#!/usr/bin/env bash
# Supervisor for src/main.js.   Usage: supervise.sh start | stop | status | run   (run = foreground loop, used by start)
#  - restarts main.js when it exits abnormally, exponential backoff 2 s .. 120 s (reset after 10 min of stable running)
#  - restart budget: more than 5 crashes within 10 min => stop, write runtime/SUPERVISOR_GAVE_UP
#  - a clean exit (code 0, e.g. SIGTERM through stop.sh) ends the supervisor: stop means stop
#  - pid file runtime/supervisor.pid; log logs/supervisor.log; child stdout/stderr logs/stdout.log; crash history runtime/supervisor.json
#  Env passes through to main.js (BOT_NAME defaults to Wren, MC_HOST 127.0.0.1, MC_PORT 25566 in config.js).
set -u
cd "$(dirname "$(readlink -f "$0")")"
mkdir -p runtime logs
PIDF=runtime/supervisor.pid LOG=logs/supervisor.log GAVEUP=runtime/SUPERVISOR_GAVE_UP STATE=runtime/supervisor.json
is_sup() { local p; p=$(cat "$PIDF" 2>/dev/null) && [[ -n "$p" ]] && grep -qa 'supervise.sh' "/proc/$p/cmdline" 2>/dev/null; }
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

case "${1:-status}" in
start)
  if is_sup; then echo "supervisor already running (pid $(cat $PIDF))"; exit 0; fi
  rm -f "$GAVEUP"
  nohup setsid "$(readlink -f "$0")" run >> "$LOG" 2>&1 < /dev/null &
  sleep 1.5
  if is_sup; then echo "supervisor started pid $(cat $PIDF)"; else echo "supervisor failed to start, see $LOG"; exit 1; fi ;;
stop)
  if ! is_sup; then echo "supervisor not running"; rm -f "$PIDF"; exit 0; fi
  p=$(cat "$PIDF"); kill -TERM "$p"
  for _ in $(seq 1 100); do kill -0 "$p" 2>/dev/null || { echo "supervisor stopped"; exit 0; }; sleep 0.2; done
  echo "supervisor still running after 20 s (pid $p); not forcing"; exit 1 ;;
status)
  if is_sup; then echo "supervisor running pid $(cat $PIDF); child $(cat runtime/bot.pid 2>/dev/null || echo none)"; else echo "supervisor not running"; fi
  [[ -f "$GAVEUP" ]] && { echo "GAVE UP:"; cat "$GAVEUP"; }
  [[ -f "$STATE" ]] && cat "$STATE"; exit 0 ;;
run)
  if is_sup && [[ "$(cat $PIDF)" != "$$" ]]; then echo "already running"; exit 0; fi
  echo $$ > "$PIDF"
  stopping=0 child=0
  on_term() { stopping=1; log "supervisor: TERM received, stopping child $child"; [[ $child -gt 0 ]] && kill -TERM "$child" 2>/dev/null; }
  trap on_term TERM INT
  crashes="" restarts=0 delay=2 total_crashes=0
  log "supervisor: start (pid $$) bot=${BOT_NAME:-Wren}"
  while [[ $stopping -eq 0 ]]; do
    t0=$(date +%s)
    node src/main.js >> logs/stdout.log 2>&1 < /dev/null &
    child=$!
    log "supervisor: child pid $child started (restart #$restarts)"
    wait "$child"; code=$?
    # a trap interrupts `wait`: wait again for the real exit status
    while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done
    child=0
    t1=$(date +%s); up=$((t1 - t0))
    if [[ $stopping -eq 1 ]] || [[ $code -eq 0 ]]; then log "supervisor: child ended code=$code after ${up}s; stopping supervisor"; break; fi
    total_crashes=$((total_crashes + 1))
    # keep crash timestamps of the last 600 s
    keep=""; for t in $crashes; do [[ $((t1 - t)) -le 600 ]] && keep="$keep $t"; done; crashes="$keep $t1"
    n=$(echo $crashes | wc -w)
    log "supervisor: child CRASHED code=$code after ${up}s (crashes in last 10 min: $n, total $total_crashes)"
    echo "{\"t\":\"$(date -u +%FT%TZ)\",\"restarts\":$((restarts + 1)),\"crashes_10min\":$n,\"total_crashes\":$total_crashes,\"last_code\":$code,\"last_uptime_s\":$up}" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    if [[ $n -gt 5 ]]; then
      echo "gave up $(date -u +%FT%TZ): $n crashes within 10 min (last exit code $code); see logs/stdout.log and logs/supervisor.log" > "$GAVEUP"
      log "supervisor: GAVE UP ($n crashes in 10 min)"; break
    fi
    [[ $up -ge 600 ]] && delay=2
    log "supervisor: restart in ${delay}s"
    # interruptible sleep
    for _ in $(seq 1 "$delay"); do [[ $stopping -eq 1 ]] && break; sleep 1; done
    delay=$((delay * 2)); [[ $delay -gt 120 ]] && delay=120
    restarts=$((restarts + 1))
  done
  rm -f "$PIDF"
  log "supervisor: exit" ;;
*) echo "usage: $0 start|stop|status|run" >&2; exit 2 ;;
esac
