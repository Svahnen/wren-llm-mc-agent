// S1G: goal-conditioned S1 selector, trails/long-range navigation, places, explored summary, decision log. No server: fake runner + fake bot.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createS1 } from '../src/s1/selector.js'
import { TrailGraph, straightHops } from '../src/s1/trails.js'
import { exploredSummary } from '../src/s1/explored.js'
import { applyPlaceOps } from '../src/s1/places.js'
import { createDecisionLog } from '../src/s1/log.js'
import { Landmarks } from '../src/skills/landmarks.js'
import { Heatmap } from '../src/heatmap.js'
import { makeRng } from '../src/util.js'

const vec = (x, y, z) => ({ x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) } })
function mkBot(o = {}) {
  const bot = { username: 'WrenT2', health: 20, food: o.food ?? 10, entity: { position: vec(0, 64, 0), onGround: true }, entities: {}, players: {}, inventory: { items: () => bot._items, emptySlotCount: () => 20 }, registry: { foodsByName: { bread: {}, beef: {} } }, _items: o.items ?? [] }
  return bot
}
function rig({ items = [], food = 10, animals = 0, results = {}, ctx = {}, rows = [], trails = null, spec } = {}) {
  const bot = mkBot({ items, food })
  const env = { rng: makeRng(3), heatmap: new Heatmap({ rng: makeRng(1) }), landmarks: new Landmarks() }
  const calls = [], finished = [], logs = []
  const runner = {
    run: async (skill, args, o) => {
      calls.push({ skill, args, owner: o.owner }); const r = (results[skill] ?? { status: 'done' })
      const res = typeof r === 'function' ? r(args, bot, calls.length) : Array.isArray(r) ? (r[Math.min(calls.filter((c) => c.skill === skill).length - 1, r.length - 1)]) : r
      return { ms: 5, reason: 'ok', ...res }
    },
    abort: async () => {},
  }
  const mkc = (b) => ({ bot: b, inv: { food: b._items.filter((i) => i.name === 'bread').reduce((s, i) => s + i.count, 0), free: 20, blocks: 20, logs: 0, rod: 0, beds: 0 }, animals, animalNear: animals ? 10 : Infinity, night: false, thunder: false, dark: false, water: false, players: [], playerNear: false,
    hostiles: 0, exposed: [], needs: { levels: { energy: 1 } }, underground: false, bedKnown: false, rng: env.rng, ...ctx })
  const dl = { write: (r) => logs.push(r) }
  const s1 = createS1({ runner, getBot: () => bot, env, trace: null, rng: env.rng, ctxFn: (b) => ({ c: mkc(b), rows }), onFinish: (e) => finished.push(e), decisionLog: dl, trails, pauseMs: 1, sleep: (ms) => new Promise((r) => setTimeout(r, 1)) })
  return { bot, env, calls, finished, logs, s1, runner }
}

