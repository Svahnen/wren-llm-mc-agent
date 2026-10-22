import test from 'node:test'
import assert from 'node:assert/strict'
import { CycleDetector, VisitCounter, NgramCounter, ChatRepeat, textSimilarity } from '../src/detect/cycle.js'
import { LockoutList, FailureBudget } from '../src/detect/lockout.js'
import { LagMonitor } from '../src/detect/lag.js'

const clock = (t0 = 1e6) => { const c = { t: t0, now: () => c.t, adv: (ms) => { c.t += ms } }; return c }

test('cycle detector: period 2 and 3 found, locked goals listed; diverse and single-goal sequences are not cycles', () => {
  const c = clock()
  const d = new CycleDetector({ now: c.now })
  let hit = null
  for (const [t, p] of [['gather', 'a'], ['sleep', 'home'], ['gather', 'a'], ['sleep', 'home'], ['gather', 'a'], ['sleep', 'home']]) { c.adv(1000); hit = d.record(t, p) ?? hit }
  assert.equal(hit.period, 2)
  assert.deepEqual(hit.keys.sort(), ['gather@a', 'sleep@home'])
  const d3 = new CycleDetector({ now: c.now })
  hit = null
  for (let i = 0; i < 9; i++) hit = d3.record(['x', 'y', 'z'][i % 3], 'p') ?? hit
  assert.equal(hit.period, 3)
  const d4 = new CycleDetector({ now: c.now })
  for (let i = 0; i < 30; i++) assert.equal(d4.record('g' + i, 'p'), null)
  const d5 = new CycleDetector({ now: c.now })
  for (let i = 0; i < 12; i++) assert.equal(d5.record('same', 'p'), null) // repeat counter's job, not a cycle
})

test('cycle detector: period 6 found, outside the 30 min window nothing', () => {
  const c = clock()
  const d = new CycleDetector({ now: c.now })
  let hit = null
  for (let i = 0; i < 18; i++) { c.adv(1000); hit = d.record('g' + (i % 6), 'p') ?? hit }
  assert.equal(hit.period, 6)
  const d2 = new CycleDetector({ now: c.now })
  for (let i = 0; i < 12; i++) { c.adv(11 * 60e3); assert.equal(d2.record(i % 2 ? 'a' : 'b', 'p'), null) } // too slow: window slides
})

test('visit counter: 8 visits to one 3-block cell within an hour flagged once; exempt home not flagged', () => {
  const c = clock()
  const v = new VisitCounter({ now: c.now })
  const A = { x: 10, y: 64, z: 10 }, B = { x: 40, y: 64, z: 40 }
  let hits = 0
  for (let i = 0; i < 10; i++) { c.adv(30e3); if (v.observe(A)) hits++; c.adv(30e3); v.observe(B) }
  assert.equal(hits, 1)
  const v2 = new VisitCounter({ now: c.now }); v2.addExempt(A)
  for (let i = 0; i < 12; i++) { c.adv(30e3); assert.equal(v2.observe(A), null); c.adv(30e3); v2.observe(B) }
  // standing still is one visit
  const v3 = new VisitCounter({ now: c.now })
  for (let i = 0; i < 100; i++) { c.adv(1000); assert.equal(v3.observe(A), null) }
})

test('n-gram counter flags a repeating action trigram, ignores varied actions, entropy sane', () => {
  const n = new NgramCounter({ n: 3, threshold: 5 })
  let hit = null
  for (let i = 0; i < 20; i++) hit = n.push(['a', 'b', 'c'][i % 3]) ?? hit
  assert.ok(hit && hit.count >= 5)
  const m = new NgramCounter({ n: 3, threshold: 5 })
  for (let i = 0; i < 40; i++) assert.equal(m.push('act' + (i * 7919) % 31), null)
  assert.ok(m.entropy() > 3)
})

test('chat repeat: near duplicates flagged, different text not, per player', () => {
  const c = clock()
  const ch = new ChatRepeat({ now: c.now })
  assert.equal(ch.say('Hello there, want to see my house?', 'Sam').repeat, false)
  assert.equal(ch.say('hello there!! want to see my house', 'Sam').repeat, true)
  assert.equal(ch.say('hello there, want to see my house?', 'Ellie').repeat, false) // other player
  assert.equal(ch.say('I found iron near the lake', 'Sam').repeat, false)
  assert.ok(textSimilarity('abc def', 'xyz') < 0.2)
  c.adv(11 * 60e3)
  assert.equal(ch.say('Hello there, want to see my house?', 'Sam').repeat, false) // expired
})

test('lockouts: exact, type-only and place-only matches, expiry, failure budget per (type,place)', () => {
  const c = clock()
  const l = new LockoutList({ now: c.now })
  l.lock({ type: 'gather', place: '1,2', reason: 'cycle' })
  assert.ok(l.isLocked('gather', '1,2'))
  assert.equal(l.isLocked('gather', '3,4'), null)
  l.lock({ place: '9,9', reason: 'visits' })
  assert.ok(l.isLocked('anything', '9,9'))
  l.lock({ type: 'fish', ms: 1000, reason: 'x' })
  assert.ok(l.isLocked('fish', 'q'))
  c.adv(2000)
  assert.equal(l.isLocked('fish', 'q'), null)
  c.adv(31 * 60e3)
  assert.equal(l.list().length, 0)
  const b = new FailureBudget({ lockouts: l, now: c.now, maxFails: 3 })
  b.record('mine', 'p', false); b.record('mine', 'p', false)
  assert.equal(l.isLocked('mine', 'p'), null)
  assert.equal(l.isLocked('mine', 'other'), null)
  b.record('mine', 'p', false)
  assert.ok(l.isLocked('mine', 'p'))
  assert.equal(l.isLocked('mine', 'other'), null) // per (type, place), not per type
  b.record('mine', 'q', false); b.record('mine', 'q', true); b.record('mine', 'q', false); b.record('mine', 'q', false)
  assert.equal(l.isLocked('mine', 'q'), null) // success resets the count
})

test('lag monitor: tps 5 detected, silence detected, discontinuity grace, recovery after grace', () => {
  const c = clock()
  const lag = new LagMonitor({ now: c.now, graceMs: 3000 })
  lag.notePacket(c.t)
  for (let i = 0; i < 4; i++) { c.adv(1000); lag.noteTimeUpdate(i * 20, c.t) } // 20 tps
  assert.equal(lag.status().lagging, false)
  for (let i = 0; i < 4; i++) { c.adv(4000); lag.noteTimeUpdate(80 + i * 20, c.t) } // tick rate 5
  let s = lag.status()
  assert.ok(s.lagging && s.reasons.includes('tps') && s.factor > 2.5, JSON.stringify(s))
  for (let i = 0; i < 4; i++) { c.adv(1000); lag.noteTimeUpdate(160 + i * 20, c.t) }
  c.adv(3500)
  lag.noteTimeUpdate(290, c.t)
  s = lag.status()
  assert.equal(s.lagging, false, JSON.stringify(s))
  c.adv(3100) // connection stall / late time updates
  assert.ok(lag.status().reasons.includes('silence') && lag.status().reasons.includes('time_updates_late'))
  lag.noteTimeUpdate(350, c.t)
  lag.noteDiscontinuity('teleport')
  assert.ok(lag.status().reasons.includes('discontinuity'))
})
