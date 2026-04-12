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
    title: "Terminal WebGPU LLM TUI",
  });

  const header = createHeader(blessed, screen);
  const overview = createOverview(blessed, screen);
  const transcript = createTranscript(blessed, screen);
  const status = createInspector(blessed, screen);
  const performance = createPerformance(blessed, screen);
  const input = createPrompt(blessed, screen);

  return {
    screen,
    header,
    overview,
    transcript,
    status,
    performance,
    input,
  };
}

export function createUIController(ui, getSnapshot) {
  const transcriptEntries = [];
  const latestUsageLines = ["no completed response yet"];
  const focusables = [ui.transcript, ui.status, ui.performance, ui.input];
  let focusIndex = 2;
  let currentState = "starting";
  let transcriptShouldFollow = true;

  function summarizeState(state) {
    const value = String(state || "").toLowerCase();
    if (value.includes("error")) {
      return "error";
    }
    if (value.includes("loaded")) {
      return "loaded";
    }
    if (value.includes("loading")) {
      return "loading";
    }
    if (value.includes("thinking") || value.includes("stream") || value.includes("request")) {
      return "running";
    }
    if (value.includes("fetching")) {
      return "fetching";
    }
    if (value.includes("selected")) {
      return "selected";
    }
    if (value.includes("starting") || value.includes("renderer")) {
      return "starting";
    }
    return "ready";
  }

  function renderStatus(text) {
    currentState = text;
    const snapshot = getSnapshot();
    ui.overview.setContent(
      [
        ` model {bold}${snapshot.currentModel}{/bold}`,
        ` state {bold}${summarizeState(currentState)}{/bold}`,
        ` known ${snapshot.knownModelsCount}`,
        ` cached ctx ${snapshot.attachedUrlTitle ? "yes" : "no"}`,
        ` api ${snapshot.apiPort}`,
      ].join("   |   "),
    );

    ui.status.setContent(
      [
        `{bold}state{/bold}`,
        `${currentState}`,
        "",
        `{bold}runtime{/bold}`,
        snapshot.rendererLabel,
        `api      ${snapshot.apiUrl}`,
        "",
        `{bold}chat{/bold}`,
        `history messages: ${snapshot.historyCount}`,
        `url attached: ${snapshot.attachedUrlTitle || "none"}`,
        "",
        `{bold}models{/bold}`,
        `built-in: ${snapshot.builtInModelsCount}`,
        `hugging face: ${snapshot.huggingFaceModelsCount}`,
        `known total: ${snapshot.knownModelsCount}`,
        "",
        `{bold}keys{/bold}`,
        `tab / shift+tab  change focus`,
        `left / right     move focus`,
        `up / down        scroll pane`,
        `enter            send prompt`,
        `ctrl+s           newline`,
        `ctrl+l           load model`,
        `q                quit`,
        "",
        `{bold}commands{/bold}`,
        `/models`,
        `/refresh-models`,
        `/model <id>`,
        `/load`,
        `/cache`,
        `/clear-cache <id>`,
        `/clear-chat`,
        `/export-transcript [path]`,
      ].join("\n"),
    );

    ui.performance.setContent(
      [
        `{bold}latest response{/bold}`,
        ...latestUsageLines,
      ].join("\n"),
    );

    ui.screen.render();
  }

  function setLatestUsage(usage) {
    const lines = formatUsage(usage);
    latestUsageLines.splice(0, latestUsageLines.length, ...(lines && lines.length > 0 ? lines : ["no usage reported"]));
    renderStatus(currentState);
  }

  function syncTranscript() {
    const previousScroll = ui.transcript.getScrollPerc();
    transcriptShouldFollow = transcriptShouldFollow || previousScroll >= 95;
    ui.transcript.setContent(
      transcriptEntries
        .map((entry) => entry.render())
        .join("\n"),
    );
    if (transcriptShouldFollow) {
      ui.transcript.setScrollPerc(100);
    } else {
      ui.transcript.setScrollPerc(previousScroll);
    }
    ui.screen.render();
  }

  function getTranscriptSeparator() {
    const paneWidth =
      typeof ui.transcript.width === "number"
        ? ui.transcript.width
        : Math.max(40, Math.floor(ui.screen.width * 0.72));
    const ruleWidth = Math.max(12, paneWidth - 10);
    return `{gray-fg}  ${"─".repeat(ruleWidth)}  {/}`;
  }

  function escapeTaggedText(text) {
    return blessed.escape(String(text ?? ""));
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
    transcriptEntries.push({
      render: () => formatTranscriptEntry(prefix, text),
    });
    syncTranscript();
  }

  function appendTranscriptLine(line) {
    if (typeof line === "string") {
      transcriptEntries.push({
        render: () => line,
      });
    } else {
      transcriptEntries.push({
        render: line,
      });
    }
    syncTranscript();
    return transcriptEntries.length - 1;
  }

  function replaceTranscriptLine(index, line) {
    transcriptEntries[index] =
      typeof line === "string"
        ? { render: () => line }
        : { render: line };
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
    const target = focusables[focusIndex];
    target.focus();
    renderStatus(currentState.split(" | focus ")[0]);
    ui.screen.render();
  }

  function moveFocus(delta) {
    setFocusedView(focusIndex + delta);
  }

  function setTranscriptFollow(shouldFollow) {
    transcriptShouldFollow = shouldFollow;
  }

  ui.screen.on("resize", () => {
    syncTranscript();
    renderStatus(currentState);
  });

  function getCurrentState() {
    return currentState;
  }

  return {
    focusables,
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
    getCurrentState,
    screen: ui.screen,
    transcript: ui.transcript,
    status: ui.status,
    performance: ui.performance,
    input: ui.input,
  };
}
