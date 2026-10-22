// TR1: learned System-1 option scorer (default OFF). A small gradient-boosted-tree reward model trained offline on habit_choice logs (you supply the model file). It re-scores the top candidate habits of the utility ranking and can blend into the utility score.
//   WREN_SCORER=off|shadow|blend   off (default): nothing changes, nothing extra is logged. shadow: scores are computed and logged, the choice is NOT changed.
//                                  blend: score = (1-w)*utility + w*K*predicted_reward, re-ranking only the top MAX_CANDIDATES habits.
//   WREN_SCORER_WEIGHT=0..1        w (default: the model file's default_mix, 0.5)
//   WREN_SCORER_PROTECT=<score>    decisions whose top utility is >= this (default: model file, 5) are never re-ranked: take_cover/shelter/sleep/hunger boosts keep priority
//   WREN_SCORER_MODEL=<path>       default bot/models/s1-scorer.json (not shipped: train your own, or leave WREN_SCORER=off)
// Features are built BY NAME from the model file, in the same way as training/tr1lib.py option_vec (keep both in sync; test/learned-scorer.test.mjs checks parity).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAX_CANDIDATES = 4           // the log keeps the chosen + 3 alternatives, so the model was trained on top-4 option sets
const IDLE_SKILLS = new Set(['idle_activity', 'gesture', 'look_at'])
const STATUS = { done: 1, failed: 2, aborted: 3 }
const DRIVES = ['hunger', 'energy', 'safety', 'curiosity', 'social']
const UNATTRIBUTABLE = (why) => !why ? false : why === 'intent' || why === 'superseded' || why.startsWith('preempted_by:state') || why.startsWith('preempted_by:intent')
const DEFAULT_MODEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'models', 's1-scorer.json')

function walk(n, x) {
  while (n.v === undefined) {
    let v = x[n.f]
    const miss = v === null || v === undefined || Number.isNaN(v)
    let left
    if (miss && n.mt === 'N') left = n.dl                // missing_type NaN: default direction
    else { if (miss) v = 0; left = v <= n.t }            // missing_type None: NaN is read as 0
    n = left ? n.l : n.r
  }
  return n.v
}
function mlp(m, x) {
  let a = x.map((v, i) => ((v === null || Number.isNaN(v) ? m.med[i] : v) - m.mu[i]) / m.sd[i])
  for (let l = 0; l < m.W.length; l++) {
    const W = m.W[l], b = m.b[l], o = new Array(b.length).fill(0)
    for (let j = 0; j < b.length; j++) { let s = b[j]; for (let i = 0; i < a.length; i++) s += a[i] * W[i][j]; o[j] = l < m.W.length - 1 ? Math.max(0, s) : s }
    a = o
  }
  return a[0]
}
/** Pure: predicted reward for one feature vector. */
export function predictVec(model, x) {
  if (model.model.type === 'gbt') { let s = model.model.base ?? 0; for (const t of model.model.trees) s += walk(t, x); return s }
  return mlp(model.model, x)
}

export function loadModel(file = DEFAULT_MODEL) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!m.features || !m.model) throw new Error('bad scorer model')
  m.hidx = Object.fromEntries(m.habits.map((h, i) => [h, i]))
  return m
}

/** Per-habit recent success rate as in training/extract.py: last 10 attributable outcomes of that habit, done = 1, failed/aborted-by-others = 0. */
function recentOk(history, habit) {
  const q = []
  for (const h of history) {
    if (h.habit !== habit) continue
    if (h.status === 'done') q.push(1)
    else if (h.status === 'failed' || (h.status === 'aborted' && !UNATTRIBUTABLE(h.reason))) q.push(0)
    if (q.length > 10) q.shift()
  }
  return q.length ? { ok: q.reduce((a, b) => a + b, 0) / q.length, n: q.length } : { ok: NaN, n: 0 }
}

