// EXP1: resource_expedition playbook (fake runner / fake bot, no server): plan refusals at dusk, depleted start -> remembered place -> gather -> remember -> home,
// unexplored-direction ranking (heat map + biome), move-on when a spot is empty, craft planks-first / honest missing_planks, menu hint.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlaybookEngine } from '../src/playbooks/engine.js'
import { getPlaybook, resolveParams, parsePlaybookTarget, playbooksText } from '../src/playbooks/catalog.js'
import { rankDestinations, daylight, tripMinutes, rememberResourcePlace } from '../src/playbooks/expedition.js'
import { Landmarks } from '../src/skills/landmarks.js'
import { craftItem } from '../src/skills/craft.js'

const vec = (x, y, z) => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) }, floored() { return vec(Math.floor(x), Math.floor(y), Math.floor(z)) } })
function mkBot(o = {}) {
  const bot = { username: 'Wren', health: 20, food: 20, entity: { position: vec(o.x ?? 0, 64, o.z ?? 0), onGround: true }, entities: {}, players: {}, thunderState: 0,
    inventory: { items: () => bot._items, emptySlotCount: () => o.free ?? 20 }, registry: { foodsByName: {}, blocksByName: {} }, _items: o.items ?? [], lookAt: async () => {}, time: { timeOfDay: o.tick ?? 1000 }, blockAt: o.blockAt ?? (() => null) }
  return bot
}
const add = (bot, name, n) => { const e = bot._items.find((i) => i.name === name); if (e) e.count += n; else bot._items.push({ name, count: n }) }
const logs = (bot) => bot._items.filter((i) => i.name.endsWith('_log')).reduce((s, i) => s + i.count, 0)
function rig({ bot = mkBot(), forestAt = null, home = true, setup = null } = {}) {
  const calls = [], notes = [], ended = []
  const env = { landmarks: new Landmarks(), foodSeen: new Map() }
  if (home) env.landmarks.set('home', { x: 0, y: 64, z: 0 }, 'home')
  setup?.(env, bot)
  const runSkill = async (name, args) => {
    calls.push({ name, args, at: [bot.entity.position.x, bot.entity.position.z] })
    if (name === 'move_to') { bot.entity.position = vec(args.x, 64, args.z); return { status: 'done', ms: 1 } }
    if (name === 'return_home') { bot.entity.position = vec(0, 64, 0); return { status: 'done', ms: 1 } }
    if (name === 'gather_wood') {
      const p = bot.entity.position
      if (forestAt && Math.hypot(p.x - forestAt.x, p.z - forestAt.z) < (forestAt.r ?? 40)) { add(bot, 'oak_log', args.count); return { status: 'done', ms: 1 } }
      return { status: 'failed', reason: 'no_target_found', detail: 'no log within 112 m (none in the loaded world around you)', ms: 1 }
    }
    return { status: 'failed', reason: 'unknown_skill', ms: 1 }
  }
  const eng = createPlaybookEngine({ getBot: () => bot, runSkill, env, sleep: async () => {}, notify: (k, t, d) => notes.push({ k, t, d }) })
  return { bot, eng, env, calls, notes, ended }
}
const go = async (R, args = {}) => { const st = R.eng.start('resource_expedition', args, { onEnd: (e) => R.ended.push(e) }); assert.ok(st.ok, JSON.stringify(st.errors)); return st.promise }
const HOME_D = (bot) => Math.round(Math.hypot(bot.entity.position.x, bot.entity.position.z))

test('catalog: resource_expedition is listed, params normalised (aliases, max_dist clamp)', () => {
  const d = getPlaybook('resource_expedition'); assert.ok(d)
  assert.deepEqual(resolveParams(d, {}).params, { resource: 'any', max_dist: 200 })
  assert.equal(resolveParams(d, { resource: 'trees' }).params.resource, 'wood')
  assert.equal(resolveParams(d, { resource: 'cobble', max_dist: '9000' }).params.max_dist, 400)
  assert.equal(resolveParams(d, { resource: 'rocks', max_dist: 5 }).params.max_dist, 40)
  assert.equal(resolveParams(d, { resource: 'gold' }).ok, false)
  assert.deepEqual(parsePlaybookTarget('resource_expedition resource=stone max_dist=120').args, { resource: 'stone', max_dist: '120' })
  assert.match(playbooksText(), /resource_expedition resource=<wood\|stone\|food\|any> \(optional\) max_dist=<metres> \(optional\)/)
})

