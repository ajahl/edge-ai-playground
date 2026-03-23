const { app, BrowserWindow, ipcMain } = require("electron");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const API_HOST = process.env.WEBLLM_API_HOST || "127.0.0.1";
const API_PORT = Number(process.env.WEBLLM_API_PORT || 3888);
const RENDERER_URL = process.env.WEBLLM_RENDERER_URL || "http://localhost:5174";
const AVAILABLE_MODELS = [
  "Llama-3.2-3B-Instruct-q4f16_1-MLC",
  "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
  "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
  "Ministral-3-3B-Reasoning-2512-q4f16_1-MLC",
  "Qwen3-8B-q4f16_1-MLC",
];
const DEFAULT_MODEL = AVAILABLE_MODELS[0];
const isDev = !app.isPackaged;

app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-features", "Vulkan,UseSkiaRenderer");

let mainWindow = null;
let server = null;
let requestCounter = 0;
let rendererReadyResolve;
const rendererReady = new Promise((resolve) => {
  rendererReadyResolve = resolve;
});
const pending = new Map();

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data, null, 2));
}

function nextRequestId() {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    void mainWindow.loadURL(RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function postToRenderer(message) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Electron window is not available.");
  }
  mainWindow.webContents.send("webllm-request", message);
}

function createPendingEntry(id, type, res) {
  return new Promise((resolve, reject) => {
    pending.set(id, { type, res, resolve, reject });
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function handleLoad(res) {
  await rendererReady;
  const id = nextRequestId();
  const promise = createPendingEntry(id, "load", res);
  postToRenderer({ id, kind: "load" });
  const payload = await promise;
  json(res, 200, payload);
}

async function handleChat(req, res) {
  await rendererReady;
  const payload = await readJsonBody(req);
  const id = nextRequestId();

  if (payload.stream === true) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    pending.set(id, { type: "stream", res });
    postToRenderer({ id, kind: "chat", payload });
    req.on("close", () => {
      if (pending.has(id)) {
        pending.delete(id);
      }
    });
    return;
  }

  const promise = createPendingEntry(id, "chat", res);
  postToRenderer({ id, kind: "chat", payload });
  const completion = await promise;
  json(res, 200, completion);
}

function startServer() {
  server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        json(res, 400, { error: { message: "Invalid request." } });
        return;
      }

      const url = new URL(req.url, `http://${API_HOST}:${API_PORT}`);

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          rendererReady: mainWindow !== null && !mainWindow.isDestroyed(),
          pendingRequests: pending.size,
          platform: os.platform(),
          apiUrl: `http://${API_HOST}:${API_PORT}`,
          rendererUrl: isDev ? RENDERER_URL : null,
          model: DEFAULT_MODEL,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        json(res, 200, {
          object: "list",
          data: AVAILABLE_MODELS.map((modelId) => ({
            id: modelId,
            object: "model",
            owned_by: "webllm",
          })),
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
        `Port ${API_PORT} is already in use on ${API_HOST}. Stop the previous Electron bridge process or start this one with WEBLLM_API_PORT=<port>.`,
      );
      app.exit(1);
      return;
    }
    throw error;
  });

  server.listen(API_PORT, API_HOST, () => {
    console.log(`WebLLM Electron REST API listening on http://${API_HOST}:${API_PORT}`);
  });
}

ipcMain.on("webllm-renderer-ready", () => {
  rendererReadyResolve();
});

ipcMain.on("webllm-progress", (_event, payload) => {
  console.log("WebLLM progress:", payload.text);
});

ipcMain.on("webllm-response", (_event, message) => {
  const entry = pending.get(message.id);
  if (!entry) {
    return;
  }
  pending.delete(message.id);
  entry.resolve(message.payload);
});

ipcMain.on("webllm-error", (_event, message) => {
  const entry = pending.get(message.id);
  if (!entry) {
    return;
  }
  pending.delete(message.id);
  if (!entry.res.writableEnded) {
    json(entry.res, 500, {
      error: {
        message: message.error,
        type: "server_error",
      },
    });
  }
  entry.reject(new Error(message.error));
});

ipcMain.on("webllm-stream-chunk", (_event, message) => {
  const entry = pending.get(message.id);
  if (!entry || entry.type !== "stream" || entry.res.writableEnded) {
    return;
  }
  entry.res.write(`data: ${JSON.stringify(message.chunk)}\n\n`);
});

ipcMain.on("webllm-stream-error", (_event, message) => {
  const entry = pending.get(message.id);
  if (!entry || entry.type !== "stream" || entry.res.writableEnded) {
    return;
  }
  entry.res.write(
    `data: ${JSON.stringify({ error: { message: message.error, type: "server_error" } })}\n\n`,
  );
  entry.res.write("data: [DONE]\n\n");
  entry.res.end();
  pending.delete(message.id);
});

ipcMain.on("webllm-stream-done", (_event, message) => {
  const entry = pending.get(message.id);
  if (!entry || entry.type !== "stream" || entry.res.writableEnded) {
    return;
  }
  entry.res.write("data: [DONE]\n\n");
  entry.res.end();
  pending.delete(message.id);
});

async function shutdown() {
  for (const entry of pending.values()) {
    if (entry.type === "stream" && entry.res && !entry.res.writableEnded) {
      entry.res.write(
        `data: ${JSON.stringify({ error: { message: "Electron bridge is shutting down.", type: "server_error" } })}\n\n`,
      );
      entry.res.write("data: [DONE]\n\n");
      entry.res.end();
      continue;
    }

    if (entry.res && !entry.res.writableEnded) {
      json(entry.res, 500, {
        error: {
          message: "Electron bridge is shutting down.",
          type: "server_error",
        },
      });
    }
  }
  pending.clear();

  if (!server) {
    return;
  }

  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

app.whenReady().then(() => {
  createWindow();
  startServer();
});

app.on("before-quit", (event) => {
  if (app.isQuittingGracefully) {
    return;
  }

  event.preventDefault();
  app.isQuittingGracefully = true;
  void shutdown().finally(() => {
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
