#!/usr/bin/env bash
# Re-link the model wasm only — skip weight conversion + TVM C++ rebuild.
# Use when only Python model code (e.g. gemma4_model.py) has changed and you
# want a fresh wasm without re-converting weights or rebuilding TVM.
#
# Usage:
#   ./relink-only.sh gemma-4-e2b-it
#   IMAGE_TAG=mlc-packaging ./relink-only.sh gemma-4-e4b-it    # override image
#
# Takes ~1–2 minutes. Output: mlc-models/<OUTPUT_MODEL_ID>/package/libs/*.wasm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-gemma4-mlc-packaging}"
source "${SCRIPT_DIR}/config-selector.sh"

CONFIG_PATH="$(resolve_config_path "${1:-${CONFIG_PATH:-}}")"
RELATIVE_CONFIG_PATH="${CONFIG_PATH#${SCRIPT_DIR}/}"

echo "=== relink-only ==="
echo "image:  ${IMAGE_TAG}"
echo "config: ${RELATIVE_CONFIG_PATH}"
echo ""

docker run --rm \
  -v "${REPO_ROOT}:/repo-root" \
  -v "${REPO_ROOT}/mlc-llm:/opt/mlc-llm-local" \
  -e "CONFIG_PATH=/repo-root/mlc-packaging/${RELATIVE_CONFIG_PATH}" \
  -w /repo-root/mlc-packaging \
  "${IMAGE_TAG}" \
  '
set -euxo pipefail
source /opt/conda/etc/profile.d/conda.sh
conda activate mlc

git config --global --add safe.directory /opt/mlc-llm-local
export MLC_LLM_SOURCE_DIR=/opt/mlc-llm-local
export TVM_SOURCE_DIR=/opt/mlc-llm-local/3rdparty/tvm
export TVM_LIBRARY_PATH=/opt/conda/envs/mlc/lib/python3.13/site-packages/tvm
export PYTHONPATH=/opt/mlc-llm-local/3rdparty/tvm/python:${PYTHONPATH:-}

python -m pip install /opt/mlc-llm-local --no-build-isolation 2>&1 | tail -3

source /opt/emsdk/emsdk_env.sh >/dev/null

cd /repo-root/mlc-packaging
source "${CONFIG_PATH}"

WASM_DIR="../mlc-models/${OUTPUT_MODEL_ID}/package/libs"
mkdir -p "${WASM_DIR}"

echo "=== Step: relink wasm with current TVM (${OUTPUT_MODEL_ID}) ==="
python -m mlc_llm compile \
  "../mlc-models/${OUTPUT_MODEL_ID}/package/mlc-chat-config.json" \
  --device "${TARGET_DEVICE:-webgpu}" \
  --output "${WASM_DIR}/${OUTPUT_MODEL_ID}-${TARGET_DEVICE:-webgpu}.wasm" \
  ${EXTRA_COMPILE_ARGS:-}

echo ""
echo "=== Done ==="
ls -lh "${WASM_DIR}/${OUTPUT_MODEL_ID}-${TARGET_DEVICE:-webgpu}.wasm"
md5sum "${WASM_DIR}/${OUTPUT_MODEL_ID}-${TARGET_DEVICE:-webgpu}.wasm"
'
