import http from "node:http";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import blessed from "blessed";
import { chromium } from "playwright-core";
import {
  apiPort,
  browserHost,
  builtInModels,
  defaultModel,
  distDir,
  executableNames,
  exposeRenderer,
  host,
  mimeTypes,
  rendererListenPort,
  startupModel,
  webllmModelLibUrlPrefix,
  webllmModelServerUrl,
} from "./lib/config.mjs";
import {
  buildChatCompletionChunk,
  cleanupExtractedText,
  decodeHtmlEntities,
  extractCompletionText,
  extractChunkText,
  extractFirstUrl,
  extractLastUserMessage,
  extractTitle,
  formatBytes,
  mapCompletionToResponse,
  normalizeResponseInput,
  stripHtmlToText,
} from "./lib/text-utils.mjs";
import { createUI, createUIController } from "./lib/ui.mjs";

let browser;
let page;
let currentModel = defaultModel;
const history = [];
let attachedUrlContext = null;
let knownModels = [...builtInModels];
let huggingFaceModels = [];
let localServerModels = [];
const pendingStreams = new Map();
let rendererPort = rendererListenPort;
let modelsRefreshPromise = null;
let interactionInFlight = false;
let pasteInProgress = false;
let lastPasteEndedAt = 0;
let lastPromptInputAt = 0;
let pendingSubmitTimer = null;
let modelPicker = null;
let modelPickerList = null;
let modelPickerIndexToModel = [];
let modelPickerPreviousFocus = null;
let promptInputOnFocusBeforePicker = true;
const chromiumHeadless = process.env.CHROMIUM_HEADLESS !== "false";

const PASTE_SUBMIT_GUARD_MS = 250;
const ENTER_SUBMIT_DEBOUNCE_MS = 120;

const ui = createUI();
const {
  screen,
  transcript,
  status,
  performance,
  input,
  renderStatus,
  setLatestUsage,
  logLine,
  appendTranscriptLine,
  replaceTranscriptLine,
  clearTranscript,
  exportTranscriptText,
  formatPrimaryTranscriptEntry,
  setFocusedView,
  moveFocus,
  setTranscriptFollow,
} = createUIController(ui, () => ({
  currentModel: getModelDisplay(currentModel),
  knownModelsCount: knownModels.length,
  attachedUrlTitle: attachedUrlContext?.title ?? null,
  apiPort,
  rendererLabel: exposeRenderer ? `renderer http://${browserHost}:${rendererPort}` : "renderer internal-only",
  apiUrl: `http://${host}:${apiPort}`,
  historyCount: history.length,
  builtInModelsCount: builtInModels.length,
  huggingFaceModelsCount: huggingFaceModels.length,
}));

const MODEL_SOURCE = {
  BUILTIN: "built-in",
  LOCAL: "local-webllm-model-server",
  HUGGINGFACE: "huggingface",
};

const MODEL_SOURCE_SHORT = {
  [MODEL_SOURCE.BUILTIN]: "built-in",
  [MODEL_SOURCE.LOCAL]: "local",
  [MODEL_SOURCE.HUGGINGFACE]: "hf",
};

let modelRegistry = new Map();
let builtInModelKeys = [];

function makeModelKey(source, modelId) {
  return `${source}::${modelId}`;
}

function createModelMeta(source, modelId) {
  const key = makeModelKey(source, modelId);
  return {
    key,
    source,
    modelId,
    display: `${modelId} [${MODEL_SOURCE_SHORT[source] || source}]`,
  };
}

function rebuildModelRegistry() {
  const registry = new Map();
  builtInModelKeys = builtInModels.map((modelId) => {
    const meta = createModelMeta(MODEL_SOURCE.BUILTIN, modelId);
    registry.set(meta.key, meta);
    return meta.key;
  });

  localServerModels = localServerModels.map((entry) => {
    const meta = typeof entry === "string" && entry.includes("::")
      ? modelRegistry.get(entry) || createModelMeta(MODEL_SOURCE.LOCAL, entry.split("::").slice(1).join("::"))
      : createModelMeta(MODEL_SOURCE.LOCAL, entry);
    registry.set(meta.key, meta);
    return meta.key;
  });

  huggingFaceModels = huggingFaceModels.map((entry) => {
    const meta = typeof entry === "string" && entry.includes("::")
      ? modelRegistry.get(entry) || createModelMeta(MODEL_SOURCE.HUGGINGFACE, entry.split("::").slice(1).join("::"))
      : createModelMeta(MODEL_SOURCE.HUGGINGFACE, entry);
    registry.set(meta.key, meta);
    return meta.key;
  });

  knownModels = [...builtInModelKeys, ...localServerModels, ...huggingFaceModels];
  modelRegistry = registry;
  if (!modelRegistry.has(currentModel)) {
    currentModel = makeModelKey(MODEL_SOURCE.BUILTIN, defaultModel);
  }
}

function getModelMeta(modelKey) {
  return modelRegistry.get(modelKey) ?? null;
}

function getModelDisplay(modelKey) {
  return getModelMeta(modelKey)?.display || modelKey;
}

