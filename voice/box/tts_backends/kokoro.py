"""Kokoro-82M (Apache-2.0). Live voice on the GPU (TTS_DEVICE=cuda, ~0.7 GB, 40-60 ms per sentence); also the automatic CPU fallback.

Expressive mode (default, TTS_EXPRESS=1): Kokoro has no emotion input, so the emotion label drives a per-emotion profile that is
realised at zero extra latency inside the model call:
  * voice = af_bella TIMBRE (decoder half of the style vector, so it stays the same person) + a per-emotion mix of other voices'
    PROSODY half (duration / F0 / energy predictor half), e.g. cheerful borrows af_heart + af_sky intonation, annoyed/angry af_kore;
  * the predicted F0 contour is expanded around its mean (f0gain), shifted (f0shift, semitones), tilted over the sentence
    (rising = playful/anxious, falling = annoyed), given a slow random wobble (liveliness) and for fear/worry a 5.5 Hz vibrato;
  * the energy predictor N is scaled; speed per emotion; afterwards a light dynamic expander + gain, and lead/trail pauses.
Measured: f0 std 2.2 st flat -> 4.5 st, per-emotion median f0 spread 0.1 -> 1.9 st, WER unchanged.
ROLLBACK to the plain flat voice: TTS_EXPRESS=0 (then TTS_VOICE/TTS_SPEED/KOKORO_VOICE_<EMOTION> behave as before).
Env: TTS_VOICE (timbre base, default af_bella), TTS_SPEED (global factor, 1.05 = profile as tuned), KOKORO_VOICE_<EMOTION> (override
the whole voice of one emotion, prosody controls still apply), TTS_EXPRESS=0|1."""
import os, re

import numpy as np
import torch
from kokoro import KModel, KPipeline

# --- plain (TTS_EXPRESS=0) speeds, the earlier non-expressive behaviour -----------------------------------------------
SPEED = {"cheerful": 1.08, "teasing": 1.0, "scared": 1.2, "angry": 1.1, "worried": 0.97,
         "excited": 1.18, "annoyed": 0.95, "calm": 1.0}

B = "af_bella"
# emotion: dict(timbre, prosody, speed, f0gain, f0shift, tilt, vib, wob, ngain, gain_db, expand, lead_ms, trail_ms)
# timbre / prosody = voice name or {voice: weight}. Tuned by numbers (no listening).
PROFILE = {
    "calm":     dict(prosody={B: .6, "af_heart": .4}, speed=1.05, f0gain=1.35, tilt=-0.5, wob=0.5, trail=120),
    "cheerful": dict(prosody={B: .4, "af_heart": .4, "af_sky": .2}, speed=1.12, f0gain=1.7, f0shift=1.5, tilt=1.0, wob=0.8,
                     ngain=1.1, gain_db=1.0, expand=0.1, trail=100),
    "excited":  dict(timbre={B: .8, "af_nova": .2}, prosody={B: .5, "af_nova": .5}, speed=1.22, f0gain=2.0, f0shift=2.5, tilt=1.5,
                     wob=1.0, ngain=1.2, gain_db=2.0, expand=0.2, trail=80),
    "teasing":  dict(prosody={B: .4, "af_sky": .3, "af_heart": .3}, speed=1.0, f0gain=1.9, f0shift=0.5, tilt=2.0, wob=1.2,
                     expand=0.1, lead=80, trail=160),
    "worried":  dict(timbre={B: .7, "af_nicole": .3}, prosody={B: .5, "af_nicole": .5}, speed=0.95, f0gain=1.6, f0shift=0.5,
                     tilt=1.5, vib=0.25, wob=0.6, gain_db=-2.0, lead=120, trail=200),
    "scared":   dict(timbre={B: .6, "af_nicole": .4}, prosody={B: .4, "af_nicole": .3, "af_sky": .3}, speed=1.25, f0gain=1.9,
                     f0shift=3.5, tilt=2.0, vib=0.5, wob=1.0, ngain=1.2, gain_db=1.0, expand=0.15, trail=60),
    "annoyed":  dict(timbre={B: .7, "af_kore": .3}, prosody={B: .5, "af_kore": .5}, speed=0.98, f0gain=1.5, f0shift=-1.2,
                     tilt=-2.0, wob=0.6, ngain=1.1, expand=0.1, lead=60, trail=180),
    "angry":    dict(timbre={B: .7, "af_kore": .3}, prosody={B: .4, "af_kore": .6}, speed=1.12, f0gain=1.8, f0shift=-1.5,
                     tilt=-1.5, wob=0.8, ngain=1.3, gain_db=2.0, expand=0.3, trail=100),
}
DEFAULTS = dict(speed=1.0, f0gain=1.0, f0shift=0.0, tilt=0.0, vib=0.0, wob=0.0, ngain=1.0, gain_db=0.0, expand=0.0, lead=0, trail=0)
F0_FPS = 80.0            # F0 frames per second of audio in Kokoro's predictor (40 duration frames/s x 2)
CTL = dict(f0gain=1.0, f0shift=0.0, tilt=0.0, vib=0.0, wob=0.0, ngain=1.0)
_MARKUP = re.compile(r"[*_~`#<>\[\]{}|]")
_LN2_12 = 0.693147 / 12


