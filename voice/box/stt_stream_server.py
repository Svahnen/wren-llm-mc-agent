#!/usr/bin/env python3
"""Companion streaming STT (CPU only): sherpa-onnx online transducer behind a FastAPI WebSocket.

Why: the batch service (stt_server.py, Parakeet on the GPU) only answers after the utterance ended. This one decodes while the
player is still talking and sends PARTIAL transcripts every ~100-300 ms, plus ENDPOINT events, using ~0.2 CPU core and no VRAM.
It never imports torch/CUDA, so it does not compete for GPU memory.

  WS  /v1/stt/stream[?rate=16000]
      client -> server  binary frame : PCM s16le mono at `rate` (any frame size; 20-100 ms is typical, bigger is fine)
                        text   frame : {"type":"finalize"}  flush, answer with a "final", start a new segment
                                       {"type":"flush"}     answer "flushed" with the utterance so far, stream keeps running
                                       {"type":"reset"}     drop everything heard so far (no reply)
      server -> client  {"type":"ready","model":...,"sample_rate":16000,"segment":0}
                        {"type":"partial","text","segment","seq","t"}      text changed; t = seconds of audio received so far
                        {"type":"endpoint","text","segment","t","t0","words"}   the model's endpoint rule fired (trailing silence); the
                                                                              segment is closed and a new one starts by itself
                        {"type":"final","text","segment","t","t0","words":[{"word","start","end"}],"latency_s"}  answer to "finalize"
                        {"type":"error","error":...}
  GET /health            open (no key): {"ok":true,"model":...}
Auth: "Authorization: Bearer <key>" or "X-API-Key: <key>" on the upgrade request (a comma list in COMPANION_API_KEY, like the other services).
Env: COMPANION_BIND PORT_STTSTREAM COMPANION_API_KEY STTS_MODEL_DIR STTS_KIND(nemo|zipformer) STTS_THREADS STTS_ENDPOINT_S STTS_MAX_STREAMS
"""
import asyncio, glob, hmac, os, threading, time
from math import gcd
import numpy as np, uvicorn
import sherpa_onnx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

KEYS = [k for k in os.environ.get("COMPANION_API_KEY", "").split(",") if k]
MODEL_DIR = os.environ["STTS_MODEL_DIR"]
KIND = os.environ.get("STTS_KIND", "nemo")                       # nemo = NeMo FastConformer transducer, zipformer = icefall zipformer
THREADS = int(os.environ.get("STTS_THREADS", "2"))
ENDPOINT_S = float(os.environ.get("STTS_ENDPOINT_S", "0.6"))     # trailing silence after words that ends a segment (rule 2)
MAX_STREAMS = int(os.environ.get("STTS_MAX_STREAMS", "4"))
MAX_SEG_S = float(os.environ.get("STTS_MAX_SEGMENT_S", "30"))    # hard end of a segment (rule 3)
SR = 16000
decode_lock = threading.Lock()
app = FastAPI(title="companion-stt-stream")
state: dict = {"streams": 0}


def _pick(pattern: str) -> str:
    """encoder*.onnx etc.; the int8 file wins when both exist (encoder + joiner), the fp32 decoder wins (tiny, more exact)."""
    files = sorted(glob.glob(os.path.join(MODEL_DIR, pattern)))
    if not files:
        raise FileNotFoundError(f"{pattern} not found in {MODEL_DIR}")
    int8 = [f for f in files if "int8" in os.path.basename(f)]
    plain = [f for f in files if f not in int8]
    return (int8 or files)[0] if not pattern.startswith("decoder") else (plain or files)[0]


def build():
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=os.path.join(MODEL_DIR, "tokens.txt"), encoder=_pick("encoder*.onnx"), decoder=_pick("decoder*.onnx"),
        joiner=_pick("joiner*.onnx"), num_threads=THREADS, sample_rate=SR, provider="cpu",
        model_type="nemo_transducer" if KIND == "nemo" else "",
        enable_endpoint_detection=True, rule1_min_trailing_silence=2.4, rule2_min_trailing_silence=ENDPOINT_S,
        rule3_min_utterance_length=MAX_SEG_S, decoding_method="greedy_search")


def _authorized(headers) -> bool:
    if not KEYS:
        return True
    tok = headers.get("x-api-key") or headers.get("authorization", "").removeprefix("Bearer ").strip()
    return any(hmac.compare_digest(tok.encode(), k.encode()) for k in KEYS)


def _words(r, off: float = 0.0) -> list:
    """Word list with start/end seconds from the token timestamps (a token starting with a space or a sentencepiece mark opens a word)."""
    out = []
    for tok, t in zip(r.tokens, r.timestamps):
        if tok[:1] in (" ", "▁") or not out:
            out.append([tok.lstrip(" ▁"), float(t), float(t)])
        else:
            out[-1][0] += tok
            out[-1][2] = float(t)
    return [{"word": w, "start": round(a + off, 2), "end": round(max(b, a) + 0.08 + off, 2)} for w, a, b in out if w]


