import * as webllm from "@mlc-ai/web-llm";
import type { AvailableModel } from "./index";

const dynamicAppConfig: webllm.AppConfig = {
  ...webllm.prebuiltAppConfig,
  model_list: [...webllm.prebuiltAppConfig.model_list],
};

function inferModelUrl(modelId: string) {
  return `https://huggingface.co/mlc-ai/${modelId}`;
}

function inferModelLibUrl(modelId: string) {
  return `${webllm.modelLibURLPrefix}${webllm.modelVersion}/${modelId}-ctx4k_cs1k-webgpu.wasm`;
}

export function getAppConfig() {
  return dynamicAppConfig;
}

export function findModelRecord(modelId: string) {
  return dynamicAppConfig.model_list.find((entry) => entry.model_id === modelId) ?? null;
}

export function ensureModelInAppConfig(modelId: AvailableModel) {
  const existing = findModelRecord(modelId);
  if (existing) {
    return existing;
  }

  const inferredRecord: webllm.ModelRecord = {
    model: inferModelUrl(modelId),
    model_id: modelId,
    model_lib: inferModelLibUrl(modelId),
  };

  dynamicAppConfig.model_list.push(inferredRecord);
  console.debug("[webgpu-llm] added dynamic appConfig model record", inferredRecord);
  return inferredRecord;
}
