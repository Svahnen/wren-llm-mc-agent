// PB2: forgiving playbook headers (exact strings from the observed brain log) and playbook/phrase -> intent inference.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDigest, validate, parseOutput, inferAction } from '../contract.js'

const DG = (o = {}) => ({ time: { day: 5, phase: 'day' }, pos: [0, 64, 0], health: 20, food: 20, inventory: {}, nearby: [], places: [{ id: 'bed_1', kind: 'bed', pos: [30, 64, 0], dist: 30 }, { id: 'home', kind: 'home', pos: [5, 64, 0], dist: 5 }], ...o })
const parse = (h, tail = '\n---\nTHINK: out I go.') => parseOutput(h + tail)

test('the exact rejected strings parse as playbook goals', () => {
  const p = parse('{type:playbook,target:explore_and_return radius=40 direction=west}')
  assert.equal(p.errors.length, 0); assert.equal(p.goal.type, 'playbook'); assert.equal(p.goal.target, 'explore_and_return radius=40 direction=west')
  const v = validate(p, normalizeDigest(DG()), { advisory: true })
  assert.equal(v.ok, true, JSON.stringify(v.errors)); assert.match(v.goal.target, /^explore_and_return /); assert.match(v.goal.target, /direction=west/)
})
test('playbook header variants all map', () => {
  for (const h of [
    '{type:playbook,target:"explore_and_return radius=40 direction=west"}',
    '{type:playbook,target:explore_and_return radius=40 direction=west',
    '{type:playbook,target:"explore_and_return radius=40 direction=west}',
    '{playbook:explore_and_return, args:{radius:40,direction:west}}',
    '{playbook:explore_and_return, radius:40, direction:west}',
    '{"type":"playbook","target":"explore_and_return radius=40 direction=west"}',
    'type:playbook,target:explore_and_return radius=40 direction=west',
    '{act:explore_and_return,args:{radius:40,direction:west}}',
    '{type:explore_and_return,target:radius=40 direction=west}',
  ]) {
    const p = parse(h); const v = validate(p, normalizeDigest(DG()), { advisory: true })
    assert.equal(v.ok, true, `${h} -> ${JSON.stringify(v.errors)}`)
    assert.equal(v.goal.type, 'playbook', h); assert.match(v.goal.target, /^explore_and_return /, h); assert.match(v.goal.target, /radius=40/, h); assert.match(v.goal.target, /direction=west/, h)
  }
  const g = validate(parse('{playbook:go_home}'), normalizeDigest(DG()), { advisory: true })
  assert.equal(g.ok, true); assert.equal(g.goal.target, 'go_home')
})
test('garbage near a playbook name is rescued; headers that name nothing stay errors', () => {
  const r = parse('{type: playbook; target = explore_and_return, radius = 40}')
  assert.equal(r.errors.length, 0); assert.match(r.goal.target, /^explore_and_return/)
  for (const bad of ['{foo bar']) assert.equal(parse(bad).ok, false, bad)
  assert.equal(validate(parse('{type:playbook,target:nothing_here at all}'), normalizeDigest(DG()), { advisory: true }).ok, false)
  assert.equal(parse('{type:build_shelter,target:}').errors.length, 0)   // accepted: shelter needs no target
})
test('custom goal "go to bed and sleep" (logged) is inferred at night', () => {
  const dg = normalizeDigest(DG({ time: { day: 5, phase: 'night' } }))
  const p = parse('{type:custom,target:go to bed and sleep}')
  assert.equal(p.ok, true)
  const inf = inferAction(p, dg)
  assert.equal(inf.hit.goal.type, 'playbook'); assert.match(inf.hit.goal.target, /^sleep_at_night/)
})
test('text mapping to playbooks and phrasings', () => {
  const night = normalizeDigest(DG({ time: { day: 5, phase: 'night' } })), day = normalizeDigest(DG())
  const h = (think, dg = day, extra = {}) => inferAction({ think, speech: '', ...extra }, dg)
  assert.match(h('Let me pick explore_and_return radius=40 direction=west and look around.').hit.goal.target, /^explore_and_return radius=40 direction=west$/)
  assert.match(h('I want to wander and explore new ground. I should explore west to see new terrain.').hit.goal.target, /explore_and_return direction=west/)
  assert.match(h("It's dark. I should go to my bed and sleep.", night).hit.goal.target, /^sleep_at_night/)
  assert.match(h('Getting dark, time to sleep.', night).hit.goal.target, /^sleep_at_night/)
  assert.equal(h('I will go to my bed.', day).hit.goal.target, 'bed_1')          // daytime: just walk there
  assert.equal(h('I will go to my bed.', day).hit.goal.type, 'go_to_place')
  assert.match(h('', night, { meta: { now: 'walk to the bed at 100,98' } }).hit.goal.target, /^sleep_at_night/)
  assert.match(h('Time to go home.').hit.goal.target, /^go_home/)
  // not mapped: past tense, negation, no cue, no bed, ambiguous
  assert.equal(h('I slept successfully and reached the bed.', night).none, true)
  assert.equal(h('I should not go to my bed yet.', night).none, true)
  assert.equal(h("My objective is to explore the area around the shelter.").none, true)
  assert.equal(h('I will go to my bed and sleep.', normalizeDigest(DG({ time: { day: 5, phase: 'night' }, places: [] }))).none, true)
  assert.ok(h('I should explore west, or maybe go home.').ambiguous)
})
