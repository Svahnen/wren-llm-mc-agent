"""Backend contract. A backend module `tts_backends/<name>.py` defines `class Backend` with:

    device: str                      # "cpu" | "cuda" (reported in /health)
    def warmup(self) -> None         # load weights, run one short synthesis
    def stream(self, text, emotion, voice=None, speed=None) -> Iterator[np.ndarray]
        # yields float32 mono chunks at 24000 Hz, first chunk as early as possible (split on sentences if needed)
    def info(self) -> dict           # voices etc.

Select with TTS_BACKEND=<name>.
"""
EMOTIONS = ("cheerful", "teasing", "scared", "angry", "worried", "excited", "annoyed", "calm")