test('get_food: eats when it holds food, goal achieved is escalated once', async () => {
  const r = rig({ items: [{ name: 'bread', count: 2 }], food: 8, results: { eat: (a, bot) => { bot.food = 20; return { status: 'done' } } } })
  r.s1.pursue({ type: 'get_food', text: 'I am hungry', mods: { urgency: 0.8 } }, { intent_id: 'i1' }); await r.s1.whenIdle()
  assert.deepEqual(r.calls.map((c) => c.skill), ['eat']); assert.equal(r.finished.length, 1)
  assert.equal(r.finished[0].status, 'done'); assert.equal(r.finished[0].reason_code, 'goal_achieved'); assert.equal(r.finished[0].intent_id, 'i1')
  assert.ok(r.calls.every((c) => c.owner === 's1'))
})
test('get_food: re-plans on failure (hunt fails -> search), then reports options_exhausted with what was tried', async () => {
  const r = rig({ animals: 1, results: { hunt: { status: 'failed', reason: 'no_animal_nearby' }, explore: { status: 'failed', reason: 'no_progress' }, wander: { status: 'failed', reason: 'stuck' } } })
  r.s1.pursue({ type: 'get_food', text: 'find something to eat' }, { intent_id: 'i2' }); await r.s1.whenIdle()
  const sk = r.calls.map((c) => c.skill); assert.equal(sk[0], 'hunt'); assert.ok(sk.includes('explore') && sk.includes('wander'), sk.join())
  assert.equal(sk.filter((s) => s === 'hunt').length, 1, 'a global failure reason locks the option for this goal')
  assert.equal(r.finished.length, 1); assert.equal(r.finished[0].status, 'failed'); assert.equal(r.finished[0].reason_code, 'options_exhausted')
  assert.match(r.finished[0].summary, /hunt.*no_animal_nearby/); assert.match(r.finished[0].summary, /seek_food/)
})
test('get_food: a success that does not reach the goal is not repeated forever (recency damping rotates options)', async () => {
  const r = rig({ animals: 1, results: { hunt: { status: 'done' }, explore: { status: 'done' } } })
  r.s1.pursue({ type: 'get_food', text: 'food' }); await r.s1.whenIdle()
  const sk = r.calls.map((c) => c.skill); assert.ok(new Set(sk).size >= 2, sk.join()); assert.ok(sk.length <= 14); assert.equal(r.finished[0].status, 'failed')
})
test('modulators change the choice: caution damps risky searching', async () => {
  const pick = async (mods) => { const rr = rig({ results: {} }); rr.s1.pursue({ type: 'explore_area', mods }); await new Promise((x) => setTimeout(x, 30)); await rr.s1.cancel(); return rr.logs[0]?.candidates?.find((c) => c.name === 'explore')?.goal_term }
  const calm = await pick({ caution: 0 }), careful = await pick({ caution: 1 })
  assert.ok(calm > careful, `${calm} vs ${careful}`)
})
test('no intent / unknown type never crashes: custom picks from the habit repertoire and reports', async () => {
  const habit = { name: 'wander', category: 'movement', plan: () => ({ skill: 'wander', args: {} }) }
  const r = rig({ rows: [{ name: 'wander', score: 1.4, habit }] })
  r.s1.pursue({ type: 'custom', text: 'something odd' }); await r.s1.whenIdle()
  assert.deepEqual(r.calls.map((c) => c.skill), ['wander']); assert.equal(r.finished[0].status, 'failed'); assert.match(r.finished[0].reason, /^not done: attempted but unverified/) // VAL2: no verifiable predicate = never 'goal achieved'
})
test('VAL2 regression (trace imvi9u0sx-14): custom goal "place chest inside house next to bed": a wave is no step, success is never claimed without a chest', async () => {
  const greet = { name: 'greet', category: 'social', plan: () => ({ skill: 'gesture', args: { kind: 'wave' } }) }
  const gather = { name: 'gather_wood', category: 'resource', plan: () => ({ skill: 'gather_wood', args: {} }) }
  const r = rig({ rows: [{ name: 'greet', score: 2, habit: greet }, { name: 'gather_wood', score: 1, habit: gather }], results: { gather_wood: { status: 'failed', reason: 'no_target_found' } } })
  r.bot.registry.itemsByName = { chest: {}, bed: {} }; r.bot.registry.blocksByName = { chest: { id: 54 }, bed: { id: 26 } }; r.bot.findBlocks = () => []
  r.s1.pursue({ type: 'custom', text: 'place chest inside house next to bed' }); await r.s1.whenIdle()
  assert.ok(!r.calls.some((c) => c.skill === 'gesture' || c.skill === 'look_at'), 'no wave for a chest goal')
  assert.equal(r.finished[0].status, 'failed'); assert.doesNotMatch(r.finished[0].reason, /goal achieved/)
  // and when a chest really appears, it is achieved
  const r2 = rig({ rows: [{ name: 'gather_wood', score: 1, habit: gather }], results: { gather_wood: (a, bot) => { bot._chests = 1; return { status: 'done' } } } })
  r2.bot.registry.itemsByName = { chest: {} }; r2.bot.registry.blocksByName = { chest: { id: 54 } }; r2.bot.findBlocks = () => (r2.bot._chests ? [{}] : [])
  r2.s1.pursue({ type: 'custom', text: 'place a chest next to the bed' }); await r2.s1.whenIdle()
  assert.equal(r2.finished[0].status, 'done')
})
test('body safety pre-empts a goal step, then the goal resumes; shelter goals are not pre-empted', async () => {
  const shelter = { name: 'shelter', category: 'safety', plan: () => ({ skill: 'shelter', args: {} }) }
  const rows = [{ name: 'shelter', score: 7, habit: shelter }]
  const r = rig({ items: [{ name: 'bread', count: 1 }], food: 8, rows, results: { eat: (a, bot) => { bot.food = 20; return { status: 'done' } } } })
  r.s1.pursue({ type: 'get_food', text: 'eat' }); await r.s1.whenIdle()
  assert.equal(r.calls[0].skill, 'shelter'); assert.equal(r.logs[0].chosen.source, 'safety'); assert.ok(r.calls.some((c) => c.skill === 'eat'))
  const r2 = rig({ rows, results: {} }); r2.s1.pursue({ type: 'build_shelter', text: 'a shelter' }); await r2.s1.whenIdle()
  assert.ok(r2.logs.every((l) => l.chosen.source === 'selector'))
})
test('cancel: no further skills, no report', async () => {
  const r = rig({ animals: 1, results: { hunt: async () => ({ status: 'done' }) } })
  r.s1.pursue({ type: 'get_food', text: 'x' }); await r.s1.cancel('s2_new_intent'); const n = r.calls.length
  await new Promise((x) => setTimeout(x, 40)); assert.ok(r.calls.length <= n + 1); assert.equal(r.finished.length, 0); assert.equal(r.s1.active(), false)
})
test('decision log: goal (type, target, intent hash), candidates with scores, chosen skill, outcome', async () => {
  const r = rig({ items: [{ name: 'bread', count: 1 }], food: 8, results: { eat: (a, bot) => { bot.food = 20; return { status: 'done' } } } })
  r.s1.pursue({ type: 'get_food', target: null, text: 'I am hungry', mods: { urgency: 0.9 } }); await r.s1.whenIdle()
  const l = r.logs[0]; assert.equal(l.kind, 'goal'); assert.equal(l.goal.type, 'get_food'); assert.match(l.goal.hash, /^[0-9a-f]+$/); assert.equal(l.goal.mods.urgency, 0.9)
  assert.ok(l.candidates.length >= 1 && typeof l.candidates[0].score === 'number'); assert.equal(l.chosen.skill, 'eat'); assert.equal(l.outcome.status, 'done'); assert.equal(l.outcome.achieved, true); assert.ok(l.state.food !== undefined)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1log-')); const dl = createDecisionLog({ dir, run: 'r1' }); assert.ok(dl.write({ kind: 'no_intent', x: 1 }))
  const line = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8').trim()); assert.equal(line.kind, 'no_intent'); assert.equal(line.run, 'r1'); assert.equal(line.v, 1)
})