function resolveModelSelection(input) {
  const requested = String(input || "").trim();
  if (!requested) {
    return currentModel;
  }
  if (modelRegistry.has(requested)) {
    return requested;
  }

  const matches = Array.from(modelRegistry.values()).filter((meta) => meta.modelId === requested);
  if (matches.length === 1) {
    return matches[0].key;
  }
  if (matches.length > 1) {
    const options = matches.map((meta) => meta.display).join(", ");
    throw new Error(`Model "${requested}" exists in multiple sources. Use /models and select one: ${options}`);
  }
  return requested;
}

rebuildModelRegistry();

function isModelPickerOpen() {
  return Boolean(modelPicker);
}

function buildModelPickerEntries() {
  const entries = [];
  const indexToModel = [];

  const pushSection = (title, models) => {
    entries.push(`{bold}${title}{/bold}`);
    indexToModel.push(null);

    if (models.length === 0) {
      entries.push("{gray-fg}  (none){/}");
      indexToModel.push(null);
      return;
    }

    for (const modelKey of models) {
      const marker = modelKey === currentModel ? "{green-fg}> {/}" : "  ";
      entries.push(`${marker}${getModelDisplay(modelKey)}`);
      indexToModel.push(modelKey);
    }
  };

  pushSection(`Built-in (${builtInModelKeys.length})`, builtInModelKeys);
  pushSection(`Local webllm-model-server (${localServerModels.length})`, localServerModels);
  pushSection(`Hugging Face (${huggingFaceModels.length})`, huggingFaceModels);

  return { entries, indexToModel };
}

function closeModelPicker(options = {}) {
  if (!modelPicker) {
    return;
  }

  const { restoreFocus = true } = options;
  modelPicker.detach();
  modelPicker = null;
  modelPickerList = null;
  modelPickerIndexToModel = [];
  screen.grabKeys = false;
  input.options.inputOnFocus = promptInputOnFocusBeforePicker;

  if (restoreFocus && modelPickerPreviousFocus && typeof modelPickerPreviousFocus.focus === "function") {
    modelPickerPreviousFocus.focus();
  }
  modelPickerPreviousFocus = null;
  screen.render();
}

function moveModelPickerSelection(direction) {
  if (!modelPickerList) {
    return;
  }

  let index = modelPickerList.selected;
  if (typeof index !== "number") {
    index = 0;
  }
  let nextIndex = index;

  while (true) {
    nextIndex += direction;
    if (nextIndex < 0 || nextIndex >= modelPickerIndexToModel.length) {
      return;
    }
    if (modelPickerIndexToModel[nextIndex]) {
      modelPickerList.select(nextIndex);
      screen.render();
      return;
    }
  }
}

function confirmModelPickerSelection() {
  if (!modelPickerList) {
    return;
  }
  const selectedIndex = typeof modelPickerList.selected === "number" ? modelPickerList.selected : -1;
  const selectedModel = selectedIndex >= 0 ? modelPickerIndexToModel[selectedIndex] : null;
  if (!selectedModel) {
    return;
  }
  currentModel = selectedModel;
  closeModelPicker();
  logLine("system", `selected model: ${getModelDisplay(currentModel)}`);
  renderStatus(`selected ${getModelDisplay(currentModel)}`);
}

function openModelPicker() {
  if (isModelPickerOpen()) {
    return;
  }

  const { entries, indexToModel } = buildModelPickerEntries();
  modelPickerIndexToModel = indexToModel;
  modelPickerPreviousFocus = screen.focused ?? input;
  promptInputOnFocusBeforePicker = Boolean(input.options.inputOnFocus);
  input.options.inputOnFocus = false;
  if (typeof input.blur === "function") {
    input.blur();
  }
  screen.grabKeys = true;

  const modal = blessed.box({
    parent: screen,
    top: "center",
    left: "center",
    width: "78%",
    height: "78%",
    label: " Select Model ",
    border: "line",
    tags: true,
    keys: true,
    mouse: true,
    vi: true,
    padding: { top: 1, bottom: 1, left: 1, right: 1 },
    style: {
      border: { fg: "cyan" },
      bg: "black",
    },
  });

  blessed.text({
    parent: modal,
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    tags: true,
    content: "Use w/s to scroll, Enter to select, Esc to close",
    style: { fg: "gray" },
  });

  const list = blessed.list({
    parent: modal,
    top: 2,
    left: 0,
    right: 0,
    bottom: 0,
    keys: true,
    mouse: true,
    vi: true,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: {
      selected: {
        bg: "blue",
        fg: "white",
        bold: true,
      },
      item: {
        fg: "white",
      },
    },
    items: entries,
  });

  const firstSelectableIndex = indexToModel.findIndex((value) => typeof value === "string");
  list.select(firstSelectableIndex >= 0 ? firstSelectableIndex : 0);

  modal.key(["escape", "q"], () => {
    closeModelPicker();
  });

  modelPicker = modal;
  modelPickerList = list;
  list.focus();
  screen.render();
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendApiError(res, statusCode, message) {
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) {
      try {
        sseWrite(res, "error", {
          error: {
            message,
          },
        });
        res.end();
      } catch {
        // Ignore teardown races.
      }
    }
    return;
  }

  json(res, statusCode, {
    error: message,
  });
}

