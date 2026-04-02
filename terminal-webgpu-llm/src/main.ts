import * as webllm from "@mlc-ai/web-llm";
import { AVAILABLE_MODELS, DEFAULT_MODEL } from "./index";

let engine: webllm.MLCEngineInterface | null = null;
let loadPromise: Promise<void> | null = null;
let loadedModel: string | null = null;
let streamAbortRequested = false;
let diagnosticsLogged = false;

function emit(type: string, payload?: unknown) {
  window.bridgeEmit?.({ type, payload });
}

function summarizeMessages(messages: unknown) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.map((message, index) => {
    const role = typeof message?.role === "string" ? message.role : "unknown";
    const content =
      typeof message?.content === "string"
        ? message.content
        : Array.isArray(message?.content)
          ? message.content
              .map((part) => (typeof part?.text === "string" ? part.text : ""))
              .filter(Boolean)
              .join(" ")
          : "";
    return {
      index,
      role,
      chars: content.length,
      preview: content.slice(0, 160),
    };
  });
}

function summarizeChatPayload(payload: unknown) {
  return {
    model: typeof payload?.model === "string" ? payload.model : undefined,
    stream: payload?.stream === true,
    messageCount: Array.isArray(payload?.messages) ? payload.messages.length : 0,
    messages: summarizeMessages(payload?.messages),
    response_format: payload?.response_format,
    temperature: payload?.temperature,
    top_p: payload?.top_p,
    max_tokens: payload?.max_tokens,
    tool_choice: payload?.tool_choice,
    toolsCount: Array.isArray(payload?.tools) ? payload.tools.length : 0,
  };
}

function summarizeCompletion(completion: unknown) {
  return {
    id: completion?.id,
    object: completion?.object,
    hasChoices: Boolean(completion?.choices?.length),
    finishReason: completion?.choices?.[0]?.finish_reason,
    contentPreview:
      typeof completion?.choices?.[0]?.message?.content === "string"
        ? completion.choices[0].message.content.slice(0, 240)
        : undefined,
    usage: completion?.usage,
  };
}

function summarizeError(error: unknown) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

function formatMessagesSummary(messages: ReturnType<typeof summarizeMessages>) {
  if (messages.length === 0) {
    return "messages=0";
  }
  return messages
    .map((message) => `${message.index}:${message.role}[${message.chars}] "${message.preview.replace(/\s+/g, " ")}"`)
    .join(" | ");
}

