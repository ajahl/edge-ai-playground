import * as webllm from "@mlc-ai/web-llm";
import { DEFAULT_MODEL, type AvailableModel } from "./index";

type SidebarChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// CHANGE: Shape used to return the active page content back to the sidebar.
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
const ports = new Set<browser.runtime.Port>();

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

function postToPort(port: browser.runtime.Port, message: Record<string, unknown>) {
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

// CHANGE: Reads the active tab's text on demand so the sidebar can attach page context.
async function readCurrentPage(): Promise<CurrentPagePayload> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("No active browser tab is available.");
  }

  const results = await browser.tabs.executeScript(tab.id, {
    code: `(() => {
      const title = document.title || "";
      const url = location.href;
      const selectedText = String(window.getSelection?.() || "").trim();
      const bodyText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
      // CHANGE: Cap captured page text early to reduce the chance of overflowing the model context window.
      const content = (selectedText || bodyText).slice(0, 6000);
      return { title, url, content };
    })();`,
  });

  const payload = results?.[0] as CurrentPagePayload | undefined;
  if (!payload || !payload.content) {
    throw new Error(
      "Could not read useful page text from the active tab. Try a normal webpage instead of a Firefox internal page.",
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
  if (!("caches" in window)) {
    return null;
  }

  let total = 0;

  for (const cacheName of WEBLLM_CACHE_NAMES) {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();

    for (const request of requests) {
      const response = await cache.match(request);
      if (!response) {
        continue;
      }

      const buffer = await response.clone().arrayBuffer();
      total += buffer.byteLength;
    }
  }

  return total;
}

async function clearWebLLMBrowserStorage() {
  if ("caches" in window) {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => WEBLLM_CACHE_NAMES.includes(cacheName))
        .map((cacheName) => caches.delete(cacheName)),
    );
  }

  if ("indexedDB" in window && typeof indexedDB.databases === "function") {
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
    const webllmUsed = await getWebLLMCacheUsageBytes();

    if (webllmUsed === null) {
      storageUsage = "unavailable";
    } else {
      storageUsage = `${formatBytes(webllmUsed)} (updated ${formatTime(new Date())})`;
    }
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
  port: browser.runtime.Port,
  requestId: string,
  model: AvailableModel,
  messages: SidebarChatMessage[],
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
      const delta = chunk.choices[0]?.delta?.content || "";
      text += delta;
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

async function handlePortMessage(port: browser.runtime.Port, message: Record<string, unknown>) {
  const type = message.type;

  if (type === "get-state") {
    await refreshStorageUsage();
    postToPort(port, snapshot());
    return;
  }

  if (type === "load-model" && typeof message.model === "string") {
    try {
      await ensureLoaded(message.model as AvailableModel);
    } catch (error) {
      engineStatus = "error";
      modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
      broadcastState();
      postToPort(port, {
        type: "bridge-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (type === "clean-model" && typeof message.model === "string") {
    try {
      await cleanModelStorage(message.model as AvailableModel);
    } catch (error) {
      engineStatus = "error";
      modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
      broadcastState();
      postToPort(port, {
        type: "bridge-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  // CHANGE: The sidebar can request the currently open page as reusable prompt context.
  if (type === "get-current-page") {
    try {
      const page = await readCurrentPage();
      postToPort(port, {
        type: "current-page",
        page,
      });
    } catch (error) {
      postToPort(port, {
        type: "bridge-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (
    type === "chat" &&
    typeof message.requestId === "string" &&
    typeof message.model === "string" &&
    Array.isArray(message.messages)
  ) {
    try {
      await runChat(
        port,
        message.requestId,
        message.model as AvailableModel,
        message.messages as SidebarChatMessage[],
      );
    } catch (error) {
      engineStatus = loadedModel ? "ready" : "error";
      modelStatus = formatModelStatus(engineStatus, loadedModel, loadingModel);
      broadcastState();
      postToPort(port, {
        type: "chat-error",
        requestId: message.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

browser.browserAction.onClicked.addListener(() => {
  void browser.sidebarAction.open();
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "webgpu-sidebar") {
    return;
  }

  ports.add(port);
  postToPort(port, snapshot());

  port.onMessage.addListener((message) => {
    void handlePortMessage(port, message as Record<string, unknown>);
  });

  port.onDisconnect.addListener(() => {
    ports.delete(port);
  });
});

void refreshStorageUsage();