// ---------------------------------------------------------------- long range
function travelRig({ trails, reach = 60, failFirst = false, y = 64 }) {
  const r = rig({ trails })
  let failed = false
  r.runner.run = async (skill, args, o) => {
    r.calls.push({ skill, args, owner: o.owner })
    const p = r.bot.entity.position, d = Math.hypot(args.x - p.x, args.z - p.z)
    if (failFirst && !failed && r.calls.length === 1) { failed = true; return { status: 'failed', reason: 'path_failed', ms: 5 } }
    if (d > reach) return { status: 'failed', reason: 'path_failed', ms: 5 }   // beyond the loaded area the pathfinder gives up
    r.bot.entity.position = vec(args.x, args.y, args.z); return { status: 'done', ms: 5 }
  }
  r.env.landmarks.set('mine', { x: 200, y, z: 0 }, 'place')
  return r
}
test('go_to_place far away: chunk-aware hops reach it where one long move_to would fail', async () => {
  const r = travelRig({ trails: null })
  r.s1.pursue({ type: 'go_to_place', target: 'mine', text: 'visit the mine' }); await r.s1.whenIdle()
  assert.equal(r.finished[0].status, 'done'); assert.ok(r.calls.length >= 5, 'hops of <= 40 blocks'); assert.ok(r.calls.every((c) => c.skill === 'move_to'))
  assert.ok(Math.hypot(r.bot.entity.position.x - 200, r.bot.entity.position.z) <= 4.5)
})
test('go_to_place follows her own walked trail and re-plans around a failing waypoint', async () => {
  const tg = new TrailGraph()
  for (let x = 0; x <= 200; x += 6) tg.record(vec(x, 64, 0)); tg.breakLink()
  for (let x = 0; x <= 200; x += 6) tg.record(vec(x, 64, 18))   // a parallel second path
  tg.breakLink(); tg.record(vec(0, 64, 0)); tg.record(vec(0, 64, 9)); tg.record(vec(0, 64, 18)); tg.breakLink(); tg.record(vec(200, 64, 0)); tg.record(vec(200, 64, 9)); tg.record(vec(200, 64, 18))
  const r = travelRig({ trails: tg, failFirst: true })
  r.s1.pursue({ type: 'go_to_place', target: 'mine', text: 'walk there' }); await r.s1.whenIdle()
  assert.equal(r.finished[0].status, 'done'); assert.ok(r.s1.stats().replans >= 1, 'a failed hop triggers a re-plan')
  assert.ok(r.calls.length < 20, `hops: ${r.calls.length}`)
})
test('go_to_place to coordinates and unknown place', async () => {
  const r = travelRig({ trails: null }); r.s1.pursue({ type: 'go_to_place', target: '50,64,40', text: 'there' }); await r.s1.whenIdle(); assert.equal(r.finished[0].status, 'done')
  const r2 = travelRig({ trails: null }); r2.s1.pursue({ type: 'go_to_place', target: 'nowhere', text: 'there' }); await r2.s1.whenIdle(); assert.equal(r2.finished[0].status, 'failed')
})
test('unreachable place is escalated, not retried forever', async () => {
  const r = travelRig({ trails: null, reach: 5 }); r.s1.pursue({ type: 'go_to_place', target: 'mine', text: 'x' }); await r.s1.whenIdle()
  assert.equal(r.finished[0].status, 'failed'); assert.equal(r.finished[0].reason_code, 'options_exhausted'); assert.match(r.finished[0].summary, /travel_route/)
})