function formatDebugPayload(payload: unknown): string {
  if (payload === undefined || payload === null) {
    return String(payload);
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (typeof payload !== "object") {
    return String(payload);
  }

  const value = payload as Record<string, unknown>;
  const parts: string[] = [];

  if (typeof value.model === "string") parts.push(`model=${value.model}`);
  if (typeof value.modelId === "string") parts.push(`modelId=${value.modelId}`);
  if (typeof value.requestId === "string") parts.push(`requestId=${value.requestId}`);
  if (typeof value.stream === "boolean") parts.push(`stream=${value.stream}`);
  if (typeof value.messageCount === "number") parts.push(`messages=${value.messageCount}`);
  if (Array.isArray(value.messages)) parts.push(formatMessagesSummary(value.messages as ReturnType<typeof summarizeMessages>));
  if ("response_format" in value) parts.push(`response_format=${value.response_format === undefined ? "undefined" : JSON.stringify(value.response_format)}`);
  if (typeof value.temperature === "number") parts.push(`temperature=${value.temperature}`);
  if (typeof value.top_p === "number") parts.push(`top_p=${value.top_p}`);
  if (typeof value.max_tokens === "number") parts.push(`max_tokens=${value.max_tokens}`);
  if (typeof value.tool_choice === "string") parts.push(`tool_choice=${value.tool_choice}`);
  if (typeof value.toolsCount === "number") parts.push(`tools=${value.toolsCount}`);
  if (typeof value.hasEngine === "boolean") parts.push(`hasEngine=${value.hasEngine}`);
  if (typeof value.loadedModel === "string" || value.loadedModel === null) parts.push(`loadedModel=${value.loadedModel}`);
  if (typeof value.loadingInFlight === "boolean") parts.push(`loadingInFlight=${value.loadingInFlight}`);
  if (typeof value.hasChoices === "boolean") parts.push(`hasChoices=${value.hasChoices}`);
  if (typeof value.finishReason === "string") parts.push(`finishReason=${value.finishReason}`);
  if (typeof value.contentPreview === "string") parts.push(`content="${value.contentPreview.replace(/\s+/g, " ")}"`);
  if (value.usage) parts.push(`usage=${JSON.stringify(value.usage)}`);
  if (typeof value.name === "string") parts.push(`name=${value.name}`);
  if (typeof value.message === "string") parts.push(`message="${value.message.replace(/\s+/g, " ")}"`);
  if (typeof value.chunkCount === "number") parts.push(`chunkCount=${value.chunkCount}`);
  if (typeof value.aborted === "boolean") parts.push(`aborted=${value.aborted}`);
  if (typeof value.stack === "string") parts.push(`stack=${value.stack.split("\n")[0]}`);

  if (parts.length > 0) {
    return parts.join(" | ");
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function debug(label: string, payload?: unknown) {
  if (payload === undefined) {
    emit("log", `[debug] ${label}`);
    return;
  }
  emit("log", `[debug] ${label}: ${formatDebugPayload(payload)}`);
}

async function logWebGPUDiagnostics() {
  if (diagnosticsLogged) {
    return;
  }
  diagnosticsLogged = true;

  if (!("gpu" in navigator)) {
    emit("log", "[debug] webgpu diagnostics: navigator.gpu unavailable");
    return;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      emit("log", "[debug] webgpu diagnostics: no adapter available");
      return;
    }

    const adapterInfo = "requestAdapterInfo" in adapter
      ? await (adapter as GPUAdapter & { requestAdapterInfo?: () => Promise<Record<string, unknown>> }).requestAdapterInfo?.()
      : undefined;

    const device = await adapter.requestDevice();
    const interestingLimits = {
      maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxComputeInvocationsPerWorkgroup: device.limits.maxComputeInvocationsPerWorkgroup,
      maxComputeWorkgroupSizeX: device.limits.maxComputeWorkgroupSizeX,
      maxComputeWorkgroupSizeY: device.limits.maxComputeWorkgroupSizeY,
      maxComputeWorkgroupSizeZ: device.limits.maxComputeWorkgroupSizeZ,
      maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
    };

    emit("log", `[debug] webgpu adapter: ${formatDebugPayload({
      vendor: adapterInfo?.vendor,
      architecture: adapterInfo?.architecture,
      device: adapterInfo?.device,
      description: adapterInfo?.description,
      fallback: adapter.isFallbackAdapter,
    })}`);
    emit("log", `[debug] webgpu limits: ${formatDebugPayload(interestingLimits)}`);

    device.destroy();
  } catch (error) {
    emit("log", `[debug] webgpu diagnostics error: ${formatDebugPayload(summarizeError(error))}`);
  }
}

async function ensureLoaded(modelId = DEFAULT_MODEL) {
  debug("ensureLoaded called", {
    modelId,
    hasEngine: Boolean(engine),
    loadedModel,
    loadingInFlight: Boolean(loadPromise),
  });
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    if (!engine) {
      await logWebGPUDiagnostics();
      debug("creating engine", { modelId });
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
      debug("engine.reload start", { modelId });
      await engine.reload(modelId);
      loadedModel = modelId;
      debug("engine.reload done", { modelId });
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
  debug("tuiLoad payload", { modelId });
  await ensureLoaded(modelId);
  return {
    ok: true,
    loaded: true,
    model: modelId,
  };
};

window.tuiChat = async (payload) => {
  const modelId = typeof payload.model === "string" ? payload.model : DEFAULT_MODEL;
  debug("tuiChat payload", summarizeChatPayload({ ...payload, model: modelId }));
  await ensureLoaded(modelId);

  if (!engine) {
    throw new Error("Engine failed to initialize.");
  }

  const { model: _ignoredModel, ...request } = payload;
  debug("engine.chat.completions.create request", summarizeChatPayload(request));
  let completion;
  try {
    completion = await engine.chat.completions.create(
      request as webllm.ChatCompletionRequestNonStreaming,
    );
  } catch (error) {
    debug("engine.chat.completions.create error", summarizeError(error));
    throw error;
  }
  debug("engine.chat.completions.create response", summarizeCompletion(completion));

  return completion;
};

window.tuiChatStream = async (payload) => {
  const modelId = typeof payload?.model === "string" ? payload.model : DEFAULT_MODEL;
  const requestId = typeof payload?.requestId === "string" ? payload.requestId : crypto.randomUUID();
  debug("tuiChatStream payload", {
    ...summarizeChatPayload({ ...payload, model: modelId, stream: true }),
    requestId,
  });
  await ensureLoaded(modelId);

  if (!engine) {
    throw new Error("Engine failed to initialize.");
  }

  streamAbortRequested = false;
  const { model: _ignoredModel, requestId: _ignoredRequestId, ...request } = payload || {};
  let generator;
  try {
    generator = await engine.chat.completions.create({
      ...request,
      stream: true,
      stream_options: {
        ...(typeof request?.stream_options === "object" && request.stream_options ? request.stream_options : {}),
        include_usage: true,
      },
    } as webllm.ChatCompletionRequestStreaming);
  } catch (error) {
    debug("engine.chat.completions.create stream init error", summarizeError(error));
    throw error;
  }
  let latestUsage: unknown = null;
  let chunkCount = 0;

  try {
    for await (const chunk of generator) {
      if (streamAbortRequested) {
        break;
      }
      chunkCount += 1;
      latestUsage = chunk?.usage ?? latestUsage;
      emit("stream-chunk", {
        requestId,
        chunk,
      });
    }
  } catch (error) {
    debug("tuiChatStream iteration error", {
      requestId,
      ...summarizeError(error),
      chunkCount,
    });
    throw error;
  } finally {
    debug("tuiChatStream done", {
      requestId,
      chunkCount,
      latestUsage,
      aborted: streamAbortRequested,
    });
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
