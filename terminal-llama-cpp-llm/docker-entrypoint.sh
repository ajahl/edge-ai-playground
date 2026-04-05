#!/bin/sh
set -eu

mkdir -p "${MODELS_DIR:-/models}"

exec node tui.mjs "$@"
