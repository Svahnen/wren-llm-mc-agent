// PB1: playbook engine + catalog + priority. Fake runner / fake bot, no server.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPlaybookEngine } from '../src/playbooks/engine.js'
import { loadLibrary, getPlaybook, playbookNames, parsePlaybookTarget, resolveParams, validateDef, defaultPlaybookFor } from '../src/playbooks/catalog.js'
import { hungerPolicy } from '../src/playbooks/priority.js'
import { PRED } from '../src/playbooks/predicates.js'
import { OPS } from '../src/playbooks/ops.js'
import { Landmarks } from '../src/skills/landmarks.js'

const vec = (x, y, z) => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) } })
function mkBot(o = {}) {
  const bot = { username: 'Wren', health: o.hp ?? 20, food: o.food ?? 20, entity: { position: vec(o.x ?? 0, 64, o.z ?? 0), onGround: true }, entities: {}, players: {}, thunderState: 0,
    inventory: { items: () => bot._items, emptySlotCount: () => 20 }, registry: { foodsByName: { bread: { foodPoints: 5 }, beef: { foodPoints: 3 }, cooked_beef: { foodPoints: 8 } }, blocksByName: {} }, _items: o.items ?? [], lookAt: async () => {}, time: { timeOfDay: 1000 } }
  return bot
}
function rig({ bot = mkBot(), onSkill = null, results = {}, calm = null, safety = null, know = null, stateFile = null, foodSource = null, now = Date.now } = {}) {
  const calls = [], notes = [], ended = []
  const env = { landmarks: new Landmarks(), foodSeen: new Map() }
  const runSkill = async (name, args, o) => {
    calls.push({ name, args })
    const f = await onSkill?.(name, args, bot, calls.length); if (f) return { ms: 1, ...f }
    const r = results[name]; const res = typeof r === 'function' ? r(args, bot, calls.filter((c) => c.name === name).length) : Array.isArray(r) ? r[Math.min(calls.filter((c) => c.name === name).length - 1, r.length - 1)] : (r ?? { status: 'done' })
    return { ms: 1, reason: 'ok', ...res }
  }
  const eng = createPlaybookEngine({ getBot: () => bot, runSkill, env, now, sleep: async () => {}, notify: (k, t, d) => notes.push({ k, t, d }), calm, safety, stateFile, foodSource })
  return { bot, eng, calls, notes, env, ended, know }
}
const run = async (R, name, args = {}, opts = {}) => { const st = R.eng.start(name, args, { know: R.know, onEnd: (e) => R.ended.push(e), ...opts }); assert.ok(st.ok, JSON.stringify(st.errors)); return { st, out: await st.promise } }

test('library: every playbook file is valid, uses known predicates and ops', async () => {
  const names = playbookNames()
  for (const n of ['show_place_to_person', 'go_home', 'get_food', 'make_tools', 'build_shelter', 'sleep_at_night', 'explore_and_return', 'gather', 'craft', 'wall_ring', 'dig_in', 'pillar_up', 'simple_hut']) assert.ok(names.includes(n), n)
  const { OPS: ops } = await import('../src/playbooks/ops.js')
  const walk = (steps, f) => steps.forEach((s) => { f(s); if (s.choose) walk(s.choose, f) })
  for (const n of names) {
    const d = getPlaybook(n); assert.deepEqual(validateDef(d), [])
    const preds = (l) => (l ?? []).map((p) => p.replace(/^!/, '').split(':')[0])
    for (const p of preds(d.done_if)) assert.ok(p in PRED, `${n}: ${p}`)
    walk(d.steps, (s) => { for (const k of ['when', 'done_if', 'ok']) for (const p of preds(s[k])) assert.ok(p in PRED, `${n}.${s.id}: ${p}`); for (const p of preds(s.loop?.until)) assert.ok(p in PRED, `${n}.${s.id}`); if (s.op) assert.ok(s.op in ops, `${n}.${s.id}: op ${s.op}`) })
  }
  assert.throws(() => loadLibrary('/nonexistent-dir-pb1'))
})

