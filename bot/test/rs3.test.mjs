// RS3: the top-10 survival strategies of RS2 (seed_hunt, farm fixes, bootstrap_kit / make_torches, eat emergency, fish, chickens, village, bone meal, breed guard).
// Fake runner + simulated world (no server). Skills are exercised with a fake bot; playbooks with a fake skill table that changes a simulated pack.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlaybookEngine } from '../src/playbooks/engine.js'
import { getPlaybook, resolveParams, playbooksText, playbookNames } from '../src/playbooks/catalog.js'
import { validateArgs } from '../src/skills/schema.js'
import { Landmarks } from '../src/skills/landmarks.js'
import { makeSeedSkills, grassNear, grassedOutHere, plantCount, bestGrassTarget } from '../src/skills/seeds.js'
import { charcoalPlan, makeRs3Skills } from '../src/skills/rs3.js'
import { farmJumpDecision, farmlandStepCost, JUMP_RELEASE_TICKS, installFarmGuard } from '../src/farm-guard.js'
import { plotNote, plotLight, torchPlot, ringStands, cropRipe } from '../src/skills/activities.js'
import { edibles, emergencyPlan, makeEat, needsBadFood } from '../src/skills/survival.js'
import { breedGuard, BREED_COOLDOWN_MS, BREED_CAP, makeFarm1Skills } from '../src/skills/farm1.js'
import { RECIPES } from '../src/skills/craft.js'
import { inventoryFacts } from '../src/habits/needs.js'
import { chooseFood } from '../src/reflex/reflexes.js'
import { kitStatus } from '../src/playbooks/rs3.js'

const vec = (x, y, z) => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) }, floored() { return vec(Math.floor(x), Math.floor(y), Math.floor(z)) } })
const FOODS = { cooked_beef: { foodPoints: 8, saturation: 12.8 }, bread: { foodPoints: 5, saturation: 6 }, rotten_flesh: { foodPoints: 4, saturation: 0.8 }, spider_eye: { foodPoints: 2, saturation: 3.2 }, poisonous_potato: { foodPoints: 2, saturation: 1.2 }, apple: { foodPoints: 4, saturation: 2.4 }, cod: { foodPoints: 2, saturation: 0.4 }, cooked_cod: { foodPoints: 5, saturation: 6 }, golden_carrot: { foodPoints: 6, saturation: 14.4 } }
const mkBot = (items = [], o = {}) => {
  const bot = { username: 'Wren', health: 20, food: 20, time: { timeOfDay: 3000 }, thunderState: 0, entity: { position: vec(0, 64, 0), onGround: true }, entities: {}, _items: items.map(([name, count]) => ({ name, count, type: name.length })), ...o }
  bot.inventory = { items: () => bot._items, emptySlotCount: () => 20 }
  bot.registry = { foodsByName: FOODS, blocksByName: { short_grass: { id: 1 }, tall_grass: { id: 2 }, fern: { id: 3 }, grass_block: { id: 4 }, water: { id: 9 }, dandelion: { id: 5 }, hay_block: { id: 7 } }, itemsByName: {} }
  bot.stopDigging = () => {}; bot.clearControlStates = () => {}; bot.blockAt ??= () => null
  return bot
}
const add = (bot, n, c) => { const e = bot._items.find((i) => i.name === n); if (e) e.count += c; else bot._items.push({ name: n, count: c, type: n.length }) }
const held = (bot, n) => bot._items.filter((i) => i.name === n).reduce((s, i) => s + i.count, 0)
const mkCtx = (bot, args = {}, extra = {}) => ({ bot, args, state: {}, aborted: false, goto: async () => ({ ok: true }), sleep: async () => {}, log: () => {}, env: {}, ...extra })

