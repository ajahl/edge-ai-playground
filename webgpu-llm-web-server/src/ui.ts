import {
  clearChatButton,
  clearStorageButton,
  clearUrlButton,
  loadModelButton,
  modelSelect,
  progressBar,
  refreshStorageButton,
  responseOutput,
  runButton,
  swStatus,
} from "./dom";
import type { ChatMessage } from "./types";
import { setStatus } from "./utils";

export function setAppState(state: string) {
  setStatus(swStatus, state);
}

export function setProgress(progress: number) {
  const clamped = Math.max(0, Math.min(progress, 1));
  progressBar.style.width = `${Math.round(clamped * 100)}%`;
}

export function scrollTranscriptToBottom() {
  responseOutput.scrollTop = responseOutput.scrollHeight;
  responseOutput.lastElementChild?.scrollIntoView({ block: "end" });
}

function formatMetric(label: string, value: string) {
  return `${label} ${value}`;
}

function formatUsageSummary(message: ChatMessage) {
  if (!message.usage) {
    return null;
  }

  const parts: string[] = [];
  const { usage } = message;
  const extra = usage.extra;

  if (typeof usage.prompt_tokens === "number") {
    parts.push(formatMetric("prompt", String(usage.prompt_tokens)));
  }
  if (typeof usage.completion_tokens === "number") {
    parts.push(formatMetric("completion", String(usage.completion_tokens)));
  }
  if (typeof usage.total_tokens === "number") {
    parts.push(formatMetric("total", String(usage.total_tokens)));
  }
  if (typeof extra?.time_to_first_token_s === "number") {
    parts.push(formatMetric("ttft", `${extra.time_to_first_token_s.toFixed(2)}s`));
  }
  if (typeof extra?.decode_tokens_per_s === "number") {
    parts.push(formatMetric("decode", `${extra.decode_tokens_per_s.toFixed(1)} tok/s`));
  }
  if (typeof extra?.prefill_tokens_per_s === "number") {
    parts.push(formatMetric("prefill", `${extra.prefill_tokens_per_s.toFixed(1)} tok/s`));
  }
  if (typeof extra?.e2e_latency_s === "number") {
    parts.push(formatMetric("latency", `${extra.e2e_latency_s.toFixed(2)}s`));
  }

  return parts.length > 0 ? parts.join(" • ") : null;
}

export function appendMessage(message: ChatMessage) {
  const node = document.createElement("article");
  node.className = `message ${message.role}`;

  const body = document.createElement("div");
  body.textContent = message.content;
  node.append(body);

  const usageSummary = formatUsageSummary(message);
  if (usageSummary) {
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = usageSummary;
    node.append(meta);
  }

  responseOutput.append(node);
  scrollTranscriptToBottom();
  return node;
}

export function renderConversation(chatHistory: ChatMessage[]) {
  responseOutput.replaceChildren();

  if (chatHistory.length === 0) {
    appendMessage(
      {
        role: "system",
        content: "No messages yet. Load a model and send a prompt to start chatting.",
      },
    );
    return;
  }

  for (const message of chatHistory) {
    appendMessage(message);
  }
}

export function setLoadingState(isLoading: boolean) {
  modelSelect.disabled = isLoading;
  loadModelButton.disabled = isLoading;
  clearStorageButton.disabled = isLoading;
  refreshStorageButton.disabled = isLoading;
  clearUrlButton.disabled = isLoading;
  runButton.disabled = isLoading;
  clearChatButton.disabled = isLoading;
}
