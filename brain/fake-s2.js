// Fake S2 with the same interface as LlmClient.complete(). Modes:
//  same     : the same goal forever (explore, same words)
//  garbage  : unparseable text
//  stall    : never answers until aborted or stallMs (default 10 min)
//  random   : plausible-random valid-looking output using ids from the prompt's STATE block
//  scripted : opts.script = array of strings | functions(messages, n) -> string ; cycles at the end
//  invalid  : parses fine but uses ids that do not exist (semantic garbage)
import { LlmError } from './llm.js'

export class FakeS2 {
  constructor({ mode = 'random', script = [], stallMs = 600_000, latencyMs = 5, seed = 1 } = {}) {
    Object.assign(this, { mode, script, stallMs, latencyMs }); this.n = 0; this.calls = []; this.s = seed
  }
  rnd() { this.s = (this.s * 1664525 + 1013904223) >>> 0; return this.s / 2 ** 32 }
  pick(a) { return a[Math.floor(this.rnd() * a.length)] }
  async complete({ messages, signal, timeoutMs = 20000, onText, kind } = {}) {
    const n = this.n++
    this.calls.push({ messages, kind })
    await this.sleep(this.mode === 'stall' ? this.stallMs : this.latencyMs, signal, timeoutMs)
    let text
    if (this.mode === 'same') text = '{act:explore,args:{}}\n---\nI want to see what is further on.'
    else if (this.mode === 'garbage') text = 'Sure! Here is what I would do ```json {"go": 1}``` lol'
    else if (this.mode === 'invalid') text = '{act:approach,args:{target:nonexistent_9}}\n---\nOver there.'
    else if (this.mode === 'scripted') { const e = this.script[n % this.script.length]; text = typeof e === 'function' ? e(messages, n) : e }
    else if (this.mode === 'stall') text = '{act:none,args:{}}\n---\nSorry, I was thinking.'
    else text = this.randomOut(messages)
    if (onText && onText(text) === 'stop') return { text, ttft_ms: this.latencyMs, total_ms: this.latencyMs, tokens: 30, early_stopped: true }
    return { text, ttft_ms: this.latencyMs, total_ms: this.latencyMs, tokens: Math.ceil(text.length / 4) }
  }
  randomOut(messages) {
    const u = messages.map((m) => m.content).join('\n')
    const ids = [...u.matchAll(/^- ([A-Za-z0-9_]+) \|/gm)].map((m) => m[1])
    const players = (u.match(/players online: ([^\n]*)/)?.[1] ?? '').split(',').map((s) => s.replace(/\(.*?\)/, '').trim()).filter((s) => s && s !== 'none')
    const acts = ['none', 'idle_activity', 'gesture', 'explore', 'explore']
    if (ids.length) acts.push('approach', 'interact')
    if (players.length) acts.push('follow')
    const a = this.pick(acts)
    const args = { none: '', idle_activity: `kind:${this.pick(['look_around', 'sit', 'watch_sky', 'rest'])}`, gesture: `kind:${this.pick(['wave', 'nod', 'jump'])}`, explore: '',
      approach: `target:${ids.length ? this.pick(ids) : 'x'}`, interact: `target:${ids.length ? this.pick(ids) : 'x'},verb:${this.pick(['look', 'talk'])}`, follow: `target:${players[0]}` }[a]
    return `{act:${a},args:{${args}}}\n---\n${this.pick(['Let me see.', 'I am curious about this.', 'Okay.', 'Going on.'])}`
  }
  sleep(ms, signal, timeoutMs) {
    return new Promise((res, rej) => {
      const t = setTimeout(done, Math.min(ms, ms > timeoutMs ? timeoutMs : ms))
      const to = ms > timeoutMs
      function done() { cleanup(); to ? rej(new LlmError('timeout', 'fake timeout')) : res() }
      const onAbort = () => { cleanup(); rej(new LlmError('aborted', 'aborted')) }
      function cleanup() { clearTimeout(t); signal?.removeEventListener('abort', onAbort) }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  async health() { return true }
}