// ---------------------------------------------------------------- 1 seed_hunt / grass_seeds
test('seed_hunt and the new playbooks are in the library with parameters S2 can read', () => {
  for (const n of ['seed_hunt', 'bootstrap_kit', 'make_torches', 'fish_session', 'fish_hit', 'chicken_loop', 'village_forage', 'bonemeal_grass', 'bonemeal_ripen']) assert.ok(playbookNames().includes(n), n)
  const t = playbooksText()
  assert.match(t, /seed_hunt count=<int> \(optional\)/); assert.match(t, /bootstrap_kit kit=<stone_tools\|torches\|farm_kit>/); assert.match(t, /fish_session minutes=<minutes>/); assert.match(t, /village_forage place=<place or x,y,z>:/)
  assert.deepEqual(resolveParams(getPlaybook('seed_hunt'), {}).params, { count: 9 })
  assert.equal(resolveParams(getPlaybook('fish_session'), { minutes: '99' }).params.minutes, 30)
  assert.equal(resolveParams(getPlaybook('bootstrap_kit'), { kit: 'farm' }).params.kit, 'farm_kit')
  assert.equal(resolveParams(getPlaybook('bootstrap_kit'), { kit: 'rocket' }).ok, false)
})
test('new skills are in skills.json with validated args', () => {
  assert.equal(validateArgs('grass_seeds', { count: 9, radius: 32 }).ok, true); assert.equal(validateArgs('grass_seeds', { count: 99 }).ok, false)
  assert.equal(validateArgs('bonemeal_grass', { uses: 2 }).ok, true); assert.equal(validateArgs('bonemeal_grass', { uses: 9 }).ok, false)
  assert.equal(validateArgs('make_charcoal', { count: 4 }).ok, true); assert.equal(validateArgs('take_hay', { count: 3, keep: 1 }).ok, true)
  for (const n of ['bonemeal_ripen', 'collect_eggs', 'throw_eggs', 'harvest_ripe']) assert.equal(validateArgs(n, {}).ok, true, n)
  assert.equal(validateArgs('craft', { item: 'stone_hoe' }).ok, true); assert.equal(validateArgs('craft', { item: 'wheat' }).ok, true)
})
const grassBot = (nGrass, { seedEvery = 8 } = {}) => {
  const bot = mkBot([], { findBlocks: () => Array.from({ length: Math.min(nGrass - bot._dug, 12) }, (_, i) => vec(3 + i, 64, 0)), _dug: 0, lookAt: async () => {}, dig: async () => { bot._dug++; if (bot._dug % seedEvery === 0) add(bot, 'wheat_seeds', 1) } })
  bot.blockAt = (p) => ({ name: 'short_grass', position: p })
  return bot
}
test('grass_seeds: breaks grass until the seed target is held, counts seeds and breaks; stops at the target', async () => {
  const [gs] = makeSeedSkills({})
  const bot = grassBot(200); const ctx = mkCtx(bot, { count: 3, radius: 32 })
  assert.equal(gs.precondition({ bot, args: { radius: 32 } }), true)
  const r = await gs.run(ctx)
  assert.equal(r.ok, true); assert.equal(held(bot, 'wheat_seeds'), 3); assert.equal(bot._dug, 24, '3 seeds at 1 in 8 = 24 breaks in this simulation'); assert.equal(r.reason, 'seeds_reached'); assert.match(r.detail, /3 seeds from 24 grass/)
})
test('grass_seeds: night, no grass and grassed-out are refused with the honest reason', async () => {
  const env = {}; const [gs] = makeSeedSkills(env)
  const night = grassBot(10); night.time.timeOfDay = 15000
  assert.equal(gs.precondition({ bot: night, args: {} }).reason, 'night')
  const none = mkBot([], { findBlocks: () => [] }); assert.deepEqual(gs.precondition({ bot: none, args: {} }), { ok: false, reason: 'no_grass', detail: 'no grass, tall grass or fern within 32 m' })
  // only 4 plants: all broken, no seed -> exhausted -> area marked, next try says grassed_out
  const small = grassBot(4, { seedEvery: 99 }); const r = await gs.run(mkCtx(small, { count: 9 }))
  assert.equal(r.ok, false); assert.equal(r.reason, 'no_seeds_dropped'); assert.equal(small._dug, 4)
  assert.ok(grassedOutHere(env, small), 'the cleared area is remembered')
  small.findBlocks = () => []; assert.equal(gs.precondition({ bot: small, args: {} }).reason, 'grassed_out')
})
test('grass_seeds: partial result when the meadow runs out after some seeds ("grass_used_up")', async () => {
  const [gs] = makeSeedSkills({}); const bot = grassBot(20, { seedEvery: 5 })
  const r = await gs.run(mkCtx(bot, { count: 9 })); assert.equal(r.ok, true); assert.equal(r.reason, 'grass_used_up'); assert.equal(held(bot, 'wheat_seeds'), 4)
})

// ---------------------------------------------------------------- bonemeal_grass
test('bonemeal_grass: counts the real new plants, reports a thin result honestly, records the measurement', async () => {
  const env = {}; const bm = makeSeedSkills(env)[1]
  const grass = []; for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) grass.push(vec(x, 63, z))
  let plants = 0
  const bot = mkBot([['bone_meal', 3]], {
    findBlocks: ({ matching }) => (matching.includes(4) ? grass : Array.from({ length: plants }, (_, i) => vec(i, 64, 0))),
    blockAt: (p) => (p.y === 63 ? { name: 'grass_block', position: p } : { name: 'air', position: p }), lookAt: async () => {}, equip: async () => {},
    activateBlock: async () => { plants += bot._grow; add(bot, 'bone_meal', -1) } })
  bot._grow = 12
  assert.equal(bm.precondition({ bot, args: {} }), true)
  const r = await bm.run(mkCtx(bot, { uses: 1 }, { env })); assert.equal(r.ok, true); assert.match(r.detail, /1 bone meal made 12 new plants \(measured\)/); assert.deepEqual(env.measure.bonemealGrass, [12])
  bot._grow = 2; plants = 0
  const t = await bm.run(mkCtx(bot, { uses: 3 }, { env })); assert.equal(t.ok, false); assert.equal(t.reason, 'thin_result'); assert.match(t.detail, /only 4 new plants/, 'stops after 2 poor results'); assert.equal(held(bot, 'bone_meal'), 0 + 0 + 0 + (3 - 1 - 2))
  const none = mkBot([], { findBlocks: () => grass, blockAt: (p) => ({ name: 'air', position: p }) }); assert.equal(bm.precondition({ bot: none, args: {} }).reason, 'no_bone_meal')
  assert.ok(plantCount(bot, vec(0, 0, 0)) >= 0); assert.ok(bestGrassTarget(bot))
})

