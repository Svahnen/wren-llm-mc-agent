#!/usr/bin/env bash
# Serves report/out read-only on ${REPORT_BIND:-127.0.0.1}:8890 (set REPORT_BIND=0.0.0.0 to open it to your LAN).  report/serve.sh [start|stop|status]   (pid in report/run/serve.pid)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; RUN="$HERE/run"; PIDF="$RUN/serve.pid"
PORT="${REPORT_PORT:-8890}"; LAN_IP="${REPORT_LAN_IP:-127.0.0.1}"
mkdir -p "$RUN" "$HERE/out"
alive() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }
case "${1:-start}" in
  stop) if alive; then kill -TERM "$(cat "$PIDF")"; sleep 0.5; fi; rm -f "$PIDF"; echo stopped ;;
  status) alive && echo "running pid $(cat "$PIDF"): http://$LAN_IP:$PORT/report.html" || echo "not running" ;;
  start)
    if alive; then echo "already running pid $(cat "$PIDF")"; else
      setsid nohup node "$HERE/serve.mjs" --host "${REPORT_BIND:-127.0.0.1}" --port "$PORT" --root "$HERE/out" >> "$RUN/serve.log" 2>&1 < /dev/null &
      echo $! > "$PIDF"; sleep 1
      alive || { echo "failed to start, see $RUN/serve.log"; rm -f "$PIDF"; exit 1; }
    fi
    echo "http://$LAN_IP:$PORT/report.html" ;;
  *) echo "usage: serve.sh [start|stop|status]"; exit 2 ;;
esac
