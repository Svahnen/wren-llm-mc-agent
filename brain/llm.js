// OpenAI-compatible streaming client for the System 2 endpoint (llama.cpp's llama-server, Ollama /v1, vLLM, a hosted API ...). Slots: 0 dialogue, 1 planning/reflection.
// Every call is logged as JSONL (brain/logs/llm-YYYY-MM-DD.jsonl). Cancellation via AbortSignal; hard timeout; optional early stop.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeLogger } from './jsonl.js'

/** API key for the endpoint (optional). Env S2_API_KEY wins; else S2_SECRETS_FILE (default brain/secrets.env, mode 600, gitignored) line S2_API_KEY=... ; '' when none.
 *  The header is always sent when a key is known; a llama-server started without a key ignores it (backwards compatible). */
export function loadS2Key(env = process.env, file = env.S2_SECRETS_FILE || fileURLToPath(new URL('./secrets.env', import.meta.url))) {
  if (env.S2_API_KEY) return env.S2_API_KEY.trim()
  try { const m = fs.readFileSync(file, 'utf8').match(/^S2_API_KEY=(.*)$/m); return m ? m[1].trim() : '' } catch { return '' }
}

export const SLOT_DIALOGUE = 0
export const SLOT_PLANNING = 1
export const DEFAULT_BASE_URL = 'http://127.0.0.1:19400/v1'

export class LlmError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.name = 'LlmError'; this.code = code; Object.assign(this, extra) }
}

export class LlmClient {
  constructor({ baseUrl = process.env.S2_BASE_URL || DEFAULT_BASE_URL, model = process.env.S2_MODEL || 's2-brain', fetchImpl = fetch, log = makeLogger('llm'),
    apiKey = loadS2Key(), timeoutMs = 20000, logPrompts = process.env.BRAIN_LOG_PROMPTS !== '0', defaults = {} } = {}) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), model, fetchImpl, log, timeoutMs, logPrompts })
    Object.defineProperty(this, 'apiKey', { value: apiKey, enumerable: false }) // not enumerable: never serialised into logs
    this.defaults = { temperature: 0.8, top_p: 0.95, top_k: 64, max_tokens: 160, ...defaults }
  }

  /**
   * @returns {Promise<{text, ttft_ms, total_ms, tokens, usage, timings, early_stopped}>} ; throws LlmError(code: aborted|timeout|http|network|bad_stream)
   * opts: messages, slot, signal, timeoutMs, onText(textSoFar) => 'stop'|void, kind, job_id, extra (body fields)
   */
  async complete({ messages, slot = SLOT_PLANNING, signal, timeoutMs = this.timeoutMs, onText, kind = 'call', job_id = null, extra = {}, ...sampling } = {}) {
    const t0 = Date.now()
    const ac = new AbortController()
    let why = null
    const onAbort = () => { why = 'aborted'; ac.abort() }
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }) }
    const timer = setTimeout(() => { why = 'timeout'; ac.abort() }, timeoutMs)
    const rec = { kind, job_id, slot, base: this.baseUrl, n_messages: messages.length, prompt_chars: messages.reduce((a, m) => a + m.content.length, 0) }
    if (this.logPrompts) rec.messages = messages
    let text = '', ttft = null, usage = null, timings = null, early = false
    try {
      // id_slot / cache_prompt are llama.cpp extensions (prompt-cache slots). Set S2_LLAMACPP=0 for servers that reject unknown fields (e.g. hosted APIs).
      const llamaExtras = process.env.S2_LLAMACPP === '0' ? {} : { id_slot: process.env.BRAIN_SLOT !== undefined ? Number(process.env.BRAIN_SLOT) : slot, cache_prompt: true }
      const body = { model: this.model, messages, stream: true, stream_options: { include_usage: true }, ...llamaExtras, ...this.defaults, ...sampling, ...extra }
      let resp
      try {
        resp = await this.fetchImpl(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body), signal: ac.signal })
      } catch (e) { throw why ? new LlmError(why, `${why} before response`) : new LlmError('network', `fetch failed: ${e.message}`) }
      if (!resp.ok) throw new LlmError('http', `HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`, { status: resp.status })
      const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = ''
      try {
        outer: for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let nl
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') break outer
            let j
            try { j = JSON.parse(payload) } catch { throw new LlmError('bad_stream', 'unparseable SSE chunk') }
            if (j.usage) usage = j.usage
            if (j.timings) timings = j.timings
            const d = j.choices?.[0]?.delta?.content
            if (d) {
              if (ttft === null) ttft = Date.now() - t0
              text += d
              if (onText && onText(text) === 'stop') { early = true; ac.abort(); break outer }
            }
          }
        }
      } catch (e) {
        if (e instanceof LlmError) throw e
        if (!early) throw why ? new LlmError(why, `${why} during stream`) : new LlmError('network', `stream failed: ${e.message}`)
      }
      if (!early && why) throw new LlmError(why, `${why}`)
      const out = { text, ttft_ms: ttft, total_ms: Date.now() - t0, tokens: usage?.total_tokens ?? Math.ceil((rec.prompt_chars + text.length) / 4), usage, timings, early_stopped: early }
      this.log({ ...rec, ok: true, text, ttft_ms: ttft, total_ms: out.total_ms, usage, timings, early_stopped: early })
      return out
    } catch (e) {
      this.log({ ...rec, ok: false, error: e.code ?? 'error', message: e.message, partial: text, total_ms: Date.now() - t0 })
      throw e
    } finally { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort) }
  }

  authHeaders(h = {}) { return this.apiKey ? { ...h, authorization: `Bearer ${this.apiKey}` } : h }

  async health() {
    const r = await this.fetchImpl(this.baseUrl.replace(/\/v1$/, '') + '/health', { headers: this.authHeaders(), signal: AbortSignal.timeout(3000) })
    return r.ok
  }
}
