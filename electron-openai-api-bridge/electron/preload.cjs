const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronWebLLM", {
  getRuntimeConfig() {
    return {
      apiUrl: `http://${process.env.WEBLLM_API_HOST || "127.0.0.1"}:${process.env.WEBLLM_API_PORT || "3888"}`,
    };
  },
  notifyReady() {
    ipcRenderer.send("webllm-renderer-ready");
  },
  onRequest(handler) {
    ipcRenderer.on("webllm-request", (_event, message) => {
      handler(message);
    });
  },
  sendProgress(payload) {
    ipcRenderer.send("webllm-progress", payload);
  },
  sendResponse(id, payload) {
    ipcRenderer.send("webllm-response", { id, payload });
  },
  sendError(id, error) {
    ipcRenderer.send("webllm-error", { id, error });
  },
  sendStreamChunk(id, chunk) {
    ipcRenderer.send("webllm-stream-chunk", { id, chunk });
  },
  sendStreamDone(id) {
    ipcRenderer.send("webllm-stream-done", { id });
  },
  sendStreamError(id, error) {
    ipcRenderer.send("webllm-stream-error", { id, error });
  },
});
