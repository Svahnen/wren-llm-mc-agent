// DAY1: hurt + foodless Wren must forage in daylight (hard priority over habits), never hand back into an idle cycle.
// observed: rec2 'recovering over ... go and get food' then a shelter habit grabbed the body and get_food was rejected busy.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { Recover, recoverPlan } from '../src/recover.js'

const AIR = { name: 'air', boundingBox: 'empty' }, STONE = { name: 'stone', boundingBox: 'block' }
const FOODS = { porkchop: { foodPoints: 3, saturation: 1.8 }, cooked_porkchop: { foodPoints: 8, saturation: 12.8 }, cod: { foodPoints: 2, saturation: 0.4 }, sweet_berries: { foodPoints: 2, saturation: 0.4 } }
function world({ hp = 3, food = 9, inv = [], ticks = 6000, thunder = 0, entities = {}, sealed = true } = {}) {
  const bot = new EventEmitter()
  bot.blockAt = (v) => { const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z); if (y < 64) return STONE; if (!sealed) return AIR; if (x === 0 && z === 0) return y >= 66 ? STONE : AIR; return Math.abs(x) <= 1 && Math.abs(z) <= 1 && y <= 66 ? STONE : AIR }
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  bot.entities = entities; bot.health = hp; bot.food = food; bot.time = { timeOfDay: ticks }; bot.thunderState = thunder
  const stacks = new Map(inv)
  bot.inventory = { items: () => [...stacks].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: 1 })) }
  bot.stacks = stacks; bot.registry = { foodsByName: FOODS, blocksByName: { furnace: { id: 61 } } }; bot.findBlock = () => null; bot.findBlocks = () => []
  return bot
}
const animal = (name, x) => ({ name, position: new Vec3(x, 64, 0), isValid: true })
function rig(bot, { onRun = null, playbooks = null, foodSeen = null } = {}) {
  let t = Date.parse('2026-06-15T02:10:00Z'); const calls = [], events = []
  const runner = { run: async (name, args, o) => { calls.push([name, args]); const r = onRun?.(name, args, o); return r ?? { status: 'done' } }, abort: async () => {} }
  const r = new Recover({ getBot: () => bot, runner, arbiter: { owner: null }, trace: { event: (e, d) => events.push([e, d]) }, now: () => t, cfg: { tickMs: 1, busyMs: 1 }, playbooks: playbooks ? () => playbooks : null, env: { foodSeen: foodSeen ?? new Map() } })
  r.on('event', (x) => events.push(['say', x]))
  r.eligible(bot); t += 130000
  return { r, calls, events, adv: (ms) => { t += ms } }
}
const names = (calls) => calls.map((c) => c[0])

test('plan: daylight with no food -> forage; thunderstorm and dusk count as night (shelter, wait)', () => {
  assert.equal(recoverPlan(world()).kind, 'forage')
  assert.equal(recoverPlan(world({ thunder: 1 })).kind, 'wait', 'thunderstorm: mobs spawn, shelter is right')
  assert.equal(recoverPlan(world({ ticks: 12200 })).kind, 'wait', 'under 2 min to dusk: too late to go out')
  assert.equal(recoverPlan(world({ ticks: 18000 })).kind, 'wait')
  assert.equal(recoverPlan(world(), { forageBlocked: true }).kind, 'wait')
})

test('animals within 48 m: leaves the cell, hunts first, then eats to >= 18 (2/2 runs)', async () => {
  for (let k = 0; k < 2; k++) {
    const bot = world({ entities: { 1: animal('pig', 30), 2: animal('cow', 40) } })
    const { r, calls } = rig(bot, { onRun: (name) => {
      if (name === 'hunt') { bot.stacks.set('porkchop', 4); return { status: 'done' } }
      if (name === 'eat') { const n = bot.stacks.get('porkchop') ?? 0; if (!n) return { status: 'rejected', reason: 'no_food' }; bot.stacks.set('porkchop', n - 1); bot.food = Math.min(20, bot.food + 3); if (bot.food >= 18) bot.health = 10; return { status: 'done' } }
    } })
    await r.tick()
    assert.deepEqual(names(calls).slice(0, 2), ['exit_hole', 'hunt'])
    assert.ok(bot.food >= 18 && bot.health >= 10, `food ${bot.food}`)
    assert.equal(r.view().foraged, 1); assert.equal(r.active, false)
  }
})

