const DEFAULT_BASE_URL = process.env.TERMINAL_WEBGPU_LLM_API_URL || "http://127.0.0.1:5179";

export class TerminalWebgpuApiClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, model = process.env.MODEL || "", logger = console } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.logger = logger;
  }

  async request(path, options = {}) {
    if (options.body) {
      this.logger.log(`\n-> ${path}`);
      this.logger.log(typeof options.body === "string" ? options.body : JSON.stringify(options.body, null, 2));
    } else {
      this.logger.log(`\n-> ${path}`);
    }
    const response = await fetch(`${this.baseUrl}${path}`, options);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(payload?.error?.message || payload?.error || `API request failed with ${response.status}`);
    }
    this.logger.log(`<- ${path}`);
    this.logger.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  async health() {
    return this.request("/health");
  }

  async models() {
    return this.request("/v1/models");
  }

  async load(model = this.model) {
    if (!model) {
      throw new Error("No model provided for load.");
    }
    this.model = model;
    return this.request("/v1/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
  }

  async chat(messages, extra = {}) {
    const payload = {
      model: extra.model || this.model || undefined,
      messages,
      temperature: extra.temperature,
      max_tokens: extra.max_tokens,
      response_format: extra.response_format,
    };
    return this.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
}
