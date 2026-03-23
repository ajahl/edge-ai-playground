import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "dist");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return mimeTypes[extension] || "application/octet-stream";
}

async function serveFile(res, filePath) {
  const contents = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": getContentType(filePath),
    "Cache-Control": "no-store",
  });
  res.end(contents);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${host}:${port}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, url: `http://${host}:${port}` }, null, 2));
      return;
    }

    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const requestedPath = path.normalize(path.join(distDir, relativePath));
    const safeRoot = `${distDir}${path.sep}`;

    if (requestedPath !== distDir && !requestedPath.startsWith(safeRoot)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    const filePath = existsSync(requestedPath)
      ? requestedPath
      : path.join(distDir, "index.html");

    await serveFile(res, filePath);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => {
  console.log(`WebLLM example server listening on http://${host}:${port}`);
});
