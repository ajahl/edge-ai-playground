# MLC Packaging

This subproject generalizes the workflow from `gemma4-mlc-packaging` into a reusable MLC/WebLLM packaging pipeline for custom models.

It follows the model packaging flow described in the MLC LLM docs:

1. Download or reuse source weights.
2. Convert weights with `mlc_llm convert_weight`.
3. Generate `mlc-chat-config.json` with `mlc_llm gen_config`.
4. Compile the model library with `mlc_llm compile`.
5. Upload the resulting package to a host such as Hugging Face.
6. Point `terminal-webgpu-llm` or `webllm-model-server` at the package.

The key difference from `gemma4-mlc-packaging` is that the model-specific values are configurable through named env files under `configs/`.

## What This Is For

Use this project when you want to package:

- a custom or forked Hugging Face model
- a model that requires a patched local `mlc-llm` checkout
- a model that should be served to WebLLM-compatible clients
- a non-Gemma model without copying and editing Gemma-only scripts

## Layout

- `config.env.example`: example packaging inputs
- `run.sh`: generic packaging workflow
- `rebuild-custom-wasm.sh`: regenerate package config and wasm from existing converted weights
- `Dockerfile`: containerized MLC build environment
- `docker-build.sh`: build the Docker image
- `docker-run.sh`: run the packaging workflow in Docker with host-mounted artifacts

## Core Configuration

Create one or more named env files under `configs/`:

```bash
cd mlc-packaging
cp config.env.example configs/my-model.env
```

The project includes one ready-to-use example:

- [`configs/qwen2.5-0.5b-instruct.env`](configs/qwen2.5-0.5b-instruct.env)

The old top-level `config.env` is no longer used. If there are no `configs/*.env` files, the scripts now stop with a clear terminal error.

Important variables:

- `SOURCE_MODEL`: Hugging Face model id, or a local model directory already mounted into the container
- `OUTPUT_MODEL_ID`: model id used inside the packaged output and wasm name
- `OUTPUT_REPO`: optional target repo path for upload instructions
- `QUANTIZATION`: MLC quantization mode such as `q4f16_1`
- `MODEL_TYPE`: optional explicit MLC model type such as `gemma4`, `qwen2`, `llama`, `gemma3`
- `CONV_TEMPLATE`: optional conversation template such as `gemma_instruction`, `qwen2`, `llama-3`
- `MAX_BATCH_SIZE`: optional `mlc_llm gen_config --max-batch-size` value
- `TARGET_DEVICE`: compile target, defaults to `webgpu`

Optional advanced variables:

- `EXTRA_GEN_CONFIG_ARGS`: extra raw arguments passed to `mlc_llm gen_config`
- `EXTRA_COMPILE_ARGS`: extra raw arguments passed to `mlc_llm compile`
- `MODELS_REPO_DIR`: sibling repo or directory where model artifacts should be stored
- `MODEL_STORAGE_DIR`: optional per-model root directory, defaults to `../mlc-models/<OUTPUT_MODEL_ID>`
- `SOURCE_DIR`, `CONVERTED_DIR`, `PACKAGE_DIR`, `WASM_DIR`: artifact layout overrides
- `FORCE_RECONVERT=1`: ignore existing converted weights and rebuild `converted/` from `source/`

By default this project now stores all model artifacts in a separate sibling repo-style directory:

- `../mlc-models/<OUTPUT_MODEL_ID>/`

That makes it easier to accumulate multiple different packaged models in one place, including the original downloaded source model.

You usually do not need to set `PACKAGE_DIR` or `WASM_DIR` manually anymore. When they are left empty, the script derives them automatically from:

- `MODELS_REPO_DIR`
- `OUTPUT_MODEL_ID`

The default per-model layout is:

- `../mlc-models/<OUTPUT_MODEL_ID>/source`
- `../mlc-models/<OUTPUT_MODEL_ID>/converted`
- `../mlc-models/<OUTPUT_MODEL_ID>/package`

## Examples

Experimental Gemma4 config:

This target requires the local Gemma4 frontend/runtime changes in `../mlc-llm`; upstream WebLLM/MLC behavior may still differ.

```env
SOURCE_MODEL=google/gemma-4-E2B-it
OUTPUT_MODEL_ID=gemma-4-E2B-it-q4f16_1-MLC
OUTPUT_REPO=your-user/gemma-4-E2B-it-q4f16_1-MLC
QUANTIZATION=q4f16_1
MODEL_TYPE=gemma4
CONV_TEMPLATE=gemma4_instruction
MAX_BATCH_SIZE=1
TARGET_DEVICE=webgpu
EXTRA_GEN_CONFIG_ARGS="--prefill-chunk-size 512"
EXTRA_COMPILE_ARGS="--opt O0"
```

Supported Qwen style config:

```env
SOURCE_MODEL=Qwen/Qwen2.5-Coder-1.5B-Instruct
OUTPUT_MODEL_ID=qwen2.5-coder-1.5b-instruct-q4f16_1-MLC
OUTPUT_REPO=your-user/qwen2.5-coder-1.5b-instruct-q4f16_1-MLC
QUANTIZATION=q4f16_1
MODEL_TYPE=qwen2
CONV_TEMPLATE=qwen2
TARGET_DEVICE=webgpu
```

