// HYG1: near-death episode while sealed in cover at low hp (ladder, pillar_up, stuck monitor).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { StuckMonitor, fullyEnclosed } from '../src/detect/stuck.js'
import { pillarAllowed, planEscape } from '../src/escape/skills.js'

const AIR = { name: 'air', boundingBox: 'empty' }, STONE = { name: 'sandstone', boundingBox: 'block' }


/** sealed 1x1x2 cell at (0,64): walls at y 64,65 and a roof at 66, floor below */
function sealedWorld(health) {
  const bot = new EventEmitter()
  bot.blockAt = (v) => {
    const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z)
    if (y < 64) return STONE
    if (x === 0 && z === 0) return y >= 66 ? STONE : AIR
    return Math.abs(x) <= 1 && Math.abs(z) <= 1 && y <= 66 ? STONE : AIR
  }
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true, yaw: 0 }
  bot.health = health; bot.time = { timeOfDay: 18000 }
  bot.inventory = { items: () => [{ name: 'cobblestone', count: 20, type: 1 }] }
  bot.registry = { blocksByName: { cobblestone: { boundingBox: 'block', transparent: false } } }
  return bot
}

test('pillar_up is not offered under a roof; planEscape does not list it', () => {
  const bot = sealedWorld(4)
  assert.equal(pillarAllowed(bot), false)
  assert.ok(!planEscape(bot).cands.includes('escape_pillar_up'))
})

function monitor(bot) {
  const triggers = []
  const body = { bot, spawned: true }
  const runner = { current: { name: 'eat', skill: { name: 'eat' } }, on() {} }
  const ladder = { busy: false, level: 0, cooldownUntil: 0, trigger: async (r) => { triggers.push(r); return { verified: true } }, reset() {} }
  const lag = { status: () => ({ lagging: false, factor: 1 }), noteDiscontinuity() {} }
  let t = 1e6
  const m = new StuckMonitor({ body, runner, ladder, lag, now: () => t })
  return { m, triggers, step: (s) => { for (let i = 0; i < s; i++) { t += 1000; m.tick() } } }
}

test('hp 4 sealed in cover: a non-stationary skill does not make the stuck monitor dig her out (for 120 s)', () => {
  const bot = sealedWorld(4)
  assert.equal(fullyEnclosed(bot), true)
  const r = monitor(bot)
  r.step(60)
  assert.deepEqual(r.triggers, [], 'no confined_trapped while hurt and walled in')
  r.step(100)   // the hold is bounded: after 120 s a real trap is escaped
  assert.ok(r.triggers.length >= 1)
})

test('healthy and sealed by day: the old behaviour (confined_trapped) is unchanged', () => {
  const bot = sealedWorld(20); bot.time.timeOfDay = 6000
  const r = monitor(bot)
  r.step(60)
  assert.ok(r.triggers.includes('confined_trapped'))
})
