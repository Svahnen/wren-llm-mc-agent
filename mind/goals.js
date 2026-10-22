// AI1: goals and projects AUTHORED BY S2 (the LLM). Code only stores, renders and persists them; it never invents, ranks or closes a goal.
// Pure data, JSON-serialisable. Ops come from the optional header-adjacent lines of the S2 answer (goal:, why:, plan:, done:, abandon:, note:, serves:, horizon:).
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim()
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
// G2: these are her LONG-TERM goals: at most 3 active, most important first, reviewed in the nightly reflection (keep / drop / reorder).
export const MAX_ACTIVE = 3
/** goal text and reason are separate fields: a copied rendered line ("... (why: x) (why: y)") never ends up inside the text. -> {text, why|null (the first reason found)} */
export function splitWhy(raw) {
  let why = null
  const text = String(raw ?? '').replace(/\s*\(\s*why\s*:\s*([^)]*)\)?/gi, (m, w) => { why ??= w.trim() || null; return '' }).replace(/\s+/g, ' ').trim()
  return { text, why }
}

// GOAL3: needs and routines (sleep, eat, heal, shelter for tonight) are NOT long-term goals. They are stored as scheduled routines with a trigger.
const PROJECT_WORDS = /\b(build|builds|building|construct|make|craft|explore|find|learn|gather|mine|mining|farm|collect|discover|teach|show|friend|friends|friendship|relationship|reliable|village|house|base|map|trade|tame|enchant|smelt|dig a|tunnel)\b/i
const ROUTINE_KINDS = [
  { kind: 'sleep', re: /\b(sleep|sleeping|slept|bed|bedtime|nap|settle (?:in|into|down)|lie down|get some rest|rest through)\b/i, trigger: 'when it gets dark', label: 'sleep at night' },
  { kind: 'eat', re: /\b(eat|eating|get (?:some )?food|have (?:a )?(?:meal|lunch|dinner)|feed myself|not (?:be )?hungry|stop being hungry)\b/i, trigger: 'when hungry', label: 'eat' },
  { kind: 'heal', re: /\b(heal|healing|recover|regain (?:my )?health|get (?:my )?health back)\b/i, trigger: 'when hurt', label: 'heal' },
  { kind: 'shelter', re: /\b(shelter|safe place|stay safe|survive the night|get through the night|spend the night|make it through the night|wait (?:here )?(?:for|until|out) (?:the )?(?:night|dark|dusk|morning|nightfall))\b/i, trigger: 'when night falls', label: 'shelter for the night' },
]
/** -> null | {kind, trigger, label}: does this goal text describe a routine/need instead of a project? Conservative: any project word wins. */
export function routineOf(text) {
  const t = String(text ?? ''); if (!t.trim()) return null
  const head = t.split(/\b(?:so that|so i can|so i|because|before|but)\b|[,.;(]/i)[0]
  if (PROJECT_WORDS.test(head)) return null
  const hit = ROUTINE_KINDS.find((k) => k.re.test(head)); if (hit) return { kind: hit.kind, trigger: hit.trigger, label: hit.label }
  return null
}

export function parseSteps(v) {
  if (Array.isArray(v)) return v.map((x) => clip(x, 140)).filter(Boolean).slice(0, 8)
  return String(v ?? '').split(/\s*(?:;|\||\s\d+[.)]\s|^\d+[.)]\s)\s*/).map((x) => clip(x.replace(/^\d+[.)]\s*/, ''), 140)).filter(Boolean).slice(0, 8)
}

