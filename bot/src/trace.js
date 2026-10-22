// JSONL trace logger: logs/trace-YYYYMMDD.jsonl, rotated by size (trace-YYYYMMDD.N.jsonl).
// Synchronous appends of one short line each: ordered, crash-safe, microseconds per call.
import fs from 'node:fs'
import path from 'node:path'

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

export class Trace {
  /**
   * @param {{dir?:string, maxBytes?:number, keepLast?:number, now?:()=>number, echo?:boolean}} o
   * dir omitted => memory only (tests). keepLast = size of the in-memory ring of recent records.
   */
  constructor({ dir = null, maxBytes = 5 * 1024 * 1024, keepLast = 200, now = Date.now, echo = false } = {}) {
    this.dir = dir
    this.maxBytes = maxBytes
    this.keepLast = keepLast
    this.now = now
    this.echo = echo
    this.recent = []
    this.seq = 0
    this.day = null
    this.part = 0
    this.size = 0
    this.file = null
    this.errors = 0
    if (dir) fs.mkdirSync(dir, { recursive: true })
  }

  #open(ts) {
    const day = ymd(new Date(ts))
    if (day !== this.day) {
      this.day = day
      this.part = 0
      this.file = null
    }
    if (!this.file) {
      // continue the latest part of today if it exists and still has room
      let part = 0
      while (fs.existsSync(this.#name(part + 1))) part++
      const cur = this.#name(part)
      const sz = fs.existsSync(cur) ? fs.statSync(cur).size : 0
      if (sz >= this.maxBytes) part++
      this.part = part
      this.file = this.#name(part)
      this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
    }
    if (this.size >= this.maxBytes) {
      this.part++
      this.file = this.#name(this.part)
      this.size = 0
    }
  }

  #name(part) {
    return path.join(this.dir, part === 0 ? `trace-${this.day}.jsonl` : `trace-${this.day}.${part}.jsonl`)
  }

  /** Record one event. Never throws. */
  event(type, fields = {}) {
    const ts = this.now()
    const rec = { t: new Date(ts).toISOString(), ts, seq: ++this.seq, type, ...fields }
    this.recent.push(rec)
    if (this.recent.length > this.keepLast) this.recent.shift()
    let line
    try { line = JSON.stringify(rec) + '\n' } catch { line = JSON.stringify({ t: rec.t, ts, seq: rec.seq, type, unserializable: true }) + '\n' }
    if (this.echo) process.stdout.write(line)
    if (!this.dir) return rec
    try {
      this.#open(ts)
      fs.appendFileSync(this.file, line)
      this.size += Buffer.byteLength(line)
    } catch { this.errors++ }
    return rec
  }

  /** Records of the in-memory ring, optionally filtered by type. */
  last(type) { return type ? this.recent.filter((r) => r.type === type) : [...this.recent] }
  currentFile() { return this.file }
}
