# Terminal WebGPU LLM

This subproject provides a terminal-first chat UI for WebLLM.

It does not show a browser window, but it still uses a hidden Chromium page under the hood for the actual WebGPU + WebLLM runtime. The terminal is the only user-facing surface.

## What It Does

- serves a tiny hidden renderer page locally
- launches headless Chromium with WebGPU flags
- loads WebLLM in that hidden page
- exposes a terminal chat UI using `blessed`
- keeps multi-turn chat history as context
- auto-attaches URL page context when a prompt contains a URL
- supports built-in and Hugging Face-discovered MLC models
- can inspect and clear cached model downloads
- shows compact response usage metrics in the transcript

## Run

```bash
cd terminal-webgpu-llm
pnpm install
pnpm build
pnpm start
```

Optional:

```bash
MODEL=Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC pnpm start
```

Startup with an explicit model id:

```bash
pnpm start -- Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC
```

## Commands

- type a prompt and press `Enter`
- paste a URL into a prompt to attach page context automatically
- `Ctrl+L`: load the currently selected model
- `/models`: list all known models
- `/refresh-models`: refresh the Hugging Face-backed model list
- `/model <id>`: switch the selected model id
- `/load`: load the currently selected model
- `/cache`: list cached models and total cache size
- `/clear-cache <id>`: clear one model's cached downloads
- `/clear-chat`: clear the conversation history
- `q` or `Ctrl+C`: quit

## API Access

The TUI also starts an OpenAI-compatible local API on `127.0.0.1:5179` by default.

You can call it from another terminal:

```bash
curl http://127.0.0.1:5179/health
curl http://127.0.0.1:5179/v1/models
curl -X POST http://127.0.0.1:5179/v1/load \
  -H 'content-type: application/json' \
  -d '{"model":"Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC"}'
curl -X POST http://127.0.0.1:5179/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model":"Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
    "messages":[{"role":"user","content":"Hello from another terminal"}]
  }'
curl -N -X POST http://127.0.0.1:5179/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model":"Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
    "stream": true,
    "messages":[{"role":"user","content":"Stream a short answer"}]
  }'
curl -X POST http://127.0.0.1:5179/v1/responses \
  -H 'content-type: application/json' \
  -d '{
    "model":"Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC",
    "input":"Hello from /v1/responses"
  }'
```

Supported API surface today:

- `GET /health`
- `GET /v1/models`
- `POST /v1/load`
- `POST /v1/chat/completions`
- `POST /v1/chat/completions` with `stream: true` as SSE
- `POST /v1/responses`
- `POST /v1/responses` with `stream: true` as SSE

Current limitations:

- `POST /v1/embeddings` returns `501` for now
- streaming support is text-focused
- this is OpenAI-compatible, not a full OpenAI feature-complete server

Environment variables:

- `PORT`: hidden renderer/static server port, default `5178`
- `API_PORT`: external API port, default `5179`
- `MODEL`: optional startup model fallback if no CLI model id is passed

## Notes

- This is terminal-only in UX, not browser-free in runtime.
- WebLLM still needs a browser runtime for WebGPU.
- Playwright-managed Chromium must be available.
- Hugging Face models are filtered against the `binary-mlc-llm-libs` `v0_2_80` WebGPU wasm directory.
