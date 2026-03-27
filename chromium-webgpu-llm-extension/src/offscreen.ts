import * as webllm from "@mlc-ai/web-llm";
import { type AvailableModel } from "./index";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type EngineState = {
  type: "state";
  engineStatus: "idle" | "loading" | "ready" | "generating" | "cleaning" | "error";
  loadedModel: AvailableModel | null;
  loadingModel: AvailableModel | null;
  progress: number;
  modelStatus: string;
  storageUsage: string;
};

const WEBLLM_CACHE_NAMES = ["webllm/model", "webllm/config", "webllm/wasm"];
const ports = new Set<chrome.runtime.Port>();

let engine: webllm.MLCEngineInterface | null = null;
let engineStatus: EngineState["engineStatus"] = "idle";
let loadedModel: AvailableModel | null = null;
let loadingModel: AvailableModel | null = null;
let progress = 0;
let modelStatus = "not loaded";
let storageUsage = "checking...";
let loadPromise: Promise<void> | null = null;

function formatModelStatus(
  status: EngineState["engineStatus"],
  activeModel: AvailableModel | null,
  pendingModel: AvailableModel | null,
) {
  if (status === "idle" && !activeModel && !pendingModel) {
    return "not loaded";
  }
  if (status === "loading" && pendingModel) {
    return `loading ${pendingModel}`;
  }
  if (status === "cleaning" && (activeModel || pendingModel)) {
    return `cleaning ${activeModel || pendingModel}`;
  }
  if (status === "ready" && activeModel) {
    return `ready ${activeModel}`;
  }
  if (status === "generating" && activeModel) {
    return `ready ${activeModel}`;
  }
  if (status === "error" && (pendingModel || activeModel)) {
    return `error ${pendingModel || activeModel}`;
  }
  return activeModel || pendingModel || "not loaded";
}

function getState(): EngineState {
  return {
    type: "state",
    engineStatus,
    loadedModel,
    loadingModel,
    progress,
    modelStatus,
    storageUsage,
  };
}

function broadcast(message: Record<string, unknown>) {
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch {
      ports.delete(port);
    }
  }
}

