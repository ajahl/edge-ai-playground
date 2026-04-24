import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const defaultModelsRoot = path.join(repoRoot, "mlc-models");
const legacyDefaultModelRoot = path.join(repoRoot, "gemma4-mlc-packaging", "artifacts", "package");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8090);

const explicitModelRoot = process.env.MODEL_ROOT?.trim() || "";
const modelsRoot = path.resolve(process.env.MODELS_ROOT || defaultModelsRoot);
const singleModelRoot = explicitModelRoot ? path.resolve(explicitModelRoot) : "";
const singleModelMode = singleModelRoot.length > 0;

const mimeTypes = {
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function safeReadJson(jsonPath) {
  try {
    if (!existsSync(jsonPath) || !statSync(jsonPath).isFile()) {
      return null;
    }
    return JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {
    return null;
  }
}

function buildVersionedUrl(modelId, cleanPath, absolutePath) {
  let version = "";
  try {
    version = String(Math.floor(statSync(absolutePath).mtimeMs));
  } catch {
    version = "";
  }
  const baseUrl = `/models/${encodeURIComponent(modelId)}/${cleanPath}`;
  return version ? `${baseUrl}?v=${version}` : baseUrl;
}

function normalizeLibEntry(modelId, packageDir, libPath) {
  const cleanLibPath = String(libPath || "").replace(/^package\//, "");
  const absolutePath = path.join(packageDir, cleanLibPath);
  return {
    path: cleanLibPath,
    url: buildVersionedUrl(modelId, cleanLibPath, absolutePath),
  };
}

function loadModelsIndex() {
  if (singleModelMode) {
    const configPath = path.join(singleModelRoot, "mlc-chat-config.json");
    const config = safeReadJson(configPath);
    const modelId = config?.model_id || path.basename(singleModelRoot);
    const libsDir = path.join(singleModelRoot, "libs");
    const libs = [];

    if (existsSync(libsDir) && statSync(libsDir).isDirectory()) {
      for (const entry of readdirSync(libsDir)) {
        if (entry.endsWith(".wasm")) {
          libs.push(`package/libs/${entry}`);
        }
      }
    }

    return {
      mode: "single-model",
      root: singleModelRoot,
      models: [
        {
          id: modelId,
          rootDir: ".",
          packageDir: ".",
          config: "mlc-chat-config.json",
          libs,
        },
      ],
    };
  }

  const indexPath = path.join(modelsRoot, "index.json");
  const payload = safeReadJson(indexPath);
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return {
    mode: "mlc-models",
    root: modelsRoot,
    models,
  };
}

function buildModelMap(indexPayload) {
  const modelMap = new Map();
  for (const entry of indexPayload.models) {
    if (!entry || typeof entry.id !== "string" || !entry.id) {
      continue;
    }

    const packageDir = singleModelMode
      ? singleModelRoot
      : path.join(modelsRoot, entry.rootDir || entry.id, "package");

    const libs = Array.isArray(entry.libs)
      ? entry.libs.map((libPath) => normalizeLibEntry(entry.id, packageDir, libPath))
      : [];

    modelMap.set(entry.id, {
      ...entry,
      packageDir,
      configUrl: buildVersionedUrl(
        entry.id,
        "mlc-chat-config.json",
        path.join(packageDir, "mlc-chat-config.json"),
      ),
      modelUrl: `/models/${encodeURIComponent(entry.id)}`,
      libs,
    });
  }

  return modelMap;
}

function resolveSafePath(rootDir, relativePath) {
  const requestedPath = path.normalize(path.join(rootDir, relativePath));
  const safeRoot = `${rootDir}${path.sep}`;
  if (requestedPath !== rootDir && !requestedPath.startsWith(safeRoot)) {
    return null;
  }
  return requestedPath;
}

function resolveLegacySingleModelPath(urlPathname) {
  const activeRoot = singleModelMode ? singleModelRoot : legacyDefaultModelRoot;
  let relativePath = urlPathname === "/" ? "mlc-chat-config.json" : decodeURIComponent(urlPathname.slice(1));
  if (relativePath.startsWith("resolve/main/")) {
    relativePath = relativePath.slice("resolve/main/".length);
  }
  return resolveSafePath(activeRoot, relativePath);
}

function resolveMultiModelRequest(urlPathname, modelMap) {
  if (!urlPathname.startsWith("/models/")) {
    return null;
  }

  const remainder = urlPathname.slice("/models/".length);
  const slashIndex = remainder.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }

  const encodedModelId = remainder.slice(0, slashIndex);
  const modelId = decodeURIComponent(encodedModelId);
  const model = modelMap.get(modelId);
  if (!model) {
    return null;
  }

  let relativePath = decodeURIComponent(remainder.slice(slashIndex + 1));
  if (!relativePath || relativePath === "/") {
    relativePath = "mlc-chat-config.json";
  }
  if (relativePath.startsWith("resolve/main/")) {
    relativePath = relativePath.slice("resolve/main/".length);
  }

  return resolveSafePath(model.packageDir, relativePath);
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "Missing URL" });
    return;
  }

  const url = new URL(req.url, `http://${host}:${port}`);
  const indexPayload = loadModelsIndex();
  const modelMap = buildModelMap(indexPayload);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      mode: indexPayload.mode,
      root: indexPayload.root,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/models") {
    sendJson(res, 200, {
      models: Array.from(modelMap.values()).map((entry) => ({
        id: entry.id,
        model: entry.modelUrl,
        config: entry.configUrl,
        libs: entry.libs,
        packageDir: entry.packageDir,
        model_type: entry.model_type,
        buffer_size_required_bytes: entry.buffer_size_required_bytes,
        max_tensor_cache_shard_bytes: entry.max_tensor_cache_shard_bytes,
        max_tensor_cache_record_bytes: entry.max_tensor_cache_record_bytes,
        segmented_embedding_candidate: entry.segmented_embedding_candidate,
        segmented_embedding_plan: entry.segmented_embedding_plan,
        runtime_supported: entry.runtime_supported,
        runtime_support_notes: entry.runtime_support_notes,
      })),
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  let filePath = null;

  if (singleModelMode) {
    filePath = resolveLegacySingleModelPath(url.pathname);
  } else if (url.pathname.startsWith("/models/")) {
    filePath = resolveMultiModelRequest(url.pathname, modelMap);
  } else if (modelMap.size === 1 && (url.pathname === "/" || url.pathname.startsWith("/resolve/main/") || url.pathname.startsWith("/libs/") || url.pathname.endsWith(".json"))) {
    const onlyModelId = Array.from(modelMap.keys())[0];
    const onlyModel = modelMap.get(onlyModelId);
    if (onlyModel) {
      let relativePath = url.pathname === "/" ? "mlc-chat-config.json" : decodeURIComponent(url.pathname.slice(1));
      if (relativePath.startsWith("resolve/main/")) {
        relativePath = relativePath.slice("resolve/main/".length);
      }
      filePath = resolveSafePath(onlyModel.packageDir, relativePath);
    }
  }

  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "Not Found" });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Content-Length": body.byteLength,
    // Model artifacts are rebuilt in-place during local development, so
    // aggressive HTTP caching can leave the browser executing stale wasm.
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  res.end(body);
});

server.listen(port, host, () => {
  console.log(`webllm-model-server listening on http://${host}:${port}`);
  if (singleModelMode) {
    console.log(`serving single package from ${singleModelRoot}`);
  } else {
    console.log(`serving packaged models from ${modelsRoot}`);
    console.log("list models at /models");
  }
});
