#!/usr/bin/env bash
# Start the body detached. pid in runtime/bot.pid, stdout/stderr in logs/stdout.log. Env: MC_HOST MC_PORT BOT_NAME ...
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
mkdir -p runtime logs
if [[ -f runtime/bot.pid ]] && pid=$(cat runtime/bot.pid) && grep -qa 'src/main.js' "/proc/$pid/cmdline" 2>/dev/null; then
  echo "already running (pid $pid)"; exit 0
fi
nohup setsid node src/main.js >> logs/stdout.log 2>&1 < /dev/null &
echo "$!" > runtime/bot.pid
sleep 1
if grep -qa 'src/main.js' "/proc/$(cat runtime/bot.pid)/cmdline" 2>/dev/null; then echo "started pid $(cat runtime/bot.pid)"; else echo "failed to start, see logs/stdout.log"; exit 1; fi
