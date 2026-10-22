#!/bin/bash
# teleport-to-trap.sh <name> [--kit] : teleport Wren (only Wren) to the start position of a trap.
# --kit : first clears Wren's inventory (keepInventory is on, so tests can re-kit) then gives iron pickaxe, 64 cobblestone, shears, iron sword.
set -euo pipefail; . "$(dirname "$0")/lib.sh"; need_server
[ $# -ge 1 ] || { echo "usage: teleport-to-trap.sh <name> [--kit]  (names: $(GEN names))" >&2; exit 2; }
read -r X Y Z YAW < <(GEN start "$1")
T0="$(date -u +%Y-%m-%dT%H:%M:%S)"; send "list"
for i in $(seq 1 20); do   # wait for the `list` answer (log lines newer than T0)
  L="$(podman logs --since "$T0" "$CT" 2>&1 | grep -E "players online" | tail -1)"; [ -n "$L" ] && break; sleep 0.3
done
grep -qw Wren <<<"$L" || { echo "Wren is not online" >&2; exit 1; }
if [ "${2:-}" = "--kit" ]; then
  send "clear Wren"; send "give Wren minecraft:iron_pickaxe"; send "give Wren minecraft:cobblestone 64"
  send "give Wren minecraft:shears"; send "give Wren minecraft:iron_sword"
fi
send "tp Wren $X $Y $Z $YAW 0"
sleep 0.5; podman logs --since "$T0" "$CT" 2>&1 | grep -E "Teleported Wren" | tail -1 || true
echo "Wren -> $1 at $X $Y $Z"
