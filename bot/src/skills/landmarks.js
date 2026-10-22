// Landmarks (home, bed, chests, named places) and the breadcrumb trail. Both are persisted (atomic JSON) so a restart keeps home.
import fs from 'node:fs'
import path from 'node:path'

const r1 = (v) => Math.round(v * 10) / 10

export class Landmarks {
  constructor({ file = null } = {}) {
    this.file = file
    this.places = {} // name -> {x,y,z,kind,t}
    if (file) this.load()
  }
  set(name, p, kind = 'place') { this.places[name] = { x: r1(p.x), y: r1(p.y), z: r1(p.z), kind, t: Date.now() }; this.save(); return this.places[name] }
  get(name) { return this.places[name] ?? null }
  get home() { return this.places.home ?? null }
  list() { return Object.entries(this.places).map(([id, v]) => ({ id, ...v })) }
  nearest(kind, from) {
    let best = null, bd = Infinity
    for (const [id, v] of Object.entries(this.places)) {
      if (v.kind !== kind) continue
      const d = Math.hypot(v.x - from.x, v.y - from.y, v.z - from.z)
      if (d < bd) { bd = d; best = { id, ...v, dist: d } }
    }
    return best
  }
  forget(name) { delete this.places[name]; this.save() }
  save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ places: this.places }))
      fs.renameSync(`${this.file}.tmp`, this.file)
    } catch { /* non-fatal */ }
  }
  load() {
    try { this.places = JSON.parse(fs.readFileSync(this.file, 'utf8')).places ?? {} } catch { this.places = {} }
  }
}

/** Breadcrumb trail: a safe route recorded every `step` blocks of travel while standing on the ground. */
export class Trail {
  constructor({ step = 8, max = 500 } = {}) { this.step = step; this.max = max; this.crumbs = [] }
  /** Record the position if it is >= step away from the last crumb. Returns true if recorded. */
  record(p, onGround = true) {
    if (!onGround) return false
    const last = this.crumbs[this.crumbs.length - 1]
    if (last && Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) < this.step) return false
    this.crumbs.push({ x: r1(p.x), y: r1(p.y), z: r1(p.z) })
    if (this.crumbs.length > this.max) this.crumbs.shift()
    return true
  }
  /** Crumbs newest first. */
  reversed() { return [...this.crumbs].reverse() }
  clear() { this.crumbs = [] }
  get length() { return this.crumbs.length }
  /** Start sampling the bot once per second (returns stop fn). */
  attach(getBot, everyMs = 1000) {
    const t = setInterval(() => {
      const bot = getBot()
      const e = bot?.entity
      if (e?.position && bot.health > 0) this.record(e.position, !!e.onGround)
    }, everyMs)
    t.unref?.()
    return () => clearInterval(t)
  }
}
