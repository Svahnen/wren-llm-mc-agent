// PB1: playbook engine. Runs the steps of a playbook (data, see catalog.js) on top of the skill runner, reports progress, survives interruptions.
//   - S2 chooses WHAT (playbook + args) and may steer (skip / abort / set); it never plans steps. S1 (selector.js) hands a goal to start().
//   - every step: when (preconditions) -> do/op/choose -> ok (success check) -> retry -> on_fail (skip | abort | {abort:reason}); loops repeat until a predicate holds.
//   - interruptions: a reflex/unstuck preemption pauses the step, waits until the body is calm, then retries the SAME step (not counted as a failure).
//   - hunger is queued (afterThis) unless priority.hungerPolicy says interrupt; then get_food runs as a child and the step resumes.
//   - progress is persisted (stateFile) after every step; start() with the same name+args within the resume window continues at the saved step.
import fs from 'node:fs'
import { getPlaybook, resolveParams, derived } from './catalog.js'
import { allTrue, evalPred, resourceRe } from './predicates.js'
import { OPS } from './ops.js'
import { hungerPolicy, afterThisNote, yieldsToFood, rodStatus } from './priority.js'
import { countMatch, isNight } from '../skills/lib.js'
import { inventoryFacts } from '../habits/needs.js'

const INTERRUPT_RE = /^(preempted|reflex|superseded|unstuck|state:)/
// BAT1: a holder of the body that must never be aborted by a playbook step (live: the playbook killed every rung of the escape ladder, 8 'interruptions' in 3 s)
export const PROTECTED_HOLDER = /^reflex:|^s1:(unstuck|escape_|take_cover|dig_in|shelter|low_hp|flee|pillbox|mlg|fight|eat$)|^(s1|s2):unstuck/
export const NO_PROGRESS_MS = 90000
const NO_RETRY = new Set(['no_target_found'])   // nothing in range: a second identical search cannot differ (gather has a cooldown for it)
const isInterrupt = (res) => (res.status === 'aborted' && INTERRUPT_RE.test(res.reason ?? '')) || (res.status === 'rejected' && /^(busy|unstuck_active|preempt_timeout)$/.test(res.reason ?? '')) || res.status === 'interrupted'

