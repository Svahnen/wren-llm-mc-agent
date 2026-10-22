#!/usr/bin/env bash
# OPS5: supervised wren.json writer. Usage: run-writer.sh start | status | run   (stop: stop-writer.sh)
set -u
SELF="$(readlink -f "$0")"; D="$(dirname "$SELF")"; cd "$D/.."
PIDF=map-addon/run/writer.pid LOG=map-addon/run/writer.log
mkdir -p map-addon/run
is_sup() { local p; p=$(cat "$PIDF" 2>/dev/null) && [[ -n "$p" ]] && grep -qa 'run-writer.sh' "/proc/$p/cmdline" 2>/dev/null; }
case "${1:-status}" in
start) is_sup && { echo "already running (pid $(cat $PIDF))"; exit 0; }
  nohup setsid "$SELF" run >> "$LOG" 2>&1 < /dev/null &
  sleep 1.5; is_sup && echo "writer supervisor pid $(cat $PIDF)" || { echo "failed, see $LOG"; exit 1; } ;;
status) is_sup && echo "running pid $(cat $PIDF)" || echo "not running" ;;
run) echo $$ > "$PIDF"; child=0; stopping=0
  trap 'stopping=1; [[ $child -gt 0 ]] && kill -TERM $child 2>/dev/null' TERM INT
  while [[ $stopping -eq 0 ]]; do
    node --no-warnings map-addon/tools/write-wren-json.mjs >> "$LOG" 2>&1 < /dev/null & child=$!
    wait $child; [[ $stopping -eq 1 ]] && break
    echo "$(date -u +%FT%TZ) writer exited; restart in 5s" >> "$LOG"; sleep 5
  done; rm -f "$PIDF" ;;
esac
