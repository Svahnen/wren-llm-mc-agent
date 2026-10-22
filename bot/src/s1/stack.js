// G2: the goal stack's two lower layers and the interruption bookkeeping.
//   long-term goals (<= 3)  : mind/goals.js GoalStore, authored by S2 (goal:/progress:/drop:), reviewed in the nightly reflection
//   current objective       : this module. S2 writes `now:` (minutes long, serves a long-term goal); it stays hers until she writes another one (or now: done / none)
//   interruptions           : reflex firings (arbiter) and her own reactions (a fight/eat/flee/hunt intent without `now:`) are PUSHED on top of the objective
// When an interruption ends, onInterruptionOver() gives S2 an event ("... you were walking home to build your lake house: continue?").
// If S2 stays silent for resumeAfterMs, the objective she chose before is resumed by S1: that is EXECUTION of her earlier decision (logged resume_default),
// not a new decision. Code never invents, changes or drops an objective except by her words (or a very long expiry, logged).
// Metrics (decision log, kind:'stack'): objectives started/completed/dropped, interruptions, resumes (default vs by S2), action switches per minute.

/** Skills / goal types that are REACTIONS to the body or the world; an S2 intent of this kind without `now:` is pushed on top of the objective instead of replacing it. */
export const REACTION_SKILLS = new Set(['eat', 'hunt', 'fish', 'cook', 'fight', 'defend', 'flee', 'take_cover', 'shelter', 'sleep', 'place_torch', 'return_to_surface', 'drop_junk', 'store_in_chest', 'gesture', 'idle_activity', 'look_at'])
export const REACTION_TYPES = new Set(['get_food', 'defend', 'avoid', 'rest', 'build_shelter', 'talk'])
const OBJECTIVE_MAX_MS = 45 * 60000
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** what an intent is, for the stack: {reaction:boolean, label} */
export function classifyIntent(it) {
  if (!it) return { reaction: false, label: '' }
  if (it.goal === 'pursue') { const t = it.goal_spec?.type ?? it.args?.type; return { reaction: REACTION_TYPES.has(t), label: `${(t ?? 'goal').replace(/_/g, ' ')}${it.goal_spec?.text ? ': ' + clip(it.goal_spec.text, 60) : ''}` } }
  return { reaction: REACTION_SKILLS.has(it.goal), label: `${String(it.goal ?? '').replace(/_/g, ' ')}${it.args && Object.keys(it.args).length ? ' ' + clip(Object.values(it.args).join(' '), 30) : ''}`.trim() }
}

