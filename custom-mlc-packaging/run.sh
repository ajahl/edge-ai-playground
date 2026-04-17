#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${CONFIG_PATH:-}"

if [[ -z "${ENV_FILE}" || ! -f "${ENV_FILE}" ]]; then
  echo "Missing config file: ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${ENV_FILE}"

: "${SOURCE_MODEL:?SOURCE_MODEL must be set}"
: "${OUTPUT_MODEL_ID:?OUTPUT_MODEL_ID must be set}"
: "${QUANTIZATION:?QUANTIZATION must be set}"

TARGET_DEVICE="${TARGET_DEVICE:-webgpu}"
MODELS_REPO_DIR="${MODELS_REPO_DIR:-../mlc-models}"
MODEL_STORAGE_DIR="${MODEL_STORAGE_DIR:-${MODELS_REPO_DIR}/${OUTPUT_MODEL_ID}}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${MODEL_STORAGE_DIR}}"
SOURCE_DIR="${SOURCE_DIR:-${MODEL_STORAGE_DIR}/source}"
CONVERTED_DIR="${CONVERTED_DIR:-${MODEL_STORAGE_DIR}/converted}"
PACKAGE_DIR="${PACKAGE_DIR:-${MODEL_STORAGE_DIR}/package}"
WASM_DIR="${WASM_DIR:-${PACKAGE_DIR}/libs}"

if ! python -c "import mlc_llm" >/dev/null 2>&1; then
  echo "mlc_llm Python module is not installed." >&2
  exit 1
fi

if [[ -f "/opt/emsdk/emsdk_env.sh" ]]; then
  # WebGPU packaging needs emcc for prep_emcc_deps.sh and wasm export.
  # shellcheck disable=SC1091
  source /opt/emsdk/emsdk_env.sh >/dev/null
fi

prepare_web_bitcode() {
  if [[ "${TARGET_DEVICE}" != "webgpu" ]]; then
    return 0
  fi
  if [[ ! -d "/opt/mlc-llm-local" ]]; then
    return 0
  fi

  export MLC_LLM_SOURCE_DIR="/opt/mlc-llm-local"
  export TVM_SOURCE_DIR="/opt/mlc-llm-local/3rdparty/tvm"

  git config --global --add safe.directory /opt/mlc-llm-local

  # Always refresh the local WebAssembly support bitcode when compiling against
  # a mounted checkout. Mixing freshly rebuilt TVM bitcode with a stale
  # `mlc_wasm_runtime.bc` can produce model libraries with runtime ABI mismatch.
  echo "Preparing WebAssembly build dependencies from ${MLC_LLM_SOURCE_DIR}"
  (
    cd "${MLC_LLM_SOURCE_DIR}"
    rm -rf ./web/dist ./3rdparty/tvm/web/dist
    ./web/prep_emcc_deps.sh
  )

  local tvm_py_dir
  tvm_py_dir="$(python -c 'import os, tvm; print(os.path.dirname(tvm.__file__))')"
  mkdir -p "${tvm_py_dir}/lib"
  mkdir -p "${tvm_py_dir}/contrib"
  cp -f "${MLC_LLM_SOURCE_DIR}/3rdparty/tvm/web/dist/wasm/wasm_runtime.bc" "${tvm_py_dir}/wasm_runtime.bc"
  cp -f "${MLC_LLM_SOURCE_DIR}/3rdparty/tvm/web/dist/wasm/wasm_runtime.bc" "${tvm_py_dir}/lib/wasm_runtime.bc"
  cp -f "${MLC_LLM_SOURCE_DIR}/3rdparty/tvm/web/dist/wasm/tvmjs_support.bc" "${tvm_py_dir}/tvmjs_support.bc"
  cp -f "${MLC_LLM_SOURCE_DIR}/3rdparty/tvm/web/dist/wasm/tvmjs_support.bc" "${tvm_py_dir}/lib/tvmjs_support.bc"
  cp -f "${MLC_LLM_SOURCE_DIR}/3rdparty/tvm/web/dist/wasm/webgpu_runtime.bc" "${tvm_py_dir}/webgpu_runtime.bc"
  cp -f "${MLC_LLM_SOURCE_DIR}/3rdparty/tvm/web/dist/wasm/webgpu_runtime.bc" "${tvm_py_dir}/lib/webgpu_runtime.bc"
  cp -f "${MLC_LLM_SOURCE_DIR}/3rdparty/tvm/python/tvm/contrib/emcc.py" "${tvm_py_dir}/contrib/emcc.py"
}

append_args_from_string() {
  local raw="${1:-}"
  local -n dest_ref="$2"
  if [[ -z "${raw}" ]]; then
    return 0
  fi
  # shellcheck disable=SC2206
  local split_args=( ${raw} )
  dest_ref+=("${split_args[@]}")
}

