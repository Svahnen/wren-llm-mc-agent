import test from 'node:test'
import assert from 'node:assert/strict'
import { SKILL_NAMES, SKILLS, validateArgs } from '../src/skills/schema.js'
import { registerSkills } from '../src/skills/index.js'
import { makeRig } from './helpers.js'
import { Landmarks, Trail } from '../src/skills/landmarks.js'
import { standableY, isStandable, openSky } from '../src/skills/lib.js'
import { sampleTargets } from '../src/skills/wander.js'
import { Heatmap } from '../src/heatmap.js'
import { makeRng } from '../src/util.js'
import { surplus, JUNK } from '../src/skills/inventory.js'

test('registry: every skills.json entry is implemented, with contract fields', () => {
  const { runner } = makeRig()
  const pack = registerSkills(runner, { seed: 1 })
  assert.deepEqual([...pack.names].sort(), [...SKILL_NAMES].sort())
  for (const n of SKILL_NAMES) {
    const s = runner.skills.get(n)
    assert.equal(typeof s.run, 'function', n)
    assert.equal(typeof s.progress_fn, 'function', n)
    assert.ok(s.max_s > 0, n)
    assert.equal(s.max_s, SKILLS[n].max_s, `${n}: registry max_s equals implementation`)
    assert.ok(SKILLS[n].desc && SKILLS[n].category, n)
  }
})

test('validateArgs: defaults, ranges, enums, unknown args, unknown skill', () => {
  assert.deepEqual(validateArgs('gather_wood', {}), { ok: true, args: { count: 4 } })
  assert.equal(validateArgs('gather_wood', { count: 99 }).ok, false)
  assert.equal(validateArgs('gather_wood', { count: 2.5 }).ok, false)
  assert.equal(validateArgs('gather_wood', { cnt: 2 }).ok, false)
  assert.equal(validateArgs('craft', { item: 'diamond_sword' }).ok, false)
  assert.equal(validateArgs('craft', {}).ok, false)
  assert.deepEqual(validateArgs('craft', { item: 'torch' }), { ok: true, args: { item: 'torch', count: 1 } })
  assert.equal(validateArgs('move_to', { x: 1, y: 2 }).ok, false)
  assert.equal(validateArgs('move_to', { x: 1, y: 2, z: 3 }).ok, true)
  assert.equal(validateArgs('follow', { target: 'x; rm -rf' }).ok, false)
  assert.equal(validateArgs('follow', { target: 'Alex' }).ok, true)
  const u = validateArgs('teleport', {})
  assert.equal(u.ok, false); assert.ok(u.valid.includes('wander'))
  assert.equal(validateArgs('wander', null).ok, false)
})

test('brain/contract.js vocabulary names that we implement use the same arg names', async () => {
  const { SKILLS: C } = await import('../../brain/contract.js')
  for (const [n, spec] of Object.entries(C)) {
    if (!SKILLS[n]) continue
    for (const a of Object.keys(spec.args)) assert.ok(a in SKILLS[n].args, `${n}.${a} missing in skills.json`)
  }
})

