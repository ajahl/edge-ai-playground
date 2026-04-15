import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const defaultModelRoot = path.join(repoRoot, "gemma4-mlc-packaging", "artifacts", "package");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8090);
const modelRoot = path.resolve(process.env.MODEL_ROOT || defaultModelRoot);

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
  res.end(JSON.stringify(payload));
}

function resolveRequestedPath(urlPathname) {
  let relativePath = urlPathname === "/" ? "mlc-chat-config.json" : decodeURIComponent(urlPathname.slice(1));
  if (relativePath.startsWith("resolve/main/")) {
    relativePath = relativePath.slice("resolve/main/".length);
  }
  const requestedPath = path.normalize(path.join(modelRoot, relativePath));
  const safeRoot = `${modelRoot}${path.sep}`;

  if (requestedPath !== modelRoot && !requestedPath.startsWith(safeRoot)) {
    return null;
  }
  return requestedPath;
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "Missing URL" });
    return;
  }

  const url = new URL(req.url, `http://${host}:${port}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      modelRoot,
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  const filePath = resolveRequestedPath(url.pathname);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "Not Found" });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Content-Length": body.byteLength,
    "Cache-Control": "public, max-age=3600",
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
  console.log(`serving model files from ${modelRoot}`);
});
