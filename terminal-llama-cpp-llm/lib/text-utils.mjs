export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

export function formatUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return ["no usage reported"];
  }

  const lines = [];
  if (usage.prompt_tokens != null) {
    lines.push(`prompt tokens: ${usage.prompt_tokens}`);
  }
  if (usage.completion_tokens != null) {
    lines.push(`completion tokens: ${usage.completion_tokens}`);
  }
  if (usage.total_tokens != null) {
    lines.push(`total tokens: ${usage.total_tokens}`);
  }
  if (usage.tokens_per_second != null) {
    lines.push(`tokens/sec: ${usage.tokens_per_second}`);
  }
  return lines.length > 0 ? lines : ["no usage reported"];
}

export function sanitizeModelLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function pickPreferredGguf(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return null;
  }

  const preferredPatterns = [
    /tq\d/i,
    /turboquant/i,
    /q4_k_m/i,
    /q4_k_s/i,
    /q5_k_m/i,
    /iq4_xs/i,
    /iq4_nl/i,
    /instruct/i,
    /chat/i,
    /it/i,
  ];

  const ranked = [...files].sort((left, right) => {
    const leftScore = preferredPatterns.reduce((score, pattern) => score + (pattern.test(left.name) ? 1 : 0), 0);
    const rightScore = preferredPatterns.reduce((score, pattern) => score + (pattern.test(right.name) ? 1 : 0), 0);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return (left.size || 0) - (right.size || 0);
  });

  return ranked[0] || null;
}
