// REC2: body-level recover routine (low hp, food in inventory, sealed cell: eat or cook, then resume).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { Recover, recoverPlan, REC, lifeThreat } from '../src/recover.js'
import { StuckMonitor } from '../src/detect/stuck.js'

const AIR = { name: 'air', boundingBox: 'empty' }, STONE = { name: 'stone', boundingBox: 'block' }
const FOODS = { dried_kelp: { foodPoints: 1, saturation: 0.6 }, cooked_cod: { foodPoints: 5, saturation: 6 }, rotten_flesh: { foodPoints: 4, saturation: 0.8 } }

/** sealed 1x1x2 cell at (0,64) at night, kelp x12 + furnace + coal */
function cell({ hp = 3, food = 9, inv = [['kelp', 12], ['furnace', 1], ['coal', 3]], night = true } = {}) {
  const bot = new EventEmitter()
  bot.blockAt = (v) => {
    const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z)
    if (y < 64) return STONE
    if (x === 0 && z === 0) return y >= 66 ? STONE : AIR
    return Math.abs(x) <= 1 && Math.abs(z) <= 1 && y <= 66 ? STONE : AIR
  }
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  bot.entities = {}
  bot.health = hp; bot.food = food; bot.time = { timeOfDay: night ? 18000 : 6000 }
  const stacks = new Map(inv)
  bot.inventory = { items: () => [...stacks].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: 1 })) }
  bot.stacks = stacks
  bot.registry = { foodsByName: FOODS, blocksByName: { furnace: { id: 61 } } }
  bot.findBlock = () => null
  return bot
}
const t0 = Date.parse('2026-06-15T00:46:20Z')
function mk(bot, extra = {}) {
  let t = t0
  const calls = []
  const runner = {
    run: async (name, args, o) => {
      calls.push(name)
      if (name === 'cook') { const n = Math.min(bot.stacks.get('kelp'), 8); bot.stacks.set('kelp', bot.stacks.get('kelp') - n); bot.stacks.set('dried_kelp', (bot.stacks.get('dried_kelp') ?? 0) + n); return { status: 'done' } }
      if (name === 'eat') {
        const dk = bot.stacks.get('dried_kelp') ?? 0
        if (!dk) return { status: 'rejected', reason: 'no_food' }
        bot.stacks.set('dried_kelp', dk - 1); bot.food = Math.min(20, bot.food + 1); if (bot.food >= 18) bot.health = 10   // regen once food >= 18
        return { status: 'done' }
      }
      return { status: 'done' }
    },
    abort: async () => {},
  }
  const events = []
  const r = new Recover({ getBot: () => bot, runner, arbiter: { owner: null }, trace: { event: (e, d) => events.push([e, d]) }, now: () => t, cfg: { tickMs: 1, ...extra } })
  r.on('event', (x) => events.push(['say', x]))
  return { r, calls, events, adv: (ms) => { t += ms } }
}



test('plan: eat > cook > wait (night) > forage (day)', () => {
  assert.equal(recoverPlan(cell({ inv: [['cooked_cod', 2], ['kelp', 3]] })).kind, 'eat')
  const k = recoverPlan(cell()); assert.deepEqual([k.kind, k.raw, k.cooked, k.count], ['cook', 'kelp', 'dried_kelp', 8])
  assert.equal(recoverPlan(cell({ inv: [['kelp', 12], ['coal', 3]] })).kind, 'wait', 'no furnace and no cobble: wait')
  assert.equal(recoverPlan(cell({ inv: [['kelp', 12], ['coal', 3], ['cobblestone', 9]] })).kind, 'cook', 'cobble for a furnace')
  assert.equal(recoverPlan(cell({ inv: [] })).kind, 'wait')
  assert.equal(recoverPlan(cell({ inv: [], night: false })).kind, 'forage')
  assert.equal(recoverPlan(cell({ food: 19 })).kind, 'wait', 'food >= 18 needs no eating')
  assert.equal(recoverPlan(cell(), { cookBlocked: true }).kind, 'wait')
})

test('trigger needs hp<=6 for >2 min; healthy or hostile-without-cover does not trigger', () => {
  const bot = cell(), { r, adv } = mk(bot)
  assert.equal(r.eligible(bot).run, false); adv(119000); assert.equal(r.eligible(bot).run, false); adv(2000)
  assert.equal(r.eligible(bot).run, true)
  bot.health = 12; assert.equal(r.eligible(bot).run, false); assert.equal(r.lowSince, null)
  // open field with a zombie 8 m away: no recover
  const o = cell(); o.blockAt = () => AIR; o.entities = { 1: { name: 'zombie', position: new Vec3(8.5, 64, 0.5) } }
  const m = mk(o); m.r.eligible(o); m.adv(130000); assert.equal(m.r.eligible(o).why, 'hostile_near_no_cover')
})

