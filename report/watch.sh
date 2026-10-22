#!/usr/bin/env bash
# Rebuilds report/out/report.html and the journal every WATCH_INTERVAL seconds (default 600).
#   report/watch.sh              start detached (nohup+setsid), pid in report/run/watch.pid
#   report/watch.sh --foreground run the loop in this shell
#   report/watch.sh --once       one rebuild and exit
# Stop with report/stop-watch.sh. Read-only on bot/mind/brain data; writes only report/out, report/run, docs/journal.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/run"; PIDF="$RUN/watch.pid"; LOGF="$RUN/watch.log"
INTERVAL="${WATCH_INTERVAL:-600}"
mkdir -p "$RUN" "$HERE/out/journal"

rebuild() {
  echo "[$(date '+%F %T')] rebuild"
  node "$HERE/journal.mjs" --copy-to "$HERE/out/journal" 2>&1 || echo "journal failed"
  node "$HERE/build-report.mjs" 2>&1 || echo "report failed"
}

case "${1:-}" in
  --once) rebuild; exit 0 ;;
  --foreground)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null && [ "$(cat "$PIDF")" != "$$" ]; then echo "already running (pid $(cat "$PIDF"))"; exit 1; fi
    echo $$ > "$PIDF"
    trap 'rm -f "$PIDF"; exit 0' TERM INT
    while true; do rebuild; sleep "$INTERVAL" & wait $!; done ;;
  *)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "already running (pid $(cat "$PIDF"))"; exit 0; fi
    WATCH_INTERVAL="$INTERVAL" setsid nohup "$0" --foreground >> "$LOGF" 2>&1 < /dev/null &
    sleep 1; echo "watch started, pid $(cat "$PIDF" 2>/dev/null || echo '?'), log $LOGF, every ${INTERVAL}s" ;;
esac
