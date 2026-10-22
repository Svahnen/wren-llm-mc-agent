#!/usr/bin/env bash
# Supervised SSH tunnel 127.0.0.1:19400 -> box 127.0.0.1:19400 (ServerAlive, auto-reconnect loop). pid file runtime/tunnel.pid (the loop's pid).
# Usage: tunnel-start.sh   (starts detached)  |  tunnel-start.sh run   (the loop itself)
set -u
ROOT="$(dirname "$(dirname "$(readlink -f "$0")")")"; RT="$ROOT/runtime"; mkdir -p "$RT" "$ROOT/logs"
HOST="${GPU_BOX:?set GPU_BOX=user@YOUR_AI_SERVER}"; LPORT="${TUNNEL_LOCAL_PORT:-19400}"; RPORT="${S2_PORT:-19400}"
PIDF="$RT/tunnel.pid"; LOG="$ROOT/logs/tunnel.log"
is_loop() { local p; p=$(cat "$PIDF" 2>/dev/null) && [ -n "$p" ] && grep -qa 'tunnel-start.sh' "/proc/$p/cmdline" 2>/dev/null; }
if [ "${1:-}" != run ]; then
  if is_loop; then echo "tunnel loop already running (pid $(cat "$PIDF"))"; exit 0; fi
  nohup setsid "$(readlink -f "$0")" run >> "$LOG" 2>&1 < /dev/null &
  sleep 2; if is_loop; then echo "tunnel loop started pid $(cat "$PIDF")"; else echo "failed, see $LOG"; exit 1; fi; exit 0
fi
echo $$ > "$PIDF"; child=0; stopping=0
trap 'stopping=1; [ $child -gt 0 ] && kill -TERM $child 2>/dev/null' TERM INT
delay=2
while [ $stopping -eq 0 ]; do
  t0=$(date +%s)
  echo "$(date -u +%FT%TZ) ssh start" >> "$LOG"
  ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o ConnectTimeout=10 \
      -L "127.0.0.1:$LPORT:127.0.0.1:$RPORT" "$HOST" >> "$LOG" 2>&1 < /dev/null &
  child=$!; wait $child; code=$?; while kill -0 $child 2>/dev/null; do wait $child; done; child=0
  [ $stopping -eq 1 ] && break
  up=$(( $(date +%s) - t0 )); echo "$(date -u +%FT%TZ) ssh exited code=$code after ${up}s; retry in ${delay}s" >> "$LOG"
  [ $up -ge 60 ] && delay=2
  for _ in $(seq 1 "$delay"); do [ $stopping -eq 1 ] && break; sleep 1; done
  delay=$((delay*2)); [ $delay -gt 30 ] && delay=30
done
rm -f "$PIDF"; echo "$(date -u +%FT%TZ) tunnel loop exit" >> "$LOG"
