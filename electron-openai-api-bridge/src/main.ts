import * as webllm from "@mlc-ai/web-llm";
import { AVAILABLE_MODELS, DEFAULT_MODEL, type AvailableModel } from "./index";

const rendererStatus = document.getElementById(
  "renderer-status",
) as HTMLSpanElement;
const modelStatus = document.getElementById("model-status") as HTMLSpanElement;
const progressStatus = document.getElementById(
  "progress-status",
) as HTMLSpanElement;
const apiStatus = document.getElementById("api-status") as HTMLSpanElement;
const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
const loadModelButton = document.getElementById(
  "load-model-button",
) as HTMLButtonElement;
const logOutput = document.getElementById("log-output") as HTMLPreElement;
const runtimeConfig = window.electronWebLLM.getRuntimeConfig();

let loadPromise: Promise<void> | null = null;
let engine: webllm.MLCEngineInterface | null = null;
let loadedModel: AvailableModel | null = null;
let loadingModel: AvailableModel | null = null;

function setText(element: HTMLElement, text: string) {
  element.textContent = text;
}

function log(text: string) {
  logOutput.textContent = text;
}

function setLoadingState(isLoading: boolean) {
  modelSelect.disabled = isLoading;
  loadModelButton.disabled = isLoading;
}

function getSelectedModel(): AvailableModel {
  return modelSelect.value as AvailableModel;
}

function syncLoadButtonLabel() {
  if (loadModelButton.disabled) {
    loadModelButton.textContent = "Loading...";
    return;
  }

  loadModelButton.textContent =
    loadedModel === getSelectedModel() ? "Model Loaded" : "Load Selected Model";
}

function setupModelSelector() {
  for (const model of AVAILABLE_MODELS) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === DEFAULT_MODEL;
    modelSelect.append(option);
  }

  modelSelect.addEventListener("change", () => {
    syncLoadButtonLabel();
  });

  loadModelButton.addEventListener("click", () => {
    void loadSelectedModel();
  });

  syncLoadButtonLabel();
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
          setText(progressStatus, report.text);
          window.electronWebLLM.sendProgress({
            progress: report.progress,
            text: report.text,
          });
          if (report.progress === 1) {
            setText(modelStatus, modelId);
          }
        },
      });
    }

    if (loadedModel !== modelId) {
      loadingModel = modelId;
      setText(modelStatus, `loading ${modelId}`);
      await engine.reload(modelId);
      loadedModel = modelId;
    }
  })().catch((error) => {
    loadPromise = null;
    loadingModel = null;
    setLoadingState(false);
    syncLoadButtonLabel();
    throw error;
  }).then(() => {
    loadPromise = null;
    loadingModel = null;
    setLoadingState(false);
    syncLoadButtonLabel();
  });

  return loadPromise;
}

async function handleLoad(id: string) {
  await ensureLoaded();
  log("Model is ready for localhost requests.");
  window.electronWebLLM.sendResponse(id, {
    ok: true,
    loaded: true,
    model: loadedModel,
  });
}

async function handleChat(id: string, payload: Record<string, unknown>) {
  await ensureLoaded();

  if (!engine) {
    throw new Error("Engine failed to initialize.");
  }

  const { model: _ignoredModel, ...request } = payload;
  if (request.stream === true) {
    const generator = await engine.chat.completions.create(
      request as webllm.ChatCompletionRequestStreaming,
    );
    let streamed = "";
    for await (const chunk of generator) {
      streamed += chunk.choices[0]?.delta?.content || "";
      log(streamed || "Streaming...");
      window.electronWebLLM.sendStreamChunk(id, chunk);
    }
    window.electronWebLLM.sendStreamDone(id);
    return;
  }

  const completion = await engine.chat.completions.create(
    request as webllm.ChatCompletionRequestNonStreaming,
  );
  log(completion.choices[0]?.message?.content || "Done.");
  window.electronWebLLM.sendResponse(id, completion);
}

async function warmModelOnStartup() {
  log(`Loading ${getSelectedModel()} at startup...`);
  try {
    await ensureLoaded();
    log("Model is ready for localhost requests.");
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    log(`Startup model load failed: ${err}`);
  }
}

async function loadSelectedModel() {
  const model = getSelectedModel();
  log(`Loading ${model}...`);
  try {
    await ensureLoaded(model);
    log(`Model ${model} is ready for localhost requests.`);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    log(`Failed to load ${model}: ${err}`);
  }
}

function main() {
  setupModelSelector();
  setText(rendererStatus, "ready");
  setText(apiStatus, runtimeConfig.apiUrl);
  log(`Renderer is ready. Waiting for localhost requests on ${runtimeConfig.apiUrl}`);

  window.electronWebLLM.onRequest((message) => {
    void (async () => {
      try {
        if (message.kind === "load") {
          await handleLoad(message.id);
          return;
        }

        if (message.kind === "chat") {
          await handleChat(message.id, message.payload || {});
        }
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        log(err);
        if (message.payload?.stream === true) {
          window.electronWebLLM.sendStreamError(message.id, err);
        } else {
          window.electronWebLLM.sendError(message.id, err);
        }
      }
    })();
  });

  window.electronWebLLM.notifyReady();
  // void warmModelOnStartup();
}

main();
