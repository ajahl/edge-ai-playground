const URL_PATTERN =
  /((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s)>"']*)?)/i;

export function setStatus(element: HTMLElement, text: string) {
  element.textContent = text;
}

export function trimPromptContext(text: string, maxChars: number) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}

export function extractFirstUrl(text: string) {
  const match = text.match(URL_PATTERN)?.[0] ?? null;
  if (!match) {
    return null;
  }

  return match.startsWith("http://") || match.startsWith("https://")
    ? match
    : `https://${match}`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatTime(date: Date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