test('daylight: ticks to minutes; a long trip needs more daylight than a short one', () => {
  assert.equal(daylight(mkBot({ tick: 1000 })).night, false)
  assert.equal(daylight(mkBot({ tick: 12542 })).night, true)
  assert.equal(daylight(mkBot({ tick: 11342 })).minToDusk, 1)
  assert.equal(daylight(mkBot({ tick: 13000 })).minToDawn, 9)
  assert.ok(tripMinutes(200) > tripMinutes(60))
})

test('near dusk: refuses with "not now: dusk in N min" and walks nowhere; at night too', async () => {
  let R = rig({ bot: mkBot({ tick: 10900 }), setup: (env) => env.landmarks.set('forest_a', { x: 120, y: 64, z: 0 }, 'forest') })   // 1642 ticks = 2 min to dusk
  let out = await go(R, { resource: 'wood' })
  assert.equal(out.status, 'failed'); assert.equal(out.reason, 'not now: dusk in 2 min')
  assert.equal(R.calls.length, 0); assert.match(R.ended[0].summary, /RESULT: not now: dusk in 2 min/)
  R = rig({ bot: mkBot({ tick: 14000 }) })
  out = await go(R, { resource: 'wood' }); assert.match(out.reason, /^not now: it is night, dawn in \d+ min$/); assert.equal(R.calls.length, 0)
})

test('depleted start: home has no trees, a remembered forest 120 m away -> walks there, 16 logs, remembers it, back home', async () => {
  const R = rig({ forestAt: { x: 120, z: 0 }, setup: (env) => { const r = env.landmarks.set('forest_a', { x: 120, y: 64, z: 0 }, 'forest'); r.note = 'oak forest, many trees'; env.landmarks.set('house', { x: -40, y: 64, z: 0 }, 'place') } })
  const out = await go(R, { resource: 'wood' })
  assert.equal(out.status, 'done', JSON.stringify(R.ended[0]))
  assert.ok(logs(R.bot) >= 16, `logs ${logs(R.bot)}`)
  assert.ok(HOME_D(R.bot) <= 12, 'back home: ' + HOME_D(R.bot))
  assert.ok(R.calls.filter((c) => c.name === 'move_to').some((c) => c.at[0] > 60), 'walked out')
  assert.equal(R.calls.filter((c) => c.name === 'gather_wood').length, 2, '8 + 8')
  assert.match(R.ended[0].summary, /RESULT: wood expedition collected 16 logs \(target reached\).*back home/)
  const f = R.env.landmarks.list().filter((l) => l.kind === 'forest'); assert.equal(f.length, 1)
  assert.match(f[0].note, /^forest at -?\d+,-?\d+ \(16 logs taken\)$/); assert.deepEqual(f[0].res, ['wood'])
  assert.ok(R.notes.some((n) => n.k === 'expedition_start') && R.notes.some((n) => n.k === 'expedition_result'))
})

test('unexplored start: no remembered place -> picks a direction, empty spots move her on, finds trees, remembers a new forest, goes home', async () => {
  // trees only in the west; every other bearing is empty. The heat map marks east/south/north cells as walked, so the west is the best guess.
  const R = rig({ forestAt: { x: -150, z: 0, r: 100 }, bot: mkBot({ blockAt: (v) => ({ biome: { name: v.x < -30 ? 'taiga' : 'plains' } }) }), setup: (env) => { env.heatmap = { cell: 8, count: (x, z) => (x > -30 ? 5 : 0) } } })
  const out = await go(R, { resource: 'wood' })
  if (process.env.DBG) console.log(R.calls.map((c) => `${c.name}@${c.at.map(Math.round)}->${c.args.x ?? ''},${c.args.z ?? ''}`).join('\n'), R.notes.map((n) => n.t).join('\n'))
  assert.equal(out.status, 'done', JSON.stringify(R.ended[0]))
  assert.ok(logs(R.bot) >= 16)
  assert.ok(HOME_D(R.bot) <= 12)
  const gw = R.calls.filter((c) => c.name === 'gather_wood'); assert.ok(gw[0].at[0] < -30, 'went west first: ' + gw[0].at)
  const f = R.env.landmarks.list().filter((l) => l.kind === 'forest'); assert.equal(f.length, 1); assert.ok(f[0].x < -100)
})

