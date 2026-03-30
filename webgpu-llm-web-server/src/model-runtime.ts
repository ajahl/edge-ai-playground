import * as webllm from "@mlc-ai/web-llm";
import { LOAD_API_PATH, type AvailableModel } from "./index";
import { ensureModelInAppConfig, getAppConfig } from "./app-config";
import { DEFAULT_MODEL } from "./models";
import {
  clearWebLLMBrowserStorage,
  inspectWebLLMCache,
  removeCachedModelMeta,
  upsertCachedModelMeta,
} from "./cache";
import { modelStatus, progressStatus } from "./dom";
import { postToServiceWorker } from "./service-worker-client";
import { setStatus } from "./utils";

type RendererRequest = {
  id: string;
  kind: "load" | "chat";
  payload?: Record<string, unknown>;
};

type RuntimeDeps = {
  addSystemMessage: (content: string) => void;
  getSelectedModel: () => AvailableModel;
  refreshStorage: () => Promise<void>;
  setAppState: (state: string) => void;
  setLoadingState: (isLoading: boolean) => void;
  setProgress: (progress: number) => void;
};

export function createModelRuntime(deps: RuntimeDeps) {
  let loadPromise: Promise<void> | null = null;
  let engine: webllm.MLCEngineInterface | null = null;
  let loadedModel: AvailableModel | null = null;
  let loadingModel: AvailableModel | null = null;

  async function ensureLoaded(modelId: AvailableModel = deps.getSelectedModel()) {
    console.debug("[webgpu-llm] ensureLoaded called", {
      modelId,
      loadedModel,
      loadingModel,
      hasPendingLoad: loadPromise !== null,
    });

    if (loadPromise) {
      if (loadingModel === modelId || (loadedModel === modelId && loadingModel === null)) {
        console.debug("[webgpu-llm] reusing existing load promise", { modelId });
        return loadPromise;
      }

      console.debug("[webgpu-llm] waiting for current load before switching model", {
        currentLoadingModel: loadingModel,
        requestedModel: modelId,
      });
      await loadPromise;
      return ensureLoaded(modelId);
    }

    loadPromise = (async () => {
      deps.setLoadingState(true);
      deps.setAppState("loading");

      if (!engine) {
        const appConfig = getAppConfig();
        engine = new webllm.MLCEngine({
          appConfig,
          initProgressCallback(report) {
            setStatus(progressStatus, report.text);
            deps.setProgress(report.progress);
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
        ensureModelInAppConfig(modelId);
        engine.setAppConfig(getAppConfig());
        loadingModel = modelId;
        setStatus(modelStatus, `loading ${modelId}`);
        console.debug("[webgpu-llm] starting engine.reload", { modelId });
        await engine.reload(modelId);
        console.debug("[webgpu-llm] finished engine.reload", { modelId });
        loadedModel = modelId;
        loadingModel = null;
        deps.setProgress(1);
        deps.setAppState("ready");
        postToServiceWorker({
          type: "webllm-model",
          model: modelId,
        });
      }
    })().catch((error) => {
      loadPromise = null;
      loadingModel = null;
      deps.setLoadingState(false);
      deps.setAppState("error");
      throw error;
    }).then(() => {
      loadPromise = null;
      loadingModel = null;
      deps.setLoadingState(false);
      deps.setAppState(loadedModel ? "ready" : "idle");
    });

    return loadPromise;
  }

  async function handleRendererRequest(message: RendererRequest) {
    try {
      if (message.kind === "load") {
        const requestedModel =
          typeof message.payload?.model === "string"
            ? (message.payload.model as AvailableModel)
            : deps.getSelectedModel();
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
          : deps.getSelectedModel();

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
    ensureModelInAppConfig(model);
    console.debug("[webgpu-llm] preloadModel requested", { model });
    deps.setLoadingState(true);
    deps.setAppState("loading");
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

      console.debug("[webgpu-llm] preloadModel response", {
        requestedModel: model,
        loadedModel: payload.model || model,
      });

      setStatus(modelStatus, payload.model || model);
      setStatus(progressStatus, "ready");
      deps.setProgress(1);
      deps.setAppState("ready");
      const inspection = await inspectWebLLMCache();
      if (inspection) {
        const sizeBytes = inspection.perModelBytes.get(model) ?? 0;
        upsertCachedModelMeta(model, sizeBytes);
      }
      deps.addSystemMessage(`Model ${payload.model || model} is ready.`);
      await deps.refreshStorage();
    } finally {
      deps.setLoadingState(false);
    }
  }

  async function clearSelectedModelStorage() {
    const model = deps.getSelectedModel();
    deps.setLoadingState(true);
    deps.setAppState("clearing");
    deps.addSystemMessage(`Clearing cached downloads for ${model}...`);

    try {
      if (engine && loadedModel === model) {
        await engine.unload();
        loadedModel = null;
        loadingModel = null;
        setStatus(modelStatus, "not loaded");
        setStatus(progressStatus, "idle");
        deps.setProgress(0);
        deps.setAppState("idle");
        postToServiceWorker({
          type: "webllm-model",
          model: DEFAULT_MODEL,
        });
      }

      await webllm.deleteModelAllInfoInCache(model);
      await clearWebLLMBrowserStorage();
      removeCachedModelMeta(model);
      deps.addSystemMessage(`Cleared cached downloads for ${model}.`);
      await deps.refreshStorage();
    } catch (error) {
      deps.setAppState("error");
      deps.addSystemMessage(error instanceof Error ? error.message : String(error));
    } finally {
      deps.setLoadingState(false);
      deps.setAppState(loadedModel ? "ready" : "idle");
    }
  }

  function getLoadedModel() {
    return loadedModel;
  }

  return {
    clearSelectedModelStorage,
    getLoadedModel,
    handleRendererRequest,
    preloadModel,
  };
}
