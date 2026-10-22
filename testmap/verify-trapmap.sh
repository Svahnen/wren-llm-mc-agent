#!/bin/bash
# verify-trapmap.sh [name|all] : check a sample (<=150 blocks per trap + all key blocks) of the expected blocks via
# `execute unless block ... run say FAIL`. Exit 0 = all present. Needs the server running; no player needed.
set -euo pipefail; . "$(dirname "$0")/lib.sh"; need_server
WHICH="${1:-all}"; tok="TV$$_$(date +%s)"
GEN verify "$WHICH" "$tok" | send_stdin
send "say $tok DONE_ALL"
wait_token "$tok" 60 || { echo "timeout waiting for verify results" >&2; exit 2; }
sleep 1
LOG="$(podman logs --since 10m "$CT" 2>&1 | grep "$tok" || true)"
FAILS="$(grep -c "$tok FAIL" <<<"$LOG" || true)"
grep "$tok DONE " <<<"$LOG" | sed "s/.*$tok DONE /checked: /"
if [ "$FAILS" -gt 0 ]; then grep "$tok FAIL" <<<"$LOG" | sed 's/.*\] //' | head -20; echo "VERIFY FAILED: $FAILS mismatches"; exit 1; fi
echo "VERIFY OK"
