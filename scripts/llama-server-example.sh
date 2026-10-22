#!/usr/bin/env bash
# EXAMPLE: run a local llama.cpp `llama-server` as the S2 brain endpoint. Any other OpenAI-compatible server works too
# (Ollama: http://127.0.0.1:11434/v1, vLLM, LM Studio, a hosted API); then you do not need this script, only S2_BASE_URL / S2_MODEL / S2_API_KEY.
#
#   MODEL=/path/to/your-model.gguf ./llama-server-example.sh
#
# Any instruction-tuned chat model that follows a strict output format works; a model of roughly 7B to 30B parameters is a
# reasonable starting range. Smaller models work but the validator will reject more answers. You choose the model, quantisation and persona.
# Env: MODEL (required), PORT (19400), CTX (16384 total context), SLOTS (2 parallel requests), NGL (999 = all layers on the GPU), API_KEY_FILE (optional).
set -euo pipefail
: "${MODEL:?set MODEL=/path/to/model.gguf}"
PORT="${PORT:-19400}"; CTX="${CTX:-16384}"; SLOTS="${SLOTS:-2}"; NGL="${NGL:-999}"
KEY=(); [ -n "${API_KEY_FILE:-}" ] && KEY=(--api-key-file "$API_KEY_FILE")
exec llama-server -m "$MODEL" -c "$CTX" -np "$SLOTS" -ngl "$NGL" --jinja --host 127.0.0.1 --port "$PORT" "${KEY[@]}"
