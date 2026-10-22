#!/bin/bash
# build-trapmap.sh [name|all] [--no-rules] : (re)build trap cells in the sky region at x=10000..10099, z=10000..10039,
# floor top y=200 (see traps.json / README). Idempotent: each cell is wiped (stone slab + air) and rebuilt.
# Only touches the documented region (bounds asserted by trapgen.py). Forceloads the 28 chunks of the region.
set -euo pipefail; . "$(dirname "$0")/lib.sh"; need_server
WHICH="${1:-all}"; RULES=1; [ "${2:-}" = "--no-rules" ] && RULES=0
read -r X1 Z1 X2 Z2 < <(GEN region)
CMDS="$(GEN build "$WHICH")"            # validates the name and all coordinates before anything is sent
[ "$RULES" = 1 ] && "$TM_DIR/rules.sh" on
send "forceload add $X1 $Z1 $X2 $Z2"
tok="TM$$_$(date +%s)"
for i in $(seq 1 60); do   # wait until the region is really loaded
  send "execute if loaded $X1 200 $Z1 if loaded $X2 200 $Z2 run say $tok LOADED" 
  sleep 0.5; podman logs --since 20s "$CT" 2>&1 | grep -q "$tok LOADED" && break
  [ "$i" = 60 ] && { echo "region did not load" >&2; exit 1; }
done
printf '%s\n' "$CMDS" | send_stdin
send "say $tok BUILD_FINISHED"
echo "sent $(printf '%s\n' "$CMDS" | wc -l) commands for '$WHICH'; run ./verify-trapmap.sh $WHICH"
