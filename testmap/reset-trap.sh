#!/bin/bash
# reset-trap.sh <name> : rebuild one trap cell from scratch (does not touch other cells or the gamerules).
set -euo pipefail; [ $# -eq 1 ] || { echo "usage: reset-trap.sh <name>" >&2; exit 2; }
exec "$(dirname "$0")/build-trapmap.sh" "$1" --no-rules
