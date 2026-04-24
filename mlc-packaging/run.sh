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
FORCE_RECONVERT="${FORCE_RECONVERT:-0}"

if [[ -d "/opt/mlc-llm-local/3rdparty/tvm/python" ]]; then
  export TVM_LIBRARY_PATH="/opt/conda/envs/mlc/lib/python3.13/site-packages/tvm"
  export PYTHONPATH="/opt/mlc-llm-local/3rdparty/tvm/python:${PYTHONPATH:-}"
fi

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
  if [[ "${MLC_LLM_SOURCE_DIR}/3rdparty/tvm/python/tvm/contrib/emcc.py" != "${tvm_py_dir}/contrib/emcc.py" ]]; then
    cp -f "${MLC_LLM_SOURCE_DIR}/3rdparty/tvm/python/tvm/contrib/emcc.py" "${tvm_py_dir}/contrib/emcc.py"
  fi
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

validate_generated_package() {
  local config_path="${PACKAGE_DIR}/mlc-chat-config.json"
  if [[ ! -f "${config_path}" ]]; then
    echo "Expected generated config at ${config_path}, but it was not found." >&2
    exit 1
  fi

  python - "${config_path}" <<'PY'
import json
import sys

config_path = sys.argv[1]
with open(config_path, "r", encoding="utf-8") as f:
    config = json.load(f)

model_type = config.get("model_type")
if model_type == "gemma4":
    config["runtime_support_notes"] = (
        "Gemma4 is experimental in this repo. The model frontend pads mixed head dimensions "
        "into a uniform WebLLM KV-cache and applies layer-local RoPE before cache attention."
    )
PY
}

