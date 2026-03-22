import http from "node:http";
import os from "node:os";
import path from "node:path";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { chromium } from "playwright-core";

const API_HOST = "127.0.0.1";
const API_PORT = Number(process.env.API_PORT || 3890);
const RENDERER_URL = process.env.RENDERER_URL || "http://localhost:5175";
const DEFAULT_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const executableNames = [
  "Chromium",
  "chrome",
  "headless_shell",
  "chrome.exe",
  "Google Chrome for Testing",
];

let browser;
let page;
const streamResponses = new Map();

function findPlaywrightChromiumExecutable() {
  const envPath = process.env.PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browserRoot || !existsSync(browserRoot)) {
    return null;
  }

  const candidates = [];
  const stack = [browserRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);

      if (entry.isSymbolicLink()) {
        try {
          const resolved = realpathSync(fullPath);
          const stats = statSync(resolved);
          if (stats.isDirectory()) {
            stack.push(resolved);
          } else if (
            stats.isFile() &&
            executableNames.includes(path.basename(resolved))
          ) {
            candidates.push(resolved);
          }
        } catch {
          // Ignore broken symlinks while scanning the browser bundle.
        }
        continue;
      }

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (
        entry.isFile() &&
        executableNames.includes(entry.name)
      ) {
        candidates.push(fullPath);
      }
    }
  }

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function resolveLaunchExecutable() {
  try {
    return findPlaywrightChromiumExecutable() || chromium.executablePath() || null;
  } catch {
    return findPlaywrightChromiumExecutable();
  }
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
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

async function ensureBrowser() {
  if (browser && page) {
    return;
  }

  const executablePath = resolveLaunchExecutable();
  if (!executablePath) {
    throw new Error(
      "Could not find a Playwright-managed Chromium binary. Start from `nix develop` and ensure PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH points to the Nix browser bundle.",
    );
  }

  browser = await chromium.launch({
    executablePath,
    headless: false,
    args: [
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      "--enable-features=Vulkan,UseSkiaRenderer",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1100, height: 800 },
  });
  page = await context.newPage();

  await page.exposeFunction("bridgeEmit", async (event) => {
    const entry = streamResponses.get(event.id);
    if (!entry) {
      return;
    }
    if (event.type === "chunk") {
      entry.res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
      return;
    }
    if (event.type === "error") {
      entry.res.write(
        `data: ${JSON.stringify({ error: { message: event.error, type: "server_error" } })}\n\n`,
      );
      entry.res.write("data: [DONE]\n\n");
      entry.res.end();
      streamResponses.delete(event.id);
      return;
    }
    if (event.type === "done") {
      entry.res.write("data: [DONE]\n\n");
      entry.res.end();
      streamResponses.delete(event.id);
    }
  });

  page.on("console", (msg) => {
    console.log("[browser]", msg.text());
  });

  await page.goto(RENDERER_URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.webllmBridgeReady === true);
}

async function handleLoad(res) {
  await ensureBrowser();
  const payload = await page.evaluate(() => window.webllmLoad?.());
  json(res, 200, payload);
}

async function handleChat(req, res) {
  await ensureBrowser();
  const payload = await readJsonBody(req);

  if (payload.stream === true) {
    const id = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    streamResponses.set(id, { res });
    req.on("close", () => {
      streamResponses.delete(id);
    });
    await page.evaluate(
      ({ requestId, requestPayload }) =>
        window.webllmStreamChat?.(requestId, requestPayload),
      { requestId: id, requestPayload: payload },
    );
    return;
  }

  const completion = await page.evaluate(
    (requestPayload) => window.webllmChat?.(requestPayload),
    payload,
  );
  json(res, 200, completion);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      json(res, 400, { error: { message: "Invalid request." } });
      return;
    }

    const url = new URL(req.url, `http://${API_HOST}:${API_PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        browserConnected: Boolean(browser && page),
        platform: os.platform(),
        playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
        playwrightExecutablePath: resolveLaunchExecutable(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      json(res, 200, {
        object: "list",
        data: [
          {
            id: DEFAULT_MODEL,
            object: "model",
            owned_by: "webllm",
          },
        ],
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/load") {
      await handleLoad(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleChat(req, res);
      return;
    }

    json(res, 404, {
      error: {
        message: `No route for ${req.method} ${url.pathname}`,
        type: "invalid_request_error",
      },
    });
  } catch (error) {
    json(res, 500, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: "server_error",
      },
    });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${API_PORT} is already in use on ${API_HOST}. Stop the previous bridge process or start this one with API_PORT=<port>.`,
    );
    process.exit(1);
  }
  throw error;
});

server.listen(API_PORT, API_HOST, () => {
  console.log(`WebLLM Chrome bridge listening on http://${API_HOST}:${API_PORT}`);
  console.log(`Using renderer URL: ${RENDERER_URL}`);
  console.log(
    `Using Playwright browsers path: ${process.env.PLAYWRIGHT_BROWSERS_PATH || "unset"}`,
  );
});

async function shutdown() {
  server.close();
  if (browser) {
    await browser.close();
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