Default included config:

The checked-in [`configs/qwen2.5-0.5b-instruct.env`](configs/qwen2.5-0.5b-instruct.env) is preconfigured for a lightweight Hugging Face model:

- `Qwen/Qwen2.5-0.5B-Instruct`
- `MODEL_TYPE=qwen2`
- `CONV_TEMPLATE=qwen2`

This gives you a smaller control case for validating the generic workflow before moving on to larger or fork-specific models.

Gemma4 status:

- `gemma4` support is experimental in this repo.
- The local frontend pads 256-wide sliding-attention heads into the 512-wide KV-cache layout used by full-attention layers, then slices back before the output projection.
- Layer-local RoPE is applied in the model before cache attention, and the KV cache is created with `RopeMode.NONE`.
- The Gemma4 WebLLM package is expected to load through `../webllm-model-server` and `../terminal-webgpu-llm` when built from the patched local `../mlc-llm` checkout.
- The included Gemma4 config uses `gemma4_instruction`, stops on `<turn|>`, and stores artifacts under `../mlc-models/gemma-4-E2B-it-q4f16_1-MLC/`.
- Keep using the included Qwen config as the control model when checking whether failures are Gemma-specific or general runtime regressions.

Default storage layout:

- original Hugging Face source model goes to `../mlc-models/<OUTPUT_MODEL_ID>/source`
- converted MLC weights go to `../mlc-models/<OUTPUT_MODEL_ID>/converted`
- final packaged model output is written to `../mlc-models/<OUTPUT_MODEL_ID>/package`
- `../mlc-models/index.json` is refreshed after each successful packaging run

## Build The Docker Image

```bash
cd mlc-packaging
./docker-build.sh
```

Optional overrides:

```bash
IMAGE_TAG=my-mlc-packaging ./docker-build.sh
MLC_LLM_GIT_URL=https://github.com/<you>/mlc-llm.git MLC_LLM_GIT_REF=<branch> ./docker-build.sh
```

The recommended path is still to mount a local patched `mlc-llm` checkout at runtime.

If you change quantization code in your local `mlc-llm` checkout, set `FORCE_RECONVERT=1`
for the next packaging run. Otherwise `run.sh` will reuse an existing
`converted/tensor-cache.json` and skip `mlc_llm convert_weight`.

## One-Step Build

If you want one command that performs both the Docker image build and the packaging run, use:

```bash
cd mlc-packaging
HF_TOKEN="$HF_TOKEN" ./build.sh
```

This simply combines:

- `./docker-build.sh`
- `./docker-run.sh`

## Recommended Runtime Flow

```bash
cd mlc-packaging
HF_TOKEN="$HF_TOKEN" ./docker-run.sh
```

If you omit an explicit config, both `./build.sh` and `./docker-run.sh` open a simple terminal selector and let you choose one of the env files from `configs/`.

You can also pass a config name directly:

```bash
HF_TOKEN="$HF_TOKEN" ./build.sh qwen2.5-0.5b-instruct
HF_TOKEN="$HF_TOKEN" ./docker-run.sh qwen2.5-0.5b-instruct.env
```

That wrapper:

- mounts `../mlc-llm` at `/opt/mlc-llm-local` by default when that sibling checkout exists
- installs it editable in the container
- prepares WebAssembly dependencies when needed
- runs the generic packaging workflow from the host-mounted directory

If your `mlc-llm` checkout lives somewhere else, override it explicitly:

```bash
MLC_LLM_LOCAL_DIR=../some-other-mlc-llm HF_TOKEN="$HF_TOKEN" ./docker-run.sh
```

## Rebuilding Only The Wasm

If `artifacts/source` and `artifacts/converted` already exist, you can skip download and conversion and rebuild only the config plus wasm:

```bash
docker run --rm -it \
  -e HF_TOKEN="$HF_TOKEN" \
  -v "$HOME/mlc-llm:/opt/mlc-llm-local" \
  -v "$HOME/mlc-packaging:/host-workspace" \
  mlc-packaging \
  "source /opt/conda/etc/profile.d/conda.sh && conda activate mlc && /usr/local/bin/rebuild-custom-wasm.sh"
```

## Expected Output

After a successful run, the package directory should contain:

- `mlc-chat-config.json`
- converted parameter shards
- tensor cache metadata
- tokenizer files
- `libs/<OUTPUT_MODEL_ID>-<TARGET_DEVICE>.wasm`

With the default config, that means the final package lands in:

- [`../mlc-models`](../mlc-models)
- under a model-specific subdirectory such as:
  [`../mlc-models/qwen2.5-0.5b-instruct-q4f16_1-MLC`](../mlc-models/qwen2.5-0.5b-instruct-q4f16_1-MLC)

Inside that model folder, you should expect:

- `source/`
- `converted/`
- `package/`

The generated `index.json` contains one entry per successfully packaged model and is intended to be useful for tools such as `webllm-model-server`.

## Notes

- The `webgpu` compile path depends on MLC web bitcode artifacts being available from your mounted `mlc-llm` checkout.
- When the local `mlc-llm` fork changes, rerunning the workflow may regenerate the TVM web runtime bitcode under the mounted checkout.
- If you are using a patched model type that only exists in your local fork, make sure `MODEL_TYPE` matches that fork exactly.