update_models_index() {
  local index_path="${MODELS_REPO_DIR}/index.json"
  python - "${MODELS_REPO_DIR}" "${index_path}" <<'PY'
import json
import os
import sys

models_repo_dir = os.path.abspath(sys.argv[1])
index_path = os.path.abspath(sys.argv[2])
target_max_buffer_bytes = 128 * 1024 * 1024


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def find_segmented_embedding_candidate(tensor_cache):
    weight_record = None
    scale_record = None
    weight_shard_path = None
    scale_shard_path = None
    segmented_shards = {}

    for shard in tensor_cache.get("records", []):
        for record in shard.get("records", []):
            name = record.get("name")
            if not isinstance(name, str):
                continue
            if name.endswith(".embed_tokens.q_weight"):
                weight_record = record
                weight_shard_path = shard.get("dataPath")
            elif name.endswith(".embed_tokens.q_scale"):
                scale_record = record
                scale_shard_path = shard.get("dataPath")
                continue

            marker = ".embed_tokens.shards."
            if marker not in name:
                continue
            prefix, suffix = name.split(marker, 1)
            parts = suffix.split(".")
            if len(parts) != 2:
                continue
            segment_index_raw, tensor_role = parts
            if tensor_role not in ("q_weight", "q_scale"):
                continue
            try:
                segment_index = int(segment_index_raw)
            except ValueError:
                continue
            shard_entry = segmented_shards.setdefault(
                segment_index,
                {
                    "index": segment_index,
                },
            )
            shard_entry[f"{tensor_role}_name"] = name
            shard_entry[f"{tensor_role}_data_path"] = shard.get("dataPath")
            shard_entry[f"{tensor_role}_nbytes"] = int(record.get("nbytes", 0))
            shard_entry[f"{tensor_role}_shape"] = record.get("shape")
            shard_entry[f"{tensor_role}_dtype"] = record.get("dtype")

    if segmented_shards:
        segments = []
        row_start = 0
        for segment_index in sorted(segmented_shards):
            shard_entry = segmented_shards[segment_index]
            weight_shape = shard_entry.get("q_weight_shape") or []
            scale_shape = shard_entry.get("q_scale_shape") or []
            if (
                len(weight_shape) < 1
                or len(scale_shape) < 1
                or not isinstance(weight_shape[0], int)
                or not isinstance(scale_shape[0], int)
            ):
                continue
            row_count = int(weight_shape[0])
            segments.append(
                {
                    "index": segment_index,
                    "row_start": row_start,
                    "row_end": row_start + row_count,
                    "row_count": row_count,
                    "weight_name": shard_entry.get("q_weight_name"),
                    "weight_data_path": shard_entry.get("q_weight_data_path"),
                    "weight_nbytes": shard_entry.get("q_weight_nbytes"),
                    "weight_shape": shard_entry.get("q_weight_shape"),
                    "weight_dtype": shard_entry.get("q_weight_dtype"),
                    "scale_name": shard_entry.get("q_scale_name"),
                    "scale_data_path": shard_entry.get("q_scale_data_path"),
                    "scale_nbytes": shard_entry.get("q_scale_nbytes"),
                    "scale_shape": shard_entry.get("q_scale_shape"),
                    "scale_dtype": shard_entry.get("q_scale_dtype"),
                }
            )
            row_start += row_count
        if segments:
            return {
                "type": "segmented_group_quantized_embedding",
                "row_axis": 0,
                "num_segments": len(segments),
                "segments": segments,
            }

    if weight_record is None or scale_record is None:
        return None

    return {
        "type": "group_quantized_embedding",
        "row_axis": 0,
        "weight_name": weight_record["name"],
        "weight_data_path": weight_shard_path,
        "weight_nbytes": int(weight_record["nbytes"]),
        "weight_shape": weight_record.get("shape"),
        "weight_dtype": weight_record.get("dtype"),
        "scale_name": scale_record["name"],
        "scale_data_path": scale_shard_path,
        "scale_nbytes": int(scale_record["nbytes"]),
        "scale_shape": scale_record.get("shape"),
        "scale_dtype": scale_record.get("dtype"),
    }


def build_segmented_embedding_plan(candidate, target_max_buffer_bytes):
    if candidate is None:
        return None

    if candidate.get("type") == "segmented_group_quantized_embedding":
        segments = candidate.get("segments") or []
        if not segments:
            return None
        bytes_per_row_weight = None
        bytes_per_row_scale = None
        planned_segments = []
        for segment in segments:
            row_count = segment.get("row_count")
            weight_nbytes = segment.get("weight_nbytes")
            scale_nbytes = segment.get("scale_nbytes")
            if (
                not isinstance(row_count, int)
                or row_count <= 0
                or not isinstance(weight_nbytes, int)
                or not isinstance(scale_nbytes, int)
            ):
                return None
            if bytes_per_row_weight is None:
                bytes_per_row_weight = weight_nbytes // row_count
            if bytes_per_row_scale is None:
                bytes_per_row_scale = scale_nbytes // row_count
            planned_segments.append(
                {
                    "index": int(segment["index"]),
                    "row_start": int(segment["row_start"]),
                    "row_end": int(segment["row_end"]),
                    "row_count": int(segment["row_count"]),
                    "estimated_weight_nbytes": int(weight_nbytes),
                    "estimated_scale_nbytes": int(scale_nbytes),
                    "estimated_total_nbytes": int(weight_nbytes) + int(scale_nbytes),
                }
            )
        if bytes_per_row_weight is None or bytes_per_row_scale is None:
            return None
        return {
            "target_max_buffer_bytes": target_max_buffer_bytes,
            "bytes_per_row_weight": bytes_per_row_weight,
            "bytes_per_row_scale": bytes_per_row_scale,
            "bytes_per_row_total": bytes_per_row_weight + bytes_per_row_scale,
            "max_rows_per_segment": max(int(segment["row_count"]) for segment in segments),
            "num_segments": len(segments),
            "segments": planned_segments,
        }

    weight_nbytes = candidate.get("weight_nbytes")
    weight_shape = candidate.get("weight_shape") or []
    scale_nbytes = candidate.get("scale_nbytes")
    scale_shape = candidate.get("scale_shape") or []
    if (
        not isinstance(weight_nbytes, int)
        or not isinstance(scale_nbytes, int)
        or len(weight_shape) < 1
        or len(scale_shape) < 1
        or not isinstance(weight_shape[0], int)
        or not isinstance(scale_shape[0], int)
    ):
        return None

    total_rows = weight_shape[0]
    if total_rows <= 0:
        return None

    bytes_per_row_weight = weight_nbytes // total_rows
    bytes_per_row_scale = scale_nbytes // total_rows
    bytes_per_row_total = bytes_per_row_weight + bytes_per_row_scale
    if bytes_per_row_total <= 0:
        return None

    max_rows_per_segment = max(1, target_max_buffer_bytes // bytes_per_row_total)
    num_segments = (total_rows + max_rows_per_segment - 1) // max_rows_per_segment

    segments = []
    for segment_index in range(num_segments):
        row_start = segment_index * max_rows_per_segment
        row_end = min(total_rows, row_start + max_rows_per_segment)
        row_count = row_end - row_start
        segments.append(
            {
                "index": segment_index,
                "row_start": row_start,
                "row_end": row_end,
                "row_count": row_count,
                "estimated_weight_nbytes": row_count * bytes_per_row_weight,
                "estimated_scale_nbytes": row_count * bytes_per_row_scale,
                "estimated_total_nbytes": row_count * bytes_per_row_total,
            }
        )

    return {
        "target_max_buffer_bytes": target_max_buffer_bytes,
        "bytes_per_row_weight": bytes_per_row_weight,
        "bytes_per_row_scale": bytes_per_row_scale,
        "bytes_per_row_total": bytes_per_row_total,
        "max_rows_per_segment": max_rows_per_segment,
        "num_segments": num_segments,
        "segments": segments,
    }

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
        config = read_json(config_path) or {}
        model_type = config.get("model_type")
        runtime_supported = True
        runtime_support_notes = None
        if model_type == "gemma4":
            runtime_supported = True
            runtime_support_notes = (
                "Gemma4 support is experimental. This package requires the local Gemma4 frontend "
                "that pads mixed head dimensions into a uniform WebLLM KV-cache and applies "
                "layer-local RoPE before cache attention."
            )

        libs_dir = os.path.join(package_dir, "libs")
        libs = []
        if os.path.isdir(libs_dir):
            for lib_name in sorted(os.listdir(libs_dir)):
                if lib_name.endswith(".wasm"):
                    libs.append(f"package/libs/{lib_name}")

        tensor_cache = read_json(os.path.join(package_dir, "tensor-cache.json")) or {}
        max_shard_bytes = 0
        max_record_bytes = 0
        for shard in tensor_cache.get("records", []):
            if isinstance(shard.get("nbytes"), (int, float)):
                max_shard_bytes = max(max_shard_bytes, int(shard["nbytes"]))
            for record in shard.get("records", []):
                if isinstance(record.get("nbytes"), (int, float)):
                    max_record_bytes = max(max_record_bytes, int(record["nbytes"]))
        segmented_embedding_candidate = find_segmented_embedding_candidate(tensor_cache)
        segmented_embedding_plan = build_segmented_embedding_plan(
            segmented_embedding_candidate,
            target_max_buffer_bytes,
        )

        entries.append(
            {
                "id": name,
                "rootDir": name,
                "sourceDir": f"{name}/source",
                "convertedDir": f"{name}/converted",
                "packageDir": f"{name}/package",
                "config": f"{name}/package/mlc-chat-config.json",
                "libs": libs,
                "model_type": model_type,
                "buffer_size_required_bytes": max(max_shard_bytes, max_record_bytes),
                "max_tensor_cache_shard_bytes": max_shard_bytes,
                "max_tensor_cache_record_bytes": max_record_bytes,
                "segmented_embedding_candidate": segmented_embedding_candidate,
                "segmented_embedding_plan": segmented_embedding_plan,
                "runtime_supported": runtime_supported,
                "runtime_support_notes": runtime_support_notes,
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
if [[ "${FORCE_RECONVERT}" == "1" ]]; then
  echo "  FORCE_RECONVERT=1, removing existing converted weights in ${CONVERTED_DIR}"
  rm -rf "${CONVERTED_DIR}"
  mkdir -p "${CONVERTED_DIR}"
  python -m mlc_llm convert_weight \
    "${SOURCE_DIR}" \
    --quantization "${QUANTIZATION}" \
    --output "${CONVERTED_DIR}"
elif [[ -f "${CONVERTED_DIR}/tensor-cache.json" ]]; then
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
validate_generated_package

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