export function createPlaybookEngine({ getBot, runSkill, abortCurrent = async () => {}, env = {}, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), notify = () => {}, log = () => {},
  stateFile = null, screenRecent = null, safety = null, calm = null, decisionLog = null, resumeWindowMs = 15 * 60000, lookup = getPlaybook, foodSource = null } = {}) {
  let cur = null, last = null, seq = 0
  const M = { started: 0, completed: 0, failed: 0, aborted: 0, cancelled: 0, resumed_runs: 0, interruptions: 0, resumes: 0, hunger_interrupts: 0, hunger_deferred: 0, danger_yields: 0, step_failures: 0, step_skips: 0, steps_done: 0, steered: 0, by_playbook: {} }
  const bp = (n) => (M.by_playbook[n] ??= { started: 0, completed: 0, failed: 0, aborted: 0, cancelled: 0, interruptions: 0, resumes: 0 })

  const save = (r, extra = {}) => {
    if (!stateFile) return
    try { fs.writeFileSync(stateFile + '.tmp', JSON.stringify({ t: now(), id: r.id, name: r.name, args: r.args, intent_id: r.intent_id, status: r.status, stepIdx: r.stepIdx, stepId: r.stepId, interruptions: r.interruptions, resumes: r.resumes, afterThis: [...r.afterThis], state: { origin: r.state.origin ?? null }, ...extra })); fs.renameSync(stateFile + '.tmp', stateFile) } catch { /* ignore */ }
  }
  const loadSaved = () => { try { return stateFile ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null } catch { return null } }

  const sub = (v, params) => {
    if (typeof v === 'string') { const m = /^\$(\w+)$/.exec(v); if (m) { const p = params[m[1]]; return p !== undefined && p !== '' && !isNaN(Number(p)) && typeof p !== 'number' && /^\d+$/.test(p) ? Number(p) : p } return v.replace(/\$(\w+)/g, (s, k) => params[k] ?? s) }
    if (Array.isArray(v)) return v.map((x) => sub(x, params))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x, params)]))
    return v
  }
  const pctx = (r, params) => ({ bot: getBot(), env, params, state: r.state, now })

  function mk(r, params) {
    return {
      bot: getBot, params, state: r.state, env, now, sleep, aborted: () => r.cancelled || r.abortReason != null, abortCurrent,
      screenRecent, log: (e, d) => log(e, { playbook: r.name, ...d }),
      notify: (kind, text, data) => { r.lastEvent = { kind, text, t: now() }; try { notify(kind, text, { playbook: r.name, ...data }) } catch { /* ignore */ } },
      runSkill: async (name, args) => { const res = await runSkill(name, args, { intent_id: r.intent_id }); r.lastSkill = { name, status: res.status, reason: res.reason }; return res },
    }
  }
  async function waitCalm(r, max = 45000) {
    const t0 = now()
    while (now() - t0 < max && !r.cancelled) { if (!calm || (await calm())) break; await sleep(500) }
    await sleep(300)
  }
  function noteInterrupt(r, res) {
    r.interruptions++; M.interruptions++; bp(r.name).interruptions++
    r.status = 'paused'; r.pausedBy = res.reason ?? res.status; save(r)
    log('playbook_interrupted', { name: r.name, step: r.stepId, by: r.pausedBy })
  }
  function noteResume(r) { r.resumes++; M.resumes++; bp(r.name).resumes++; r.status = 'running'; log('playbook_resumed', { name: r.name, step: r.stepId }); save(r) }

  /** run one skill with interruption handling; returns the final result (never an interruption unless the budget is used up).
   *  BAT1: the same cause is ONE interruption however often it is retried; a body held by a real emergency (reflex, escape ladder) is waited for, never aborted;
   *  only a filler (habit skill, sleep...) holding the body is aborted. The step is retried (resumed) afterwards, at the same step. */
  async function callSkill(r, x, skill, args, step) {
    let lastKey = null, waitedMs = 0
    let tInt = 0
    for (let k = 0; k < 14;) {
      // FOOD3: no-progress guard. A step that only waits/retries for interruptions for more than NO_PROGRESS_MS fails with a reason (live: 'stuck in go_home, running but nothing happens')
      if (tInt && now() - tInt > NO_PROGRESS_MS) return { status: 'failed', reason: 'no_progress_timeout', detail: `step ${step?.id ?? '?'} made no progress for ${Math.round((now() - tInt) / 1000)} s (interrupted/busy)` }
      if (r.cancelled || r.abortReason) return { status: 'aborted', reason: 'playbook_stopped' }
      if (r.skipReq) return { status: 'aborted', reason: 'skipped_by_s2' }
      const res = await x.runSkill(skill, args)
      if (r.skipReq) return { status: 'aborted', reason: 'skipped_by_s2' }
      if (!isInterrupt(res)) return res
      if (!tInt) tInt = now()
      const key = `${res.status}:${res.reason ?? ''}:${PROTECTED_HOLDER.test(res.holder ?? '') ? 'protected' : (res.holder ?? '')}`   // one cause = one interruption, whichever rung of the ladder holds the body now
      if (key !== lastKey) { noteInterrupt(r, res); lastKey = key } else { r.status = 'paused' }
      const busy = res.reason === 'busy' || res.reason === 'unstuck_active'
      if (busy && PROTECTED_HOLDER.test(res.holder ?? '') || res.reason === 'unstuck_active') {
        const t0 = now(); await waitCalm(r, 20000); await sleep(300); waitedMs += now() - t0 + 300   // wait for the emergency to end; bounded, not counted as an attempt
        if (waitedMs > 180000) return { status: 'failed', reason: 'interrupted_too_often' }
        noteResume(r); continue
      }
      k++
      if (busy) { try { await abortCurrent() } catch { /* ignore */ } await sleep(300) } else await waitCalm(r)
      noteResume(r)
    }
    return { status: 'failed', reason: 'interrupted_too_often' }
  }

  async function runBody(r, x, step, params, depth) {
    if (step.do) {
      const args = sub(step.do.args ?? {}, params)
      const res = await callSkill(r, x, step.do.skill, args, step)
      if (res.status === 'done' || (res.status === 'aborted' && res.reason === 'skipped_by_s2')) return res.status === 'done' ? { status: 'done', reason: res.reason } : { status: 'skipped', reason: 'skipped_by_s2' }
      return { status: 'failed', reason: res.reason ?? res.status, ...(res.detail ? { detail: res.detail } : {}) }
    }
    if (step.op) {
      const f = OPS[step.op]; if (!f) return { status: 'failed', reason: `unknown_op_${step.op}` }
      for (let k = 0; k < 14; k++) {
        if (r.cancelled || r.abortReason) return { status: 'failed', reason: 'playbook_stopped' }
        if (r.skipReq) return { status: 'skipped', reason: 'skipped_by_s2' }
        const res = await f(x, step, sub(step.args ?? {}, params))
        if (res.status !== 'interrupted') return res
        noteInterrupt(r, res); await waitCalm(r); noteResume(r)
      }
      return { status: 'failed', reason: 'interrupted_too_often' }
    }
    if (step.choose) {
      const tried = []
      for (const opt of step.choose) {
        if ((r.optFails[opt.id] ?? 0) >= 2) continue
        if (opt.when && !allTrue(opt.when, pctx(r, params))) continue
        r.sub = opt.id
        const res = await execStep(r, x, opt, params, depth + 1)
        tried.push(`${opt.id}:${res.status}${res.reason ? '/' + res.reason : ''}`)
        if (res.status === 'done') return { status: 'done', via: opt.id }
        if (res.status === 'skipped' && res.reason === 'skipped_by_s2') return res
        if (res.status === 'failed') r.optFails[opt.id] = (r.optFails[opt.id] ?? 0) + 1
      }
      r.sub = null
      return { status: 'failed', reason: tried.length ? 'every_option_failed' : 'no_option_applies', detail: tried.join('; ') }
    }
    return { status: 'failed', reason: 'empty_step' }
  }

  async function execStep(r, x, step, params, depth = 0) {
    const pc = () => pctx(r, params)
    if (step.when && !allTrue(step.when, pc())) return { status: 'skipped', reason: 'when' }
    if (step.done_if && allTrue(step.done_if, pc())) return { status: 'skipped', reason: 'already' }
    const attempts = (step.retry ?? 0) + 1
    let res = null
    for (let a = 0; a < attempts; a++) {
      if (r.cancelled || r.abortReason) return { status: 'failed', reason: 'playbook_stopped' }
      if (step.loop) {
        let fails = 0, it = 0
        res = null
        while (it < (step.loop.max ?? 3)) {
          if (allTrue(step.loop.until, pc())) { res = { status: 'done', reason: 'until' }; break }
          if (r.cancelled || r.abortReason) return { status: 'failed', reason: 'playbook_stopped' }
          if (depth === 0) await between(r, x, params)
          it++; r.iter = `${it}/${step.loop.max ?? 3}`
          const body = { ...step, loop: undefined, when: undefined, done_if: undefined, ok: undefined }
          const b = await runBody(r, x, body, params, depth)
          if (b.status === 'skipped' && b.reason === 'skipped_by_s2') return b
          if (b.status === 'failed') { if (++fails >= 2) { res = { status: 'failed', reason: b.reason, detail: b.detail }; break } } else fails = 0
        }
        r.iter = null
        if (!res) res = allTrue(step.loop.until, pc()) ? { status: 'done', reason: 'until' } : { status: 'failed', reason: 'loop_exhausted' }
      } else {
        res = await runBody(r, x, step, params, depth)
        if (res.status === 'skipped' && res.reason === 'skipped_by_s2') return res
        if (res.status === 'done' && step.ok) { await sleep(200); if (!allTrue(step.ok, pc())) res = { status: 'failed', reason: 'result_check_failed', detail: step.ok.join(',') } }
      }
      if (res.status !== 'failed') return res
      if (NO_RETRY.has(res.reason)) return res
      if (a < attempts - 1) { log('playbook_retry', { name: r.name, step: step.id, reason: res.reason, attempt: a + 1 }); await sleep(400) }
    }
    return res
  }

  /** between steps: danger (S1 safety yield), hunger rule. */
  async function between(r, x, params) {
    if (r.depth > 0) return
    const bot = getBot(); if (!bot?.entity) return
    if (safety) { try { if (await safety()) { r.danger_yields++; M.danger_yields++ } } catch { /* ignore */ } }
    if (r.name === 'get_food' || r.noHunger) return
    const inv = inventoryFacts(bot)
    const src = inv.food > 0 ? 0 : (foodSource ? foodSource(bot) : Infinity)
    const hp = hungerPolicy({ food: bot.food ?? 20, hp: bot.health ?? 20, src })
    if (hp.interrupt && !r.inHunger) {
      r.inHunger = true; r.interruptions++; M.interruptions++; M.hunger_interrupts++; bp(r.name).interruptions++
      notify('hunger_interrupt', `food ${Math.round(bot.food)}/20 (${hp.why.replace(/_/g, ' ')}): the playbook ${r.name} paused at step ${r.stepId} to get food, and then continues.`, { playbook: r.name })
      r.status = 'paused'; r.pausedBy = 'hunger'; save(r)
      const def = lookup('get_food')
      const saveStep = [r.stepIdx, r.stepId, r.sub, r.name, r.depth]
      r.depth++; r.name2 = r.name
      const child = await runDef(r, def, {}, true)
      ;[r.stepIdx, r.stepId, r.sub, r.name] = saveStep; r.depth = saveStep[4]
      r.inHunger = false
      noteResume(r)
      if (child.status !== 'done' && yieldsToFood(r.name, { food: bot.food ?? 20, hasFood: inventoryFacts(bot).food > 0, night: (() => { try { return isNight(bot) } catch { return false } })() })) {
        r.abortReason = 'hungry_no_food'   // FOOD3: do not carry on with a non-urgent playbook while starving and foodless
        notify('hunger_unresolved', `could not get food (${child.reason}); ${r.name} is stopped (hungry_no_food) so the body is free to hunt or search.`, {})
      } else if (child.status !== 'done') notify('hunger_unresolved', `could not get food while ${r.name} was paused (${child.reason}); continuing it.`, {})
    } else if (hp.defer) {
      const note = afterThisNote(bot.food)
      if (![...r.afterThis].length) { M.hunger_deferred++; r.afterThis.add(note); notify('after_this', `food is ${Math.round(bot.food)}/20 but nothing to eat is close and you are not hurt: noted as "after this" behind ${r.name}.`, { playbook: r.name }); save(r) }
    }
  }

  async function runDef(r, def, params, child = false) {
    const top = !child
    const ctx = () => pctx(r, params)
    if (def.done_if && allTrue(def.done_if, ctx())) return { status: 'done', reason: 'already' }
    const x = mk(r, params)
    let i = top ? r.stepIdx : 0
    for (; i < def.steps.length; i++) {
      if (r.cancelled) return { status: 'cancelled', reason: r.cancelReason }
      if (r.abortReason) return { status: 'aborted', reason: r.abortReason }
      const step = def.steps[i]
      if (top) { r.stepIdx = i; r.stepId = step.id; r.sub = null; save(r) }
      if (top) await between(r, x, params)
      r.skipReq = false
      if (r.setReq) { Object.assign(params, r.setReq); r.setReq = null }
      const res = await execStep(r, x, step, params, 0)
      const rec = { id: step.id, status: res.status, reason: res.reason, via: res.via, ...(res.status === 'failed' && res.detail ? { detail: String(res.detail).slice(0, 220) } : {}) }
      if (top) { r.results.push(rec); r.lastResult = rec }
      if (res.status === 'done') M.steps_done++
      if (res.status === 'skipped' && res.reason !== 'when' && res.reason !== 'already') { M.step_skips++; if (top) x.notify('step_skipped', `step ${step.id} of ${r.name} skipped (${res.reason}).`, { step: step.id }) }
      if (res.status === 'failed') {
        M.step_failures++
        const of = step.on_fail ?? 'abort'
        const why = (typeof of === 'object' && of.abort) || res.reason
        if (top) x.notify('step_failed', `step ${step.id} of ${r.name} failed: ${res.reason}${res.detail ? ' (' + String(res.detail).slice(0, 120) + ')' : ''}; ${of === 'skip' ? 'skipping it' : 'stopping the playbook'}.`, { step: step.id, reason: res.reason })
        if (of === 'skip') continue
        return { status: 'failed', reason: why, step: step.id, detail: res.detail }
      }
      if (def.done_if && i < def.steps.length - 1 && allTrue(def.done_if, ctx())) return { status: 'done', reason: 'goal_reached' }
    }
    return { status: 'done', reason: 'completed' }
  }

  async function runTop(r) {
    r.status = 'running'; save(r)
    let out
    const p0 = getBot()?.entity?.position; r.p0 = p0 ? { x: p0.x, y: p0.y, z: p0.z } : null; r.maxDisp = 0
    const tick = setInterval(() => { try { const p = getBot()?.entity?.position; if (p && r.p0) r.maxDisp = Math.max(r.maxDisp, Math.hypot(p.x - r.p0.x, p.z - r.p0.z)) } catch { /* ignore */ } }, 1000)
    try { out = await runDef(r, r.def, r.params, false) } catch (e) { out = { status: 'failed', reason: 'internal_error', detail: String(e?.message).slice(0, 120) } }
    clearInterval(tick)
    r.status = out.status === 'done' ? 'done' : out.status === 'cancelled' ? 'cancelled' : out.status === 'aborted' ? 'aborted' : 'failed'
    r.endReason = out.reason; r.finished = now()
    const b = bp(r.name)
    if (r.status === 'done') { M.completed++; b.completed++ } else if (r.status === 'cancelled') { M.cancelled++; b.cancelled++ } else if (r.status === 'aborted') { M.aborted++; b.aborted++ } else { M.failed++; b.failed++ }
    // PB3: a playbook that ended in a "nothing to be found here" way is not re-run at the same place at once; S2 gets the plain reason + a hint
    const cd = r.def.cooldown
    if (cd && r.status !== 'done' && r.status !== 'cancelled' && (cd.reasons ?? []).includes(r.endReason)) {
      const p = getBot()?.entity?.position, rad = Math.max(32, Math.round((r.maxDisp ?? 0) + 24))
      const text = String(cd.text ?? r.endReason).replace('{r}', String(rad))
      lastFail.set(r.name, { t: now(), pos: p ? { x: p.x, z: p.z } : r.p0, reason: r.endReason, text, r: rad })
      r.failText = text; r.failHint = cd.hint ?? null
    }
    if (cur === r) { last = r; cur = null }
    save(r, { endReason: r.endReason, ...(r.status === 'cancelled' ? { status: 'interrupted' } : {}) })
    try { decisionLog?.write({ kind: 'playbook', event: 'end', name: r.name, args: r.args, status: r.status, reason: r.endReason, step: r.stepId, k: r.stepIdx + 1, n: r.def.steps.length, interruptions: r.interruptions, resumes: r.resumes, ms: now() - r.t0, after_this: [...r.afterThis] }) } catch { /* ignore */ }
    return { ...out, status: r.status }
  }

  const lastFail = new Map()
  /** active cooldown for this playbook near `p` (or anywhere when p is null) */
  const cooldownFor = (name, p) => {
    const def = lookup(name); const cd = def?.cooldown; const f = lastFail.get(name); if (!cd || !f) return null
    const age = (now() - f.t) / 1000; if (age > (cd.s ?? 120)) return null
    if (p && f.pos && Math.hypot(p.x - f.pos.x, p.z - f.pos.z) > (cd.radius ?? 40)) return null
    return { name, age_s: Math.round(age), left_s: Math.round((cd.s ?? 120) - age), text: f.text, line: `tried ${name} here ${age < 90 ? Math.round(age) + ' s' : Math.round(age / 60) + ' min'} ago: ${f.text.replace(/ \(.*$/, '')}` }
  }
  const sameArgs = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort())

  return {
    /** start a playbook. raw args are validated here. -> {ok, errors?, promise, resumed} */
    start(name, rawArgs = {}, { intent_id = null, serves = null, know = null, onEnd = null } = {}) {
      const def = lookup(name)
      if (!def) return { ok: false, errors: [`"${name}" is not a playbook`] }
      const rp = resolveParams(def, rawArgs, know); if (!rp.ok) return { ok: false, errors: rp.errors }
      if (cur) return { ok: false, errors: ['a playbook is already running'] }
      { const b0 = getBot(); // FOOD3: starving with nothing to eat: a non-urgent playbook waits, getting food comes first
        if (b0 && yieldsToFood(def.name, { food: b0.food ?? 20, hasFood: inventoryFacts(b0).food > 0, night: (() => { try { return isNight(b0) } catch { return false } })() }))
          return { ok: false, hungry: true, errors: [`food ${Math.round(b0.food ?? 0)}/20 and nothing to eat: ${def.name} waits. Get food first (hunt a visible animal, forage_plants, or the get_food playbook), then start ${def.name} again.`] } }
      if (def.name === 'fish' || def.name === 'fish_session') { const b1 = getBot()   // FOOD4: no rod and no means to craft one: refuse honestly before any step
        if (b1) { const ri = (re) => { try { return countMatch(b1, re) } catch { return 0 } }
          const st = rodStatus({ rod: ri(/^fishing_rod$/), string: ri(/^string$/), sticks: ri(/^stick$/), planks: ri(/_planks$/), logs: ri(/_log$/) })
          if (!st.ok) return { ok: false, noRod: true, errors: [`cannot fish: ${st.text}. Hunting, foraging or a farm are the ways to food now.`] } } }
      { const cd0 = cooldownFor(def.name, getBot()?.entity?.position)
        // BAT1: a "no wood" cooldown ends as soon as she holds wood again (e.g. back from an expedition)
        const got = cd0 && /no_wood|used up/.test(lastFail.get(def.name)?.reason ?? lastFail.get(def.name)?.text ?? '') ? (() => { try { return countMatch(getBot(), resourceRe('wood')) >= 3 } catch { return false } })() : false
        if (got) lastFail.delete(def.name) }
      { const cd = cooldownFor(def.name, getBot()?.entity?.position); if (cd) return { ok: false, cooldown: true, errors: [`${cd.line}; not started again for ${cd.left_s} s unless you move 40 m away. ${def.cooldown.hint ?? ''}`.trim()] } }
      const params = derived(def, rp.params)
      const bot = getBot()
      const r = { id: `pb-${++seq}`, name: def.name, def, params, args: rp.params, intent_id: intent_id ?? `pb-${seq}`, serves, t0: now(), stepIdx: 0, stepId: def.steps[0].id, status: 'running', cancelled: false, abortReason: null, skipReq: false,
        interruptions: 0, resumes: 0, danger_yields: 0, afterThis: new Set(), results: [], optFails: {}, depth: 0, sub: null, state: { base: {}, origin: null } }
      for (const k of ['wood', 'stone', 'coal', 'iron', 'sand', 'dirt', 'plants']) { try { r.state.base[k] = countMatch(bot, resourceRe(k)) } catch { r.state.base[k] = 0 } }
      const saved = loadSaved()
      let resumed = false
      if (saved && saved.name === def.name && sameArgs(saved.args, rp.params) && now() - saved.t < resumeWindowMs && saved.stepIdx > 0 && !['done', 'failed', 'aborted'].includes(saved.status)) {
        r.stepIdx = Math.min(saved.stepIdx, def.steps.length - 1); r.stepId = def.steps[r.stepIdx].id; r.interruptions = saved.interruptions ?? 0; r.resumes = (saved.resumes ?? 0) + 1
        r.afterThis = new Set(saved.afterThis ?? []); if (saved.state?.origin) r.state.origin = saved.state.origin
        resumed = true; M.resumes++; M.resumed_runs++; bp(def.name).resumes++
      }
      cur = r; M.started++; bp(def.name).started++
      log('playbook_start', { name: def.name, args: rp.params, resumed, step: r.stepId })
      try { decisionLog?.write({ kind: 'playbook', event: 'start', name: def.name, args: rp.params, resumed, step: r.stepId }) } catch { /* ignore */ }
      r.promise = runTop(r).then((o) => { try { onEnd?.({ ...o, hint: r.failHint ? `${r.failText}. Next: ${r.failHint}` : null, name: r.name, args: r.args, intent_id: r.intent_id, summary: summaryOf(r, o), steps: r.results.length, ms: now() - r.t0, interruptions: r.interruptions, resumes: r.resumes, after_this: [...r.afterThis] }) } catch { /* ignore */ } return o })
      return { ok: true, resumed, id: r.id, promise: r.promise, warnings: rp.warnings }
    },
    /** stop (S2 changed its mind / shutdown). Progress stays saved so the same playbook can resume. */
    async cancel(reason = 'cancelled') {
      const r = cur; if (!r) return false
      r.cancelled = true; r.cancelReason = reason; r.status = 'interrupted'; save(r, { status: 'interrupted' }); cur = null
      try { await abortCurrent() } catch { /* ignore */ }
      return true
    },
    /** S2 steering: {skip:true} | {abort:'reason'} | {set:{k:v}} */
    async steer(cmd = {}) {
      const r = cur; if (!r) return { ok: false, reason: 'no_playbook' }
      M.steered++
      if (cmd.abort) { r.abortReason = String(cmd.abort).slice(0, 60) || 'aborted_by_s2'; try { await abortCurrent() } catch { /* ignore */ } return { ok: true, did: 'abort' } }
      if (cmd.skip) { r.skipReq = true; try { await abortCurrent() } catch { /* ignore */ } return { ok: true, did: 'skip', step: r.stepId } }
      if (cmd.set) { const def = r.def; const rp = resolveParams(def, { ...r.args, ...cmd.set }); if (!rp.ok) return { ok: false, reason: rp.errors.join('; ') }; Object.assign(r.params, derived(def, rp.params)); Object.assign(r.args, rp.params); r.setReq = null; return { ok: true, did: 'set', args: r.args } }
      return { ok: false, reason: 'unknown_command' }
    },
    active: () => !!cur,
    /** the digest / map view */
    view() {
      const r = cur ?? (last && now() - last.finished < 60000 ? last : null); if (!r) return null
      return { name: r.name, args: r.args, status: r.status, k: Math.min(r.stepIdx + 1, r.def.steps.length), n: r.def.steps.length, step: r.stepId, step_desc: r.def.steps[r.stepIdx]?.desc ?? null, sub: r.sub ?? null, iter: r.iter ?? null,
        commitment: !!r.def.commitment, interruptions: r.interruptions, resumes: r.resumes, paused_by: r.status === 'paused' ? r.pausedBy : null, after_this: [...r.afterThis], last_event: r.lastEvent?.text ?? null, end_reason: r.endReason ?? null, age_s: Math.round((now() - r.t0) / 1000), serves: r.serves }
    },
    current: () => cur,
    /** PB3: playbooks that were just tried here and found nothing (digest + menu) */
    cooldowns() { const p = getBot()?.entity?.position; return [...lastFail.keys()].map((n) => cooldownFor(n, p)).filter(Boolean) },
    /** commitment playbooks keep priority over non-critical hunger */
    hungerWouldInterrupt(bot = getBot()) { if (!bot) return false; const inv = inventoryFacts(bot); return hungerPolicy({ food: bot.food ?? 20, hp: bot.health ?? 20, src: inv.food > 0 ? 0 : (foodSource ? foodSource(bot) : Infinity) }).interrupt },
    noteAfterThis(text) { if (cur) { cur.afterThis.add(text); M.hunger_deferred++ } },
    metrics() {
      const fin = M.completed + M.failed + M.aborted
      const per = {}; for (const [k, v] of Object.entries(M.by_playbook)) per[k] = { ...v, completion_rate: v.completed + v.failed + v.aborted ? +(v.completed / (v.completed + v.failed + v.aborted)).toFixed(2) : null, interruptions_per_run: v.started ? +(v.interruptions / v.started).toFixed(2) : null }
      return { ...M, by_playbook: per, completion_rate: fin ? +(M.completed / fin).toFixed(2) : null, interruptions_per_playbook: M.started ? +(M.interruptions / M.started).toFixed(2) : null, resume_rate: M.interruptions ? +(M.resumes / M.interruptions).toFixed(2) : null }
    },
    async whenIdle() { while (cur) await cur.promise },
  }
}
function summaryOf(r, o) { if (r.state?.result) return `${r.name}: ${o.status}${o.reason ? ' (' + o.reason + ')' : ''}. ${r.state.result}`   // EXP1: the playbook's own plain RESULT line
  const tried = r.results.map((x) => `${x.id}${x.via ? '(' + x.via + ')' : ''}:${x.status}${x.reason ? '/' + x.reason : ''}${x.detail ? ' [' + x.detail + ']' : ''}`).join(', '); return `${r.name}: ${o.status}${o.reason ? ' (' + o.reason + ')' : ''}${o.reason === 'not_night' && o.detail ? ' RESULT: ' + o.detail : ''}. Steps: ${tried || 'none'}${r.afterThis.size ? '. After this: ' + [...r.afterThis].join('; ') : ''}` }
