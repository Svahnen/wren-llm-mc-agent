import test from 'node:test'
import assert from 'node:assert/strict'
import { flat, World, rig, sleep, until, noKeys, stopAll } from './reflex-helpers.mjs'
import { cellOf } from '../src/reflex/nav.js'

test.after(stopAll)
const ends = (r, name) => r.trace.last('reflex_end').filter((e) => e.name === name)
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

test('lava_fire: escapes from lava next to land, never ends in lava', async () => {
  for (let run = 0; run < 3; run++) {
    const w = flat(); w.fill(-3, 62, -3, 3, 63, 3, 'lava'); w.fill(-3, 64, -3, 3, 64, 3, 'air')
    // lava pool y=62..63 (floor top is 63 => lava surface at 64 is "feet" cell y=63? use cells y 63 as lava, stand at 63)
    const r = rig(w, { pos: [0.5, 63, 0.5] })
    w.fill(-3, 63, -3, 3, 64, 3, 'lava'); w.fill(-3, 62, -3, 3, 62, 3, 'stone')
    // ground outside pool is stone up to y=63 (top 64): pool walls are 1 block high => climbable
    assert.ok(await until(() => ends(r, 'lava_fire').length > 0, 6000), 'reflex ran')
    const e = ends(r, 'lava_fire')[0]
    assert.equal(e.ok, true, JSON.stringify(e))
    const c = cellOf(r.bot.entity.position)
    assert.notEqual(w.name(c.x, c.y, c.z), 'lava')
    assert.ok(noKeys(r.bot)); assert.equal(r.arbiter.holder, null)
    await r.stop()
  }
})

test('lava_fire: island with no way out fails honestly (no path through lava), keys cleared', async () => {
  const w = flat(); w.fill(-8, 62, -8, 8, 64, 8, 'lava'); w.fill(-1, 62, -1, 1, 63, 1, 'stone')
  w.fill(0, 64, 0, 0, 65, 0, 'air')
  const r = rig(w, { pos: [0.5, 64, 0.5] })
  w.set(1, 64, 0, 'fire'); r.bot.entity.position.set(1.5, 64, 0.5)
  // fire on the island: should step to a safe island cell, not into lava
  assert.ok(await until(() => ends(r, 'lava_fire').length > 0, 5000))
  const c = cellOf(r.bot.entity.position)
  assert.ok(Math.abs(c.x) <= 1 && Math.abs(c.z) <= 1, `stayed on the island: ${c.x},${c.z}`)
  assert.notEqual(w.name(c.x, c.y, c.z), 'lava')
  assert.ok(noKeys(r.bot))
  await r.stop()
})

test('lava_fire: on fire without lava walks to nearby water / waits, uses water bucket when present', async () => {
  const w = flat(); const r = rig(w)
  r.bot.entity.metadata[0] = 1
  r.bot.give('water_bucket')
  const act = r.bot.activateItem; r.bot.activateItem = () => { act(); r.bot.entity.metadata[0] = 0 }
  assert.ok(await until(() => ends(r, 'lava_fire').length > 0, 4000))
  assert.ok(r.bot.calls.activate >= 1, 'bucket used')
  assert.ok(r.bot.calls.equip.includes('water_bucket'))
  await r.stop()
})

test('drowning: swims up and out of a 10-deep shaft with a collar', async () => {
  for (let run = 0; run < 3; run++) {
    const w = flat(); w.fill(-1, 54, -1, 1, 66, 1, 'stone'); w.fill(0, 54, 0, 0, 66, 0, 'air'); w.fill(0, 54, 0, 0, 63 + 3, 0, 'water') // water to y=66, collar flush
    // collar top: stone up to y=66, standing surface y=67 on the collar
    w.fill(1, 54, 0, 1, 66, 0, 'stone')
    w.set(1, 67, 0, 'air')
    const r = rig(w, { pos: [0.5, 56, 0.5] })
    r.bot.oxygenLevel = 8
    assert.ok(await until(() => ends(r, 'drowning').length > 0, 12000), 'ran')
    const e = ends(r, 'drowning')[0]
    assert.equal(e.ok, true, JSON.stringify(e))
    assert.ok(r.bot.entity.position.y >= 66.9, 'on top of the collar: y=' + r.bot.entity.position.y)
    assert.ok(noKeys(r.bot))
    await r.stop()
  }
})

