#!/usr/bin/env bash
# RUNS ON THE AI SERVER (the machine with the speech models). Starts Kokoro TTS (:19411) and sherpa-onnx streaming STT (:19412), loopback only. Idempotent.
# usage: box-start.sh [tts|stt|all]     Work dir: ~/wren/voice (pid files in run/, logs in logs/).
# Required env (set them in ~/wren/voice/box.env, which this script sources if present):
#   TTS_PYTHON   python of a venv with kokoro + fastapi + uvicorn        (for TTS)
#   STT_PYTHON   python of a venv with sherpa-onnx + fastapi + uvicorn   (for streaming STT)
#   STTS_MODEL_DIR  directory with the sherpa-onnx encoder/decoder/joiner .onnx files and tokens
# Optional: HF_HOME, TTS_DEVICE (cuda|cpu), TTS_VOICE (af_heart), STTS_KIND (nemo|zipformer), COMPANION_API_KEY
set -u
WHAT="${1:-all}"; V="$HOME/wren/voice"; RUN="$V/run"; LOG="$V/logs"; mkdir -p "$RUN" "$LOG"
[ -f "$V/box.env" ] && . "$V/box.env"
alive() { local p; p=$(cat "$RUN/$1.pid" 2>/dev/null) && [ -n "$p" ] && grep -qa "$2" "/proc/$p/cmdline" 2>/dev/null; }
if [ "$WHAT" = tts ] || [ "$WHAT" = all ]; then
  : "${TTS_PYTHON:?set TTS_PYTHON in $V/box.env}"
  if alive tts tts_server.py; then echo "tts already running pid $(cat $RUN/tts.pid)"; else
    ( cd "$V"; export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}" TTS_BACKEND=kokoro TTS_DEVICE="${TTS_DEVICE:-cuda}" TTS_EXPRESS="${TTS_EXPRESS:-0}" \
        TTS_VOICE="${TTS_VOICE:-af_heart}" TTS_THREADS=2 PORT_TTS=19411 COMPANION_BIND=127.0.0.1
      nohup setsid "$TTS_PYTHON" "$V/tts_server.py" > "$LOG/tts.log" 2>&1 < /dev/null & echo $! > "$RUN/tts.pid" )
    echo "tts started"; fi
fi
if [ "$WHAT" = stt ] || [ "$WHAT" = all ]; then
  : "${STT_PYTHON:?set STT_PYTHON in $V/box.env}"; : "${STTS_MODEL_DIR:?set STTS_MODEL_DIR in $V/box.env}"
  if alive stt stt_stream_server.py; then echo "stt already running pid $(cat $RUN/stt.pid)"; else
    ( cd "$V"; export CUDA_VISIBLE_DEVICES= PORT_STTSTREAM=19412 COMPANION_BIND=127.0.0.1 \
        STTS_MODEL_DIR STTS_KIND="${STTS_KIND:-nemo}" STTS_THREADS=2 STTS_ENDPOINT_S=3.0 STTS_MAX_STREAMS=8 STTS_MAX_SEGMENT_S=30
      nohup setsid nice -n 5 "$STT_PYTHON" "$V/stt_stream_server.py" > "$LOG/stt.log" 2>&1 < /dev/null & echo $! > "$RUN/stt.pid" )
    echo "stt started"; fi
fi
