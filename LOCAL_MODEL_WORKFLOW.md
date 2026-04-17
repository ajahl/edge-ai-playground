# Local Model Workflow

This guide shows the full command flow to download, convert, serve, and load an LLM into `terminal-webgpu-llm`.

Run these commands from the repo root unless a step says otherwise.

## 1. Convert and package a model into `mlc-models`

If the model already has a config in `custom-mlc-packaging/configs`, run:

```bash
cd custom-mlc-packaging
HF_TOKEN="$HF_TOKEN" ./docker-run.sh qwen2.5-0.5b-instruct
```

This will:

- download the original Hugging Face model into `mlc-models/<model-id>/source`
- convert weights into `mlc-models/<model-id>/converted`
- generate the package in `mlc-models/<model-id>/package`
- compile the WebGPU wasm in `mlc-models/<model-id>/package/libs`

For another configured model, use its config name:

```bash
HF_TOKEN="$HF_TOKEN" ./docker-run.sh gemma-4-E2B-it
```

## 2. Verify the packaged model exists

Example for qwen:

```bash
ls mlc-models/qwen2.5-0.5b-instruct-q4f16_1-MLC
ls mlc-models/qwen2.5-0.5b-instruct-q4f16_1-MLC/source
ls mlc-models/qwen2.5-0.5b-instruct-q4f16_1-MLC/package
ls mlc-models/qwen2.5-0.5b-instruct-q4f16_1-MLC/package/libs
```

You should see at least:

- `source/`
- `converted/`
- `package/mlc-chat-config.json`
- `package/libs/<model-id>-webgpu.wasm`

## 3. Start the local model server

```bash
cd webllm-model-server
node server.mjs
```

If port `8090` is already in use:

```bash
lsof -nP -iTCP:8090 -sTCP:LISTEN
kill <PID>
```

Quick verification:

```bash
curl -s http://127.0.0.1:8090/models
```

## 4. Start `terminal-webgpu-llm`

In a second terminal:

```bash
cd terminal-webgpu-llm
pnpm start
```

If port `5179` is already in use:

```bash
lsof -nP -iTCP:5179 -sTCP:LISTEN
kill -9 <PID>
pnpm start
```

Quick verification:

```bash
curl -s http://127.0.0.1:5179/v1/models
```

You should see entries like:

```text
local-webllm-model-server::qwen2.5-0.5b-instruct-q4f16_1-MLC
```

## 5. Load the model in the TUI API

Example:

```bash
curl -s -X POST http://127.0.0.1:5179/v1/load \
  -H 'Content-Type: application/json' \
  --data '{"model":"local-webllm-model-server::qwen2.5-0.5b-instruct-q4f16_1-MLC"}'
```

Expected result:

```json
{"ok":true,"loaded":true}
```

## 6. Send a chat request

```bash
curl -s -X POST http://127.0.0.1:5179/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data '{
    "model":"local-webllm-model-server::qwen2.5-0.5b-instruct-q4f16_1-MLC",
    "messages":[
      {"role":"user","content":"Reply with exactly: local model ok"}
    ],
    "temperature":0
  }'
```

Expected output includes:

```json
"content":"Local model ok"
```

## Minimal end-to-end example

```bash
cd custom-mlc-packaging
HF_TOKEN="$HF_TOKEN" ./docker-run.sh qwen2.5-0.5b-instruct
```

```bash
cd webllm-model-server
node server.mjs
```

```bash
cd terminal-webgpu-llm
pnpm start
```

```bash
curl -s http://127.0.0.1:5179/v1/models
```

```bash
curl -s -X POST http://127.0.0.1:5179/v1/load \
  -H 'Content-Type: application/json' \
  --data '{"model":"local-webllm-model-server::qwen2.5-0.5b-instruct-q4f16_1-MLC"}'
```

```bash
curl -s -X POST http://127.0.0.1:5179/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data '{
    "model":"local-webllm-model-server::qwen2.5-0.5b-instruct-q4f16_1-MLC",
    "messages":[{"role":"user","content":"Say hello"}]
  }'
```

## Generic checklist for any new model

```bash
cd custom-mlc-packaging
HF_TOKEN="$HF_TOKEN" ./docker-run.sh <config-name>
```

```bash
ls mlc-models/<output-model-id>/package/libs
```

```bash
cd webllm-model-server
node server.mjs
```

```bash
cd terminal-webgpu-llm
pnpm start
```

```bash
curl -s http://127.0.0.1:5179/v1/models
```

```bash
curl -s -X POST http://127.0.0.1:5179/v1/load \
  -H 'Content-Type: application/json' \
  --data '{"model":"local-webllm-model-server::<output-model-id>"}'
```

```bash
curl -s -X POST http://127.0.0.1:5179/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data '{
    "model":"local-webllm-model-server::<output-model-id>",
    "messages":[{"role":"user","content":"Hello"}]
  }'
```
