// G2: goal stack (objective + interruptions + default resume), cook/fight options in S1, cook planning, fight target choice. No server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStack, classifyIntent } from '../src/s1/stack.js'
import { createS1 } from '../src/s1/selector.js'
import { planFuel, rawFoodCount } from '../src/skills/cook.js'
import { pickHostile, weaponOf, makeFight } from '../src/skills/fight.js'
import { Landmarks } from '../src/skills/landmarks.js'
import { Heatmap } from '../src/heatmap.js'
import { makeRng } from '../src/util.js'

const mkClock = () => { let t = 1000000; return { now: () => t, adv: (ms) => { t += ms } } }
const goHome = { intent_id: 'i1', goal: 'go_to', args: { place: 'home' }, serves: 'G1', objective: { text: 'walk home to build the lake house', end: null } }
const mk = (o = {}) => {
  const clk = mkClock(), events = [], resumed = [], logs = []
  const st = createStack({ now: clk.now, resumeAfterMs: 20000, calmMs: 3000, log: (e, d) => logs.push([e, d]), onInterruptionOver: (x) => events.push(x), onResume: async (it) => { resumed.push(it); return o.busy ? { skipped: 'body_busy' } : { resumed: true } } })
  return { clk, st, events, resumed, logs }
}

test('classify: reactions vs serving intents', () => {
  assert.equal(classifyIntent({ goal: 'eat', args: {} }).reaction, true)
  assert.equal(classifyIntent({ goal: 'fight', args: {} }).reaction, true)
  assert.equal(classifyIntent({ goal: 'go_to', args: { place: 'home' } }).reaction, false)
  assert.equal(classifyIntent({ goal: 'pursue', goal_spec: { type: 'defend' }, args: { type: 'defend' } }).reaction, true)
  assert.equal(classifyIntent({ goal: 'pursue', goal_spec: { type: 'go_to_place' }, args: { type: 'go_to_place' } }).reaction, false)
})

test('objective set by `now:`; a reflex pushes an interruption; S2 is told when it is over; silence -> resume_default of the SAME intent', async () => {
  const { clk, st, events, resumed } = mk()
  assert.equal(st.noteIntent(goHome).role, 'objective')
  assert.equal(st.view().status, 'active'); assert.equal(st.view().serves, 'G1')
  st.reflexStart('mob_defense')
  assert.equal(st.view().status, 'interrupted'); assert.match(st.view().interrupted_by, /mob_defense/); assert.equal(st.view().interruption_over, false)
  clk.adv(5000); await st.tick(); assert.equal(events.length, 0, 'still fighting')
  st.reflexEnd(); clk.adv(2000); await st.tick(); assert.equal(events.length, 0, 'calm period not over')
  clk.adv(1500); await st.tick(); assert.equal(events.length, 1, 'S2 gets ONE event when the interruption is over')
  assert.equal(events[0].objective.text, 'walk home to build the lake house')
  assert.equal(st.view().interruption_over, true); assert.ok(st.view().resume_in_s > 0)
  clk.adv(10000); await st.tick(); assert.equal(resumed.length, 0, 'S2 has time to answer')
  clk.adv(11000); await st.tick()
  assert.equal(resumed.length, 1); assert.equal(resumed[0].goal, 'go_to'); assert.deepEqual(resumed[0].args, { place: 'home' })
  assert.equal(st.view().status, 'active'); assert.equal(st.metrics().resumes_default, 1)
  clk.adv(30000); await st.tick(); assert.equal(resumed.length, 1, 'resumes once')
})