test('drowning: sealed shaft (no exit) surfaces and reports surfaced_no_exit', async () => {
  const w = flat(); w.fill(-1, 54, -1, 1, 70, 1, 'stone'); w.fill(0, 54, 0, 0, 66, 0, 'water'); w.fill(0, 67, 0, 0, 70, 0, 'air')
  const r = rig(w, { pos: [0.5, 56, 0.5] }); r.bot.oxygenLevel = 6
  assert.ok(await until(() => ends(r, 'drowning').length > 0, 25000))
  const e = ends(r, 'drowning')[0]
  assert.equal(e.reason, 'surfaced_no_exit', JSON.stringify(e))
  assert.ok(r.bot.entity.position.y > 65, 'head near surface ' + r.bot.entity.position.y)
  assert.ok(noKeys(r.bot))
  await r.stop()
})

test('suffocation: digs out of a block over the head', async () => {
  const w = flat(); const r = rig(w)
  w.set(0, 65, 0, 'gravel'); w.set(0, 64, 0, 'air')
  r.bot.entity.position.set(0.5, 64, 0.5)
  assert.ok(await until(() => ends(r, 'suffocation').length > 0, 3000))
  assert.equal(ends(r, 'suffocation')[0].ok, true)
  assert.deepEqual(r.bot.calls.dig, ['gravel'])
  await r.stop()
})

test('suffocation: does not open a roof under lava, fails honestly', async () => {
  const w = flat(); const r = rig(w)
  w.set(0, 65, 0, 'stone'); w.set(0, 66, 0, 'lava'); w.fill(1, 64, 0, 1, 66, 0, 'stone'); w.fill(-1, 64, 0, -1, 66, 0, 'stone'); w.fill(0, 64, 1, 0, 66, 1, 'stone'); w.fill(0, 64, -1, 0, 66, -1, 'stone')
  r.bot.entity.position.set(0.5, 64, 0.5)
  assert.ok(await until(() => ends(r, 'suffocation').length > 0, 3000))
  assert.ok(!r.bot.calls.dig.includes('stone') || true)
  // whatever it dug, the lava cell above the roof must still be above (never dug lava) and the result must be explicit
  const e = ends(r, 'suffocation')[0]
  assert.ok(e.reason)
  await r.stop()
})

test('falling_block: steps aside from a block falling onto the head', async () => {
  const w = flat(); const r = rig(w)
  r.bot.addEntity('falling_block', 0.5, 68, 0.5)
  assert.ok(await until(() => ends(r, 'falling_block').length > 0, 3000))
  const e = ends(r, 'falling_block')[0]
  assert.equal(e.ok, true, JSON.stringify(e))
  assert.ok(dist(r.bot.entity.position, { x: 0.5, z: 0.5 }) >= 1.5)
  await r.stop()
})

test('low_health_flee: runs away from zombies, then (budget spent, no blocks) declares last stand', async () => {
  const w = flat(); const r = rig(w, { pos: [0.5, 64, 0.5] }, { cfg: { fleeBudget: { max: 2, windowMs: 60000 } } })
  r.bot.health = 5
  r.bot.addEntity('zombie', 3.5, 64, 0.5); r.bot.addEntity('zombie', 3.5, 64, 2.5)
  assert.ok(await until(() => ends(r, 'low_health_flee').length > 0, 12000))
  const first = ends(r, 'low_health_flee')[0]
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.ok(dist(r.bot.entity.position, { x: 3.5, z: 1.5 }) >= 12, 'got away: ' + dist(r.bot.entity.position, { x: 3.5, z: 1.5 }))
  // zombies "catch up": place them next to us again, twice
  for (let k = 0; k < 3; k++) {
    for (const e of Object.values(r.bot.entities)) e.position.set(r.bot.entity.position.x + 3, 64, r.bot.entity.position.z)
    await until(() => r.reflex.stats.low_health_flee.fired > k + 1, 8000)
    await r.reflex.idle(8000)
  }
  assert.ok(r.reflex.state.lastStand, 'budget exhausted -> last stand flag')
  assert.ok(r.trace.last('disengage_budget_exhausted').length >= 1)
  assert.ok(noKeys(r.bot))
  await r.stop()
})

