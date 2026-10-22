import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { DeadStateMonitor } from '../src/detect/deadstate.js'

function mkBot({ empty = 5, light = 15, sky = 15, y = 70, food = 20, items = [] } = {}) {
  return {
    entity: { position: new Vec3(0.5, y, 0.5) },
    inventory: { emptySlotCount: () => empty, items: () => items, slots: [] },
    blockAt: () => ({ light, skyLight: sky }),
    food, time: { timeOfDay: 18000 }, registry: { foodsByName: { bread: {} } },
  }
}
const clock = () => { const c = { t: 1e6, now: () => c.t, adv: (ms) => { c.t += ms } }; return c }

test('dead states: inventory full, no light, hunger without food; emitted once per cooldown, cleared when gone', () => {
  const c = clock(); const seen = []
  let bot = mkBot({ empty: 0, light: 2, sky: 0, food: 3 })
  const m = new DeadStateMonitor({ getBot: () => bot, lag: { status: () => ({ lagging: false }) }, now: c.now, hooks: { onDeadState: (k) => seen.push(k) } })
  m.check()
  assert.deepEqual(seen.sort(), ['hunger_no_food', 'inventory_full', 'no_light'])
  c.adv(5000); m.check()
  assert.equal(seen.length, 3) // cooldown
  c.adv(61000); m.check()
  assert.equal(seen.length, 5) // SURV4: no_light is one episode (flapping suppressed); the others re-emit
  assert.equal(m.counts.no_light_suppressed, 2)
  bot = mkBot({ empty: 3, light: 12, sky: 0, food: 3, items: [{ name: 'bread' }] })
  m.check()
  assert.deepEqual(m.active(), [])
})

test('dead states: disoriented underground needs 90 s without a breadcrumb trail; a trail suppresses it; lag suppresses all', () => {
  const c = clock(); const seen = []
  let trail = null, lagging = false
  const bot = mkBot({ light: 3, sky: 0, y: 30 })
  const m = new DeadStateMonitor({ getBot: () => bot, lag: { status: () => ({ lagging }) }, now: c.now, hooks: { getBreadcrumb: () => trail, onDeadState: (k, d) => seen.push([k, d.needs]) } })
  for (let i = 0; i < 20; i++) { c.adv(5000); m.check() }
  assert.ok(seen.some(([k, n]) => k === 'disoriented_underground' && n === 'trail_empty'))
  const n0 = seen.filter(([k]) => k === 'disoriented_underground').length
  trail = [{}]
  c.adv(61000); m.check()
  assert.equal(seen.filter(([k]) => k === 'disoriented_underground').length, n0)
  lagging = true; seen.length = 0
  c.adv(61000); m.check()
  assert.equal(seen.length, 0)
})