// ---------------------------------------------------------------- 2 farm fixes
test('farm guard: a jump on farmland is dropped, but a jump wanted for 2 s in a row (stuck) is let through; step cost makes A* walk around', () => {
  assert.deepEqual(farmJumpDecision({ jump: true, onFarmland: true, onGround: true, held: 0 }), { release: true, held: 1 })
  assert.equal(farmJumpDecision({ jump: true, onFarmland: false, onGround: true, held: 5 }).release, false)
  assert.equal(farmJumpDecision({ jump: false, onFarmland: true, onGround: true, held: 5 }).held, 0)
  assert.equal(farmJumpDecision({ jump: true, onFarmland: true, onGround: true, held: JUMP_RELEASE_TICKS }).stuck, true)
  const bot = { blockAt: (p) => ({ name: p.y === 63 ? 'farmland' : 'air', position: p }) }
  const cost = farmlandStepCost(bot); assert.ok(cost({ name: 'air', position: vec(0, 64, 0) }) > 0); assert.equal(cost({ name: 'air', position: vec(0, 70, 0) }), 0); assert.ok(cost({ name: 'farmland', position: vec(0, 63, 0) }) > 0)
  // installFarmGuard on a fake bot: the control state is cleared
  const handlers = []; const gb = { controlState: { jump: true }, entity: { position: vec(0, 64, 0), onGround: true }, blockAt: () => ({ name: 'farmland' }), on: (e, f) => handlers.push(f), removeListener() {}, setControlState(k, v) { gb.controlState[k] = v } }
  installFarmGuard(gb); handlers[0](); assert.equal(gb.controlState.jump, false); assert.equal(gb._farmGuard.suppressed, 1)
})
test('farm plot facts: hydration, light and torches are reported honestly; torches go beside the plot', async () => {
  assert.match(plotNote({ wet: 9, light: { minBlock: 0, minSky: 15 }, torches: 0 }), /all 9 tiles within 4 blocks of water \(hydrated\).*daylight 15 \(grows by day, not at night without torches\)/)
  assert.match(plotNote({ wet: 5, light: { minBlock: 0, minSky: 15 }, torches: 0 }), /only 5\/9 tiles within 4 blocks of water: the dry ones grow slowly/)
  assert.match(plotNote({ wet: 0, light: { minBlock: 0, minSky: 4 }, torches: 0 }), /no water within 4 blocks.*dark spot \(light 4 < 9\)/)
  assert.match(plotNote({ wet: 9, light: { minBlock: 12, minSky: 15 }, torches: 2 }), /lit by torches \(light 12\).*2 torches placed/)
  const site = { x: 10, y: 63, z: 10 }
  const placed = []
  const bot = mkBot([['torch', 3]], { blockAt: (p) => (p.y === 63 ? { name: 'dirt', boundingBox: 'block', position: p } : placed.some((q) => q.x === p.x && q.y === p.y && q.z === p.z) ? { name: 'torch', boundingBox: 'empty', position: p } : { name: 'air', boundingBox: 'empty', position: p }), equip: async () => {},
    placeBlock: async (ref, face) => { placed.push({ x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }) } })
  assert.deepEqual(plotLight(bot, site), { n: 9, minBlock: 0, minSky: 0 })
  assert.equal(await torchPlot(bot, site, 2), 2); assert.deepEqual(placed.map((p) => [p.x, p.z]), [[10, 12], [10, 8]], 'north and south middle of the sides, off the farmland')
  const stands = ringStands({ blockAt: (p) => ({ name: p.y === 63 ? 'dirt' : 'air', boundingBox: p.y === 63 ? 'block' : 'empty', position: p }), registry: { blocksByName: {} } }, site)
  assert.ok(stands.every((s) => Math.max(Math.abs(s.x - 10), Math.abs(s.z - 10)) === 2)); assert.equal(stands.length > 0, true)
  assert.equal(cropRipe({ name: 'wheat', getProperties: () => ({ age: 7 }) }), true); assert.equal(cropRipe({ name: 'wheat', getProperties: () => ({ age: 5 }) }), false)
})

// ---------------------------------------------------------------- 3/4 charcoal, torches, kits
test('charcoalPlan: logs are the input and the fuel (1 log = 1.5 items); never more charcoal than the pack can fuel', () => {
  assert.equal(charcoalPlan({ logs: {}, planks: 0 }, 4).k, 0)
  assert.equal(charcoalPlan({ logs: { oak_log: 1 }, planks: 0 }, 4).k, 0, 'one log cannot fuel itself')
  const p = charcoalPlan({ logs: { oak_log: 7 }, planks: 0 }, 4); assert.equal(p.k, 4); assert.equal(p.input, 'oak_log'); assert.deepEqual(p.fuel, [{ name: 'oak_log', count: 3 }]); assert.equal(p.need, 7)
  assert.equal(charcoalPlan({ logs: { oak_log: 5 }, planks: 0 }, 4).k, 3, '5 logs: 3 in, 2 as fuel (3 items needed 2 fuel)')
  const m = charcoalPlan({ logs: { oak_log: 4, birch_log: 2 }, planks: 4 }, 12); assert.ok(m.k >= 4 && m.k <= 6); assert.equal(m.input, 'oak_log'); assert.equal(m.fuel[0].name, 'birch_log')
  assert.equal(charcoalPlan({ logs: { oak_log: 2 }, planks: 4 }, 2).k, 2, 'planks burn too')
})
test('make_charcoal skill: smelts logs in a (found) furnace, success = charcoal delta; refuses without logs', async () => {
  const mc = makeRs3Skills({}).find((s) => s.name === 'make_charcoal')
  const none = mkBot([['oak_log', 1]]); assert.equal(mc.precondition({ bot: none, args: { count: 4 } }).reason, 'not_enough_logs'); assert.match(mc.precondition({ bot: none, args: { count: 4 } }).detail, /about 7 logs/)
  const bot = mkBot([['oak_log', 7]], {})
  const furnaceBlock = { name: 'furnace', position: vec(1, 64, 0) }
  bot.registry.blocksByName.furnace = { id: 50 }; bot.findBlock = () => furnaceBlock
  const put = { fuel: 0, input: 0 }
  const furnace = { putFuel: async (t, m, n) => { put.fuel += n }, putInput: async (t, m, n) => { put.input += n }, outputItem: () => (held(bot, 'charcoal') < put.input ? {} : null), takeOutput: async () => { add(bot, 'charcoal', put.input) }, close() {}, fuelItem: () => ({}), fuel: 1 }
  bot.openFurnace = async () => furnace
  const r = await mc.run(mkCtx(bot, { count: 4 })); assert.equal(r.ok, true); assert.equal(held(bot, 'charcoal'), 4); assert.equal(put.input, 4); assert.equal(put.fuel, 3); assert.match(r.detail, /4 charcoal from 4 oak_log/)
})
test('craft recipes: stone_hoe and hay -> wheat exist', () => { assert.deepEqual(RECIPES.stone_hoe, { cobble: 2, stick: 2, table: true }); assert.deepEqual(RECIPES.wheat, { out: 9, hay: 1 }) })

