// Brain: wires scheduler + prompt + LLM + validator + intent store. Transport-agnostic (server.js exposes it over HTTP).
import { S2Scheduler } from './scheduler.js'
import { buildMessages, buildRepair, buildReflection } from './prompt.js'
import { parseOutput, validate, allowedActs, RELAXABLE, makeIntent, validateEvent, speechPolicy, templateLine, intentExpired, normalizeDigest, newIntentId, inferAction, MENTIONS_ACTION, eatToCook, reactionMsg } from './contract.js'
import { isCritical } from './survival.js'
import { SLOT_DIALOGUE, SLOT_PLANNING } from './llm.js'
import { makeLogger } from './jsonl.js'
import { GoalStore } from '../mind/goals.js'
import { routineNote } from './daylight.js'

export const autonomyFromEnv = (env = process.env) => (String(env.WREN_AUTONOMY ?? 'high').toLowerCase() === 'classic' ? 'classic' : 'high')

export class Brain {
  constructor({ llm, log = makeLogger('brain'), now = () => Date.now(), scheduler = {}, name = 'Wren', autonomy = autonomyFromEnv() } = {}) {
    Object.assign(this, { llm, log, now, name, autonomy })
    this.high = autonomy === 'high'
    this.goals = new GoalStore()
    this.notes = []        // consequences/advisories for the next prompt (shown once)
    this.advisoryOpen = [] // overridden warnings awaiting an outcome
    if (this.high) scheduler = { ...scheduler, deadlines: { heartbeat: 40000, done: 30000, drive_wake: 30000, ...(scheduler.deadlines ?? {}) }, maxAgeMs: { heartbeat: 45000, done: 30000, ...(scheduler.maxAgeMs ?? {}) } }
    this.log({ ev: 'autonomy', mode: autonomy })
    this.digest = normalizeDigest({})
    this.ctx = { self_summary: '', memories: [] }
    this.recent = [] // {intent_id, goal, args, status}
    this.state = { seq: 0, intent: null, speech: null, cancel: [], template: null }
    this.reflection = null
    this.streak = {} // rule code -> consecutive jobs rejected by it (P1 deadlock breaker)
    this.lastIntentAt = now()
    this.waiters = []
    this.stats = { jobs: 0, valid_first: 0, valid_after_repair: 0, invalid: 0, repaired: 0, early_stops: 0, events_rejected: 0, intents: 0, ttft_ms: [], total_ms: [] }
    this.scheduler = new S2Scheduler({
      run: (job, o) => this.runJob(job, o), now, humanPresent: () => this.digest.players.length > 0, ...scheduler,
      on: {
        offline: ({ offline, reason }) => { this.log({ ev: 's2_offline', offline, reason }); this._bump({ template: templateLine(offline ? 'offline' : 'online') ? { text: templateLine(offline ? 'offline' : 'online'), intent_id: null } : null }) },
        offlineEvent: ({ kind }) => { if (kind === 'human_speech') this._bump({ template: { text: templateLine('offline'), intent_id: null } }) },
        drop: (d) => this.log({ ev: 'drop', kind: d.job.kind, reason: d.reason }),
        error: (d) => this.log({ ev: 'job_error', kind: d.job.kind, reason: d.reason, error: d.error?.message }),
        late: (d) => this.log({ ev: 'late_dropped', kind: d.job.kind, reason: d.reason }),
        result: (d) => this.log({ ev: 'job_done', kind: d.job.kind, ms: d.ms, wait_ms: d.job.waitMs, valid: d.result?.valid }),
        ...(scheduler.on ?? {}),
      },
    })
  }

