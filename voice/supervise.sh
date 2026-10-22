#!/usr/bin/env bash
# Restart supervisor for the voice service (src/main.js). Usage: supervise.sh start | stop | status | run
set -u
SELF="$(readlink -f "$0")"; cd "$(dirname "$SELF")"; mkdir -p runtime logs
PIDF=runtime/voice-supervisor.pid LOG=logs/supervisor.log
is_sup() { local p; p=$(cat "$PIDF" 2>/dev/null) && [[ -n "$p" ]] && grep -qa 'voice/supervise.sh' "/proc/$p/cmdline" 2>/dev/null; }
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
case "${1:-status}" in
start) if is_sup; then echo "voice supervisor already running (pid $(cat $PIDF))"; exit 0; fi
  nohup setsid "$SELF" run >> "$LOG" 2>&1 < /dev/null &
  sleep 2; if is_sup; then echo "voice supervisor started pid $(cat $PIDF)"; else echo "failed, see $LOG"; exit 1; fi ;;
stop) if ! is_sup; then echo "voice supervisor not running"; rm -f "$PIDF"; exit 0; fi
  p=$(cat "$PIDF"); kill -TERM "$p"; for _ in $(seq 1 100); do kill -0 "$p" 2>/dev/null || { echo "voice supervisor stopped"; exit 0; }; sleep 0.2; done; echo "still running (pid $p)"; exit 1 ;;
status) if is_sup; then echo "voice supervisor pid $(cat $PIDF), service $(cat runtime/voice.pid 2>/dev/null || echo none)"; else echo "voice supervisor not running"; fi ;;
run) echo $$ > "$PIDF"; stopping=0 child=0; delay=2
  trap 'stopping=1; [[ $child -gt 0 ]] && kill -TERM $child 2>/dev/null' TERM INT
  log "voice supervisor start pid $$"
  while [[ $stopping -eq 0 ]]; do
    t0=$(date +%s)
    node src/main.js >> logs/stdout.log 2>&1 < /dev/null & child=$!; echo $child > runtime/voice.pid
    wait $child; code=$?; while kill -0 $child 2>/dev/null; do wait $child; code=$?; done; child=0
    [[ $stopping -eq 1 || $code -eq 0 ]] && { log "child ended code=$code; exit"; break; }
    up=$(( $(date +%s) - t0 )); log "voice service CRASHED code=$code after ${up}s; restart in ${delay}s"
    [[ $up -ge 300 ]] && delay=2
    for _ in $(seq 1 $delay); do [[ $stopping -eq 1 ]] && break; sleep 1; done
    delay=$((delay*2)); [[ $delay -gt 60 ]] && delay=60
  done
  rm -f "$PIDF" runtime/voice.pid; log "voice supervisor exit" ;;
*) echo "usage: $0 start|stop|status|run" >&2; exit 2 ;;
esac