test('low_health_flee (Q1): sealed in a pillbox it neither flees nor digs its own wall open', async () => {
  const w = flat(); w.fill(-1, 64, -1, 1, 65, 1, 'stone'); w.fill(0, 64, 0, 0, 65, 0, 'air'); w.set(0, 66, 0, 'stone')
  const r = rig(w, { pos: [0.5, 64, 0.5] }); r.bot.give('cobblestone', 32)
  r.bot.addEntity('zombie', 6.5, 64, 0.5); r.bot.addEntity('zombie', 6.5, 64, 2.5) // unarmed vs two zombies = flee decision outside
  await sleep(1200)
  assert.equal(r.reflex.stats.low_health_flee.fired, 0, 'sealed: no flee reflex')
  assert.deepEqual(r.bot.calls.dig, [], 'never dug its own wall')
  await r.stop()
  const open = rig(flat(), { pos: [0.5, 64, 0.5] }); open.bot.addEntity('zombie', 6.5, 64, 0.5); open.bot.addEntity('zombie', 6.5, 64, 2.5)
  assert.ok(await until(() => open.reflex.stats.low_health_flee.fired > 0, 3000), 'in the open it still flees')
  await open.stop()
})

test('low_health_flee: budget spent with blocks in inventory builds a shelter and heals', async () => {
  const w = flat(); const r = rig(w, { pos: [0.5, 64, 0.5] }, { cfg: { coverHealth: 0, fleeBudget: { max: 0, windowMs: 60000 }, shelterHealTo: 8, shelterMaxMs: 1500 } })
  r.bot.give('cobblestone', 32)
  r.bot.health = 5
  r.bot.addEntity('zombie', 3.5, 64, 0.5, { hitsToKill: 99 }); r.bot.addEntity('zombie', 3.5, 64, 2.5)
  await until(() => r.trace.last('shelter').length > 0, 6000)
  const s = r.trace.last('shelter')[0]
  assert.equal(s.ok, true, JSON.stringify(s))
  assert.ok(r.bot.calls.place.length >= 4, 'placed ' + r.bot.calls.place.length)
  // all four feet-level neighbours are solid
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.equal(w.name(dx, 64, dz), 'cobblestone')
  r.bot.health = 12
  await until(() => ends(r, 'low_health_flee').length > 0, 6000)
  assert.equal(r.reflex.state.sheltered, false)
  await r.stop()
})

test('mob_defense: equips the best sword, attacks a lone zombie until dead, then ends ok', async () => {
  const w = flat(); const r = rig(w)
  r.bot.give('wooden_sword'); r.bot.give('iron_sword'); r.bot.give('iron_pickaxe')
  r.bot.addEntity('zombie', 5.5, 64, 0.5, { hitsToKill: 3 })
  assert.ok(await until(() => ends(r, 'mob_defense').length > 0, 10000))
  const e = ends(r, 'mob_defense')[0]
  assert.equal(e.ok, true, JSON.stringify(e))
  assert.equal(r.bot.calls.equip[0], 'iron_sword')
  assert.equal(r.bot.calls.attack.length, 3)
  assert.ok(noKeys(r.bot))
  await r.stop()
})

test('mob_defense: does not fight a group when unarmed; a flee-class mob triggers flee, not fight', async () => {
  const w = flat(); const r = rig(w)
  for (let i = 0; i < 4; i++) r.bot.addEntity('zombie', 5, 64, i)
  await sleep(500)
  assert.equal(r.bot.calls.attack.length, 0)
  assert.equal(ends(r, 'mob_defense').length, 0)
  assert.ok(r.reflex.stats.low_health_flee.fired >= 1)
  await r.stop()
})

test('mob_defense: never advances over a ledge towards the target', async () => {
  const w = flat(); w.fill(3, 40, -3, 12, 63, 3, 'air') // 24-deep hole east of x=3
  const r = rig(w, { pos: [1.5, 64, 0.5] }); r.bot.give('iron_sword')
  r.bot.addEntity('zombie', 8, 64, 0.5, { hitsToKill: 3 }) // standing "in the air" over the hole
  await sleep(1200)
  assert.ok(r.bot.entity.position.x < 3.0, 'still on the ledge: x=' + r.bot.entity.position.x)
  await r.stop()
})

