// Client of the sherpa streaming STT server (ws /v1/stt/stream). One SttStream per speaker uuid.
export class SttStream {
  constructor(url, { onPartial, apiKey = '' } = {}) {
    this.apiKey = apiKey; this.url = url; this.onPartial = onPartial; this.ready = false; this.pending = []; this.waiter = null; this.closed = false;
    this.q = []; this.partial = ''; this.ws = null; this.open();
  }
  open() {
    const ws = this.ws = new WebSocket(this.url, this.apiKey ? { headers: { 'X-API-Key': this.apiKey } } : undefined); ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.ready = true; for (const m of this.q.splice(0)) ws.send(m); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'partial' || m.type === 'endpoint') { this.partial = m.text; this.onPartial?.(m.text, m); }
      if ((m.type === 'final' || m.type === 'flushed') && this.waiter) { const w = this.waiter; this.waiter = null; w(m); }
    };
    ws.onclose = () => { this.ready = false; if (this.waiter) { const w = this.waiter; this.waiter = null; w({ type: 'error', text: this.partial }); } if (!this.closed) setTimeout(() => !this.closed && this.open(), 1000); };
    ws.onerror = () => {};
  }
  _send(m) { if (this.ready && this.ws.readyState === 1) this.ws.send(m); else if (this.q.length < 400) this.q.push(m); }
  feed(pcm16kBuf) { this._send(pcm16kBuf); }
  // finalize current utterance: resolves the server's "final" (new stream afterwards). Falls back to last partial on error/timeout.
  finalize(timeoutMs = 3000) {
    return new Promise((res) => {
      const timer = setTimeout(() => { this.waiter = null; res({ type: 'timeout', text: this.partial }); }, timeoutMs);
      this.waiter = (m) => { clearTimeout(timer); res(m); };
      this._send(JSON.stringify({ type: 'finalize' })); this.partial = '';
    });
  }
  reset() { this._send(JSON.stringify({ type: 'reset' })); this.partial = ''; }
  close() { this.closed = true; try { this.ws.close(); } catch {} }
}
