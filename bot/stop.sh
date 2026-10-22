#!/usr/bin/env bash
# Graceful stop (SIGTERM), wait up to 15 s. Only signals the pid in runtime/bot.pid if it is really src/main.js.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
[[ -f runtime/bot.pid ]] || { echo "not running (no pid file)"; exit 0; }
pid=$(cat runtime/bot.pid)
if ! grep -qa 'src/main.js' "/proc/$pid/cmdline" 2>/dev/null; then echo "stale pid file"; rm -f runtime/bot.pid; exit 0; fi
kill -TERM "$pid"
for _ in $(seq 1 75); do
  kill -0 "$pid" 2>/dev/null || { echo "stopped"; rm -f runtime/bot.pid; exit 0; }
  sleep 0.2
done
echo "still running after 15 s (pid $pid); not forcing"; exit 1