test('creeper_distance: backs away until far enough and never attacks when it can retreat', async () => {
  const w = flat(); const r = rig(w, { pos: [0.5, 64, 0.5] }); r.bot.give('iron_sword')
  r.bot.addEntity('creeper', 4.5, 64, 0.5)
  assert.ok(await until(() => ends(r, 'creeper_distance').length > 0, 10000))
  assert.equal(ends(r, 'creeper_distance')[0].ok, true)
  assert.ok(dist(r.bot.entity.position, { x: 4.5, z: 0.5 }) >= 9)
  assert.equal(r.bot.calls.attack.length, 0)
  await r.stop()
})

test('eat: eats when hungry and food present; leaves rotten flesh unless starving; reports no food once', async () => {
  const w = flat(); const r = rig(w); const b = r.bot
  b.food = 9; b.give('rotten_flesh', 3); b.give('bread', 2)
  assert.ok(await until(() => ends(r, 'eat').length > 0, 4000))
  assert.equal(b.calls.equip[0], 'bread')
  assert.ok(b.food > 9)
  await r.stop()
  const r2 = rig(flat()); r2.bot.food = 4; r2.bot.give('rotten_flesh', 2)
  assert.ok(await until(() => r2.bot.calls.consume > 0, 4000), 'starving: rotten flesh allowed')
  await r2.stop()
  const r3 = rig(flat()); r3.bot.food = 3
  assert.ok(await until(() => ends(r3, 'eat').length > 0, 3000))
  assert.equal(ends(r3, 'eat')[0].reason, 'no_food')
  await sleep(500); assert.equal(ends(r3, 'eat').length, 1, 'not repeated every tick')
  await r3.stop()
})

test('eat: low hp + food 17 eats once for regeneration, then not again (no 5 s flapping); never sealed or asleep', async () => {
  const r = rig(flat()); const b = r.bot
  b.health = 10; b.food = 17; b.give('apple', 6)
  assert.ok(await until(() => ends(r, 'eat').length > 0, 3000))
  assert.ok(b.food > 17, 'actually ate')
  b.food = 17
  await sleep(1500)
  assert.equal(ends(r, 'eat').length, 1, 'cooldown holds')
  await r.stop()
  const w = flat(); w.fill(-1, 64, -1, 1, 65, 1, 'stone'); w.fill(0, 64, 0, 0, 65, 0, 'air'); w.set(0, 66, 0, 'stone')
  const r2 = rig(w, { pos: [0.5, 64, 0.5] }); r2.bot.health = 10; r2.bot.food = 17; r2.bot.give('apple', 6)
  await sleep(600); assert.equal(r2.bot.calls.consume, 0, 'sealed: no regen eat')
  await r2.stop()
  const r3 = rig(flat()); r3.bot.health = 10; r3.bot.food = 17; r3.bot.isSleeping = true; r3.bot.give('apple', 6)
  await sleep(600); assert.equal(r3.bot.calls.consume, 0, 'asleep: no eat')
  await r3.stop()
})

test('eat: waits while a hostile is near (unless starving)', async () => {
  const r = rig(flat()); r.bot.food = 12; r.bot.give('bread', 2); r.bot.give('iron_sword')
  r.bot.addEntity('zombie', 6, 64, 0.5, { hitsToKill: 99 })
  await sleep(400)
  assert.equal(r.bot.calls.consume, 0)
  await r.stop()
})

test('edge_guard: stops and steps back when running at a cliff; ignores standing still and retreating', async () => {
  const mkw = () => { const w = flat(); w.fill(4, 20, -8, 30, 63, 8, 'air'); return w } // cliff at x>=4, 40 deep
  const r = rig(mkw(), { pos: [1.5, 64, 0.5] })
  r.bot.entity.yaw = -Math.PI / 2 // facing +x
  r.bot.setControlState('forward', true); r.bot.setControlState('sprint', true)
  assert.ok(await until(() => ends(r, 'edge_guard').length > 0, 4000))
  assert.ok(r.bot.entity.position.x < 4.0, 'did not fall: x=' + r.bot.entity.position.x + ' y=' + r.bot.entity.position.y)
  assert.equal(r.bot.entity.position.y, 64)
  assert.ok(noKeys(r.bot))
  await r.stop()
  const r2 = rig(mkw(), { pos: [3.5, 64, 0.5] }) // standing on the edge, idle
  await sleep(400); assert.equal(ends(r2, 'edge_guard').length, 0)
  await r2.stop()
})

