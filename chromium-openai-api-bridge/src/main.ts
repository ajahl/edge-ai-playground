import * as webllm from "@mlc-ai/web-llm";
import { DEFAULT_MODEL } from "./index";

const rendererStatus = document.getElementById(
  "renderer-status",
) as HTMLSpanElement;
const modelStatus = document.getElementById("model-status") as HTMLSpanElement;
const progressStatus = document.getElementById(
  "progress-status",
) as HTMLSpanElement;
const logOutput = document.getElementById("log-output") as HTMLPreElement;

let engine: webllm.MLCEngineInterface | null = null;
let loadPromise: Promise<void> | null = null;

function setText(element: HTMLElement, text: string) {
  element.textContent = text;
}

function log(text: string) {
  logOutput.textContent = text;
}

async function ensureLoaded() {
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    if (!engine) {
      engine = await webllm.CreateMLCEngine(DEFAULT_MODEL, {
        initProgressCallback(report) {
          setText(progressStatus, report.text);
          if (report.progress === 1) {
            setText(modelStatus, DEFAULT_MODEL);
          }
          window.bridgeEmit?.({
            id: "system",
            type: "progress",
            payload: report,
          });
        },
      });
    }
  })().catch((error) => {
    loadPromise = null;
    throw error;
  });

  return loadPromise;
}

window.webllmLoad = async () => {
  await ensureLoaded();
  log("Model is ready for terminal requests.");
  return {
    ok: true,
    loaded: true,
    model: DEFAULT_MODEL,
  };
};

window.webllmChat = async (request: Record<string, unknown>) => {
  await ensureLoaded();
  if (!engine) {
    throw new Error("Engine failed to initialize.");
  }

  const { model: _ignoredModel, ...rest } = request;
  const completion = await engine.chat.completions.create(
    rest as webllm.ChatCompletionRequestNonStreaming,
  );
  log(completion.choices[0]?.message?.content || "Done.");
  return completion;
};

window.webllmStreamChat = async (id: string, request: Record<string, unknown>) => {
  await ensureLoaded();
  if (!engine) {
    throw new Error("Engine failed to initialize.");
  }

  const { model: _ignoredModel, ...rest } = request;
  try {
    const generator = await engine.chat.completions.create(
      rest as webllm.ChatCompletionRequestStreaming,
    );
    let message = "";
    for await (const chunk of generator) {
      message += chunk.choices[0]?.delta?.content || "";
      log(message || "Streaming...");
      window.bridgeEmit?.({
        id,
        type: "chunk",
        payload: chunk,
      });
    }
    window.bridgeEmit?.({
      id,
      type: "done",
    });
  } catch (error) {
    window.bridgeEmit?.({
      id,
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

setText(rendererStatus, "ready");
log("Renderer is ready. Waiting for Puppeteer on http://127.0.0.1:3890");
window.webllmBridgeReady = true;
