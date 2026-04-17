# MLC Models

This repository is intended to store packaged MLC/WebLLM model artifacts produced by sibling tooling such as [`../custom-mlc-packaging`](../custom-mlc-packaging).

An [`index.json`](index.json) file is expected to be refreshed automatically by the packaging workflow after each successful model build.

Recommended layout:

- one subdirectory per packaged model id
- each model directory contains:
  - `mlc-chat-config.json`
  - parameter shards
  - tensor cache metadata
  - tokenizer files
  - `libs/<model-id>-<target>.wasm`

Example layout:

```text
mlc-models/
  index.json
  qwen2.5-0.5b-instruct-q4f16_1-MLC/
    mlc-chat-config.json
    tensor-cache.json
    tokenizer.json
    libs/
      qwen2.5-0.5b-instruct-q4f16_1-MLC-webgpu.wasm
```
