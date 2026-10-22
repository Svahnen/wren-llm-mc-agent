import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { LagMonitor } from '../src/detect/lag.js'
import { EscalationLadder, RestartStore } from '../src/escape/ladder.js'
import { Trace } from '../src/trace.js'
import { diagnose, groundBelow, ownPillarHeight, pillarCells } from '../src/escape/world.js'
import { planEscape, pillarAllowed, MAX_PILLAR } from '../src/escape/skills.js'
import { confinedNote, brainDigest } from '../src/mindlink/digest.js'
import { buildDigest } from '../../mind/digest.js'

const AIR = { name: 'air', boundingBox: 'empty' }, STONE = { name: 'stone', boundingBox: 'block' }, LAVA = { name: 'lava', boundingBox: 'empty' }
/** Column x=0,z=0 solid up to y<=top (standing y=top+1); ground at y<64 everywhere except `hole` predicate. */
function columnWorld(top, { lavaAt = null } = {}) {
  const bot = new EventEmitter()
  bot.blockAt = (v) => {
    if (lavaAt && lavaAt(v)) return LAVA
    if (v.x === 0 && v.z === 0 && v.y <= top) return STONE
    return v.y < 64 ? STONE : AIR
  }
  bot.entity = { position: new Vec3(0.5, top + 1, 0.5), onGround: true, yaw: 0 }
  bot.inventory = { items: () => [{ name: 'cobblestone', count: 20, type: 1 }] }
  bot.registry = { blocksByName: { cobblestone: { boundingBox: 'block', transparent: false } } }
  return bot
}

test('elevated: 1-wide 20-tall column is elevated; 2-tall column is not (step off); flat ground is not', () => {
  const tall = diagnose(columnWorld(83))
  assert.equal(tall.elevated, true); assert.equal(tall.trapped, true); assert.ok(tall.dropBelow >= 19)
  const low = diagnose(columnWorld(65))
  assert.equal(low.elevated, false); assert.equal(low.dropBelow, 2)
  const flat = new EventEmitter(); flat.blockAt = (v) => (v.y < 64 ? STONE : AIR); flat.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  assert.equal(diagnose(flat).elevated, false)
})

test('groundBelow reports lava landing so descend would refuse a lava drop', () => {
  const bot = columnWorld(83, { lavaAt: (v) => v.y === 63 && !(v.x === 0 && v.z === 0) })
  assert.equal(groundBelow(bot).landing, 'lava')
})

test('planEscape: elevated puts escape_descend first and never pillars up or places under', () => {
  const { cands } = planEscape(columnWorld(83))
  assert.equal(cands[0], 'escape_descend')
  assert.ok(!cands.includes('escape_pillar_up')); assert.ok(!cands.includes('escape_place_under'))
})

test('pillarAllowed: pit yes; open column no; own pillar >= cap no', () => {
  const pit = columnWorld(64)
  pit.blockAt = (v) => (v.y < 64 || (v.y >= 64 && v.y < 68 && !(v.x === 0 && v.z === 0)) ? STONE : AIR)
  pit.entity.position = new Vec3(0.5, 64, 0.5)
  assert.equal(pillarAllowed(pit), true)
  for (let i = 0; i < MAX_PILLAR; i++) pillarCells(pit).push({ x: 0, y: 63 - i, z: 0 })
  assert.equal(ownPillarHeight(pit), MAX_PILLAR); assert.equal(pillarAllowed(pit), false)
  assert.equal(pillarAllowed(columnWorld(70)), false)
})

function ladderRig(bot, script, cfg = {}) {
  const body = new EventEmitter()
  Object.assign(body, { bot, spawned: true, gen: 1, state: 'spawned' })
  const calls = []
  const run = async (name, args) => { calls.push(name); return { skill: name, ms: 1, ...(script[name]?.(bot) ?? { status: 'failed', reason: 'scripted' }) } }
  const runner = { abort: async () => {}, current: null, skills: new Map() }
  const ladder = new EscalationLadder({ body, runner, run, trace: new Trace({ keepLast: 200 }), lag: new LagMonitor({ now: Date.now }), cfg: { escapeBudgetS: 5, ...cfg }, store: new RestartStore(), onRestart: () => {} })
  return { ladder, calls }
}

test('ladder: elevated episode runs escape_descend BEFORE nudge and is verified by the drop', async () => {
  const bot = columnWorld(83)
  const { ladder, calls } = ladderRig(bot, { escape_descend: (b) => { b.blockAt = (v) => (v.y < 64 ? STONE : AIR); b.entity.position = new Vec3(0.5, 64, 0.5); return { status: 'done' } } })
  const r = await ladder.trigger('confined_trapped')
  assert.equal(calls[0], 'escape_descend'); assert.equal(r.verified, true); assert.equal(r.by, 'escape_descend')
})

test('ladder: a step that failed >= 3 times is skipped for the rest of the sequence, cleared by real movement', async () => {
  const pit = new EventEmitter()
  pit.blockAt = (v) => (v.y < 64 || (v.y >= 64 && v.y < 68 && !(v.x === 0 && v.z === 0)) ? STONE : AIR)
  pit.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }; pit.inventory = { items: () => [] }; pit.registry = { blocksByName: {} }
  const { ladder, calls } = ladderRig(pit, {}, { backoffBaseS: 0 })
  for (let i = 0; i < 3; i++) { await ladder.trigger('confined_trapped'); ladder.reset('progress'); ladder.cooldownUntil = 0 } // the observed case: skill_done resets kept restarting the ladder at nudge
  const before = calls.filter((c) => c === 'unstuck_nudge').length
  assert.ok(ladder.skipped('nudge') && ladder.skipped('move_away') && ladder.skipped('go_home'))
  ladder.cooldownUntil = 0
  await ladder.trigger('confined_trapped')
  assert.equal(calls.filter((c) => c === 'unstuck_nudge').length, before, 'nudge not retried once skipped')
  ladder.reset('moved')
  assert.equal(ladder.skipped('nudge'), false)
})

test('confinedNote: only while elevated; reaches brain events and the mind digest', () => {
  assert.equal(confinedNote(columnWorld(65)), null)
  const n = confinedNote(columnWorld(83))
  assert.match(n.text, /confined on a column at y=84/)
  const bot = columnWorld(83); bot.entities = {}; bot.players = {}; bot.health = 20; bot.food = 20; bot.time = { timeOfDay: 1000, day: 1 }
  const bd = brainDigest(bot, { confined: n })
  assert.ok(bd.events.some((e) => /confined on a column/.test(e)))
  const md = buildDigest({ pos: { x: 0, y: 84, z: 0 }, hp: 20, food: 20, confined: n.text }, { drives: null, now: 1 })
  assert.match(md.confined, /confined on a column/)
})
