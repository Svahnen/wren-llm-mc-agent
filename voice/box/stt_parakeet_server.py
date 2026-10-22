#!/usr/bin/env python3
"""Wren voice, second-pass STT: Parakeet TDT 0.6b v3 (NeMo) behind FastAPI. COPY of the companion STT server (unchanged logic);
ours runs on box loopback port 19413 (PORT_STT), STT_DEVICE=cuda|cpu.

POST /v1/stt            body = WAV file (Content-Type audio/wav), or raw PCM s16le mono
                        (Content-Type audio/L16 or application/octet-stream, ?rate=16000)
  -> {"text","words":[{"word","start","end"}],"duration","latency_s","device"}
GET  /health            open (no key)
Auth: "Authorization: Bearer <COMPANION_API_KEY>" or "X-API-Key".
Env: COMPANION_BIND PORT_STT COMPANION_API_KEY STT_MODEL STT_DEVICE(cuda|cpu) HF_HOME
"""
import hmac, io, os, tempfile, threading, time
from math import gcd
import numpy as np, soundfile as sf, torch, uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

KEYS = [k for k in os.environ.get("COMPANION_API_KEY", "").split(",") if k]  # comma list: own key (+ shared legacy key)
DEVICE = os.environ.get("STT_DEVICE", "cuda")
MODEL = os.environ.get("STT_MODEL", "nvidia/parakeet-tdt-0.6b-v3")
SR = 16000
MAX_BYTES = int(os.environ.get("STT_MAX_BYTES", str(16 * 2**20)))  # ~8 min of 16 kHz s16le
lock = threading.Lock()
app = FastAPI(title="companion-stt")
state = {}


def auth(req: Request):
    if "origin" in req.headers:  # browsers always send Origin on cross-site requests; the voice service (Node fetch) sends none
        raise HTTPException(403, "browser requests are not accepted")
    if req.method == "POST" and req.headers.get("content-type", "").split(";")[0].strip().lower() not in ("audio/wav", "audio/x-wav", "audio/l16", "application/octet-stream"):
        raise HTTPException(415, "content-type must be audio/wav, audio/L16 or application/octet-stream")
    if not KEYS:
        return
    tok = req.headers.get("x-api-key") or req.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not any(hmac.compare_digest(tok.encode(), k.encode()) for k in KEYS):
        raise HTTPException(401, "unauthorized")


def transcribe(wav: np.ndarray):
    shm = "/dev/shm" if os.path.isdir("/dev/shm") else None
    with lock, tempfile.NamedTemporaryFile(suffix=".wav", dir=shm) as f:
        sf.write(f.name, wav, SR, format="WAV", subtype="PCM_16")
        with torch.inference_mode():
            h = state["m"].transcribe([f.name], timestamps=True, verbose=False)[0]
    words = [{"word": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)}
             for w in (h.timestamp or {}).get("word", [])]
    return h.text, words


@app.on_event("startup")
def load():
    import nemo.collections.asr as nemo_asr
    t = time.time()
    m = nemo_asr.models.ASRModel.from_pretrained(MODEL, map_location="cpu").eval()
    if DEVICE != "cpu" and os.environ.get("STT_DTYPE", "bf16") == "bf16":
        m = m.to(torch.bfloat16)  # convert on CPU first: peak VRAM 1.8 GB instead of ~4.3 GB (fp32 transient)
    try:
        m = m.to(DEVICE)
    except torch.OutOfMemoryError:
        print("STT FATAL: CUDA OOM while loading %s (free VRAM too low)" % MODEL, flush=True)
        os._exit(78)
    state["m"] = m
    transcribe((np.random.default_rng(0).standard_normal(SR) * 0.01).astype(np.float32))  # warmup
    state["load_s"] = round(time.time() - t, 1)


def decode(body: bytes, rate: int):
    if body[:4] == b"RIFF":
        a, sr = sf.read(io.BytesIO(body), dtype="float32", always_2d=True)
        a = a.mean(axis=1)
    else:
        a, sr = np.frombuffer(body[: len(body) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0, rate
    if sr != SR:
        from scipy.signal import resample_poly
        g = gcd(sr, SR)
        a = resample_poly(a, SR // g, sr // g).astype(np.float32)
    return a


@app.get("/health")
def health():
    return {"ok": "m" in state, "model": MODEL, "device": DEVICE, "load_s": state.get("load_s")}


@app.post("/v1/stt", dependencies=[Depends(auth)])
async def stt(req: Request, rate: int = 16000):
    if int(req.headers.get("content-length") or 0) > MAX_BYTES:
        raise HTTPException(413, "audio too large")
    body = await req.body()
    if not body:
        raise HTTPException(400, "empty body")
    if len(body) > MAX_BYTES:
        raise HTTPException(413, "audio too large")
    t = time.perf_counter()
    try:
        wav = decode(body, rate)
    except Exception as e:
        raise HTTPException(400, f"bad audio: {e}")
    text, words = transcribe(wav)
    return JSONResponse({"text": text, "words": words, "duration": round(len(wav) / SR, 3),
                         "latency_s": round(time.perf_counter() - t, 3), "device": DEVICE})


BIND = os.environ.get("COMPANION_BIND", "127.0.0.1")   # loopback by default; reach it through an SSH tunnel


if __name__ == "__main__":
    if BIND not in ("127.0.0.1", "::1", "localhost") and not KEYS:
        print(f"WARNING: bound to {BIND} with NO COMPANION_API_KEY: anyone who can reach this port can use the server", flush=True)
    uvicorn.run(app, host=BIND,
                port=int(os.environ.get("PORT_STT", "19413")), log_level="warning")