/** state = {hp, food, levels, history, hpDrop30}. options = [{name, score}] (candidates). Returns one feature vector per option, ordered as model.features. */
export function buildFeatures(model, state, options) {
  const { history = [], levels = {} } = state
  const last = history[history.length - 1]
  let idleStreak = 0
  for (let i = history.length - 1; i >= 0 && IDLE_SKILLS.has(history[i].skill); i--) idleStreak++
  let lastStreak = 0
  if (last) for (let i = history.length - 1; i >= 0 && history[i].habit === last.habit; i--) lastStreak++
  const fails5 = history.slice(-5).filter((h) => h.status === 'failed').length
  const set = new Set(options.map((o) => o.name))
  return options.map((o) => {
    const ok = recentOk(history, o.name)
    const isLast = last && last.habit === o.name ? 1 : 0
    const f = {
      hp: state.hp, food: state.food, idle_streak: idleStreak, fails_last5: fails5, hp_drop_30s: state.hpDrop30 ?? 0, last_status: last ? (STATUS[last.status] ?? 0) : 0,
      last_habit_idx: last ? (model.hidx[last.habit] ?? -1) : -1, last_habit_streak: lastStreak, opt_habit: model.hidx[o.name] ?? -1, opt_score: o.score,
      opt_streak: isLast ? lastStreak : 0, opt_recent_ok: ok.ok, opt_recent_n: ok.n, opt_is_last: isLast,
    }
    for (const d of DRIVES) f[d] = levels[d]
    for (const h of model.habits) f[`has_${h}`] = set.has(h) ? 1 : 0
    return model.features.map((n) => (f[n] === undefined ? NaN : f[n]))
  })
}

export function createScorer({ mode = 'off', weight, protect, modelPath, now = Date.now, trace = null } = {}) {
  const off = { mode: 'off', active: false, apply() {}, info: () => ({ mode: 'off' }) }
  if (mode !== 'shadow' && mode !== 'blend') return off
  let model
  try { model = loadModel(modelPath || DEFAULT_MODEL) } catch (e) { trace?.event('scorer_load_failed', { message: String(e?.message).slice(0, 160) }); return off }
  const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : (model.default_mix ?? 0.5)
  const K = model.k_scale ?? 4
  const prot = Number.isFinite(protect) ? protect : (model.protect_score ?? 5)
  const hpSamples = []   // [t, hp] seen at decisions, for the 30 s damage feature
  /** Annotates rows (sorted by utility score, desc) in place with .learned and .mixed for the top candidates; in blend mode re-orders them by .mixed. */
  function apply(rows, { bot, history, levels }) {
    const t = now(), hp = bot?.health ?? 20, food = bot?.food ?? 20
    hpSamples.push([t, hp]); while (hpSamples.length > 1 && hpSamples[0][0] < t - 60000) hpSamples.shift()
    let ref = hp; for (const [ts, v] of hpSamples) if (ts <= t - 30000) ref = v; else break
    const top = rows.slice(0, MAX_CANDIDATES)
    const opts = top.map((r) => ({ name: r.name, score: r.score }))
    const X = buildFeatures(model, { hp, food, levels, history, hpDrop30: Math.max(0, ref - hp) }, opts)
    top.forEach((r, i) => { r.learned = K * predictVec(model, X[i]); r.mixed = (1 - w) * r.score + w * r.learned })
    const utilTop = top[0]?.name
    const guarded = (top[0]?.score ?? 0) >= prot
    if (mode === 'blend' && !guarded) {
      top.sort((a, b) => b.mixed - a.mixed)
      rows.splice(0, top.length, ...top)
    }
    if (rows[0]) { rows[0].utilityTop = utilTop; rows[0].guarded = guarded }
  }
  return { mode, active: true, weight: w, protect: prot, apply, info: () => ({ mode, weight: w, model: model.kind, rows: model.trained_rows }) }
}

export function scorerFromEnv(env = process.env, trace = null) {
  const mode = (env.WREN_SCORER || 'off').toLowerCase()
  const weight = env.WREN_SCORER_WEIGHT === undefined || env.WREN_SCORER_WEIGHT === '' ? undefined : Number(env.WREN_SCORER_WEIGHT)
  const protect = env.WREN_SCORER_PROTECT === undefined || env.WREN_SCORER_PROTECT === '' ? undefined : Number(env.WREN_SCORER_PROTECT)
  return createScorer({ mode, weight, protect, modelPath: env.WREN_SCORER_MODEL || undefined, trace })
}
