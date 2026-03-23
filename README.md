# Edge AI Playground

This workspace contains three WebGPU/WebLLM service variants with different runtime shapes:

- [chromium-openai-api-bridge](./chromium-openai-api-bridge): a Node bridge that keeps a real Chromium page alive and exposes a localhost OpenAI-compatible API.
- [electron-openai-api-bridge](./electron-openai-api-bridge): an Electron desktop wrapper that exposes a localhost OpenAI-compatible API from the Electron main process.
- [webgpu-llm-web-server](./webgpu-llm-web-server): a minimal browser-hosted WebGPU LLM service where the page runs WebLLM and same-origin browser code calls the API directly.

## Projects

### Chromium OpenAI API Bridge

Path: [chromium-openai-api-bridge](./chromium-openai-api-bridge)

Use this when you want a localhost REST API without Electron.

- Starts a Node HTTP server.
- Launches Playwright-managed Chromium with WebGPU.
- Runs WebLLM inside a real browser page.
- Exposes `GET /health`, `GET /v1/models`, `POST /v1/load`, and `POST /v1/chat/completions`.
- Good fit for terminal tools like `curl` while staying in a browser runtime.

Typical dev flow:

```bash
cd chromium-openai-api-bridge
pnpm install
pnpm dev
```

### Electron OpenAI API Bridge

Path: [electron-openai-api-bridge](./electron-openai-api-bridge)

Use this when you want a packaged desktop app that still provides a localhost API.

- Starts an Electron app.
- Runs WebLLM in the Electron renderer process with WebGPU.
- Exposes the REST API from the Electron main process.
- Supports the same OpenAI-style routes as the Chromium bridge.
- Good fit when Electron is acceptable or preferred for distribution.

Typical dev flow:

```bash
cd electron-openai-api-bridge
pnpm install
pnpm dev
```

### WebGPU LLM Service

Path: [webgpu-llm-web-server](./webgpu-llm-web-server)

Use this when you want the simplest browser-native setup.

- Serves a webpage locally.
- Runs WebLLM in the browser page.
- Uses a service worker to expose same-origin `/v1/...` endpoints.
- Keeps the model warm while the page stays open.
- Best fit for browser callers on the same origin, not for external `curl` clients.

Typical dev flow:

```bash
cd webgpu-llm-web-server
pnpm install
pnpm dev
```

## Which One To Use

- Choose `webgpu-llm-web-server` if your client is another browser page on the same origin.
- Choose `chromium-openai-api-bridge` if you want a practical localhost API without Electron.
- Choose `electron-openai-api-bridge` if you want a desktop wrapper with a built-in localhost API.

## Notes

- All three variants rely on WebGPU and browser-style runtimes for model execution.
- The Chromium and Electron bridges are the right choices for machine-local REST access from terminal tools.
- The browser-hosted service is the lightest setup, but it depends on the page remaining open.

## Acknowledgments

Thanks to the MLC-AI team for the WebLLM and MLC tooling that these examples build on. This workspace includes and adapts components from the MLC-AI ecosystem.
