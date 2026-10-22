#!/usr/bin/env bash
# Stop the voice service, tunnel and (unless KEEP_BOX=1) our TTS/STT on the box. Only pids from pid files.
HERE="$(dirname "$(readlink -f "$0")")"; HOST="${GPU_BOX:?set GPU_BOX=user@YOUR_AI_SERVER}"
"$HERE/supervise.sh" stop
"$HERE/tunnel.sh" stop
[ "${KEEP_BOX:-0}" = 1 ] || timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'bash ~/wren/voice/box-stop.sh'
