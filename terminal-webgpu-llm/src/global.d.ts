export {};

declare global {
  interface Window {
    bridgeEmit?: (event: {
      type: string;
      payload?: unknown;
    }) => void;
    tuiRendererReady?: boolean;
    tuiLoad?: (payload?: { model?: string; modelId?: string; source?: string }) => Promise<{
      ok: boolean;
      loaded: boolean;
      model: string;
    }>;
    tuiChat?: (payload: Record<string, unknown>) => Promise<unknown>;
    tuiListCachedModels?: (payload?: { models?: string[] }) => Promise<{
      totalBytes: number;
      cachedModels: Array<{ model: string; sizeBytes: number }>;
    }>;
    tuiClearModel?: (payload?: { model?: string }) => Promise<{
      ok: boolean;
      model: string;
    }>;
  }
}