test('S2 answers after the interruption: no default resume; a non-reaction intent counts as S2 continuing, `now:` replaces', async () => {
  const a = mk(); a.st.noteIntent(goHome); a.st.reflexStart('mob_defense'); a.st.reflexEnd(); a.clk.adv(3500); await a.st.tick()
  a.clk.adv(5000); a.st.noteIntent({ intent_id: 'i2', goal: 'go_to', args: { place: 'home' } })
  a.clk.adv(30000); await a.st.tick(); assert.equal(a.resumed.length, 0); assert.equal(a.st.metrics().resumes_by_s2, 1); assert.equal(a.st.view().status, 'active')
  const b = mk(); b.st.noteIntent(goHome); b.st.reflexStart('x'); b.st.reflexEnd(); b.clk.adv(3500); await b.st.tick()
  b.st.noteIntent({ intent_id: 'i3', goal: 'explore', args: {}, objective: { text: 'look around the cliffs', end: null } })
  b.clk.adv(40000); await b.st.tick(); assert.equal(b.resumed.length, 0); assert.equal(b.st.view().text, 'look around the cliffs'); assert.equal(b.st.metrics().interrupted_then_abandoned, 1)
})

test('her own reaction (eat / fight without now:) is pushed on top and popped when it finishes; the objective survives', async () => {
  const { clk, st, events, resumed } = mk()
  st.noteIntent(goHome)
  assert.equal(st.noteIntent({ intent_id: 'e1', goal: 'fight', args: { target: 'zombie_1' } }).role, 'interruption')
  assert.equal(st.view().status, 'interrupted'); assert.equal(st.view().text, 'walk home to build the lake house')
  assert.equal(st.noteIntent({ intent_id: 'e2', goal: 'eat', args: {} }).role, 'interruption', 'a second reaction continues the same interruption')
  assert.equal(st.metrics().interruptions, 1)
  st.reactionEnded('e1'); clk.adv(4000); await st.tick(); assert.equal(events.length, 0, 'e2 still active? e1 end alone must not end it')
  st.reactionEnded('e2'); clk.adv(3500); await st.tick(); assert.equal(events.length, 1)
  clk.adv(21000); await st.tick(); assert.equal(resumed.length, 1); assert.equal(resumed[0].goal, 'go_to')
})

test('now: done / none end the objective with the right metric; act none is a no-op; an expired reflex without objective only counts', async () => {
  const { st } = mk()
  st.reflexStart('x'); assert.equal(st.metrics().interruptions_reflex, 1); assert.equal(st.view(), null)
  st.noteIntent(goHome); st.noteIntent({ intent_id: 'n', goal: 'none', args: {} })
  assert.equal(st.view().status, 'active')
  st.noteIntent({ intent_id: 'd', goal: 'none', args: {}, objective: { text: '', end: 'done' } })
  assert.equal(st.metrics().completed, 1); assert.equal(st.view(), null)
  st.noteIntent(goHome); st.noteIntent({ intent_id: 'x', goal: 'none', args: {}, objective: { text: '', end: 'dropped' } })
  assert.equal(st.metrics().dropped, 1); assert.equal(st.metrics().objective_completion, 0.5)
})

test('resume while the body is already on it (S1 continues its own goal after a reflex) is counted as inherent, not as a new action', async () => {
  const { clk, st, resumed } = mk({ busy: true })
  st.noteIntent(goHome); st.reflexStart('x'); st.reflexEnd(); clk.adv(3500); await st.tick(); clk.adv(21000); await st.tick()
  assert.equal(resumed.length, 1); assert.equal(st.metrics().resumes_default, 0); assert.equal(st.metrics().resumes_inherent, 1)
})

test('switch metric: skill starts by non-reflex owners, switches per minute', () => {
  const { clk, st } = mk()
  for (const n of ['go_to', 'go_to', 'hunt', 'eat', 'eat', 'go_to']) { st.noteStart(n, 's2'); clk.adv(2000) }
  st.noteStart('flee', 'reflex')
  assert.equal(st.metrics().switches, 3); assert.equal(st.switchesPerMin(), 3)
  clk.adv(61000); assert.equal(st.switchesPerMin(), 0)
})