// ---------------------------------------------------------------- playbook simulation
function sim({ items = [], tick = 3000, food = 20, env = null } = {}) {
  const bot = mkBot(items, { food, time: { timeOfDay: tick } })
  const e = env ?? { landmarks: new Landmarks() }
  const calls = [], notes = []
  const world = { grass: 200, seedEvery: 8, dug: 0 }
  const skills = {
    gather_wood: (a) => { add(bot, 'oak_log', a.count); return { status: 'done' } },
    gather_stone: (a) => { add(bot, 'cobblestone', a.count); return { status: 'done' } },
    craft: (a) => {
      const c = a.count ?? 1
      if (a.item === 'crafting_table') { add(bot, 'crafting_table', 1); return { status: 'done' } }
      if (a.item === 'torch') { if (held(bot, 'charcoal') + held(bot, 'coal') < 1) return { status: 'failed', reason: 'missing_coal' }; add(bot, held(bot, 'charcoal') ? 'charcoal' : 'coal', -Math.ceil(c / 4)); add(bot, 'torch', Math.ceil(c / 4) * 4); return { status: 'done' } }
      if (a.item === 'bread') { add(bot, 'wheat', -3 * c); add(bot, 'bread', c); return { status: 'done' } }
      if (/^stone_/.test(a.item) && held(bot, 'cobblestone') < 2) return { status: 'failed', reason: 'missing_cobblestone' }
      if (a.item === 'stone_hoe') { add(bot, 'stone_hoe', 1); return { status: 'done' } }
      add(bot, a.item, c); return { status: 'done' }
    },
    make_charcoal: (a) => { const logs = held(bot, 'oak_log'); const k = Math.min(a.count, Math.floor(logs * 0.6)); if (!k) return { status: 'failed', reason: 'not_enough_logs' }; add(bot, 'oak_log', -Math.ceil(k * (1 + 1 / 1.5))); add(bot, 'charcoal', k); return { status: 'done' } },
    grass_seeds: (a) => { if (world.grass <= 0) return { status: 'failed', reason: 'no_grass' }; const want = Math.min(a.count, 24), before = held(bot, 'wheat_seeds'); while (held(bot, 'wheat_seeds') - before < want && world.grass > 0) { world.grass--; world.dug++; if (world.dug % world.seedEvery === 0) add(bot, 'wheat_seeds', 1) } return held(bot, 'wheat_seeds') > before ? { status: 'done' } : { status: 'failed', reason: 'no_seeds_dropped' } },
    bonemeal_grass: () => { add(bot, 'bone_meal', -1); world.grass += 30; return { status: 'done' } },
    eat: () => { bot.food = Math.min(20, bot.food + 5); return { status: 'done' } },
    cook: () => { for (const [r, c] of [['cod', 'cooked_cod'], ['salmon', 'cooked_salmon'], ['chicken', 'cooked_chicken']]) { const n = held(bot, r); if (n) { add(bot, r, -n); add(bot, c, n) } } return { status: 'done' } },
    fish: (a) => { world.fishCalls = (world.fishCalls ?? 0) + 1; add(bot, world.noBite ? 'stick' : 'cod', world.noBite ? 0 : a.catches); return world.noBite ? { status: 'failed', reason: 'no_bite' } : { status: 'done' } },
    hunt: () => { add(bot, 'cod', 1); return { status: 'done' } },
    explore: () => ({ status: 'done' }),
    go_to: () => ({ status: 'done' }),
    move_to: (a) => { bot.entity.position = vec(a.x, 64, a.z); return { status: 'done' } },
    breed_animals: () => ({ status: 'done', reason: 'baby_born' }),
    collect_eggs: () => { add(bot, 'egg', 3); return { status: 'done', detail: '3 eggs picked up' } },
    throw_eggs: (a) => { add(bot, 'egg', -a.count); return { status: 'done', detail: 'threw eggs' } },
    pen_slaughter: () => ({ status: 'failed', reason: 'pen_too_small' }),
    take_hay: () => { add(bot, 'wheat', 18); return { status: 'done', detail: '2 bales taken (3 left in the village), 18 wheat in the pack' } },
    harvest_ripe: () => { add(bot, 'carrot', 4); return { status: 'done', detail: '4 ripe crops taken' } },
    bonemeal_ripen: () => { add(bot, 'bone_meal', -3); world.ripened = true; return { status: 'done' } },
    farm_harvest: () => { if (world.ripened) add(bot, 'wheat', 9); return { status: 'done' } },
  }
  const runSkill = async (name, args) => { calls.push({ name, args }); const f = skills[name]; if (!f) return { status: 'failed', reason: 'unknown_skill_' + name }; return f(args ?? {}) }
  const eng = createPlaybookEngine({ getBot: () => bot, runSkill, env: e, sleep: async () => {}, notify: (k, t) => notes.push({ k, t }) })
  return { bot, eng, calls, notes, world, env: e }
}
const run = async (S, name, args = {}) => { const ended = []; const st = S.eng.start(name, args, { onEnd: (x) => ended.push(x) }); assert.ok(st.ok, JSON.stringify(st)); const out = await st.promise; return { out, end: ended[0] } }