test('no animals, string + sticks: crafts a rod and fishes; plants and expedition only after that', async () => {
  const bot = world({ inv: [['stick', 3], ['string', 2]] })
  const { r, calls } = rig(bot, { onRun: (name) => {
    if (name === 'craft') { bot.stacks.set('fishing_rod', 1); return { status: 'done' } }
    if (name === 'fish') { bot.stacks.set('cod', 2); return { status: 'done' } }
    if (name === 'eat') { bot.stacks.set('cod', 0); bot.food = 20; bot.health = 10; return { status: 'done' } }
  } })
  await r.tick()
  assert.deepEqual(names(calls).filter((n) => n !== 'exit_hole').slice(0, 3), ['craft', 'fish', 'eat'])
  assert.deepEqual(calls.find((c) => c[0] === 'craft')[1], { item: 'fishing_rod' })
})

test('no string: skips fishing; nothing found anywhere -> expedition food max_dist 120 is tried, then rests and retries (no hand-back, no tight loop)', async () => {
  const bot = world(); const pbCalls = []
  const playbooks = { active: () => false, cancel: async () => {}, start: (name, args) => { pbCalls.push([name, args]); return { ok: true, promise: Promise.resolve({ status: 'failed' }) } } }
  const seen = new Map([['pig:1,1', { name: 'pig', x: 60, y: 64, z: 60, t: Date.now() }]])
  const { r, calls, events } = rig(bot, { playbooks, foodSeen: seen })
  await r.tick()
  assert.ok(!names(calls).includes('fish') && !names(calls).includes('craft'))
  assert.deepEqual(pbCalls.map((c) => c[0]), ['get_food', 'resource_expedition'])
  assert.deepEqual(pbCalls[1][1], { resource: 'food', max_dist: 120 })
  assert.ok(events.some((e) => e[0] === 'rec2_forage_nothing'))
  assert.equal(recoverPlan(bot, { forageBlocked: true }).kind, 'wait')
  assert.ok(!events.some((e) => e[0] === 'say' && /go and get food/.test(e[1])), 'never "hands back" to an idle cycle any more')
})

test('hostile within 16 m aborts the forage at once (nothing is hunted), dusk too', async () => {
  const bot = world({ sealed: false, entities: { 1: animal('pig', 20), 2: { name: 'zombie', position: new Vec3(10, 64, 0), isValid: true } } })
  const { r, calls } = rig(bot)
  await r.tick()
  assert.ok(!names(calls).includes('hunt'), JSON.stringify(names(calls)))
  const b2 = world({ entities: { 1: animal('pig', 30) } })
  const g = rig(b2, { onRun: (name) => { if (name === 'exit_hole') b2.time.timeOfDay = 12400; return { status: 'done' } } })
  await g.r.tick()
  assert.ok(!names(g.calls).includes('hunt'), 'daylight ran out while leaving the cell: no hunt')
})

test('while foraging the escape ladder stays ON (walking in the open), while waiting in cover it is suppressed; the gate holds habits both times', async () => {
  const bot = world({ entities: { 1: animal('pig', 30) } }); let during = null, gated = null
  const { r } = rig(bot, { onRun: (name) => { if (name === 'hunt') { during = r.suppressLadder(); gated = r.gate('wander', { owner: 's1', intent_id: 'habit-9' }); bot.stacks.set('porkchop', 3) } if (name === 'eat') { bot.food = 20; bot.health = 10 } } })
  await r.tick()
  assert.equal(during, false); assert.equal(gated?.reason, 'busy')
})