test('catalog: target parsing, param validation, default playbook mapping', () => {
  assert.deepEqual(parsePlaybookTarget('show_place_to_person person=Alex place="my house"'), { name: 'show_place_to_person', args: { person: 'Alex', place: 'my house' } })
  assert.deepEqual(parsePlaybookTarget('gather(resource=wood, count=8)').args, { resource: 'wood', count: '8' })
  assert.deepEqual(parsePlaybookTarget('gather stone 5').args, { resource: 'stone', count: '5' })
  const d = getPlaybook('show_place_to_person')
  assert.equal(resolveParams(d, { person: 'x' }).ok, false)
  const r = resolveParams(d, { person: 'alex', place: 'house' }, { players: ['Alex'], places: ['house'] }); assert.ok(r.ok); assert.equal(r.params.person, 'Alex')
  assert.equal(resolveParams(d, { person: 'nobody', place: 'house' }, { players: ['Alex'], places: ['house'] }).ok, false)
  assert.equal(resolveParams(getPlaybook('gather'), { resource: 'unobtainium' }).ok, false)
  assert.equal(defaultPlaybookFor({ type: 'get_food' }).name, 'get_food')
  assert.equal(defaultPlaybookFor({ type: 'find_resource', target: 'wood' }).args.resource, 'wood')
  assert.equal(defaultPlaybookFor({ type: 'talk' }), null)
})

test('priority: hunger interrupts only at food<=6 and (hp<10 or food within 16 m)', () => {
  assert.equal(hungerPolicy({ food: 7, hp: 5, src: 0 }).interrupt, false)
  assert.equal(hungerPolicy({ food: 4, hp: 20, src: 40 }).interrupt, false)
  assert.equal(hungerPolicy({ food: 4, hp: 20, src: 40 }).defer, true)
  assert.equal(hungerPolicy({ food: 4, hp: 9, src: 100 }).interrupt, true)
  assert.equal(hungerPolicy({ food: 6, hp: 20, src: 15 }).interrupt, true)
  assert.equal(hungerPolicy({ food: 0, hp: 20, src: Infinity }).interrupt, false)
})

test('get_food: eats held food; cooks raw before hunting; falls through the ranked options', async () => {
  let R = rig({ bot: mkBot({ food: 8, items: [{ name: 'bread', count: 2 }] }), results: { eat: (a, b) => { b.food = 20; return { status: 'done' } } } })
  let { out } = await run(R, 'get_food'); assert.equal(out.status, 'done'); assert.equal(R.calls[0].name, 'eat')
  // raw beef, fuel, cobble: cook, then eat (the furnace is made by the cook skill)
  R = rig({ bot: mkBot({ food: 8, items: [{ name: 'beef', count: 2 }, { name: 'coal', count: 2 }, { name: 'cobblestone', count: 8 }, { name: 'oak_planks', count: 4 }] }), onSkill: (n, a, b) => { if (n === 'cook') { b._items = [{ name: 'cooked_beef', count: 2 }] } if (n === 'eat') b.food = 20; return null } })
  ;({ out } = await run(R, 'get_food')); assert.equal(out.status, 'done'); assert.deepEqual(R.calls.map((c) => c.name), ['cook', 'eat'])
  // nothing held, no animals, a remembered herd: walks there, hunts
  R = rig({ bot: mkBot({ food: 8 }), onSkill: (n, a, b) => { if (n === 'hunt') { b._items = [{ name: 'beef', count: 1 }]; return { status: 'done' } } if (n === 'move_to') { b.entity.position = vec(a.x, 64, a.z); b.entities.c = { name: 'cow', position: vec(a.x + 3, 64, a.z) } } if (n === 'eat') b.food = 20; return null } })
  R.env.foodSeen.set('cow', { name: 'cow', x: 60, y: 64, z: 0, t: Date.now() })
  ;({ out } = await run(R, 'get_food')); assert.equal(out.status, 'done', JSON.stringify(R.ended)); assert.ok(R.calls.some((c) => c.name === 'hunt'))
  // starving with raw meat and nothing to cook with: eats it raw as a last resort
  R = rig({ bot: mkBot({ food: 3, items: [{ name: 'beef', count: 1 }] }), onSkill: (n, a, b) => { if (n === 'eat') { b.food = 8; b._items = [{ name: 'bread', count: 0 }] } return null } })
  ;({ out } = await run(R, 'get_food')); assert.ok(R.calls.some((c) => c.name === 'eat'))
})

test('get_food: nothing anywhere -> fails with a reason S2 can read', async () => {
  const R = rig({ bot: mkBot({ food: 3 }), results: { explore: { status: 'done' } } })
  const { out } = await run(R, 'get_food'); assert.equal(out.status, 'failed'); assert.equal(out.reason, 'no_food_found')
  assert.match(R.ended[0].summary, /obtain/)
})

