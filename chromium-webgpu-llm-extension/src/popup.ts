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
const progressTrack = document.getElementById("progress-track") as HTMLDivElement;
const progressBar = document.getElementById("progress-bar") as HTMLDivElement;
// const progressLabel = document.getElementById("progress-label") as HTMLSpanElement;
const engineStatus = document.getElementById("engine-status") as HTMLSpanElement;
const storageUsage = document.getElementById("storage-usage") as HTMLSpanElement;
const conversation = document.getElementById("conversation") as HTMLDivElement;

let chatHistory: ChatMessage[] = [];
let currentPageContext: CurrentPageContext | null = null;
let pendingRequestId: string | null = null;
let pendingAssistantNode: HTMLElement | null = null;
let offscreenPort: chrome.runtime.Port | null = null;
let statePollTimer: number | null = null;

function setText(element: HTMLElement, text: string) {
  element.textContent = text;
}

function setProgress(progress: number, indeterminate = false) {
  const clamped = Math.max(0, Math.min(progress, 1));
  const percent = Math.round(clamped * 100);

  progressTrack.classList.toggle("is-indeterminate", indeterminate);
  progressBar.style.width = indeterminate ? "45%" : `${percent}%`;
  progressTrack.setAttribute("aria-valuenow", String(percent));
  // progressLabel.textContent = indeterminate ? "Loading..." : `${percent}%`;
}

function trimPromptContext(text: string, maxChars: number) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}

function getSelectedModel(): AvailableModel {
  return modelSelect.value as AvailableModel;
}

function appendMessage(role: string, content: string) {
  const node = document.createElement("article");
  node.className = `message ${role}`;
  node.textContent = content;
  conversation.append(node);
  conversation.scrollTop = conversation.scrollHeight;
}

function renderConversation() {
  conversation.replaceChildren();
  if (chatHistory.length === 0) {
    appendMessage("system", "No messages yet. Load a model and send a prompt to start chatting.");
    return;
  }
  for (const message of chatHistory) {
    appendMessage(message.role, message.content);
  }
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
  setText(pageContextStatus, `Using page: ${currentPageContext.title || currentPageContext.url}`);
}

function syncState(state: BridgeState) {
  setText(modelStatus, state.modelStatus);
  setText(engineStatus, state.engineStatus);
  setText(storageUsage, state.storageUsage);
  setProgress(state.progress, state.engineStatus === "loading" && state.progress <= 0);
  setLoadingState(
    state.engineStatus === "loading" ||
      state.engineStatus === "generating" ||
      state.engineStatus === "cleaning",
  );
  syncStatePolling(state.engineStatus);

  if (!document.activeElement || document.activeElement !== modelSelect) {
    if (state.loadedModel) {
      modelSelect.value = state.loadedModel;
    } else if (!modelSelect.value) {
      modelSelect.value = DEFAULT_MODEL;
    }
  }
}

function requestServiceWorker(message: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    void chrome.runtime.sendMessage({ target: "service-worker", ...message }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(String(response?.error || "Service worker request failed.")));
        return;
      }
      resolve(response as Record<string, unknown>);
    });
  });
}

function handlePortDisconnect() {
  offscreenPort = null;
  stopStatePolling();
  setText(engineStatus, "idle");
  setText(modelStatus, "not loaded");
  setProgress(0, false);
  setLoadingState(false);
  appendMessage("system", "The model connection was lost. Reconnecting when needed.");
}

function handlePortMessage(message: Record<string, unknown>) {
  if (message.type === "state") {
    syncState(message as BridgeState);
    return;
  }

  if (message.type === "bridge-error") {
    appendMessage("system", String(message.message || "Unknown error"));
    return;
  }

  if (message.type === "chat-chunk" && message.requestId === pendingRequestId) {
    if (pendingAssistantNode && typeof message.text === "string") {
      pendingAssistantNode.textContent = message.text || "...";
      conversation.scrollTop = conversation.scrollHeight;
    }
    return;
  }

  if (message.type === "chat-done" && message.requestId === pendingRequestId) {
    if (pendingAssistantNode) {
      pendingAssistantNode.remove();
      pendingAssistantNode = null;
    }
    if (typeof message.text === "string") {
      chatHistory.push({ role: "assistant", content: message.text });
    }
    pendingRequestId = null;
    renderConversation();
    return;
  }

  if (message.type === "chat-error" && message.requestId === pendingRequestId) {
    if (pendingAssistantNode) {
      pendingAssistantNode.remove();
      pendingAssistantNode = null;
    }
    pendingRequestId = null;
    appendMessage("system", String(message.message || "Unknown error"));
  }
}