class Session:
    def __init__(self, rate: int):
        self.rate, self.seg, self.seq, self.recv = rate, 0, 0, 0       # recv = samples received (at 16 kHz)
        self.last = ""
        self.t_seg0 = 0                                                   # samples at the start of the current segment
        self.st = state["rec"].create_stream()

    def feed(self, pcm: bytes) -> list:
        """One audio frame in; returns the events to send (partial / endpoint). Runs in a worker thread."""
        a = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0
        if self.rate != SR:
            from scipy.signal import resample_poly
            g = gcd(self.rate, SR)
            a = resample_poly(a, SR // g, self.rate // g).astype(np.float32)
        self.recv += len(a)
        rec, ev = state["rec"], []
        with decode_lock:
            self.st.accept_waveform(SR, a)
            while rec.is_ready(self.st):
                rec.decode_stream(self.st)
            r = rec.get_result_all(self.st)
            text, ended = r.text.strip(), rec.is_endpoint(self.st)
            t = round(self.recv / SR, 2)
            if ended:
                if text:
                    ev.append({"type": "endpoint", "text": text, "segment": self.seg, "t": t, "t0": round(self.t_seg0 / SR, 2),
                               "words": _words(r, self.t_seg0 / SR)})
                    self.seg += 1
                rec.reset(self.st)
                self.last, self.t_seg0 = "", self.recv
            elif text != self.last:
                self.last, self.seq = text, self.seq + 1
                ev.append({"type": "partial", "text": text, "segment": self.seg, "seq": self.seq, "t": t})
        return ev

    def finalize(self) -> dict:
        rec, t0 = state["rec"], time.perf_counter()
        with decode_lock:
            self.st.accept_waveform(SR, np.zeros(int(0.5 * SR), np.float32))      # right context so the last word is emitted
            self.st.input_finished()
            while rec.is_ready(self.st):
                rec.decode_stream(self.st)
            r = rec.get_result_all(self.st)
            out = {"type": "final", "text": r.text.strip(), "segment": self.seg, "t": round(self.recv / SR, 2),
                   "t0": round(self.t_seg0 / SR, 2), "words": _words(r, self.t_seg0 / SR), "latency_s": round(time.perf_counter() - t0, 3)}
            self.st = rec.create_stream()          # input_finished closes a stream: a new one for the next segment
        self.seg, self.last, self.t_seg0 = self.seg + 1, "", self.recv
        return out

    def flush(self) -> dict:
        """The utterance so far, complete up to the last sample received: 0.3 s of silence goes into the LIVE stream (the same silence
        the player is producing anyway) so the last word is emitted. Non-destructive: the stream keeps running."""
        rec, t0 = state["rec"], time.perf_counter()
        with decode_lock:
            self.st.accept_waveform(SR, np.zeros(int(0.3 * SR), np.float32))
            self.recv += int(0.3 * SR)
            while rec.is_ready(self.st):
                rec.decode_stream(self.st)
            r = rec.get_result_all(self.st)
            self.last = r.text.strip()
            return {"type": "flushed", "text": self.last, "segment": self.seg, "t": round(self.recv / SR, 2),
                    "t0": round(self.t_seg0 / SR, 2), "words": _words(r, self.t_seg0 / SR), "latency_s": round(time.perf_counter() - t0, 3)}

    def reset(self):
        with decode_lock:
            state["rec"].reset(self.st)
        self.last, self.t_seg0 = "", self.recv


@app.on_event("startup")
def load():
    t = time.time()
    state["rec"] = build()
    s = state["rec"].create_stream()
    s.accept_waveform(SR, (np.random.default_rng(0).standard_normal(SR) * 0.01).astype(np.float32))
    while state["rec"].is_ready(s):
        state["rec"].decode_stream(s)
    state["load_s"] = round(time.time() - t, 1)


@app.get("/health")
def health():
    return {"ok": "rec" in state, "model": os.path.basename(MODEL_DIR.rstrip("/")), "kind": KIND, "device": "cpu",
            "streams": state["streams"], "load_s": state.get("load_s")}


@app.websocket("/v1/stt/stream")
async def stream(ws: WebSocket):
    if "origin" in ws.headers:  # a browser page: refuse (the Node voice service sends no Origin header)
        await ws.close(code=4403)
        return
    if not _authorized(ws.headers):
        await ws.close(code=4401)
        return
    if state["streams"] >= MAX_STREAMS:
        await ws.close(code=4429)
        return
    try:
        rate = int(ws.query_params.get("rate", SR))
    except ValueError:
        rate = SR
    if not 8000 <= rate <= 48000:
        await ws.close(code=4400)
        return
    await ws.accept()
    state["streams"] += 1
    s = Session(rate)
    try:
        await ws.send_json({"type": "ready", "model": os.path.basename(MODEL_DIR.rstrip("/")), "sample_rate": SR, "segment": 0})
        while True:
            m = await ws.receive()
            if m["type"] == "websocket.disconnect":
                break
            if m.get("bytes"):
                for e in await asyncio.to_thread(s.feed, m["bytes"]):
                    await ws.send_json(e)
            elif m.get("text"):
                try:
                    kind = __import__("json").loads(m["text"]).get("type")
                except ValueError:
                    kind = None
                if kind == "finalize":
                    await ws.send_json(await asyncio.to_thread(s.finalize))
                elif kind == "flush":
                    await ws.send_json(await asyncio.to_thread(s.flush))
                elif kind == "reset":
                    await asyncio.to_thread(s.reset)
    except WebSocketDisconnect:
        pass
    except Exception as e:                                           # never leak a traceback to the client
        try:
            await ws.send_json({"type": "error", "error": type(e).__name__})
        except Exception:
            pass
    finally:
        state["streams"] -= 1


BIND = os.environ.get("COMPANION_BIND", "127.0.0.1")   # loopback by default; reach it through an SSH tunnel


if __name__ == "__main__":
    if BIND not in ("127.0.0.1", "::1", "localhost") and not KEYS:
        print(f"WARNING: bound to {BIND} with NO COMPANION_API_KEY: anyone who can reach this port can use the server", flush=True)
    uvicorn.run(app, host=BIND, port=int(os.environ.get("PORT_STTSTREAM", "18405")),
                log_level="warning", ws_max_size=1 << 20)