// ---- mock world
function world(cells) { // cells: fn(x,y,z)->name
  const blk = (name) => ({ name, boundingBox: ['air', 'water', 'lava', 'short_grass'].includes(name) ? 'empty' : 'block' })
  return { blockAt: (p) => { const n = cells(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return n === null ? null : blk(n) }, entity: { position: { x: 0, y: 64, z: 0 } } }
}
test('isStandable / standableY: floor, 2 air, no liquid, no unloaded', () => {
  const w = world((x, y, z) => (x === 5 && z === 5 ? (y < 60 ? 'stone' : 'air') : x === 6 ? (y < 63 ? 'stone' : y === 63 ? 'lava' : 'air') : x === 7 ? (y < 64 ? 'stone' : y === 65 ? 'stone' : 'air') : x === 8 ? null : (y < 64 ? 'stone' : 'air')))
  assert.equal(standableY(w, 0, 0, 64), 64)
  assert.equal(standableY(w, 5, 5, 64), 60)        // floor lower than hint, found by scanning down
  assert.equal(isStandable(w, 6, 64, 0), false)   // lava floor
  assert.equal(isStandable(w, 7, 64, 0), false)    // ceiling at head height
  assert.equal(standableY(w, 8, 0, 64), null)      // unloaded column
  const lava = world((x, y) => (y < 64 ? (y === 63 ? 'lava' : 'stone') : 'air'))
  assert.equal(isStandable(lava, 1, 64, 1), false)
  const water = world((x, y) => (y < 64 ? 'stone' : y === 64 ? 'water' : 'air'))
  assert.equal(isStandable(water, 1, 64, 1), false)
})

test('sampleTargets: only standable columns, novelty-biased', () => {
  const w = world((x, y) => (x > 0 ? (y < 64 ? 'stone' : 'air') : (y < 64 ? 'stone' : y === 64 ? 'water' : 'air'))) // west = water
  const rng = makeRng(3)
  const heatmap = new Heatmap({ cell: 8, rng })
  const env = { rng, heatmap, costAt: null }
  const c = sampleTargets(w, env, { radius: 40, minDist: 6, samples: 200 })
  assert.ok(c.length > 20)
  assert.ok(c.every((t) => t.x > 0), 'no water-column targets')
  // saturate the northern half (z<0) -> best candidates are south
  for (let x = 0; x < 80; x += 4) for (let z = -80; z < 0; z += 4) for (let k = 0; k < 5; k++) heatmap.visit(x, z)
  const c2 = sampleTargets(w, env, { radius: 40, minDist: 6, samples: 200 })
  assert.ok(c2.slice(0, 20).filter((t) => t.z > 0).length >= 18)
  // costAt (mind/ danger zones) pushes candidates away
  env.costAt = (p) => (p.z > 0 ? 500 : 0)
  const c3 = sampleTargets(w, env, { radius: 40, minDist: 6, samples: 200 })
  assert.ok(c3[0].z < 1)
})

test('openSky and Trail/Landmarks', () => {
  const w = world((x, y) => (y < 60 ? 'stone' : y === 70 && x === 1 ? 'stone' : 'air'))
  assert.equal(openSky(w, { x: 0, y: 61, z: 0 }), true)
  assert.equal(openSky(w, { x: 1, y: 61, z: 0 }), false)
  const t = new Trail({ step: 8, max: 5 })
  assert.equal(t.record({ x: 0, y: 0, z: 0 }), true)
  assert.equal(t.record({ x: 3, y: 0, z: 0 }), false)
  assert.equal(t.record({ x: 9, y: 0, z: 0 }, false), false)
  for (let i = 1; i <= 8; i++) t.record({ x: i * 10, y: 0, z: 0 })
  assert.equal(t.length, 5)
  assert.equal(t.reversed()[0].x, 80)
  const l = new Landmarks()
  l.set('home', { x: 1.04, y: 2, z: 3 }, 'home'); l.set('bed', { x: 5, y: 2, z: 3 }, 'bed')
  assert.equal(l.home.x, 1)
  assert.equal(l.nearest('bed', { x: 0, y: 0, z: 0 }).id, 'bed')
})

test('surplus: junk and capped stacks only', () => {
  const mk = (name, count) => ({ name, count })
  const bot = { inventory: { items: () => [mk('gravel', 30), mk('cobblestone', 100), mk('bread', 5), mk('oak_log', 10), mk('iron_pickaxe', 1), mk('rotten_flesh', 4), mk('dirt', 20)] } }
  const s = Object.fromEntries(surplus(bot).map((x) => [x.name, x.count]))
  assert.deepEqual(s, { gravel: 30, cobblestone: 36, rotten_flesh: 4 })
  assert.ok(!JUNK.has('bread') && !JUNK.has('iron_pickaxe'))
})
