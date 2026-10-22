// PVP1: players who hurt her: attribution, facts for S2, memory, bounded responses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { createHurtTracker, describeHurt } from '../src/mindlink/hurtby.js'
import { PeopleBook } from '../src/mindlink/people.js'
import { makeDefend } from '../src/skills/defend.js'
import { validate, SKILLS, normalizeDigest } from '../../brain/contract.js'
import { activityMenu } from '../../brain/menu.js'

function mk({ players = {}, entities = {}, hp = 20 } = {}) {
  const b = new EventEmitter()
  b.username = 'WrenT3'; b.health = hp; b.time = { age: 5 * 24000 }
  b.entity = { position: new Vec3(0, 64, 0), onGround: true }
  b.players = {}; b.entities = {}
  for (const [n, p] of Object.entries(players)) { const e = { type: 'player', username: n, position: new Vec3(...p.pos), height: 1.8, heldItem: p.held ? { name: p.held } : null }; b.players[n] = { username: n, entity: e }; b.entities[100 + Object.keys(b.entities).length] = e }
  for (const [i, m] of Object.entries(entities)) b.entities[i] = { name: m.name, type: m.type ?? 'hostile', position: new Vec3(...m.pos) }
  b.hit = (by, dmg) => { if (by) b.emit('entitySwingArm', b.players[by].entity); b.health -= dmg; b.emit('health') }
  return b
}
const clock = () => { const c = { t: 1_000_000, now: () => c.t }; return c }
const setup = (opts) => { const c = clock(), b = mk(opts), tr = createHurtTracker({ now: c.now }); const got = []; tr.attach(b, (h) => got.push(h)); return { c, b, tr, got } }
process.env.WREN_IGNORE_PLAYERS = '/^WrenT\\d+$/i'.replace('WrenT', 'WrenXX')   // test: WrenT names are NOT ignored here (the rig attacker/victim names are test-only)