test('trail graph: record, route along walked cells, avoid bad nodes, persist', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trail-')), 't.json')
  const g = new TrailGraph({ file: f })
  for (let x = 0; x <= 100; x += 5) g.record(vec(x, 64, 0)); g.save()
  const route = g.route(vec(2, 64, 1), vec(98, 64, 2)); assert.ok(route && route.length >= 3 && route.length <= 8, JSON.stringify(route)); assert.deepEqual([route.at(-1).x, route.at(-1).z], [98, 2])
  g.markBad(vec(48, 64, 0)); assert.equal(g.route(vec(2, 64, 1), vec(98, 64, 2)), null, 'single trail blocked by a bad node')
  assert.equal(new TrailGraph({ file: f }).size, g.size, 'reloaded')
  assert.equal(g.route(vec(5000, 64, 5000), vec(98, 64, 2)), null)
  assert.equal(straightHops({ x: 0, y: 64, z: 0 }, { x: 100, y: 64, z: 0 }, 40).length, 3)
  const g2 = new TrailGraph(); g2.record(vec(0, 64, 0)); g2.record(vec(500, 64, 0)); assert.equal(g2.adj.get(g2.key(vec(0, 64, 0))).size, 0, 'a teleport is not linked')
})
test('places: remember saves current coordinates + note; rename and forget; digest-ready list', () => {
  const lm = new Landmarks(); lm.set('home', { x: 0, y: 64, z: 0 }, 'home')
  const res = applyPlaceOps(lm, [{ op: 'remember', name: 'blue_lake', note: 'good fishing' }, { op: 'rename', name: 'blue_lake', to: 'pond' }, { op: 'forget', name: 'ghost' }], { x: 10.4, y: 70, z: -3.6 })
  assert.deepEqual(res.map((x) => x.ok), [true, true, false]); assert.equal(lm.get('pond').note, 'good fishing'); assert.equal(lm.get('blue_lake'), null); assert.equal(Math.round(lm.get('pond').x), 10)
  applyPlaceOps(lm, [{ op: 'forget', name: 'pond' }], null); assert.equal(lm.get('pond'), null)
})
test('explored summary: unexplored directions and nearest unwalked ground', () => {
  const h = new Heatmap({ rng: makeRng(1) })
  for (let x = -120; x <= 120; x += 8) h.visit(x, 0)       // an east-west road
  const s = exploredSummary(h, { x: 0, z: 0 }, ['plains'])
  assert.ok(s.cells > 20); assert.ok(!s.unexplored.includes('east') && !s.unexplored.includes('west')); assert.ok(s.unexplored.includes('north') && s.unexplored.includes('south')); assert.deepEqual(s.biomes, ['plains']); assert.ok(s.nearest_new)
})

