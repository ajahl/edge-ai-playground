import type { AvailableModel } from "./index";

export type ChatUsage = {
  completion_tokens?: number;
  prompt_tokens?: number;
  total_tokens?: number;
  extra?: {
    e2e_latency_s?: number;
    prefill_tokens_per_s?: number;
    decode_tokens_per_s?: number;
    time_to_first_token_s?: number;
    time_per_output_token_s?: number;
  };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  usage?: ChatUsage;
};

export type CachedModelMeta = {
  model: AvailableModel;
  sizeBytes: number;
  updatedAt: number;
};

export type AttachedUrlContext = {
  url: string;
  title: string;
  content: string;
};
