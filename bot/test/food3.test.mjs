// FOOD3: starving + foodless Wren: non-urgent playbooks wait, no-progress timeout, no eat for forbidden food, forage_plants empty-search memory.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlaybookEngine, NO_PROGRESS_MS } from '../src/playbooks/engine.js'
import { yieldsToFood } from '../src/playbooks/priority.js'
import { inventoryFacts } from '../src/habits/needs.js'
import { CATALOG } from '../src/habits/catalog.js'
import { makeForagePlants, emptySearch, recentEmpty } from '../src/skills/forageplants.js'
import { Landmarks } from '../src/skills/landmarks.js'

const vec = (x, y, z) => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) } })
const FOODS = { bread: { foodPoints: 5 }, pufferfish: { foodPoints: 1 }, rotten_flesh: { foodPoints: 4 } }
function mkBot({ food = 2, hp = 9, items = [] } = {}) {
  const bot = { username: 'Wren', health: hp, food, entity: { position: vec(0, 64, 0), onGround: true }, entities: {}, players: {}, thunderState: 0, time: { timeOfDay: 2000 },
    inventory: { items: () => items, emptySlotCount: () => 20 }, registry: { foodsByName: FOODS, blocksByName: {} } }
  return bot
}
function eng(bot, runSkill, extra = {}) {
  return createPlaybookEngine({ getBot: () => bot, runSkill, env: { landmarks: new Landmarks(), foodSeen: new Map() }, sleep: async () => {}, ...extra })
}

test('yieldsToFood: torch_perimeter / daylight go_home wait when starving and foodless; shelter, get_food, night go_home do not', () => {
  const h = { food: 2, hasFood: false }
  assert.equal(yieldsToFood('torch_perimeter', h), true)
  assert.equal(yieldsToFood('go_home', h), true)
  assert.equal(yieldsToFood('go_home', { ...h, night: true }), false)
  assert.equal(yieldsToFood('torch_perimeter', { ...h, hasFood: true }), false)
  assert.equal(yieldsToFood('torch_perimeter', { food: 12, hasFood: false }), false)
  for (const n of ['get_food', 'dig_in', 'sleep_at_night', 'build_shelter', 'hole_and_cap']) assert.equal(yieldsToFood(n, h), false)
})

test('engine.start refuses torch_perimeter at food 2 with nothing to eat (nothing edible), allows it with bread', () => {
  const calls = []
  const e = eng(mkBot(), async (n) => { calls.push(n); return { status: 'done', ms: 1 } })
  const st = e.start('torch_perimeter', { radius: 6 })
  assert.equal(st.ok, false); assert.equal(st.hungry, true); assert.match(st.errors[0], /hunt|get_food/)
  assert.equal(calls.length, 0)
  const e2 = eng(mkBot({ items: [{ name: 'bread', count: 2 }] }), async (n) => { calls.push(n); return { status: 'done', ms: 1 } })
  assert.equal(e2.start('torch_perimeter', { radius: 6 }).ok, true)
})

test('a step that is only interrupted/busy for more than NO_PROGRESS_MS fails with no_progress_timeout', async () => {
  let t = 1000
  const bot = mkBot({ food: 20, hp: 20 })
  const runSkill = async () => { t += 20000; return { status: 'rejected', reason: 'busy', holder: 'reflex:low_health_flee', ms: 1 } }
  const e = eng(bot, runSkill, { now: () => t, calm: async () => true })
  const st = e.start('go_home', {}, {})
  assert.equal(st.ok, true)
  const out = await st.promise
  assert.equal(out.status, 'failed')
  assert.ok(NO_PROGRESS_MS <= 90000)
  assert.match(String(out.reason), /no_progress_timeout|no_route_home/)
})

test('pufferfish only: habit eat does not apply (badFood ignores forbidden food); rotten flesh at food 2 still does', () => {
  const eatH = CATALOG.find((h) => h.name === 'eat')
  const mk = (items, hp = 9) => { const b = mkBot({ food: 2, hp, items }); const inv = inventoryFacts(b); return { bot: b, inv, exposed: [], tier: 2 } }
  assert.equal(inventoryFacts(mkBot({ items: [{ name: 'pufferfish', count: 2 }] })).badFood, 0)
  assert.ok(!eatH.applies(mk([{ name: 'pufferfish', count: 2 }])))
  assert.ok(eatH.applies(mk([{ name: 'rotten_flesh', count: 1 }])))
})

test('forage_plants: an empty search is remembered and answers at once within 30 m / 2 min', () => {
  const bot = mkBot()
  emptySearch.t = 0
  const sk = makeForagePlants()
  assert.equal(sk.precondition({ bot }), true)
  emptySearch.t = Date.now(); emptySearch.x = 5; emptySearch.z = 5
  assert.equal(recentEmpty(bot), true)
  const r = sk.precondition({ bot }); assert.equal(r.ok, false); assert.equal(r.reason, 'no_target_found')
  assert.equal(recentEmpty(bot, Date.now() + 130000), false)
  emptySearch.x = 100; assert.equal(recentEmpty(bot), false)
  emptySearch.t = 0
})
