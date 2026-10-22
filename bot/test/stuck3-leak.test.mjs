// STUCK3: fixture slice of the live pit at 100,60,100 (synthetic:  walls solid, a water source in the head-level wall at z+1.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { leakCells, sealedWithLeak, plugLeaks, nicheCandidates, placeInWall } from '../src/skills/leak.js'
import { boxedIn } from '../src/skills/shelter.js'
import { fullyEnclosed } from '../src/detect/stuck.js'

const SOLID = (name) => ({ name, boundingBox: 'block' })
const AIR = { name: 'air', boundingBox: 'empty' }
const WATER = { name: 'water', boundingBox: 'empty' }
const S = { x: 100, y: 60, z: 100 }

function world({ leak = true } = {}) {
  const grid = new Map()
  const k = (x, y, z) => `${x},${y},${z}`
  for (let x = S.x - 3; x <= S.x + 3; x++) for (let z = S.z - 3; z <= S.z + 3; z++) for (let y = S.y - 2; y <= S.y + 4; y++) grid.set(k(x, y, z), y <= S.y + 1 ? SOLID('dirt') : (y === S.y + 2 ? SOLID('dirt') : AIR))
  grid.set(k(S.x, S.y, S.z), AIR); grid.set(k(S.x, S.y + 1, S.z), AIR)
  grid.set(k(S.x, S.y - 1, S.z), SOLID('cobblestone'))
  grid.set(k(S.x, S.y + 2, S.z), SOLID('oak_log'))
  if (leak) grid.set(k(S.x, S.y + 1, S.z + 1), WATER)
  const bot = new EventEmitter()
  bot.__placed = new Set()
  bot.blockAt = (v) => grid.get(k(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z))) ?? AIR
  bot.entity = { position: new Vec3(S.x + 0.5, S.y, S.z + 0.5), onGround: true }
  bot.health = 3; bot.food = 10; bot.time = { timeOfDay: 18000 }
  const inv = [{ name: 'sand', count: 12, type: 5 }, { name: 'furnace', count: 10, type: 6 }, { name: 'coal', count: 3, type: 7 }, { name: 'kelp', count: 1, type: 8 }]
  bot.inventory = { items: () => inv }
  bot.registry = { blocksByName: {} }
  bot.equip = async () => {}
  bot.dig = async (b) => { for (const [kk, v] of grid) if (v === b) grid.set(kk, AIR) }
  bot.placed = []
  bot.placeBlock = async (ref, face) => {
    const t = new Vec3(ref.position?.x ?? 0, 0, 0)
    void t
    const tgt = bot._ref2(ref).plus(new Vec3(face.x, face.y, face.z))
    const item = bot.heldName ?? 'sand'
    grid.set(k(tgt.x, tgt.y, tgt.z), SOLID(item)); bot.placed.push([tgt.x, tgt.y, tgt.z, item])
  }
  // blockAt returns shared objects: look the reference up by identity
  bot._ref2 = (ref) => { for (const [kk, v] of grid) if (v === ref) { const [x, y, z] = kk.split(',').map(Number); return new Vec3(x, y, z) } throw new Error('ref') }
  const origBlockAt = bot.blockAt
  bot.blockAt = (v) => { const b = origBlockAt(v); return b }
  return { bot, grid }
}
// give each cell its own object so identity lookups work
function unique(w) { for (const [kk, v] of w.grid) w.grid.set(kk, { ...v }); return w }

test('leaking pit is not boxedIn / fullyEnclosed but is sealedWithLeak; the leak cell is found', () => {
  const { bot } = unique(world())
  assert.equal(boxedIn(bot), false)
  assert.equal(fullyEnclosed(bot), false)
  assert.equal(sealedWithLeak(bot), true)
  assert.deepEqual(leakCells(bot), [{ x: S.x, y: S.y + 1, z: S.z + 1 }])
})

test('plugLeaks places a block into the water cell, then the cell is sealed', async () => {
  const w = unique(world()); const { bot } = w
  const r = await plugLeaks(bot, { sleep: async () => {}, settleMs: 10 })
  assert.equal(r.plugged, 1)
  assert.equal(r.left, 0)
  assert.equal(sealedWithLeak(bot), false)   // nothing leaks any more
  assert.equal(fullyEnclosed(bot), true)
  assert.equal(boxedIn(bot), true)
})

test('a dry sealed cell is not a leak case', () => {
  const { bot } = unique(world({ leak: false }))
  assert.equal(sealedWithLeak(bot), false)
  assert.equal(boxedIn(bot), true)
})

test('niche: a plain wall block is chosen, water-backed ones are not', () => {
  const { bot, grid } = unique(world({ leak: false }))
  const c = nicheCandidates(bot, {})
  assert.ok(c.length >= 1)
  // put water behind the east wall head-level block: that one is excluded
  grid.set(`${S.x + 2},${S.y + 1},${S.z}`, { ...WATER })
  const c2 = nicheCandidates(bot, {})
  assert.ok(!c2.some((x) => x.W.x === S.x + 1 && x.W.y === S.y + 1))
  // protected cell excluded
  const c3 = nicheCandidates(bot, { digForbidden: () => true })
  assert.equal(c3.length, 0)
})

test('placeInWall: digs one wall block, puts the furnace there, cell stays boxed in', async () => {
  const w = unique(world({ leak: false })); const { bot } = w
  bot.heldName = 'furnace'
  const at = await placeInWall({ bot, aborted: false }, 'furnace', {})
  assert.ok(at)
  const b = bot.blockAt(at)
  assert.equal(b.name, 'furnace')
  assert.equal(boxedIn(bot), true)
})

import { capExempt } from '../src/mindlink/translate.js'
import { StuckMonitor, fullyEnclosed as fe } from '../src/detect/stuck.js'
test('cook is exempt from repeat caps / mind lockouts (live: cook refused 8x with locked_out at hp 3)', () => {
  assert.equal(capExempt('cook', {}), true)
})
test('sealed + hurt: while cook is the running skill the 120 s cover hold keeps renewing; once idle it expires', () => {
  const { bot } = unique(world({ leak: false }))
  let cur = { name: 'cook', skill: { name: 'cook' } }
  const triggers = []
  const runner = { get current() { return cur }, on() {} }
  const ladder = { busy: false, level: 0, cooldownUntil: 0, trigger: async (r) => { triggers.push(r); return { verified: true } }, reset() {} }
  const lag = { status: () => ({ lagging: false, factor: 1 }), noteDiscontinuity() {} }
  let t = 1e6
  const m = new StuckMonitor({ body: { bot, spawned: true }, runner, ladder, lag, now: () => t })
  const step = (n) => { for (let i = 0; i < n; i++) { t += 1000; m.tick() } }
  assert.equal(fe(bot), true)
  step(200)
  assert.deepEqual(triggers, [])
  cur = { name: 'idle_activity', skill: { name: 'idle_activity' } }
  step(200)
  assert.ok(triggers.length >= 1)
})
