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

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return null;
  }
  return decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim());
}

function extractMetaDescription(html) {
  const match = html.match(
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  );
  if (!match) {
    return null;
  }
  return decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim());
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<template[\s\S]*?<\/template>/gi, " ")
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|ul|ol|h1|h2|h3|h4|h5|h6|blockquote|pre)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function cleanupExtractedText(text) {
  return text
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*[<>][^>\n<]{0,80}[<>]?\s*$/gm, "")
    .replace(/^\s*\/{2,}.*$/gm, "")
    .replace(/^\s*[{}[\]|`~]+\s*$/gm, "")
    .replace(/^\s*(javascript:|data:).*/gim, "")
    .replace(/^\s*https?:\/\/\S+\s*$/gim, "")
    .replace(/^\s*www\.\S+\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractPreferredHtml(html) {
  const candidates = [
    /<body\b[^>]*>([\s\S]*?)<\/body>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
  ];

  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return html;
}

function extractReadableText(html) {
  const preferredHtml = extractPreferredHtml(html);
  const preferredText = stripHtmlToText(preferredHtml);
  const fallbackText = stripHtmlToText(html);
  const metaDescription = extractMetaDescription(html);

  const combined = [
    metaDescription,
    preferredText,
    fallbackText,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return cleanupExtractedText(combined);
}

async function handleUrlContext(req, res) {
  const payload = await readJsonBody(req);
  const targetUrl = typeof payload.url === "string" ? payload.url.trim() : "";

  if (!targetUrl) {
    json(res, 400, {
      error: {
        message: "Request body must include a url string.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    json(res, 400, {
      error: {
        message: "URL is not valid.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    json(res, 400, {
      error: {
        message: "Only http and https URLs are supported.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(parsedUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "webgpu-llm-web-server/1.0",
      },
    });
  } catch (error) {
    json(res, 502, {
      error: {
        message:
          error instanceof Error
            ? `Upstream fetch failed: ${error.message}`
            : "Upstream fetch failed.",
        type: "server_error",
      },
    });
    return;
  }

  if (!upstream.ok) {
    json(res, upstream.status, {
      error: {
        message: `Upstream fetch failed with ${upstream.status}.`,
        type: "server_error",
      },
    });
    return;
  }

  const html = await upstream.text();
  const title = extractTitle(html) || parsedUrl.toString();
  const content = extractReadableText(html);

  json(res, 200, {
    ok: true,
    url: parsedUrl.toString(),
    title,
    content,
  });
}

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

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, url: `http://${host}:${port}` });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/url-context") {
      await handleUrlContext(req, res);
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
