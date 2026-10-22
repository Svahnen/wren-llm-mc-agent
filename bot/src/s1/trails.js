// S1G: walked-trail graph for long-range travel between places. Every position she stands on while walking is snapped to a 8-block cell; consecutive
// cells are linked, so the graph is made of routes she has ACTUALLY walked (safe: no lava, no cliff she did not already cross). planRoute() finds a chain
// of waypoints between two points along that graph (Dijkstra); the navigator (navigate.js) follows it hop by hop and re-plans on failure.
import fs from 'node:fs'
import path from 'node:path'

const r1 = (v) => Math.round(v * 10) / 10
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export class TrailGraph {
  constructor({ cell = 8, file = null, maxNodes = 6000, linkMax = 28 } = {}) {
    Object.assign(this, { cell, file, maxNodes, linkMax })
    this.nodes = new Map()   // key -> {x,y,z,n}
    this.adj = new Map()     // key -> Map(neighbourKey -> weight)
    this.bad = new Map()     // key -> until (ms): a waypoint that failed recently; routes avoid it
    this.prev = null
    this.dirty = 0
    if (file) this.load()
  }
  key(p) { return `${Math.floor(p.x / this.cell)},${Math.floor(p.y / this.cell)},${Math.floor(p.z / this.cell)}` }
  get size() { return this.nodes.size }
  /** Record a standing position. Returns true when a new node or edge was added. */
  record(p, onGround = true) {
    if (!onGround || !p || !Number.isFinite(p.x)) return false
    const k = this.key(p)
    let added = false
    let n = this.nodes.get(k)
    if (!n) {
      if (this.nodes.size >= this.maxNodes) return false
      n = { x: r1(p.x), y: r1(p.y), z: r1(p.z), n: 0 }; this.nodes.set(k, n); this.adj.set(k, new Map()); added = true
    }
    n.n++
    if (this.prev && this.prev.k !== k) {
      const pn = this.nodes.get(this.prev.k)
      const w = pn ? d3(pn, n) : Infinity
      if (pn && w <= this.linkMax && !this.adj.get(k).has(this.prev.k)) { this.adj.get(k).set(this.prev.k, w); this.adj.get(this.prev.k).set(k, w); added = true }
    }
    this.prev = { k, t: Date.now() }
    if (added && ++this.dirty >= 40) this.save()
    return added
  }
  /** a teleport / respawn / long gap: do not link the next sample to the last one */
  breakLink() { this.prev = null }
  markBad(p, ms = 120000, now = Date.now()) { const k = this.key(p); this.bad.set(k, now + ms) }
  nearest(p, maxD = 30, now = Date.now()) {
    let best = null, bd = maxD
    for (const [k, n] of this.nodes) {
      if ((this.bad.get(k) ?? 0) > now) continue
      const d = d3(n, p); if (d < bd) { bd = d; best = k }
    }
    return best
  }
  /** Waypoints [{x,y,z}] from `from` to `to` along walked trails, ending at `to`. null when the graph has no connected route. */
  route(from, to, { now = Date.now(), snap = 30 } = {}) {
    const a = this.nearest(from, snap, now), b = this.nearest(to, snap, now)
    if (!a || !b) return null
    const dist = new Map([[a, 0]]), prev = new Map(), done = new Set()
    const open = [[0, a]]
    while (open.length) {
      open.sort((x, y) => x[0] - y[0])
      const [dd, k] = open.shift()
      if (done.has(k)) continue
      done.add(k)
      if (k === b) break
      for (const [nk, w] of this.adj.get(k) ?? []) {
        if (done.has(nk) || (this.bad.get(nk) ?? 0) > now) continue
        const nd = dd + w
        if (nd < (dist.get(nk) ?? Infinity)) { dist.set(nk, nd); prev.set(nk, k); open.push([nd, nk]) }
      }
    }
    if (!done.has(b)) return null
    const chain = []
    for (let k = b; k !== undefined; k = prev.get(k)) chain.push(k)
    chain.reverse()
    const pts = chain.map((k) => ({ ...this.nodes.get(k) })).map(({ x, y, z }) => ({ x, y, z }))
    // keep a waypoint roughly every 24 blocks, always the last one; the exact target ends the chain
    const out = []
    let last = from
    for (let i = 0; i < pts.length; i++) { if (i === pts.length - 1 || d3(pts[i], last) >= 24) { out.push(pts[i]); last = pts[i] } }
    out.push({ x: to.x, y: to.y ?? pts.at(-1).y, z: to.z })
    return out
  }
  save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const nodes = [...this.nodes].map(([k, n]) => [k, n.x, n.y, n.z, n.n])
      const edges = []; for (const [k, m] of this.adj) for (const [nk, w] of m) if (k < nk) edges.push([k, nk, r1(w)])
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ cell: this.cell, nodes, edges }))
      fs.renameSync(`${this.file}.tmp`, this.file); this.dirty = 0
    } catch { /* non-fatal */ }
  }
  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (j.cell !== this.cell) return
      for (const [k, x, y, z, n] of j.nodes) { this.nodes.set(k, { x, y, z, n }); this.adj.set(k, new Map()) }
      for (const [a, b, w] of j.edges) if (this.adj.has(a) && this.adj.has(b)) { this.adj.get(a).set(b, w); this.adj.get(b).set(a, w) }
    } catch { /* first run */ }
  }
  /** sampling timer: once per second while standing on the ground and alive */
  attach(getBot, everyMs = 1000) {
    const t = setInterval(() => {
      const bot = getBot(); const e = bot?.entity
      if (e?.position && bot.health > 0) this.record(e.position, !!e.onGround); else this.breakLink()
    }, everyMs)
    t.unref?.()
    return () => clearInterval(t)
  }
}

/** Chunk-aware hop planning when no trail connects: a straight chain of hops of at most `hop` blocks toward the target (a far y/column in an unloaded
 *  chunk cannot be snapped to a standable cell, so each hop stays inside the loaded area). */
export function straightHops(from, to, hop = 40) {
  const dx = to.x - from.x, dz = to.z - from.z, d = Math.hypot(dx, dz)
  if (d <= hop) return [{ x: to.x, y: to.y ?? from.y, z: to.z }]
  const n = Math.ceil(d / hop), out = []
  for (let i = 1; i <= n; i++) { const t = i / n; out.push({ x: Math.round(from.x + dx * t), y: Math.round(from.y + ((to.y ?? from.y) - from.y) * t), z: Math.round(from.z + dz * t) }) }
  return out
}
