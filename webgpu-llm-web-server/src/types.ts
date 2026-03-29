import type { AvailableModel } from "./index";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
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
