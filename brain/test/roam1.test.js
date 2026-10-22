// ROAM1: menu ranks roam high when home is used up, make_camp at dusk with the honest line, new_home offer, dusk line in the digest, playbooks validate as goals.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDigest } from '../contract.js'
import { activityMenu } from '../menu.js'
import { duskLineDg, roamMenu } from '../menu-roam1.js'
import { buildMessages } from '../prompt.js'
import { validate, parseOutput } from '../contract.js'

const dg = (o = {}) => normalizeDigest({ time: { day: 3, phase: 'day', ticks: 3000 }, pos: [0, 64, 0], health: 20, food: 6, energy: 18, needs: {}, inventory: {}, free_slots: 20, nearby: [], hazards: [], players: [], places: [{ id: 'home', kind: 'home', pos: [0, 64, 0], dist: 3 }], events: [], chat: [], recent_intents: [], ...o })
const lines = (t) => t.split('\n').filter((l) => /^\d+\./.test(l))
const F = (what, reason) => ({ what, reason, ago_s: 60 })

test('home used up + hungry + nothing to eat: roam is entry 1 (above resource_expedition), with kit facts, seeds and camp mentioned', () => {
  const t = activityMenu(dg({ inventory: { dirt: 20, torch: 2 }, failures: [F('forage_plants', 'no_target_found: no ripe berry bush'), F('gather_wood', 'no_target_found: no log within 112 m')] }), { max: 9 })
  const l = lines(t)
  assert.match(l[0], /^1\. roam days=2 \(max 4\) max_dist=400: the ground around home is used up \(2 failed/)
  assert.match(l[0], /grass seeds.*night camp.*instead of walking home/)
  assert.match(l[0], /You carry 20 building blocks, 2 torches, 0 food items/)
  assert.ok(l.some((x) => /resource_expedition/.test(x)), 'the single-day expedition is still offered')
})
test('a remembered meadow is named as the destination; a bag with food and no failures keeps roam quiet', () => {
  const t = activityMenu(dg({ failures: [F('hunt', 'no_animal_nearby'), F('forage_plants', 'no_target_found')], places: [{ id: 'home', kind: 'home', pos: [0, 64, 0], dist: 3 }, { id: 'meadow_x1', kind: 'meadow', pos: [300, 64, 0], dist: 300, note: 'tall grass' }] }), { max: 9 })
  assert.match(lines(t)[0], /toward your remembered meadow_x1 \(300 m/)
  const q = activityMenu(dg({ food: 20, inventory: { bread: 6 } }), { max: 12 })
  assert.match(q, /roam days=<1-4> direction=/); assert.doesNotMatch(lines(q).slice(0, 2).join('\n'), /^1\. roam days=2/)
})
test('night and near dusk: roam is a NOT NOW line, nothing offered', () => {
  const f = [F('forage_plants', 'no_target_found'), F('hunt', 'no_animal_nearby')]
  const n = activityMenu(dg({ failures: f, time: { day: 1, phase: 'night', ticks: 14000 } }), { max: 9 })
  assert.match(n, /NOT NOW:.*roam \(it is night, a roam starts in the morning, dawn in \d+ min\)/)
  const d = activityMenu(dg({ failures: f, time: { day: 1, phase: 'day', ticks: 11300 } }), { max: 9 })
  assert.match(d, /roam \(not now: dusk in \d+ min; start in the morning, or make_camp if you stay out\)/)
})
test('dusk away from home: honest line and make_camp ranked; reachable home: both ways named', () => {
  const far = dg({ time: { day: 1, phase: 'day', ticks: 9800 }, places: [{ id: 'home', kind: 'home', pos: [380, 64, 0], dist: 380 }], inventory: { dirt: 12 } })
  assert.match(duskLineDg(far), /^home is 380 m away; dark in \d+ min: home is too far to reach before dark: camp here \(make_camp\)$/)
  const t = activityMenu(far, { max: 9 }); assert.match(lines(t).find((x) => /make_camp/.test(x)), /make_camp: home is 380 m away; dark in .*camp here \(make_camp\)/)
  const near = dg({ time: { day: 1, phase: 'day', ticks: 9000 }, places: [{ id: 'home', kind: 'home', pos: [120, 64, 0], dist: 120 }] })
  assert.match(duskLineDg(near), /go home \(go_home\) or camp here \(make_camp\)/)
  assert.equal(duskLineDg(dg({ time: { day: 1, phase: 'day', ticks: 2000 }, places: [{ id: 'home', kind: 'home', pos: [380, 64, 0], dist: 380 }] })), null)
  assert.equal(duskLineDg(dg({ time: { day: 1, phase: 'night', ticks: 14000 } })), null)
  assert.equal(duskLineDg(dg({ time: { day: 1, phase: 'day', ticks: 11000 }, places: [{ id: 'home', kind: 'home', pos: [0, 64, 0], dist: 5 }] })), null, 'at home')
})
test('the dusk line reaches the prompt digest', () => {
  const far = dg({ time: { day: 1, phase: 'day', ticks: 9800 }, places: [{ id: 'home', kind: 'home', pos: [380, 64, 0], dist: 380 }] })
  const m = buildMessages({ digest: far, memory: {}, mode: 'decide' })
  const txt = JSON.stringify(m)
  assert.match(txt, /dusk: home is 380 m away; dark in \d+ min/)
})
test('new_home is offered only at a good_site far from home', () => {
  const places = [{ id: 'home', kind: 'home', pos: [0, 64, 0], dist: 400 }, { id: 'good_site_a', kind: 'good_site', pos: [400, 64, 0], dist: 10, note: 'food, water, trees and grass together' }]
  assert.match(roamMenu(dg({ places })).ok.map((o) => o.text).join('\n'), /new_home: this place has food, water, trees and grass together.*old_home/)
  assert.doesNotMatch(roamMenu(dg({ places: [{ ...places[0], dist: 50 }, places[1]] })).ok.map((o) => o.text).join('\n'), /new_home/)
})
test('roam, make_camp and new_home validate as playbook goals; a bad number does not', () => {
  for (const [t, re] of [['roam days=3 direction=east', /roam direction=east days=3/], ['make_camp bed=yes', /make_camp bed=yes/], ['new_home', /new_home/]]) {
    const a = validate(parseOutput(`now: ${t}\nintent: x`), dg(), { advisory: true })
    assert.ok(a.ok, t + JSON.stringify(a.errors)); assert.equal(a.goal.type, 'playbook'); assert.match(a.goal.target, re)
  }
  assert.equal(validate(parseOutput('now: roam days=abc\nintent: x'), dg(), { advisory: true }).ok, false)
})