test('step recovery: retry, skip, abort with reason; ok-check failure counts as failure', async () => {
  const R = rig({ bot: mkBot({ food: 20 }), results: { gather_wood: [{ status: 'failed', reason: 'timeout' }, { status: 'failed', reason: 'timeout' }, { status: 'failed', reason: 'timeout' }] } })
  const { out } = await run(R, 'make_tools'); assert.equal(out.status, 'failed'); assert.equal(out.reason, 'no_wood'); assert.equal(R.calls.filter((c) => c.name === 'gather_wood').length, 3)   // BAT1: no_target_found is not retried (bat1.test.mjs), other failures are
  assert.ok(R.notes.some((n) => n.k === 'step_failed'))
  const R2 = rig({ bot: mkBot({ food: 20 }), results: { gather_wood: [{ status: 'failed', reason: 'x' }, { status: 'done' }] } })
  R2.bot._items = []; const r2 = await run(R2, 'make_tools')   // second try "succeeds" but the ok-check (logs in pack) fails -> keeps failing -> abort
  assert.equal(r2.out.status, 'failed')
})

test('interruption: a reflex preemption pauses the step, then the SAME step is retried (resume counted, not a failure)', async () => {
  let n = 0
  const R = rig({ bot: mkBot({ food: 20, items: [{ name: 'oak_log', count: 1 }] }), results: { gather_stone: () => (++n === 1 ? { status: 'aborted', reason: 'preempted_by:reflex' } : { status: 'done' }) }, calm: async () => true })
  R.bot.thunderState = 0
  const { out } = await run(R, 'gather', { resource: 'stone', count: 1 }, {})
  R.eng.metrics()
  assert.ok(R.eng.metrics().interruptions >= 1); assert.ok(R.eng.metrics().resumes >= 1)
  assert.equal(R.calls.filter((c) => c.name === 'gather_stone').length >= 2, true)
  assert.notEqual(out.status, 'cancelled')
})

test('persistence: cancel keeps the step; the same playbook+args resumes there', async () => {
  const f = path.join(os.tmpdir(), `pb1-${process.pid}-${Date.now()}.json`)
  let release
  const gate = new Promise((r) => { release = r })
  const bot = mkBot({ food: 20 })
  const R = rig({ bot, stateFile: f, onSkill: async (n) => null })
  R.know = null
  // make explore_and_return stall in 'out' so we can cancel it
  let stall = true
  const R1 = rig({ bot, stateFile: f, onSkill: (n) => (n === 'explore' && stall ? new Promise((res) => gate.then(() => res({ status: 'aborted', reason: 'playbook_step' }))) : null) })
  const st = R1.eng.start('explore_and_return', { radius: 40 }, {})
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(R1.eng.view().step, 'out'); assert.equal(R1.eng.view().k, 2); assert.equal(R1.eng.view().n, 3)
  const c = R1.eng.cancel('new_intent'); release(); await c; await st.promise
  const saved = JSON.parse(fs.readFileSync(f, 'utf8')); assert.equal(saved.stepIdx, 1); assert.equal(saved.status, 'interrupted')
  stall = false

  const R2 = rig({ bot, stateFile: f })
  const st2 = R2.eng.start('explore_and_return', { radius: 40 }, {}); assert.equal(st2.resumed, true)
  await st2.promise
  assert.ok(R2.calls.length > 0); fs.rmSync(f, { force: true })
  assert.equal(R2.eng.metrics().resumed_runs, 1)
})

test('hunger calibration: food 4, hp 20, no food close -> queued as "after this", playbook is NOT interrupted', async () => {
  const bot = mkBot({ food: 4 })
  const R = rig({ bot, foodSource: () => Infinity })
  const { out } = await run(R, 'explore_and_return', { radius: 5 })
  assert.equal(out.status, 'done'); assert.equal(R.eng.metrics().hunger_interrupts, 0); assert.equal(R.eng.metrics().hunger_deferred, 1)
  assert.deepEqual(R.ended[0].after_this.length, 1); assert.match(R.ended[0].summary, /After this/)
  assert.ok(!R.calls.some((c) => c.name === 'eat' || c.name === 'hunt'))
})

