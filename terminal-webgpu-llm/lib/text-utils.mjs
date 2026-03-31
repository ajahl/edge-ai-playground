export function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

export function buildChatCompletionChunk(model, chunk) {
  return {
    id: chunk?.id || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: chunk?.created || Math.floor(Date.now() / 1000),
    model,
    choices: Array.isArray(chunk?.choices) ? chunk.choices : [],
    usage: chunk?.usage,
  };
}

export function normalizeResponseInput(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input)) {
    return [];
  }
  const text = input
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (typeof item?.content === "string") {
        return item.content;
      }
      if (Array.isArray(item?.content)) {
        return item.content
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .filter(Boolean)
          .join("\n");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
  return text ? [{ role: "user", content: text }] : [];
}

export function mapCompletionToResponse(payload, completion) {
  const assistantText =
    completion?.choices?.[0]?.message?.content ||
    completion?.choices?.[0]?.text ||
    "";

  return {
    id: completion?.id || `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: payload.model,
    status: "completed",
    output: [
      {
        type: "message",
        id: `msg_${crypto.randomUUID()}`,
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: assistantText,
          },
        ],
      },
    ],
    output_text: assistantText,
    usage: completion?.usage,
  };
}

export function formatUsage(usage) {
  if (!usage) {
    return null;
  }
  const parts = [];
  if (typeof usage.prompt_tokens === "number") {
    parts.push(`prompt ${usage.prompt_tokens}`);
  }
  if (typeof usage.completion_tokens === "number") {
    parts.push(`completion ${usage.completion_tokens}`);
  }
  if (typeof usage.total_tokens === "number") {
    parts.push(`total ${usage.total_tokens}`);
  }
  if (typeof usage.extra?.time_to_first_token_s === "number") {
    parts.push(`ttft ${usage.extra.time_to_first_token_s.toFixed(2)}s`);
  }
  if (typeof usage.extra?.decode_tokens_per_s === "number") {
    parts.push(`decode ${usage.extra.decode_tokens_per_s.toFixed(1)} tok/s`);
  }
  if (typeof usage.extra?.prefill_tokens_per_s === "number") {
    parts.push(`prefill ${usage.extra.prefill_tokens_per_s.toFixed(1)} tok/s`);
  }
  if (typeof usage.extra?.e2e_latency_s === "number") {
    parts.push(`latency ${usage.extra.e2e_latency_s.toFixed(2)}s`);
  }
  return parts;
}

export function extractChunkText(chunk) {
  const content = chunk?.choices?.[0]?.delta?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

export function extractFirstUrl(text) {
  const match = text.match(/((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s)>"']*)?)/i)?.[0];
  if (!match) {
    return null;
  }
  return match.startsWith("http://") || match.startsWith("https://")
    ? match
    : `https://${match}`;
}

export function cleanupExtractedText(text) {
  return text
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function stripHtmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<template[\s\S]*?<\/template>/gi, " ")
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|ul|ol|h1|h2|h3|h4|h5|h6|blockquote|pre)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

export function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim()) : null;
}
