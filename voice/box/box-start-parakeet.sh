#!/usr/bin/env bash
# RUNS ON THE AI SERVER. OPTIONAL second-pass STT: NVIDIA Parakeet-TDT-0.6B-v3 on 127.0.0.1:19413 (GPU bf16 about 2-4 GB, or STT_DEVICE=cpu). Idempotent.
# Falls back to CPU when free VRAM < MIN_FREE_MIB (default 5000). Needs PARAKEET_PYTHON (venv with nemo_toolkit[asr], fastapi, uvicorn) in ~/wren/voice/box.env.
set -u
V="$HOME/wren/voice"; RUN="$V/run"; LOG="$V/logs"; mkdir -p "$RUN" "$LOG"
[ -f "$V/box.env" ] && . "$V/box.env"
: "${PARAKEET_PYTHON:?set PARAKEET_PYTHON in $V/box.env}"
if [ -f "$RUN/parakeet.pid" ] && grep -qa stt_parakeet_server "/proc/$(cat $RUN/parakeet.pid)/cmdline" 2>/dev/null; then echo "parakeet already running pid $(cat $RUN/parakeet.pid)"; exit 0; fi
DEV="${STT_DEVICE:-cuda}"
if [ "$DEV" = cuda ]; then
  FREE=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -1)
  if [ "${FREE:-0}" -lt "${MIN_FREE_MIB:-5000}" ]; then echo "free VRAM ${FREE} MiB < ${MIN_FREE_MIB:-5000}: using CPU" >&2; DEV=cpu; fi
fi
( cd "$V"; export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}" PORT_STT=19413 COMPANION_BIND=127.0.0.1 STT_DEVICE="$DEV" STT_DTYPE=bf16 OMP_NUM_THREADS=4
  nohup setsid nice -n 5 "$PARAKEET_PYTHON" "$V/stt_parakeet_server.py" > "$LOG/parakeet.log" 2>&1 < /dev/null & echo $! > "$RUN/parakeet.pid" )
echo "parakeet started on $DEV"
