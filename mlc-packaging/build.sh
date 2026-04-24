#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config-selector.sh"

CONFIG_PATH="$(resolve_config_path "${1:-${CONFIG_PATH:-}}")"
export CONFIG_PATH

echo "Using config: ${CONFIG_PATH}"

echo "Step 1/2: build Docker image"
"${SCRIPT_DIR}/docker-build.sh"

echo "Step 2/2: run packaging workflow"
"${SCRIPT_DIR}/docker-run.sh"
