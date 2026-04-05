import http from "node:http";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { apiPort, builtInRepos, defaultModel, host, llamaPort, llamaServerBin, startupModel } from "./lib/config.mjs";
import { deleteDownloadedModel, discoverModels, downloadModel, listDownloadedModels, resolveDownloadTarget } from "./lib/huggingface.mjs";
import { createChatCompletion, getRuntimeSnapshot, startServer, stopServer } from "./lib/llama-runtime.mjs";
import { formatBytes, sanitizeModelLabel } from "./lib/text-utils.mjs";
import { createUI, createUIController } from "./lib/ui.mjs";

const history = [];
let currentModel = startupModel || defaultModel;
let knownModels = builtInRepos.map((id) => ({ id, downloads: 0, likes: 0, private: false }));
let downloadedModels = listDownloadedModels();
let interactionInFlight = false;

const ui = createUI();
const {
  screen,
  input,
  logLine,
  appendTranscriptLine,
  replaceTranscriptLine,
  renderStatus,
  setLatestUsage,
  clearTranscript,
  exportTranscriptText,
  formatPrimaryTranscriptEntry,
  setFocusedView,
  moveFocus,
} = createUIController(ui, () => {
  const runtime = getRuntimeSnapshot();
  return {
    currentModel,
    knownModelsCount: knownModels.length,
    downloadedModelsCount: downloadedModels.length,
    apiPort,
    apiUrl: `http://${host}:${apiPort}`,
    llamaPort,
    llamaServerBin,
    serverPid: runtime.pid,
    serverUrl: runtime.url,
    activeModelPath: runtime.modelPath,
    historyCount: history.length,
  };
});

function getCurrentSelection() {
  return sanitizeModelLabel(currentModel);
}

function refreshDownloadedModels() {
  downloadedModels = listDownloadedModels();
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function getKnownModelEntries() {
  const entries = [];
  const seen = new Set();
  const runtime = getRuntimeSnapshot();

  for (const model of knownModels) {
    const id = model.id || model;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      object: "model",
      owned_by: "huggingface",
      downloaded: Boolean(getDownloadedMatch(id)),
      active: runtime.modelLabel === id || currentModel === id,
    });
  }

  for (const item of downloadedModels) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    entries.push({
      id: item.name,
      object: "model",
      owned_by: "downloaded",
      downloaded: true,
      active: runtime.modelLabel === item.name,
      path: item.path,
    });
  }

  if (runtime.modelLabel && !seen.has(runtime.modelLabel)) {
    entries.push({
      id: runtime.modelLabel,
      object: "model",
      owned_by: "loaded",
      downloaded: true,
      active: true,
      path: runtime.modelPath || undefined,
    });
  }

  return entries;
}

