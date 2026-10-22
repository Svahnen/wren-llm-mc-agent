#!/usr/bin/env bash
# Stop the tunnel loop (pid from runtime/tunnel.pid, verified) and its ssh child.
ROOT="$(dirname "$(dirname "$(readlink -f "$0")")")"; PIDF="$ROOT/runtime/tunnel.pid"
p=$(cat "$PIDF" 2>/dev/null) || { echo "not running"; exit 0; }
grep -qa 'tunnel-start.sh' "/proc/$p/cmdline" 2>/dev/null || { echo "stale pid file"; rm -f "$PIDF"; exit 0; }
kill -TERM "$p"; for _ in $(seq 40); do kill -0 "$p" 2>/dev/null || { echo "tunnel stopped"; exit 0; }; sleep 0.25; done
echo "still running (pid $p)"; exit 1
