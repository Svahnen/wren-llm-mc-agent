// In-game chat as a first-class channel (V4): global text everyone on the server sees, at any distance. Voice (SAY) is proximity only.
// Pure helpers: safe splitting for Minecraft's 256-char limit, no command injection (never a line starting with '/'), output rate limit, own-state importance.
import fs from 'node:fs'
import path from 'node:path'

export const CHAT_MAX = 240   // Minecraft allows 256; keep a margin

/** SEC1: the single string that may reach bot.chat() from model text: control chars/§ removed, whitespace collapsed, ALL leading command-ish prefix characters
 *  ('/', '\\', '!', '.', '#', '~', '`', '@', '$', '%', ':' and spaces) stripped, hard cap CHAT_MAX. '' when nothing safe is left. */
export function sanitizeChatOut(text, max = CHAT_MAX) {
  const t = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff§]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s/\\!.#~`@$%:]+/, '').trim()
  return t.slice(0, max).trim()
}

/** Text -> the chat lines to send (<= CHAT_MAX each, at most `maxLines`). Control characters removed; a line that starts with '/' (a command) is dropped. */
export function chatLines(text, { max = CHAT_MAX, maxLines = 2 } = {}) {
  let t = String(text ?? '').replace(/[\u0000-\u001f\u007f§]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t || t.startsWith('/')) return []
  const out = []
  while (t && out.length < maxLines) {
    if (t.length <= max) { out.push(t); t = ''; break }
    const head = t.slice(0, max)
    let cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
    cut = cut >= 40 ? cut + 1 : head.lastIndexOf(' ')
    if (cut < 20) cut = max
    out.push(t.slice(0, cut).trim()); t = t.slice(cut).trim()
  }
  if (t && out.length) out[out.length - 1] = out[out.length - 1].replace(/[,;:\s]+$/, '') + '…'
  return out.filter((l) => l && !l.startsWith('/'))
}

/** Sliding-window limiter: at most `perMin` chat lines per minute and `gapMs` between messages. -> {ok} | {ok:false, retryMs} */
export class ChatLimiter {
  constructor({ perMin = 8, gapMs = 1500 } = {}) { Object.assign(this, { perMin, gapMs }); this.t = [] }
  take(n = 1, now = Date.now()) {
    this.t = this.t.filter((x) => now - x < 60000)
    if (this.t.length && now - this.t.at(-1) < this.gapMs) return { ok: false, retryMs: this.gapMs - (now - this.t.at(-1)) }
    if (this.t.length + n > this.perMin) return { ok: false, retryMs: 60000 - (now - this.t[0]) }
    for (let i = 0; i < n; i++) this.t.push(now + i)
    return { ok: true }
  }
}

const OWN_STATE_RE = /\b(starv\w*|hungry|food (?:is )?(?:at )?(?:zero|low|empty)|no food|low health|health (?:is )?(?:low|critical)|almost dead|nearly dead|about to die|dying|bleeding|freezing|exhausted)\b/i
/** Importance (0..1) of a spoken line about her own urgent state; null when the text says nothing like that. Perception of the text, not a decision. */
export function stateImportance(text) { return OWN_STATE_RE.test(String(text ?? '')) ? 0.75 : null }

/** Append one JSON line to each file (best effort, never throws). Used for the chat transcript of the run (text only). */
export function appendJsonl(files, rec) {
  const line = JSON.stringify(rec) + '\n'
  for (const f of files.filter(Boolean)) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, line) } catch {} }
}
