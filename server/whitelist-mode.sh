#!/bin/bash
# Usage: whitelist-mode.sh on|off   One-line switch for the whitelist (default off).
# Writes data/.whitelist-mode (read by start.sh), edits data/server.properties, and applies live if the container runs. whitelist.json is untouched (use whitelist-set.sh).
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)/data"; m="${1:-}"; [[ "$m" == on || "$m" == off ]] || { echo "usage: $0 on|off" >&2; exit 2; }
v=false; [ "$m" = on ] && v=true
echo "$m" > "$D/.whitelist-mode"
[ -f "$D/server.properties" ] && sed -i -e "s/^white-list=.*/white-list=$v/" -e "s/^enforce-whitelist=.*/enforce-whitelist=$v/" "$D/server.properties"
timeout 20 podman exec wren-mc mc-send-to-console "whitelist $m" 2>/dev/null && echo "applied live" || echo "(container not running; applies on next start)"
echo "whitelist $m"