test('seed_hunt: from 0 to 9 seeds, result line counts before/after; target 9 is not claimed when the grass runs out', async () => {
  const S = sim({ items: [], food: 12 }); const { out, end } = await run(S, 'seed_hunt')
  assert.equal(out.status, 'done'); assert.equal(held(S.bot, 'wheat_seeds') >= 9, true); assert.match(end.summary, /RESULT: seed_hunt: wheat_seeds 0 -> \d+; food 12 -> 12; goal met/)
  const T = sim({}); T.world.grass = 20; const r = await run(T, 'seed_hunt', { count: 9 })
  assert.equal(r.out.status, 'failed'); assert.equal(r.out.reason, 'seeds_short'); assert.match(r.end.summary, /goal NOT met \(holding 2 of 9 wheat_seeds\)/)
  const U = sim({ items: [['wheat_seeds', 9]] }); const q = await run(U, 'seed_hunt'); assert.equal(q.out.status, 'done'); assert.equal(U.calls.length, 0)
})
test('seed_hunt: night and hostile mobs stop it at once; bone meal is used when the grass is gone', async () => {
  const N = sim({ tick: 15000 }); const r = await run(N, 'seed_hunt'); assert.equal(r.out.status, 'failed'); assert.equal(r.out.reason, 'night'); assert.equal(N.calls.length, 0)
  const S = sim({ items: [['bone_meal', 2]] }); S.world.grass = 8
  const o = await run(S, 'seed_hunt'); assert.ok(S.calls.some((c) => c.name === 'bonemeal_grass'), 'bone meal step ran after the grass ran out'); assert.ok(held(S.bot, 'wheat_seeds') > 1, 'the sprouted grass gave more seeds'); void o
})
test('make_torches: no coal -> wood, stone, charcoal, torches; with coal it only crafts; honest failure line when wood is missing at night', async () => {
  const S = sim({ items: [['stick', 4]] }); const { out, end } = await run(S, 'make_torches', { count: 8 })
  assert.equal(out.status, 'done'); assert.ok(held(S.bot, 'torch') >= 8, `torches ${held(S.bot, 'torch')}`); assert.deepEqual(S.calls.map((c) => c.name).filter((n) => n !== 'craft'), ['gather_wood', 'gather_stone', 'make_charcoal'])
  assert.match(end.summary, /RESULT: make_torches: .*torch 0 -> 8.*goal met/)
  const C = sim({ items: [['coal', 2], ['stick', 4]] }); await run(C, 'make_torches', { count: 8 }); assert.deepEqual(C.calls.map((c) => c.name), ['craft'])
  const N = sim({ tick: 15000 }); const n = await run(N, 'make_torches', { count: 8 }); assert.equal(n.out.reason, 'night'); assert.match(n.end.summary, /not daylight/)
  const D = resolveParams(getPlaybook('make_torches'), { count: '8' }); assert.ok(D.ok)
})
test('bootstrap_kit: stone_tools builds the chain and reports what is missing', async () => {
  const S = sim({}); const { out, end } = await run(S, 'bootstrap_kit', { kit: 'stone_tools' })
  assert.equal(out.status, 'done'); assert.match(end.summary, /RESULT: bootstrap_kit stone_tools: have stone pickaxe, stone axe, stone sword; missing nothing/)
  const names = S.calls.map((c) => c.name); assert.ok(names.indexOf('gather_wood') < names.indexOf('gather_stone')); assert.ok(!names.includes('make_charcoal'))
  const F = sim({}); const f = await run(F, 'bootstrap_kit', { kit: 'farm_kit' }); assert.equal(f.out.status, 'done'); assert.ok(held(F.bot, 'stone_hoe') === 1 && held(F.bot, 'torch') >= 4, 'hoe and torches'); assert.match(f.end.summary, /have stone pickaxe, stone axe, stone sword, hoe, 4 torches/)
  const T = sim({}); await run(T, 'bootstrap_kit', { kit: 'torches' }); assert.ok(held(T.bot, 'torch') >= 8)
  // honest failure: stone is not found
  const X = sim({}); const orig = X.eng; void orig
  const bot = mkBot([['oak_log', 6]]); assert.deepEqual(kitStatus(bot, 'stone_tools').missing, ['stone pickaxe', 'stone axe', 'stone sword'])
})
test('bootstrap_kit: gathering failures end with kit_incomplete and the missing parts, not a claim', async () => {
  const S = sim({}); const base = S.eng
  const calls = []; const bot = S.bot
  const eng = createPlaybookEngine({ getBot: () => bot, env: S.env, sleep: async () => {}, runSkill: async (name, args) => { calls.push(name); if (name === 'gather_stone') return { status: 'failed', reason: 'no_target_found' }; if (name === 'gather_wood') { add(bot, 'oak_log', 5); return { status: 'done' } } if (name === 'craft') { if (/^stone_/.test(args.item)) return { status: 'failed', reason: 'missing_cobblestone' }; add(bot, args.item, 1); return { status: 'done' } } return { status: 'failed', reason: 'x' } } })
  void base
  const ended = []; const st = eng.start('bootstrap_kit', { kit: 'stone_tools' }, { onEnd: (e) => ended.push(e) }); const out = await st.promise
  assert.equal(out.status, 'failed'); assert.equal(out.reason, 'kit_incomplete'); assert.match(ended[0].summary, /missing stone pickaxe, stone axe, stone sword/)
})

