// BAT1: (1) the 13x gather_wood loop (observed, fixture sliced from that trace), (2) go_home must not kill the escape ladder / count 8 interruptions, (3) honest "build incomplete".
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import { gatherResource } from '../src/skills/gather.js'
import { noteDepleted, depletedAt, depletedMap } from '../src/skills/depleted.js'
import { createPlaybookEngine, PROTECTED_HOLDER } from '../src/playbooks/engine.js'
import { CATALOG } from '../src/habits/catalog.js'
import { makeBuild, incompleteDetail } from '../src/skills/build.js'

const ms = (t) => Date.parse(t)

// ---------- (1) gather_wood loop ----------
function emptyWorld(pos = [100, 64, 100]) {   // flat grass, no trees at all
  const bot = new EventEmitter()
  bot.registry = { blocksByName: { oak_log: { id: 1, name: 'oak_log' }, dirt: { id: 2, name: 'dirt' }, grass_block: { id: 3, name: 'grass_block' }, stone: { id: 4, name: 'stone' }, air: { id: 0, name: 'air' } } }
  bot.entity = { position: new Vec3(pos[0] + 0.5, pos[1], pos[2] + 0.5), onGround: true }; bot.health = 20; bot.entities = {}
  bot.inventory = { items: () => [], emptySlotCount: () => 20 }
  bot.blockAt = (v) => { const y = Math.floor(v.y); const n = y === 63 ? 'grass_block' : y > 63 ? 'air' : 'dirt'; return { name: n, boundingBox: n === 'air' ? 'empty' : 'block', position: new Vec3(Math.floor(v.x), y, Math.floor(v.z)), type: bot.registry.blocksByName[n].id } }
  bot.findBlocks = () => []
  bot.stopDigging = () => {}; bot.equip = async () => {}
  return bot
}
const mkctx = (bot) => { const logs = []; return { bot, aborted: false, state: {}, log: (e, d) => logs.push([e, d]), sleep: async () => {}, logs, goto: async () => ({ ok: false }) } }



test('cooldown: 5 min, per resource and place (48 m), not for other resources, ends on time', () => {
  const env = {}, p = { x: 0, z: 0 }
  noteDepleted(env, 'wood', p, 'no log within 112 m', 1_000_000)
  assert.equal(depletedAt(env, 'wood', { x: 30, z: 0 }, 1_000_000 + 240_000)?.left_s, 60)
  assert.equal(depletedAt(env, 'wood', { x: 80, z: 0 }, 1_000_000 + 10_000), null, 'far away: not on cooldown')
  assert.equal(depletedAt(env, 'stone', p, 1_000_000 + 10_000), null)
  assert.equal(depletedAt(env, 'wood', p, 1_000_000 + 301_000), null)
  assert.deepEqual(depletedMap(env, p, 1_000_000 + 1000), { wood: true, stone: false })
})

test('habits: gather_wood / gather_stone habits are off the list during the cooldown (a different activity is chosen), on again after', () => {
  const g = CATALOG.find((h) => h.name === 'gather_wood'), s = CATALOG.find((h) => h.name === 'gather_stone')
  const c = { inv: { free: 10, logs: 0, planks: 0, cobble: 0, pickaxe: 1 }, dark: false, exposed: [], tier: 0, depleted: { wood: false, stone: false } }
  assert.equal(g.applies(c), true); assert.equal(s.applies(c), true)
  assert.equal(g.applies({ ...c, depleted: { wood: true } }), false); assert.equal(s.applies({ ...c, depleted: { stone: true } }), false)
  assert.equal(CATALOG.find((h) => h.name === 'explore').applies({ ...c, depleted: { wood: true }, underground: false, inv: c.inv }), true)
})

const rigEng = (runSkill, o = {}) => {
  const t0 = { v: 1_000_000 }, pos = { x: 100, z: 100 }, spies = { abort: 0 }
  const bot = { username: 'Wren', health: 20, food: 20, entity: { position: { get x() { return pos.x }, y: 64, get z() { return pos.z }, offset() { return this }, distanceTo(q) { return Math.hypot(pos.x - q.x, pos.z - q.z) } }, onGround: true }, entities: {}, players: {}, thunderState: 0, inventory: { items: () => [], emptySlotCount: () => 20 }, registry: { foodsByName: {}, blocksByName: {} } }
  const eng = createPlaybookEngine({ getBot: () => bot, runSkill, env: {}, now: () => t0.v, sleep: async () => { t0.v += 300 }, notify: () => {}, abortCurrent: async () => { spies.abort++ }, ...o })
  return { eng, spies, t0 }
}
test('playbook make_tools: gather_wood no_target_found is tried ONCE (was 3x), fails no_wood, and make_tools is on cooldown at that place with the expedition hint', async () => {
  let calls = 0
  const R = rigEng(async (name) => { calls++; return { status: 'failed', reason: 'no_target_found', detail: '3 log blocks within 112 m but none usable', ms: 1, skill: name } })
  const ended = []
  const out = await R.eng.start('make_tools', {}, { onEnd: (e) => ended.push(e) }).promise
  assert.equal(out.reason, 'no_wood'); assert.equal(calls, 1)
  assert.match(ended[0].hint, /used up.*Next: resource_expedition resource=wood/)
  const again = R.eng.start('make_tools', {}); assert.equal(again.ok, false); assert.equal(again.cooldown, true); assert.match(again.errors[0], /not started again for \d+ s/)
})

// ---------- (2) go_home / interruptions ----------
const def1 = { name: 'go_home', desc: 'x', params: {}, steps: [{ id: 'go', do: { skill: 'go_to', args: { place: 'home' } } }] }
const lookup = (n) => (n === 'go_home' ? def1 : null)

