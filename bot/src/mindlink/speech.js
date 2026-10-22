// Fit a line into the in-game chat limit without cutting a sentence in half (Q1: "...see if the world offers me something safe to look at before I try to"
// was said on the real server, cut at 240 chars mid-sentence).
export function fitSpeech(text, max = 240) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const head = t.slice(0, max)
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  if (stop >= 40) return head.slice(0, stop + 1)
  const sp = head.lastIndexOf(' ')
  return (sp > 0 ? head.slice(0, sp) : head).replace(/[,;:\s]+$/, '') + '…'
}

// M4: rate limit without losing the newest thought. Normal lines: 1 per `gap` ms; while waiting only the NEWEST one is kept (older pending lines are
// dropped). Protected lines (an answer to a human, a death / danger report) are never replaced; they queue (max 3) and go out first, 4 s apart.
export const DANGER_RE = /\b(i died|died|dead|dying|in danger|danger|drown(?:ing|ed)?|burning|on fire|lava|trapped|help)\b/i
export class SpeechQueue {
  constructor({ gap = 20000, urgentGap = 4000, maxAge = 60000, maxProtected = 3 } = {}) { Object.assign(this, { gap, urgentGap, maxAge, maxProtected }); this.lastAt = 0; this.pending = null; this.prot = []; this.dropped = 0 }
  /** -> {send: text} to say now, or {queued:true}. */
  offer(text, { protect = false } = {}, now = Date.now()) {
    const wait = now - this.lastAt
    if (protect ? wait >= this.urgentGap : wait >= this.gap) { this.lastAt = now; return { send: text } }
    if (protect) { this.prot.push({ text, at: now }); while (this.prot.length > this.maxProtected) { this.prot.shift(); this.dropped++ } }
    else { if (this.pending) this.dropped++; this.pending = { text, at: now } }
    return { queued: true }
  }
  /** Call every second or two; returns a line to say now or null. */
  drain(now = Date.now()) {
    if (this.pending && now - this.pending.at > this.maxAge) { this.pending = null; this.dropped++ }
    const wait = now - this.lastAt
    if (this.prot.length && wait >= this.urgentGap) { this.lastAt = now; return this.prot.shift().text }
    if (this.pending && wait >= this.gap) { const t = this.pending.text; this.pending = null; this.lastAt = now; return t }
    return null
  }
}
