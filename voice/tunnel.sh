#!/usr/bin/env bash
# Supervised SSH tunnel PC 127.0.0.1:19411 (TTS), :19412 (stream STT) and :19413 (Parakeet second pass) -> box 127.0.0.1 same ports. Reconnect loop like scripts/tunnel-start.sh.
# Usage: tunnel.sh (start detached, idempotent) | tunnel.sh run (the loop) | tunnel.sh stop
set -u
ROOT="$(dirname "$(readlink -f "$0")")"; RT="$ROOT/runtime"; mkdir -p "$RT" "$ROOT/logs"
HOST="${GPU_BOX:?set GPU_BOX=user@YOUR_AI_SERVER}"; PIDF="$RT/tunnel.pid"; LOG="$ROOT/logs/tunnel.log"
is_loop() { local p; p=$(cat "$PIDF" 2>/dev/null) && [ -n "$p" ] && grep -qa 'voice/tunnel.sh' "/proc/$p/cmdline" 2>/dev/null; }
case "${1:-}" in
stop) if is_loop; then kill -TERM "$(cat "$PIDF")"; echo "tunnel stopping"; else echo "tunnel not running"; fi; exit 0;;
run) ;;
*) if is_loop; then echo "tunnel loop already running (pid $(cat "$PIDF"))"; exit 0; fi
   nohup setsid "$ROOT/tunnel.sh" run >> "$LOG" 2>&1 < /dev/null &
   sleep 2; if is_loop; then echo "tunnel loop started pid $(cat "$PIDF")"; else echo "failed, see $LOG"; exit 1; fi; exit 0;;
esac
echo $$ > "$PIDF"; child=0; stopping=0
trap 'stopping=1; [ $child -gt 0 ] && kill -TERM $child 2>/dev/null' TERM INT
delay=2
while [ $stopping -eq 0 ]; do
  t0=$(date +%s); echo "$(date -u +%FT%TZ) ssh start" >> "$LOG"
  ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o ConnectTimeout=10 \
      -L 127.0.0.1:19411:127.0.0.1:19411 -L 127.0.0.1:19412:127.0.0.1:19412 -L 127.0.0.1:19413:127.0.0.1:19413 "$HOST" >> "$LOG" 2>&1 < /dev/null &
  child=$!; wait $child; code=$?; while kill -0 $child 2>/dev/null; do wait $child; done; child=0
  [ $stopping -eq 1 ] && break
  up=$(( $(date +%s) - t0 )); echo "$(date -u +%FT%TZ) ssh exited code=$code after ${up}s; retry in ${delay}s" >> "$LOG"
  [ $up -ge 60 ] && delay=2
  for _ in $(seq 1 "$delay"); do [ $stopping -eq 1 ] && break; sleep 1; done
  delay=$((delay*2)); [ $delay -gt 30 ] && delay=30
done
rm -f "$PIDF"; echo "$(date -u +%FT%TZ) tunnel loop exit" >> "$LOG"