export function createStack({ now = Date.now, resumeAfterMs = 20000, calmMs = 3000, log = () => {}, decisionLog = null, onResume = async () => {}, onInterruptionOver = () => {} } = {}) {
  let obj = null          // {id, text, serves, t0, resume:{intent}, status, steps, interruptions, resumes}
  let inter = null        // {source:'reflex'|'self', label, t0, active, calmAt, over, overAt, intent_id}
  let lastIntentAt = 0
  let seq = 0
  const m = { objectives: 0, completed: 0, dropped: 0, replaced: 0, expired: 0, interruptions: 0, interruptions_reflex: 0, interruptions_self: 0, resumes_default: 0, resumes_inherent: 0, resumes_by_s2: 0, interrupted_then_abandoned: 0, switches: 0, starts: 0 }
  const startTimes = []   // [{t, name}] skill starts by non-reflex owners (the thrash metric)
  let lastStart = null
  const rec = (event, extra = {}) => { log('stack_' + event, extra); try { decisionLog?.write({ kind: 'stack', event, objective: obj ? { id: obj.id, text: clip(obj.text, 80), serves: obj.serves, status: obj.status } : null, ...extra }) } catch { /* ignore */ } }

  const inter0 = () => (inter ? { ...inter } : null)
  function closeInterruption(how) { if (inter) { rec('interruption_end', { how, label: inter.label, source: inter.source, ms: now() - inter.t0 }); inter = null } }

  function setObjective({ text, serves = null, intent = null }) {
    if (obj) { if (obj.status === 'interrupted') m.interrupted_then_abandoned++; m.replaced++; rec('objective_replaced', { old: clip(obj.text, 60) }) }
    inter && closeInterruption('objective_replaced')
    obj = { id: `obj-${++seq}`, text: clip(text, 160), serves, t0: now(), resume: intent, status: 'active', interruptions: 0, resumes: 0, last_action: intent ? describe(intent) : '' }
    m.objectives++
    rec('objective_set', { text: obj.text, serves, via: intent?.goal ?? null })
    return obj
  }
  const describe = (it) => classifyIntent(it).label
  function endObjective(how) {
    if (!obj) return false
    if (how === 'done') m.completed++; else m.dropped++
    rec('objective_end', { how, text: clip(obj.text, 60), ms: now() - obj.t0, interruptions: obj.interruptions, resumes: obj.resumes })
    obj = null; closeInterruption('objective_end')
    return true
  }
  const maybeCalm = () => { if (inter && !inter.reflexActive && !inter.selfActive && inter.calmAt == null) inter.calmAt = now() }
  function push(source, label, intent_id = null) {
    if (!obj) return
    if (inter && !inter.over) { // already interrupted: the interruption just goes on (a fight has many reflex firings)
      if (source === 'reflex') inter.reflexActive = true; else { inter.selfActive = true; inter.intent_id = intent_id }
      inter.calmAt = null
      return
    }
    if (inter) closeInterruption('superseded_by_new')
    m.interruptions++; m[source === 'reflex' ? 'interruptions_reflex' : 'interruptions_self']++
    obj.interruptions++
    obj.status = 'interrupted'
    inter = { source, label, t0: now(), reflexActive: source === 'reflex', selfActive: source === 'self', calmAt: null, over: false, overAt: null, intent_id, wasDoing: obj.last_action || obj.text }
    rec('interruption_start', { source, label })
  }

  return {
    /** an S2 intent arrived (any kind). Returns {role:'objective'|'serving'|'interruption'|'none', ...} */
    noteIntent(it) {
      if (it?.goal === 'none' && !it.objective) return { role: 'none' }   // 'keep doing what you do': neither a new decision nor a reason to cancel the default resume
      lastIntentAt = now()
      const c = classifyIntent(it)
      const o = it?.objective
      if (o?.end) { const had = !!obj; endObjective(o.end); return { role: 'objective_end', had } }
      if (o?.text) {
        const was = obj?.status === 'interrupted'
        if (obj && inter && !inter.over) closeInterruption('new_objective')
        setObjective({ text: o.text, serves: it.serves ?? null, intent: (c.reaction && it.goal !== 'pursue') || it.goal === 'none' ? null : it })
        return { role: 'objective', replacedInterrupted: was }
      }
      if (!obj) return { role: 'none' }
      if (c.reaction) { push('self', c.label, it.intent_id); return { role: 'interruption' } }
      // a normal intent while an objective exists: it serves the objective; it is also what a resume would repeat
      if (obj.status === 'interrupted') { m.resumes_by_s2++; rec('resumed_by_s2', { intent: it.goal }); obj.status = 'active'; obj.resumes++; closeInterruption('s2_decided') }
      obj.resume = it; obj.last_action = c.label
      return { role: 'serving' }
    },
    /** reflex took the body (arbiter 'granted' owner reflex) */
    reflexStart(label) { if (!obj) { m.interruptions_reflex++; return } push('reflex', `reflex ${label}`) },
    reflexEnd() { if (inter && !inter.over) { inter.reflexActive = false; maybeCalm() } },
    /** the intent that was the self-reaction has finished (done/failed/preempted) */
    reactionEnded(intent_id) { if (inter && !inter.over && inter.selfActive && (!intent_id || inter.intent_id === intent_id)) { inter.selfActive = false; maybeCalm() } },
    /** skill start by a non-reflex owner: the thrash metric */
    noteStart(name, owner, t = now()) {
      if (owner === 'reflex') return
      m.starts++
      if (lastStart && lastStart !== name) { m.switches++; startTimes.push(t) }
      lastStart = name
    },
    switchesPerMin() { const t = now(); while (startTimes.length && t - startTimes[0] > 60000) startTimes.shift(); return startTimes.length },
    /** 1 Hz: interruption bookkeeping and the default resume */
    async tick() {
      const t = now()
      if (!obj) return
      if (t - obj.t0 > OBJECTIVE_MAX_MS && t - lastIntentAt > OBJECTIVE_MAX_MS) { m.expired++; rec('objective_expired', {}); obj = null; inter = null; return }
      if (inter && !inter.reflexActive && !inter.selfActive && !inter.over && inter.calmAt != null && t - inter.calmAt >= calmMs) {
        inter.over = true; inter.overAt = t
        rec('interruption_over', { label: inter.label, source: inter.source, ms: t - inter.t0 })
        try { onInterruptionOver({ objective: { ...obj }, interruption: { ...inter } }) } catch { /* ignore */ }
      }
      if (obj.status === 'interrupted' && inter?.over && lastIntentAt < inter.overAt && t - inter.overAt >= resumeAfterMs) {
        const intent = obj.resume
        obj.status = 'active'; obj.resumes++; m.resumes_default++
        rec('resume_default', { intent: intent?.goal ?? null, args: intent?.args ?? null, waited_ms: t - inter.overAt })
        closeInterruption('resume_default')
        if (intent) {
          try {
            const r = await onResume(intent, { reason: 'resume_default', objective: { ...obj } })
            if (r?.skipped) { m.resumes_default--; m.resumes_inherent++; rec('resume_inherent', { why: r.skipped }) }   // the body was already back on it (S1 continues its own goal after a reflex)
          } catch (e) { rec('resume_error', { message: String(e?.message).slice(0, 100) }) }
        }
      }
    },
    /** the body finished the objective's own action successfully and S2 wrote nothing: keep it (it is hers to end) */
    view() {
      if (!obj) return null
      const t = now()
      const v = { text: obj.text, serves: obj.serves, age_s: Math.round((t - obj.t0) / 1000), status: obj.status, resumed: obj.resumes || undefined, was_doing: obj.last_action || undefined }
      if (inter) { v.interrupted_by = inter.label; v.interrupted_s = Math.round((t - inter.t0) / 1000); v.interruption_over = !!inter.over; if (inter.over) v.resume_in_s = Math.max(0, (resumeAfterMs - (t - inter.overAt)) / 1000) }
      return v
    },
    objective: () => obj, interruption: inter0,
    setObjective, endObjective,
    metrics() { const spm = this.switchesPerMin(); return { ...m, switches_per_min: spm, objective_completion: m.objectives ? +(m.completed / m.objectives).toFixed(2) : null, resume_rate: m.interruptions ? +((m.resumes_default + m.resumes_inherent + m.resumes_by_s2) / m.interruptions).toFixed(2) : null } },
    logMetrics() { rec('metrics', this.metrics()) },
  }
}
