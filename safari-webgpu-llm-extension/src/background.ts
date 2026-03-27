import * as webllm from "@mlc-ai/web-llm";
import { type AvailableModel } from "./index";

type PopupChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type CurrentPagePayload = {
  title: string;
  url: string;
  content: string;
};

type BridgeStateMessage = {
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
let loadPromise: Promise<void> | null = null;
let loadedModel: AvailableModel | null = null;
let loadingModel: AvailableModel | null = null;
let progress = 0;
let engineStatus: BridgeStateMessage["engineStatus"] = "idle";
let modelStatus = "not loaded";
let storageUsage = "checking...";

function formatModelStatus(
  status: BridgeStateMessage["engineStatus"],
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

function snapshot(): BridgeStateMessage {
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

function postToPort(port: chrome.runtime.Port, message: Record<string, unknown>) {
  try {
    port.postMessage(message);
  } catch {
    ports.delete(port);
  }
}

function broadcast(message: Record<string, unknown>) {
  for (const port of ports) {
    postToPort(port, message);
  }
}

function broadcastState() {
  broadcast(snapshot());
}

async function readCurrentPage(): Promise<CurrentPagePayload> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active browser tab is available.");
  }

  const results = await chrome.tabs.executeScript(tab.id, {
    code: `(() => {
      const title = document.title || "";
      const url = location.href;
      const selectedText = String(window.getSelection?.() || "").trim();
      const bodyText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
      const content = (selectedText || bodyText).slice(0, 6000);
      return { title, url, content };
    })();`,
  });

  const payload = results?.[0] as CurrentPagePayload | undefined;
  if (!payload?.content) {
    throw new Error(
      "Could not read useful page text from the active tab. Try a normal webpage instead of a browser-internal page.",
    );
  }

  return payload;
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
    const localStorageKeys = Object.keys(localStorage).filter((key) =>
      key.toLowerCase().includes("webllm"),
    );
    for (const key of localStorageKeys) {
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
    engineStatus = "error";
    loadingModel = null;
    progress = 0;
    modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
    broadcastState();
    throw error;
  }).finally(() => {
    loadPromise = null;
  });

  return loadPromise;
}

async function cleanModelStorage(model: AvailableModel) {
  engineStatus = "cleaning";
  modelStatus = formatModelStatus(engineStatus, loadedModel, model);
  broadcastState();

  if (engine && loadedModel === model) {
    await engine.unload();
    loadedModel = null;
    loadingModel = null;
    progress = 0;
    modelStatus = formatModelStatus("idle", loadedModel, loadingModel);
  }

  await webllm.deleteModelAllInfoInCache(model);
  await clearWebLLMBrowserStorage();

  engineStatus = "idle";
  progress = 0;
  modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
  await refreshStorageUsage();
}

async function runChat(
  port: chrome.runtime.Port,
  requestId: string,
  model: AvailableModel,
  messages: PopupChatMessage[],
) {
  await ensureLoaded(model);

  if (!engine) {
    throw new Error("Engine failed to initialize.");
  }

  engineStatus = "generating";
  broadcastState();

  try {
    const completion = await engine.chat.completions.create({
      messages,
      stream: true,
    });

    let text = "";
    for await (const chunk of completion) {
      text += chunk.choices[0]?.delta?.content || "";
      postToPort(port, {
        type: "chat-chunk",
        requestId,
        text,
      });
    }

    postToPort(port, {
      type: "chat-done",
      requestId,
      text,
    });
  } finally {
    engineStatus = loadedModel ? "ready" : "idle";
    modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
    broadcastState();
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "webgpu-popup") {
    return;
  }

  ports.add(port);
  postToPort(port, snapshot());

  port.onMessage.addListener((message) => {
    void (async () => {
      try {
        switch (message?.type) {
          case "get-state":
            await refreshStorageUsage();
            postToPort(port, snapshot());
            return;
          case "load-model":
            await ensureLoaded(message.model as AvailableModel);
            return;
          case "clean-model":
            await cleanModelStorage(message.model as AvailableModel);
            return;
          case "get-current-page":
            postToPort(port, {
              type: "current-page",
              page: await readCurrentPage(),
            });
            return;
          case "chat":
            void runChat(
              port,
              message.requestId as string,
              message.model as AvailableModel,
              message.messages as PopupChatMessage[],
            ).catch((error) => {
              engineStatus = loadedModel ? "ready" : "error";
              modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
              broadcastState();
              postToPort(port, {
                type: "chat-error",
                requestId: message.requestId,
                message: error instanceof Error ? error.message : String(error),
              });
            });
            return;
          default:
            postToPort(port, {
              type: "bridge-error",
              message: "Unknown popup port message.",
            });
        }
      } catch (error) {
        postToPort(port, {
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
