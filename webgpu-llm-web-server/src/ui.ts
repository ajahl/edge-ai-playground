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

export function appendMessage(role: "system" | "user" | "assistant", content: string) {
  const node = document.createElement("article");
  node.className = `message ${role}`;
  node.textContent = content;
  responseOutput.append(node);
  scrollTranscriptToBottom();
  return node;
}

export function renderConversation(chatHistory: ChatMessage[]) {
  responseOutput.replaceChildren();

  if (chatHistory.length === 0) {
    appendMessage(
      "system",
      "No messages yet. Load a model and send a prompt to start chatting.",
    );
    return;
  }

  for (const message of chatHistory) {
    appendMessage(message.role, message.content);
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
