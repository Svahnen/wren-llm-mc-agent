import test from 'node:test'
import assert from 'node:assert/strict'
import { validateEvent } from '../contract.js'
import { buildMessages, buildSystem } from '../prompt.js'

test('VINT: human_speech keeps via/dist/unspoken; typed chat stays unchanged', () => {
  const v = validateEvent({ type: 'human_speech', from: 'Sam', text: 'hi', via: 'voice', dist: 3.14, unspoken: 'and more' })
  assert.ok(v.ok); assert.equal(v.event.via, 'voice'); assert.equal(v.event.dist, 3.1); assert.equal(v.event.unspoken, 'and more')
  const c = validateEvent({ type: 'human_speech', from: 'Sam', text: 'hi' })
  assert.equal(c.event.via, undefined); assert.equal(c.event.dist, undefined)
})

test('VINT: voice prompt asks for short spoken answers and shows the cut-off remainder; system stays personality-free', () => {
  const dg = { time: { day: 1, phase: 'day' }, pos: [0, 64, 0], health: 20, food: 20, energy: 20, needs: {}, inventory: {}, nearby: [], players: [{ name: 'Sam', dist: 3 }], places: [], events: [] }
  const m = buildMessages({ job: { kind: 'human_speech', events: [{ type: 'human_speech', from: 'Sam', text: 'what is up', via: 'voice', dist: 3, unspoken: 'the cave has rooms' }] }, digest: dg })
  const u = m[1].content
  assert.match(u, /\[Sam, 3 m\] "what is up"/); assert.match(u, /cut off.*the cave has rooms/); assert.match(u, /one or two short spoken sentences/)
  assert.match(buildSystem(), /AI with a body/)
})

test('VINT: two speakers stay separate, attributed, closest first; overlap is announced; uuid/ts survive validation', () => {
  const dg = { time: { day: 1, phase: 'day' }, pos: [0, 64, 0], health: 20, food: 20, energy: 20, needs: {}, inventory: {}, nearby: [], players: [{ name: 'Sam', dist: 3 }, { name: 'Anna', dist: 8 }], places: [], events: [] }
  const ev = (from, dist, text, extra = {}) => validateEvent({ type: 'human_speech', from, text, via: 'voice', dist, uuid: 'u-' + from, ts: 1000, ...extra }).event
  const job = { kind: 'human_speech', events: [ev('Anna', 8, 'can you come here', { overlap: ['Anna', 'Sam'] }), ev('Sam', 3, 'what are you doing')] }
  assert.equal(job.events[0].uuid, 'u-Anna'); assert.equal(job.events[0].ts, 1000)
  const u = buildMessages({ job, digest: dg })[1].content
  assert.ok(u.indexOf('[Sam, 3 m] "what are you doing"') < u.indexOf('[Anna, 8 m] "can you come here"'))
  assert.doesNotMatch(u, /what are you doing can you come/)
  assert.match(u, /Anna and Sam spoke at the same time\. Say who you heard and ask who you should answer/)
  const u2 = buildMessages({ job: { kind: 'human_speech', events: [job.events[0] && ev('Anna', 8, 'hi'), ev('Sam', 3, 'hello')] }, digest: dg })[1].content
  assert.match(u2, /one moment, Anna/)
})