test('empty spots: moves on up to 4 times, then reports found_nothing, dead ends are not retried at once', async () => {
  const R = rig({})   // no trees anywhere
  const out = await go(R, { resource: 'wood' })
  assert.equal(out.status, 'failed'); assert.equal(out.reason, 'found_nothing')
  assert.ok(HOME_D(R.bot) <= 12, 'still comes home')
  assert.match(R.ended[0].summary, /RESULT: wood expedition found no logs/)
  assert.ok(R.calls.filter((c) => c.name === 'gather_wood').length >= 2)
  assert.equal(R.env.landmarks.list().filter((l) => l.kind === 'forest').length, 0)
})

test('daylight runs short on the way: stops gathering, still walks home', async () => {
  const R = rig({ forestAt: { x: 120, z: 0 }, bot: mkBot({ tick: 7000 }), setup: (env, bot) => { env.landmarks.set('forest_a', { x: 120, y: 64, z: 0 }, 'forest') } })
  const origRun = R.eng
  // dusk arrives during the first gather call: after it the clock reads 11500 (about 1 min left, home is 120 m away)
  const bot = R.bot; let first = true
  const orig = bot.inventory.items
  bot.inventory.items = () => { if (bot.entity.position.x > 100 && first && logs(bot) > 0) { first = false; bot.time.timeOfDay = 12000 } return orig() }
  const out = await go(R, { resource: 'wood' })
  assert.ok(logs(bot) >= 8 && logs(bot) < 16, 'logs ' + logs(bot))
  assert.ok(HOME_D(bot) <= 12)
  assert.match(R.ended[0].summary, /daylight getting short/)
  assert.equal(out.status, 'done')
})

test('the gather skill watchdog (aborted no_progress) ends one round, not the expedition: it keeps going and reports a partial/complete RESULT', async () => {
  const bot = mkBot(); let n = 0
  const R2 = rig({ bot })
  R2.env.landmarks.set('home', { x: 0, y: 64, z: 0 }, 'home'); R2.env.landmarks.set('forest_a', { x: 120, y: 64, z: 0 }, 'forest')
  const calls = []
  const eng = createPlaybookEngine({ getBot: () => bot, env: R2.env, sleep: async () => {}, notify: (k, t, d) => R2.notes.push({ k, t, d }),
    runSkill: async (name, args) => { calls.push(name); if (name === 'move_to') { bot.entity.position = vec(args.x, 64, args.z); return { status: 'done', ms: 1 } } if (name === 'gather_wood') { n++; add(bot, 'oak_log', n === 1 ? 3 : 8); return n === 1 ? { status: 'aborted', reason: 'no_progress', ms: 1 } : { status: 'done', ms: 1 } } return { status: 'done', ms: 1 } } })
  const st = eng.start('resource_expedition', { resource: 'wood' }, { onEnd: (e) => R2.ended.push(e) }); const out = await st.promise
  assert.equal(out.status, 'done', JSON.stringify(R2.ended[0])); assert.equal(logs(bot), 19); assert.equal(n, 3, '3 + 8 + 5: no op failure after the abort')
  assert.match(R2.ended[0].summary, /collected 19 logs \(target reached\)/)
})