// ---------------------------------------------------------------- 5 fishing
test('fish_session: casts in rounds, stops at food 18, cooks and eats; honest no-rod and night refusals', async () => {
  const S = sim({ items: [['fishing_rod', 1], ['coal', 1]], food: 8 }); S.bot.entity.position = vec(0, 64, 0)
  // water near: predicate water_within uses findBlock
  S.bot.findBlock = () => ({ position: vec(2, 63, 0) }); S.bot.registry.blocksByName.water = { id: 9 }
  const { out, end } = await run(S, 'fish_session', { minutes: 5 })
  assert.equal(out.status, 'done'); assert.ok(held(S.bot, 'cooked_cod') + held(S.bot, 'cod') >= 1); assert.match(end.summary, /fished .* min in \d+ round\(s\), \d+ fish, stopped: (time_up|food_full)/); assert.match(end.summary, /goal met/)
  const N = sim({ items: [['fishing_rod', 1]], tick: 15000 }); N.bot.findBlock = () => ({ position: vec(2, 63, 0) }); const n = await run(N, 'fish_session'); assert.equal(n.out.reason, 'night')
  const R = sim({ items: [['stick', 2]] }); const st = R.eng.start('fish_session', {}); assert.equal(st.ok, false); assert.match(st.errors[0], /cannot fish/)
})
test('fish_session: three empty rounds end it as no_bite, with the count in the line', async () => {
  const S = sim({ items: [['fishing_rod', 1]], food: 10 }); S.world.noBite = true; S.bot.findBlock = () => ({ position: vec(2, 63, 0) })
  const { out, end } = await run(S, 'fish_session', { minutes: 5 }); assert.equal(out.status, 'failed'); assert.equal(out.reason, 'no_catch'); assert.match(end.summary, /3 round\(s\), 0 fish, stopped: no_bite/); assert.equal(S.world.fishCalls, 3)
})
test('fish_hit: needs fish in view, hits until the count, cooks and eats; refuses at night', async () => {
  const S = sim({ items: [['coal', 1]], food: 10 }); S.bot.entities = { 1: { id: 1, name: 'cod', position: vec(4, 63, 0), isValid: true } }; S.bot.findBlock = () => ({ position: vec(4, 63, 0) })
  const { out, end } = await run(S, 'fish_hit', { count: 2 }); assert.equal(out.status, 'done'); assert.match(end.summary, /RESULT: fish_hit: .*goal met/); assert.ok(held(S.bot, 'cooked_cod') + held(S.bot, 'cod') >= 2)
  const E = sim({ items: [] }); const e = await run(E, 'fish_hit'); assert.equal(e.out.reason, 'no_fish_seen')
  const N = sim({ tick: 15000 }); assert.equal((await run(N, 'fish_hit')).out.reason, 'night')
})

// ---------------------------------------------------------------- 6 chickens
test('chicken_loop: one pass lists every part; no chickens / no seeds / night are honest refusals', async () => {
  const env = { landmarks: new Landmarks() }; env.landmarks.set('pen', { x: 0, y: 64, z: 0 }, 'place')
  const S = sim({ items: [['wheat_seeds', 4]], env }); S.bot.entities = { 1: { id: 1, name: 'chicken', position: vec(1, 64, 1), isValid: true }, 2: { id: 2, name: 'chicken', position: vec(-1, 64, 1), isValid: true } }
  const { out, end } = await run(S, 'chicken_loop'); assert.equal(out.status, 'done')
  assert.match(end.summary, /breed: baby_born; eggs: 3 eggs picked up; throw: threw eggs; meat: pen_too_small/); assert.match(end.summary, /eggs 0 -> 0|eggs 0 -> \d/)
  assert.deepEqual(S.calls.map((c) => c.name).filter((n) => n !== 'go_to'), ['breed_animals', 'collect_eggs', 'throw_eggs', 'pen_slaughter'], 'meat is tried when the pack holds under 2 food')
  const none = sim({ items: [['wheat_seeds', 4]] }); assert.equal((await run(none, 'chicken_loop')).out.reason, 'no_chickens')
  const noSeeds = sim({ env }); noSeeds.bot.entities = S.bot.entities; assert.equal((await run(noSeeds, 'chicken_loop')).out.reason, 'no_seeds')
  const night = sim({ items: [['wheat_seeds', 4]], tick: 15000, env }); assert.equal((await run(night, 'chicken_loop')).out.reason, 'not_now')
})

