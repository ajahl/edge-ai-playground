# Terminal llama.cpp LLM

This subproject provides a terminal-first chat UI for local `llama.cpp` inference.

It mirrors the shape of `terminal-webgpu-llm`, but swaps the runtime to:

- Hugging Face for GGUF model discovery and downloads
- `llama.cpp` `llama-server` for model serving and inference
- a local terminal UI for loading, running, and chatting

## What It Does

- lists curated GGUF-capable Hugging Face model repos
- downloads GGUF files into a local models directory
- launches `llama-server` for the selected model
- calls the local OpenAI-compatible `llama-server` API
- keeps multi-turn chat history as context
- exposes model and runtime commands inside the TUI

## Requirements

Install `llama.cpp` and make `llama-server` available on your `PATH`, or set:

- `LLAMA_SERVER_BIN=/absolute/path/to/llama-server`

Optional:

- `HF_TOKEN` for gated Hugging Face repos or higher rate limits
- `MODELS_DIR` to override the default local model cache
- `API_PORT` to change the external API port, default `8012`
- `LLAMA_PORT` to change the internal `llama-server` port, default `8013`
- `N_GPU_LAYERS` to set `--n-gpu-layers`
- `CTX_SIZE` to set `--ctx-size`

The built-in catalog now includes:

- Gemma 4 GGUF repos such as `unsloth/gemma-4-E2B-it-GGUF`, `unsloth/gemma-4-E4B-it-GGUF`, and `unsloth/gemma-4-26B-A4B-it-GGUF`
- a TurboQuant-oriented repo example: `YTan2000/Qwen3.5-27B-TQ3_4S`

## Run

```bash
cd terminal-llama-cpp-llm
pnpm install
pnpm start
```

Startup with an explicit model id:

```bash
pnpm start -- bartowski/Qwen2.5-Coder-3B-Instruct-GGUF
```

## Docker

Build the image:

```bash
cd terminal-llama-cpp-llm
docker build -t terminal-llama-cpp-llm .
```

```bash
cd terminal-llama-cpp-llm
docker build --no-cache -t terminal-llama-cpp-llm .
```

Run the TUI with a persistent model volume:

```bash
docker run --rm -it \
  -p 8012:8012 \
  -v terminal-llama-cpp-models:/models \
  terminal-llama-cpp-llm
```

Pass NVIDIA graphicscards: 
```bash
docker run --rm -it \
  --gpus all \
  -p 8012:8012 \
  -v models:/models \
  terminal-llama-cpp-llm

```

Pass NVIDIA graphicscards (benchmark test): 
```bash
docker network create webgpu-llm-net

docker run --rm -it \
  --name terminal-webgpu-llm  \
  --gpus all \
  -p 8012:8012 \
  --network webgpu-llm-net \
  -v models:/models \
  terminal-llama-cpp-llm

docker run --rm -it \
  --network webgpu-llm-net \
  -e TERMINAL_WEBGPU_LLM_API_URL=http://terminal-webgpu-llm:8012 \
  terminal-webgpu-llm-benchmark
```




Run with a startup model and Hugging Face token:

```bash
docker run --rm -it \
  -p 8012:8012 \
  -v terminal-llama-cpp-models:/models \
  -e HF_TOKEN=hf_xxx \
  terminal-llama-cpp-llm \
  bartowski/Qwen2.5-Coder-3B-Instruct-GGUF
```

Run with a host-mounted model directory instead of a named volume:

```bash
docker run --rm -it \
  -p 8012:8012 \
  -v "$(pwd)/models:/models" \
  terminal-llama-cpp-llm
```

Optional runtime tuning:

- `HF_TOKEN`: Hugging Face access token for gated or rate-limited repos
- `API_PORT`: external TUI/API port, default `8012`
- `LLAMA_PORT`: internal `llama-server` port, default `8013`
- `N_GPU_LAYERS`: passed to `llama-server --n-gpu-layers`
- `CTX_SIZE`: passed to `llama-server --ctx-size`
- `MODELS_DIR`: local model cache path inside the container, default `/models`

## Commands

- type a prompt and press `Enter`
- `Ctrl+L`: load the currently selected model into `llama-server`
- `/models`: list discovered models
- `/refresh-models`: refresh the Hugging Face-backed model list
- `/model <repo-or-file>`: select a model repo or a downloaded file
- `/download [repo-or-file]`: download the selected model or a specific one
- `/downloaded`: list local GGUF files
- `/load [repo-or-file]`: download if needed and launch `llama-server`
- `/running`: show the active server state
- `/stop`: stop the active `llama-server`
- `/clear-chat`: clear the conversation history
- `q` or `Ctrl+C`: quit

## Notes

- This app currently targets `llama-server`, not the low-level `llama-cli`.
- The TUI now exposes its own API on `8012` by default and keeps `llama-server` behind it on `8013`.
- Hugging Face discovery is intentionally curated toward repos that usually contain GGUF assets.
- When a repo has multiple GGUF files, the downloader prefers quantized instruct/chat variants.
- The Docker image bundles `llama-server` and stores downloaded GGUF files under `/models`.
- Gemma 4 repos on Hugging Face are often multimodal. This TUI currently uses text-only chat requests.
- TurboQuant-style `TQ*` GGUF files may require a `llama.cpp` or `llama-server` build with TurboQuant support. The repo can list and prefer them, but actual loading depends on the runtime binary.
