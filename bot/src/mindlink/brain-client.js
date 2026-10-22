import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Shared secret for the brain API: env BRAIN_TOKEN, else BRAIN_TOKEN=... in brain/secrets.env (mode 600, gitignored; override the path with BRAIN_SECRETS_FILE). '' = none. */
export function loadBrainToken(env = process.env, file = env.BRAIN_SECRETS_FILE || fileURLToPath(new URL('../../../brain/secrets.env', import.meta.url))) {
  if (env.BRAIN_TOKEN) return env.BRAIN_TOKEN.trim()
  try { const m = fs.readFileSync(file, 'utf8').match(/^BRAIN_TOKEN=(.*)$/m); return m ? m[1].trim() : '' } catch { return '' }
}

// HTTP client for the brain host (127.0.0.1:19500): POST /event, POST /context, GET /intent long-poll loop. Never throws.
export class BrainClient {
  constructor({ url = process.env.BRAIN_URL || 'http://127.0.0.1:19500', token = loadBrainToken(), log = () => {}, onIntent = () => {} }) {
    Object.assign(this, { url: url.replace(/\/$/, ''), token, log, onIntent })
    this.since = -1; this.running = false; this.lastOkAt = 0; this.errors = 0; this.last = null; this.polls = 0
  }
  get headers() { return { 'content-type': 'application/json', ...(this.token ? { 'x-brain-token': this.token } : {}) } }
  async #req(method, path, body, timeoutMs = 4000) {
    try {
      const r = await fetch(this.url + path, { method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
      const j = await r.json().catch(() => ({}))
      this.lastOkAt = Date.now(); this.errors = 0
      return { ok: r.ok, status: r.status, ...j }
    } catch (e) { this.errors++; return { ok: false, error: String(e?.message ?? e).slice(0, 100) } }
  }
  postEvent(ev) { return this.#req('POST', '/event', ev) }
  postContext(ctx) { return this.#req('POST', '/context', ctx) }
  status() { return this.#req('GET', '/status') }
  start() {
    if (this.running) return
    this.running = true
    ;(async () => {
      while (this.running) {
        const wait = 20000
        const r = await this.#req('GET', `/intent?since=${this.since}&wait=${wait}`, undefined, wait + 5000)
        this.polls++
        if (!r.ok) { await new Promise((res) => setTimeout(res, Math.min(10000, 1000 * Math.min(10, this.errors)))); continue }
        if (r.seq !== undefined) { this.last = r; if (r.seq < this.since) { this.since = r.seq; r.changed = true } else if (r.seq > this.since) this.since = r.seq } // seq went backwards = brain restarted
        try { await this.onIntent(r) } catch (e) { this.log('brain_onintent_error', { message: String(e?.message).slice(0, 150) }) }
        if (!r.changed) await new Promise((res) => setTimeout(res, 300)) // long-poll returned unchanged: avoid a hot loop
      }
    })()
  }
  stop() { this.running = false }
}
