import * as webllm from "@mlc-ai/web-llm";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  LOAD_API_PATH,
  MODELS_API_PATH,
  OPENAI_API_PATH,
  type AvailableModel,
} from "./index";

const swStatus = document.getElementById("sw-status") as HTMLSpanElement;
const modelStatus = document.getElementById("model-status") as HTMLSpanElement;
const progressStatus = document.getElementById(
  "progress-status",
) as HTMLSpanElement;
const storageUsage = document.getElementById("storage-usage") as HTMLSpanElement;
const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
const loadModelButton = document.getElementById(
  "load-model-button",
) as HTMLButtonElement;
const clearStorageButton = document.getElementById(
  "clear-storage-button",
) as HTMLButtonElement;
const refreshStorageButton = document.getElementById(
  "refresh-storage-button",
) as HTMLButtonElement;
const promptInput = document.getElementById("prompt") as HTMLTextAreaElement;
const runButton = document.getElementById("run-button") as HTMLButtonElement;
const responseOutput = document.getElementById("response-output") as HTMLPreElement;

const serviceWorkerUrl = import.meta.env.DEV ? "/sw.ts" : "/sw.js";
let keepAliveTimer: number | null = null;
let loadPromise: Promise<void> | null = null;
let engine: webllm.MLCEngineInterface | null = null;
let loadedModel: AvailableModel | null = null;
let loadingModel: AvailableModel | null = null;
const WEBLLM_CACHE_NAMES = ["webllm/model", "webllm/config", "webllm/wasm"];

function setStatus(element: HTMLElement, text: string) {
  element.textContent = text;
}

function setLoadingState(isLoading: boolean) {
  modelSelect.disabled = isLoading;
  loadModelButton.disabled = isLoading;
  clearStorageButton.disabled = isLoading;
  refreshStorageButton.disabled = isLoading;
  runButton.disabled = isLoading;
}

function getSelectedModel(): AvailableModel {
  return modelSelect.value as AvailableModel;
}

function postToServiceWorker(message: Record<string, unknown>) {
  navigator.serviceWorker.controller?.postMessage(message);
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
    setStatus(storageUsage, "refreshing...");
    const webllmUsed = await getWebLLMCacheUsageBytes();

    if (webllmUsed === null) {
      setStatus(storageUsage, "unavailable");
      return;
    }

    setStatus(
      storageUsage,
      `${formatBytes(webllmUsed)} (WebLLM cache, updated ${formatTime(new Date())})`,
    );
  } catch {
    setStatus(storageUsage, "unavailable");
  }
}

function setupModelSelector() {
  for (const model of AVAILABLE_MODELS) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === DEFAULT_MODEL;
    modelSelect.append(option);
  }
}

async function waitForController() {
  if (navigator.serviceWorker.controller) {
    return;
  }

  await new Promise<void>((resolve) => {
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => resolve(),
      { once: true },
    );
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("This browser does not support service workers.");
  }

  setStatus(swStatus, "registering");
  await navigator.serviceWorker.register(serviceWorkerUrl, {
    type: "module",
    scope: "/",
  });

  await navigator.serviceWorker.ready;
  await waitForController();
  setStatus(swStatus, "ready");
}

function startKeepAlive() {
  if (keepAliveTimer !== null) {
    return;
  }

  keepAliveTimer = window.setInterval(() => {
    postToServiceWorker({
      type: "webllm-keepalive",
    });
  }, 10_000);
}

async function getModels() {
  const response = await fetch(MODELS_API_PATH);
  if (!response.ok) {
    throw new Error(`Model probe failed with ${response.status}`);
  }
  return response.json();
}

async function ensureLoaded(modelId: AvailableModel = getSelectedModel()) {
  if (loadPromise) {
    if (loadingModel === modelId || (loadedModel === modelId && loadingModel === null)) {
      return loadPromise;
    }

    await loadPromise;
    return ensureLoaded(modelId);
  }

  loadPromise = (async () => {
    setLoadingState(true);

    if (!engine) {
      engine = new webllm.MLCEngine({
        initProgressCallback(report) {
          setStatus(progressStatus, report.text);
          postToServiceWorker({
            type: "webllm-progress",
            progress: report.progress,
            text: report.text,
            model: modelId,
          });
          if (report.progress === 1) {
            setStatus(modelStatus, modelId);
          }
        },
      });
    }

    if (loadedModel !== modelId) {
      loadingModel = modelId;
      setStatus(modelStatus, `loading ${modelId}`);
      await engine.reload(modelId);
      loadedModel = modelId;
      loadingModel = null;
      postToServiceWorker({
        type: "webllm-model",
        model: modelId,
      });
    }
  })().catch((error) => {
    loadPromise = null;
    loadingModel = null;
    setLoadingState(false);
    throw error;
  }).then(() => {
    loadPromise = null;
    loadingModel = null;
    setLoadingState(false);
  });

  return loadPromise;
}

