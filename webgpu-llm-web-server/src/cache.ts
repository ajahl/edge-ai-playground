import type { AvailableModel } from "./index";
import { AVAILABLE_MODELS } from "./models";
import { cachedModels, modelSelect, storageUsage } from "./dom";
import type { CachedModelMeta } from "./types";
import { formatBytes, formatTime, setStatus } from "./utils";

const WEBLLM_CACHE_NAMES = ["webllm/model", "webllm/config", "webllm/wasm"];
const CACHED_MODELS_META_STORAGE_KEY = "webllm.cached-model-meta.v1";
let knownModels: AvailableModel[] = [...AVAILABLE_MODELS];

export function setKnownModels(models: AvailableModel[]) {
  knownModels = Array.from(new Set(models));
}

function getKnownModels() {
  return knownModels;
}

function readCachedModelMetaIndex() {
  try {
    const raw = localStorage.getItem(CACHED_MODELS_META_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    return JSON.parse(raw) as Record<string, CachedModelMeta>;
  } catch {
    return {};
  }
}

function writeCachedModelMetaIndex(index: Partial<Record<AvailableModel, CachedModelMeta>>) {
  try {
    localStorage.setItem(CACHED_MODELS_META_STORAGE_KEY, JSON.stringify(index));
  } catch {
    // Ignore storage write issues.
  }
}

export function upsertCachedModelMeta(model: AvailableModel, sizeBytes: number) {
  const index = readCachedModelMetaIndex();
  index[model] = {
    model,
    sizeBytes,
    updatedAt: Date.now(),
  };
  writeCachedModelMetaIndex(index);
}

export function removeCachedModelMeta(model: AvailableModel) {
  const index = readCachedModelMetaIndex();
  delete index[model];
  writeCachedModelMetaIndex(index);
}

function getCachedModelMetaList() {
  const index = readCachedModelMetaIndex();
  return getKnownModels()
    .map((model) => index[model])
    .filter((entry): entry is CachedModelMeta => Boolean(entry));
}

export async function inspectWebLLMCache() {
  if (!("caches" in window)) {
    return null;
  }

  let total = 0;
  const perModelBytes = new Map<AvailableModel, number>();
  const knownModels = getKnownModels();

  for (const cacheName of WEBLLM_CACHE_NAMES) {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();

    for (const request of requests) {
      const matchedModel = knownModels.find((model) => request.url.includes(model)) ?? null;
      const response = await cache.match(request);
      if (!response) {
        continue;
      }

      const byteLength = (await response.clone().arrayBuffer()).byteLength;
      total += byteLength;

      if (matchedModel) {
        perModelBytes.set(matchedModel, (perModelBytes.get(matchedModel) ?? 0) + byteLength);
      }
    }
  }

  return {
    totalBytes: total,
    cachedModels: knownModels.filter((model) => perModelBytes.has(model)),
    perModelBytes,
  };
}

function renderCachedModels(
  models: CachedModelMeta[],
  onSelectModel: (model: AvailableModel) => void,
) {
  if (models.length === 0) {
    cachedModels.textContent = "none";
    return;
  }

  const list = document.createElement("div");
  list.className = "model-list";

  for (const meta of models) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "model-chip";
    item.textContent = `${meta.model} (${formatBytes(meta.sizeBytes)})`;
    item.addEventListener("click", () => {
      modelSelect.value = meta.model;
      onSelectModel(meta.model);
    });
    list.append(item);
  }

  cachedModels.replaceChildren(list);
}

export async function clearWebLLMBrowserStorage() {
  if ("caches" in window) {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => WEBLLM_CACHE_NAMES.includes(cacheName))
        .map((cacheName) => caches.delete(cacheName)),
    );
  }

  if ("indexedDB" in window && typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases();
    await Promise.all(
      databases
        .map((database) => database.name)
        .filter((name): name is string => Boolean(name) && name.includes("webllm"))
        .map(
          (name) =>
            new Promise<void>((resolve) => {
              const request = indexedDB.deleteDatabase(name);
              request.onsuccess = () => resolve();
              request.onerror = () => resolve();
              request.onblocked = () => resolve();
            }),
        ),
    );
  }

  try {
    const localStorageKeys = Object.keys(localStorage).filter((key) =>
      key.toLowerCase().includes("webllm"),
    );
    for (const key of localStorageKeys) {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage access issues.
  }
}

export async function refreshStorageUsage(onSelectModel: (model: AvailableModel) => void) {
  try {
    setStatus(storageUsage, "refreshing...");
    cachedModels.textContent = "refreshing...";
    const cachedMeta = getCachedModelMetaList();

    if (cachedMeta.length > 0) {
      const totalBytes = cachedMeta.reduce((sum, entry) => sum + entry.sizeBytes, 0);
      setStatus(
        storageUsage,
        `${formatBytes(totalBytes)} (cached model index, updated ${formatTime(new Date())})`,
      );
      renderCachedModels(cachedMeta, onSelectModel);
      return;
    }

    const inspection = await inspectWebLLMCache();
    if (inspection === null) {
      setStatus(storageUsage, "unavailable");
      cachedModels.textContent = "unavailable";
      return;
    }

    const rebuiltMeta = inspection.cachedModels.map((model) => ({
      model,
      sizeBytes: inspection.perModelBytes.get(model) ?? 0,
      updatedAt: Date.now(),
    }));

    writeCachedModelMetaIndex(
      Object.fromEntries(rebuiltMeta.map((entry) => [entry.model, entry])) as Partial<
        Record<AvailableModel, CachedModelMeta>
      >,
    );

    setStatus(
      storageUsage,
      `${formatBytes(inspection.totalBytes)} (WebLLM cache, updated ${formatTime(new Date())})`,
    );
    renderCachedModels(rebuiltMeta, onSelectModel);
  } catch {
    setStatus(storageUsage, "unavailable");
    cachedModels.textContent = "unavailable";
  }
}
