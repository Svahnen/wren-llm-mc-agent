// EXP1: the menu offers resource_expedition as the hint when a gather failed with "no X within N m"; it validates as a playbook goal.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseOutput, validate, normalizeDigest } from '../contract.js'
import { activityMenu } from '../menu.js'
import { depletedResource } from '../menu-exp1.js'

const dg = (o = {}) => ({ time: { day: 1, phase: 'day', ticks: 3000 }, pos: [0, 64, 0], health: 20, food: 20, energy: 18, needs: {}, inventory: {}, free_slots: 20, nearby: [], hazards: [], players: [], places: [{ id: 'home', kind: 'home', pos: [0, 64, 0], dist: 3, dir: 'here' }], events: [], chat: [], recent_intents: [], difficulty: 'easy', failures: [], ...o })
const lines = (t) => t.split('\n').filter((l) => /^\d+\./.test(l))

test('depletedResource: gather failures that say "no X within N m" map to a resource, others do not', () => {
  assert.equal(depletedResource({ what: 'gather_wood', reason: 'no_target_found: no log within 112 m (none in the loaded world around you)' }), 'wood')
  assert.equal(depletedResource({ what: 'gather_stone', reason: 'no_target_found: 400 stone blocks within 64 m but none usable' }), 'stone')
  assert.equal(depletedResource({ what: 'craft', reason: 'missing_planks' }), 'wood')
  assert.equal(depletedResource({ what: 'wanted find_resource', reason: 'gather: failed (could_not_gather). Steps: collect:failed' }), 'any')
  assert.equal(depletedResource({ what: 'gather_wood', reason: 'timeout' }), null)
  assert.equal(depletedResource({ what: 'move_to', reason: 'unreachable' }), null)
})

test('menu: after "gather_wood no_target_found no log within 112 m" resource_expedition resource=wood ranks first with the cause and daylight', () => {
  const t = activityMenu(normalizeDigest(dg({ failures: [{ what: 'gather_wood', reason: 'no_target_found: no log within 112 m (none in the loaded world around you)', ago_s: 30 }] })))
  assert.match(lines(t)[0], /^1\. resource_expedition resource=wood max_dist=200: gather_wood failed \(no_target_found: no log within 112 m/)
  assert.match(lines(t)[0], /new ground likely to have it.*about \d+ min left/)
  assert.ok(lines(t).length <= 7)
})
test('menu: a remembered forest is named as the destination', () => {
  const t = activityMenu(normalizeDigest(dg({ places: [{ id: 'home', kind: 'home', dist: 3 }, { id: 'forest_ab1', kind: 'forest', dist: 140, dir: 'west', note: 'forest at -180,60 (16 logs taken)' }], failures: [{ what: 'gather_wood', reason: 'no_target_found: no log within 112 m', ago_s: 10 }] })))
  assert.match(lines(t)[0], /to your remembered forest_ab1 \(140 m west\)/)
})
test('menu: stone failure -> stone; at night or near dusk it is a NOT NOW line; no failure -> a quiet low entry', () => {
  const f = [{ what: 'gather_stone', reason: 'no_target_found: no stone within 64 m', ago_s: 20 }]
  assert.match(lines(activityMenu(normalizeDigest(dg({ failures: f }))))[0], /resource=stone/)
  const n = activityMenu(normalizeDigest(dg({ failures: f, time: { day: 1, phase: 'night', ticks: 14000 } })))
  assert.match(n, /NOT NOW:.*resource_expedition \(it is night, dawn in \d+ min\)/); assert.doesNotMatch(lines(n).join('\n'), /resource_expedition/)
  const d = activityMenu(normalizeDigest(dg({ failures: f, time: { day: 1, phase: 'day', ticks: 11300 } })))
  assert.match(d, /resource_expedition \(not now: dusk in 2 min\)/)
  const q = activityMenu(normalizeDigest(dg()))
  assert.match(q, /resource_expedition resource=<wood\|stone\|food\|any>/)
})
test('goal: {type:playbook,target:"resource_expedition resource=wood"} validates; bad resource does not', () => {
  const a = validate(parseOutput('now: resource_expedition resource=wood max_dist=150\nintent: get wood from further away'), dg(), { advisory: true })
  assert.ok(a.ok, JSON.stringify(a.errors)); assert.equal(a.goal.type, 'playbook'); assert.match(a.goal.target, /resource_expedition resource=wood max_dist=150/)
  const b = validate(parseOutput('now: resource_expedition resource=gold\nintent: x'), dg(), { advisory: true })
  assert.equal(b.ok, false)
})

// BAT1: the live failure shapes (observed): S2's playbook failures never matched, so resource_expedition was not on the menu
test('BAT1 depletedResource: wanted playbook make_tools failed (no_wood) -> wood; no_stone -> stone; unrelated playbook failures stay null', () => {
  assert.equal(depletedResource({ what: 'wanted playbook: make_tools', reason: 'failed (no_wood). Steps: wood:failed/no_target_found (170s ago) [the game said: "x"]' }), 'wood')
  assert.equal(depletedResource({ what: 'wanted playbook: make_tools', reason: 'failed (no_stone). Steps: wood:done, stone:failed/no_target_found' }), 'stone')
  assert.equal(depletedResource({ what: 'wanted playbook: gather resource=wood count=6', reason: 'failed (could_not_gather). Steps: collect:failed' }), 'wood')
  assert.equal(depletedResource({ what: 'wanted playbook: wall_ring', reason: 'failed (could_not_wall). Steps: blocks:skipped/when, ring:failed/incomplete' }), null)
  assert.equal(depletedResource({ what: 'wanted playbook: go_home', reason: 'failed (no_route_home)' }), null)
})
test('BAT1 menu: after the live make_tools failure resource_expedition resource=wood is menu entry 1', () => {
  const t = activityMenu(normalizeDigest(dg({ failures: [{ what: 'wanted playbook: make_tools', reason: 'failed (no_wood). Steps: wood:failed/no_target_found', ago_s: 170 }] })))
  assert.match(lines(t)[0], /^1\. resource_expedition resource=wood max_dist=200/)
})