// ---- S1 selector: defend fights with the sword, get_food cooks raw meat
const vec = (x, y, z) => ({ x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) } })
function rig({ items = [], hp = 20, food = 10, hostiles = 0, inv = {}, results = {}, ctx = {} } = {}) {
  const bot = { username: 'WrenT2', health: hp, food, entity: { position: vec(0, 64, 0), onGround: true }, entities: {}, players: {}, inventory: { items: () => items, emptySlotCount: () => 20 }, registry: { foodsByName: { beef: {}, cooked_beef: {} }, blocksByName: {} } }
  const env = { rng: makeRng(3), heatmap: new Heatmap({ rng: makeRng(1) }), landmarks: new Landmarks() }
  const calls = [], logs = [], finished = []
  const runner = { run: async (skill, args) => { calls.push({ skill, args }); const r = results[skill] ?? { status: 'done' }; return { ms: 5, reason: 'ok', ...(typeof r === 'function' ? r(bot) : r) } }, abort: async () => {} }
  const mkc = (b) => ({ bot: b, inv: { food: 0, free: 20, blocks: 20, logs: 0, rod: 0, beds: 0, sword: 0, axe: 0, raw: 0, furnace: 0, fuel: 0, cobble: 0, cooked: 0, ...inv }, animals: 0, animalNear: Infinity, night: false, dark: false, water: false, players: [], playerNear: false, hostiles, exposed: [], needs: { levels: { energy: 1 } }, underground: false, rng: env.rng, ...ctx })
  const s1 = createS1({ runner, getBot: () => bot, env, rng: env.rng, ctxFn: (b) => ({ c: mkc(b), rows: [] }), onFinish: (e) => finished.push(e), decisionLog: { write: (r) => logs.push(r) }, pauseMs: 1, sleep: () => new Promise((r) => setTimeout(r, 1)) })
  return { bot, calls, logs, finished, s1 }
}
test('defend with a sword: FIGHT is chosen over flee/hold; without a weapon and at low health it flees', async () => {
  const a = rig({ hostiles: 1, inv: { sword: 1 }, results: { fight: (b) => ({ status: 'done' }) } })
  a.s1.pursue({ type: 'defend', target: 'zombie_1', text: 'kill the zombie' }); await new Promise((r) => setTimeout(r, 40)); await a.s1.cancel()
  assert.equal(a.calls[0].skill, 'fight'); assert.deepEqual(a.calls[0].args, { target: 'zombie_1' })
  const top = a.logs[0].candidates; assert.ok(top.find((c) => c.name === 'fight').score > top.find((c) => c.name === 'hold').score)
  const b = rig({ hostiles: 1, hp: 5, inv: { sword: 1, blocks: 0, pickaxe: 0 } })   // SURV1: with blocks to seal herself in she would dig_in instead
  b.s1.pursue({ type: 'defend', target: 'zombie_1', text: 'survive' }); await new Promise((r) => setTimeout(r, 40)); await b.s1.cancel()
  assert.equal(b.calls[0].skill, 'flee', 'low health: flee')
  const c = rig({ hostiles: 1, hp: 20, inv: { sword: 1 }, results: { fight: { status: 'done' } } })
  c.s1.pursue({ type: 'defend', text: 'x' }, {}); await new Promise((r) => setTimeout(r, 40)); await c.s1.cancel()
  assert.equal(c.calls[0].skill, 'fight')
})
test('get_food with raw beef + fuel + cobblestone: cook first (not eat raw) unless starving; no furnace stuff -> stock cobblestone', async () => {
  const items = [{ name: 'beef', count: 2 }]
  const a = rig({ items, food: 10, inv: { food: 2, raw: 2, fuel: 6, cobble: 8 }, results: { cook: (b) => { b.food = 10; return { status: 'done' } } } })
  a.s1.pursue({ type: 'get_food', text: 'eat well' }); await new Promise((r) => setTimeout(r, 40)); await a.s1.cancel()
  assert.equal(a.calls[0].skill, 'cook')
  const b = rig({ items, food: 3, inv: { food: 2, raw: 2, fuel: 6, cobble: 8 } })
  b.s1.pursue({ type: 'get_food', text: 'starving', mods: { urgency: 1 } }); await new Promise((r) => setTimeout(r, 40)); await b.s1.cancel()
  assert.equal(b.calls[0].skill, 'eat', 'starving: eat now')
  const c = rig({ items, food: 12, inv: { food: 2, raw: 2, fuel: 6, cobble: 0, pickaxe: 1 } })
  c.s1.pursue({ type: 'get_food', text: 'prepare' }); await new Promise((r) => setTimeout(r, 40)); await c.s1.cancel()
  assert.ok(['gather_stone', 'eat'].includes(c.calls[0].skill), c.calls[0].skill)
  const d = rig({ items, food: 12, inv: { food: 2, raw: 2, fuel: 0, cobble: 8 } })
  d.s1.pursue({ type: 'get_food', text: 'no fuel' }); await new Promise((r) => setTimeout(r, 40)); await d.s1.cancel()
  assert.notEqual(d.calls[0].skill, 'cook')
})
test('a failed cook (no_fuel) is not retried for the same goal', async () => {
  const a = rig({ items: [{ name: 'beef', count: 1 }], food: 12, inv: { food: 1, raw: 1, fuel: 3, cobble: 8 }, results: { cook: { status: 'failed', reason: 'no_fuel' } } })
  a.s1.pursue({ type: 'get_food', text: 'x' }); await new Promise((r) => setTimeout(r, 80)); await a.s1.cancel()
  assert.equal(a.calls.filter((c) => c.skill === 'cook').length, 1)
})