function writeTranscriptToFile(targetPath = "") {
  const transcriptText = exportTranscriptText();
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const requestedPath = targetPath?.trim()
    ? path.resolve(targetPath.trim())
    : path.resolve(process.cwd(), `terminal-llama-cpp-llm-transcript-${safeTimestamp}.txt`);
  const fallbackPath = path.join(os.tmpdir(), `terminal-llama-cpp-llm-transcript-${safeTimestamp}.txt`);

  let resolvedPath = requestedPath;
  try {
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, `${transcriptText}\n`, "utf8");
  } catch (error) {
    resolvedPath = fallbackPath;
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, `${transcriptText}\n`, "utf8");
    logLine("system", `primary export path failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  logLine("system", `transcript exported to ${resolvedPath}`);
  return { transcriptText, resolvedPath };
}

function copyTranscriptToClipboard() {
  const transcriptText = exportTranscriptText();
  const clipboardCommands = [
    ["pbcopy", []],
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];

  let attempts = 0;

  return new Promise((resolve) => {
    function tryNext() {
      const entry = clipboardCommands[attempts];
      attempts += 1;

      if (!entry) {
        logLine("system", "clipboard copy unavailable; use /export-transcript instead");
        resolve(false);
        return;
      }

      const [command, args] = entry;
      execFile(command, args, { input: transcriptText }, (error) => {
        if (error) {
          tryNext();
          return;
        }
        logLine("system", `transcript copied to clipboard via ${command}`);
        resolve(true);
      });
    }

    tryNext();
  });
}

function openMouseSelectionView() {
  const transcriptText = exportTranscriptText();
  const lines = [
    "",
    "===== terminal-llama-cpp-llm transcript =====",
    "",
    transcriptText,
    "",
    "===== end transcript =====",
    "",
    "Mouse-select and copy from this normal terminal screen.",
    "Press Enter to return to the TUI.",
  ];

  screen.leave();
  process.stdout.write(`${lines.join("\n")}\n`);

  return new Promise((resolve) => {
    const onData = (chunk) => {
      const text = String(chunk || "");
      if (!text.includes("\n") && !text.includes("\r")) {
        return;
      }
      process.stdin.off("data", onData);
      screen.enter();
      screen.render();
      logLine("system", "returned from mouse-select transcript view");
      resolve();
    };

    process.stdin.on("data", onData);
  });
}

async function refreshModels() {
  renderStatus("refreshing Hugging Face models");
  knownModels = await discoverModels();
  logLine("system", `discovered ${knownModels.length} candidate model repos`);
  renderStatus(`selected ${getCurrentSelection()}`);
}

function getDownloadedMatch(selection) {
  const normalized = sanitizeModelLabel(selection).toLowerCase();
  return downloadedModels.find((item) => item.path.toLowerCase() === normalized || item.name.toLowerCase() === normalized);
}

async function ensureModelReady(selection = getCurrentSelection()) {
  const localMatch = getDownloadedMatch(selection);
  if (localMatch) {
    return { localPath: localMatch.path, fileName: localMatch.name };
  }

  const target = await resolveDownloadTarget(selection);
  if (target.type === "file") {
    if (!existsSync(target.localPath)) {
      throw new Error(`file does not exist: ${target.localPath}`);
    }
    return target;
  }

  const progressIndex = appendTranscriptLine(() => formatPrimaryTranscriptEntry("system", `downloading ${target.fileName}`));
  const downloaded = await downloadModel(selection, (progress) => {
    replaceTranscriptLine(progressIndex, () =>
      formatPrimaryTranscriptEntry("system", `downloading ${target.fileName} (${progress.message})`),
    );
  });

  replaceTranscriptLine(progressIndex, () =>
    formatPrimaryTranscriptEntry("system", `downloaded ${downloaded.fileName} to ${downloaded.localPath}`),
  );
  refreshDownloadedModels();
  return downloaded;
}

async function deleteModel(selection) {
  const deleted = await deleteDownloadedModel(selection);
  refreshDownloadedModels();
  logLine("system", `deleted ${deleted.path}`);
  return deleted;
}

async function loadSelectedModel(selection = getCurrentSelection()) {
  renderStatus(`loading ${selection}`);
  const target = await ensureModelReady(selection);
  const runtime = await startServer(target.localPath, (line) => logLine("runtime", line), target.fileName || selection);
  renderStatus(`loaded ${selection}`);
  logLine("system", `llama-server ready on ${runtime.url}`);
}

async function submitPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text || interactionInFlight) {
    return;
  }

  interactionInFlight = true;
  input.clearValue();
  screen.render();
  history.push({ role: "user", content: text });
  logLine("you", text);
  renderStatus("running inference");

  const assistantIndex = appendTranscriptLine(() => formatPrimaryTranscriptEntry("assistant", "thinking..."));

  try {
    const runtime = getRuntimeSnapshot();
    const payload = {
      messages: history,
      stream: false,
    };
    if (runtime.modelLabel) {
      payload.model = runtime.modelLabel;
    }
    const response = await createChatCompletion(payload);
    const message = response?.choices?.[0]?.message?.content || "";
    history.push({ role: "assistant", content: message });
    replaceTranscriptLine(assistantIndex, () => formatPrimaryTranscriptEntry("assistant", message));
    setLatestUsage(response.usage || null);
    renderStatus(`loaded ${getCurrentSelection()}`);
  } catch (error) {
    replaceTranscriptLine(
      assistantIndex,
      () => formatPrimaryTranscriptEntry("system", `error: ${error instanceof Error ? error.message : String(error)}`),
    );
    renderStatus("error");
  } finally {
    interactionInFlight = false;
  }
}

async function handleCommand(rawInput) {
  const [command, ...rest] = rawInput.trim().split(/\s+/);
  const argument = rest.join(" ").trim();

  switch (command) {
    case "/models": {
      if (knownModels.length === 0) {
        logLine("system", "no known models");
        return true;
      }
      for (const model of knownModels.slice(0, 30)) {
        logLine("system", `${model.id} | downloads ${model.downloads || 0} | likes ${model.likes || 0}`);
      }
      return true;
    }
    case "/refresh-models":
      await refreshModels();
      return true;
    case "/model":
      if (!argument) {
        logLine("system", `selected ${getCurrentSelection()}`);
        return true;
      }
      currentModel = argument;
      renderStatus(`selected ${getCurrentSelection()}`);
      return true;
    case "/download":
      await ensureModelReady(argument || getCurrentSelection());
      renderStatus(`selected ${getCurrentSelection()}`);
      return true;
    case "/downloaded":
      refreshDownloadedModels();
      if (downloadedModels.length === 0) {
        logLine("system", "no downloaded models yet");
        return true;
      }
      for (const item of downloadedModels) {
        logLine("system", `${item.name} | ${formatBytes(item.size)} | ${item.path}`);
      }
      return true;
    case "/delete-model":
      await deleteModel(argument || getCurrentSelection());
      renderStatus(`selected ${getCurrentSelection()}`);
      return true;
    case "/redownload": {
      const targetSelection = argument || getCurrentSelection();
      try {
        await deleteModel(targetSelection);
      } catch {
        // Ignore missing local files and continue with a fresh download.
      }
      await ensureModelReady(targetSelection);
      renderStatus(`selected ${getCurrentSelection()}`);
      return true;
    }
    case "/load":
      if (argument) {
        currentModel = argument;
      }
      await loadSelectedModel(getCurrentSelection());
      return true;
    case "/running": {
      const runtime = getRuntimeSnapshot();
      logLine("system", `server ${runtime.pid ? "running" : "stopped"} | pid ${runtime.pid || "none"} | ${runtime.modelPath || "no model"}`);
      return true;
    }
    case "/stop":
      await stopServer();
      renderStatus(`selected ${getCurrentSelection()}`);
      logLine("system", "stopped llama-server");
      return true;
    case "/clear-chat":
      history.length = 0;
      clearTranscript();
      renderStatus(`selected ${getCurrentSelection()}`);
      return true;
    case "/export-transcript":
      writeTranscriptToFile(argument);
      return true;
    case "/copy-transcript":
      await copyTranscriptToClipboard();
      return true;
    case "/select-transcript":
      await openMouseSelectionView();
      return true;
    default:
      return false;
  }
}

async function handleSubmission() {
  const value = input.getValue();
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  if (trimmed.startsWith("/")) {
    try {
      await handleCommand(trimmed);
    } catch (error) {
      logLine("system", `error: ${error instanceof Error ? error.message : String(error)}`);
      renderStatus("error");
    } finally {
      input.clearValue();
      screen.render();
    }
    return;
  }
  await submitPrompt(trimmed);
}

async function bootstrap() {
  renderStatus("starting");
  logLine("system", `using llama-server binary: ${llamaServerBin}`);
  logLine("system", `api URL: http://${host}:${apiPort}`);
  logLine("system", `llama-server URL: http://${host}:${llamaPort}`);
  await refreshModels();
  refreshDownloadedModels();

  if (startupModel) {
    logLine("system", `startup selection: ${startupModel}`);
  }

  renderStatus(`selected ${getCurrentSelection()}`);
  setFocusedView(3);
}

