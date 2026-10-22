// G2: goal stack in the S2 contract: `now:` objective line, goal/progress/drop ops, max 3 long-term goals, nightly review, prompt shows goals + objective + interrupted-from.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Brain } from '../brain.js'
import { FakeS2 } from '../fake-s2.js'
import { parseOutput, validate, makeIntent, parseNow, validateIntent } from '../contract.js'
import { buildMessages, renderObjective } from '../prompt.js'
import { GoalStore, parseReview, reviewGoals, MAX_ACTIVE } from '../../mind/goals.js'
import { dg } from './helpers.js'

const quiet = () => {}
const mk = (script) => new Brain({ llm: new FakeS2({ mode: 'scripted', script }), log: quiet, autonomy: 'high' })

test('parse: `now:` objective with serves, one-line form, done/none, old formats unchanged', () => {
  const p = parseOutput('{act:go_to,args:{place:home}}\n---\nTHINK: home first.\nnow: walk home to build the lake house\nserves: G1\nprogress: gathered 12 logs')
  assert.equal(p.ok, true); assert.equal(p.meta.now, 'walk home to build the lake house'); assert.equal(p.meta.serves, 'G1'); assert.equal(p.meta.note, 'gathered 12 logs')
  const one = parseOutput('{act:go_to,args:{place:home}}\n---\nnow: walk home, serves: G1')
  assert.equal(one.meta.now, 'walk home'); assert.equal(one.meta.serves, 'G1')
  const obj = parseOutput('{act:none,args:{}}\n---\nobjective: collect wood\ndrop: G2 not interesting any more')
  assert.equal(obj.meta.now, 'collect wood'); assert.equal(obj.meta.abandon, 'G2 not interesting any more')
  assert.deepEqual(parseNow('done'), { text: '', end: 'done' }); assert.deepEqual(parseNow('none'), { text: '', end: 'dropped' }); assert.equal(parseNow(''), null); assert.equal(parseNow(undefined), null)
  const old = parseOutput('{act:explore,args:{direction:east}}\n---\nSAY: Heading east.\ngoal: find the river\nwhy: curious')
  assert.equal(old.meta.now, undefined); assert.equal(old.meta.goal, 'find the river'); assert.equal(old.speech, 'Heading east.')
})
test('intent carries the objective; S2 intent without now: has objective null', () => {
  const v = validate(parseOutput('{act:go_to,args:{place:home}}\n---\nnow: walk home\nserves: G1'), dg())
  assert.equal(v.ok, true)
  const it = makeIntent(v, dg(), { serves: 'G1' })
  assert.deepEqual(it.objective, { text: 'walk home', end: null }); assert.deepEqual(validateIntent(it), [])
  const v2 = validate(parseOutput('{act:go_to,args:{place:home}}\n---\n'), dg())
  assert.equal(makeIntent(v2, dg()).objective, null)
})
test('cook and fight are part of the vocabulary and validated', () => {
  const d = dg({ inventory: { beef: 2, iron_sword: 1, oak_log: 3 } })
  assert.equal(validate(parseOutput('{act:cook,args:{}}\n---\n'), d).ok, true)
  assert.equal(validate(parseOutput('{act:fight,args:{target:zombie_1}}\n---\n'), d).ok, true)
  assert.equal(validate(parseOutput('{act:fight,args:{target:made_up_9}}\n---\n'), d).ok, false)
  const starving = dg({ food: 2, inventory: { beef: 2 } })
  assert.ok(!validate(parseOutput('{act:cook,args:{}}\n---\n'), starving).errors.some((e) => e.code === 'needs_starving'), 'cook serves a starving body with raw meat')
})

test('long-term goals: at most 3, reword by id, progress notes, drop; render shows order', () => {
  const g = new GoalStore()
  for (const t of ['build a lake house', 'find diamonds', 'befriend the fox']) g.apply({ goal: t, why: 'w' })
  assert.equal(MAX_ACTIVE, 3)
  const r4 = g.apply({ goal: 'a fourth thing' }); assert.equal(r4.created, null); assert.match(r4.rejected[0], /goal_limit.*3 long-term/)
  g.apply({ goal: 'G1: build a lake house with a dock' }); assert.equal(g.get('G1').text, 'build a lake house with a dock'); assert.equal(g.active().length, 3)
  g.apply({ note: 'gathered 12 logs', serves: 'G1' }); assert.deepEqual(g.get('G1').notes, ['gathered 12 logs'])
  g.apply({ abandon: 'G2 boring' }); assert.equal(g.get('G2').status, 'abandoned')
  assert.match(g.render(), /most important first/); assert.match(g.render(), /so far: gathered 12 logs/)
})
test('nightly review: keep / drop / reorder through the LLM callback; silence keeps; parse is tolerant; works through the store', async () => {
  const g = new GoalStore()
  for (const t of ['build a lake house', 'find diamonds', 'befriend the fox']) g.apply({ goal: t })
  const ops = parseReview('**keep: G1** the foundation is done\n- drop G2 - no cave found in two days\n3. order: G3, G1\nnoise')
  assert.deepEqual(ops.keep, [{ id: 'G1', note: 'the foundation is done' }]); assert.deepEqual(ops.drop, [{ id: 'G2', reason: 'no cave found in two days' }]); assert.deepEqual(ops.order, ['G3', 'G1'])
  let seen = null
  const r = await reviewGoals(g, async (m) => { seen = m; return 'keep: G1 foundation done\ndrop: G2 no cave\norder: G3 G1' }, { summary: 'a quiet day' })
  assert.match(seen[1].content, /build a lake house/); assert.match(seen[1].content, /a quiet day/)
  assert.deepEqual(r.result.kept, ['G1']); assert.deepEqual(r.result.dropped, ['G2']); assert.equal(r.result.ordered, true)
  assert.deepEqual(g.active().map((x) => x.id), ['G3', 'G1']); assert.equal(g.reviewSeq, 1); assert.match(g.get('G1').notes.at(-1), /review: foundation done/)
  const none = await reviewGoals(g, async () => 'I am not sure what to say'); assert.equal(none.result, null); assert.equal(g.active().length, 2)
  assert.equal(await reviewGoals(new GoalStore(), async () => 'x'), null)
})
test('brain adopts the reviewed goal store from the context (goals_replace) once per reviewSeq', () => {
  const b = mk(['{act:none,args:{}}\n---\n'])
  b.handleEvent({ type: 'body_state', state: 'context', context: { self_summary: 's' } })
  const g = new GoalStore(); g.apply({ goal: 'x' }); g.apply({ goal: 'y' }); g.review({ drop: [{ id: 'G2', reason: 'no' }], order: [] })
  b.handleEvent({ type: 'body_state', state: 'context', context: { goals_replace: g.snapshot() } })
  assert.equal(b.goals.get('G2').status, 'abandoned'); assert.equal(b.goals.reviewSeq, 1)
  b.goals.apply({ goal: 'z' })
  b.handleEvent({ type: 'body_state', state: 'context', context: { goals_replace: g.snapshot() } })
  assert.ok(b.goals.get('G3'), 'a stale replace (same reviewSeq) is ignored')
})

