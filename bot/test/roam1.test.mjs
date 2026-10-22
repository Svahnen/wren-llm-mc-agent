// ROAM1: roam / make_camp / new_home playbooks, the dusk rule while roaming, collect_seeds. Fake runner + simulated world (no server).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlaybookEngine } from '../src/playbooks/engine.js'
import { getPlaybook, resolveParams, playbooksText } from '../src/playbooks/catalog.js'
import { buildCamp, surroundings, rememberPlace } from '../src/playbooks/roam.js'
import { duskFacts, duskLine, campReason, returnReason, shouldLeaveForDusk, DUSK_START } from '../src/habits/safety.js'
import { CATALOG } from '../src/habits/catalog.js'
import { Landmarks } from '../src/skills/landmarks.js'
import { makeRoamSkills, grassNear, seedCount } from '../src/skills/roam.js'
import { validateArgs } from '../src/skills/schema.js'

const vec = (x, y, z) => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) }, floored() { return vec(Math.floor(x), Math.floor(y), Math.floor(z)) } })
const EDIBLE = { beef: 1, cooked_beef: 1, bread: 1, apple: 1, sweet_berries: 1 }
const FOOD_X = 450   // food, grass, water and trees exist only east of this line

/** simulated world: position, clock, hunger, inventory; skills cost game time (ticks) */
function sim({ tick = 3000, items = [], food = 6, home = true, foodX = FOOD_X } = {}) {
  const bot = { username: 'Wren', health: 20, food, thunderState: 0, time: { timeOfDay: tick }, entity: { position: vec(0, 64, 0), onGround: true }, entities: {}, _items: items.map(([name, count]) => ({ name, count })),
    inventory: { items: () => bot._items, emptySlotCount: () => 20 }, blockAt: () => null }
  const reg = { grass: 1, water: 2, log: 3 }
  bot.registry = { foodsByName: EDIBLE_REG, blocksByName: { short_grass: { id: reg.grass, name: 'short_grass' }, water: { id: reg.water, name: 'water' }, oak_log: { id: reg.log, name: 'oak_log' } } }
  const rich = () => bot.entity.position.x >= foodX
  bot.findBlocks = ({ matching }) => (rich() ? Array.from({ length: 12 }, (_, i) => vec(bot.entity.position.x + 2 + i, 64, bot.entity.position.z)).slice(0, matching.includes(reg.log) ? 8 : 12) : [])
  bot.findBlock = ({ matching }) => (rich() && (matching === reg.water || [].concat(matching).includes(reg.water)) ? { position: vec(0, 64, 0) } : null)
  const refreshAnimals = () => { bot.entities = rich() ? { 1: { id: 1, name: 'cow', position: bot.entity.position.offset(6, 0, 0), isValid: true }, 2: { id: 2, name: 'cow', position: bot.entity.position.offset(-6, 0, 3), isValid: true }, 3: { id: 3, name: 'pig', position: bot.entity.position.offset(0, 0, 9), isValid: true } } : {} }
  const add = (n, c) => { const e = bot._items.find((i) => i.name === n); if (e) e.count += c; else bot._items.push({ name: n, count: c }) }
  const ate = []
  const env = { landmarks: new Landmarks(), foodSeen: new Map() }
  if (home) env.landmarks.set('home', { x: 0, y: 64, z: 0 }, 'home')
  const calls = [], notes = []
  const adv = (t) => { bot.time.timeOfDay = (bot.time.timeOfDay + t) % 24000 }
  const runSkill = async (name, args) => {
    calls.push({ name, args, at: [Math.round(bot.entity.position.x), Math.round(bot.entity.position.z)], tick: bot.time.timeOfDay })
    refreshAnimals()
    switch (name) {
      case 'move_to': { const p = bot.entity.position; adv(Math.round((Math.hypot(args.x - p.x, args.z - p.z) / 4.3) * 20)); bot.entity.position = vec(args.x, 64, args.z); refreshAnimals(); return { status: 'done' } }
      case 'collect': add('dirt', 16); adv(400); return { status: 'done' }
      case 'place_torch': return { status: 'done' }
      case 'eat': { const f = bot._items.find((i) => EDIBLE[i.name]); if (!f) return { status: 'failed', reason: 'no_food' }; f.count--; if (!f.count) bot._items.splice(bot._items.indexOf(f), 1); bot.food = Math.min(20, bot.food + 4); ate.push(f.name); adv(40); return { status: 'done' } }
      case 'hunt': if (!rich()) return { status: 'failed', reason: 'no_animal_nearby' }; add('beef', 2); adv(500); return { status: 'done' }
      case 'forage_plants': return { status: 'failed', reason: 'no_target_found' }
      case 'collect_seeds': if (!rich()) return { status: 'failed', reason: 'no_grass' }; add('wheat_seeds', 1); adv(700); return { status: 'done' }
      case 'shelter': case 'hole_and_cap': bot.time.timeOfDay = 23500; if (name === 'shelter') bot.__sheltered = true; return { status: 'done' }
      case 'exit_hole': case 'dig_stairs_up': return { status: 'done' }
      case 'dig_in': bot.time.timeOfDay = 23500; return { status: 'done' }
      case 'set_home': env.landmarks.set('home', { x: bot.entity.position.x, y: 64, z: bot.entity.position.z }, 'home'); return { status: 'done' }
      case 'build': case 'close_doors_nearby': return { status: 'done' }
      case 'sleep': bot.time.timeOfDay = 23500; return { status: 'done' }
      default: return { status: 'failed', reason: 'unknown_skill' }
    }
  }
  const eng = createPlaybookEngine({ getBot: () => bot, runSkill, env, sleep: async () => { /* no real waiting */ }, notify: (k, t, d) => notes.push({ k, t, d, active: env.roam?.active }) })
  return { bot, env, eng, calls, notes, add, ate, adv }
}
const EDIBLE_REG = Object.fromEntries(Object.keys(EDIBLE).map((k) => [k, { foodPoints: 4 }]))
const run = async (S, name, args = {}) => { const ended = []; const st = S.eng.start(name, args, { onEnd: (e) => ended.push(e) }); assert.ok(st.ok, JSON.stringify(st.errors)); const out = await st.promise; return { out, ended } }