const apiServer = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      json(res, 400, { error: "Missing URL" });
      return;
    }

    refreshDownloadedModels();
    const url = new URL(req.url, `http://${host}:${apiPort}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const runtime = getRuntimeSnapshot();
      json(res, 200, {
        ok: true,
        loaded: Boolean(runtime.pid),
        model: runtime.modelLabel || currentModel,
        apiPort,
        llamaPort,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      json(res, 200, {
        object: "list",
        data: getKnownModelEntries(),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/load") {
      const payload = await readJsonBody(req);
      const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : getCurrentSelection();
      currentModel = model;
      await loadSelectedModel(model);
      json(res, 200, { ok: true, loaded: true, model });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const payload = await readJsonBody(req);
      const response = await createChatCompletion(payload);
      json(res, 200, response);
      return;
    }

    json(res, 404, { error: "Not Found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine("system", `api error: ${message}`);
    json(res, 500, { error: message });
  }
});

screen.key(["C-c", "q"], async () => {
  await stopServer().catch(() => {});
  process.exit(0);
});

screen.key(["tab"], () => moveFocus(1));
screen.key(["S-tab"], () => moveFocus(-1));
screen.key(["left"], () => moveFocus(-1));
screen.key(["right"], () => moveFocus(1));

screen.key(["C-l"], async () => {
  try {
    await loadSelectedModel(getCurrentSelection());
  } catch (error) {
    logLine("system", `error: ${error instanceof Error ? error.message : String(error)}`);
    renderStatus("error");
  }
});

screen.key(["C-y"], async () => {
  await copyTranscriptToClipboard();
});

screen.key(["C-e"], () => {
  writeTranscriptToFile();
});

screen.key(["C-t"], async () => {
  await openMouseSelectionView();
});

input.key("enter", async () => {
  await handleSubmission();
});

bootstrap().catch((error) => {
  logLine("system", `startup error: ${error instanceof Error ? error.message : String(error)}`);
  renderStatus("error");
});

apiServer.listen(apiPort, host, () => {
  logLine("system", `api server listening on http://${host}:${apiPort}`);
});