function sseWrite(res, event, data) {
  if (event) {
    res.write(`event: ${event}\n`);
  }
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function summarizeMessages(messages) {
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

function summarizeChatPayload(payload) {
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

function formatMessagesSummary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "messages=0";
  }
  return messages
    .map((message) => `${message.index}:${message.role}[${message.chars}] "${String(message.preview || "").replace(/\s+/g, " ")}"`)
    .join(" | ");
}

function formatDebugPayload(payload) {
  if (payload === undefined || payload === null) {
    return String(payload);
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (typeof payload !== "object") {
    return String(payload);
  }

  const parts = [];
  if (typeof payload.model === "string") parts.push(`model=${payload.model}`);
  if (typeof payload.stream === "boolean") parts.push(`stream=${payload.stream}`);
  if (typeof payload.messageCount === "number") parts.push(`messages=${payload.messageCount}`);
  if (Array.isArray(payload.messages)) parts.push(formatMessagesSummary(payload.messages));
  if ("response_format" in payload) parts.push(`response_format=${payload.response_format === undefined ? "undefined" : JSON.stringify(payload.response_format)}`);
  if (typeof payload.temperature === "number") parts.push(`temperature=${payload.temperature}`);
  if (typeof payload.top_p === "number") parts.push(`top_p=${payload.top_p}`);
  if (typeof payload.max_tokens === "number") parts.push(`max_tokens=${payload.max_tokens}`);
  if (typeof payload.tool_choice === "string") parts.push(`tool_choice=${payload.tool_choice}`);
  if (typeof payload.toolsCount === "number") parts.push(`tools=${payload.toolsCount}`);

  if (parts.length > 0) {
    return parts.join(" | ");
  }

  try {
    return JSON.stringify(payload);
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function debugLog(label, payload) {
  if (payload === undefined) {
    logLine("debug", label);
    return;
  }
  logLine("debug", `${label}: ${formatDebugPayload(payload)}`);
}

function compactPayload(payload) {
  try {
    return JSON.stringify(payload, null, 2);
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function exportTranscript(targetPath = "") {
  const transcriptText = exportTranscriptText();
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const requestedPath = targetPath?.trim()
    ? path.resolve(targetPath.trim())
    : path.resolve(process.cwd(), `terminal-webgpu-llm-transcript-${safeTimestamp}.txt`);
  const fallbackPath = path.join(os.tmpdir(), `terminal-webgpu-llm-transcript-${safeTimestamp}.txt`);

  let resolvedPath = requestedPath;
  try {
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, `${transcriptText}\n`, "utf8");
  } catch (error) {
    resolvedPath = fallbackPath;
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, `${transcriptText}\n`, "utf8");
    logLine(
      "debug",
      `primary export path failed (${requestedPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  logLine("system", `transcript exported to ${resolvedPath}`);

  execFile("pbcopy", [], { input: transcriptText }, (error) => {
    if (error) {
      logLine("debug", `pbcopy unavailable: ${error.message}`);
      return;
    }
    logLine("system", "transcript copied to clipboard");
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function buildResponsesPayload(payload) {
  const messages =
    Array.isArray(payload?.messages) && payload.messages.length > 0
      ? payload.messages
      : normalizeResponseInput(payload?.input);

  return {
    model: currentModel,
    messages,
    temperature: payload?.temperature,
    top_p: payload?.top_p,
    max_tokens: payload?.max_output_tokens ?? payload?.max_tokens,
    stream: payload?.stream === true,
    tools: Array.isArray(payload?.tools) ? payload.tools : undefined,
    tool_choice: payload?.tool_choice,
    response_format: payload?.text?.format ?? payload?.response_format,
  };
}

async function fetchUrlContextFromTerminal(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "terminal-webgpu-llm/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`URL fetch failed with ${response.status}`);
  }
  const html = await response.text();
  const title = extractTitle(html) || url;
  const content = cleanupExtractedText(stripHtmlToText(html));
  if (!content) {
    throw new Error("The page was fetched, but no readable text could be extracted.");
  }
  return {
    url,
    title,
    content,
  };
}

const HUGGINGFACE_MODEL_AUTHORS = ["mlc-ai", "welcoma"];
const BINARY_LIBS_API_URL = "https://api.github.com/repos/mlc-ai/binary-mlc-llm-libs/contents/web-llm-models/v0_2_80";

async function fetchHuggingFaceModels() {
  const modelResponses = await Promise.all(
    HUGGINGFACE_MODEL_AUTHORS.map((author) =>
      fetch(`https://huggingface.co/api/models?author=${author}&limit=200&sort=lastModified&direction=-1`),
    ),
  );
  const binaryResponse = await fetch(BINARY_LIBS_API_URL);

  for (const response of modelResponses) {
    if (!response.ok) {
      throw new Error(`Hugging Face model list failed with ${response.status}`);
    }
  }
  if (!binaryResponse.ok) {
    throw new Error(`Binary lib list failed with ${binaryResponse.status}`);
  }

  const normalize = (value) =>
    value
      .replace(/^[^/]+\//, "")
      .replace(/-MLC$/i, "")
      .replace(/-ctx.*$/i, "")
      .replace(/-webgpu$/i, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();

  const binaryEntries = await binaryResponse.json();
  const availableBinaryKeys = new Set(
    binaryEntries
      .filter((entry) => entry.type === "file" && entry.name?.endsWith(".wasm"))
      .map((entry) => normalize(entry.name || "")),
  );

  const payloads = await Promise.all(modelResponses.map((response) => response.json()));
  const payload = payloads.flat();
  const candidateModels = payload
    .map((entry) => entry.id?.trim())
    .filter((id) => Boolean(id) && id.includes("-MLC"))
    .map((id) => ({
      repoId: id,
      modelId: id.replace(/^[^/]+\//, ""),
      author: id.split("/")[0] || "",
    }));

  const compatibilityChecks = await Promise.all(
    candidateModels.map(async ({ author, modelId, repoId }) => {
      if (author === "mlc-ai") {
        return availableBinaryKeys.has(normalize(modelId)) ? modelId : null;
      }

      if (author === "welcoma") {
        const libsResponse = await fetch(`https://huggingface.co/api/models/${repoId}/tree/main/libs`);
        if (!libsResponse.ok) {
          return null;
        }
        const libsEntries = await libsResponse.json();
        const hasWebgpuWasm = Array.isArray(libsEntries)
          && libsEntries.some((entry) => typeof entry?.path === "string" && entry.path.endsWith("-webgpu.wasm"));
        return hasWebgpuWasm ? modelId : null;
      }

      return null;
    }),
  );

  return compatibilityChecks.filter(Boolean);
}

async function fetchWebLLMModelServerModels() {
  const response = await fetch(`${webllmModelServerUrl}/models`);
  if (!response.ok) {
    throw new Error(`WebLLM model server /models failed with ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload?.models)) {
    return [];
  }
  return payload.models
    .map((entry) => (typeof entry?.id === "string" ? entry.id : null))
    .filter(Boolean);
}

function findPlaywrightChromiumExecutable() {
  const envPath = process.env.PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browserRoot || !existsSync(browserRoot)) {
    return null;
  }

  const candidates = [];
  const stack = [browserRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);

      if (entry.isSymbolicLink()) {
        try {
          const resolved = realpathSync(fullPath);
          const stats = statSync(resolved);
          if (stats.isDirectory()) {
            stack.push(resolved);
          } else if (stats.isFile() && executableNames.includes(path.basename(resolved))) {
            candidates.push(resolved);
          }
        } catch {
          // Ignore broken symlinks.
        }
        continue;
      }

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && executableNames.includes(entry.name)) {
        candidates.push(fullPath);
      }
    }
  }

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function resolveLaunchExecutable() {
  try {
    return findPlaywrightChromiumExecutable() || chromium.executablePath() || null;
  } catch {
    return findPlaywrightChromiumExecutable();
  }
}

function serveStatic(res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const requestedPath = path.normalize(path.join(distDir, relativePath));
  const safeRoot = `${distDir}${path.sep}`;

  if (requestedPath !== distDir && !requestedPath.startsWith(safeRoot)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  const filePath = existsSync(requestedPath)
    ? requestedPath
    : path.join(distDir, "index.html");

  let contents = readFileSync(filePath);
  if (path.basename(filePath) === "index.html") {
    const html = contents
      .toString("utf8")
      .replace("__WEBLLM_MODEL_LIB_URL_PREFIX__", webllmModelLibUrlPrefix)
      .replace("__WEBLLM_MODEL_SERVER_URL__", webllmModelServerUrl);
    contents = Buffer.from(html, "utf8");
  }
  res.writeHead(200, {
    "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(contents);
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${host}:${rendererPort || rendererListenPort || 0}`);
  if (req.method === "GET") {
    serveStatic(res, url.pathname);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

const apiServer = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      json(res, 400, { error: "Missing URL" });
      return;
    }

    const url = new URL(req.url, `http://${host}:${apiPort}`);

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        model: getModelDisplay(currentModel),
        loaded: Boolean(page),
        rendererReady: Boolean(page),
        apiPort,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      json(res, 200, {
        object: "list",
        data: knownModels.map((key) => {
          const meta = getModelMeta(key);
          return {
          id: key,
          object: "model",
          owned_by: meta?.source || "unknown",
          root: meta?.modelId,
        };
        }),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/load") {
      const payload = await readJsonBody(req);
      debugLog("api /v1/load payload", payload);
      const model = resolveModelSelection(
        typeof payload.model === "string" && payload.model.trim()
          ? payload.model.trim()
          : currentModel,
      );
      await ensureBrowser();
      await loadModel(model);
      json(res, 200, { ok: true, model, display: getModelDisplay(model), loaded: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const payload = await readJsonBody(req);
      debugLog("api /v1/chat/completions payload", {
        model: payload?.model,
        stream: payload?.stream,
        messageCount: Array.isArray(payload?.messages) ? payload.messages.length : 0,
        roles: Array.isArray(payload?.messages) ? payload.messages.map((message) => message?.role) : [],
        response_format: payload?.response_format,
        temperature: payload?.temperature,
        max_tokens: payload?.max_tokens,
      });
      if (payload.stream === true) {
        await streamChatCompletion(payload, res);
        return;
      }
      const completion = await createChatCompletion(payload);
      json(res, 200, completion);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      const payload = await readJsonBody(req);
      debugLog("api /v1/responses payload", summarizeChatPayload(buildResponsesPayload(payload)));
      const chatPayload = buildResponsesPayload(payload);
      debugLog("api /v1/responses mapped chat payload", {
        model: chatPayload?.model,
        stream: chatPayload?.stream,
        messageCount: Array.isArray(chatPayload?.messages) ? chatPayload.messages.length : 0,
        response_format: chatPayload?.response_format,
      });

      if (chatPayload.stream === true) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });

        const aggregated = [];
        await new Promise((resolve, reject) => {
          const requestId = crypto.randomUUID();
          pendingStreams.set(requestId, {
            onChunk(chunk) {
              const delta = chunk?.choices?.[0]?.delta?.content ?? "";
              if (delta) {
                aggregated.push(delta);
                sseWrite(res, "response.output_text.delta", {
                  type: "response.output_text.delta",
                  delta,
                });
              }
            },
            onDone() {
              const outputText = aggregated.join("");
              sseWrite(res, "response.output_text.done", {
                type: "response.output_text.done",
                text: outputText,
              });
              sseWrite(res, "response.completed", {
                type: "response.completed",
                response: {
                  id: `resp_${requestId}`,
                  object: "response",
                  status: "completed",
                  model: chatPayload.model,
                  output_text: outputText,
                },
              });
              sseWrite(res, null, "[DONE]");
              res.end();
              renderStatus("ready");
              resolve();
            },
            onError(error) {
              reject(error);
            },
          });

          page.evaluate(
            (request) => window.tuiChatStream?.(request),
            {
              ...chatPayload,
              requestId,
            },
          ).catch((error) => {
            pendingStreams.delete(requestId);
            reject(error);
          });
        });
        return;
      }

      const completion = await createChatCompletion(chatPayload);
      json(res, 200, mapCompletionToResponse(chatPayload, completion));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/embeddings") {
      json(res, 501, {
        error: {
          message: "Embeddings are not implemented in this TUI bridge yet.",
          type: "not_supported",
        },
      });
      return;
    }

    json(res, 404, { error: "Not Found" });
  } catch (error) {
    renderStatus("api error");
    const message = error instanceof Error ? error.message : String(error);
    logLine("error", message);
    sendApiError(res, 500, message);
  }
});

async function ensureBrowser() {
  if (browser && page && !page.isClosed()) {
    return;
  }

  const executablePath = resolveLaunchExecutable();
  if (!executablePath) {
    throw new Error(
      "Could not find a Playwright-managed Chromium binary. Set PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH or PLAYWRIGHT_BROWSERS_PATH.",
    );
  }

  browser = await chromium.launch({
    executablePath,
    headless: chromiumHeadless,
    args: [
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      "--enable-features=Vulkan,UseSkiaRenderer",
      "--enable-logging=stderr",
      "--v=1",
      "--vmodule=*gpu*=3",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
  });
  page = await context.newPage();

  await page.exposeFunction("bridgeEmit", async (event) => {
    if (event.type === "ready") {
      renderStatus("renderer ready");
      return;
    }
    if (event.type === "progress") {
      renderStatus(`${event.payload.text} (${Math.round(event.payload.progress * 100)}%)`);
      return;
    }
    if (event.type === "loaded") {
      currentModel = typeof event.payload?.model === "string" ? event.payload.model : currentModel;
      renderStatus(`loaded ${getModelDisplay(currentModel)}`);
      logLine("system", `model ready: ${getModelDisplay(currentModel)}`);
      return;
    }
    if (event.type === "log") {
      logLine("system", String(event.payload));
      return;
    }
    if (event.type === "stream-chunk") {
      const pending = pendingStreams.get(event.payload?.requestId);
      if (pending) {
        pending.onChunk(event.payload?.chunk);
      }
      return;
    }
    if (event.type === "stream-done") {
      const pending = pendingStreams.get(event.payload?.requestId);
      if (pending) {
        pending.onDone(event.payload);
        pendingStreams.delete(event.payload?.requestId);
      }
      return;
    }
    if (event.type === "error") {
      for (const pending of pendingStreams.values()) {
        pending.onError?.(String(event.payload));
      }
      pendingStreams.clear();
      renderStatus("error");
      logLine("error", String(event.payload));
    }
  });

  page.on("console", (msg) => {
    logLine("browser", msg.text());
  });

  await page.goto(`http://${browserHost}:${rendererPort}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.tuiRendererReady === true);
}

async function resetBrowser() {
  try {
    await browser?.close();
  } catch {
    // Ignore browser teardown issues.
  }
  browser = undefined;
  page = undefined;
}

function isExecutionContextDestroyed(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Execution context was destroyed");
}

async function evaluateWithRecovery(callback, payload) {
  await ensureBrowser();
  try {
    return await page.evaluate(callback, payload);
  } catch (error) {
    if (!isExecutionContextDestroyed(error)) {
      throw error;
    }
    logLine("system", "renderer context was replaced; recovering hidden browser page");
    await resetBrowser();
    await ensureBrowser();
    return page.evaluate(callback, payload);
  }
}

async function loadModel(model) {
  currentModel = model;
  const meta = getModelMeta(model);
  renderStatus(`loading ${getModelDisplay(model)}`);
  await evaluateWithRecovery(
    (request) => window.tuiLoad?.(request),
    {
      model,
      modelId: meta?.modelId || model,
      source: meta?.source || MODEL_SOURCE.BUILTIN,
    },
  );
}

async function createChatCompletion(requestPayload) {
  await ensureBrowser();
  const model = currentModel;
  const userPrompt = extractLastUserMessage(requestPayload?.messages);

  renderStatus(`api request ${getModelDisplay(model)}`);
  logLine("api", `chat request on ${getModelDisplay(model)}`);
  if (userPrompt) {
    logLine("user", userPrompt);
  }

  const completion = await evaluateWithRecovery(
    (request) => window.tuiChat?.(request),
    {
      ...requestPayload,
      model,
    },
  );

  const answer = extractCompletionText(completion);
  if (answer) {
    logLine("assistant", answer);
  } else {
    logLine("assistant", "(empty response from model)");
    logLine("debug", `raw completion payload:\n${compactPayload(completion)}`);
  }

  renderStatus("ready");
  return completion;
}

async function streamChatCompletion(requestPayload, res) {
  await ensureBrowser();
  const model = currentModel;
  const requestId = crypto.randomUUID();
  const userPrompt = extractLastUserMessage(requestPayload?.messages);
  let assistantText = "";
  const assistantLineIndex = appendTranscriptLine(() => formatPrimaryTranscriptEntry("assistant", assistantText || ""));

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  renderStatus(`api stream ${getModelDisplay(model)}`);
  logLine("api", `stream request on ${getModelDisplay(model)}`);
  if (userPrompt) {
    logLine("user", userPrompt);
  }

  await new Promise((resolve, reject) => {
    pendingStreams.set(requestId, {
      onChunk(chunk) {
        assistantText += extractChunkText(chunk);
        replaceTranscriptLine(assistantLineIndex, () => formatPrimaryTranscriptEntry("assistant", assistantText || " "));
        sseWrite(res, null, buildChatCompletionChunk(model, chunk));
      },
      onDone() {
        if (!assistantText) {
          assistantText = "(no response)";
          replaceTranscriptLine(assistantLineIndex, () => formatPrimaryTranscriptEntry("assistant", assistantText));
          logLine("debug", `raw streamed completion request finished without text for model ${model}`);
        }
        sseWrite(res, null, "[DONE]");
        res.end();
        renderStatus("ready");
        resolve();
      },
      onError(error) {
        reject(error);
      },
    });

    res.on("close", async () => {
      if (!pendingStreams.has(requestId)) {
        return;
      }
      pendingStreams.delete(requestId);
      try {
        await evaluateWithRecovery(() => window.tuiAbortStream?.());
      } catch {
        // Ignore abort race conditions.
      }
      resolve();
    });

    evaluateWithRecovery(
      (request) => window.tuiChatStream?.(request),
      {
        ...requestPayload,
        model,
        requestId,
      },
    ).catch((error) => {
      pendingStreams.delete(requestId);
      reject(error);
    });
  });
}

async function refreshKnownModels() {
  if (modelsRefreshPromise) {
    return modelsRefreshPromise;
  }

  modelsRefreshPromise = (async () => {
    try {
      if (!interactionInFlight) {
        renderStatus("refreshing models");
      }
      logLine("system", "refreshing Hugging Face models in background...");
      huggingFaceModels = await fetchHuggingFaceModels();
      localServerModels = [];
      try {
        localServerModels = await fetchWebLLMModelServerModels();
        if (localServerModels.length > 0) {
          logLine("system", `webllm-model-server available: ${localServerModels.join(", ")}`);
        }
      } catch {
        localServerModels = [];
      }
      rebuildModelRegistry();
      logLine("system", `known models updated: ${knownModels.length}`);
      if (!interactionInFlight) {
        renderStatus("ready");
      }
    } catch (error) {
      if (!interactionInFlight) {
        renderStatus("error");
      }
      logLine("error", `failed to refresh Hugging Face models: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      modelsRefreshPromise = null;
    }
  })();

  return modelsRefreshPromise;
}

function refreshKnownModelsInBackground() {
  void refreshKnownModels().catch(() => {
    // Error handling is already done inside refreshKnownModels.
  });
}

async function showCachedModels() {
  const payload = await evaluateWithRecovery(
    (request) => window.tuiListCachedModels?.(request),
    { models: knownModels },
  );

  if (!payload || payload.cachedModels.length === 0) {
    logLine("system", "cached models: none");
    return;
  }

  logLine("system", `cache total: ${formatBytes(payload.totalBytes)}`);
  for (const entry of payload.cachedModels) {
    logLine("cache", `${entry.model} (${formatBytes(entry.sizeBytes)})`);
  }
}

async function clearModelCache(model) {
  await evaluateWithRecovery(
    (request) => window.tuiClearModel?.(request),
    { model },
  );
  history.push({
    role: "system",
    content: `Cleared cached downloads for ${model}.`,
  });
  logLine("system", `cleared cache for ${model}`);
}

async function sendPrompt(prompt) {
  const detectedUrl = extractFirstUrl(prompt);
  if (detectedUrl) {
    renderStatus("fetching url");
    attachedUrlContext = await fetchUrlContextFromTerminal(detectedUrl);
    logLine("system", `attached url: ${attachedUrlContext.title}`);
  } else {
    attachedUrlContext = null;
  }

  history.push({ role: "user", content: prompt });
  logLine("you", prompt);
  renderStatus("thinking");

  const systemMessages = history.filter((entry) => entry.role === "system");
  const nonSystemMessages = history.filter((entry) => entry.role !== "system");
  const requestMessages = nonSystemMessages.map((entry) => ({
    role: entry.role,
    content: entry.content,
  }));

  if (attachedUrlContext || systemMessages.length > 0) {
    const parts = [];
    if (attachedUrlContext) {
      parts.push(
        `Attached URL context:\nTitle: ${attachedUrlContext.title}\nURL: ${attachedUrlContext.url}\nContent:\n${attachedUrlContext.content}`,
      );
    }
    for (const message of systemMessages) {
      parts.push(message.content);
    }
    requestMessages.unshift({
      role: "system",
      content: parts.join("\n\n"),
    });
  }

  const requestId = crypto.randomUUID();
  let assistantText = "";
  let latestUsage = null;
  const assistantLineIndex = appendTranscriptLine(() => formatPrimaryTranscriptEntry("assistant", assistantText || ""));

  await new Promise((resolve, reject) => {
    pendingStreams.set(requestId, {
      onChunk(chunk) {
        assistantText += extractChunkText(chunk);
        latestUsage = chunk?.usage || latestUsage;
        replaceTranscriptLine(assistantLineIndex, () => formatPrimaryTranscriptEntry("assistant", assistantText || " "));
      },
      onDone(payload) {
        latestUsage = payload?.usage || latestUsage;
        resolve();
      },
      onError(error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    });

    evaluateWithRecovery(
      (request) => window.tuiChatStream?.(request),
      {
        model: currentModel,
        messages: requestMessages,
        requestId,
      },
    ).catch((error) => {
      pendingStreams.delete(requestId);
      reject(error);
    });
  });

  if (!assistantText) {
    assistantText = "(no response)";
    replaceTranscriptLine(assistantLineIndex, () => formatPrimaryTranscriptEntry("assistant", assistantText));
  }

  setLatestUsage(latestUsage);

  history.push({ role: "assistant", content: assistantText });
  renderStatus("ready");
}

screen.key(["C-c", "q"], async () => {
  try {
    screen.program?.decrst?.(2004);
  } catch {
    // Ignore terminal mode reset issues.
  }
  try {
    await browser?.close();
  } catch {
    // Ignore shutdown issues.
  }
  try {
    server.close();
  } catch {
    // Ignore shutdown issues.
  }
  try {
    apiServer.close();
  } catch {
    // Ignore shutdown issues.
  }
  process.exit(0);
});

screen.key(["tab"], () => {
  if (isModelPickerOpen()) {
    return;
  }
  moveFocus(1);
});

screen.key(["S-tab"], () => {
  if (isModelPickerOpen()) {
    return;
  }
  moveFocus(-1);
});

screen.key(["up"], () => {
  if (isModelPickerOpen()) {
    return;
  }
  if (screen.focused === input) {
    moveFocus(-1);
    return;
  }
  if (screen.focused === transcript) {
    setTranscriptFollow(false);
    transcript.scroll(-3);
    screen.render();
    return;
  }
  if (screen.focused === status) {
    status.scroll(-1);
    screen.render();
    return;
  }
  if (screen.focused === performance) {
    performance.scroll(-1);
    screen.render();
  }
});

screen.key(["down"], () => {
  if (isModelPickerOpen()) {
    return;
  }
  if (screen.focused === transcript) {
    transcript.scroll(3);
    if (transcript.getScrollPerc() >= 95) {
      setTranscriptFollow(true);
    }
    screen.render();
    return;
  }
  if (screen.focused === status) {
    status.scroll(1);
    screen.render();
    return;
  }
  if (screen.focused === performance) {
    performance.scroll(1);
    screen.render();
    return;
  }
  if (screen.focused === input) {
    moveFocus(1);
  }
});

screen.key(["left"], () => {
  if (isModelPickerOpen()) {
    return;
  }
  moveFocus(-1);
});

screen.key(["right"], () => {
  if (isModelPickerOpen()) {
    return;
  }
  moveFocus(1);
});

screen.key(["enter"], () => {
  if (!isModelPickerOpen()) {
    return;
  }
  confirmModelPickerSelection();
});

screen.key(["escape"], () => {
  if (!isModelPickerOpen()) {
    return;
  }
  closeModelPicker();
});

screen.key(["w"], () => {
  if (!isModelPickerOpen()) {
    return;
  }
  moveModelPickerSelection(-1);
});

screen.key(["s"], () => {
  if (!isModelPickerOpen()) {
    return;
  }
  moveModelPickerSelection(1);
});

screen.key(["C-l"], async () => {
  try {
    await loadModel(currentModel);
  } catch (error) {
    renderStatus("error");
    logLine("error", error instanceof Error ? error.message : String(error));
  }
});

async function handlePromptSubmit(rawValue) {
  const prompt = String(rawValue || "").trim();
  if (!prompt) {
    return;
  }

  interactionInFlight = true;

  try {
    if (prompt.startsWith("/model ")) {
      currentModel = resolveModelSelection(prompt.slice(7).trim() || currentModel);
      logLine("system", `selected model: ${getModelDisplay(currentModel)}`);
      renderStatus(`selected ${getModelDisplay(currentModel)}`);
      return;
    }

    if (prompt === "/load") {
      try {
        await loadModel(currentModel);
      } catch (error) {
        renderStatus("error");
        logLine("error", error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (prompt === "/models") {
      openModelPicker();
      renderStatus("selecting model");
      return;
    }

    if (prompt === "/refresh-models") {
      refreshKnownModelsInBackground();
      return;
    }

    if (prompt === "/cache") {
      try {
        await showCachedModels();
      } catch (error) {
        logLine("error", error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (prompt.startsWith("/clear-cache ")) {
      const model = prompt.slice(13).trim();
      if (!model) {
        logLine("error", "usage: /clear-cache <model>");
        return;
      }
      try {
        await clearModelCache(model);
      } catch (error) {
        logLine("error", error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (prompt === "/clear-chat") {
      history.length = 0;
      attachedUrlContext = null;
      clearTranscript();
      logLine("system", "chat history cleared");
      renderStatus("ready");
      return;
    }

    if (prompt.startsWith("/export-transcript")) {
      const exportPath = prompt.slice("/export-transcript".length).trim();
      try {
        exportTranscript(exportPath);
      } catch (error) {
        logLine("error", error instanceof Error ? error.message : String(error));
      }
      return;
    }

    try {
      await sendPrompt(prompt);
    } catch (error) {
      renderStatus("error");
      logLine("error", error instanceof Error ? error.message : String(error));
    }
  } finally {
    interactionInFlight = false;
  }
}

input.key(["enter"], async () => {
  const withinPasteGuard = Date.now() - lastPasteEndedAt < PASTE_SUBMIT_GUARD_MS;
  if (pasteInProgress || withinPasteGuard) {
    return;
  }
  if (pendingSubmitTimer) {
    clearTimeout(pendingSubmitTimer);
  }
  const requestedAt = Date.now();
  pendingSubmitTimer = setTimeout(async () => {
    pendingSubmitTimer = null;
    if (pasteInProgress) {
      return;
    }
    if (lastPromptInputAt > requestedAt) {
      return;
    }
    const value = input.getValue();
    input.clearValue();
    input.setScroll(0);
    screen.render();
    await handlePromptSubmit(value);
  }, ENTER_SUBMIT_DEBOUNCE_MS);
});

input.key(["C-s"], () => {
  const currentValue = input.getValue();
  input.setValue(`${currentValue}\n`);
  input.setScrollPerc(100);
  screen.render();
});

async function main() {
  renderStatus("starting");
  try {
    screen.program?.decset?.(2004);
    screen.program?.input?.on?.("data", (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      lastPromptInputAt = Date.now();
      if (text.includes("\u001b[200~")) {
        pasteInProgress = true;
        if (pendingSubmitTimer) {
          clearTimeout(pendingSubmitTimer);
          pendingSubmitTimer = null;
        }
      }
      if (text.includes("\u001b[201~")) {
        pasteInProgress = false;
        lastPasteEndedAt = Date.now();
      }
    });
  } catch {
    // Ignore bracketed-paste setup issues.
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(rendererListenPort, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve renderer server address."));
        return;
      }
      rendererPort = address.port;
      resolve();
    });
  });
  apiServer.listen(apiPort, host);
  await ensureBrowser();
  if (startupModel) {
    currentModel = resolveModelSelection(startupModel);
    await loadModel(currentModel);
  } else {
    currentModel = makeModelKey(MODEL_SOURCE.BUILTIN, defaultModel);
    logLine("system", `selected model: ${getModelDisplay(currentModel)}`);
    logLine("system", "no startup model provided; use /load or Ctrl+L to load it.");
  }
  if (exposeRenderer) {
    logLine("system", `renderer ready on http://${host}:${rendererPort}`);
  } else {
    logLine("system", "renderer ready on internal-only localhost port");
  }
  logLine("system", `api ready on http://${host}:${apiPort}`);
  logLine(
    "system",
    "Commands: /models, /refresh-models, /model <id>, /load, /cache, /clear-cache <id>, /clear-chat, /export-transcript [path].",
  );
  renderStatus("ready");
  refreshKnownModelsInBackground();
  setFocusedView(2);
  screen.render();
}

void main().catch((error) => {
  renderStatus("error");
  logLine("error", error instanceof Error ? error.message : String(error));
  screen.render();
});