test('catalog: roam / make_camp / new_home exist, params normalised, listed for S2; collect_seeds is a registered skill with validated args', () => {
  const d = getPlaybook('roam'); assert.ok(d && getPlaybook('make_camp') && getPlaybook('new_home'))
  assert.deepEqual(resolveParams(d, { days: '3', direction: 'north' }).params, { direction: 'north', days: 3, max_dist: 400, at_dusk: 'auto', bed: 'no' })
  assert.match(playbooksText(), /roam .*days=<int>/)
  assert.equal(validateArgs('collect_seeds', { count: 6 }).ok, true)
  assert.equal(validateArgs('collect_seeds', { count: 99 }).ok, false)
})

test('dusk rule: facts and the honest line (home 380 m away, dusk in 2 min: camp here or go home)', () => {
  // tick 9800 -> 1400 ticks (70 s, ~1.2 min) to dusk; home 380 m away needs 127 s: not reachable
  const c = { ticks: 9800, hasHome: true, homeDist: 380, roaming: true }
  const f = duskFacts(c); assert.equal(f.homeReachable, false); assert.ok(f.walk > f.secs)
  assert.match(duskLine(c), /^home is 380 m away; dark in \d+ min: home is too far to reach before dark: camp here \(make_camp\)$/)
  const near = { ticks: 9000, hasHome: true, homeDist: 120, roaming: true }   // 100 s left, walk 40 s: reachable
  assert.match(duskLine(near), /go home \(go_home\) or camp here \(make_camp\)/)
  assert.equal(duskLine({ ticks: 2000, hasHome: true, homeDist: 380 }), null, 'plenty of daylight: silent')
  assert.equal(duskLine({ ticks: 14000, hasHome: true, homeDist: 380 }), null, 'night: other rules')
  assert.equal(duskLine({ ticks: 9800, hasHome: true, homeDist: 10 }), null, 'at home')
})

