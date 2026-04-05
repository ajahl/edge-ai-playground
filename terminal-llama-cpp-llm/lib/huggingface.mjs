import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { builtInRepos, hfToken, modelsDir } from "./config.mjs";
import { formatBytes, pickPreferredGguf } from "./text-utils.mjs";

const DEFAULT_SEARCH_LIMIT = 20;

function getHeaders() {
  return hfToken ? { Authorization: `Bearer ${hfToken}` } : {};
}

function encodeRepoId(repoId) {
  return String(repoId || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export async function discoverModels() {
  const queries = builtInRepos.map(async (repoId) => {
    try {
      const response = await fetch(`https://huggingface.co/api/models/${encodeRepoId(repoId)}`, {
        headers: getHeaders(),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      return {
        id: payload.id || repoId,
        downloads: payload.downloads || 0,
        likes: payload.likes || 0,
        private: payload.private || false,
      };
    } catch {
      return {
        id: repoId,
        downloads: 0,
        likes: 0,
        private: false,
      };
    }
  });

  const curated = await Promise.all(queries);

  try {
    const response = await fetch(
      `https://huggingface.co/api/models?search=GGUF&sort=downloads&direction=-1&limit=${DEFAULT_SEARCH_LIMIT}`,
      { headers: getHeaders() },
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const discovered = payload
      .filter((item) => /gguf/i.test(item.id || ""))
      .map((item) => ({
        id: item.id,
        downloads: item.downloads || 0,
        likes: item.likes || 0,
        private: item.private || false,
      }));

    const merged = new Map();
    for (const item of [...curated, ...discovered]) {
      merged.set(item.id, item);
    }
    return [...merged.values()];
  } catch {
    return curated;
  }
}

export async function listRepoFiles(repoId) {
  const response = await fetch(`https://huggingface.co/api/models/${encodeRepoId(repoId)}`, {
    headers: getHeaders(),
  });
  if (!response.ok) {
    throw new Error(`unable to query ${repoId}: HTTP ${response.status}`);
  }

  const payload = await response.json();
  return (payload.siblings || [])
    .filter((file) => typeof file.rfilename === "string" && /\.gguf$/i.test(file.rfilename))
    .map((file) => ({
      name: file.rfilename,
      size: file.size || 0,
      url: `https://huggingface.co/${repoId}/resolve/main/${file.rfilename}?download=true`,
    }));
}

export async function resolveDownloadTarget(selection) {
  if (!selection) {
    throw new Error("no model selected");
  }

  if (selection.endsWith(".gguf")) {
    const resolvedPath = path.resolve(selection);
    return {
      type: "file",
      repoId: null,
      fileName: path.basename(resolvedPath),
      localPath: resolvedPath,
    };
  }

  const files = await listRepoFiles(selection);
  if (files.length === 0) {
    throw new Error(`no GGUF files found for ${selection}`);
  }

  const preferred = pickPreferredGguf(files);
  const repoDir = path.join(modelsDir, selection.replace(/\//g, "--"));

  return {
    type: "repo",
    repoId: selection,
    fileName: preferred.name,
    url: preferred.url,
    localPath: path.join(repoDir, preferred.name),
    availableFiles: files,
  };
}

export async function downloadModel(selection, onProgress) {
  const target = await resolveDownloadTarget(selection);
  if (target.type === "file") {
    return target;
  }

  mkdirSync(path.dirname(target.localPath), { recursive: true });
  const tempPath = `${target.localPath}.part`;

  const response = await fetch(target.url, { headers: getHeaders() });
  if (!response.ok || !response.body) {
    throw new Error(`download failed for ${target.repoId}: HTTP ${response.status}`);
  }

  const totalBytes = Number(response.headers.get("content-length") || 0);
  if (existsSync(target.localPath) && statSync(target.localPath).size > 0) {
    const existingBytes = statSync(target.localPath).size;
    if (!totalBytes || existingBytes === totalBytes) {
      return target;
    }
    rmSync(target.localPath, { force: true });
  }

  rmSync(tempPath, { force: true });
  let receivedBytes = 0;
  const fileStream = createWriteStream(tempPath);
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    receivedBytes += value.byteLength;
    if (onProgress) {
      onProgress({
        receivedBytes,
        totalBytes,
        message: `${formatBytes(receivedBytes)} / ${totalBytes > 0 ? formatBytes(totalBytes) : "unknown"}`,
      });
    }

    if (!fileStream.write(Buffer.from(value))) {
      await new Promise((resolve) => fileStream.once("drain", resolve));
    }
  }

  await new Promise((resolve, reject) => {
    fileStream.end((error) => (error ? reject(error) : resolve()));
  });

  const finalBytes = statSync(tempPath).size;
  if (totalBytes > 0 && finalBytes !== totalBytes) {
    rmSync(tempPath, { force: true });
    throw new Error(
      `download incomplete for ${target.fileName}: expected ${totalBytes} bytes, got ${finalBytes}`,
    );
  }

  renameSync(tempPath, target.localPath);
  return target;
}

export function listDownloadedModels() {
  mkdirSync(modelsDir, { recursive: true });
  const items = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (/\.gguf$/i.test(entry.name)) {
        const stats = statSync(fullPath);
        items.push({
          name: entry.name,
          path: fullPath,
          size: stats.size,
        });
      }
    }
  }

  walk(modelsDir);
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

export async function deleteDownloadedModel(selection) {
  const value = String(selection || "").trim();
  if (!value) {
    throw new Error("no model specified");
  }

  const downloaded = listDownloadedModels();
  const normalized = value.toLowerCase();

  let target =
    downloaded.find((item) => item.path.toLowerCase() === normalized || item.name.toLowerCase() === normalized) || null;

  if (!target && !value.endsWith(".gguf")) {
    try {
      const resolved = await resolveDownloadTarget(value);
      target =
        downloaded.find((item) => item.path === resolved.localPath || item.name === resolved.fileName) || {
          name: resolved.fileName,
          path: resolved.localPath,
        };
    } catch {
      target = null;
    }
  }

  if (!target || !existsSync(target.path)) {
    throw new Error(`downloaded model not found for ${value}`);
  }

  rmSync(target.path, { force: true });
  rmSync(`${target.path}.part`, { force: true });

  return target;
}