@torch.no_grad()
def _forward_with_tokens(self, input_ids, ref_s, speed=1):
    """kokoro.KModel.forward_with_tokens with an F0 / energy hook between the predictor and the decoder (CTL)."""
    L = torch.full((input_ids.shape[0],), input_ids.shape[-1], device=input_ids.device, dtype=torch.long)
    tm = torch.arange(L.max()).unsqueeze(0).expand(L.shape[0], -1).type_as(L)
    tm = torch.gt(tm + 1, L.unsqueeze(1)).to(self.device)
    bd = self.bert(input_ids, attention_mask=(~tm).int())
    d_en = self.bert_encoder(bd).transpose(-1, -2)
    s = ref_s[:, 128:]
    d = self.predictor.text_encoder(d_en, s, L, tm)
    x, _ = self.predictor.lstm(d)
    dur = torch.sigmoid(self.predictor.duration_proj(x)).sum(axis=-1) / speed
    pd = torch.round(dur).clamp(min=1).long().squeeze()
    idx = torch.repeat_interleave(torch.arange(input_ids.shape[1], device=self.device), pd)
    a = torch.zeros((input_ids.shape[1], idx.shape[0]), device=self.device)
    a[idx, torch.arange(idx.shape[0])] = 1
    a = a.unsqueeze(0)
    en = d.transpose(-1, -2) @ a
    F0, N = self.predictor.F0Ntrain(en, s)
    c = CTL
    voiced = F0 > 30
    if voiced.any() and (c["f0gain"] != 1.0 or c["f0shift"] or c["tilt"] or c["vib"] or c["wob"]):
        lf = torch.log(F0.clamp(min=1.0))
        m = lf[voiced].mean()
        n = lf.shape[-1]
        tt = torch.linspace(0, 1, n, device=lf.device)
        st = c["f0shift"] + c["tilt"] * (tt - 0.5)                      # semitones added on top of the expanded contour
        if c["vib"]:
            st = st + c["vib"] * torch.sin(2 * 3.14159265 * 5.5 * tt * n / F0_FPS)
        if c["wob"]:
            gq = torch.Generator(device="cpu")
            gq.manual_seed(n)
            r = torch.randn(1, 1, max(4, n // 14), generator=gq).to(lf.device)
            st = st + c["wob"] * torch.nn.functional.interpolate(r, size=n, mode="linear", align_corners=True)[0, 0]
        F0 = torch.where(voiced, torch.exp(m + (lf - m) * c["f0gain"] + st * _LN2_12), F0)
    if c["ngain"] != 1.0:
        N = N * c["ngain"]
    t_en = self.text_encoder(input_ids, L, tm)
    asr = t_en @ a
    return self.decoder(asr, F0, N, ref_s[:, :128]).squeeze(), pd


def _post(w, gain_db, expand, sr=24000):
    if expand:                                    # light dynamic expander: loud syllables stand out more
        win = int(sr * 0.04)
        e = np.sqrt(np.convolve(w * w, np.ones(win) / win, "same") + 1e-8)
        w = w * np.clip(e / np.percentile(e, 90), 0.25, 2.0) ** expand
    if gain_db:
        w = w * 10 ** (gain_db / 20)
    pk = float(np.abs(w).max()) if w.size else 0.0
    if pk > 0.97:
        w = w * 0.97 / pk
    return w.astype(np.float32)


def _spec(v):
    """'af_bella' | 'af_bella:0.6,af_heart:0.4' | {name: weight} -> {name: weight}"""
    if isinstance(v, dict):
        return v
    out = {}
    for p in str(v).split(","):
        n, _, w = p.strip().partition(":")
        if n:
            out[n] = float(w) if w else 1.0
    return out


class Backend:
    def __init__(self):
        self.device = os.environ.get("TTS_DEVICE", "cpu")
        torch.set_num_threads(int(os.environ.get("TTS_THREADS", "6")))
        self.voice = os.environ.get("TTS_VOICE", B)
        self.speed = float(os.environ.get("TTS_SPEED", "1.0"))
        self.express = os.environ.get("TTS_EXPRESS", "1") != "0"
        if self.express:
            KModel.forward_with_tokens = _forward_with_tokens
        self.pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M",
                              device=None if self.device == "cpu" else self.device)
        self._vc = {}

    def warmup(self):
        for e in ("calm", "excited"):
            for t in ("Warm up.", "Warm up the voice, one more time please."):
                for _ in self.stream(t, e):
                    pass

    def _mix(self, spec):
        """weighted blend of voice packs (normalised weights); cached"""
        spec = _spec(spec)
        key = tuple(sorted(spec.items()))
        if key not in self._vc:
            tot = sum(spec.values()) or 1.0
            self._vc[key] = sum(self.pipe.load_single_voice(n) * (w / tot) for n, w in spec.items())
        return self._vc[key]

    def _style(self, emotion, voice):
        p = {**DEFAULTS, **PROFILE.get(emotion, PROFILE["calm"])}
        over = voice or os.environ.get(f"KOKORO_VOICE_{emotion.upper()}")
        base = _spec(self.voice)
        if over:                                  # explicit voice for this call / emotion: plain voice, prosody controls still apply
            timbre = prosody = _spec(over)
        elif base != {B: 1.0}:                    # TTS_VOICE names another voice: use it for every emotion
            timbre = prosody = base
        else:                                     # default: af_bella timbre, per-emotion prosody mix
            timbre, prosody = p.get("timbre") or base, p.get("prosody") or base
        return p, torch.cat([self._mix(timbre)[..., :128], self._mix(prosody)[..., 128:]], -1)

    def stream(self, text, emotion, voice=None, speed=None):
        text = _MARKUP.sub("", text).strip()        # "*sighs*" markup must not be read out
        if not any(c.isalnum() for c in text):
            return
        if not self.express:                        # plain flat voice (rollback)
            v = voice or os.environ.get(f"KOKORO_VOICE_{emotion.upper()}") or self.voice
            sp = speed or SPEED.get(emotion, 1.0) * self.speed
            for r in self.pipe(text, voice=v, speed=sp):
                if r[2] is not None:
                    yield r[2].numpy()
            return
        p, style = self._style(emotion, voice)
        sp = speed or p["speed"] * self.speed / 1.05
        CTL.update({k: p[k] for k in CTL})
        prev = None
        first = True
        for r in self.pipe(text, voice=style, speed=sp):
            if r[2] is None:
                continue
            w = _post(r[2].numpy(), p["gain_db"], p["expand"])
            if first and p["lead"]:
                w = np.concatenate([np.zeros(int(24 * p["lead"]), np.float32), w])
            first = False
            if prev is not None:
                yield prev
            prev = w
        if prev is not None:
            yield np.concatenate([prev, np.zeros(int(24 * p["trail"]), np.float32)]) if p["trail"] else prev

    def info(self):
        return {"backend": "kokoro", "express": self.express, "default_voice": self.voice,
                "emotions": sorted(PROFILE) if self.express else SPEED}
