import blessed from "blessed";
import { formatUsage } from "./text-utils.mjs";
import { createHeader } from "./views/header.mjs";
import { createOverview } from "./views/overview.mjs";
import { createTranscript } from "./views/transcript.mjs";
import { createInspector } from "./views/inspector.mjs";
import { createPerformance } from "./views/performance.mjs";
import { createPrompt } from "./views/prompt.mjs";

export function createUI() {
  const screen = blessed.screen({
    smartCSR: true,
    title: "Terminal llama.cpp LLM TUI",
  });

  const header = createHeader(blessed, screen);
  const overview = createOverview(blessed, screen);
  const transcript = createTranscript(blessed, screen);
  const status = createInspector(blessed, screen);
  const performance = createPerformance(blessed, screen);
  const input = createPrompt(blessed, screen);

  return { screen, header, overview, transcript, status, performance, input };
}

export function createUIController(ui, getSnapshot) {
  const transcriptEntries = [];
  const latestUsageLines = ["no completed response yet"];
  const focusables = [ui.transcript, ui.status, ui.performance, ui.input];
  let focusIndex = 3;
  let currentState = "starting";

  function summarizeState(state) {
    const value = String(state || "").toLowerCase();
    if (value.includes("error")) return "error";
    if (value.includes("download")) return "downloading";
    if (value.includes("load")) return "loading";
    if (value.includes("run") || value.includes("think")) return "running";
    if (value.includes("start")) return "starting";
    return "ready";
  }

  function renderStatus(text) {
    currentState = text;
    const snapshot = getSnapshot();

    ui.overview.setContent(
      [
        ` selected {bold}${snapshot.currentModel}{/bold}`,
        ` state {bold}${summarizeState(text)}{/bold}`,
        ` known ${snapshot.knownModelsCount}`,
        ` local ${snapshot.downloadedModelsCount}`,
        ` api ${snapshot.apiPort}`,
      ].join("   |   "),
    );

    ui.status.setContent(
      [
        `{bold}state{/bold}`,
        currentState,
        "",
        `{bold}runtime{/bold}`,
        `binary   ${snapshot.llamaServerBin}`,
        `api      ${snapshot.apiUrl}`,
        `llama    ${snapshot.serverUrl}`,
        `pid      ${snapshot.serverPid || "none"}`,
        "",
        `{bold}models{/bold}`,
        `selected: ${snapshot.currentModel}`,
        `known: ${snapshot.knownModelsCount}`,
        `downloaded: ${snapshot.downloadedModelsCount}`,
        `active file: ${snapshot.activeModelPath || "none"}`,
        "",
        `{bold}chat{/bold}`,
        `history messages: ${snapshot.historyCount}`,
        "",
        `{bold}keys{/bold}`,
        `tab / shift+tab  change focus`,
        `left / right     move focus`,
        `up / down        scroll pane`,
        `enter            send prompt`,
        `ctrl+s           newline`,
        `ctrl+l           load model`,
        `ctrl+y           copy transcript`,
        `ctrl+e           export transcript`,
        `ctrl+t           mouse-select transcript`,
        `q                quit`,
        "",
        `{bold}commands{/bold}`,
        `/models`,
        `/refresh-models`,
        `/model <repo-or-file>`,
        `/download [repo-or-file]`,
        `/downloaded`,
        `/delete-model <repo-or-file>`,
        `/redownload [repo-or-file]`,
        `/load [repo-or-file]`,
        `/running`,
        `/stop`,
        `/clear-chat`,
        `/copy-transcript`,
        `/export-transcript [path]`,
        `/select-transcript`,
      ].join("\n"),
    );

    ui.performance.setContent([`{bold}latest response{/bold}`, ...latestUsageLines].join("\n"));
    ui.screen.render();
  }

  function setLatestUsage(usage) {
    latestUsageLines.splice(0, latestUsageLines.length, ...formatUsage(usage));
    renderStatus(currentState);
  }

  function escapeTaggedText(text) {
    return blessed.escape(String(text ?? ""));
  }

  function syncTranscript() {
    ui.transcript.setContent(transcriptEntries.map((entry) => entry.render()).join("\n"));
    ui.transcript.setScrollPerc(100);
    ui.screen.render();
  }

  function getTranscriptSeparator() {
    const paneWidth =
      typeof ui.transcript.width === "number" ? ui.transcript.width : Math.max(40, Math.floor(ui.screen.width * 0.72));
    const ruleWidth = Math.max(12, paneWidth - 10);
    return `{gray-fg}  ${"─".repeat(ruleWidth)}  {/}`;
  }

  function formatPrimaryTranscriptEntry(prefix, text) {
    return `${getTranscriptSeparator()}\n{bold}${escapeTaggedText(prefix)}{/bold} ${escapeTaggedText(text)}`;
  }

  function formatTranscriptEntry(prefix, text) {
    if (prefix === "you" || prefix === "assistant" || prefix === "system") {
      return formatPrimaryTranscriptEntry(prefix, text);
    }
    return `{gray-fg}│{/} {bold}${escapeTaggedText(prefix)}{/bold} ${escapeTaggedText(text)}`;
  }

  function logLine(prefix, text) {
    transcriptEntries.push({ render: () => formatTranscriptEntry(prefix, text) });
    syncTranscript();
  }

  function appendTranscriptLine(line) {
    transcriptEntries.push(typeof line === "string" ? { render: () => line } : { render: line });
    syncTranscript();
    return transcriptEntries.length - 1;
  }

  function replaceTranscriptLine(index, line) {
    transcriptEntries[index] = typeof line === "string" ? { render: () => line } : { render: line };
    syncTranscript();
  }

  function clearTranscript() {
    transcriptEntries.length = 0;
    syncTranscript();
  }

  function exportTranscriptText() {
    return transcriptEntries
      .map((entry) => entry.render())
      .join("\n")
      .replace(/\{\/?[^}]+\}/g, "");
  }

  function setFocusedView(index) {
    focusIndex = (index + focusables.length) % focusables.length;
    focusables[focusIndex].focus();
    ui.screen.render();
  }

  function moveFocus(delta) {
    setFocusedView(focusIndex + delta);
  }

  ui.screen.on("resize", () => {
    syncTranscript();
    renderStatus(currentState);
  });

  return {
    screen: ui.screen,
    transcript: ui.transcript,
    status: ui.status,
    performance: ui.performance,
    input: ui.input,
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
  };
}