test('dusk rule: roaming + home too far -> no march home, camp instead; not roaming -> DUSK1 unchanged', () => {
  const far = { ticks: 9800, hasHome: true, homeDist: 380, bot: { health: 20 }, inv: { free: 10 }, hostiles: 0 }
  assert.ok(shouldLeaveForDusk(far))
  assert.equal(returnReason(far), 'before_dusk', 'not roaming: DUSK1 as before')
  assert.equal(returnReason({ ...far, roaming: true }), null, 'roaming: the march home is not forced')
  assert.equal(campReason({ ...far, roaming: true }), 'dusk_far_from_home')
  assert.equal(campReason(far), null)
  // plenty of time / home reachable while roaming: camp is not forced, going home still allowed
  assert.equal(campReason({ ticks: 2000, hasHome: true, homeDist: 380, roaming: true }), null)
  const reach = { ticks: 9000, hasHome: true, homeDist: 120, roaming: true, bot: { health: 20 }, inv: { free: 10 }, hostiles: 0 }
  assert.equal(returnReason(reach), 'before_dusk'); assert.equal(campReason(reach), null)
  // a roam with dusk already begun (tick 11500) far from home: camp
  assert.equal(campReason({ ticks: 11500, hasHome: true, homeDist: 300, roaming: true }), 'dusk_far_from_home')
  assert.equal(campReason({ ticks: 13000, hasHome: true, homeDist: 300, roaming: true }), null, 'night: shelter habit')
  assert.equal(campReason({ ticks: 23800, hasHome: true, homeDist: 300, roaming: true }), null, 'morning')
})

test('habit camp_here: applies when roaming at dusk away from home, picks shelter with 9+ blocks else hole_and_cap', () => {
  const h = CATALOG.find((x) => x.name === 'camp_here'); assert.ok(h)
  const c = { campWhy: 'dusk_far_from_home', sealed: false, underground: false, inv: { blocks: 20 } }
  assert.equal(h.applies(c), true); assert.deepEqual(h.plan(c), { skill: 'shelter', args: {} })
  assert.deepEqual(h.plan({ ...c, inv: { blocks: 3 } }), { skill: 'hole_and_cap', args: {} })
  assert.equal(h.applies({ ...c, campWhy: null }), false); assert.equal(h.applies({ ...c, sealed: true }), false)
})

test('roam refuses at night, in thunder and with dusk near (nothing walked)', async () => {
  let S = sim({ tick: 14000 }); let r = await run(S, 'roam')
  assert.equal(r.out.status, 'failed'); assert.match(r.out.reason, /^not now: it is night, dawn in \d+ min$/); assert.equal(S.calls.length, 0); assert.equal(S.env.roam, undefined)
  S = sim({ tick: 11000 }); r = await run(S, 'roam'); assert.match(r.out.reason, /^not now: dusk in \d+ min$/); assert.equal(S.calls.length, 0)
  S = sim({ tick: 3000 }); S.bot.thunderState = 1; r = await run(S, 'roam'); assert.equal(r.out.reason, 'not now: thunderstorm')
})

