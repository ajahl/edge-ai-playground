import "./styles.css";
import {
  AVAILABLE_MODELS,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DEFAULT_MODEL,
  DEFAULT_SLIDING_WINDOW_SIZE,
  OPENAI_API_PATH,
  type AvailableModel,
} from "./index";
import {
  attachedUrlStatus,
  clearChatButton,
  clearStorageButton,
  clearUrlButton,
  loadModelButton,
  modelSelect,
  modelStatus,
  progressStatus,
  promptInput,
  refreshStorageButton,
  responseOutput,
  runButton,
  stopButton,
  swStatus,
} from "./dom";
import { refreshStorageUsage } from "./cache";
import { createModelRuntime } from "./model-runtime";
import { getModels, postToServiceWorker, registerServiceWorker, startKeepAlive } from "./service-worker-client";
import type { AttachedUrlContext, ChatMessage } from "./types";
import { appendMessage, renderConversation, scrollTranscriptToBottom, setAppState, setLoadingState, setProgress } from "./ui";
import { attachUrlContext, buildRequestMessages, clearAttachedUrlContext, getSelectedModel, syncAttachedUrlStatus } from "./url-context";
import { setStatus } from "./utils";

const serviceWorkerUrl = import.meta.env.DEV ? "/sw.ts" : "/sw.js";

let keepAliveTimer: number | null = null;
let chatHistory: ChatMessage[] = [];
let activeChatAbortController: AbortController | null = null;
let attachedUrlContext: AttachedUrlContext | null = null;

function addSystemMessage(content: string) {
  chatHistory.push({ role: "system", content });
  renderConversation(chatHistory);
}

async function refreshStorage() {
  await refreshStorageUsage((model) => {
    void runtime.preloadModel(model);
  });
}

const runtime = createModelRuntime({
  addSystemMessage,
  getSelectedModel,
  refreshStorage,
  setAppState,
  setLoadingState,
  setProgress,
});

function setupModelSelector() {
  for (const model of AVAILABLE_MODELS) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === DEFAULT_MODEL;
    modelSelect.append(option);
  }
}

async function runPrompt() {
  runButton.disabled = true;
  stopButton.disabled = false;
  const prompt = promptInput.value.trim();
  if (!prompt) {
    runButton.disabled = false;
    stopButton.disabled = true;
    return;
  }

  if (
    responseOutput.childElementCount === 1 &&
    responseOutput.firstElementChild?.classList.contains("system")
  ) {
    const existingText = responseOutput.firstElementChild.textContent || "";
    if (existingText.startsWith("No messages yet.")) {
      responseOutput.replaceChildren();
    }
  }

  setAppState("generating");
  try {
    attachedUrlContext = await attachUrlContext(attachedUrlContext);
  } catch (error) {
    attachedUrlStatus.textContent = error instanceof Error ? error.message : String(error);
  }

  chatHistory.push({
    role: "user",
    content: prompt,
  });
  renderConversation(chatHistory);
  const assistantNode = appendMessage({
    role: "assistant",
    content: "...",
  });
  activeChatAbortController = new AbortController();

  try {
    const response = await fetch(OPENAI_API_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: activeChatAbortController.signal,
      body: JSON.stringify({
        model: getSelectedModel(),
        stream: true,
        context_window_size: DEFAULT_CONTEXT_WINDOW_SIZE,
        sliding_window_size: DEFAULT_SLIDING_WINDOW_SIZE,
        stream_options: { include_usage: true },
        messages: buildRequestMessages(chatHistory, attachedUrlContext),
      }),
    });

    if (!response.ok) {
      const payload = await response.json();
      assistantNode.className = "message system";
      assistantNode.textContent = JSON.stringify(payload, null, 2);
      addSystemMessage(JSON.stringify(payload, null, 2));
      return;
    }

    if (!response.body) {
      throw new Error("Streaming response body is not available.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let message = "";
    let usage: ChatMessage["usage"];

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
          usage = payload.usage;
        }

        assistantNode.replaceChildren();
        const body = document.createElement("div");
        body.textContent = message || "Streaming...";
        assistantNode.append(body);
        if (usage) {
          const meta = document.createElement("div");
          meta.className = "message-meta";
          const parts: string[] = [];
          if (typeof usage.prompt_tokens === "number") {
            parts.push(`prompt ${usage.prompt_tokens}`);
          }
          if (typeof usage.completion_tokens === "number") {
            parts.push(`completion ${usage.completion_tokens}`);
          }
          if (typeof usage.total_tokens === "number") {
            parts.push(`total ${usage.total_tokens}`);
          }
          if (typeof usage.extra?.decode_tokens_per_s === "number") {
            parts.push(`decode ${usage.extra.decode_tokens_per_s.toFixed(1)} tok/s`);
          }
          if (typeof usage.extra?.time_to_first_token_s === "number") {
            parts.push(`ttft ${usage.extra.time_to_first_token_s.toFixed(2)}s`);
          }
          meta.textContent = parts.join(" • ");
          assistantNode.append(meta);
        }
        scrollTranscriptToBottom();
      }
    }

    chatHistory.push({
      role: "assistant",
      content: message || "Streaming...",
      usage,
    });
    renderConversation(chatHistory);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      assistantNode.className = "message system";
      assistantNode.textContent = "Generation stopped.";
      addSystemMessage("Generation stopped.");
    } else {
      setAppState("error");
      assistantNode.className = "message system";
      assistantNode.textContent = String(error);
      addSystemMessage(String(error));
    }
  } finally {
    activeChatAbortController = null;
    runButton.disabled = false;
    stopButton.disabled = true;
    setAppState(runtime.getLoadedModel() ? "ready" : "idle");
  }
}

