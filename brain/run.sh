#!/usr/bin/env bash
# Start the brain host detached. pid in runtime/brain.pid, output in logs/stdout.log. Env: BRAIN_PORT (19500), BRAIN_LLM (real|fake:random|fake:same|...), S2_BASE_URL; BRAIN_TOKEN is generated into brain/secrets.env on first run
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
mkdir -p runtime logs
# First run: generate BRAIN_TOKEN into brain/secrets.env (mode 600). The brain API refuses every request without it; the bot reads the same file.
if [ -z "${BRAIN_TOKEN:-}" ] && ! grep -qs '^BRAIN_TOKEN=.' secrets.env; then
  ( umask 077; touch secrets.env; sed -i '/^BRAIN_TOKEN=$/d' secrets.env; printf 'BRAIN_TOKEN=%s\n' "$(openssl rand -hex 24)" >> secrets.env ); chmod 600 secrets.env
  echo "created BRAIN_TOKEN in $(pwd)/secrets.env"
fi
if [[ -f runtime/brain.pid ]] && pid=$(cat runtime/brain.pid) && grep -qa 'server.js' "/proc/$pid/cmdline" 2>/dev/null; then echo "already running (pid $pid)"; exit 0; fi
nohup setsid node server.js >> logs/stdout.log 2>&1 < /dev/null &
echo "$!" > runtime/brain.pid
sleep 1
if grep -qa 'server.js' "/proc/$(cat runtime/brain.pid)/cmdline" 2>/dev/null; then echo "started pid $(cat runtime/brain.pid)"; else echo "failed to start, see logs/stdout.log"; exit 1; fi