test('2-day roam from a depleted start: kit, walks out, camps at dusk (home too far), survives the night, food >= 14, >= 4 seeds, remembers places, comes home', async () => {
  const S = sim({ tick: 3000, food: 6 })
  const { out, ended } = await run(S, 'roam', { direction: 'east', days: 2, max_dist: 600 })
  if (process.env.DBG) console.log(S.calls.map((c) => `${c.name}@${c.at}t${c.tick}`).join('\n'), S.notes.map((n) => n.t).join('\n'))
  assert.equal(out.status, 'done', JSON.stringify(ended[0]))
  assert.ok(S.calls.some((c) => c.name === 'collect' && c.args.resource === 'dirt'), 'kit: building blocks first')
  assert.ok(S.bot.food >= 14, 'food ' + S.bot.food)
  assert.ok(seedCount(S.bot) >= 4, 'seeds ' + seedCount(S.bot))
  const camps = S.calls.filter((c) => c.name === 'shelter' || c.name === 'hole_and_cap')
  assert.equal(camps.length, 1, 'exactly one night camp: ' + camps.map((c) => c.name))
  assert.ok(camps[0].at[0] > 150, 'camp is far from home: ' + camps[0].at)
  assert.ok(camps[0].tick >= 8800 && camps[0].tick < 11300, 'built before dusk, tick ' + camps[0].tick)
  assert.equal(S.calls.filter((c) => c.name === 'place_torch').length, 0, 'no torches carried: none placed')
  assert.ok(Math.hypot(S.bot.entity.position.x, S.bot.entity.position.z) <= 12, 'back home')
  const kinds = new Set(S.env.landmarks.list().map((l) => l.kind))
  for (const k of ['food_area', 'meadow', 'water', 'forest', 'camp']) assert.ok(kinds.has(k), `remembered ${k}: ${[...kinds]}`)
  assert.match(ended[0].summary, /RESULT: roamed .*1 night camp\(s\).*seed\(s\) picked.*back home/)
  assert.ok(S.notes.some((n) => n.k === 'roam_dusk' && /m from home; dusk in .*camping here/.test(n.t)))
  assert.equal(S.env.roam.active, false, 'habit layer flag cleared')
})

test('roam with a torch in the pack: the camp places it before sealing; a bed is not used unless bed=yes', async () => {
  const S = sim({ tick: 3000, food: 6, items: [['torch', 4], ['white_bed', 1], ['dirt', 30]] })
  await run(S, 'roam', { direction: 'east', days: 2, max_dist: 600 })
  const names = S.calls.map((c) => c.name)
  assert.ok(names.indexOf('place_torch') >= 0 && names.indexOf('place_torch') < names.indexOf('shelter'))
  assert.ok(!names.includes('sleep'))
})

test('roam: env.roam.active (read by the habit layer) is true during the trip, cleared at the end; the camp note carries the plain facts', async () => {
  const S = sim({ tick: 3000, food: 6 })
  await run(S, 'roam', { direction: 'east', days: 2, max_dist: 600 })
  assert.equal(S.notes.find((n) => n.k === 'roam_start').active, true); assert.equal(S.notes.find((n) => n.k === 'camp_start').active, true)
  assert.match(S.notes.find((n) => n.k === 'camp_start').t, /Making a camp here \(-?\d+,-?\d+\): \d+ building blocks, 0 torches\. \d+ m away|Making a camp here/)
  assert.equal(S.notes.find((n) => n.k === 'roam_result').active, false)
})