async function ensureOffscreenPort() {
  if (offscreenPort) {
    return offscreenPort;
  }

  await requestServiceWorker({ type: "ensure-offscreen" });

  const port = chrome.runtime.connect({ name: "webgpu-panel" });
  port.onMessage.addListener((message) => {
    handlePortMessage(message as Record<string, unknown>);
  });
  port.onDisconnect.addListener(() => {
    handlePortDisconnect();
  });

  offscreenPort = port;
  return port;
}

async function postToOffscreen(message: Record<string, unknown>) {
  const port = await ensureOffscreenPort();
  port.postMessage(message);
}

function stopStatePolling() {
  if (statePollTimer !== null) {
    window.clearInterval(statePollTimer);
    statePollTimer = null;
  }
}

function startStatePolling() {
  if (statePollTimer !== null) {
    return;
  }

  statePollTimer = window.setInterval(() => {
    void postToOffscreen({ type: "get-state" }).catch(() => {
      stopStatePolling();
    });
  }, 400);
}

function syncStatePolling(status: BridgeState["engineStatus"]) {
  if (status === "loading" || status === "generating" || status === "cleaning") {
    startStatePolling();
    return;
  }

  stopStatePolling();
}

async function handleLoadModel() {
  try {
    setText(engineStatus, "loading");
    setText(modelStatus, `loading ${getSelectedModel()}`);
    setProgress(0, true);
    setLoadingState(true);
    startStatePolling();
    await postToOffscreen({
      type: "load-model",
      model: getSelectedModel(),
    });
  } catch (error) {
    appendMessage("system", error instanceof Error ? error.message : String(error));
  }
}

async function handleCleanModelStorage() {
  chatHistory = [];
  renderConversation();
  appendMessage("system", `Clearing cached downloads for ${getSelectedModel()}...`);

  try {
    setText(engineStatus, "cleaning");
    setText(modelStatus, `cleaning ${getSelectedModel()}`);
    setProgress(0, false);
    setLoadingState(true);
    startStatePolling();
    await postToOffscreen({
      type: "clean-model",
      model: getSelectedModel(),
    });
  } catch (error) {
    appendMessage("system", error instanceof Error ? error.message : String(error));
  }
}

async function handleUseCurrentPage() {
  setText(pageContextStatus, "Reading current page...");
  try {
    const response = await requestServiceWorker({ type: "get-current-page" });
    currentPageContext = response.page as CurrentPageContext;
    syncPageContextStatus();
    appendMessage(
      "system",
      `Attached current page: ${currentPageContext.title || currentPageContext.url}`,
    );
  } catch (error) {
    syncPageContextStatus();
    appendMessage("system", error instanceof Error ? error.message : String(error));
  }
}

async function handleSendPrompt() {
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

  try {
    setText(engineStatus, "generating");
    setLoadingState(true);
    startStatePolling();
    await postToOffscreen({
      type: "chat",
      requestId: pendingRequestId,
      model: getSelectedModel(),
      messages: requestMessages,
    });
  } catch (error) {
    if (pendingAssistantNode) {
      pendingAssistantNode.remove();
      pendingAssistantNode = null;
    }
    pendingRequestId = null;
    appendMessage("system", error instanceof Error ? error.message : String(error));
  }
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

async function main() {
  populateModelSelector();
  renderConversation();
  setText(modelStatus, "not loaded");
  setText(engineStatus, "idle");
  setText(storageUsage, "checking...");
  setProgress(0, false);
  syncPageContextStatus();

  try {
    await postToOffscreen({ type: "get-state" });
  } catch (error) {
    appendMessage("system", error instanceof Error ? error.message : String(error));
  }

  loadButton.addEventListener("click", () => {
    void handleLoadModel();
  });
  cleanButton.addEventListener("click", () => {
    void handleCleanModelStorage();
  });
  usePageButton.addEventListener("click", () => {
    void handleUseCurrentPage();
  });
  sendButton.addEventListener("click", () => {
    void handleSendPrompt();
  });
  clearButton.addEventListener("click", handleClearChat);

  promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void handleSendPrompt();
    }
  });
}

void main();
