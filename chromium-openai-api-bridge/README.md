# WebLLM OpenAI-Compatible Chromium Bridge

This example exposes a localhost REST API for terminal clients by keeping a real Chromium page alive with WebLLM loaded.

Instead of using a service worker or Electron, it:

- starts a small Node HTTP server
- launches a Playwright-managed Chromium browser
- opens a Vite page that runs WebLLM with WebGPU
- forwards OpenAI-style requests from terminal clients into that page

This is useful when you want terminal access but want to avoid Electron.

## What It Provides

The local API runs on `http://127.0.0.1:3890` and exposes:

- `GET /health`
- `GET /v1/models`
- `POST /v1/load`
- `POST /v1/chat/completions`

`POST /v1/chat/completions` supports:

- non-streaming JSON responses
- streaming SSE responses when `stream: true`

If port `3890` is already in use, you can override it:

```bash
API_PORT=3890 pnpm dev
```

If your Vite renderer is reachable at a different host, you can override that too:

```bash
RENDERER_URL=http://localhost:5175 API_PORT=3890 pnpm dev
```

## Requirements

- Node.js 20 or 22 recommended
- `pnpm`
- Playwright-compatible Chromium provided by the Nix shell
- WebGPU available in that browser

## Nix Shell

If you use the repo `flake.nix`, the dev shell now provides:

- Node.js 22
- `pnpm`
- `playwright-driver.browsers`
- `PLAYWRIGHT_BROWSERS_PATH`
- `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS`

So the bridge can use the Nix-managed browser bundle without relying on any system-installed Chromium:

```bash
nix develop
cd chromium-openai-api-bridge
pnpm install
pnpm dev
```

If you need to override the executable manually, set:

```bash
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium
```

## Run

```bash
cd chromium-openai-api-bridge
pnpm install
pnpm dev
```

This starts:

- a Vite page on `http://127.0.0.1:5175`
- a Node bridge on `http://127.0.0.1:3890`
- a Chromium window controlled by Playwright

Keep the browser running while you use the API.

## Warm The Model

```bash
curl -X POST http://127.0.0.1:3890/v1/load
```

## Non-Streaming Request

```bash
curl http://127.0.0.1:3890/v1/chat/completions \
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
curl -N http://127.0.0.1:3890/v1/chat/completions \
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

## Notes

- The model lives in the browser page, not in Node.
- The HTTP API only works while the Chromium page is open and connected.
- This is a practical terminal bridge, not a pure server-side runtime.