test('rankDestinations: remembered places first (nearest), then unexplored ranked by heat map and biome; skips dead ends and places close by', () => {
  const lm = new Landmarks()
  lm.set('forest_near', { x: 10, y: 64, z: 5 }, 'forest')            // too close: she is standing in it
  lm.set('forest_far', { x: 150, y: 64, z: 0 }, 'forest')
  lm.set('oak_wood', { x: 0, y: 64, z: 90 }, 'place').note = 'lots of trees here'   // her own note counts
  lm.set('hill', { x: -80, y: 64, z: 0 }, 'place').note = 'stone hill'
  const bot = mkBot({ blockAt: (v) => ({ biome: { name: v.x < -40 ? 'taiga' : v.z > 40 ? 'desert' : 'plains' } }) })
  const env = { landmarks: lm, heatmap: { count: (x, z) => 0 } }
  const w = rankDestinations(bot, env, 'wood', 200)
  assert.deepEqual(w.filter((c) => c.source === 'remembered').map((c) => c.id), ['oak_wood', 'forest_far'])
  const unexplored = w.filter((c) => c.source === 'unexplored'); assert.ok(unexplored.length >= 3)
  assert.match(unexplored[0].label, /west.*taiga/, 'taiga to the west is best: ' + unexplored[0].label)
  assert.ok(!unexplored.slice(0, 2).some((c) => /desert/.test(c.biome ?? '')))
  assert.deepEqual(rankDestinations(bot, env, 'stone', 200).filter((c) => c.source === 'remembered').map((c) => c.id), ['hill'])
  env.expDead = new Map([['forest_far', Date.now() + 60000]])
  assert.ok(!rankDestinations(bot, env, 'wood', 200).some((c) => c.id === 'forest_far'))
  assert.ok(!rankDestinations(bot, env, 'wood', 100).some((c) => c.id === 'forest_far' || c.dist > 100))
})

test('rememberResourcePlace: merges within 35 m, keeps at most 3 of a kind, never touches home', () => {
  const env = { landmarks: new Landmarks() }; env.landmarks.set('home', { x: 0, y: 64, z: 0 }, 'home')
  const a = rememberResourcePlace(env, 'wood', { x: 100, y: 64, z: 0 }, 12); const b = rememberResourcePlace(env, 'wood', { x: 110, y: 64, z: 5 }, 4)
  assert.equal(a.id, b.id); assert.equal(env.landmarks.list().filter((l) => l.kind === 'forest').length, 1)
  for (let i = 1; i <= 4; i++) rememberResourcePlace(env, 'wood', { x: 100 + i * 200, y: 64, z: 0 }, 3)
  assert.equal(env.landmarks.list().filter((l) => l.kind === 'forest').length, 3)
  rememberResourcePlace(env, 'stone', { x: 0, y: 70, z: 300 }, 16)
  assert.equal(env.landmarks.list().find((l) => l.kind === 'stone_area').note.startsWith('stone at'), true)
  assert.ok(env.landmarks.home)
})

// ---- craft: planks first, honest missing_planks
function craftBot(inv) {
  const bot = { registry: { blocksByName: { crafting_table: { id: 7 } }, itemsByName: { oak_planks: { id: 3 }, stick: { id: 4 }, oak_log: { id: 5 } } }, entity: { position: vec(0.5, 64, 0.5), height: 1.8 }, inventory: { items: () => inv } }
  bot.findBlock = () => null; bot.blockAt = () => ({ name: 'air', type: 0 })
  const put = (n, c) => { const e = inv.find((i) => i.name === n); if (e) e.count += c; else inv.push({ name: n, count: c }) }
  bot.recipesFor = (id) => (id === 3 && inv.some((i) => i.name === 'oak_log' && i.count > 0) ? [{ id: 3 }] : id === 4 && inv.some((i) => /_planks$/.test(i.name) && i.count >= 2) ? [{ id: 4 }] : [])
  bot.craft = async (r) => { if (r.id === 3) { inv.find((i) => i.name === 'oak_log').count--; put('oak_planks', 4) } else { inv.find((i) => /_planks$/.test(i.name)).count -= 2; put('stick', 4) } }
  return bot
}
const cctx = (bot) => ({ bot, aborted: false, log: () => {}, sleep: async () => {}, goto: async () => ({ ok: true }) })
test('craft with logs but no planks: planks are made first, no missing_planks', async () => {
  const inv = [{ name: 'oak_log', count: 2 }]
  const r = await craftItem(cctx(craftBot(inv)), 'stick', 4)
  assert.equal(r.ok, true, JSON.stringify(r)); assert.ok(inv.find((i) => i.name === 'stick').count >= 4)
})
test('craft with no planks and no logs: missing_planks names the cause and the expedition', async () => {
  const r = await craftItem(cctx(craftBot([])), 'stick', 4)
  assert.equal(r.ok, false); assert.equal(r.reason, 'missing_planks'); assert.match(r.detail, /no logs.*resource_expedition resource=wood/)
})