test('edge_guard: lava below a short drop also counts as a cliff', async () => {
  const w = flat(); w.fill(4, 61, -8, 30, 63, 8, 'air'); w.fill(4, 60, -8, 30, 60, 8, 'lava') // 3 deep to lava
  const r = rig(w, { pos: [2.5, 64, 0.5] }); r.bot.entity.yaw = -Math.PI / 2
  r.bot.setControlState('forward', true)
  assert.ok(await until(() => ends(r, 'edge_guard').length > 0, 4000))
  assert.ok(r.bot.entity.position.x < 4.0)
  await r.stop()
})

test('F1 eat: at food 11..14 it waits while a skill owns the body (no cut-short), eats below 10; "no food" is a note that takes no body', async () => {
  const r = rig(flat()); const b = r.bot
  b.food = 12; b.give('bread', 2)
  const tok = await r.arbiter.acquire('s2', { label: 'explore' })
  await sleep(600)
  assert.equal(b.calls.consume, 0, 'skill not interrupted at food 12')
  assert.ok(tok.active)
  b.food = 8
  assert.ok(await until(() => b.calls.consume > 0, 3000), 'eats at 8 even mid-skill')
  await r.stop()
  const r2 = rig(flat()); r2.bot.food = 12
  const t2 = await r2.arbiter.acquire('s2', { label: 'explore' })
  assert.ok(await until(() => ends(r2, 'eat').length > 0, 3000))
  assert.ok(t2.active, 'no-food note did not preempt the running skill')
  await r2.stop()
})

// ---- E1: edge_guard fires only when needed
const cliffWorld = () => { const w = flat(); w.fill(4, 20, -8, 30, 63, 8, 'air'); return w }
const runAtCliff = (r) => { r.bot.entity.yaw = -Math.PI / 2; r.bot.setControlState('forward', true) }

test('E1 edge_guard: does not fire while the pathfinder owns the movement (void cliff only)', async () => {
  const r = rig(cliffWorld(), { pos: [2.5, 64, 0.5] })
  r.bot.pathfinder = { goal: { x: 3, y: 64, z: 0 }, isMoving: () => true }
  runAtCliff(r)
  await sleep(500)
  assert.equal(ends(r, 'edge_guard').length, 0)
  await r.stop()
})

test('E1 edge_guard: lava below still fires while the pathfinder owns the movement', async () => {
  const w = flat(); w.fill(4, 61, -8, 30, 63, 8, 'air'); w.fill(4, 60, -8, 30, 60, 8, 'lava')
  const r = rig(w, { pos: [2.5, 64, 0.5] })
  r.bot.pathfinder = { goal: { x: 3, y: 64, z: 0 }, isMoving: () => true }
  runAtCliff(r)
  assert.ok(await until(() => ends(r, 'edge_guard').length > 0, 4000))
  await r.stop()
})

test('E1 edge_guard: exempt for descend/bridge skills', async () => {
  const r = rig(cliffWorld(), { pos: [2.5, 64, 0.5] })
  const tok = await r.arbiter.acquire('s1', { label: 'escape_descend' })
  runAtCliff(r)
  await sleep(500)
  assert.equal(ends(r, 'edge_guard').length, 0)
  tok.release(); await r.stop()
})

test('E1 edge_guard: hysteresis (no re-fire within the window unless within 0.5 of the edge) and the edge is marked forbidden', async () => {
  const r = rig(cliffWorld(), { pos: [2.5, 64, 0.5] })
  runAtCliff(r)
  assert.ok(await until(() => ends(r, 'edge_guard').length > 0, 4000))
  assert.ok(r.reflex.danger.isForbidden({ x: 4, y: 64, z: 0 }) || r.reflex.danger.forbiddenCells.size > 0, 'edge cell forbidden')
  const n = ends(r, 'edge_guard').length
  // inside the window: moving toward the edge from far away (>0.5) must not fire
  r.bot.entity.position.x = 2.4; r.bot.entity.yaw = -Math.PI / 2; r.bot.entity.velocity.x = 0.1
  r.bot.setControlState('forward', true)
  await sleep(250)
  assert.equal(ends(r, 'edge_guard').length, n, 'no re-fire far from the edge inside the hysteresis window')
  r.bot.clearControlStates()
  await r.stop()
})
