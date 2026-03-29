import { URL_CONTEXT_API_PATH, type AvailableModel } from "./index";
import type { AttachedUrlContext, ChatMessage } from "./types";
import { attachedUrlPreview, attachedUrlStatus, modelSelect, promptInput } from "./dom";
import { extractFirstUrl, formatBytes, trimPromptContext } from "./utils";

export function syncAttachedUrlStatus(attachedUrlContext: AttachedUrlContext | null) {
  if (!attachedUrlContext) {
    attachedUrlStatus.textContent = "No URL attached";
    attachedUrlPreview.textContent = "No page content loaded.";
    return;
  }

  attachedUrlStatus.textContent =
    `Attached: ${attachedUrlContext.title} (${formatBytes(attachedUrlContext.content.length)})`;
  attachedUrlPreview.textContent = trimPromptContext(attachedUrlContext.content, 800);
}

export function clearAttachedUrlContext() {
  syncAttachedUrlStatus(null);
  return null;
}

export async function attachUrlContext(
  currentContext: AttachedUrlContext | null,
) {
  const url = extractFirstUrl(promptInput.value.trim());
  if (!url) {
    return clearAttachedUrlContext();
  }

  if (currentContext?.url === url) {
    syncAttachedUrlStatus(currentContext);
    return currentContext;
  }

  attachedUrlStatus.textContent = "Fetching URL...";

  const response = await fetch(URL_CONTEXT_API_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || `URL fetch failed with ${response.status}`);
  }

  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (!content) {
    throw new Error("The page was fetched, but no readable text could be extracted.");
  }

  const attachedUrlContext = {
    url: payload.url,
    title: payload.title,
    content,
  };
  syncAttachedUrlStatus(attachedUrlContext);
  return attachedUrlContext;
}

export function buildRequestMessages(
  chatHistory: ChatMessage[],
  attachedUrlContext: AttachedUrlContext | null,
) {
  const systemMessages = chatHistory.filter((message) => message.role === "system");
  const nonSystemMessages = chatHistory.filter((message) => message.role !== "system");
  const systemParts: string[] = [];

  if (attachedUrlContext) {
    systemParts.push(
      `Attached URL context:\nTitle: ${attachedUrlContext.title}\n` +
        `URL: ${attachedUrlContext.url}\n` +
        `Content:\n${attachedUrlContext.content}`,
    );
  }

  for (const message of systemMessages) {
    systemParts.push(message.content);
  }

  const requestMessages = nonSystemMessages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  if (systemParts.length > 0) {
    requestMessages.unshift({
      role: "system" as const,
      content: systemParts.join("\n\n"),
    });
  }

  return requestMessages;
}

export function getSelectedModel(): AvailableModel {
  return modelSelect.value as AvailableModel;
}
