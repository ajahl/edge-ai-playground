#!/bin/bash
set -euxo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="/repo-root/custom-mlc-packaging"
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
ARTIFACTS_DIR="${ARTIFACTS_DIR:-./artifacts}"
SOURCE_DIR="${SOURCE_DIR:-${ARTIFACTS_DIR}/source}"
CONVERTED_DIR="${CONVERTED_DIR:-${ARTIFACTS_DIR}/converted}"
PACKAGE_DIR="${PACKAGE_DIR:-${ARTIFACTS_DIR}/package}"
WASM_DIR="${WASM_DIR:-${PACKAGE_DIR}/libs}"

source /opt/conda/etc/profile.d/conda.sh
conda activate mlc
source /opt/emsdk/emsdk_env.sh

if [[ -d "/opt/mlc-llm-local" ]]; then
  export MLC_LLM_SOURCE_DIR="/opt/mlc-llm-local"
  export TVM_SOURCE_DIR="/opt/mlc-llm-local/3rdparty/tvm"
fi

bash "${WORK_DIR}/run.sh"
