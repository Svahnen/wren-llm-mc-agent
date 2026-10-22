#!/usr/bin/env python3
"""Companion TTS: streaming, pluggable backend.

POST /v1/tts  {"text": "...", "emotion": "cheerful", "voice": null, "speed": null}
  -> chunked audio/L16;rate=24000;channels=1 (raw PCM s16le). Headers: X-Sample-Rate, X-Backend.
GET  /health  open.   GET /v1/voices (auth) -> backend info.
Auth: Bearer <COMPANION_API_KEY> or X-API-Key.
Emotions: cheerful teasing scared angry worried excited annoyed calm. Unknown -> calm.
Backend selection: env TTS_BACKEND -> tts_backends/<name>.py exposing class Backend (see tts_backends/base.py).
"""
import hmac, importlib, os, time
import numpy as np, uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

KEYS = [k for k in os.environ.get("COMPANION_API_KEY", "").split(",") if k]  # comma list: own key (+ shared legacy key)
NAME = os.environ.get("TTS_BACKEND", "kokoro")
# X-Backend: "kokoro-cpu" marks the slow CPU fallback voice (the bridge keeps it off the engine Say path); GPU Kokoro is just "kokoro"
LABEL = "kokoro-cpu" if (NAME == "kokoro" and os.environ.get("TTS_DEVICE", "cpu") == "cpu") else NAME
app = FastAPI(title="companion-tts")
S = {}


class Req(BaseModel):
    text: str = Field(max_length=int(os.environ.get("TTS_MAX_CHARS", "1000")))
    emotion: str = "calm"
    voice: str | None = None
    speed: float | None = None
    seed: int | None = None          # AU1: fixes the torch RNG (Kokoro's decoder noise source) so the same text+voice+speed+seed gives the same samples


def auth(req: Request):
    if "origin" in req.headers:  # browsers always send Origin on cross-site requests; the voice service (Node fetch) sends none
        raise HTTPException(403, "browser requests are not accepted")
    if req.method == "POST" and not req.headers.get("content-type", "").lower().startswith("application/json"):
        raise HTTPException(415, "content-type must be application/json")
    if not KEYS:
        return
    tok = req.headers.get("x-api-key") or req.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not any(hmac.compare_digest(tok.encode(), k.encode()) for k in KEYS):
        raise HTTPException(401, "unauthorized")


@app.on_event("startup")
def load():
    t = time.time()
    b = importlib.import_module(f"tts_backends.{NAME}").Backend()
    b.warmup()
    S["b"] = b
    S["load_s"] = round(time.time() - t, 1)


@app.get("/health")
def health():
    b = S.get("b")
    return {"ok": b is not None, "backend": NAME, "device": getattr(b, "device", None),
            "sample_rate": 24000, "load_s": S.get("load_s"), "seed": True}


@app.get("/v1/voices", dependencies=[Depends(auth)])
def voices():
    return S["b"].info()


def pcm16(a: np.ndarray) -> bytes:
    return (np.clip(a, -1, 1) * 32767).astype("<i2").tobytes()


# --- Serialised generation -------------------------------------------------------------------------------------------
# Root cause of the recurring "next request dies after an interrupted one" failures:
#  1. The old code iterated b.stream() through starlette's threadpool: every next() ran on whichever worker thread was free,
#     but torch.inference_mode / no_grad are THREAD-LOCAL. The static KV cache and CUDA graphs were created inside
#     inference mode on one thread and then touched from another one that was not in it ("Inplace update to inference tensor
#     outside InferenceMode", "Inference tensors cannot be saved for backward"). A client disconnect left the generator
#     suspended mid `with torch.inference_mode()` and closed from yet another thread.
#  2. Two overlapping requests drove the one shared static cache / CUDA graph from two threads at once -> device-side assert
#     (sticky, process restart).
# Fix: ONE dedicated worker thread owns all GPU generation (inference_mode entered once for the whole thread), requests are
# queued FIFO, a cancelled (disconnected) request is dropped/stopped between chunks and its generator closed in that same
# thread, and a request that fails before sending any audio is retried once transparently.
import asyncio, queue, threading

JOBS = queue.Queue()
STICKY = ("device-side assert", "illegal memory access", "CUDA error", "CUDA out of memory", "cudaError")


class Job:
    def __init__(self, r, loop):
        self.r, self.loop, self.cancel = r, loop, threading.Event()
        self.out = asyncio.Queue()

    def put(self, item):
        self.loop.call_soon_threadsafe(self.out.put_nowait, item)


def run_job(b, job):
    r = job.r
    for attempt in (0, 1):
        sent = 0
        if r.seed is not None:
            import torch
            torch.manual_seed(r.seed & 0x7FFFFFFF)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(r.seed & 0x7FFFFFFF)
        gen = b.stream(r.text, r.emotion, voice=r.voice, speed=r.speed)
        try:
            for chunk in gen:
                if job.cancel.is_set():
                    return
                job.put(pcm16(np.asarray(chunk, dtype=np.float32)))
                sent += 1
            return
        except Exception as e:
            msg = str(e)
            print(f"tts: attempt {attempt} failed after {sent} chunks: {type(e).__name__}: {msg[:200]}", flush=True)
            if any(k in msg for k in STICKY):
                # A CUDA device-side assert / illegal access is sticky: every later call fails until the process restarts.
                # Exit 79 (run-tts.sh maps it to a plain failure -> systemd restarts the unit cleanly, rate limited).
                job.put(e)
                time.sleep(0.2)
                os._exit(79)
            if sent or attempt or job.cancel.is_set():
                job.put(e)
                return
            if hasattr(b, "recover"):
                b.recover()
        finally:
            try:
                gen.close()
            except Exception:
                pass


def worker():
    try:
        import torch
        ctx = torch.inference_mode()
    except Exception:
        ctx = None
    if ctx:
        ctx.__enter__()          # whole thread stays in inference mode; never left, never shared with another thread
    while True:
        job = JOBS.get()
        if job.cancel.is_set():
            continue
        try:
            run_job(S["b"], job)
        except BaseException as e:
            job.put(e)
        finally:
            job.put(None)


threading.Thread(target=worker, name="tts-gpu", daemon=True).start()


@app.post("/v1/tts", dependencies=[Depends(auth)])
async def tts(r: Req):
    if not any(c.isalnum() for c in r.text):
        raise HTTPException(400, "no speakable text")
    job = Job(r, asyncio.get_running_loop())
    JOBS.put(job)

    async def gen():
        try:
            while True:
                item = await job.out.get()
                if item is None:
                    return
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            job.cancel.set()     # client went away (or finished): stop generating, worker closes the generator itself

    return StreamingResponse(gen(), media_type="audio/L16;rate=24000;channels=1",
                             headers={"X-Sample-Rate": "24000", "X-Backend": LABEL})


BIND = os.environ.get("COMPANION_BIND", "127.0.0.1")   # loopback by default; reach it through an SSH tunnel


if __name__ == "__main__":
    if BIND not in ("127.0.0.1", "::1", "localhost") and not KEYS:
        print(f"WARNING: bound to {BIND} with NO COMPANION_API_KEY: anyone who can reach this port can use the server", flush=True)
    uvicorn.run(app, host=BIND,
                port=int(os.environ.get("PORT_TTS", "18403")), log_level="warning")