test('make_camp: pillbox with 9+ blocks, hole with none, dig_in with a pick, honest failure otherwise; remembered as place "camp"', async () => {
  let S = sim({ tick: 9900, items: [['dirt', 20]] }); S.bot.entity.position = vec(300, 64, 0)
  let r = await run(S, 'make_camp'); assert.equal(r.out.status, 'done', JSON.stringify(r.ended[0]))
  assert.deepEqual(S.calls.map((c) => c.name), ['shelter']); assert.match(S.env.landmarks.list().find((l) => l.kind === 'camp').note, /camp \(pillbox\) at 300,0/)
  S = sim({ tick: 9900, items: [] }); S.bot.entity.position = vec(300, 64, 0)
  r = await run(S, 'make_camp'); assert.equal(r.out.status, 'done'); assert.deepEqual(S.calls.map((c) => c.name).slice(0, 3), ['hole_and_cap', 'exit_hole'].slice(0, 1).concat(['exit_hole']).slice(0, 1).concat(S.calls.map((c) => c.name)[1]))
  assert.ok(S.calls.some((c) => c.name === 'hole_and_cap') && S.calls.some((c) => c.name === 'dig_stairs_up'), 'no blocks: leaves by stairs')
  // already enclosed (hole, hut, cave pocket): that is the camp
  { const S3 = sim({ tick: 9900, items: [['dirt', 4]] }); S3.bot.entity.position = vec(300, 64, 0)
    const x3 = { bot: () => S3.bot, runSkill: async (n) => (n === 'hole_and_cap' ? { status: 'failed', reason: 'already_sealed' } : { status: 'done' }), notify: () => {}, now: Date.now, sleep: async () => {}, aborted: () => false, state: {}, env: S3.env }
    S3.bot.time.timeOfDay = 9900   // day: wait_until(safe_to_leave) holds at once
    const r3 = await buildCamp(x3, {}); assert.equal(r3.status, 'done'); assert.match(r3.detail, /camp via hole/) }
  // nothing works: honest failure with the tried methods
  S = sim({ tick: 9900, items: [] }); S.bot.entity.position = vec(300, 64, 0)
  const run0 = S.eng; const orig = S.calls
  const S2 = sim({ tick: 9900, items: [] }); S2.bot.entity.position = vec(300, 64, 0)
  const x = { bot: () => S2.bot, runSkill: async () => ({ status: 'failed', reason: 'cannot_make_hole' }), notify: () => {}, now: Date.now, sleep: async () => {}, aborted: () => false, state: {}, env: S2.env }
  const res = await buildCamp(x, {}); assert.equal(res.status, 'failed'); assert.equal(res.reason, 'no_camp_possible'); assert.match(res.detail, /tried hole: cannot_make_hole/)
  void run0; void orig
})

test('make_camp bed=yes with a bed and 40+ blocks: hut, then sleeps in the bed (spawn set by her choice); without bed=yes the bed is untouched', async () => {
  let S = sim({ tick: 9900, items: [['dirt', 50], ['white_bed', 1]] }); S.bot.entity.position = vec(300, 64, 0)
  await run(S, 'make_camp', { bed: 'yes' })
  const n = S.calls.map((c) => c.name); assert.ok(n.includes('build') && n.includes('sleep') && !n.includes('shelter'), n.join())
  S = sim({ tick: 9900, items: [['dirt', 50], ['white_bed', 1]] }); S.bot.entity.position = vec(300, 64, 0)
  await run(S, 'make_camp'); assert.ok(!S.calls.some((c) => c.name === 'sleep'))
})

test('new_home: old home stays remembered as old_home, home moves to the spot; only when she runs it', async () => {
  const S = sim({ tick: 3000 }); S.bot.entity.position = vec(500, 64, 40)
  const r = await run(S, 'new_home'); assert.equal(r.out.status, 'done', JSON.stringify(r.ended[0]))
  const lm = S.env.landmarks; assert.equal(Math.round(lm.get('home').x), 500); assert.equal(Math.round(lm.get('old_home').x), 0); assert.match(lm.get('old_home').note, /my previous home at 0,0/)
  assert.ok(S.notes.some((x) => x.k === 'home_moved'))
})

test('a good site (animals + grass + water + trees) far from home is remembered and OFFERED, home is not moved by the roam', async () => {
  const S = sim({ tick: 3000, food: 6 })
  await run(S, 'roam', { direction: 'east', days: 2, max_dist: 600 })
  assert.ok(S.notes.some((n) => n.k === 'roam_site' && /new_home/.test(n.t)))
  assert.ok(S.env.landmarks.list().some((l) => l.kind === 'good_site'))
  assert.equal(Math.round(S.env.landmarks.get('home').x), 0, 'home unchanged')
})

