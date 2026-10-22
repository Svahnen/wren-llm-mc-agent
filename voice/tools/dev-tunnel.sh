#!/usr/bin/env bash
# Second (dev) tunnel for a parallel voice instance: local 19541->box TTS 19411, 19542->STT 19412, 19543->Parakeet 19413. pid in runtime2/tunnel2.pid
set -u
R="$(dirname "$(readlink -f "$0")")/../runtime2"; mkdir -p "$R"
if [ "${1:-}" = stop ]; then p=$(cat "$R/tunnel2.pid" 2>/dev/null); [ -n "$p" ] && grep -qa 'ssh' "/proc/$p/cmdline" 2>/dev/null && kill -TERM "$p" && echo stopped; exit 0; fi
nohup ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:19541:127.0.0.1:19411 -L 127.0.0.1:19542:127.0.0.1:19412 -L 127.0.0.1:19543:127.0.0.1:19413 "${GPU_BOX:?set GPU_BOX=user@YOUR_AI_SERVER}" > "$R/tunnel2.log" 2>&1 < /dev/null &
echo $! > "$R/tunnel2.pid"; sleep 2; curl -s -m3 http://127.0.0.1:19543/health; echo
