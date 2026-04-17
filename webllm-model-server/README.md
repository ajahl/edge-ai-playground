# WebLLM Model Server

This subproject serves converted MLC/WebLLM model packages over HTTP so [terminal-webgpu-llm](terminal-webgpu-llm) can load them by URL.

By default it serves the packaged models stored in:

- [mlc-models](/Volumes/DevArea/machine-learning/edge-ai-playground/mlc-models)

It reads:

- [index.json](/Volumes/DevArea/machine-learning/edge-ai-playground/mlc-models/index.json)

and exposes each model under its own base path.

## Run

```bash
cd webllm-model-server
pnpm start
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

- `GET /models/gemma-4-E2B-it-q4f16_1-MLC/mlc-chat-config.json`
- `GET /models/gemma-4-E2B-it-q4f16_1-MLC/libs/gemma-4-E2B-it-q4f16_1-MLC-webgpu.wasm`
- `GET /models/qwen2.5-0.5b-instruct-q4f16_1-MLC/mlc-chat-config.json`

## Environment

- `HOST`: bind address, default `127.0.0.1`
- `PORT`: server port, default `8090`
- `MODELS_ROOT`: optional override for the `mlc-models` repository root
- `MODEL_ROOT`: optional single-package compatibility override; if set, the server serves just that package

## Using It With terminal-webgpu-llm

Point a model record in [terminal-webgpu-llm/src/app-config.ts](terminal-webgpu-llm/src/app-config.ts) at the model-specific base URL.

For Gemma:

- `model`: `http://127.0.0.1:8090/models/gemma-4-E2B-it-q4f16_1-MLC`
- `model_lib`: `http://127.0.0.1:8090/models/gemma-4-E2B-it-q4f16_1-MLC/libs/gemma-4-E2B-it-q4f16_1-MLC-webgpu.wasm`

For Qwen:

- `model`: `http://127.0.0.1:8090/models/qwen2.5-0.5b-instruct-q4f16_1-MLC`
- `model_lib`: `http://127.0.0.1:8090/models/qwen2.5-0.5b-instruct-q4f16_1-MLC/libs/qwen2.5-0.5b-instruct-q4f16_1-MLC-webgpu.wasm`

Then in the TUI:

```text
/model gemma-4-E2B-it-q4f16_1-MLC
/load
```
