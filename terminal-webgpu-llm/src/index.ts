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