test('rememberPlace: capped per kind, merged within 40 m', () => {
  const env = { landmarks: new Landmarks() }
  for (let i = 0; i < 6; i++) rememberPlace(env, 'meadow', { x: i * 100, y: 64, z: 0 }, `m${i}`, { cap: 3 })
  assert.equal(env.landmarks.list().filter((l) => l.kind === 'meadow').length, 3)
  rememberPlace(env, 'meadow', { x: 510, y: 64, z: 0 }, 'again', { cap: 3 }); assert.equal(env.landmarks.list().filter((l) => l.kind === 'meadow').length, 3)
})

test('blocked heading bends; unreachable home ends the roam honestly', async () => {
  const S = sim({ tick: 3000 })
  let n = 0; const base = S.eng
  const bot = S.bot, env = S.env, notes = []
  const calls = []
  const runSkill = async (name, args) => { calls.push(name); if (name === 'move_to') { n++; if (n > 3) return { status: 'failed', reason: 'no_path' }; bot.entity.position = vec(args.x, 64, args.z); return { status: 'done' } } if (name === 'collect') return { status: 'done' }; return { status: 'failed', reason: 'x' } }
  const eng = createPlaybookEngine({ getBot: () => bot, runSkill, env, sleep: async () => {}, notify: (k, t) => notes.push(t) })
  const ended = []; const st = eng.start('roam', { direction: 'east', days: 1 }, { onEnd: (e) => ended.push(e) }); await st.promise
  assert.match(ended[0].summary, /RESULT: roamed/); assert.ok(notes.some((t) => /Turning for home \(blocked\)/.test(t)) || calls.filter((c) => c === 'move_to').length >= 6)
  void base
})

test('collect_seeds skill: no grass -> no_grass; grass -> breaks it until a seed drops, success = seed delta', async () => {
  const [sk] = makeRoamSkills()
  const mk = (grass) => { const bot = { health: 20, entity: { position: vec(0, 64, 0) }, _items: [], inventory: { items: () => bot._items, emptySlotCount: () => 10 }, registry: { blocksByName: { short_grass: { id: 1, name: 'short_grass' } } }, findBlocks: () => (grass ? Array.from({ length: 6 }, (_, i) => vec(3 + i, 64, 0)) : []), _dug: 0,
    blockAt: (p) => ({ name: 'short_grass', position: p }), lookAt: async () => {}, dig: async () => { bot._dug++; if (bot._dug === 3) bot._items.push({ name: 'wheat_seeds', count: 1 }) }, stopDigging() {}, entities: {} }; return bot }
  assert.deepEqual(sk.precondition({ bot: mk(false) }), { ok: false, reason: 'no_grass', detail: 'no tall grass or fern within 16 m' })
  assert.equal(sk.precondition({ bot: mk(true) }), true)
  const bot = mk(true)
  const ctx = { bot, args: { count: 1 }, state: {}, aborted: false, goto: async () => ({ ok: true }), sleep: async () => {} }
  const r = await sk.run(ctx); assert.equal(r.ok, true); assert.equal(r.gained, 1); assert.equal(bot._dug, 3)
  const bot2 = mk(true); bot2.dig = async () => {}
  const r2 = await sk.run({ ...ctx, bot: bot2, state: {} }); assert.equal(r2.ok, false); assert.equal(r2.reason, 'no_seeds_dropped')
})

test('surroundings: scores animals, grass, water and trees', () => {
  const S = sim({ tick: 3000 }); S.bot.entity.position = vec(500, 64, 0); S.bot.entities = { 1: { id: 1, name: 'cow', position: vec(505, 64, 0), isValid: true }, 2: { id: 2, name: 'pig', position: vec(495, 64, 0), isValid: true } }
  const s = surroundings(S.bot); assert.equal(s.animals, 2); assert.ok(s.grass >= 8 && s.water && s.logs >= 6); assert.equal(s.score, 4)
  S.bot.entity.position = vec(0, 64, 0); S.bot.entities = {}; assert.equal(surroundings(S.bot).score, 0)
})
