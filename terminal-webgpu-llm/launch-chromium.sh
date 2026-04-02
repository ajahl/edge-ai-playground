#!/bin/sh
set -eu

CHROMIUM_BIN="${CHROMIUM_EXECUTABLE:-/usr/bin/chromium}"

if [ "${GPU_WRAPPER:-none}" = "virtualgl" ] && command -v vglrun >/dev/null 2>&1; then
  exec vglrun "$CHROMIUM_BIN" "$@"
fi

exec "$CHROMIUM_BIN" "$@"