function broadcastState() {
  broadcast(getState());
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTime(date: Date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

async function getWebLLMCacheUsageBytes() {
  let total = 0;
  for (const cacheName of WEBLLM_CACHE_NAMES) {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();
    for (const request of requests) {
      const response = await cache.match(request);
      if (!response) {
        continue;
      }
      total += (await response.clone().arrayBuffer()).byteLength;
    }
  }
  return total;
}

async function clearWebLLMBrowserStorage() {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((cacheName) => WEBLLM_CACHE_NAMES.includes(cacheName))
      .map((cacheName) => caches.delete(cacheName)),
  );

  if (typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases();
    await Promise.all(
      databases
        .map((database) => database.name)
        .filter((name): name is string => Boolean(name) && name.includes("webllm"))
        .map(
          (name) =>
            new Promise<void>((resolve) => {
              const request = indexedDB.deleteDatabase(name);
              request.onsuccess = () => resolve();
              request.onerror = () => resolve();
              request.onblocked = () => resolve();
            }),
        ),
    );
  }

  try {
    const keys = Object.keys(localStorage).filter((key) =>
      key.toLowerCase().includes("webllm"),
    );
    for (const key of keys) {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage access issues.
  }
}

async function refreshStorageUsage() {
  try {
    const used = await getWebLLMCacheUsageBytes();
    storageUsage = `${formatBytes(used)} (updated ${formatTime(new Date())})`;
  } catch {
    storageUsage = "unavailable";
  }
  broadcastState();
}

async function ensureLoaded(modelId: AvailableModel) {
  if (loadPromise) {
    if (loadingModel === modelId || (loadedModel === modelId && loadingModel === null)) {
      return loadPromise;
    }
    await loadPromise;
    return ensureLoaded(modelId);
  }

  loadPromise = (async () => {
    engineStatus = "loading";
    loadingModel = modelId;
    progress = 0;
    modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
    broadcastState();

    if (!engine) {
      engine = new webllm.MLCEngine({
        initProgressCallback(report) {
          progress = report.progress;
          modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
          broadcastState();
        },
      });
    }

    if (loadedModel !== modelId) {
      await engine.reload(modelId);
      loadedModel = modelId;
    }

    progress = 1;
    engineStatus = "ready";
    loadingModel = null;
    modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
    await refreshStorageUsage();
  })().catch((error) => {
    progress = 0;
    engineStatus = "error";
    loadingModel = null;
    modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
    broadcastState();
    throw error;
  }).finally(() => {
    loadPromise = null;
  });

  return loadPromise;
}

async function cleanModelStorage(modelId: AvailableModel) {
  engineStatus = "cleaning";
  progress = 0;
  modelStatus = formatModelStatus(engineStatus, loadedModel, modelId);
  broadcastState();

  if (engine && loadedModel === modelId) {
    await engine.unload();
    loadedModel = null;
    loadingModel = null;
  }

  await webllm.deleteModelAllInfoInCache(modelId);
  await clearWebLLMBrowserStorage();

  engineStatus = "idle";
  progress = 0;
  modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
  await refreshStorageUsage();
}

async function runChat(requestId: string, modelId: AvailableModel, messages: ChatMessage[]) {
  await ensureLoaded(modelId);
  if (!engine) {
    throw new Error("Engine failed to initialize.");
  }

  engineStatus = "generating";
  modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
  broadcastState();

  try {
    const completion = await engine.chat.completions.create({
      messages,
      stream: true,
    });

    let text = "";
    for await (const chunk of completion) {
      text += chunk.choices[0]?.delta?.content || "";
      broadcast({ type: "chat-chunk", requestId, text });
    }

    broadcast({ type: "chat-done", requestId, text });
  } finally {
    engineStatus = loadedModel ? "ready" : "idle";
    modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
    broadcastState();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  void (async () => {
    try {
      switch (message.type) {
        case "get-state":
          await refreshStorageUsage();
          sendResponse({ ok: true, state: getState() });
          return;
        case "load-model":
          await ensureLoaded(message.model as AvailableModel);
          sendResponse({ ok: true });
          return;
        case "clean-model":
          await cleanModelStorage(message.model as AvailableModel);
          sendResponse({ ok: true });
          return;
        case "chat":
          void runChat(
            message.requestId as string,
            message.model as AvailableModel,
            message.messages as ChatMessage[],
          ).catch((error) => {
            engineStatus = loadedModel ? "ready" : "error";
            modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
            broadcastState();
            broadcast({
              type: "chat-error",
              requestId: message.requestId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
          sendResponse({ ok: true });
          return;
        default:
          sendResponse({ ok: false, error: "Unknown offscreen message." });
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "webgpu-panel") {
    return;
  }

  ports.add(port);
  try {
    port.postMessage(getState());
  } catch {
    ports.delete(port);
    return;
  }

  port.onMessage.addListener((message) => {
    void (async () => {
      try {
        switch (message?.type) {
          case "get-state":
            port.postMessage(getState());
            return;
          case "load-model":
            await ensureLoaded(message.model as AvailableModel);
            return;
          case "clean-model":
            await cleanModelStorage(message.model as AvailableModel);
            return;
          case "chat":
            void runChat(
              message.requestId as string,
              message.model as AvailableModel,
              message.messages as ChatMessage[],
            ).catch((error) => {
              engineStatus = loadedModel ? "ready" : "error";
              modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
              broadcastState();
              broadcast({
                type: "chat-error",
                requestId: message.requestId,
                message: error instanceof Error ? error.message : String(error),
              });
            });
            return;
          default:
            port.postMessage({
              type: "bridge-error",
              message: "Unknown offscreen port message.",
            });
        }
      } catch (error) {
        port.postMessage({
          type: "bridge-error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  port.onDisconnect.addListener(() => {
    ports.delete(port);
  });
});

void refreshStorageUsage();
