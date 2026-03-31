import * as webllm from "@mlc-ai/web-llm";
import { AVAILABLE_MODELS, DEFAULT_MODEL } from "./index";

let engine: webllm.MLCEngineInterface | null = null;
let loadPromise: Promise<void> | null = null;
let loadedModel: string | null = null;
let streamAbortRequested = false;

function emit(type: string, payload?: unknown) {
  window.bridgeEmit?.({ type, payload });
}

async function ensureLoaded(modelId = DEFAULT_MODEL) {
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    if (!engine) {
      engine = new webllm.MLCEngine({
        initProgressCallback(report) {
          emit("progress", {
            model: modelId,
            progress: report.progress,
            text: report.text,
          });
        },
      });
    }

    if (loadedModel !== modelId) {
      emit("log", `Loading model ${modelId}...`);
      await engine.reload(modelId);
      loadedModel = modelId;
      emit("loaded", { model: modelId });
    }
  })().catch((error) => {
    emit("error", error instanceof Error ? error.message : String(error));
    loadPromise = null;
    throw error;
  }).then(() => {
    loadPromise = null;
  });
  return loadPromise; 
}

async function inspectCache(knownModels: string[]) {
  if (!("caches" in window)) {
    return { totalBytes: 0, cachedModels: [] };
  }

  const cacheNames = ["webllm/model", "webllm/config", "webllm/wasm"];
  const perModelBytes = new Map();
  let totalBytes = 0;

  for (const cacheName of cacheNames) {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();

    for (const request of requests) {
      const matchedModel = knownModels.find((model) => request.url.includes(model)) ?? null;
      const response = await cache.match(request);
      if (!response) {
        continue;
      }
      const byteLength = (await response.clone().arrayBuffer()).byteLength;
      totalBytes += byteLength;
      if (matchedModel) {
        perModelBytes.set(matchedModel, (perModelBytes.get(matchedModel) ?? 0) + byteLength);
      }
    }
  }

  return {
    totalBytes,
    cachedModels: Array.from(perModelBytes.entries()).map(([model, sizeBytes]) => ({
      model,
      sizeBytes,
    })),
  };
}

window.tuiLoad = async (payload) => {
  const modelId = typeof payload?.model === "string" ? payload.model : DEFAULT_MODEL;
  await ensureLoaded(modelId);
  return {
    ok: true,
    loaded: true,
    model: modelId,
  };
};

window.tuiChat = async (payload) => {
  const modelId = typeof payload.model === "string" ? payload.model : DEFAULT_MODEL;
  await ensureLoaded(modelId);

  if (!engine) {
    throw new Error("Engine failed to initialize.");
  }

  const { model: _ignoredModel, ...request } = payload;
  const completion = await engine.chat.completions.create(
    request as webllm.ChatCompletionRequestNonStreaming,
  );

  return completion;
};

window.tuiChatStream = async (payload) => {
  const modelId = typeof payload?.model === "string" ? payload.model : DEFAULT_MODEL;
  const requestId = typeof payload?.requestId === "string" ? payload.requestId : crypto.randomUUID();
  await ensureLoaded(modelId);

  if (!engine) {
    throw new Error("Engine failed to initialize.");
  }

  streamAbortRequested = false;
  const { model: _ignoredModel, requestId: _ignoredRequestId, ...request } = payload || {};
  const generator = await engine.chat.completions.create({
    ...request,
    stream: true,
    stream_options: {
      ...(typeof request?.stream_options === "object" && request.stream_options ? request.stream_options : {}),
      include_usage: true,
    },
  } as webllm.ChatCompletionRequestStreaming);
  let latestUsage: unknown = null;

  try {
    for await (const chunk of generator) {
      if (streamAbortRequested) {
        break;
      }
      latestUsage = chunk?.usage ?? latestUsage;
      emit("stream-chunk", {
        requestId,
        chunk,
      });
    }
  } finally {
    emit("stream-done", {
      requestId,
      aborted: streamAbortRequested,
      usage: latestUsage,
    });
    streamAbortRequested = false;
  }

  return { ok: true, requestId };
};

window.tuiAbortStream = async () => {
  streamAbortRequested = true;
  return { ok: true };
};

window.tuiListCachedModels = async (payload) => {
  const models = Array.isArray(payload?.models)
    ? payload.models.filter((value) => typeof value === "string")
    : AVAILABLE_MODELS;
  return inspectCache(models);
};

window.tuiClearModel = async (payload) => {
  const modelId = typeof payload?.model === "string" ? payload.model : DEFAULT_MODEL;
  await webllm.deleteModelAllInfoInCache(modelId);
  if (loadedModel === modelId && engine) {
    await engine.unload();
    loadedModel = null;
  }
  return { ok: true, model: modelId };
};

emit("ready", { model: DEFAULT_MODEL });
window.tuiRendererReady = true;
