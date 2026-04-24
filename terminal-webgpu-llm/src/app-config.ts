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
  model_type?: string;
  buffer_size_required_bytes?: number;
  runtime_supported?: boolean;
  runtime_support_notes?: string | null;
  max_tensor_cache_shard_bytes?: number;
  max_tensor_cache_record_bytes?: number;
  segmented_embedding_candidate?: {
    type?: string;
    row_axis?: number;
    weight_name?: string;
    weight_data_path?: string;
    weight_nbytes?: number;
    weight_shape?: number[];
    weight_dtype?: string;
    scale_name?: string;
    scale_data_path?: string;
    scale_nbytes?: number;
    scale_shape?: number[];
    scale_dtype?: string;
  };
  segmented_embedding_plan?: {
    target_max_buffer_bytes?: number;
    bytes_per_row_weight?: number;
    bytes_per_row_scale?: number;
    bytes_per_row_total?: number;
    max_rows_per_segment?: number;
    num_segments?: number;
    segments?: Array<{
      index?: number;
      row_start?: number;
      row_end?: number;
      row_count?: number;
      estimated_weight_nbytes?: number;
      estimated_scale_nbytes?: number;
      estimated_total_nbytes?: number;
    }>;
  };
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

function getLocalModelOverrides(modelId: string): Partial<webllm.ModelRecord> | undefined {
  if (modelId.startsWith("gemma-4-")) {
    return {
      overrides: {
        context_window_size: -1,
        sliding_window_size: 512,
        attention_sink_size: 0,
      },
    };
  }
  return undefined;
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
    if (entry.runtime_supported === false) {
      throw new Error(
        entry.runtime_support_notes ||
          `Model ${modelId} is stored on the local model server but is not currently runtime-supported.`,
      );
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
      buffer_size_required_bytes: entry.buffer_size_required_bytes,
      required_features: ["shader-f16"],
      ...getLocalModelOverrides(modelId),
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
