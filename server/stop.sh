#!/bin/bash
# Graceful stop (saves the world) and remove the container. Data stays in server/data.
set -euo pipefail
NAME="wren-mc"
SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
exec 9>"$SERVER_DIR/.lifecycle.lock"; flock -w 180 9
# Marker tells watchdog.sh this stop is intentional (do not auto-restart). start.sh removes it.
date -u +%FT%TZ > "$SERVER_DIR/.intentional-stop"
podman exec "$NAME" mc-send-to-console stop 2>/dev/null || true
podman stop -t 90 "$NAME" 2>/dev/null || true
podman rm "$NAME" 2>/dev/null || true
echo "$NAME stopped."