function stopChat() {
  activeChatAbortController?.abort();
}

function clearChat() {
  chatHistory = [];
  renderConversation(chatHistory);
}

async function main() {
  setupModelSelector();
  await registerServiceWorker(serviceWorkerUrl, setAppState);
  keepAliveTimer = startKeepAlive(postToServiceWorker);
  await refreshStorage();
  setProgress(0);
  renderConversation(chatHistory);
  syncAttachedUrlStatus(attachedUrlContext);

  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.type === "webllm-progress") {
      setStatus(progressStatus, data.text);
      if (typeof data.progress === "number") {
        setProgress(data.progress);
      }
      if (typeof data.model === "string") {
        setStatus(modelStatus, data.model);
      }
    } else if (data?.type === "webllm-model" && typeof data.model === "string") {
      setStatus(modelStatus, data.model);
      modelSelect.value = data.model;
    } else if (data?.type === "webllm-keepalive-ack") {
      if (swStatus.textContent === "registering") {
        setAppState(runtime.getLoadedModel() ? "ready" : "idle");
      }
    } else if (data?.type === "webllm-request") {
      void runtime.handleRendererRequest(data);
    }
  });

  const models = await getModels();
  const initialModel =
    models?.data?.[0]?.id && AVAILABLE_MODELS.includes(models.data[0].id as AvailableModel)
      ? (models.data[0].id as AvailableModel)
      : DEFAULT_MODEL;

  modelSelect.value = initialModel;
  setStatus(modelStatus, runtime.getLoadedModel() || initialModel);

  loadModelButton.addEventListener("click", () => {
    void runtime.preloadModel(getSelectedModel());
  });

  clearStorageButton.addEventListener("click", () => {
    void runtime.clearSelectedModelStorage();
  });

  refreshStorageButton.addEventListener("click", () => {
    void refreshStorage();
  });

  clearUrlButton.addEventListener("click", () => {
    attachedUrlContext = clearAttachedUrlContext();
  });

  stopButton.disabled = true;
  stopButton.addEventListener("click", () => {
    stopChat();
  });

  clearChatButton.addEventListener("click", () => {
    clearChat();
  });

  runButton.addEventListener("click", () => {
    void runPrompt();
  });
}

void main().catch((error) => {
  setAppState("failed");
  chatHistory = [{ role: "system", content: String(error) }];
  renderConversation(chatHistory);
});
