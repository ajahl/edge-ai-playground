#!/bin/sh
set -eu

DISPLAY_SERVER_PID=""

cleanup() {
  if [ -n "$DISPLAY_SERVER_PID" ]; then
    kill "$DISPLAY_SERVER_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

mkdir -p "${XDG_RUNTIME_DIR:-/tmp/runtime-root}"
chmod 700 "${XDG_RUNTIME_DIR:-/tmp/runtime-root}" 2>/dev/null || true

dbus-daemon --system --fork 2>/dev/null || true

if [ "${CHROMIUM_HEADLESS:-true}" = "false" ]; then
  if [ "${DISPLAY_BACKEND:-xvfb}" = "xdummy" ]; then
    Xorg "${DISPLAY:-:99}" -noreset -config /app/xorg-dummy.conf +extension GLX +extension RANDR +extension RENDER &
    DISPLAY_SERVER_PID="$!"
  else
    Xvfb "${DISPLAY:-:99}" -screen 0 1920x1080x24 &
    DISPLAY_SERVER_PID="$!"
  fi
fi

if [ "${GPU_WRAPPER:-none}" = "virtualgl" ] && ! command -v vglrun >/dev/null 2>&1; then
  echo "warning: GPU_WRAPPER=virtualgl requested, but vglrun is not installed in this image" >&2
fi

exec node tui.mjs "$@"