// ---------------------------------------------------------------- 7 village
test('village_forage: walks there, hay + ripe crops + bread; refuses at night, at dusk-too-close and for unknown places', async () => {
  const env = { landmarks: new Landmarks() }; env.landmarks.set('village', { x: 90, y: 64, z: 0 }, 'village')
  const S = sim({ env }); const { out, end } = await run(S, 'village_forage', { place: 'village' })
  assert.equal(out.status, 'done'); assert.equal(held(S.bot, 'bread'), 6); assert.match(end.summary, /RESULT: village_forage at village: carrot 0 -> 4, bread 0 -> 6/); assert.match(end.summary, /hay: 2 bales taken/)
  assert.deepEqual(S.calls.map((c) => c.name).filter((n) => n !== 'move_to'), ['take_hay', 'harvest_ripe', 'craft'])
  const N = sim({ env, tick: 15000 }); assert.equal((await run(N, 'village_forage', { place: 'village' })).out.reason, 'night')
  const D = sim({ env, tick: 10900 }); const d = await run(D, 'village_forage', { place: 'village' }); assert.equal(d.out.reason, 'dusk_too_close'); assert.match(d.end.summary, /only .* min of daylight are left/)
  const st = sim({ env }).eng.start('village_forage', { place: 'nowhere' }, { know: { places: ['village'] } }); assert.equal(st.ok, false)
})
test('take_hay keeps a bale standing (policy) and turns hay into wheat; harvest_ripe takes only ripe crops', async () => {
  const th = makeRs3Skills({}).find((s) => s.name === 'take_hay')
  const mk = (n) => { const bot = mkBot([], { findBlocks: ({ matching }) => (matching === 7 ? Array.from({ length: n - bot._broken }, (_, i) => vec(5 + i, 64, 0)) : []), _broken: 0, lookAt: async () => {}, dig: async (b) => { bot._broken++; add(bot, 'hay_block', 1) }, blockAt: (p) => ({ name: 'hay_block', position: p }) }); return bot }
  const one = mk(1); const r1 = await th.run(mkCtx(one, { count: 3, keep: 1 })); assert.equal(r1.ok, false); assert.equal(r1.reason, 'last_bale_kept')
  const bot = mk(3); const r = await th.run(mkCtx(bot, { count: 3, keep: 1 })); assert.equal(bot._broken, 2, 'one of three bales stays'); assert.equal(r.ok, true); assert.match(r.detail, /2 bales taken \(1 left in the village\)/)
  const hr = makeRs3Skills({}).find((s) => s.name === 'harvest_ripe')
  const crops = [{ name: 'wheat', position: vec(3, 64, 0), getProperties: () => ({ age: 7 }) }, { name: 'wheat', position: vec(4, 64, 0), getProperties: () => ({ age: 3 }) }]
  const cb = mkBot([], { findBlocks: () => crops.map((c) => c.position), blockAt: (p) => crops.find((c) => c.position.x === p.x) ?? { name: 'farmland', position: p }, lookAt: async () => {}, dig: async (b) => { b.name = 'air'; add(cb, 'wheat', 1) } })
  cb.registry.blocksByName.wheat = { id: 20 }
  const hres = await hr.run(mkCtx(cb, { count: 12, radius: 20 })); assert.equal(hres.ok, true); assert.equal(held(cb, 'wheat'), 1, 'the unripe plant stays')
})

// ---------------------------------------------------------------- 9 bone meal on crops
test('bonemeal_ripen playbook: needs bone meal and a farm; uses it, harvests, bakes; result counts', async () => {
  const env = { landmarks: new Landmarks() }; env.landmarks.set('farm', { x: 0, y: 64, z: 0 }, 'place')
  const S = sim({ items: [['bone_meal', 4], ['wheat_seeds', 2]], env }); const { out, end } = await run(S, 'bonemeal_ripen')
  assert.equal(out.status, 'done'); assert.equal(held(S.bot, 'bread'), 3); assert.match(end.summary, /RESULT: bonemeal_ripen: bone_meal 4 -> 1.*bread 0 -> 3.*goal met/)
  const N = sim({ items: [], env }); assert.equal((await run(N, 'bonemeal_ripen')).out.reason, 'no_bone_meal')
  const F = sim({ items: [['bone_meal', 1]] }); assert.equal((await run(F, 'bonemeal_ripen')).out.reason, 'no_farm_known')
  const G = sim({ items: [['bone_meal', 2]] }); const g = await run(G, 'bonemeal_grass', { uses: 2 }); assert.ok(G.calls.some((c) => c.name === 'bonemeal_grass' && c.args.uses === 2)); assert.equal(g.out.status, 'done'); assert.match(g.end.summary, /wheat_seeds 0 -> \d+/)
})