export class GoalStore {
  constructor(j = null) { this.goals = []; this.routines = []; this.nextId = 1; this.rev = 0; this.lastTouched = null; this.reviewSeq = 0; if (j) Object.assign(this, { goals: (j.goals ?? []).map((g) => { const c = splitWhy(g.text); return c.text !== g.text ? { ...g, text: clip(c.text, 200), why: g.why || clip(c.why, 240) } : g }), nextId: j.nextId ?? 1, rev: j.rev ?? 0, lastTouched: j.lastTouched ?? null, reviewSeq: j.reviewSeq ?? 0, routines: Array.isArray(j.routines) ? j.routines.slice(-8) : [] }); if (j) this.cleanRoutines() }
  snapshot() { return { goals: this.goals.slice(-40), routines: this.routines.slice(-8), nextId: this.nextId, rev: this.rev, lastTouched: this.lastTouched, reviewSeq: this.reviewSeq } }
  static fromJSON(j) { return new GoalStore(j) }
  active() { return this.goals.filter((g) => g.status === 'active') }
  /** GOAL3: store (or refresh) a scheduled routine. One per kind. -> the routine */
  addRoutine(r, text, { now = Date.now() } = {}) {
    const ex = this.routines.find((x) => x.kind === r.kind)
    if (ex) { ex.text = clip(text, 200); return ex }
    const x = { id: 'R' + (this.routines.length ? Math.max(...this.routines.map((q) => Number(q.id.slice(1)))) + 1 : 1), kind: r.kind, label: r.label, text: clip(text, 200), trigger: r.trigger, created_ms: now }
    this.routines.push(x); this.routines = this.routines.slice(-8); this.rev++; return x
  }
  /** GOAL3: move active goals that are really routines out of the long-term list (legacy data, nightly review). -> moved goal ids */
  cleanRoutines({ now = Date.now() } = {}) {
    const moved = []
    for (const g of this.active()) { const r = routineOf(g.text); if (r) { this.addRoutine(r, g.text, { now }); this.#close(g, 'abandoned', 'a routine, not a long-term goal: now scheduled (' + r.label + ': ' + r.trigger + ')', now); moved.push(g.id) } }
    if (moved.length) this.rev++
    return moved
  }
  /** projects only: active goals that are not routines */
  projects() { return this.active().filter((g) => !routineOf(g.text)) }
  get(id) { return this.goals.find((g) => g.id === String(id).toUpperCase()) ?? null }
  /** the goal an op refers to: explicit id if active, else the one touched last, else the only active one. */
  target(id) { const g = id && this.get(id); if (g && g.status === 'active') return g; const a = this.active(); return a.find((x) => x.id === this.lastTouched) ?? a.at(-1) ?? null }

  /** meta: {goal, why, plan, horizon, done, abandon, note, serves}. -> {created, closed:[], rejected:[], serves}. Never throws. */
  apply(meta = {}, { now = Date.now(), day = null } = {}) {
    const out = { created: null, closed: [], rejected: [], serves: null, routine: null }
    let touched = false
    // she copied a rendered line ("G1 [active, 2 min] text ..."): that is a reference to an existing goal, not a new one
    const ref = /^\s*(G\d+)(?=\s*\[|\s*$)/.exec(String(meta.goal ?? ''))
    // G2: "goal: G2: new wording" on an existing active goal UPDATES it (long-term goals are reworded, not duplicated)
    const upd = !ref && /^\s*(G\d+)\s*[:\-]\s*(\S.*)$/i.exec(String(meta.goal ?? ''))
    if (upd && this.get(upd[1])?.status === 'active') {
      const g = this.get(upd[1]); { const c = splitWhy(upd[2]); const ru = routineOf(c.text); if (ru) { out.routine = this.addRoutine(ru, c.text, { now }); this.#close(g, 'abandoned', 'a routine, not a long-term goal: now scheduled (' + ru.label + ': ' + ru.trigger + ')', now); out.closed.push(g.id) } else { g.text = clip(c.text, 200); const w = meta.why || c.why; if (w) g.why = clip(w, 240) } if (meta.horizon && ['short', 'day', 'long'].includes(meta.horizon)) g.horizon = meta.horizon }
      this.lastTouched = g.id; touched = true; out.serves = g.id; out.updated = g.id; meta = { ...meta, goal: undefined, why: undefined, serves: meta.serves ?? g.id }
    } else if (ref) { if (this.get(ref[1])) meta = { ...meta, goal: undefined, serves: meta.serves ?? ref[1] }; else meta = { ...meta, goal: String(meta.goal).replace(/^\s*G\d+\s*(\[[^\]]*\])?\s*/i, '') } }
    else if (upd) meta = { ...meta, goal: upd[2] }
    if (meta.goal) {
      const sp = splitWhy(meta.goal); if (!meta.why && sp.why) meta = { ...meta, why: sp.why }
      const text = clip(sp.text, 200), dup = this.active().find((g) => norm(g.text) === norm(text)), rt = routineOf(text)
      if (rt) { out.routine = this.addRoutine(rt, text, { now }); touched = true }
      else if (dup) { this.lastTouched = dup.id; out.created = null; out.serves = dup.id }
      else if (this.active().length >= MAX_ACTIVE) out.rejected.push(`goal_limit: you already have ${MAX_ACTIVE} long-term goals (${this.active().map((x) => x.id).join(', ')}); finish or drop one first (drop: <id> <reason>), or reword one with goal: <id>: <new wording>`)
      else {
        const g = { id: 'G' + this.nextId++, text, why: clip(meta.why, 240), status: 'active', created_ms: now, created_day: day, horizon: ['short', 'day', 'long'].includes(meta.horizon) ? meta.horizon : null, plan: parseSteps(meta.plan).map((t) => ({ text: t, done: false })), notes: [], ended_ms: null, reason: null }
        this.goals.push(g); this.lastTouched = g.id; out.created = g.id; out.serves = g.id; touched = true
      }
    } else if (meta.plan) {
      const g = this.target(meta.serves); const steps = parseSteps(meta.plan)
      if (g && steps.length) { g.plan = steps.map((t) => ({ text: t, done: false })); this.lastTouched = g.id; touched = true }
    }
    if (meta.why && !meta.goal) { const g = this.target(meta.serves); if (g && !g.why) { g.why = clip(meta.why, 240); touched = true } }
    if (meta.note) { const g = this.target(meta.serves); if (g) { this.#note(g, clip(meta.note, 160)); touched = true } }
    if (meta.done) {
      const m = /^\s*(?:(G\d+)(?:[.#](\d+))?|step\s*(\d+))/i.exec(String(meta.done))
      let g = m?.[1] ? this.get(m[1]) : this.target(meta.serves)
      const step = Number(m?.[2] ?? m?.[3] ?? NaN)
      if (g && g.status === 'active') {
        if (Number.isFinite(step) && g.plan[step - 1]) { g.plan[step - 1].done = true; touched = true }
        else { this.#close(g, 'done', null, now); out.closed.push(g.id); touched = true }
      } else if (!g) out.rejected.push(`done: no such active goal "${clip(meta.done, 40)}"`)
    }
    if (meta.abandon) {
      const m = /^\s*(G\d+)?[\s:,-]*(.*)$/i.exec(String(meta.abandon))
      const g = m?.[1] ? this.get(m[1]) : this.target(meta.serves)
      if (g && g.status === 'active') { this.#close(g, 'abandoned', clip(m[2], 160) || 'no reason given', now); out.closed.push(g.id); touched = true }
      else out.rejected.push(`abandon: no such active goal "${clip(meta.abandon, 40)}"`)
    }
    const s = meta.serves ? this.get(meta.serves) : null
    if (s && s.status === 'active') { out.serves = s.id; this.lastTouched = s.id } else if (!out.serves) out.serves = this.active().length ? (this.target(null)?.id ?? null) : null
    if (touched) this.rev++
    return out
  }
  /** G2 nightly review (her own decision, applied by code): ops = {keep:[{id,note?}], drop:[{id,reason?}], order:[ids]}. -> {kept, dropped, ordered} */
  review(ops = {}, { now = Date.now() } = {}) {
    const out = { kept: [], dropped: [], ordered: false }
    for (const k of ops.keep ?? []) { const g = this.get(k.id); if (g?.status === 'active') { if (k.note) this.#note(g, 'review: ' + clip(k.note, 140)); out.kept.push(g.id) } }
    for (const d of ops.drop ?? []) { const g = this.get(d.id); if (g?.status === 'active') { this.#close(g, 'abandoned', clip(d.reason, 160) || 'dropped in the nightly review', now); out.dropped.push(g.id) } }
    if (ops.order?.length) {
      const act = this.active(), by = new Map(act.map((g) => [g.id, g]))
      const first = ops.order.map((i) => by.get(String(i).toUpperCase())).filter(Boolean).filter((g, i, a) => a.indexOf(g) === i)
      if (first.length) { const rest = act.filter((g) => !first.includes(g)); const others = this.goals.filter((g) => g.status !== 'active'); this.goals = [...others, ...first, ...rest]; out.ordered = true }
    }
    this.reviewSeq++; this.rev++
    return out
  }
  #note(g, t) { g.notes.push(t); if (g.notes.length > 6) g.notes.shift() }
  #close(g, status, reason, now) { g.status = status; g.reason = reason; g.ended_ms = now }
  /** factual outcome appended by code (what happened), never a judgement */
  noteOutcome(id, text) { const g = id && this.get(id); if (g && g.status === 'active') { this.#note(g, clip(text, 160)); this.rev++ } }

  /** scheduled routines, for the prompt (not goals) */
  renderRoutines() { return this.routines.map((r) => `${r.id} ${r.label}: ${r.trigger}`).join('\n') }
  render(now = Date.now()) {
    const ago = (ms) => { const m = Math.max(0, Math.round((now - ms) / 60000)); return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h` }
    const L = []
    if (this.active().length > 1) L.push('(most important first)')
    for (const g of this.active()) {
      L.push(`${g.id} [active, ${ago(g.created_ms)}${g.horizon ? ', ' + g.horizon : ''}] ${g.text}${g.why ? ' (why: ' + g.why + ')' : ''}`)
      if (g.plan.length) L.push('   plan: ' + g.plan.map((s, i) => `${i + 1}. ${s.text}${s.done ? ' (done)' : ''}`).join(' '))
      if (g.notes.length) L.push('   so far: ' + g.notes.slice(-3).join('; '))
    }
    for (const g of this.goals.filter((x) => x.status !== 'active').slice(-2)) L.push(`${g.id} [${g.status}${g.reason ? ': ' + g.reason : ''}] ${g.text}`)
    return L.join('\n')
  }
}

// ---- G2: nightly review of the long-term goals through the sleep-pass LLM callback. The model decides; code parses and applies.
export function reviewMessages(store, { name = 'Wren', summary = '' } = {}) {
  return [
    { role: 'system', content: `You are ${name}, an AI that has been given a body to explore a Minecraft world. Nobody assigns you goals; the long-term goals below are yours.` },
    { role: 'user', content: `Your long-term goals (most important first):\n${store.render()}\n\n${summary ? `How the day went: ${summary}\n\n` : ''}Review them before you sleep. Long-term goals are projects (build, explore, find, make, learn, a relationship). Sleeping, eating, healing and sheltering are routines, not goals: do not keep those, drop them. For each goal answer on its own line, one of:\nkeep: <id> <one line of progress or why it still matters>\ndrop: <id> <reason>\nThen, if the order should change, one line: order: <ids, most important first>. Answer only with these lines.` },
  ]
}
/** tolerant: "keep: G1 progress...", "drop G2 - reason", "order: G3, G1" (any case, bullets, bold). -> {keep, drop, order} */
export function parseReview(text) {
  const ops = { keep: [], drop: [], order: [] }
  for (const raw of String(text ?? '').split('\n')) {
    const ln = raw.replace(/^[\s\-*>#\d.)]+/, '').replace(/\*\*/g, '').trim()
    let m = /^(keep|drop|abandon|order|reorder)\b\s*[:\-]?\s*(.*)$/i.exec(ln); if (!m) continue
    const verb = m[1].toLowerCase(), rest = m[2]
    if (verb === 'order' || verb === 'reorder') { ops.order.push(...(rest.match(/G\d+/gi) ?? []).map((x) => x.toUpperCase())); continue }
    const id = /^\s*(G\d+)\b[\s:,.\-]*(.*)$/i.exec(rest); if (!id) continue
    ;(verb === 'keep' ? ops.keep : ops.drop).push({ id: id[1].toUpperCase(), ...(verb === 'keep' ? { note: id[2] } : { reason: id[2] }) })
  }
  return ops
}
/** run one review: ask(messages) -> text. Applies to `store`; returns {ops, result}. A goal she says nothing about is kept (silence is not a decision to drop). */
export async function reviewGoals(store, ask, { name, summary, now } = {}) {
  if (!store.active().length) return null
  store.cleanRoutines({ now })   // routines are not kept as long-term goals
  if (!store.active().length) return null
  const text = await ask(reviewMessages(store, { name, summary }))
  const ops = parseReview(text)
  ops.keep = ops.keep.filter((k) => { const g = store.get(k.id); return !(g && routineOf(g.text)) })
  if (!ops.keep.length && !ops.drop.length && !ops.order.length) return { ops, result: null, text }
  return { ops, result: store.review(ops, { now }), text }
}
