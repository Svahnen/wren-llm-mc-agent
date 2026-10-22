// IMP1: text -> intent mapping (sentence level), waits as explicit rest, menu choices, honest none.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeDigest, validate, parseOutput, inferAction } from '../contract.js'
import { activityMenu } from '../menu.js'

const DG = (o = {}) => normalizeDigest({ time: { day: 5, phase: 'day' }, pos: [0, 64, 0], health: 20, food: 17, inventory: { cod: 2, rotten_flesh: 1, oak_log: 4, cobblestone: 3 }, places: [{ id: 'home_base', kind: 'home', pos: [-60, 64, 0], dist: 60 }, { id: 'bed_1', kind: 'bed', pos: [2, 64, 0], dist: 2 }, { id: 'shelter', kind: 'place', pos: [90, 64, 0], dist: 90 }], ...o })
const inf = (think, o = {}, extra = {}) => inferAction({ think, speech: '', ...extra }, DG(o))

test('waiting is an explicit rest with a duration', () => {
  for (const t of ['The bed is right there. I will wait for dusk.', "I'll stay put at the bed.", 'Let me just rest here until night.', "I'm not moving again."]) {
    const r = inf(t); assert.deepEqual(r.hit, { act: 'idle_activity', args: { kind: 'rest', seconds: 30 } }, t)
  }
  assert.equal(inf('I will wait for about 45 seconds.').hit.args.seconds, 45)
  assert.equal(inf('I should wait here for 5 minutes.').hit.args.seconds, 60)   // capped at the skill maximum
  const v = validate({ ...parseOutput('{act:none}\n---\nTHINK: x'), act: 'idle_activity', args: { kind: 'rest', seconds: 30 }, errors: [] }, DG(), { advisory: true })
  assert.equal(v.ok, true)
  assert.equal(validate({ ...parseOutput('{act:none}\n---\nTHINK: x'), act: 'idle_activity', args: { kind: 'rest', seconds: 500 }, errors: [] }, DG(), { advisory: true }).ok, false)
})
test('honest none: the body is already doing it, or she names alternatives, or she negates', () => {
  const esc = { events: ['you are confined and cannot move; try dig out in direction south. Do not start explore: the body is running the escape ladder (dig out)'] }
  assert.equal(inf('The escape ladder is running, I will wait for it to finish and then go to the bed.', esc).none, true)
  assert.equal(inf('I should wait here, and then walk to home_base.', { playbook: { name: 'fish', status: 'running', k: 4, n: 4, step: 'cast' } }).hit?.goal?.target ?? 'x', 'go_home')   // an explicit walk is still allowed during a playbook
  assert.equal(inf('I should wait here.', { playbook: { name: 'fish', status: 'running', k: 4, n: 4, step: 'cast' } }).none, true)   // wait is not started on top of a running playbook
  assert.equal(inf('I could either wait here or head for home_base.').none ?? inf('I could either wait here or head for home_base.').ambiguous != null, true)
  assert.ok(!inf('I could either wait here or head for home_base.').hit)
  assert.equal(inf("I shouldn't wait here.").none, true)
  assert.equal(inf('I am hurt.', { health: 3 }).none, true)
  assert.equal(inf('I will wait here.', { health: 3, nearby: [{ id: 'zombie_1', kind: 'zombie', cat: 'hostile', dist: 8 }] }).none, true)   // never idle under attack
})
test('status talk about a playbook is not a decision; contingent plans are not either', () => {
  assert.equal(inf('The get_food playbook failed twice. The go_home playbook finished. I am confused.').none, true)
  assert.equal(inf('I will keep fishing, otherwise I will drop it and go home to sleep.').none, true)
  assert.equal(inf('Since the fish playbook failed, I should go home.').hit.goal.target, 'go_home')
})
test('now line and last committed sentence decide between several options', () => {
  assert.equal(inf('I could go home or eat. Let me think.', {}, { meta: { now: 'walk to shelter' } }).hit.goal.target, 'shelter')
  assert.equal(inf('I want to get food. Then I will walk to shelter.').hit.goal.target, 'shelter')   // last committed, single
  const h = inf('', {}, { meta: { now: 'eat cod, then walk to shelter' } })
  assert.deepEqual(h.hit, { act: 'eat', args: { item: 'cod' } })   // sequence: first step now
  assert.equal(inf('', {}, { meta: { now: 'rest at the bed and wait for dusk' } }).hit.act, 'idle_activity')
  assert.ok(inf('Either build a shelter or eat cod.').ambiguous)
})
test('menu choice "I will go with 2" picks the numbered activity', () => {
  const dg = DG({ food: 10, places: [{ id: 'home', kind: 'home', pos: [-80, 64, 0], dist: 80 }] })
  const lines = activityMenu(dg).split('\n').filter((l) => /^\d+\. /.test(l))
  assert.ok(lines.length >= 3)
  const name = (n) => /^\d+\. ([a-z_]+)/.exec(lines[n - 1])[1]
  const r = inferAction({ think: `Here are the options. 1. ${name(1)} 2. ${name(2)}. I'll go with ${2}.`, speech: '' }, dg)
  assert.equal(r.why, 'menu_choice')
  const t = r.hit.goal.type === 'build_shelter' ? 'build_shelter' : r.hit.goal.target.split(' ')[0]
  assert.equal(t, name(2) === 'dig_in' ? 'build_shelter' : name(2))
  assert.equal(inferAction({ think: 'I will take 3 logs and see.', speech: '' }, dg).why === 'menu_choice', false)
  assert.equal(inferAction({ think: 'I will pick the third option', speech: '' }, dg).why, 'menu_choice')
})
test('place walks, cooking, gathering', () => {
  assert.equal(inf('Let me walk to home_base now.').hit.goal.target, 'go_home')
  assert.equal(inf('I need to head to the shelter.').hit.goal.target, 'shelter')
  assert.equal(inf('I should cook them.').hit.act, 'cook')
  assert.match(inf('I should gather 10 stone for a wall.').hit.goal.target, /^gather resource=stone count=10$/)
  assert.equal(inf('I should head west to my home base.').hit.goal.target, 'go_home')   // not explore west
})
test('empty custom goal header is a quiet none, not header_syntax', () => {
  for (const h of ['{type:custom,target:}', '{type:custom,target:""}']) {
    const p = parseOutput(`${h}\n---\nTHINK: nothing to do`)
    assert.ok(!p.errors.some((e) => e.code === 'header_syntax'), h)
    if (h.endsWith('target:}')) { assert.deepEqual(p.errors, []); assert.equal(p.act, 'none') }
  }
})
test('a second wait in a row in full-health daylight is refused (GOAL3), one short rest is fine', () => {
  const r = { goal: 'idle_activity', args: { kind: 'rest' }, status: 'done' }
  assert.ok(inf('I will wait here.', { recent_intents: [] }).hit)
  const x = inf('I will wait here.', { recent_intents: [r], time: { day: 5, phase: 'day' } })
  assert.equal(x.none, true); assert.equal(x.why, 'daylight_idle')
  assert.ok(inf('I will wait here.', { recent_intents: [r], health: 15 }).hit)   // hurt: resting is fine
})
