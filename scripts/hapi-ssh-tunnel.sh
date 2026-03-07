#!/usr/bin/env bash
set -euo pipefail

# Open local SSH tunnel to a remote HAPI hub.
# Run this script on the client device that will open http://localhost:<local_port>.
# Usage:
#   ./scripts/hapi-ssh-tunnel.sh user@server
#   ./scripts/hapi-ssh-tunnel.sh user@server 3006 3006
#
# Args:
#   1: SSH target (required)
#   2: local port (default: 3006)
#   3: remote hub port (default: 3006)

TARGET="${1:-}"
LOCAL_PORT="${2:-3006}"
REMOTE_PORT="${3:-3006}"

if [ -z "$TARGET" ]; then
    echo "usage: $0 <user@host> [local_port] [remote_hub_port]" >&2
    exit 1
fi

echo "[hapi-ssh-tunnel] forwarding localhost:${LOCAL_PORT} -> ${TARGET}:127.0.0.1:${REMOTE_PORT}"
echo "[hapi-ssh-tunnel] open: http://localhost:${LOCAL_PORT}"

action=(ssh -N -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" "$TARGET")
echo "[hapi-ssh-tunnel] cmd: ${action[*]}"
exec "${action[@]}"