test('prompt: shows long-term goals, the objective, the interruption (interrupted-from) and what she holds; no objective -> invitation', () => {
  const g = new GoalStore(); g.apply({ goal: 'build a lake house', why: 'beautiful' })
  const obj = { text: 'walk home to gather the tools', serves: 'G1', age_s: 130, status: 'interrupted', interrupted_by: 'reflex mob_defense', interrupted_s: 35, interruption_over: true, resume_in_s: 12, was_doing: 'go to home', resumed: 1 }
  const m = buildMessages({ job: { kind: 'heartbeat', events: [] }, digest: dg({ objective: obj, holding: 'iron_sword' }), goals: g.render(), autonomy: 'high' })[1].content
  assert.match(m, /Your long-term goals/); assert.match(m, /build a lake house/)
  assert.match(m, /Your current objective/); assert.match(m, /walk home to gather the tools \(serves G1\), started 2 min ago/)
  assert.match(m, /INTERRUPTED 35 s ago by reflex mob_defense \(that is over now\)\. You were: go to home/); assert.match(m, /continue it, change it, or drop it/); assert.match(m, /about 12 s/)
  assert.match(m, /in your hand: iron_sword/)
  const none = buildMessages({ job: { kind: 'heartbeat', events: [] }, digest: dg(), goals: '', autonomy: 'high' })[1].content
  assert.match(none, /no current objective/)
  assert.equal(renderObjective({ text: '' }), '')
  const classic = buildMessages({ job: { kind: 'heartbeat', events: [] }, digest: dg({ objective: obj }), autonomy: 'classic' })[1].content
  assert.doesNotMatch(classic, /objective/i)
})
test('brain end-to-end: `now:` + goal ops in one answer produce a goal AND an intent that carries the objective', async () => {
  const b = mk(['{act:go_to,args:{place:home}}\n---\nTHINK: go home first.\ngoal: build a lake house\nwhy: it is calm there\nplan: gather; build\nnow: walk home\nserves: G1'])
  b.handleEvent({ type: 'heartbeat', digest: dg() })
  await new Promise((r) => setTimeout(r, 1500))
  const it = (await b.getIntent({})).intent
  assert.ok(it, 'intent published'); assert.equal(it.objective.text, 'walk home'); assert.equal(b.goals.active().length, 1)
  b.close()
})

test('regression: goal text and reason stay separate; copied "(why: ...)" never accumulates in the text; updates replace; length capped', () => {
  const g = new GoalStore()
  g.apply({ goal: 'map the river valley and find iron (why: I am at 0 food) (why: skeletons nearby)' })
  assert.equal(g.get('G1').text, 'map the river valley and find iron'); assert.equal(g.get('G1').why, 'I am at 0 food')
  g.apply({ goal: 'G1: map the river valley and find iron (why: hp 10) (why: more)', why: 'hp 10 now' })
  assert.equal(g.get('G1').text, 'map the river valley and find iron'); assert.equal(g.get('G1').why, 'hp 10 now')
  const dup = g.apply({ goal: 'map the river valley and find iron (why: yet another)' }); assert.equal(dup.created, null); assert.equal(g.goals.length, 1)
  assert.doesNotMatch(g.render(), /\(why:.*\(why:/)
  const old = GoalStore.fromJSON({ goals: [{ id: 'G1', text: 'x (why: a) (why: b) (why: c)', why: '', status: 'active', plan: [], notes: [], created_ms: 0 }], nextId: 2 })
  assert.equal(old.get('G1').text, 'x'); assert.equal(old.get('G1').why, 'a')
  g.apply({ goal: 'G1: ' + 'long '.repeat(100) }); assert.ok(g.get('G1').text.length <= 200)
})