  // ---- inbound
  handleEvent(raw) {
    const v = validateEvent(raw)
    if (!v.ok) { this.stats.events_rejected++; this.log({ ev: 'event_rejected', errors: v.errors, type: raw?.type }); return { ok: false, errors: v.errors } }
    const ev = v.event
    if (ev.digest) this.digest = ev.digest
    if (ev.context?.goals_restore && this.goals.rev === 0 && this.goals.goals.length === 0) { this.goals = GoalStore.fromJSON(ev.context.goals_restore); this.log({ ev: 'goals_restored', n: this.goals.goals.length }) }
    // G2: the nightly review (mind process) changed the long-term goals: adopt that version
    if (ev.context?.goals_replace && (ev.context.goals_replace.reviewSeq ?? 0) > (this.goals.reviewSeq ?? 0)) { this.goals = GoalStore.fromJSON({ ...ev.context.goals_replace, rev: Math.max(this.goals.rev + 1, ev.context.goals_replace.rev ?? 0) }); this.log({ ev: 'goals_reviewed', n: this.goals.goals.length, reviewSeq: this.goals.reviewSeq }); this._bumpGoals() }
    if (ev.context) this.ctx = { self_summary: String(ev.context.self_summary ?? this.ctx.self_summary).slice(0, 2500), self_summary_age_s: ev.context.self_summary_age_s ?? (ev.context.self_summary === undefined ? this.ctx.self_summary_age_s : undefined), memories: (ev.context.memories ?? this.ctx.memories).slice(0, 12).map((m) => String(m).slice(0, 300)) }
    this.log({ ev: 'event', type: ev.type, status: ev.status, from: ev.from })
    if (ev.type === 'report') this._onReport(ev)
    if (ev.type === 'body_state') {
      if (['dead', 'respawning', 'disconnected'].includes(ev.state)) {
        if (ev.state === 'dead') for (const a of this.advisoryOpen) this.log({ ev: 'advisory_outcome', intent_id: a.intent_id, codes: a.codes, status: 'died', reason: 'died' })
        this.advisoryOpen = []
        this._clearIntent(`body_${ev.state}`)
      }
      return { ok: true }
    }
    const r = this.scheduler.push(ev)
    return { ok: true, queued: r.accepted, ...r }
  }

  _onReport(ev) {
    const r = this.recent.find((x) => x.intent_id === ev.intent_id)
    if (r) r.status = ev.status
    const ao = this.advisoryOpen.find((a) => a.intent_id === ev.intent_id)
    if (ao && ['done', 'failed', 'blocked'].includes(ev.status)) { this.log({ ev: 'advisory_outcome', intent_id: ev.intent_id, codes: ao.codes, status: ev.status, reason: ev.reason_code }); this.advisoryOpen = this.advisoryOpen.filter((a) => a !== ao) }
    if (this.high && r?.serves && ['done', 'failed', 'blocked'].includes(ev.status)) { this.goals.noteOutcome(r.serves, `${r.goal} ${ev.status}${ev.status === 'done' ? '' : ' (' + ev.reason_code + ')'}`); this._bumpGoals() }
    const cur = this.state.intent
    if (!cur || cur.intent_id !== ev.intent_id) return
    if (ev.status === 'started' && this.state.speech) this.state.speech.released = true
    const pol = speechPolicy(ev.status, ev.reason_code, ev.intent_id)
    const patch = {}
    if (pol.cancel_speech && this.state.speech && !this.state.speech.released) { patch.cancel = [...this.state.cancel, this.state.speech.utterance_id].slice(-20); patch.speech = null }
    if (pol.template) patch.template = { text: pol.template, intent_id: ev.intent_id }
    if (Object.keys(patch).length) this._bump(patch)
  }

  _bumpGoals() { this.state = { ...this.state, seq: this.state.seq + 1 }; const w = this.waiters; this.waiters = []; for (const f of w) f() }

  _clearIntent(why) { if (this.state.intent) this._bump({ intent: null, speech: null, cancel: this.state.speech && !this.state.speech.released ? [...this.state.cancel, this.state.speech.utterance_id].slice(-20) : this.state.cancel }); this.log({ ev: 'intent_cleared', why }) }

  _bump(patch) {
    this.state = { ...this.state, ...patch, seq: this.state.seq + 1 }
    const w = this.waiters; this.waiters = []
    for (const f of w) f()
  }

  /** latest-wins view for S1. since: last seq seen. wait: ms to long-poll. */
  async getIntent({ since = -1, waitMs = 0 } = {}) {
    if (waitMs > 0 && this.state.seq <= since) await new Promise((res) => { const t = setTimeout(res, waitMs); this.waiters.push(() => { clearTimeout(t); res() }) })
    const s = this.state
    const expired = s.intent && intentExpired(s.intent, this.now())
    const template = s.template
    if (template) this.state = { ...this.state, template: null } // one-shot
    return {
      v: 1, seq: s.seq, changed: s.seq > since, intent: expired ? null : s.intent, expired: !!expired, speech: expired ? null : s.speech,
      cancel_utterances: s.cancel, template_line: template, autonomy: this.autonomy, goals_rev: this.goals.rev, goals: this.high ? this.goals.snapshot() : undefined, s2_offline: this.scheduler.s2Offline, habits_only: this.scheduler.s2Offline || !s.intent || !!expired,
    }
  }

