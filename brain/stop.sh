#!/usr/bin/env bash
# Graceful stop (SIGTERM). Only signals the pid in runtime/brain.pid if it really is server.js.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
[[ -f runtime/brain.pid ]] || { echo "not running (no pid file)"; exit 0; }
pid=$(cat runtime/brain.pid)
if ! grep -qa 'server.js' "/proc/$pid/cmdline" 2>/dev/null; then echo "stale pid file"; rm -f runtime/brain.pid; exit 0; fi
kill -TERM "$pid"
for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || { echo "stopped"; rm -f runtime/brain.pid; exit 0; }; sleep 0.2; done
echo "still running after 10 s (pid $pid); not forcing"; exit 1
