#!/usr/bin/env bash
# Stops the report watch loop started by report/watch.sh (SIGTERM to the exact pid in report/run/watch.pid).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; PIDF="$HERE/run/watch.pid"
[ -f "$PIDF" ] || { echo "not running (no pid file)"; exit 0; }
PID="$(cat "$PIDF")"
if kill -0 "$PID" 2>/dev/null; then kill -TERM "$PID"; for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done; fi
kill -0 "$PID" 2>/dev/null && { echo "pid $PID still alive"; exit 1; }
rm -f "$PIDF"; echo "stopped"