update_models_index() {
  local index_path="${MODELS_REPO_DIR}/index.json"
  python - "${MODELS_REPO_DIR}" "${index_path}" <<'PY'
import json
import os
import sys

models_repo_dir = os.path.abspath(sys.argv[1])
index_path = os.path.abspath(sys.argv[2])

entries = []
if os.path.isdir(models_repo_dir):
    for name in sorted(os.listdir(models_repo_dir)):
        model_dir = os.path.join(models_repo_dir, name)
        if not os.path.isdir(model_dir):
            continue
        package_dir = os.path.join(model_dir, "package")
        config_path = os.path.join(package_dir, "mlc-chat-config.json")
        if not os.path.isfile(config_path):
            continue

        libs_dir = os.path.join(package_dir, "libs")
        libs = []
        if os.path.isdir(libs_dir):
            for lib_name in sorted(os.listdir(libs_dir)):
                if lib_name.endswith(".wasm"):
                    libs.append(f"package/libs/{lib_name}")

        entries.append(
            {
                "id": name,
                "rootDir": name,
                "sourceDir": f"{name}/source",
                "convertedDir": f"{name}/converted",
                "packageDir": f"{name}/package",
                "config": f"{name}/package/mlc-chat-config.json",
                "libs": libs,
            }
        )

payload = {"models": entries}
os.makedirs(os.path.dirname(index_path), exist_ok=True)
with open(index_path, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)
    f.write("\n")
PY
}

mkdir -p "${ARTIFACTS_DIR}" "${SOURCE_DIR}" "${CONVERTED_DIR}" "${MODELS_REPO_DIR}" "${MODEL_STORAGE_DIR}" "${PACKAGE_DIR}" "${WASM_DIR}"

prepare_web_bitcode

echo "Step 1: download source weights if needed"
if [[ ! -f "${SOURCE_DIR}/config.json" ]]; then
  echo "  Downloading ${SOURCE_MODEL} into ${SOURCE_DIR}"
  if command -v hf >/dev/null 2>&1; then
    hf download "${SOURCE_MODEL}" --local-dir "${SOURCE_DIR}"
  elif command -v huggingface-cli >/dev/null 2>&1; then
    huggingface-cli download "${SOURCE_MODEL}" --local-dir "${SOURCE_DIR}"
  else
    echo "Neither hf nor huggingface-cli is available in the container." >&2
    exit 1
  fi
else
  echo "  Reusing existing source weights in ${SOURCE_DIR}"
fi

echo "Step 2: convert weights"
if [[ -f "${CONVERTED_DIR}/tensor-cache.json" ]]; then
  echo "  Reusing existing converted weights in ${CONVERTED_DIR}"
else
  python -m mlc_llm convert_weight \
    "${SOURCE_DIR}" \
    --quantization "${QUANTIZATION}" \
    --output "${CONVERTED_DIR}"
fi

echo "Step 3: generate config"
gen_config_args=(
  "${SOURCE_DIR}"
  "--quantization" "${QUANTIZATION}"
  "--output" "${PACKAGE_DIR}"
)
if [[ -n "${MODEL_TYPE:-}" ]]; then
  gen_config_args+=("--model-type" "${MODEL_TYPE}")
fi
if [[ -n "${CONV_TEMPLATE:-}" ]]; then
  gen_config_args+=("--conv-template" "${CONV_TEMPLATE}")
fi
if [[ -n "${MAX_BATCH_SIZE:-}" ]]; then
  gen_config_args+=("--max-batch-size" "${MAX_BATCH_SIZE}")
fi
append_args_from_string "${EXTRA_GEN_CONFIG_ARGS:-}" gen_config_args
python -m mlc_llm gen_config "${gen_config_args[@]}"

echo "Step 4: copy converted params into package dir"
cp -R "${CONVERTED_DIR}/." "${PACKAGE_DIR}/"

echo "Step 5: compile ${TARGET_DEVICE} library"
compile_args=(
  "${PACKAGE_DIR}/mlc-chat-config.json"
  "--device" "${TARGET_DEVICE}"
  "--output" "${WASM_DIR}/${OUTPUT_MODEL_ID}-${TARGET_DEVICE}.wasm"
)
append_args_from_string "${EXTRA_COMPILE_ARGS:-}" compile_args
python -m mlc_llm compile "${compile_args[@]}"

echo "Step 6: update mlc-models index"
update_models_index

cat <<EOF

Local package prepared in:
  ${PACKAGE_DIR}

Output library:
  ${WASM_DIR}/${OUTPUT_MODEL_ID}-${TARGET_DEVICE}.wasm

Next steps:
1. Upload ${PACKAGE_DIR} to:
   https://huggingface.co/${OUTPUT_REPO:-<your-repo>}
2. Ensure the repo root contains:
   - mlc-chat-config.json
   - params_shard_*.bin
   - tensor-cache.json or ndarrays cache metadata
   - tokenizer files
   - libs/${OUTPUT_MODEL_ID}-${TARGET_DEVICE}.wasm
3. Add a terminal-webgpu-llm ModelRecord that points at:
   model: https://huggingface.co/${OUTPUT_REPO:-<your-repo>}
   model_lib: https://huggingface.co/${OUTPUT_REPO:-<your-repo>}/resolve/main/libs/${OUTPUT_MODEL_ID}-${TARGET_DEVICE}.wasm

EOF