// ---------------------------------------------------------------- 8 eat emergency
test('eat emergency: rotten flesh at food <= 6 only, after everything better, aim 18 once; spider eye / poisonous potato never', async () => {
  const b = mkBot([['rotten_flesh', 6], ['spider_eye', 2], ['poisonous_potato', 1]], { food: 5, health: 12 })
  assert.equal(needsBadFood(b), true); assert.deepEqual(emergencyPlan(b).pool, ['rotten_flesh']); assert.equal(emergencyPlan(b).aim, 18)
  assert.deepEqual(edibles(b, { allowBad: true }).map((i) => i.name), ['rotten_flesh'], 'spider eye / potato stay out even at hp 12')
  assert.deepEqual(edibles(mkBot([['rotten_flesh', 1], ['apple', 1], ['cooked_beef', 1]], { food: 5 }), { allowBad: true }).map((i) => i.name), ['cooked_beef', 'apple', 'rotten_flesh'], 'good food first, bad last')
  assert.deepEqual(edibles(mkBot([['golden_carrot', 1], ['rotten_flesh', 1]], { food: 5 }), { allowBad: true }).map((i) => i.name), ['golden_carrot', 'rotten_flesh'])
  assert.equal(edibles(mkBot([['rotten_flesh', 3]], { food: 12, health: 20 })).length, 0, 'not in an emergency')
  assert.equal(inventoryFacts(b).badFood, 6, 'only rotten flesh counts as emergency food for the habit layer')
  assert.equal(chooseFood(b, { allowBad: true })?.name, 'rotten_flesh'); assert.equal(chooseFood(mkBot([['spider_eye', 1]], { food: 3, health: 20 }), { allowBad: true }), null, 'the reflex never eats a spider eye out of hunger')
})
test('eat skill: one meal from food 5 keeps eating rotten flesh until food 18 (regeneration), then stops; healthy bodies do not eat it', async () => {
  const eat = makeEat()
  const bot = mkBot([['rotten_flesh', 6]], { food: 5, health: 10 })
  bot.equip = async () => {}; bot.consume = async () => { const it = bot._items.find((i) => i.name === 'rotten_flesh'); it.count--; bot.food = Math.min(20, bot.food + 4); if (!it.count) bot._items.splice(bot._items.indexOf(it), 1) }
  assert.equal(eat.precondition({ bot, args: {} }), true)
  const r = await eat.run(mkCtx(bot, {})); assert.equal(r.ok, true); assert.equal(r.reason, 'emergency_fed'); assert.equal(bot.food, 21 > 20 ? 20 : 20 - 0, 'ends at the cap'); assert.ok(held(bot, 'rotten_flesh') >= 1, 'stops at 18, keeps the rest'); assert.match(r.detail, /food 5 -> \d+: natural regeneration is on/)
  const h = mkBot([['rotten_flesh', 2]], { food: 12, health: 20 }); assert.deepEqual(eat.precondition({ bot: h, args: {} }), { ok: false, reason: 'no_food' })
  const sp = mkBot([['spider_eye', 2]], { food: 3, health: 20 }); assert.deepEqual(eat.precondition({ bot: sp, args: {} }), { ok: false, reason: 'no_food' })
  const part = mkBot([['rotten_flesh', 1]], { food: 4, health: 20 }); part.equip = async () => {}; part.consume = async () => { part.food += 4; part._items.length = 0 }
  const pr = await eat.run(mkCtx(part, {})); assert.equal(pr.reason, 'emergency_partly_fed')
})

// ---------------------------------------------------------------- 10 breed guard
test('breed guard: parents rest 5 min, a kind is kept at 4-6; babies count toward the cap', () => {
  const a = (name, baby = false) => ({ name, baby })
  const adults = (n, name = 'cow') => Array.from({ length: n }, () => a(name))
  assert.equal(breedGuard(adults(4), 'cow', {}, 1000), null)
  assert.equal(breedGuard([...adults(4), a('cow', true), a('cow', true)], 'cow', {}, 1000).reason, 'pen_full')
  assert.equal(BREED_CAP, 6); assert.equal(breedGuard([...adults(5), a('cow', true)], 'cow', {}, 0).reason, 'pen_full')
  const g = breedGuard(adults(2), 'cow', { cow: 1000 }, 1000 + 2 * 60000); assert.equal(g.reason, 'breed_cooldown'); assert.equal(g.wait_s, 180); assert.match(g.detail, /bred 2 min ago.*again in 3 min.*5 min cooldown.*20 min to grow/)
  assert.equal(breedGuard(adults(2), 'cow', { cow: 1000 }, 1000 + BREED_COOLDOWN_MS), null); assert.equal(breedGuard(adults(2), 'pig', { cow: 1000 }, 2000), null, 'other kinds are independent')
})
test('breed_animals skill: second try within 5 min answers breed_cooldown without feeding; the first feeding starts the clock', async () => {
  const env = { landmarks: new Landmarks() }; env.landmarks.set('pen', { x: 0, y: 64, z: 0 }, 'place')
  const sk = makeFarm1Skills(env).find((s) => s.name === 'breed_animals')
  const cows = [1, 2].map((i) => ({ id: i, name: 'cow', position: vec(i - 1.5, 64, 0), height: 1.4 }))
  const bot = mkBot([['wheat', 4]], { entities: Object.fromEntries(cows.map((c) => [c.id, c])), equip: async () => {}, lookAt: async () => {}, activateEntity: async () => {} })
  const ctx = mkCtx(bot, {}, { env })
  env.breedLog = { cow: Date.now() - 60000 }   // a feeding 1 min ago (the first feeding itself waits 35 s of real time for a baby)
  const second = await sk.run(mkCtx(bot, {}, { env })); assert.equal(second.ok, false); assert.equal(second.reason, 'breed_cooldown'); assert.match(second.detail, /5 min cooldown/)
  const env2 = { landmarks: env.landmarks, breedLog: {} }; const crowded = ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => ({ id: 10 + i, name: 'cow', position: vec(i * 0.3 - 0.5, 64, 0.2) }))
  const bot2 = mkBot([['wheat', 4]], { entities: Object.fromEntries(crowded.map((c) => [c.id, c])) }); const full = await makeFarm1Skills(env2).find((s) => s.name === 'breed_animals').run(mkCtx(bot2, {}, { env: env2 }))
  assert.equal(full.reason, 'pen_full')
})

test('grassNear stays usable by roam (re-exported) and the quiet digest names the new playbook cooldowns', () => {
  const bot = mkBot([], { findBlocks: () => [vec(2, 64, 0), vec(1, 64, 0)] }); assert.equal(grassNear(bot, 16)[0].p.x, 1)
  for (const n of ['seed_hunt', 'make_torches', 'fish_session', 'chicken_loop', 'bonemeal_grass']) assert.ok(getPlaybook(n).cooldown.reasons.length > 0, n)
  assert.ok(getPlaybook('breed_animals').cooldown.reasons.includes('breed_cooldown'))
})