test('hurt_by: a swinging player in reach is the attacker; amount and kind are recorded', () => {
  const { b, got } = setup({ players: { Alice: { pos: [2, 64, 0] }, Bob: { pos: [3, 64, 0] } } })
  b.hit('Alice', 3)
  assert.equal(got.length, 1); assert.deepEqual([got[0].who, got[0].kind, got[0].amount], ['Alice', 'player', 3])
})
test('hurt_by: swing by someone out of reach, or long ago, is not attributed; mob / env fallbacks', () => {
  const far = setup({ players: { Far: { pos: [30, 64, 0] } } }); far.b.hit('Far', 2)
  assert.equal(far.got[0].kind, 'env')
  const old = setup({ players: { Old: { pos: [2, 64, 0] } } }); old.b.emit('entitySwingArm', old.b.players.Old.entity); old.c.t += 5000; old.b.hit(null, 2)
  assert.equal(old.got[0].kind, 'env')
  const mob = setup({ entities: { 1: { name: 'zombie', pos: [1, 64, 0] } } }); mob.b.hit(null, 3)
  assert.deepEqual([mob.got[0].who, mob.got[0].kind], ['zombie', 'mob'])
})
test('hurt_by: arrow + a player holding a bow in range -> that player', () => {
  const { b, got } = setup({ players: { Archer: { pos: [20, 64, 0], held: 'bow' } }, entities: { 7: { name: 'arrow', type: 'projectile', pos: [1, 64, 0] } } })
  b.hit(null, 4); assert.deepEqual([got[0].who, got[0].kind, got[0].via], ['Archer', 'player', 'arrow'])
})
test('hurt_by: spare test bots (ignored names) are never attributed as people', () => {
  process.env.WREN_IGNORE_PLAYERS = '/^Ign/i'
  try { const { b, got } = setup({ players: { IgnBot: { pos: [2, 64, 0] } } }); b.hit('IgnBot', 2); assert.equal(got[0].kind, 'env') } finally { process.env.WREN_IGNORE_PLAYERS = '/^WrenXX\\d+$/i' }
})
test('digest lines: facts, ages, per-person history, accidental single hit presented neutrally', () => {
  const dir = new PeopleBook(null, () => 1_000_000)
  const { c, b, tr } = setup({ players: { Alex: { pos: [2, 64, 0] } } })
  for (let i = 0; i < 12; i++) dir.meet('Alex')   // a friend she has talked with
  const hist = (n) => dir.hurtHistory(n, 5)
  b.hit('Alex', 1); dir.hurt('Alex', { amount: 1, day: 5 })
  c.t += 4000
  let d = describeHurt(tr, hist, { now: c.t })
  assert.match(d.lines[0], /^Alex hit you \(−1 hp\) 4 s ago$/)
  assert.match(d.lines[1], /a single hit, and the first time Alex has hurt you; you have talked with Alex 12 time/)
  assert.ok(!/accident|enemy|attack|hostile|trust/i.test(d.lines.join(' ')), 'neutral wording')
  // three more hits
  for (let i = 0; i < 3; i++) { c.t += 400; b.hit('Alex', 2); dir.hurt('Alex', { amount: 2, day: 5 }) }
  c.t += 5000
  d = describeHurt(tr, hist, { now: c.t })
  assert.match(d.lines[0], /^Alex hit you 4 times \(−7 hp in all\) 5 s ago/)
  assert.match(d.lines[1], /the first time Alex has hurt you/)   // all four hits are this one burst
  assert.equal(d.structured[0].hits, 4); assert.equal(d.structured[0].attacking_now, true)   // last hit 5 s ago, inside the 6 s window
  // a person with earlier history: counts and recency, still no verdict
  dir.hurt('Alex', { amount: 2, day: 4 }); dir.hurt('Alex', { amount: 2, day: 5 })
  c.t += 100; b.hit('Alex', 2); dir.hurt('Alex', { amount: 2, day: 5 })
  d = describeHurt(tr, hist, { now: c.t })
  assert.match(d.lines[1], /Alex has hurt you \d+x today and \d+x in all/); assert.equal(d.structured[0].attacking_now, true)
})
test('memory: the hurt is a fact with counts, trust and familiarity are untouched; nearbyLines shows it', () => {
  let t = 0; const p = new PeopleBook(null, () => t)
  p.meet('Ann'); const before = { ...p.get('Ann') }
  t += 1000; p.hurt('Ann', { amount: 3, day: 1, where: 'near home' }); p.hurt('Ann', { amount: 2, day: 1 })
  const r = p.get('Ann'); assert.equal(r.trust, before.trust); assert.equal(r.familiarity, before.familiarity); assert.equal(r.interactions, before.interactions)
  assert.match(p.nearbyLines(['Ann'])[0], /has hurt you 2 time\(s\)/)
  assert.equal(p.hurtHistory('Ann', 1).today, 2); assert.equal(p.hurtHistory('Ann', 2).today, 0)
  // a stranger who hurts first is created without a conversation
  p.hurt('Zed', { amount: 1, day: 1 }); assert.equal(p.get('Zed').interactions, 0)
})
test('S2 vocabulary: defend only for someone who hurt her in the last 10 s; flee from a player is valid', () => {
  assert.ok(SKILLS.defend && SKILLS.flee.args.from.kinds.includes('player'))
  const dg = (hb) => ({ health: 18, food: 18, pos: [0, 64, 0], players: [{ name: 'Cat', dist: 2, pos: [2, 64, 0] }, { name: 'Dan', dist: 3, pos: [3, 64, 0] }], hurt_by: hb })
  const run = (act, args, d) => validate({ errors: [], act, args, speech: 'Stop.' }, d)
  assert.ok(run('defend', { target: 'Cat' }, dg([{ who: 'Cat', kind: 'player', hits: 3, hp: 6, ago_s: 2 }])).ok)
  assert.ok(run('defend', { target: 'Dan' }, dg([{ who: 'Cat', kind: 'player', hits: 3, hp: 6, ago_s: 2 }])).errors.some((e) => e.code === 'defend_not_hurt'))
  assert.ok(run('defend', { target: 'Cat' }, dg([{ who: 'Cat', kind: 'player', hits: 3, hp: 6, ago_s: 40 }])).errors.some((e) => e.code === 'defend_not_attacking'))
  assert.ok(run('flee', { from: 'Cat' }, dg([{ who: 'Cat', kind: 'player', hits: 1, hp: 2, ago_s: 3 }])).ok)
})
test('menu: bounded options appear when a player hurts her; defend is NOT NOW once they stopped; nothing without a hurt', () => {
  const base = { time: { phase: 'day' }, inventory: { cobblestone: 20 }, nearby: [], places: [{ id: 'home', kind: 'home', dist: 60, dir: 'north' }], players: [{ name: 'Cat', dist: 2 }], food: 20, health: 15 }
  const m1 = activityMenu(normalizeDigest({ ...base, hurt_by: [{ who: 'Cat', kind: 'player', hits: 3, hp: 6, ago_s: 2 }] }))
  for (const w of ['tell Cat', 'flee from=Cat', 'defend target=Cat', 'go_home', 'close_doors_nearby', 'dig_in']) assert.ok(m1.includes(w), w + '\n' + m1)
  const m2 = activityMenu(normalizeDigest({ ...base, hurt_by: [{ who: 'Cat', kind: 'player', hits: 3, hp: 6, ago_s: 30 }] }))
  assert.ok(!m2.includes('defend target=Cat') && /NOT NOW:.*defend/.test(m2))
  assert.ok(!/flee from|defend target|tell /.test(activityMenu(normalizeDigest(base))))
})

