import { AVAILABLE_MODELS, DEFAULT_MODEL, type AvailableModel } from "./index";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type CurrentPageContext = {
  title: string;
  url: string;
  content: string;
};

type BridgeState = {
  type: "state";
  engineStatus: "idle" | "loading" | "ready" | "generating" | "cleaning" | "error";
  loadedModel: AvailableModel | null;
  loadingModel: AvailableModel | null;
  progress: number;
  modelStatus: string;
  storageUsage: string;
};

const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
const loadButton = document.getElementById("load-button") as HTMLButtonElement;
const cleanButton = document.getElementById("clean-button") as HTMLButtonElement;
const usePageButton = document.getElementById("use-page-button") as HTMLButtonElement;
const sendButton = document.getElementById("send-button") as HTMLButtonElement;
const clearButton = document.getElementById("clear-button") as HTMLButtonElement;
const promptInput = document.getElementById("prompt-input") as HTMLTextAreaElement;
const pageContextStatus = document.getElementById("page-context-status") as HTMLSpanElement;
const modelStatus = document.getElementById("model-status") as HTMLSpanElement;
const progressBar = document.getElementById("progress-bar") as HTMLDivElement;
const engineStatus = document.getElementById("engine-status") as HTMLSpanElement;
const storageUsage = document.getElementById("storage-usage") as HTMLSpanElement;
const conversation = document.getElementById("conversation") as HTMLDivElement;

const port = chrome.runtime.connect({ name: "webgpu-popup" });

let chatHistory: ChatMessage[] = [];
let pendingRequestId: string | null = null;
let pendingAssistantNode: HTMLElement | null = null;
let currentPageContext: CurrentPageContext | null = null;

function trimPromptContext(text: string, maxChars: number) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}

function setText(element: HTMLElement, text: string) {
  element.textContent = text;
}

function setProgress(progress: number) {
  const clamped = Math.max(0, Math.min(progress, 1));
  progressBar.style.width = `${Math.round(clamped * 100)}%`;
}

function getSelectedModel(): AvailableModel {
  return modelSelect.value as AvailableModel;
}

function renderConversation() {
  conversation.replaceChildren();

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

function appendMessage(role: string, content: string) {
  const node = document.createElement("article");
  node.className = `message ${role}`;
  node.textContent = content;
  conversation.append(node);
  conversation.scrollTop = conversation.scrollHeight;
}

function setLoadingState(isLoading: boolean) {
  modelSelect.disabled = isLoading;
  loadButton.disabled = isLoading;
  cleanButton.disabled = isLoading;
  usePageButton.disabled = isLoading;
  sendButton.disabled = isLoading;
  clearButton.disabled = isLoading;
}

function syncPageContextStatus() {
  if (!currentPageContext) {
    setText(pageContextStatus, "No page attached");
    return;
  }

  const title = currentPageContext.title || currentPageContext.url;
  setText(pageContextStatus, `Using page: ${title}`);
}

function syncState(state: BridgeState) {
  setText(modelStatus, state.modelStatus);
  setText(engineStatus, state.engineStatus);
  setText(storageUsage, state.storageUsage);
  setProgress(state.progress);
  setLoadingState(
    state.engineStatus === "loading" ||
      state.engineStatus === "generating" ||
      state.engineStatus === "cleaning",
  );

  if (!document.activeElement || document.activeElement !== modelSelect) {
    if (state.loadedModel) {
      modelSelect.value = state.loadedModel;
    } else if (!modelSelect.value) {
      modelSelect.value = DEFAULT_MODEL;
    }
  }
}

function handleLoadModel() {
  port.postMessage({
    type: "load-model",
    model: getSelectedModel(),
  });
}

function handleCleanModelStorage() {
  chatHistory = [];
  renderConversation();
  appendMessage("system", `Clearing cached downloads for ${getSelectedModel()}...`);
  port.postMessage({
    type: "clean-model",
    model: getSelectedModel(),
  });
}

function handleUseCurrentPage() {
  setText(pageContextStatus, "Reading current page...");
  port.postMessage({
    type: "get-current-page",
  });
}

function handleSendPrompt() {
  const prompt = promptInput.value.trim();
  if (!prompt || pendingRequestId) {
    return;
  }

  const userMessage: ChatMessage = { role: "user", content: prompt };
  chatHistory.push(userMessage);
  renderConversation();
  promptInput.value = "";

  pendingRequestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pendingAssistantNode = document.createElement("article");
  pendingAssistantNode.className = "message assistant";
  pendingAssistantNode.textContent = "";
  conversation.append(pendingAssistantNode);

  const requestMessages = currentPageContext
    ? ([
        {
          role: "system",
          content:
            `Current page context:\nTitle: ${trimPromptContext(currentPageContext.title, 200)}\n` +
            `URL: ${trimPromptContext(currentPageContext.url, 500)}\n` +
            `Content:\n${trimPromptContext(currentPageContext.content, 3000)}`,
        },
        ...chatHistory,
      ] as ChatMessage[])
    : chatHistory;

  port.postMessage({
    type: "chat",
    requestId: pendingRequestId,
    model: getSelectedModel(),
    messages: requestMessages,
  });
}

function handleClearChat() {
  chatHistory = [];
  renderConversation();
}

function populateModelSelector() {
  for (const model of AVAILABLE_MODELS) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === DEFAULT_MODEL;
    modelSelect.append(option);
  }
}

