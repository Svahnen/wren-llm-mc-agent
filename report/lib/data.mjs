// Loaders. Every loader tolerates missing files/dirs/corrupt lines and returns empty data instead of throwing.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function readJsonl(file) {
  let txt = ''
  try { txt = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue
    try { const r = JSON.parse(line); if (r && typeof r === 'object') out.push(r) } catch { /* partial last line / corrupt: skip */ }
  }
  return out
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

const listDir = (dir) => { try { return fs.readdirSync(dir) } catch { return [] } }

const tsOf = (r) => (Number.isFinite(r.ts) ? r.ts : Date.parse(typeof r.ts === 'string' ? r.ts : r.t ?? '') || null)

/** All bot traces (top-level trace-YYYYMMDD[.N].jsonl only: test-run subdirectories are ignored), sorted by time. */
export function loadTraces(dir) {
  const files = listDir(dir).filter((f) => /^trace-\d{8}(\.\d+)?\.jsonl$/.test(f)).sort()
  const events = []
  for (const f of files) for (const r of readJsonl(path.join(dir, f))) { const ts = tsOf(r); if (ts !== null) { r.ts = ts; events.push(r) } }
  events.sort((a, b) => a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0))
  return { files, events }
}

/** Brain logs: brain-YYYY-MM-DD.jsonl (decisions) and llm-YYYY-MM-DD.jsonl (raw calls); top level only (bake-* dirs are experiments). */
export function loadBrain(dir) {
  const files = listDir(dir).filter((f) => /^(brain|llm)-.*\.jsonl$/.test(f)).sort()
  const brain = [], llm = []
  for (const f of files) for (const r of readJsonl(path.join(dir, f))) {
    const ts = tsOf(r)
    if (ts === null) continue
    r.ts = ts
    ;(f.startsWith('llm-') ? llm : brain).push(r)
  }
  brain.sort((a, b) => a.ts - b.ts); llm.sort((a, b) => a.ts - b.ts)
  return { files, brain, llm }
}

export function findMindDb(root = ROOT, explicit = null) {
  const cands = [explicit, process.env.MIND_DB, ...['bot/runtime', 'brain/runtime', 'runtime', 'mind/runtime', 'mind'].map((d) => path.join(root, d, 'mind.sqlite'))].filter(Boolean)
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c } catch { /* next */ } }
  for (const d of ['bot/runtime', 'brain/runtime', 'runtime', 'mind/runtime']) {
    const hit = listDir(path.join(root, d)).find((f) => /\.(sqlite|db)$/.test(f) && !/-(wal|shm)$/.test(f))
    if (hit) return path.join(root, d, hit)
  }
  return null
}

/** Read-only snapshot of the mind DB, or null. Never writes; failures give {error}. */
export async function loadMind(file) {
  if (!file) return null
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch (e) { return { file, error: 'node:sqlite unavailable' } }
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const all = (sql) => { try { return db.prepare(sql).all() } catch { return [] } }
    const count = (t) => { try { return db.prepare(`SELECT count(*) c FROM ${t}`).get().c } catch { return null } }
    return {
      file,
      counts: Object.fromEntries(['episodes', 'facts', 'lessons', 'places', 'reflections', 'preferences'].map((t) => [t, count(t)])),
      lessons: all('SELECT goal_type,cell,x,y,z,approach,result,cause,extent,count,used_count,changed_count,created_t,last_t FROM lessons ORDER BY last_t DESC LIMIT 200'),
      preferences: all('SELECT activity,pleasant_count,days,status,first_t,last_t FROM preferences ORDER BY pleasant_count DESC LIMIT 50'),
      reflections: all('SELECT t,text FROM reflections ORDER BY t DESC LIMIT 20'),
      self_summary: all('SELECT version,t,text,author FROM self_summary ORDER BY version DESC LIMIT 1')[0] ?? null,
      goals: (() => { try { const r = db.prepare("SELECT value FROM meta WHERE key='state_goals'").get(); return r ? JSON.parse(r.value) : null } catch { return null } })(),
      core: all('SELECT t,text FROM core_memories ORDER BY t DESC LIMIT 20'),
      episodes: all('SELECT t,kind,text,cell,x,z,activity,goal_type,outcome,importance,valence FROM episodes WHERE archived=0 ORDER BY t DESC LIMIT 400'),
      places: all('SELECT cell,visits,danger,name FROM places ORDER BY visits DESC LIMIT 12'),
      relationships: all('SELECT name,familiarity,affinity,interactions FROM relationships ORDER BY interactions DESC LIMIT 12'),
    }
  } catch (e) {
    return { file, error: String(e?.message ?? e) }
  } finally { try { db?.close() } catch { /* ignore */ } }
}

/** Mind timestamps are game seconds unless they look like epoch; returns epoch ms or null. */
export function mindEpoch(t) {
  if (!Number.isFinite(t)) return null
  if (t > 1e12) return t
  if (t > 1e9) return t * 1000
  return null
}
export const GAME_DAY_S = 1200

export function loadAll({ root = ROOT, logsDir, runtimeDir, brainDir, mindDb } = {}) {
  const ld = logsDir ?? path.join(root, 'bot', 'logs')
  const rd = runtimeDir ?? path.join(root, 'bot', 'runtime')
  const bd = brainDir ?? path.join(root, 'brain', 'logs')
  const trace = loadTraces(ld)
  return {
    root, logsDir: ld, runtimeDir: rd, brainDir: bd,
    trace,
    metrics: readJson(path.join(rd, 'metrics.json')),
    heat: readJson(path.join(rd, 'heatmap.json')),
    landmarks: readJson(path.join(rd, 'landmarks.json')),
    brain: { ...loadBrain(bd), thoughts: readJsonl(path.join(ld, 'thoughts.jsonl')).slice(-400) }, // AI1: inner thoughts (bot/logs/thoughts.jsonl)
    mindFile: findMindDb(root, mindDb),
  }
}
