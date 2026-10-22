// AI1: goal-conditioned steering for the habit layer (WREN_AUTONOMY=high). S2 (the LLM) authors goals; S1 only serves them.
//   steer view (built by mindlink from S2's last intent + goal store): {goalActive, goalId, goalText, skill, args, status, mods:{urgency,caution,sociability}, repeats}
//   - with an active goal, leisure habits (explore/wander/idle/...) are NOT started unless they serve the current intent's skill
//   - habits that serve the intent's skill get a score bonus scaled by S2's urgency; caution damps risky habits; sociability boosts social ones
//   - S2 silent + goal active: the last intent is continued (synthetic habit `continue_intent`) instead of a random habit
//   - survival/body habits (take_cover, shelter, sleep, eat, ...) are untouched: they are body safety, not choices
//   - no goal at all: nothing changes (classic habit fallback)
export const LEISURE = new Set(['explore', 'wander', 'idle', 'pick_flowers', 'fish', 'visit_player'])
const RISKY = new Set(['explore', 'wander', 'hunt', 'gather_stone', 'gather_coal'])
const SOCIAL = new Set(['visit_player', 'greet'])
const SERVES = {
  collect: ['gather_wood', 'gather_stone', 'gather_coal', 'stock_blocks', 'pick_flowers', 'craft', 'tidy'],
  gather_wood: ['gather_wood', 'craft', 'tidy'], gather_stone: ['gather_stone', 'craft', 'tidy'],
  explore: ['explore', 'wander'], wander: ['explore', 'wander'],
  hunt: ['hunt', 'eat', 'seek_food', 'get_wool'], eat: ['eat', 'hunt'],
  approach: ['visit_player', 'greet'], follow: ['visit_player', 'greet'], interact: ['greet', 'visit_player'], look_at: ['greet'],
  sleep: ['sleep', 'rest'], idle_activity: ['rest', 'idle'], fish: ['fish'],
}
export const CONTINUABLE = new Set(['collect', 'explore', 'gather_wood', 'gather_stone', 'wander', 'fish'])
export const MAX_CONTINUES = 3
export const serving = (habit, skill) => !!skill && (SERVES[skill] ?? []).includes(habit)

/** view for habits from mindlink state S. null when classic or no goal exists. */
export function steerView(S) {
  const st = S.steer; const active = (S.gstore?.goals ?? []).filter((g) => g.status === 'active')
  const ob = S.stack?.objective?.()   // G2: a current objective also counts as an active goal (leisure filler habits are suppressed while it exists)
  if (!active.length && !ob) return null
  return { goalActive: true, goalId: st?.goalId ?? active.at(-1)?.id ?? ob?.id, goalText: st?.goalText ?? active.at(-1)?.text ?? ob?.text, skill: st?.skill ?? ob?.resume?.goal ?? null, args: st?.args ?? null, status: st?.status ?? null, mods: st?.mods ?? {}, repeats: st?.repeats ?? 0,
    markContinued: () => { if (S.steer) S.steer.repeats = (S.steer.repeats ?? 0) + 1 } }
}

/** rows: [{name, base, score, habit}] sorted desc; returns the new sorted rows (leisure not serving the goal removed). */
export function steerRows(rows, view, { continuePlan = null } = {}) {
  if (!view?.goalActive) return rows
  const m = view.mods ?? {}
  const out = []
  for (const r of rows) {
    const sv = serving(r.name, view.skill)
    const social = SOCIAL.has(r.name) && (m.sociability ?? 0) > 0.5
    if (LEISURE.has(r.name) && !sv && !social) continue
    let d = 0
    if (sv) d += 1.2 + 2 * (m.urgency ?? 0.3)
    if ((m.caution ?? 0) > 0.5 && RISKY.has(r.name)) d -= 1.5 * m.caution
    if (social) d += 1.5 * m.sociability
    r.steer = +d.toFixed(2); r.score += d; out.push(r)
  }
  if (continuePlan && view.skill && CONTINUABLE.has(view.skill) && view.status === 'done' && (view.repeats ?? 0) < MAX_CONTINUES) {
    out.push({ name: 'continue_intent', base: 2.6, score: 2.6 + 2 * (m.urgency ?? 0.3), pen: 0, steer: 0, habit: { name: 'continue_intent', plan: () => ({ skill: view.skill, args: view.args ?? {} }) } })
  }
  return out.sort((a, b) => b.score - a.score)
}

/** compact fields for the logged habit_choice event (training data for the learned scorer, TR1): the goal as a feature. */
export function goalFeature(view, chosen) {
  if (!view?.goalActive) return { goal: null, goal_type: 'none' }
  let h = 2166136261; for (const c of String(view.goalText ?? '')) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return { goal: { id: view.goalId, hash: (h >>> 0).toString(16), serves: !!chosen && (chosen === 'continue_intent' || serving(chosen, view.skill)), skill: view.skill, mods: view.mods ?? {} } }
}
