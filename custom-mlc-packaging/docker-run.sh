#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-custom-mlc-packaging}"
DEFAULT_MLC_LLM_DIR="$(cd "${SCRIPT_DIR}/../mlc-llm" 2>/dev/null && pwd || true)"
source "${SCRIPT_DIR}/config-selector.sh"

CONFIG_PATH="$(resolve_config_path "${1:-${CONFIG_PATH:-}}")"
if [[ "${CONFIG_PATH}" != "${SCRIPT_DIR}"/* ]]; then
  echo "Config path must live inside ${SCRIPT_DIR}: ${CONFIG_PATH}" >&2
  exit 1
fi
RELATIVE_CONFIG_PATH="${CONFIG_PATH#${SCRIPT_DIR}/}"

HF_TOKEN_ARG=()
if [[ -n "${HF_TOKEN:-}" ]]; then
  HF_TOKEN_ARG=(-e "HF_TOKEN=${HF_TOKEN}")
fi

MLC_LLM_MOUNT_ARGS=()
if [[ -n "${MLC_LLM_LOCAL_DIR:-}" ]]; then
  MLC_LLM_MOUNT_ARGS=(-v "${MLC_LLM_LOCAL_DIR}:/opt/mlc-llm-local")
elif [[ -n "${DEFAULT_MLC_LLM_DIR}" && -d "${DEFAULT_MLC_LLM_DIR}" ]]; then
  MLC_LLM_MOUNT_ARGS=(-v "${DEFAULT_MLC_LLM_DIR}:/opt/mlc-llm-local")
fi

docker_args=(
  run
  --rm
  -it
)
if [[ "${#HF_TOKEN_ARG[@]}" -gt 0 ]]; then
  docker_args+=("${HF_TOKEN_ARG[@]}")
fi
if [[ "${#MLC_LLM_MOUNT_ARGS[@]}" -gt 0 ]]; then
  docker_args+=("${MLC_LLM_MOUNT_ARGS[@]}")
fi
docker_args+=(
  -e "CONFIG_PATH=/repo-root/custom-mlc-packaging/${RELATIVE_CONFIG_PATH}"
  -v "${REPO_ROOT}:/repo-root"
  -w /repo-root/custom-mlc-packaging
  "${IMAGE_TAG}"
  "source /opt/conda/etc/profile.d/conda.sh && conda activate mlc && if [ -d /opt/mlc-llm-local ]; then export MLC_LLM_SOURCE_DIR=/opt/mlc-llm-local; git config --global --add safe.directory /opt/mlc-llm-local; python -m pip install /opt/mlc-llm-local --no-build-isolation; fi && cd /repo-root/custom-mlc-packaging && bash ./run.sh"
)

docker "${docker_args[@]}"