test('routine: sealed cell, hp 3, food 9, kelp x12 + furnace + coal -> cooks, eats, hp >= 10; ladder suppressed while it runs, events for S2', async () => {
  const bot = cell(), { r, calls, events, adv } = mk(bot)
  r.eligible(bot); adv(130000)
  let during = null
  const orig = r.runner.run; r.runner.run = async (n, a, o) => { during ??= { sup: r.suppressLadder(), gateHabit: r.gate('gather_stone', { owner: 's1' })?.reason, gateOwn: r.gate('eat', { owner: 's1', intent_id: 'rec2-9-eat' }) }; return orig(n, a, o) }
  await r.tick()
  assert.ok(calls[0] === 'cook' && calls.filter((c) => c === 'eat').length >= 9)
  assert.ok(bot.health >= 10 && bot.food >= 18)
  assert.deepEqual(during, { sup: true, gateHabit: 'busy', gateOwn: null })
  assert.equal(r.active, false); assert.equal(r.suppressLadder(), false)
  const say = events.filter((e) => e[0] === 'say').map((e) => e[1])
  assert.ok(say.some((s) => /^recovering: cooking kelp \(0\/8\)/.test(s)), say.join('|'))
  assert.ok(events.some((e) => e[0] === 'rec2_start') && events.some((e) => e[0] === 'rec2_end' && e[1].end === 'recovered'))
})

test('S2 override: an urgent intent / needs act pauses the routine; non-urgent S2 skills are held', async () => {
  const bot = cell(), { r, calls, adv } = mk(bot)
  r.eligible(bot); adv(130000)
  r.active = true
  assert.equal(r.gate('explore', { owner: 's2' }).reason, 'busy')
  assert.equal(r.gate('flee', { owner: 's2' }), null)
  r.active = false
  assert.equal(r.s2Override(), true)
  assert.equal(r.eligible(bot).why, 's2_override')
  await r.tick(); assert.deepEqual(calls, [])
  adv(100000); assert.equal(r.s2Override(), false)
  r.intents = { current: { intent: { goal: 'explore', urgent: true } } }; assert.equal(r.s2Override(), true)
})

test('ladder suppression: StuckMonitor does not trigger while suppressed, but does for drowning/lava', () => {
  const bot = cell({ hp: 4 }); bot.health = 4
  const triggers = []
  const runner = { current: { name: 'explore', skill: { name: 'explore' } }, on() {} }
  const ladder = { busy: false, level: 0, cooldownUntil: 0, trigger: async (x) => { triggers.push(x); return { verified: false } }, reset() {} }
  const lag = { status: () => ({ lagging: false, factor: 1 }), noteDiscontinuity() {} }
  let t = 1e6
  const m = new StuckMonitor({ body: { bot, spawned: true }, runner, ladder, lag, now: () => t })
  bot.blockAt = (v) => { const y = Math.floor(v.y); return y < 64 ? STONE : AIR }   // open: hold is false, a plain trap/no-progress
  bot.time.timeOfDay = 6000
  let sup = true; m.suppress = () => sup
  for (let i = 0; i < 400; i++) { t += 1000; m.tick() }
  assert.deepEqual(triggers, [])
  sup = false
  for (let i = 0; i < 400; i++) { t += 1000; m.tick() }
  assert.ok(triggers.length >= 1, 'without the routine the ladder runs')
  const b2 = cell(); b2.blockAt = (v) => (Math.floor(v.y) < 64 ? STONE : /^$/.test('') && Math.floor(v.y) === 64 ? { name: 'lava', boundingBox: 'empty' } : AIR)
  assert.equal(lifeThreat(b2), true)
  const b3 = cell(); b3.__suffocating = true; assert.equal(lifeThreat(b3), true)
  assert.equal(lifeThreat(cell()), false)
  const r2 = new Recover({ getBot: () => b2, runner: {}, now: () => 0 }); r2.active = true; assert.equal(r2.suppressLadder(), false, 'lava: ladder allowed')
})

test('REC2b: busy (drowning reflex holds the body) is waited out, not failed; blocked cook rests instead of handing back by day', async () => {
  const bot = cell({ night: false }), { r, calls, adv } = mk(bot)
  r.eligible(bot); adv(130000)
  let n = 0; const orig = r.runner.run
  r.runner.run = async (name, a, o) => (name === 'cook' && n++ < 7 ? { status: 'rejected', reason: 'busy', holder: 'reflex:drowning' } : orig(name, a, o))
  r.cfg.tickMs = 1
  r.cfg.busyMs = 1
  await r.tick()
  assert.ok(n >= 8, 'cook retried after 7 busy rejections'); assert.ok(bot.health >= 10)
  assert.equal(recoverPlan(cell({ night: false }), { cookBlocked: true }).kind, 'wait', 'cook blocked + cookable: rest, no hand-back')
})

test('REC2b: not in cover -> dig_in once before cooking', async () => {
  const bot = cell(); const open = bot.blockAt; bot.blockAt = (v) => (Math.floor(v.x) === 1 && Math.floor(v.y) === 64 && Math.floor(v.z) === 0 ? { name: 'air', boundingBox: 'empty' } : open(v))
  const { r, calls, adv } = mk(bot)
  r.eligible(bot); adv(130000)
  const orig = r.runner.run; r.runner.run = async (n, a, o) => { if (n === 'dig_in') { bot.blockAt = open; calls.push(n); return { status: 'done' } } return orig(n, a, o) }
  await r.tick()
  assert.equal(calls[0], 'dig_in'); assert.ok(calls.includes('cook')); assert.ok(bot.health >= 10)
})