// ---- defend skill with a fake body
function defendRig({ attackerPos = [2, 64, 0], hp = 20 } = {}) {
  const c = clock(); const b = mk({ players: { Cat: { pos: attackerPos } }, hp })
  const tr = createHurtTracker({ now: () => Date.now() }); tr.attach(b); b.__hurtBy = tr
  b.equip = async () => {}; b.lookAt = async () => {}; b.inventory = { items: () => [] }
  b.swings = 0; b.attack = () => { b.swings++ }
  const ctx = { bot: b, args: { target: 'Cat' }, state: {}, aborted: false, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }
  return { b, ctx, sk: makeDefend() }
}
test('defend: refuses someone who did not hurt her (never attacks first)', () => {
  const { ctx, sk } = defendRig()
  assert.deepEqual(sk.precondition(ctx), { ok: false, reason: 'not_attacking_you' })
})
test('defend: hits back while attacked, ends when the attacker stops (and does not chase)', async () => {
  const { b, ctx, sk } = defendRig()
  b.hit('Cat', 2)
  assert.equal(sk.precondition(ctx), true)
  const p = sk.run(ctx)
  const keep = setInterval(() => b.hit('Cat', 0.5), 1000)   // Cat keeps hitting for ~2.5 s
  await new Promise((r) => setTimeout(r, 2500)); clearInterval(keep)
  const t0 = Date.now(); const res = await p
  assert.equal(res.ok, true); assert.equal(res.note, 'attacker_stopped')
  assert.ok(b.swings >= 2, 'hit back ' + b.swings)
  assert.ok(Date.now() - t0 < 6500 && Date.now() - t0 >= 1500, 'stopped ~5 s after the last hit: ' + (Date.now() - t0))
})
test('defend: attacker out of reach is not chased; low health hands back to body safety', async () => {
  const far = defendRig({ attackerPos: [6, 64, 0] }); far.b.hit('Cat', 1); far.b.players.Cat.entity.position = new Vec3(12, 64, 0)
  assert.equal((await far.sk.run(far.ctx)).note, 'attacker_left_reach'); assert.equal(far.b.swings, 0)
  const low = defendRig({ hp: 5 }); assert.deepEqual(low.sk.precondition(low.ctx), { ok: false, reason: 'low_health' })
})
