#!/usr/bin/env bash
# Start everything for the Wren voice service, idempotent: (1) Kokoro TTS :19411 + sherpa STT :19412 on the model server,
# (2) supervised SSH tunnel to them, (3) supervised voice service on this machine (HTTP 127.0.0.1:19521, mod WS client -> ws://127.0.0.1:19520).
# Env: GPU_BOX (required, e.g. user@YOUR_AI_SERVER), VOICE_MOD_URL, VOICE_HTTP_PORT, VOICE_VOICE (af_heart), VOICE_BOT_NAME (Wren), VOICE_SPEAK_DISTANCE (16)
set -u
HERE="$(dirname "$(readlink -f "$0")")"; HOST="${GPU_BOX:?set GPU_BOX=user@YOUR_AI_SERVER}"; SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST")
# First run: create voice/secrets.env (chmod 600) with random values. Copy WRENVOICE_SECRET into the mod's wrenvoice.json "secret" if you set it by hand,
# and COMPANION_API_KEY into ~/wren/voice/box.env on the model server (only needed if a speech server is not loopback-only).
if [ ! -f "$HERE/secrets.env" ]; then
  ( umask 077; printf 'VOICE_TOKEN=%s\nWRENVOICE_SECRET=\nCOMPANION_API_KEY=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > "$HERE/secrets.env" )
  echo "created $HERE/secrets.env; set WRENVOICE_SECRET to the value in server/data/config/wrenvoice.json (the mod generated it)"
fi
timeout 30 "${SSH[@]}" 'mkdir -p ~/wren/voice/tts_backends ~/wren/voice/run ~/wren/voice/logs' || { echo "box unreachable"; exit 1; }
timeout 60 scp -q -o BatchMode=yes "$HERE"/box/{tts_server.py,stt_stream_server.py,stt_parakeet_server.py,box-start.sh,box-stop.sh,box-start-parakeet.sh,box-stop-parakeet.sh} "$HOST:wren/voice/" || exit 1
timeout 60 scp -q -o BatchMode=yes "$HERE"/box/tts_backends/*.py "$HOST:wren/voice/tts_backends/" || exit 1
timeout 60 "${SSH[@]}" 'bash ~/wren/voice/box-start.sh all' || exit 1
timeout 60 "${SSH[@]}" 'bash ~/wren/voice/box-start-parakeet.sh' || echo "WARN: Parakeet second pass not started (service keeps the streaming text)"
echo "waiting for box health..."
for i in $(seq 1 40); do
  if timeout 15 "${SSH[@]}" 'curl -sf -m3 http://127.0.0.1:19411/health && curl -sf -m3 http://127.0.0.1:19412/health' >/dev/null 2>&1; then echo "box TTS+STT healthy"; break; fi
  [ "$i" = 40 ] && { echo "box services NOT healthy; see ~/wren/voice/logs on the box" >&2; exit 1; }; sleep 2
done
"$HERE/tunnel.sh" || exit 1
"$HERE/supervise.sh" start
