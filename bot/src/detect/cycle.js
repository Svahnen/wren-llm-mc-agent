// Repeat detectors: goal cycles (period 2..6), repeated visits to a 3-block cell, action n-grams, chat text similarity.

/** Cycles on (goal type, target place) sequences in a sliding window. */
export class CycleDetector {
  constructor({ now = Date.now, windowMs = 30 * 60e3, minPeriod = 2, maxPeriod = 6, minReps = 3 } = {}) {
    Object.assign(this, { now, windowMs, minPeriod, maxPeriod, minReps })
    this.h = []
    this.detections = 0
  }
  record(type, place = null) {
    const t = this.now()
    this.h.push({ t, type, place, key: `${type}@${place ?? '*'}` })
    this.h = this.h.filter((x) => t - x.t <= this.windowMs).slice(-200)
    const d = this.check()
    if (d) { this.detections++; this.h = [] }
    return d
  }
  check() {
    const h = this.h, n = h.length
    for (let p = this.minPeriod; p <= this.maxPeriod; p++) {
      const need = p * this.minReps
      if (n < need) continue
      let ok = true
      for (let i = n - need + p; i < n && ok; i++) if (h[i].key !== h[i - p].key) ok = false
      if (!ok) continue
      const tail = h.slice(n - p)
      if (new Set(tail.map((x) => x.key)).size < 2) continue // same goal repeated is the repeat counter's job
      return { kind: 'cycle', period: p, reps: this.minReps, goals: tail.map((x) => ({ type: x.type, place: x.place })), keys: [...new Set(tail.map((x) => x.key))] }
    }
    return null
  }
}

/** Visits to the same 3-block cell per hour. A visit = entering a cell not seen for `gapMs`. */
export class VisitCounter {
  constructor({ now = Date.now, cell = 3, windowMs = 3600e3, maxVisits = 8, gapMs = 20e3, exemptRadius = 6 } = {}) {
    Object.assign(this, { now, cell, windowMs, maxVisits, gapMs, exemptRadius })
    this.cells = new Map() // key -> {visits:[t], seen, flaggedAt}
    this.exempt = []
  }
  addExempt(pos, radius = this.exemptRadius) { this.exempt.push({ x: pos.x, y: pos.y, z: pos.z, r: radius }) }
  keyOf(p) { const c = this.cell; return `${Math.floor(p.x / c)},${Math.floor(p.y / c)},${Math.floor(p.z / c)}` }
  observe(pos) {
    const t = this.now(), k = this.keyOf(pos)
    let e = this.cells.get(k)
    if (!e) { e = { visits: [], seen: -Infinity, flaggedAt: -Infinity }; this.cells.set(k, e) }
    const isNew = t - e.seen > this.gapMs
    e.seen = t
    if (!isNew) return null
    e.visits = e.visits.filter((x) => t - x < this.windowMs)
    e.visits.push(t)
    if (this.cells.size > 4000) for (const [kk, v] of this.cells) if (t - v.seen > this.windowMs) this.cells.delete(kk)
    if (e.visits.length >= this.maxVisits && t - e.flaggedAt > this.windowMs) {
      if (this.exempt.some((x) => Math.hypot(pos.x - x.x, pos.z - x.z) <= x.r && Math.abs(pos.y - x.y) <= 8)) return null
      e.flaggedAt = t
      return { kind: 'repeat_visit', cell: k, visits: e.visits.length, place: k }
    }
    return null
  }
}

/** Action n-gram repeat counter + Shannon entropy over the recent window. */
export class NgramCounter {
  constructor({ n = 3, window = 60, threshold = 6 } = {}) { Object.assign(this, { n, window, threshold }); this.a = []; this.detections = 0 }
  push(action) {
    this.a.push(String(action))
    if (this.a.length > this.window) this.a.shift()
    const m = new Map()
    for (let i = 0; i + this.n <= this.a.length; i++) { const g = this.a.slice(i, i + this.n).join('>'); m.set(g, (m.get(g) ?? 0) + 1) }
    let best = null
    for (const [g, c] of m) if (!best || c > best.count) best = { gram: g, count: c }
    if (best && best.count >= this.threshold && new Set(best.gram.split('>')).size >= 1) {
      this.detections++; this.a = []
      return { kind: 'ngram_repeat', ...best }
    }
    return null
  }
  entropy() {
    const m = new Map()
    for (const x of this.a) m.set(x, (m.get(x) ?? 0) + 1)
    let h = 0
    for (const c of m.values()) { const p = c / this.a.length; h -= p * Math.log2(p) }
    return +h.toFixed(3)
  }
}

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
const bigrams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1) } return m }
/** Dice coefficient on character bigrams, 0..1. */
export function textSimilarity(a, b) {
  a = norm(a); b = norm(b)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const A = bigrams(a), B = bigrams(b)
  let inter = 0
  for (const [g, c] of A) inter += Math.min(c, B.get(g) ?? 0)
  return (2 * inter) / (a.length - 1 + b.length - 1)
}

/** Has she said (nearly) this to this player recently? */
export class ChatRepeat {
  constructor({ now = Date.now, windowMs = 10 * 60e3, threshold = 0.8, keep = 30 } = {}) { Object.assign(this, { now, windowMs, threshold, keep }); this.h = [] }
  check(text, to = null) {
    const t = this.now()
    let best = { similarity: 0, matched: null }
    for (const x of this.h) {
      if (t - x.t > this.windowMs || (to !== null && x.to !== to)) continue
      const s = textSimilarity(text, x.text)
      if (s > best.similarity) best = { similarity: +s.toFixed(3), matched: x.text }
    }
    return { repeat: best.similarity >= this.threshold, ...best }
  }
  /** check, then record. */
  say(text, to = null) { const r = this.check(text, to); this.h.push({ t: this.now(), text, to }); if (this.h.length > this.keep) this.h.shift(); return r }
}
