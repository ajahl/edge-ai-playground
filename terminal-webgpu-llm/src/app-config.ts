import * as webllm from "@mlc-ai/web-llm";

type LocalServerModelLib = {
  path?: string;
  url?: string;
};

type LocalServerModelEntry = {
  id?: string;
  model?: string;
  config?: string;
  libs?: LocalServerModelLib[];
};

type LocalServerModelsResponse = {
  models?: LocalServerModelEntry[];
};

const MODEL_SOURCE = {
  BUILTIN: "built-in",
  LOCAL: "local-webllm-model-server",
  HUGGINGFACE: "huggingface",
} as const;

const LOCAL_MODEL_SERVER_BASE =
  (globalThis as { __WEBLLM_MODEL_SERVER_URL__?: string }).__WEBLLM_MODEL_SERVER_URL__?.replace(/\/$/, "") ||
  "http://127.0.0.1:8090";

const dynamicAppConfig: webllm.AppConfig = {
  ...webllm.prebuiltAppConfig,
  cacheBackend: "indexeddb",
  model_list: [...webllm.prebuiltAppConfig.model_list],
};

let localServerModelsPromise: Promise<Map<string, LocalServerModelEntry>> | null = null;

function findModelRecord(modelId: string) {
  return dynamicAppConfig.model_list.find((entry) => entry.model_id === modelId) ?? null;
}

function toAbsoluteUrl(urlOrPath: string) {
  if (/^https?:\/\//.test(urlOrPath)) {
    return urlOrPath;
  }
  return `${LOCAL_MODEL_SERVER_BASE}${urlOrPath.startsWith("/") ? "" : "/"}${urlOrPath}`;
}

async function fetchLocalServerModels() {
  if (localServerModelsPromise) {
    return localServerModelsPromise;
  }

  localServerModelsPromise = (async () => {
    const response = await fetch(`${LOCAL_MODEL_SERVER_BASE}/models`);
    if (!response.ok) {
      throw new Error(`webllm-model-server /models failed with ${response.status}`);
    }

    const payload = (await response.json()) as LocalServerModelsResponse;
    const entries = Array.isArray(payload.models) ? payload.models : [];
    const modelMap = new Map<string, LocalServerModelEntry>();

    for (const entry of entries) {
      if (typeof entry?.id === "string" && entry.id) {
        modelMap.set(entry.id, entry);
      }
    }

    return modelMap;
  })().catch((error) => {
    localServerModelsPromise = null;
    throw error;
  });

  return localServerModelsPromise;
}

export function getAppConfig() {
  return dynamicAppConfig;
}

export async function ensureModelInAppConfig(modelKey: string, source: string, modelId: string) {
  const existing = findModelRecord(modelKey);
  if (existing) {
    return existing;
  }

  if (source === MODEL_SOURCE.LOCAL) {
    const localServerModels = await fetchLocalServerModels();
    const entry = localServerModels.get(modelId);
    if (!entry) {
      return null;
    }

    const wasmLib =
      entry.libs?.find((lib) => typeof lib?.url === "string" && lib.url.endsWith("-webgpu.wasm")) ??
      entry.libs?.find((lib) => typeof lib?.url === "string");

    if (typeof entry.model !== "string" || !wasmLib?.url) {
      return null;
    }

    const record: webllm.ModelRecord = {
      model: toAbsoluteUrl(entry.model),
      model_id: modelKey,
      model_lib: toAbsoluteUrl(wasmLib.url),
      required_features: ["shader-f16"],
    };

    dynamicAppConfig.model_list.push(record);
    return record;
  }

  const baseRecord = findModelRecord(modelId);
  if (!baseRecord) {
    return null;
  }

  const record: webllm.ModelRecord = {
    ...baseRecord,
    model_id: modelKey,
  };

  dynamicAppConfig.model_list.push(record);
  return record;
}
