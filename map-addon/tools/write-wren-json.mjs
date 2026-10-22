#!/usr/bin/env node
// Builds config/wrenmap/wren.json for the wrenmap Fabric mod every 2 s (atomic: temp + rename).
// Not wired into the bot: run it next to the bot, e.g.  node map-addon/tools/write-wren-json.mjs [--once]
// Sources (read only): bot/runtime/mind.sqlite (active goal, deaths), bot/runtime/landmarks.json (home, named places),
// bot/logs/thoughts.jsonl (latest thought + position trail). Output: server/data/config/wrenmap/wren.json.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const P = {
  out: process.env.WRENMAP_OUT ?? path.join(ROOT, 'server/data/config/wrenmap/wren.json'),
  db: path.join(ROOT, 'bot/runtime/mind.sqlite'),
  landmarks: path.join(ROOT, 'bot/runtime/landmarks.json'),
  thoughts: path.join(ROOT, 'bot/logs/thoughts.jsonl'),
  metrics: path.join(ROOT, 'bot/runtime/metrics.json'),
}
const EVERY_MS = 2000, TRAIL_MAX = 200, TAIL_BYTES = 256 * 1024
const r1 = (v) => Math.round(v * 10) / 10
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

function tailLines(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r')
    const { size } = fs.fstatSync(fd), n = Math.min(size, bytes), buf = Buffer.alloc(n)
    fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    if (size > n) lines.shift() // first line is probably cut
    return lines
  } catch { return [] }
}

const live = [] // OPS5: Wren's own recent positions sampled from bot/runtime/metrics.json (updated by the bot every few seconds)
function sampleLive() {
  const p = readJson(P.metrics)?.pos
  if (!Array.isArray(p) || p.length < 3 || p.some((v) => typeof v !== 'number')) return
  const q = [r1(p[0]), r1(p[1]), r1(p[2])], prev = live.at(-1)
  if (!prev || Math.hypot(prev[0] - q[0], prev[2] - q[2]) > 1.5) { live.push(q); if (live.length > TRAIL_MAX) live.shift() }
}

export function build() {
  sampleLive()
  const out = { trail: [], home: null, deaths: [], goal: '', thought: '', places: [] }
  // thoughts: latest "thought" text + trail from the logged positions
  const th = tailLines(P.thoughts, TAIL_BYTES).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const lastThought = [...th].reverse().find((t) => t.text && t.kind === 'thought') ?? th.at(-1)
  if (lastThought) out.thought = String(lastThought.text).slice(0, 300)
  for (const t of th) {
    const p = t.pos
    if (!Array.isArray(p) || p.length < 3) continue
    const q = [r1(p[0]), r1(p[1]), r1(p[2])], prev = out.trail.at(-1)
    if (!prev || Math.hypot(prev[0] - q[0], prev[2] - q[2]) > 2) out.trail.push(q)
  }
  if (live.length >= 2) out.trail = live.slice() // live samples beat sparse thought positions once we have a line
  out.trail = out.trail.slice(-TRAIL_MAX)
  // landmarks: home + named places (bed and others)
  const lm = readJson(P.landmarks)?.places ?? {}
  for (const [name, v] of Object.entries(lm)) {
    if (typeof v?.x !== 'number') continue
    const pos = [r1(v.x), r1(v.y), r1(v.z)]
    if (name === 'home') out.home = pos
    else out.places.push({ name: v.note ? `${name} (${v.note})` : name, pos })
  }
  // mind db: deaths + active goal
  let db
  try {
    db = new DatabaseSync(P.db, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 500')
    for (const d of db.prepare("SELECT text,x,y,z,day FROM episodes WHERE kind='death' AND x IS NOT NULL ORDER BY id DESC LIMIT 30").all().reverse()) {
      const m = /died \(([^)]*)\)/.exec(d.text)
      out.deaths.push({ pos: [r1(d.x), r1(d.y), r1(d.z)], cause: m?.[1] ?? 'unknown', t: d.day != null ? `day ${d.day}` : '' })
    }
    const row = db.prepare("SELECT value FROM meta WHERE key='state_goals'").get()
    const goals = row ? JSON.parse(row.value).goals ?? [] : []
    const g = goals.filter((x) => x.status === 'active').at(-1)
    if (g) out.goal = String(g.text + (g.why ? ` (${g.why})` : '')).slice(0, 300)
  } catch { /* db busy or missing: keep the rest */ } finally { try { db?.close() } catch {} }
  return out
}

export function writeOnce() {
  const body = JSON.stringify(build())
  fs.mkdirSync(path.dirname(P.out), { recursive: true })
  const tmp = `${P.out}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body); fs.renameSync(tmp, P.out)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeOnce()
  if (!process.argv.includes('--once')) setInterval(() => { try { writeOnce() } catch (e) { console.error('wren-json:', e.message) } }, EVERY_MS)
}