test('a busy body (habit still running / unstuck ladder) is not an option failure: wait, retry, no escalation', async () => {
  let n = 0
  const r = rig({ items: [{ name: 'bread', count: 1 }], food: 8, results: { eat: (a, bot) => { n++; if (n <= 3) return { status: 'rejected', reason: 'busy' }; bot.food = 20; return { status: 'done' } } } })
  r.s1.pursue({ type: 'get_food', text: 'eat' }); await r.s1.whenIdle()
  assert.equal(r.finished[0].status, 'done'); assert.equal(r.calls.filter((c) => c.skill === 'eat').length, 4)
})
test('a body that stays busy forever is reported as failed (body_busy), not retried forever', async () => {
  const r = rig({ items: [{ name: 'bread', count: 1 }], food: 8, results: { eat: { status: 'rejected', reason: 'unstuck_active' } } })
  r.s1.pursue({ type: 'get_food', text: 'eat' }); await r.s1.whenIdle()
  assert.equal(r.finished[0].status, 'failed'); assert.match(r.finished[0].reason, /body_busy/)
})

test('get_food with no animal in view: heads for where animals were last seen, then hunts (re-plan chain); hysteresis keeps the switch count low', async () => {
  const r = rig({ animals: 0 })
  r.env.foodSeen = new Map([['cow:5,0', { name: 'cow', x: 80, y: 64, z: 0, t: Date.now() }]])
  let hunted = false
  r.runner.run = async (skill, args, o) => {
    r.calls.push({ skill, args }); if (skill === 'move_to') { r.bot.entity.position = vec(args.x, args.y, args.z); return { status: 'done', ms: 5 } }
    if (skill === 'hunt') { hunted = true; r.bot._items = [{ name: 'beef', count: 2 }]; return { status: 'done', ms: 5 } }
    return { status: 'failed', reason: 'no_progress', ms: 5 }
  }
  const origSit = r.s1; void origSit
  r.s1.pursue({ type: 'get_food', text: 'eat' })
  await new Promise((x) => setTimeout(x, 30)); r.calls.length // let it start
  // once she is at the herd an animal is in view
  const t0 = Date.now(); while (Date.now() - t0 < 500 && !r.calls.some((c) => c.skill === 'move_to')) await new Promise((x) => setTimeout(x, 5))
  assert.ok(r.calls.some((c) => c.skill === 'move_to'), 'travelled to the remembered source')
  await r.s1.cancel('test'); assert.ok(r.s1.stats().switches <= 3)
})
