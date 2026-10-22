#!/usr/bin/env bash
# Supervisor for the brain host (server.js) wired to the SSH tunnel endpoint (S2_BASE_URL default http://127.0.0.1:19400/v1, see scripts/tunnel-start.sh).
# Restart with backoff 2..60 s; clean exit (SIGTERM through stop) ends it. Usage: supervise.sh start | stop | status | run
# Env: BRAIN_PORT (19500), BRAIN_LLM (real|fake:random|...), S2_BASE_URL, BRAIN_LOG_DIR, BRAIN_TOKEN.
set -u
SELF="$(readlink -f "$0")"
cd "$(dirname "$SELF")"
mkdir -p runtime logs
# First run: generate BRAIN_TOKEN into brain/secrets.env (mode 600). The brain API refuses every request without it; the bot reads the same file.
if [ -z "${BRAIN_TOKEN:-}" ] && ! grep -qs '^BRAIN_TOKEN=.' secrets.env; then
  ( umask 077; touch secrets.env; sed -i '/^BRAIN_TOKEN=$/d' secrets.env; printf 'BRAIN_TOKEN=%s\n' "$(openssl rand -hex 24)" >> secrets.env ); chmod 600 secrets.env
  echo "created BRAIN_TOKEN in $(pwd)/secrets.env"
fi
PIDF=runtime/brain-supervisor.pid LOG=logs/supervisor.log
export S2_BASE_URL="${S2_BASE_URL:-http://127.0.0.1:19400/v1}"
# SEC1 (LOW 14): clean child env. Only these names pass (no CLAUDE_CODE_*, tokens of other tools, session vars); everything else is dropped by env -i.
CLEAN_RE='^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TZ|TMPDIR|XDG_RUNTIME_DIR|NODE_[A-Z_]+|WREN_[A-Z0-9_]+|MINDLINK_[A-Z0-9_]+|BOT_[A-Z0-9_]+|TRACE_ECHO|BRAIN_[A-Z0-9_]+|S2_[A-Z0-9_]+|MIND_[A-Z0-9_]+|VOICE_[A-Z0-9_]+|H1_DEBUG)$'
clean_env() { local n; CLEAN=(); while IFS= read -r -d '' kv; do n="${kv%%=*}"; [[ "$n" =~ $CLEAN_RE ]] && CLEAN+=("$kv"); done < <(env -0); }
is_sup() { local p; p=$(cat "$PIDF" 2>/dev/null) && [[ -n "$p" ]] && grep -qa 'brain/supervise.sh\|supervise.sh run' "/proc/$p/cmdline" 2>/dev/null; }
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
case "${1:-status}" in
start) if is_sup; then echo "already running (pid $(cat $PIDF))"; exit 0; fi
  nohup setsid "$SELF" run >> "$LOG" 2>&1 < /dev/null &
  sleep 2; if is_sup; then echo "brain supervisor started pid $(cat $PIDF)"; else echo "failed, see $LOG"; exit 1; fi ;;
stop) if ! is_sup; then echo "not running"; rm -f "$PIDF"; exit 0; fi
  p=$(cat "$PIDF"); kill -TERM "$p"; for _ in $(seq 1 100); do kill -0 "$p" 2>/dev/null || { echo "stopped"; exit 0; }; sleep 0.2; done; echo "still running (pid $p)"; exit 1 ;;
status) if is_sup; then echo "brain supervisor pid $(cat $PIDF), child $(cat runtime/brain.pid 2>/dev/null || echo none)"; else echo "not running"; fi
  curl -s -m 3 "http://127.0.0.1:${BRAIN_PORT:-19500}/status" | cut -c1-300; echo ;;
run) echo $$ > "$PIDF"; stopping=0 child=0; delay=2
  trap 'stopping=1; [[ $child -gt 0 ]] && kill -TERM $child 2>/dev/null' TERM INT
  log "brain supervisor start pid $$ S2_BASE_URL=$S2_BASE_URL llm=${BRAIN_LLM:-real}"
  while [[ $stopping -eq 0 ]]; do
    t0=$(date +%s)
    clean_env; env -i "${CLEAN[@]}" node server.js >> logs/stdout.log 2>&1 < /dev/null & child=$!; echo $child > runtime/brain.pid
    wait $child; code=$?; while kill -0 $child 2>/dev/null; do wait $child; code=$?; done; child=0
    [[ $stopping -eq 1 || $code -eq 0 ]] && { log "child ended code=$code; exit"; break; }
    up=$(( $(date +%s) - t0 )); log "brain CRASHED code=$code after ${up}s; restart in ${delay}s"
    [[ $up -ge 300 ]] && delay=2
    for _ in $(seq 1 $delay); do [[ $stopping -eq 1 ]] && break; sleep 1; done
    delay=$((delay*2)); [[ $delay -gt 60 ]] && delay=60
  done
  rm -f "$PIDF" runtime/brain.pid; log "brain supervisor exit" ;;
*) echo "usage: $0 start|stop|status|run" >&2; exit 2 ;;
esac
