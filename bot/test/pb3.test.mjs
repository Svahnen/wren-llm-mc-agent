// PB3: test bots are not people; get_food failure -> clear result, cooldown, no identical retry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isIgnoredPlayer, humansOnly } from '../src/ignore-players.js'
import { PeopleBook } from '../src/mindlink/people.js'
import { createPlaybookEngine } from '../src/playbooks/engine.js'
import { Landmarks } from '../src/skills/landmarks.js'
import { PRED } from '../src/playbooks/predicates.js'
import { brainDigest } from '../src/mindlink/digest.js'

const vec = (x, y, z) => ({ x, y, z, offset: (a, b, c) => vec(x + a, y + b, z + c), distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z) } })

test('ignore list: WrenT<n> only, configurable by env spec', () => {
  for (const n of ['WrenT1', 'WrenT2', 'wrent12']) assert.equal(isIgnoredPlayer(n), true, n)
  for (const n of ['Sam', 'Wren', 'WrenTx', 'WrenT', 'Steve']) assert.equal(isIgnoredPlayer(n), false, n)
  assert.equal(isIgnoredPlayer('Bob', 'Bob,/^Test/'), true); assert.equal(isIgnoredPlayer('TestX', 'Bob,/^Test/'), true); assert.equal(isIgnoredPlayer('Sam', 'Bob'), false)
  assert.deepEqual(humansOnly(['Sam', 'WrenT2', { username: 'WrenT3' }, { name: 'Ann' }]), ['Sam', { name: 'Ann' }])
})
test('people memory never records test bots', () => {
  const pb = new PeopleBook(null)
  const r = pb.meet('WrenT2', { topic: 'hi' }); assert.equal(r.ignored, true); assert.equal(pb.get('WrenT2'), null); assert.deepEqual(pb.nearbyLines(['WrenT2']), [])
  assert.ok(pb.meet('Sam', {}).rec)
})
test('predicates: a test bot is never an online person', () => {
  const bot = { username: 'Wren', players: { WrenT2: { username: 'WrenT2', entity: { position: vec(1, 64, 1) } }, Sam: { username: 'Sam' } }, entity: { position: vec(0, 64, 0) } }
  assert.equal(PRED.person_online({ bot }, 'WrenT2'), false); assert.equal(PRED.person_online({ bot }, 'Sam'), true)
})
test('digest players list leaves test bots out', () => {
  const bot = { username: 'Wren', entity: { position: vec(0, 64, 0), yaw: 0, pitch: 0 }, players: { Wren: { username: 'Wren' }, WrenT2: { username: 'WrenT2', entity: { position: vec(3, 64, 0) } }, Sam: { username: 'Sam', entity: { position: vec(5, 64, 0) } } }, entities: {}, inventory: { items: () => [] }, time: { timeOfDay: 1000, age: 1000, day: 1 }, food: 20, health: 20, registry: { blocksByName: {} }, game: {} }
  let d; try { d = brainDigest(bot, { landmarks: { list: () => [] }, chat: [], events: [] }) } catch (e) { assert.fail("digest threw: " + e.stack) }
  assert.deepEqual(d.players.map((p) => p.name), ['Sam'])
})

function rig(t0 = { v: 1_000_000 }, pos = { x: 0, z: 0 }) {
  const bot = { username: 'Wren', health: 20, food: 15, entity: { position: { get x() { return pos.x }, y: 64, get z() { return pos.z }, offset() { return this }, distanceTo(o) { return Math.hypot(pos.x - o.x, pos.z - o.z) } }, onGround: true }, entities: {}, players: {}, thunderState: 0,
    inventory: { items: () => [], emptySlotCount: () => 20 }, registry: { foodsByName: {}, blocksByName: {} } }
  const calls = []
  const env = { landmarks: new Landmarks(), foodSeen: new Map() }
  const runSkill = async (name, args) => { calls.push(name); return { ms: 1, status: name === 'explore' ? 'done' : 'failed', reason: name === 'explore' ? 'ok' : 'nothing' } }
  const eng = createPlaybookEngine({ getBot: () => bot, runSkill, env, now: () => t0.v, sleep: async () => {}, notify: () => {} })
  return { eng, calls, t0, pos, bot }
}
test('get_food with nothing to find: clear result + hint, then cooldown at the same place, expires, and moving away lifts it', async () => {
  const R = rig()
  const ended = []
  const st = R.eng.start('get_food', {}, { onEnd: (e) => ended.push(e) }); assert.ok(st.ok)
  const out = await st.promise
  assert.notEqual(out.status, 'done')
  assert.ok(R.calls.filter((c) => c === 'explore').length >= 1, 'explores before giving up')
  assert.equal(out.reason, 'no_food_found')
  assert.match(ended[0].hint, /no food within \d+ m/); assert.match(ended[0].hint, /Next: .*explore_and_return/)
  const cd = R.eng.cooldowns(); assert.equal(cd.length, 1); assert.match(cd[0].line, /^tried get_food here \d+ s ago: no food within \d+ m$/)
  const again = R.eng.start('get_food', {}); assert.equal(again.ok, false); assert.equal(again.cooldown, true); assert.match(again.errors[0], /tried get_food here/)
  R.pos.x = 100; assert.equal(R.eng.cooldowns().length, 0); assert.ok(R.eng.start('get_food', {}).ok); await R.eng.current()?.promise
  R.pos.x = 0; R.t0.v += 130_000; assert.equal(R.eng.cooldowns().length, 0)
})
