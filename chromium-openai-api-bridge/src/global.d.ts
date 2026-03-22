declare global {
  interface Window {
    webllmBridgeReady?: boolean;
    webllmLoad?: () => Promise<unknown>;
    webllmChat?: (request: Record<string, unknown>) => Promise<unknown>;
    webllmStreamChat?: (id: string, request: Record<string, unknown>) => Promise<void>;
    bridgeEmit?: (event: {
      id: string;
      type: "chunk" | "done" | "error" | "progress";
      payload?: unknown;
      error?: string;
    }) => void;
  }
}

export {};
