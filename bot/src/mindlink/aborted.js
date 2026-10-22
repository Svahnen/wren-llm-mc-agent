// M4: a skill that was aborted after real effort (>= 30 s, or it moved / gained something) still happened to her and belongs in her memory.
// Pure helpers + a small dedupe/rate-limit log so a shelter that is interrupted ten times is ONE episode with a count, not ten.
export const ABORT_MIN_MS = 30000
export const ABORT_MIN_MOVE = 8
export const ABORT_WINDOW_MS = 10 * 60000   // repeats of the same (skill, reason) inside this window are merged
export const ABORT_MAX_PER_WINDOW = 6       // hard cap on aborted-skill episodes per window

/** Runner abort reason -> {kind, by}. reflex / unstuck / preempted (intent, human, superseded) / other. */
export function abortKind(reason) {
  const r = String(reason ?? '')
  const m = /^preempted_by:reflex[:/]?(.*)$/.exec(r)
  if (m) return { kind: 'reflex', by: m[1] || null }
  if (/unstuck/.test(r)) return { kind: 'unstuck', by: null }
  if (/^preempted_by|^superseded$|human_override/.test(r)) return { kind: 'preempted', by: null }
  return { kind: r || 'unknown', by: null }
}

export function invCounts(items = []) {
  const m = {}
  for (const i of items) if (i?.name) m[i.name] = (m[i.name] ?? 0) + (i.count ?? 1)
  return m
}
export function invGain(before = {}, after = {}) {
  const g = {}
  for (const [n, c] of Object.entries(after)) { const d = c - (before[n] ?? 0); if (d > 0) g[n] = d }
  return g
}
const gainText = (g) => Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${c} ${n.replace(/_/g, ' ')}`).join(', ')
const durText = (ms) => ms >= 90000 ? `${Math.round(ms / 60000)} minutes` : `${Math.round(ms / 1000)} seconds`

export function worthRecording({ ms, moved, gains }) {
  return ms >= ABORT_MIN_MS || moved >= ABORT_MIN_MOVE || Object.keys(gains ?? {}).length > 0
}

export class AbortLog {
  constructor() { this.map = new Map(); this.recent = [] }
  /** Returns the episode to write now ({text, outcome, goal, count}) or null (not worth it / merged into a pending repeat / rate limited). */
  note({ goal, reason, ms, moved = 0, gains = {}, now = Date.now() }) {
    if (!worthRecording({ ms, moved, gains })) return null
    const { kind, by } = abortKind(reason), key = goal + '|' + kind
    const cur = this.map.get(key)
    if (cur && now - cur.firstAt < ABORT_WINDOW_MS) { // repeat: count it, write the summary later (flush)
      cur.count++; cur.ms += ms; cur.moved += moved
      for (const [n, c] of Object.entries(gains)) cur.gains[n] = (cur.gains[n] ?? 0) + c
      cur.lastAt = now; return null
    }
    this.recent = this.recent.filter((t) => now - t < ABORT_WINDOW_MS)
    if (this.recent.length >= ABORT_MAX_PER_WINDOW) return null
    this.recent.push(now)
    this.map.set(key, { firstAt: now, lastAt: now, count: 0, ms: 0, moved: 0, gains: {}, goal, kind, by })
    return { goal, kind, count: 1, text: this.#text({ goal, kind, by, count: 1, ms, moved, gains }) }
  }
  /** Merged repeats whose window ended -> one summary episode each. */
  flush(now = Date.now()) {
    const out = []
    for (const [key, c] of this.map) {
      if (now - c.firstAt < ABORT_WINDOW_MS) continue
      this.map.delete(key)
      if (c.count > 0) out.push({ goal: c.goal, kind: c.kind, count: c.count, text: this.#text({ ...c, again: true }) })
    }
    return out
  }
  #text({ goal, kind, by, count, ms, moved, gains, again }) {
    const what = goal.replace(/_/g, ' ')
    const why = kind === 'reflex' ? `a reflex${by ? ' (' + by.replace(/_/g, ' ') + ')' : ''}` : kind === 'unstuck' ? 'getting unstuck' : kind === 'preempted' ? 'a new decision' : kind
    const g = gainText(gains)
    const tail = [moved >= ABORT_MIN_MOVE ? `moved about ${Math.round(moved)} blocks` : null, g ? `gained ${g}` : null].filter(Boolean).join(', ')
    if (again) return `I was interrupted again ${count} more time${count === 1 ? '' : 's'} while I tried to ${what}, by ${why}, about ${durText(ms)} in total${tail ? '; ' + tail : ''}`
    return `I was interrupted by ${why} while I was doing ${what}, after ${durText(ms)}${tail ? '; ' + tail : ''}`
  }
}