test('hunger calibration: food 4 and hp 8 -> get_food runs as a child, then the playbook continues at its step', async () => {
  const bot = mkBot({ food: 4, hp: 8, items: [{ name: 'bread', count: 2 }] })
  const R = rig({ bot, onSkill: (n, a, b) => { if (n === 'eat') b.food = 20; return null } })
  const { out } = await run(R, 'explore_and_return', { radius: 5 })
  assert.equal(out.status, 'done'); assert.equal(R.eng.metrics().hunger_interrupts, 1); assert.ok(R.eng.metrics().resumes >= 1)
  assert.equal(R.calls[0].name, 'eat')
  assert.ok(R.calls.some((c) => c.name === 'explore'))
})

test('steering: skip a step, abort with a reason, change args', async () => {
  let rel
  const R = rig({ bot: mkBot({ food: 20 }), onSkill: (n) => (n === 'explore' ? new Promise((res) => { rel = () => res({ status: 'aborted', reason: 'playbook_step' }) }) : null) })
  const st = R.eng.start('explore_and_return', { radius: 40 }, {})
  await new Promise((r) => setTimeout(r, 20))
  const s = await R.eng.steer({ set: { radius: 10 } }); assert.equal(s.ok, true); assert.equal(R.eng.view().args.radius, 10)
  const sk = R.eng.steer({ skip: true }); rel(); await sk
  const out = await st.promise
  assert.ok(['done', 'failed'].includes(out.status))
  assert.ok(R.eng.metrics().steered >= 2)
  // abort
  let rel2
  const R2 = rig({ bot: mkBot({ food: 20 }), onSkill: (n) => (n === 'explore' ? new Promise((res) => { rel2 = () => res({ status: 'aborted', reason: 'playbook_step' }) }) : null) })
  const st2 = R2.eng.start('explore_and_return', { radius: 40 }, {}); await new Promise((r) => setTimeout(r, 20))
  const ab = R2.eng.steer({ abort: 'changed my mind' }); rel2(); await ab
  const o2 = await st2.promise; assert.equal(o2.status, 'aborted'); assert.equal(o2.reason, 'changed my mind')
})

test('show_place_to_person: waits for a person who falls behind, arrives, presents; person lost -> fails after the wait budget', async () => {
  const bot = mkBot({ food: 4, hp: 20 })
  const R = rig({ bot, know: { players: ['Alex'], places: ['house'] } })
  R.env.landmarks.set('house', { x: 60, y: 64, z: 0 }, 'place')
  bot.players.Alex = { entity: { position: vec(3, 64, 0) } }
  let clock = 0
  R.calls.length = 0
  const eng = createPlaybookEngine({ getBot: () => bot, env: R.env, sleep: async () => { clock++; const p = bot.players.Alex.entity.position; const me = bot.entity.position; if (clock > 3 && clock < 8) return; p.x = Math.min(me.x + 4, p.x + 6) }, notify: (k, t) => R.notes.push({ k, t }), foodSource: () => Infinity,
    runSkill: async (name, args) => { R.calls.push({ name, args }); if (name === 'move_to') bot.entity.position = vec(args.x, 64, args.z); return { status: 'done', ms: 1 } } })
  const st = eng.start('show_place_to_person', { person: 'Alex', place: 'house' }, { know: R.know })
  assert.ok(st.ok, JSON.stringify(st.errors)); const out = await st.promise
  assert.equal(out.status, 'done', JSON.stringify(R.notes))
  assert.ok(R.calls.filter((c) => c.name === 'move_to').length >= 3)
  assert.ok(R.notes.some((n) => n.k === 'show_start')); assert.ok(R.notes.some((n) => n.k === 'show_arrived'))
  assert.ok(!R.calls.some((c) => ['eat', 'hunt', 'cook'].includes(c.name)), 'food 4, hp 20, no food close: no hijack')
  assert.equal(eng.metrics().hunger_interrupts, 0)
  // lost person
  const bot2 = mkBot({ food: 20 }); bot2.players.Alex = { entity: { position: vec(2, 64, 0) } }
  const eng2 = createPlaybookEngine({ getBot: () => bot2, env: R.env, sleep: async () => { bot2.players.Alex.entity.position = vec(900, 64, 900) }, notify: (k) => R.notes.push({ k }), runSkill: async (n, a) => { if (n === 'move_to') bot2.entity.position = vec(a.x, 64, a.z); return { status: 'done', ms: 1 } } })
  const st2 = eng2.start('show_place_to_person', { person: 'Alex', place: 'house' }, { know: R.know }); const o2 = await st2.promise
  assert.equal(o2.status, 'failed'); assert.ok(['could_not_get_there', 'person_lost'].includes(o2.reason))
  assert.ok(R.notes.some((n) => n.k === 'person_lost'))
})
