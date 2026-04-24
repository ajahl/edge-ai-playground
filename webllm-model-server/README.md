# WebLLM Model Server

This subproject serves converted MLC/WebLLM model packages over HTTP so [`../terminal-webgpu-llm`](../terminal-webgpu-llm) can load them by URL.

By default it serves the packaged models stored in:

- [`../mlc-models`](../mlc-models)

It reads:

- [`../mlc-models/index.json`](../mlc-models/index.json)

and exposes each model under its own base path.

## Run

```bash
cd webllm-model-server
pnpm start
```

Run the server tests:

```bash
cd webllm-model-server
pnpm test
```

Default URL:

```text
http://127.0.0.1:8090
```

Useful endpoints:

- `GET /health`
- `GET /models`
- `GET /models/<model-id>/mlc-chat-config.json`
- `GET /models/<model-id>/libs/<model-lib>.wasm`

Examples:

- `GET /models/qwen2.5-0.5b-instruct-q4f16_1-MLC/mlc-chat-config.json`
- `GET /models/qwen2.5-0.5b-instruct-q4f16_1-MLC/libs/qwen2.5-0.5b-instruct-q4f16_1-MLC-webgpu.wasm`

## Environment

- `HOST`: bind address, default `127.0.0.1`
- `PORT`: server port, default `8090`
- `MODELS_ROOT`: optional override for the `mlc-models` repository root
- `MODEL_ROOT`: optional single-package compatibility override; if set, the server serves just that package

## Using It With terminal-webgpu-llm

Start this server first, then start [`../terminal-webgpu-llm`](../terminal-webgpu-llm). The TUI discovers models from `GET /models` and exposes them with source-qualified ids such as:

- `local-webllm-model-server::qwen2.5-0.5b-instruct-q4f16_1-MLC`
- `local-webllm-model-server::gemma-4-E2B-it-q4f16_1-MLC`

Then in the TUI, select and load a model:

```text
/refresh-models
/model local-webllm-model-server::gemma-4-E2B-it-q4f16_1-MLC
/load
```

You can also load through the local API:

```bash
curl -s http://127.0.0.1:5179/v1/load \
  -H 'content-type: application/json' \
  -d '{"model":"local-webllm-model-server::gemma-4-E2B-it-q4f16_1-MLC"}'
```

Gemma4 status:

- `gemma-4-*` packages are experimental but expected to load when produced by the patched local `../mlc-llm` checkout.
- The model server advertises Gemma4 packages with `runtime_supported: true` when their package metadata and wasm are present.
- Keep the included Qwen package as a smaller control model for separating general WebLLM/server issues from Gemma-specific regressions.
