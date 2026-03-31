import http from "node:http";
import path from "node:path";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chromium } from "playwright-core";
import {
  apiPort,
  builtInModels,
  defaultModel,
  distDir,
  executableNames,
  exposeRenderer,
  host,
  mimeTypes,
  rendererListenPort,
  startupModel,
} from "./lib/config.mjs";
import {
  buildChatCompletionChunk,
  cleanupExtractedText,
  decodeHtmlEntities,
  extractChunkText,
  extractFirstUrl,
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
const pendingStreams = new Map();
let rendererPort = rendererListenPort;

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
  formatPrimaryTranscriptEntry,
  setFocusedView,
  moveFocus,
} = createUIController(ui, () => ({
  currentModel,
  knownModelsCount: knownModels.length,
  attachedUrlTitle: attachedUrlContext?.title ?? null,
  apiPort,
  rendererLabel: exposeRenderer ? `renderer http://${host}:${rendererPort}` : "renderer internal-only",
  apiUrl: `http://${host}:${apiPort}`,
  historyCount: history.length,
  builtInModelsCount: builtInModels.length,
  huggingFaceModelsCount: huggingFaceModels.length,
}));

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

async function fetchHuggingFaceModels() {
  const [hfResponse, binaryResponse] = await Promise.all([
    fetch("https://huggingface.co/api/models?author=mlc-ai&limit=200&sort=lastModified&direction=-1"),
    fetch("https://api.github.com/repos/mlc-ai/binary-mlc-llm-libs/contents/web-llm-models/v0_2_80"),
  ]);

  if (!hfResponse.ok) {
    throw new Error(`Hugging Face model list failed with ${hfResponse.status}`);
  }
  if (!binaryResponse.ok) {
    throw new Error(`Binary lib list failed with ${binaryResponse.status}`);
  }

  const normalize = (value) =>
    value
      .replace(/^mlc-ai\//, "")
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

  const payload = await hfResponse.json();
  return payload
    .map((entry) => entry.id?.trim())
    .filter((id) => Boolean(id) && id.includes("-MLC"))
    .map((id) => id.replace(/^mlc-ai\//, ""))
    .filter((id) => availableBinaryKeys.has(normalize(id)));
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

  const contents = readFileSync(filePath);
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
        model: currentModel,
        loaded: Boolean(page),
        rendererReady: Boolean(page),
        apiPort,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      json(res, 200, {
        object: "list",
        data: knownModels.map((id) => ({
          id,
          object: "model",
          owned_by: builtInModels.includes(id) ? "built-in" : "huggingface",
        })),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/load") {
      const payload = await readJsonBody(req);
      const model = typeof payload.model === "string" && payload.model.trim()
        ? payload.model.trim()
        : currentModel;
      await ensureBrowser();
      await loadModel(model);
      json(res, 200, { ok: true, model, loaded: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const payload = await readJsonBody(req);
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
      const chatPayload = buildResponsesPayload(payload);

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
  if (browser && page) {
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
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      "--enable-features=Vulkan,UseSkiaRenderer",
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
      currentModel = event.payload.model;
      renderStatus(`loaded ${currentModel}`);
      logLine("system", `model ready: ${currentModel}`);
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

  await page.goto(`http://${host}:${rendererPort}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.tuiRendererReady === true);
}

async function loadModel(model) {
  currentModel = model;
  renderStatus(`loading ${model}`);
  await page.evaluate(
    (request) => window.tuiLoad?.(request),
    { model },
  );
}

async function createChatCompletion(requestPayload) {
  await ensureBrowser();
  const model = currentModel;

  renderStatus(`api request ${model}`);
  logLine("api", `chat request on ${model}`);

  const completion = await page.evaluate(
    (request) => window.tuiChat?.(request),
    {
      ...requestPayload,
      model,
    },
  );

  renderStatus("ready");
  return completion;
}

async function streamChatCompletion(requestPayload, res) {
  await ensureBrowser();
  const model = currentModel;
  const requestId = crypto.randomUUID();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  renderStatus(`api stream ${model}`);
  logLine("api", `stream request on ${model}`);

  await new Promise((resolve, reject) => {
    pendingStreams.set(requestId, {
      onChunk(chunk) {
        sseWrite(res, null, buildChatCompletionChunk(model, chunk));
      },
      onDone() {
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
        await page.evaluate(() => window.tuiAbortStream?.());
      } catch {
        // Ignore abort race conditions.
      }
      resolve();
    });

    page.evaluate(
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
  try {
    huggingFaceModels = await fetchHuggingFaceModels();
    knownModels = Array.from(new Set([...builtInModels, ...huggingFaceModels]));
    logLine("system", `known models updated: ${knownModels.length}`);
  } catch (error) {
    logLine("error", `failed to refresh Hugging Face models: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function showCachedModels() {
  const payload = await page.evaluate(
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
  await page.evaluate(
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

    page.evaluate(
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
  moveFocus(1);
});

screen.key(["S-tab"], () => {
  moveFocus(-1);
});

screen.key(["up"], () => {
  if (screen.focused === input) {
    moveFocus(-1);
    return;
  }
  if (screen.focused === transcript) {
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
  if (screen.focused === transcript) {
    transcript.scroll(3);
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
  moveFocus(-1);
});

screen.key(["right"], () => {
  moveFocus(1);
});

screen.key(["C-l"], async () => {
  try {
    await loadModel(currentModel);
  } catch (error) {
    renderStatus("error");
    logLine("error", error instanceof Error ? error.message : String(error));
  }
});

input.on("submit", async (value) => {
  input.clearValue();
  screen.render();

  const prompt = String(value || "").trim();
  if (!prompt) {
    return;
  }

  if (prompt.startsWith("/model ")) {
    currentModel = prompt.slice(7).trim() || currentModel;
    logLine("system", `selected model: ${currentModel}`);
    renderStatus(`selected ${currentModel}`);
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
    logLine("system", `built-in models (${builtInModels.length}):`);
    for (const model of builtInModels) {
      logLine("model", model);
    }
    logLine("system", `hugging face models (${huggingFaceModels.length}):`);
    for (const model of huggingFaceModels) {
      logLine("model", model);
    }
    return;
  }

  if (prompt === "/refresh-models") {
    await refreshKnownModels();
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

  try {
    await sendPrompt(prompt);
  } catch (error) {
    renderStatus("error");
    logLine("error", error instanceof Error ? error.message : String(error));
  }
});

async function main() {
  renderStatus("starting");
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
  await refreshKnownModels();
  await ensureBrowser();
  if (startupModel) {
    currentModel = startupModel;
    await loadModel(currentModel);
  } else {
    currentModel = defaultModel;
    logLine("system", `selected model: ${currentModel}`);
    logLine("system", "no startup model provided; use /load or Ctrl+L to load it.");
  }
  if (exposeRenderer) {
    logLine("system", `renderer ready on http://${host}:${rendererPort}`);
  } else {
    logLine("system", "renderer ready on internal-only localhost port");
  }
  logLine("system", `api ready on http://${host}:${apiPort}`);
  logLine("system", "Commands: /models, /refresh-models, /model <id>, /load, /cache, /clear-cache <id>, /clear-chat.");
  renderStatus("ready");
  setFocusedView(2);
  screen.render();
}

void main().catch((error) => {
  renderStatus("error");
  logLine("error", error instanceof Error ? error.message : String(error));
  screen.render();
});
