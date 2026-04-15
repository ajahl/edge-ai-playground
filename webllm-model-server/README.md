# WebLLM Model Server

This subproject serves a converted MLC/WebLLM model package over HTTP so [terminal-webgpu-llm](terminal-webgpu-llm) can load it by URL.

By default it serves:

- [gemma4-mlc-packaging/artifacts/package](gemma4-mlc-packaging/artifacts/package)

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
- `GET /mlc-chat-config.json`
- `GET /libs/gemma-4-E2B-it-q4f16_1-MLC-webgpu.wasm`

## Environment

- `HOST`: bind address, default `127.0.0.1`
- `PORT`: server port, default `8090`
- `MODEL_ROOT`: optional override for the served package directory

## Using It With terminal-webgpu-llm

Point the Gemma model record in [terminal-webgpu-llm/src/app-config.ts](terminal-webgpu-llm/src/app-config.ts) at:

- `model`: `http://127.0.0.1:8090`
- `model_lib`: `http://127.0.0.1:8090/libs/gemma-4-E2B-it-q4f16_1-MLC-webgpu.wasm`

Then in the TUI:

```text
/model gemma-4-E2B-it-q4f16_1-MLC
/load
```
