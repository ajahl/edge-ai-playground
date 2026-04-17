#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MLC_LLM_GIT_URL="${MLC_LLM_GIT_URL:-}"
MLC_LLM_GIT_REF="${MLC_LLM_GIT_REF:-}"
IMAGE_TAG="${IMAGE_TAG:-custom-mlc-packaging}"

echo "Building Docker image: ${IMAGE_TAG}"
if [[ -n "${MLC_LLM_GIT_URL}" ]]; then
  echo "  mlc-llm git URL: ${MLC_LLM_GIT_URL}"
  if [[ -n "${MLC_LLM_GIT_REF}" ]]; then
    echo "  mlc-llm git ref: ${MLC_LLM_GIT_REF}"
  fi
else
  echo "  Using image-bundled nightly MLC packages."
  echo "  Recommended workflow: mount your patched local mlc-llm checkout at runtime via docker-run.sh."
fi

docker build \
  --build-arg "MLC_LLM_GIT_URL=${MLC_LLM_GIT_URL}" \
  --build-arg "MLC_LLM_GIT_REF=${MLC_LLM_GIT_REF}" \
  -t "${IMAGE_TAG}" \
  "${SCRIPT_DIR}"
