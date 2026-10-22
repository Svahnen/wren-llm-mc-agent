#!/usr/bin/env bash
# Supervisor for the mind+brain build (src/mindlink/run.js). Same behaviour as bot/supervise.sh (backoff 2..120 s, give up after >5 crashes in 10 min,
# clean exit ends it), but pid/state files live in $BOT_RUNTIME_DIR (default runtime/) and logs in $BOT_LOG_DIR (default logs/), so a test bot
# (BOT_NAME=WrenT4 with its own dirs) never collides with the real Wren.   Usage: supervise-mind.sh start | stop | status | run
set -u
SELF="$(readlink -f "$0")"
cd "$(dirname "$SELF")/../.."
RT="${BOT_RUNTIME_DIR:-runtime}" LOGD="${BOT_LOG_DIR:-logs}"
# OPS1: optional env file (KEY=VALUE lines, no secrets) sourced by every supervisor invocation; the node child inherits it. Default bot/run.env, override with BOT_ENV_FILE.
ENVF="${BOT_ENV_FILE:-run.env}"; if [[ -f "$ENVF" ]]; then set -a; . "$ENVF"; set +a; fi
# SEC1 (LOW 14): clean child env. Only these names pass (no CLAUDE_CODE_*, tokens of other tools, session vars); everything else is dropped by env -i.
CLEAN_RE='^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TZ|TMPDIR|XDG_RUNTIME_DIR|NODE_[A-Z_]+|WREN_[A-Z0-9_]+|MINDLINK_[A-Z0-9_]+|BOT_[A-Z0-9_]+|TRACE_ECHO|BRAIN_[A-Z0-9_]+|S2_[A-Z0-9_]+|MIND_[A-Z0-9_]+|VOICE_[A-Z0-9_]+|H1_DEBUG)$'
clean_env() { local n; CLEAN=(); while IFS= read -r -d '' kv; do n="${kv%%=*}"; [[ "$n" =~ $CLEAN_RE ]] && CLEAN+=("$kv"); done < <(env -0); }
mkdir -p "$RT" "$LOGD"
PIDF="$RT/supervisor.pid" LOG="$LOGD/supervisor.log" GAVEUP="$RT/SUPERVISOR_GAVE_UP" STATE="$RT/supervisor.json"
is_sup() { local p; p=$(cat "$PIDF" 2>/dev/null) && [[ -n "$p" ]] && grep -qa 'supervise-mind.sh' "/proc/$p/cmdline" 2>/dev/null; }
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
case "${1:-status}" in
start)
  if is_sup; then echo "supervisor already running (pid $(cat $PIDF))"; exit 0; fi
  rm -f "$GAVEUP"
  nohup setsid "$SELF" run >> "$LOG" 2>&1 < /dev/null &
  sleep 1.5
  if is_sup; then echo "supervisor started pid $(cat $PIDF)"; else echo "supervisor failed to start, see $LOG"; exit 1; fi ;;
stop)
  if ! is_sup; then echo "supervisor not running"; rm -f "$PIDF"; exit 0; fi
  p=$(cat "$PIDF"); kill -TERM "$p"
  for _ in $(seq 1 150); do kill -0 "$p" 2>/dev/null || { echo "supervisor stopped"; exit 0; }; sleep 0.2; done
  echo "supervisor still running after 30 s (pid $p); not forcing"; exit 1 ;;
status)
  if is_sup; then echo "supervisor running pid $(cat $PIDF); child $(cat $RT/bot.pid 2>/dev/null || echo none)"; else echo "supervisor not running"; fi
  [[ -f "$GAVEUP" ]] && { echo "GAVE UP:"; cat "$GAVEUP"; }
  [[ -f "$STATE" ]] && cat "$STATE"; exit 0 ;;
run)
  if is_sup && [[ "$(cat $PIDF)" != "$$" ]]; then echo "already running"; exit 0; fi
  echo $$ > "$PIDF"
  stopping=0 child=0
  on_term() { stopping=1; log "supervisor: TERM received, stopping child $child"; [[ $child -gt 0 ]] && kill -TERM "$child" 2>/dev/null; }
  trap on_term TERM INT
  crashes="" restarts=0 delay=2 total_crashes=0
  log "supervisor(mind): start (pid $$) bot=${BOT_NAME:-Wren}"
  while [[ $stopping -eq 0 ]]; do
    t0=$(date +%s)
    clean_env; env -i "${CLEAN[@]}" node src/mindlink/run.js >> "$LOGD/stdout.log" 2>&1 < /dev/null &
    child=$!
    log "supervisor: child pid $child started (restart #$restarts)"
    wait "$child"; code=$?
    while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done
    child=0
    t1=$(date +%s); up=$((t1 - t0))
    if [[ $stopping -eq 1 ]] || [[ $code -eq 0 ]]; then log "supervisor: child ended code=$code after ${up}s; stopping supervisor"; break; fi
    total_crashes=$((total_crashes + 1))
    keep=""; for t in $crashes; do [[ $((t1 - t)) -le 600 ]] && keep="$keep $t"; done; crashes="$keep $t1"
    n=$(echo $crashes | wc -w)
    log "supervisor: child CRASHED code=$code after ${up}s (crashes in last 10 min: $n, total $total_crashes)"
    echo "{\"t\":\"$(date -u +%FT%TZ)\",\"restarts\":$((restarts + 1)),\"crashes_10min\":$n,\"total_crashes\":$total_crashes,\"last_code\":$code,\"last_uptime_s\":$up}" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    if [[ $n -gt 5 ]]; then
      echo "gave up $(date -u +%FT%TZ): $n crashes within 10 min (last exit code $code); see $LOGD/stdout.log and $LOG" > "$GAVEUP"
      log "supervisor: GAVE UP ($n crashes in 10 min)"; break
    fi
    [[ $up -ge 600 ]] && delay=2
    log "supervisor: restart in ${delay}s"
    for _ in $(seq 1 "$delay"); do [[ $stopping -eq 1 ]] && break; sleep 1; done
    delay=$((delay * 2)); [[ $delay -gt 120 ]] && delay=120
    restarts=$((restarts + 1))
  done
  rm -f "$PIDF"
  log "supervisor: exit" ;;
*) echo "usage: $0 start|stop|status|run" >&2; exit 2 ;;
esac