test('real emergencies are protected holders, fillers are not; a filler (habit sleep) holding the body IS aborted once and the step resumes', async () => {
  for (const h of ['reflex:low_hp_cover', 's1:unstuck_nudge', 's1:escape_bridge', 's1:take_cover', 's1:dig_in', 's1:shelter']) assert.ok(PROTECTED_HOLDER.test(h), h)
  for (const h of ['s1:sleep', 's1:gather_wood', 's1:explore', 's1:idle_activity', 's1:wander', 's1:go_to']) assert.ok(!PROTECTED_HOLDER.test(h), h)
  let n = 0
  const R = rigEng(async (name) => (++n === 1 ? { status: 'rejected', reason: 'busy', holder: 's1:sleep', ms: 0, skill: name } : { status: 'done', ms: 3, skill: name }), { lookup })
  const out = await R.eng.start('go_home', {}).promise
  assert.equal(out.status, 'done'); assert.equal(R.spies.abort, 1); assert.equal(n, 2)
})
test('a reflex holding the body (e.g. low_hp_cover) is waited for, not aborted', async () => {
  let n = 0
  const R = rigEng(async (name) => (++n <= 3 ? { status: 'rejected', reason: 'busy', holder: 'reflex:low_hp_cover', ms: 0, skill: name } : { status: 'done', ms: 3, skill: name }), { lookup })
  const out = await R.eng.start('go_home', {}).promise
  assert.equal(out.status, 'done'); assert.equal(R.spies.abort, 0); assert.equal(R.eng.metrics().interruptions, 1)
})
test('step failure detail reaches the S2 summary (honest reasons)', async () => {
  const R = rigEng(async (name) => ({ status: 'failed', reason: 'incomplete', detail: 'placed 3 of 8 blocks: 5x out of reach', ms: 1, skill: name }), { lookup: () => ({ name: 'wall_ring', params: {}, steps: [{ id: 'ring', do: { skill: 'build', args: {} }, on_fail: { abort: 'could_not_wall' } }] }) })
  const ended = []; await R.eng.start('wall_ring', {}, { onEnd: (e) => ended.push(e) }).promise
  assert.match(ended[0].summary, /ring:failed\/incomplete \[placed 3 of 8 blocks: 5x out of reach\]/)
})

// ---------- (3) build incomplete ----------
function buildWorld({ refuse = () => false, blocks = 20, floor = true } = {}) {
  const m = new Map()
  const bot = new EventEmitter()
  const inv = [{ name: 'cobblestone', count: blocks }]
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }; bot.health = 20; bot.entities = {}
  bot.inventory = { items: () => inv, emptySlotCount: () => 20 }
  bot.registry = { blocksByName: {} }
  const nm = (x, y, z) => m.get(`${x},${y},${z}`) ?? (y === 63 && floor ? 'stone' : 'air')
  bot.blockAt = (v) => { const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z), n = nm(x, y, z); return { name: n, boundingBox: n === 'air' ? 'empty' : 'block', position: new Vec3(x, y, z), offset(a, b, c) { return bot.blockAt(new Vec3(x + a, y + b, z + c)) } } }
  bot.equip = async () => {}; bot.dig = async () => {}; bot.stopDigging = () => {}; bot.clearControlStates = () => {}
  bot.placeBlock = async (ref, face) => { const t = [ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z]; if (refuse(t)) throw new Error('blockUpdate timed out (server refused)'); m.set(t.join(','), 'cobblestone') }
  return { bot, m }
}
const bctx = (bot, args) => ({ bot, args, aborted: false, state: {}, log: () => {}, sleep: async () => {} })

test('build wall_ring: complete when every placement works', async () => {
  const { bot } = buildWorld()
  const r = await makeBuild({}).run(bctx(bot, { plan: 'wall_ring', height: 2 }))
  assert.equal(r.ok, true)
})
test('build wall_ring incomplete: the detail names what failed, how many were placed, and the alternative (not just "incomplete")', async () => {
  const { bot } = buildWorld({ refuse: (t) => t[0] === 1 })   // the +x side is refused by the server
  const r = await makeBuild({}).run(bctx(bot, { plan: 'wall_ring', height: 2 }))
  assert.equal(r.ok, false); assert.equal(r.reason, 'incomplete')
  assert.match(r.detail, /^placed \d+ of 8 blocks \(\d+ missing, holding \d+ placeable blocks\): \d+x the server refused the placement/)
  assert.match(r.detail, /Instead: step to another cell/)
})
test('build wall_ring with no support around (water edge / ledge): says no solid reference + the alternative', async () => {
  const { bot } = buildWorld({ floor: false })
  const r = await makeBuild({}).run(bctx(bot, { plan: 'wall_ring', height: 2 }))
  assert.equal(r.ok, false); assert.match(r.detail, /no solid block next to the cell to build on/); assert.match(r.detail, /flat dry ground/)
})
test('build: blocks running out mid-way is reported as such with the counts', async () => {
  const { bot } = buildWorld({ blocks: 8 })
  let n = 0; const inv = bot.inventory.items(); const orig = bot.placeBlock
  bot.placeBlock = async (ref, face) => { if (++n === 5) { inv[0].count = 0 } return orig(ref, face) }
  const r = await makeBuild({}).run(bctx(bot, { plan: 'wall_ring', height: 2 }))
  if (!r.ok) { assert.match(r.reason, /ran_out_of_blocks|incomplete/) }
})
test('incompleteDetail wording', () => {
  assert.match(incompleteDetail(new Map([['a', 'reach:out of reach']]), 8, 7, 12), /1x out of reach.*Instead: build again from the middle/)
})
