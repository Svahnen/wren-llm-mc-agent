#!/usr/bin/env bash
# RUNS ON THE GPU BOX. Stops only our Parakeet process (pid file, cmdline checked).
RUN="$HOME/wren/voice/run"; p=$(cat "$RUN/parakeet.pid" 2>/dev/null)
if [ -n "$p" ] && grep -qa stt_parakeet_server "/proc/$p/cmdline" 2>/dev/null; then kill -TERM "$p"; echo "stopped $p"; else echo "not running"; fi
