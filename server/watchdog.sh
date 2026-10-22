#!/bin/bash
# Supervisor: restarts wren-mc via start.sh when it is down, even after a clean exit 0 (e.g. "Exception ticking world").
# Usage: ./watchdog.sh start|stop|status      (loop itself: ./watchdog.sh run)
# Respects server/.intentional-stop (written by stop.sh, cleared by start.sh). Backoff: max 5 restarts per 10 min, then waits 10 min.
set -u
D="$(cd "$(dirname "$0")" && pwd)"; NAME=wren-mc
PID="$D/.watchdog.pid"; LOG="$D/watchdog.log"; MARK="$D/.intentional-stop"
log(){ echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
running(){ [ "$(timeout 20 podman inspect -f '{{.State.Running}}' $NAME 2>/dev/null)" = true ]; }
run(){
  echo $$ > "$PID"; trap 'rm -f "$PID"; exit 0' TERM INT; log "watchdog up pid $$"
  local hist=() down=0 now t cr h2
  while true; do
    sleep 15 & wait $!
    if running || [ -e "$MARK" ]; then down=0; continue; fi
    down=$((down+1)); [ $down -lt 2 ] && continue   # down on 2 consecutive polls (avoids racing a manual start.sh)
    now=$(date +%s); h2=(); for t in "${hist[@]}"; do [ $((now-t)) -lt 600 ] && h2+=("$t"); done; hist=("${h2[@]}")
    if [ "${#hist[@]}" -ge 5 ]; then log "5 restarts in 10 min, backing off 10 min"; sleep 600; hist=(); continue; fi
    exec 9>"$D/.lifecycle.lock"; flock -w 180 9
    if running || [ -e "$MARK" ]; then flock -u 9; down=0; continue; fi
    cr=$(ls -t "$D"/data/crash-reports/*.txt 2>/dev/null | head -1)
    log "container down (exit $(timeout 20 podman inspect -f '{{.State.ExitCode}}' $NAME 2>&1), latest crash report: ${cr:-none}); starting"
    LOCK_HELD=1 timeout 300 "$D/start.sh" >> "$LOG" 2>&1 && log "start.sh ok" || log "start.sh FAILED"
    flock -u 9; hist+=("$(date +%s)"); down=0; sleep 60
  done
}
case "${1:-}" in
  run) run;;
  start) if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then echo "already running pid $(cat "$PID")"; else nohup setsid "$0" run >/dev/null 2>&1 & sleep 1; echo "started pid $(cat "$PID" 2>/dev/null)"; fi;;
  stop) [ -f "$PID" ] && kill "$(cat "$PID")" && echo stopped || echo "not running";;
  status) [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null && echo "running pid $(cat "$PID")" || echo "not running";;
  *) echo "usage: $0 start|stop|status"; exit 1;;
esac
