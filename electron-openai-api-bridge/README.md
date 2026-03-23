# WebLLM OpenAI-Compatible Electron Bridge

This example is the desktop-wrapper version of the OpenAI-compatible REST bridge.

Instead of exposing the API from a browser service worker, it:

- starts an Electron app
- runs WebLLM inside the Electron renderer process with WebGPU
- exposes a localhost HTTP API from the Electron main process
- lets terminal clients call the model with `curl`

This is the right shape when you want terminal access while still keeping WebLLM in a Chromium/WebGPU runtime.

## What It Provides

The Electron main process exposes a local HTTP server on `http://127.0.0.1:3888` with:

- `GET /v1/models`
- `POST /v1/load`
- `POST /v1/chat/completions`
- `GET /health`

`POST /v1/chat/completions` supports:

- non-streaming JSON responses
- streaming responses with OpenAI-style server-sent events when `stream: true`

## Requirements

- Node.js and `pnpm`
- Electron-compatible machine with GPU support
- WebGPU support available in Electron on your system

## Run In Dev

```bash
cd web-llm/examples/openai-api-electron
pnpm install
pnpm dev
```

This starts:

- a Vite renderer on port `5174`
- an Electron app window
- a local REST API on port `3888`

Keep the Electron app running while you use the API.

You can override the default dev endpoints if needed:

```bash
WEBLLM_API_PORT=3891 WEBLLM_RENDERER_URL=http://127.0.0.1:5174 pnpm dev
```

## Load The Model

Warm the model once:

```bash
curl -X POST http://127.0.0.1:3888/v1/load
```

## Non-Streaming Request

```bash
curl http://127.0.0.1:3888/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "webllm-local",
    "messages": [
      { "role": "user", "content": "Write one short sentence about WebGPU." }
    ]
  }'
```

## Streaming Request

```bash
curl -N http://127.0.0.1:3888/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "webllm-local",
    "stream": true,
    "stream_options": { "include_usage": true },
    "messages": [
      { "role": "user", "content": "Tell me a short story about local AI." }
    ]
  }'
```

## Health Check

```bash
curl http://127.0.0.1:3888/health
```

## Project Structure

- `electron/main.cjs`: Electron app entry and localhost REST server
- `electron/preload.cjs`: secure IPC bridge between renderer and main
- `index.html`: small status UI
- `src/main.ts`: renderer-side WebLLM engine and request handling
- `src/index.ts`: shared constants

## Notes

- The model lives in the Electron renderer process, not the Node main process.
- The local HTTP server only works while the Electron app is open.
- Unlike the service-worker example, this can be called from terminal tools such as `curl`.
- The example now defaults to `Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC`, matching the runnable Chrome bridge variant.
