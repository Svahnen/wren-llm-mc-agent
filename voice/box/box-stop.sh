#!/usr/bin/env bash
# RUNS ON THE GPU BOX. Stops only our TTS/STT processes (pids from ~/wren/voice/run/*.pid, verified by cmdline).
V="$HOME/wren/voice"
for n in tts:tts_server.py stt:stt_stream_server.py; do
  k=${n%%:*}; m=${n##*:}; p=$(cat "$V/run/$k.pid" 2>/dev/null)
  if [ -n "$p" ] && grep -qa "$m" "/proc/$p/cmdline" 2>/dev/null; then kill -TERM "$p"; echo "stopped $k $p"; fi
  rm -f "$V/run/$k.pid"
done