async function handleRendererRequest(message: {
  id: string;
  kind: "load" | "chat";
  payload?: Record<string, unknown>;
}) {
  try {
    if (message.kind === "load") {
      const requestedModel =
        typeof message.payload?.model === "string"
          ? (message.payload.model as AvailableModel)
          : getSelectedModel();
      await ensureLoaded(requestedModel);
      postToServiceWorker({
        type: "webllm-response",
        id: message.id,
        payload: {
          ok: true,
          loaded: true,
          model: requestedModel,
        },
      });
      return;
    }

    const requestPayload = message.payload || {};
    const requestedModel =
      typeof requestPayload.model === "string"
        ? (requestPayload.model as AvailableModel)
        : getSelectedModel();

    await ensureLoaded(requestedModel);
    if (!engine) {
      throw new Error("Engine failed to initialize.");
    }

    const { model: _ignoredModel, ...request } = requestPayload;

    if (request.stream === true) {
      const generator = await engine.chat.completions.create(
        request as webllm.ChatCompletionRequestStreaming,
      );
      for await (const chunk of generator) {
        postToServiceWorker({
          type: "webllm-stream-chunk",
          id: message.id,
          chunk,
        });
      }
      postToServiceWorker({
        type: "webllm-stream-done",
        id: message.id,
      });
      return;
    }

    const completion = await engine.chat.completions.create(
      request as webllm.ChatCompletionRequestNonStreaming,
    );
    postToServiceWorker({
      type: "webllm-response",
      id: message.id,
      payload: completion,
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    postToServiceWorker({
      type:
        message.payload?.stream === true ? "webllm-stream-error" : "webllm-error",
      id: message.id,
      error: messageText,
    });
  }
}

async function preloadModel(model: AvailableModel) {
  setLoadingState(true);
  setStatus(modelStatus, `loading ${model}`);
  setStatus(progressStatus, "warming model");

  try {
    const response = await fetch(LOAD_API_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload?.error?.message || `Preload failed with ${response.status}`);
    }

    setStatus(modelStatus, payload.model || model);
    setStatus(progressStatus, "ready");
    await refreshStorageUsage();
  } finally {
    setLoadingState(false);
  }
}

async function clearSelectedModelStorage() {
  const model = getSelectedModel();
  setLoadingState(true);
  responseOutput.textContent = `Clearing cached downloads for ${model}...`;

  try {
    if (engine && loadedModel === model) {
      await engine.unload();
      loadedModel = null;
      loadingModel = null;
      setStatus(modelStatus, "not loaded");
      setStatus(progressStatus, "idle");
      postToServiceWorker({
        type: "webllm-model",
        model: DEFAULT_MODEL,
      });
    }

    await webllm.deleteModelAllInfoInCache(model);
    await clearWebLLMBrowserStorage();
    responseOutput.textContent = `Cleared cached downloads for ${model}.`;
    await refreshStorageUsage();
  } catch (error) {
    responseOutput.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    setLoadingState(false);
  }
}

async function runPrompt() {
  runButton.disabled = true;
  responseOutput.textContent = "";

  try {
    const response = await fetch(OPENAI_API_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getSelectedModel(),
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: promptInput.value }],
      }),
    });

    if (!response.ok) {
      const payload = await response.json();
      responseOutput.textContent = JSON.stringify(payload, null, 2);
      return;
    }

    if (!response.body) {
      throw new Error("Streaming response body is not available.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let message = "";
    let usageText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const event of events) {
        const line = event
          .split("\n")
          .find((entry) => entry.startsWith("data: "));
        if (!line) {
          continue;
        }

        const data = line.slice(6);
        if (data === "[DONE]") {
          continue;
        }

        const payload = JSON.parse(data);
        if (payload.error) {
          throw new Error(payload.error.message || "Streaming request failed.");
        }

        const delta = payload.choices?.[0]?.delta?.content || "";
        message += delta;

        if (payload.usage) {
          usageText = `\n\nUsage:\n${JSON.stringify(payload.usage, null, 2)}`;
        }

        responseOutput.textContent = message || "Streaming...";
        if (usageText) {
          responseOutput.textContent += usageText;
        }
      }
    }
  } catch (error) {
    responseOutput.textContent = String(error);
  } finally {
    runButton.disabled = false;
  }
}

async function main() {
  setupModelSelector();
  await registerServiceWorker();
  startKeepAlive();
  await refreshStorageUsage();

  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.type === "webllm-progress") {
      setStatus(progressStatus, data.text);
      if (typeof data.model === "string") {
        setStatus(modelStatus, data.model);
      }
    } else if (data?.type === "webllm-model" && typeof data.model === "string") {
      setStatus(modelStatus, data.model);
      modelSelect.value = data.model;
    } else if (data?.type === "webllm-keepalive-ack") {
      setStatus(swStatus, "ready");
    } else if (data?.type === "webllm-request") {
      void handleRendererRequest(data);
    }
  });

  const models = await getModels();
  const initialModel =
    models?.data?.[0]?.id && AVAILABLE_MODELS.includes(models.data[0].id as AvailableModel)
      ? (models.data[0].id as AvailableModel)
      : DEFAULT_MODEL;

  modelSelect.value = initialModel;
  setStatus(modelStatus, loadedModel || initialModel);

  loadModelButton.addEventListener("click", () => {
    void preloadModel(getSelectedModel());
  });

  clearStorageButton.addEventListener("click", () => {
    void clearSelectedModelStorage();
  });

  refreshStorageButton.addEventListener("click", () => {
    void refreshStorageUsage();
  });

  runButton.addEventListener("click", () => {
    void runPrompt();
  });
}

void main().catch((error) => {
  setStatus(swStatus, "failed");
  responseOutput.textContent = String(error);
});