function handlePortMessage(message: Record<string, unknown>) {
  if (message.type === "state") {
    syncState(message as BridgeState);
    return;
  }

  if (message.type === "bridge-error" && typeof message.message === "string") {
    syncPageContextStatus();
    appendMessage("system", message.message);
    return;
  }

  if (message.type === "current-page" && typeof message.page === "object" && message.page) {
    currentPageContext = message.page as CurrentPageContext;
    syncPageContextStatus();
    appendMessage(
      "system",
      `Attached current page: ${currentPageContext.title || currentPageContext.url}`,
    );
    return;
  }

  if (
    message.type === "chat-chunk" &&
    message.requestId === pendingRequestId &&
    typeof message.text === "string"
  ) {
    if (pendingAssistantNode) {
      pendingAssistantNode.textContent = message.text || "...";
      conversation.scrollTop = conversation.scrollHeight;
    }
    return;
  }

  if (
    message.type === "chat-done" &&
    message.requestId === pendingRequestId &&
    typeof message.text === "string"
  ) {
    if (pendingAssistantNode) {
      pendingAssistantNode.remove();
      pendingAssistantNode = null;
    }

    chatHistory.push({ role: "assistant", content: message.text });
    pendingRequestId = null;
    renderConversation();
    return;
  }

  if (
    message.type === "chat-error" &&
    message.requestId === pendingRequestId &&
    typeof message.message === "string"
  ) {
    if (pendingAssistantNode) {
      pendingAssistantNode.remove();
      pendingAssistantNode = null;
    }

    pendingRequestId = null;
    appendMessage("system", `Generation failed: ${message.message}`);
  }
}

function main() {
  populateModelSelector();
  renderConversation();

  setText(modelStatus, "not loaded");
  setText(engineStatus, "idle");
  setText(storageUsage, "checking...");
  setProgress(0);
  syncPageContextStatus();

  port.onMessage.addListener((message) => {
    handlePortMessage(message as Record<string, unknown>);
  });

  port.postMessage({ type: "get-state" });

  loadButton.addEventListener("click", handleLoadModel);
  cleanButton.addEventListener("click", handleCleanModelStorage);
  usePageButton.addEventListener("click", handleUseCurrentPage);
  sendButton.addEventListener("click", handleSendPrompt);
  clearButton.addEventListener("click", handleClearChat);

  promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleSendPrompt();
    }
  });
}

main();
