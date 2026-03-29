export const OPENAI_API_PATH = "/v1/chat/completions";
export const MODELS_API_PATH = "/v1/models";
export const LOAD_API_PATH = "/v1/load";
export const URL_CONTEXT_API_PATH = "/v1/url-context";
export const DEFAULT_CONTEXT_WINDOW_SIZE = 32768;
export const DEFAULT_SLIDING_WINDOW_SIZE = 4096;

export const AVAILABLE_MODELS = [
  "Llama-3.2-3B-Instruct-q4f16_1-MLC",
  "Llama-3.2-1B-Instruct-q4f16_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
  "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC",
  "Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
  "Ministral-3-3B-Reasoning-2512-q4f16_1-MLC",
  "Qwen3-8B-q4f16_1-MLC",
] as const;

export const DEFAULT_MODEL = AVAILABLE_MODELS[0];

export type AvailableModel = (typeof AVAILABLE_MODELS)[number];