// ---- body skills (pure parts)
const item = (name, count = 1) => ({ name, count, type: name.length })
test('cook: fuel plan prefers coal, then planks/logs; raw food count', () => {
  const bot = { inventory: { items: () => [item('coal', 2), item('oak_planks', 4), item('oak_log', 3), item('beef', 3), item('cooked_beef', 1)] } }
  assert.equal(rawFoodCount(bot), 3)
  const p = planFuel(bot, 3); assert.equal(p[0].item.name, 'coal'); assert.equal(p[0].count, 1)
  const q = planFuel({ inventory: { items: () => [item('oak_planks', 2)] } }, 3); assert.equal(q[0].count, 2)
  assert.equal(planFuel({ inventory: { items: () => [item('oak_planks', 1)] } }, 3), null)
  assert.equal(planFuel({ inventory: { items: () => [] } }, 1), null)
})
test('fight: best weapon (sword > axe), hostile choice, creepers are never auto-picked, preconditions', () => {
  const me = vec(0, 64, 0)
  const bot = { health: 20, entity: { position: me }, inventory: { items: () => [item('wooden_sword'), item('iron_sword'), item('stone_axe')] }, entities: { 1: { id: 1, name: 'creeper', position: vec(3, 64, 0) }, 2: { id: 2, name: 'zombie', position: vec(6, 64, 0) }, 3: { id: 3, name: 'cow', position: vec(2, 64, 0) }, 4: { id: 4, name: 'skeleton', position: vec(30, 64, 0) } } }
  assert.equal(weaponOf(bot).name, 'iron_sword')
  assert.equal(pickHostile(bot).name, 'zombie'); assert.equal(pickHostile(bot, 'creeper_1').name, 'creeper', 'explicit target honoured')
  const sk = makeFight()
  assert.equal(sk.precondition({ bot, args: {} }), true)
  assert.deepEqual(sk.precondition({ bot: { ...bot, health: 4 }, args: {} }), { ok: false, reason: 'low_health' })
  assert.deepEqual(sk.precondition({ bot: { ...bot, entities: {} }, args: {} }), { ok: false, reason: 'no_target_found' })
})
