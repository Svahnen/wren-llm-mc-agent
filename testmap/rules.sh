#!/bin/bash
# rules.sh on|off : test-run gamerules from traps.json (keepInventory, no mob spawning, no fire tick, fixed day/clear).
# off restores the vanilla defaults (checked at install time: all were vanilla before the first `on`).
# NOTE: gamerules are per world, so they also affect anything else played on the test server while on.
set -euo pipefail; . "$(dirname "$0")/lib.sh"; need_server
case "${1:-}" in
  on)  for kv in keepInventory=true doMobSpawning=false doFireTick=false doDaylightCycle=false doWeatherCycle=false; do send "gamerule ${kv%%=*} ${kv#*=}"; done
       send "time set day"; send "weather clear"; echo "test gamerules ON";;
  off) for kv in keepInventory=false doMobSpawning=true doFireTick=true doDaylightCycle=true doWeatherCycle=true; do send "gamerule ${kv%%=*} ${kv#*=}"; done
       echo "gamerules restored to vanilla defaults";;
  *) echo "usage: rules.sh on|off" >&2; exit 2;;
esac
