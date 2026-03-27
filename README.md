# Edge AI Playground

This workspace contains six WebGPU/WebLLM variants with different runtime shapes:

- [chromium-openai-api-bridge](./chromium-openai-api-bridge): a Node bridge that keeps a real Chromium page alive and exposes a localhost OpenAI-compatible API.
- [electron-openai-api-bridge](./electron-openai-api-bridge): an Electron desktop wrapper that exposes a localhost OpenAI-compatible API from the Electron main process.
- [webgpu-llm-web-server](./webgpu-llm-web-server): a minimal browser-hosted WebGPU LLM service where the page runs WebLLM and same-origin browser code calls the API directly.
- [firefox-webgpu-llm-extension](./firefox-webgpu-llm-extension): a Firefox sidebar extension that runs WebLLM locally in the extension UI and adds storage cleanup and usage reporting.
- [chromium-webgpu-llm-extension](./chromium-webgpu-llm-extension): a Chromium-family side panel extension that mirrors the Firefox extension behavior using a MV3 service worker and an offscreen engine host.
- [safari-webgpu-llm-extension](./safari-webgpu-llm-extension): a Safari-targeted extension scaffold based on the Chromium extension source, intended for later Safari/Xcode packaging.

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

### Firefox WebGPU LLM Extension

Path: [firefox-webgpu-llm-extension](./firefox-webgpu-llm-extension)

Use this when you want the model directly inside Firefox as a docked sidebar tool.

- Opens from the Firefox toolbar into the browser sidebar.
- Runs WebLLM inside the extension UI with WebGPU.
- Streams chat responses inside the sidebar conversation panel.
- Shows model-load progress with a progress bar.
- Reports WebLLM storage usage and can clear the extension's WebLLM caches and databases.

Typical dev flow:

```bash
cd firefox-webgpu-llm-extension
pnpm install
pnpm build
```

### Chromium WebGPU LLM Extension

Path: [chromium-webgpu-llm-extension](./chromium-webgpu-llm-extension)

Use this when you want the model directly inside Chrome or Chromium as a side panel tool.

- Opens from the browser toolbar into the side panel.
- Runs the UI in a side panel while keeping WebLLM warm in an offscreen document.
- Streams chat responses inside the panel conversation view.
- Supports page reading, storage reporting, and storage cleanup similar to the Firefox variant.

Typical dev flow:

```bash
cd chromium-webgpu-llm-extension
pnpm install
pnpm build
```

### Safari WebGPU LLM Extension

Path: [safari-webgpu-llm-extension](./safari-webgpu-llm-extension)

Use this when you want a Safari-specific starting point in this repo and are prepared to finish the Apple packaging step with Safari/Xcode tooling.

- Starts from the Chromium extension source as the closest web-extension base.
- Keeps the same WebLLM UI and feature intent in source form.
- Still needs Apple packaging/conversion and Safari runtime validation before it can be treated as a real Safari extension deliverable.

Typical dev flow:

```bash
cd safari-webgpu-llm-extension
pnpm install
pnpm build
```

## Which One To Use

- Choose `webgpu-llm-web-server` if your client is another browser page on the same origin.
- Choose `chromium-openai-api-bridge` if you want a practical localhost API without Electron.
- Choose `electron-openai-api-bridge` if you want a desktop wrapper with a built-in localhost API.
- Choose `firefox-webgpu-llm-extension` if you want the model embedded directly into Firefox as a sidebar experience.
- Choose `chromium-webgpu-llm-extension` if you want the model embedded directly into Chrome or Chromium as a side panel experience.
- Choose `safari-webgpu-llm-extension` if you want a Safari-focused starting point and you can complete the Apple packaging step outside this repo.

## Notes

- All six variants rely on WebGPU and browser-style runtimes for model execution.
- The Chromium and Electron bridges are the right choices for machine-local REST access from terminal tools.
- The browser-hosted service is the lightest setup, but it depends on the page remaining open.
- The Firefox extension keeps its WebLLM data inside the extension's own browser storage context.
- The Chromium-family extension keeps the model warm in an offscreen document so it can outlive the visible panel UI.
- The Safari extension folder is currently a source scaffold and still requires Safari/Xcode packaging work.

## Acknowledgments

Thanks to the MLC-AI team for the WebLLM and MLC tooling that these examples build on. This workspace includes and adapts components from the MLC-AI ecosystem.