  status() {
    const t = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? null
    return { ...this.scheduler.status(), seq: this.state.seq, current_intent: this.state.intent?.intent_id ?? null,
      brain: { ...this.stats, ttft_ms: undefined, total_ms: undefined, ttft_p50_ms: t(this.stats.ttft_ms), total_p50_ms: t(this.stats.total_ms) },
      valid_rate: this.stats.jobs ? (this.stats.valid_first + this.stats.valid_after_repair) / this.stats.jobs : null, reflection_ready: !!this.reflection }
  }

  /** rules downgraded to warnings: a rule that rejected >= 2 jobs in a row, or starving after a hunt that already failed recently. */
  relaxSet(dg) {
    const r = new Set(Object.entries(this.streak).filter(([, n]) => n >= 2).map(([c]) => c))
    const hunts = [...this.recent, ...(dg.recent_intents ?? [])].slice(-8).filter((x) => x && x.goal === 'hunt' && ['failed', 'blocked'].includes(x.status))
    if (hunts.length) r.add('needs_starving')
    return r
  }

  _idleInfo(dg, job) {
    const min = (this.now() - this.lastIntentAt) / 60000
    if (min < 3 || job.kind !== 'heartbeat' || dg.time?.phase !== 'day' || dg.nearby.some((n) => n.cat === 'hostile' && n.dist <= 8)) return null
    return { min: Math.round(min), choices: allowedActs(dg, { relax: this.relaxSet(dg) }).filter((a) => !a.startsWith('idle_activity')).slice(0, 5) }
  }

