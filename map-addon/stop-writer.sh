#!/usr/bin/env bash
# OPS5: stop the wren.json writer supervisor (and its node child via TERM trap).
cd "$(dirname "$(readlink -f "$0")")/.."
p=$(cat map-addon/run/writer.pid 2>/dev/null) || { echo "not running"; exit 0; }
grep -qa 'run-writer.sh' "/proc/$p/cmdline" 2>/dev/null || { echo "not running"; rm -f map-addon/run/writer.pid; exit 0; }
kill -TERM "$p"; for _ in $(seq 1 50); do kill -0 "$p" 2>/dev/null || { echo stopped; exit 0; }; sleep 0.2; done; echo "still running $p"; exit 1
