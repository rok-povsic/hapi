#!/usr/bin/env bash
set -euo pipefail

# Start HAPI hub for SSH-only access (no relay).
# Default bind: loopback only.

HAPI_BIN="${HAPI_BIN:-hapi}"
HAPI_PORT="${HAPI_PORT:-3006}"
HAPI_HOST="${HAPI_HOST:-127.0.0.1}"
ENABLE_RUNNER="${ENABLE_RUNNER:-0}"

if ! command -v "$HAPI_BIN" >/dev/null 2>&1; then
    echo "error: hapi binary not found: $HAPI_BIN" >&2
    echo "hint: install with: npm i -g @twsxtd/hapi" >&2
    exit 1
fi

mkdir -p "${HOME}/.hapi/logs"

export HAPI_LISTEN_HOST="$HAPI_HOST"
export HAPI_LISTEN_PORT="$HAPI_PORT"

echo "[hapi-ssh-server] starting hub on http://${HAPI_HOST}:${HAPI_PORT} (no relay)"
if [ "$ENABLE_RUNNER" = "1" ]; then
    echo "[hapi-ssh-server] starting runner in background"
    nohup "$HAPI_BIN" runner start --foreground >"${HOME}/.hapi/logs/runner.log" 2>&1 &
    echo "[hapi-ssh-server] runner pid=$!"
fi

exec "$HAPI_BIN" hub --no-relay