  // ---- job runner (called by the scheduler)
  async runJob(job, { signal, slot }) {
    this.stats.jobs++
    const last = job.events.at(-1)
    const jobDigest = [...job.events].reverse().find((e) => e.digest)?.digest
    // GATH1: the job may have queued behind another LLM call; use the newest digest the body sent (position/health must be as fresh as possible)
    const digest = jobDigest && !(this.digest?.at > jobDigest.at) ? jobDigest : (this.digest ?? jobDigest)
    if (job.kind === 'reflection' || job.kind === 'sleep_pass') {
      const r = await this.llm.complete({ messages: buildReflection({ digest, ctx: this.ctx, episodes: last?.context?.episodes ?? [], name: this.name }), slot: SLOT_PLANNING, signal, kind: job.kind, job_id: job.id, max_tokens: 400, timeoutMs: 100000 })
      this.reflection = { text: r.text.trim(), at: this.now() }
      this.log({ ev: 'reflection', chars: r.text.length })
      return { valid: true, tokens: r.tokens }
    }
    const dg = normalizeDigest({ ...digest, recent_intents: digest.recent_intents?.length ? digest.recent_intents : this.recent.slice(-8).map(({ goal, args, status }) => ({ goal, args, status })) })
    const human = job.events.some((e) => e.type === 'human_speech')
    if (human && !dg.chat.length) dg.chat = job.events.filter((e) => e.type === 'human_speech').map((e) => ({ from: e.from, text: e.text }))
    const relax = this.relaxSet(dg)
    const idle = this._idleInfo(dg, job)
    if (idle) this.log({ ev: 'idle_reprompt', min: idle.min })
    const notes = this.notes.splice(0)
    const safe = !dg.nearby.some((n) => n.cat === 'hostile' && n.dist <= 12) && dg.health > 8
    let messages = buildMessages({ job, digest: dg, ctx: this.ctx, name: this.name, idle, autonomy: this.autonomy, goals: this.high ? this.goals.render(this.now()) : '', routines: this.high ? this.goals.renderRoutines() : '', noProject: this.high && this.goals.projects().length === 0, notes, budget: { slotTokens: Number(process.env.S2_CTX_PER_SLOT) || 8192, onTrim: (d) => this.log({ ev: 'prompt_trimmed', ...d }) } })
    const llmOpts = this.high ? { max_tokens: safe ? 400 : 240, timeoutMs: safe ? 40000 : 25000 } : {}
    const slotId = human ? SLOT_DIALOGUE : slot === 0 ? SLOT_DIALOGUE : SLOT_PLANNING
    let tokens = 0, attempt = 0, v = null, parsed = null, text = ''; const raws = [], firstErr = []
    for (; attempt < 2; attempt++) {
      let early = false
      const r = await this.llm.complete({
        messages, slot: slotId, signal, kind: job.kind + (attempt ? '_repair' : ''), job_id: job.id, ...llmOpts,
        onText: (t) => { // validate the header as soon as line 1 is complete; stop streaming if it is already wrong
          if (!t.includes('\n')) return
          const p = parseOutput(t.split('\n')[0] + '\n---\nx')
          const vv = validate(p, dg, { recent: this.recent, relax, advisory: this.high })
          if (!vv.ok) { early = true; return 'stop' }
        },
      })
      tokens += r.tokens ?? 0
      if (early) this.stats.early_stops++
      this.stats.ttft_ms.push(r.ttft_ms ?? 0); this.stats.total_ms.push(r.total_ms ?? 0)
      text = r.text; raws.push(text); parsed = parseOutput(text)
      if (early) parsed.errors = parsed.errors.filter((e) => e.code !== 'delimiter_missing')
      v = validate(parsed, dg, { recent: this.recent, relax, advisory: this.high })
      { const m = eatToCook(parsed, dg, v); if (m) { const vm = validate(m.parsed, dg, { recent: this.recent, relax, advisory: this.high }); if (vm.ok) { this.log({ ev: 'eat_mapped_to_cook', item: m.item, hp: dg.health, food: dg.food }); this.notes.push(m.note); v = vm; parsed = m.parsed } } }   // FOOD2
      // an early stop leaves no speech: not a failure per se, re-validate the header only
      if (v.ok) break
      if (attempt === 0) firstErr.push(...v.errors.map((e) => e.code))
      this.log({ ev: 'invalid', attempt, errors: v.errors.map((e) => e.code), text: text.slice(0, 300) })
      if (attempt === 0) { this.stats.repaired++; messages = buildRepair(messages, text, v.errors, allowedActs(dg, { relax })) }
    }
    const seen = new Set([...firstErr, ...v.errors.map((x) => x.code)])
    if (!v.ok && v.errors.every((x) => RELAXABLE.includes(x.code))) {
      // never leave S2 with zero acceptable actions: accept the last answer with the blocking rules as warnings
      const v2 = validate(parsed, dg, { recent: this.recent, relax: new Set([...relax, ...RELAXABLE]) })
      if (v2.ok) { this.log({ ev: 'validator_deadlock', codes: [...seen], act: parsed.act, forced: true, streak: { ...this.streak } }); v = v2 }
    }
    if (!v.ok) {
      for (const c of Object.keys(this.streak)) if (!seen.has(c)) delete this.streak[c]
      for (const c of seen) if (RELAXABLE.includes(c)) this.streak[c] = (this.streak[c] ?? 0) + 1
      if (Object.values(this.streak).some((n) => n >= 2)) this.log({ ev: 'validator_deadlock', codes: [...seen], act: parsed.act, forced: false, streak: { ...this.streak } })
      this.stats.invalid++
      if (human) this._bump({ template: { text: templateLine('invalid', String(job.id)), intent_id: null } })
      return { valid: false, tokens, errors: v.errors.map((e) => e.code), raws, first_errors: firstErr }
    }
    // SURV1: words are not actions. {act:none} + an option named in THINK/SAY -> the one obvious action, or one re-prompt asking for an action line
    if (this.high && v.ok && !human && ((v.act === 'none' && !v.goal) || (!v.act && v.goal?.type === 'custom' && !v.goal.via_act))) {
      const inf = inferAction(parsed, dg)
      const mapped = inf.hit ? (inf.hit.goal ? { ...parsed, act: null, args: {}, goal: inf.hit.goal, errors: [] } : { ...parsed, act: inf.hit.act, args: inf.hit.args, goal: null, errors: [] }) : null
      if (!inf.hit) { this.stats.action_none = (this.stats.action_none ?? 0) + 1; this.log({ ev: 'action_none', why: inf.ambiguous ? 'ambiguous' : inf.why ?? 'no_option', kinds: inf.ambiguous }) }   // IMP1: honest none is counted, not silent
      const v2 = mapped ? validate(mapped, dg, { recent: this.recent, relax, advisory: true }) : null
      if (v2?.ok) { this.stats.action_inferred = (this.stats.action_inferred ?? 0) + 1; this.log({ ev: 'action_inferred', from: v.act ?? 'custom', to: inf.hit.act ?? inf.hit.goal.type, args: inf.hit.args ?? inf.hit.goal?.target, why: inf.why, text: inf.from, hp: dg.health, food: dg.food }); v = v2; parsed = mapped }
      else if (isCritical(dg) && (inf.ambiguous || MENTIONS_ACTION.test(`${parsed.think} ${parsed.speech}`))) {
        const msgs = buildRepair(messages, text, [{ msg: reactionMsg(dg) }], allowedActs(dg, { relax }))   // FOOD2: short, explicit, with a valid example line
        this.stats.action_reprompt = (this.stats.action_reprompt ?? 0) + 1
        try {
          const r2 = await this.llm.complete({ messages: msgs, slot: slotId, signal, kind: job.kind + '_action', job_id: job.id, max_tokens: 240, timeoutMs: 25000 })
          tokens += r2.tokens ?? 0; raws.push(r2.text)
          let p2 = parseOutput(r2.text), v3 = validate(p2, dg, { recent: this.recent, relax, advisory: true })
          { const m = eatToCook(p2, dg, v3); if (m) { const vm = validate(m.parsed, dg, { recent: this.recent, relax, advisory: true }); if (vm.ok) { this.log({ ev: 'eat_mapped_to_cook', item: m.item, hp: dg.health, food: dg.food, reprompt: true }); this.notes.push(m.note); v3 = vm; p2 = m.parsed } } }   // FOOD2
          const acts = v3.ok && (v3.act !== 'none' || v3.goal)
          this.log({ ev: 'action_reprompt', ok: !!acts, act: v3.act, goal: v3.goal?.type, hp: dg.health, food: dg.food })
          if (acts) { v = v3; parsed = p2 }
        } catch (e) { this.log({ ev: 'action_reprompt', ok: false, error: String(e?.message).slice(0, 80) }) }
      }
    }
    this.streak = {}
    for (const w of v.warnings) if (w.code === 'place_op') this.notes.push(`Place note not applied: ${w.msg}.`)
    attempt === 0 ? this.stats.valid_first++ : this.stats.valid_after_repair++
    let serves = null
    if (this.high) {
      const r = this.goals.apply(v.meta ?? {}, { now: this.now(), day: dg.time.day })
      serves = r.serves
      for (const m of r.rejected) this.notes.push(m)
      if (r.routine) { this.notes.push(routineNote(r.routine, dg)); this.log({ ev: 'routine_stored', id: r.routine.id, kind: r.routine.kind, text: r.routine.text, trigger: r.routine.trigger }) }
      if (r.created || r.closed.length || r.rejected.length) this.log({ ev: 'goal_ops', created: r.created, closed: r.closed, rejected: r.rejected, goal: this.goals.get(r.created ?? r.closed[0] ?? serves)?.text })
      if (v.meta?.value) this.log({ ev: 'value', text: v.meta.value })
      const adv = v.warnings.filter((w) => w.advisory)
      if (adv.length) {
        for (const w of adv) this.notes.push(`Heads-up (not blocked, you chose ${v.act}): ${w.msg}. Your reflexes will still protect you, but this could hurt or kill you.`)
        this.notes = this.notes.slice(-4)
        this.log({ ev: 'advisory_overridden', act: v.act, codes: adv.map((w) => w.code), msgs: adv.map((w) => w.msg), hp: dg.health, food: dg.food })
      }
    }
    const intent = makeIntent(v, dg, { intent_id: newIntentId(this.now()), now: this.now(), serves })
    intent.job_id = job.id; intent.job_kind = job.kind
    { const ids = job.events.filter((e) => e.type === 'human_speech' && Number.isFinite(e.utt_id)).map((e) => e.utt_id); if (ids.length) intent.answers = ids }   // V3: which utterances this job answers
    if (this.high) { const adv = v.warnings.filter((w) => w.advisory); if (adv.length) { this.advisoryOpen.push({ intent_id: intent.intent_id, codes: adv.map((w) => w.code) }); this.advisoryOpen = this.advisoryOpen.slice(-8) } }
    this._publish(intent, v, human)
    return { valid: true, tokens, intent_id: intent.intent_id, goal: intent.goal, args: intent.args, speech: v.speech, warnings: v.warnings.map((w) => w.code), attempts: attempt + 1, raws, first_errors: firstErr }
  }

  _publish(intent, v, human) {
    const prev = this.state
    const cancel = prev.speech && !prev.speech.released ? [...prev.cancel, prev.speech.utterance_id].slice(-20) : prev.cancel
    const speech = v.speech ? { utterance_id: 'u-' + intent.intent_id, intent_id: intent.intent_id, text: v.speech, kind: v.speech_kind, released: false } : null
    this.recent.push({ intent_id: intent.intent_id, goal: intent.goal, args: intent.args, status: 'issued', serves: intent.serves, text: intent.goal_spec?.text ?? null }); this.recent = this.recent.slice(-16)
    this.stats.intents++; this.lastIntentAt = this.now()
    this.log({ ev: 'intent', intent_id: intent.intent_id, goal: intent.goal, args: intent.args, speech: v.speech, speech_kind: v.speech_kind, serves: intent.serves, goal_spec: intent.goal_spec, place_ops: intent.place_ops?.length ? intent.place_ops : undefined, think_chars: (v.think ?? '').length, warnings: v.warnings.map((w) => w.code), human })
    this._bump({ intent, speech, cancel })
  }

  close() { this.scheduler.close() }
}
