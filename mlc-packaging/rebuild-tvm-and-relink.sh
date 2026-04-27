#!/usr/bin/env bash
# Full TVM C++ rebuild + wasm relink.
# Use when TVM C++ runtime (paged_kv_cache.cc, tree_attn.cc, etc.) has changed
# and the wasm needs to embed the new runtime.
#
# Bypasses ./web/prep_emcc_deps.sh's `git submodule update --init` so local
# uncommitted TVM patches are preserved (they would otherwise be wiped).
#
# Usage:
#   ./rebuild-tvm-and-relink.sh gemma-4-e2b-it
#   IMAGE_TAG=mlc-packaging ./rebuild-tvm-and-relink.sh gemma-4-e4b-it
#
# Takes ~5 minutes. Output: mlc-models/<OUTPUT_MODEL_ID>/package/libs/*.wasm
# plus rebuilt TVM bitcode in the container's tvm/lib (lost on container exit
# but the resulting wasm includes the new runtime).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-gemma4-mlc-packaging}"
source "${SCRIPT_DIR}/config-selector.sh"

CONFIG_PATH="$(resolve_config_path "${1:-${CONFIG_PATH:-}}")"
RELATIVE_CONFIG_PATH="${CONFIG_PATH#${SCRIPT_DIR}/}"

echo "=== rebuild-tvm-and-relink ==="
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

# Rebuild the wasm runtime bitcode WITHOUT touching git submodules
cd /opt/mlc-llm-local
rm -rf ./web/dist ./3rdparty/tvm/web/dist

echo "=== Step 1: Build mlc_wasm_runtime ==="
( cd web && make )

echo "=== Step 2: Build TVM web runtime (with current C++ patches) ==="
( cd /opt/mlc-llm-local/3rdparty/tvm/web && TVM_HOME=/opt/mlc-llm-local/3rdparty/tvm make )

echo "=== Step 3: Copy fresh bitcode into the conda tvm package dir ==="
TVM_PY_DIR="$(python -c '"'"'import os, tvm; print(os.path.dirname(tvm.__file__))'"'"')"
mkdir -p "${TVM_PY_DIR}/lib" "${TVM_PY_DIR}/contrib"
cp -f /opt/mlc-llm-local/3rdparty/tvm/web/dist/wasm/wasm_runtime.bc "${TVM_PY_DIR}/wasm_runtime.bc"
cp -f /opt/mlc-llm-local/3rdparty/tvm/web/dist/wasm/wasm_runtime.bc "${TVM_PY_DIR}/lib/wasm_runtime.bc"
cp -f /opt/mlc-llm-local/3rdparty/tvm/web/dist/wasm/tvmjs_support.bc "${TVM_PY_DIR}/tvmjs_support.bc"
cp -f /opt/mlc-llm-local/3rdparty/tvm/web/dist/wasm/tvmjs_support.bc "${TVM_PY_DIR}/lib/tvmjs_support.bc"
cp -f /opt/mlc-llm-local/3rdparty/tvm/web/dist/wasm/webgpu_runtime.bc "${TVM_PY_DIR}/webgpu_runtime.bc"
cp -f /opt/mlc-llm-local/3rdparty/tvm/web/dist/wasm/webgpu_runtime.bc "${TVM_PY_DIR}/lib/webgpu_runtime.bc"
cp -f /opt/mlc-llm-local/3rdparty/tvm/python/tvm/contrib/emcc.py "${TVM_PY_DIR}/contrib/emcc.py" || true

echo "=== Step 4: Compile model wasm with new TVM runtime ==="
cd /repo-root/mlc-packaging
source "${CONFIG_PATH}"

WASM_DIR="../mlc-models/${OUTPUT_MODEL_ID}/package/libs"
mkdir -p "${WASM_DIR}"

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
