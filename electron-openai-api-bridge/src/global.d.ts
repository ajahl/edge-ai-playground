interface ElectronWebLLMBridge {
  getRuntimeConfig(): {
    apiUrl: string;
  };
  notifyReady(): void;
  onRequest(
    handler: (message: {
      id: string;
      kind: "load" | "chat";
      payload?: Record<string, unknown>;
    }) => void,
  ): void;
  sendProgress(payload: { progress: number; text: string }): void;
  sendResponse(id: string, payload: unknown): void;
  sendError(id: string, error: string): void;
  sendStreamChunk(id: string, chunk: unknown): void;
  sendStreamDone(id: string): void;
  sendStreamError(id: string, error: string): void;
}

declare global {
  interface Window {
    electronWebLLM: ElectronWebLLMBridge;
  }
}

export {};
