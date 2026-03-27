const offscreenDocumentUrl = new URL("./offscreen.html", import.meta.url);
const OFFSCREEN_PATH = offscreenDocumentUrl.pathname.replace(/^\//, "");

let creatingOffscreen: Promise<void> | null = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);

  if ("getContexts" in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    if (contexts.length > 0) {
      return;
    }
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["BLOBS"],
    justification: "Keep the WebLLM engine warm while the side panel is closed.",
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active browser tab is available.");
  }
  return tab.id;
}

async function readCurrentPage() {
  const tabId = await getActiveTabId();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const title = document.title || "";
      const url = location.href;
      const selectedText = String(window.getSelection?.() || "").trim();
      const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const content = (selectedText || bodyText).slice(0, 6000);
      return { title, url, content };
    },
  });

  const payload = results[0]?.result;
  if (!payload?.content) {
    throw new Error(
      "Could not read useful page text from the active tab. Try a normal webpage instead of a browser-internal page.",
    );
  }

  return payload;
}

async function openSidePanel(tabId?: number) {
  const resolvedTabId = tabId ?? (await getActiveTabId());
  await chrome.sidePanel.setOptions({
    tabId: resolvedTabId,
    path: "popup.html",
    enabled: true,
  });
  await chrome.sidePanel.open({ tabId: resolvedTabId });
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    await ensureOffscreenDocument();
    await openSidePanel(tab.id);
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "service-worker") {
    return false;
  }

  void (async () => {
    try {
      switch (message.type) {
        case "ensure-offscreen":
          await ensureOffscreenDocument();
          sendResponse({ ok: true });
          return;
        case "get-current-page":
          sendResponse({ ok: true, page: await readCurrentPage() });
          return;
        case "open-panel":
          await openSidePanel();
          sendResponse({ ok: true });
          return;
        default:
          sendResponse({ ok: false, error: "Unknown service worker message." });
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
});
