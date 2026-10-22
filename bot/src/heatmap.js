// Visited-cell heatmap for novelty-biased exploration. Cells are cell x cell blocks in XZ.
import fs from 'node:fs'
import path from 'node:path'

export class Heatmap {
  constructor({ cell = 8, rng = Math.random } = {}) {
    this.cell = cell
    this.rng = rng
    this.counts = new Map() // "cx,cz" -> visits
  }
  key(x, z) { return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}` }
  count(x, z) { return this.counts.get(this.key(x, z)) ?? 0 }
  visit(x, z) { const k = this.key(x, z); this.counts.set(k, (this.counts.get(k) ?? 0) + 1) }
  get size() { return this.counts.size }

  /** Sample candidates on a ring-ish area around origin; prefer the least-visited cell (random tie-break). */
  pickTarget(origin, { radius = 28, samples = 16, minDist = 6 } = {}) {
    let best = null
    for (let i = 0; i < samples; i++) {
      const ang = this.rng() * Math.PI * 2
      const d = minDist + this.rng() * (radius - minDist)
      const x = origin.x + Math.cos(ang) * d
      const z = origin.z + Math.sin(ang) * d
      // visits of the target cell, plus a little of its 4 neighbours so we prefer open unexplored regions
      let score = this.count(x, z)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) score += 0.25 * this.count(x + dx * this.cell, z + dz * this.cell)
      score += this.rng() * 0.2
      if (!best || score < best.score) best = { x, z, score }
    }
    return best
  }

  save(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ cell: this.cell, counts: [...this.counts] }))
    fs.renameSync(tmp, file)
  }
  load(file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (j.cell === this.cell && Array.isArray(j.counts)) this.counts = new Map(j.counts)
      return true
    } catch { return false }
  }
}
