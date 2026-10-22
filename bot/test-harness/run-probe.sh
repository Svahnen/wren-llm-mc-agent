#!/bin/bash
# Runs probe.mjs only if no Wren session is connected (a duplicate login would kick the other bot).
set -euo pipefail; cd "$(dirname "$0")/.."
T0="$(date -u +%Y-%m-%dT%H:%M:%S)"; podman exec wren-mc mc-send-to-console list; sleep 1
podman logs --since "$T0" wren-mc 2>&1 | grep "players online" | tail -1 | grep -qw Wren && { echo "Wren already online, refusing" >&2; exit 1; }
exec node test-harness/probe.mjs "$@"
