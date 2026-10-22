import test from 'node:test'
import assert from 'node:assert/strict'
import { translate, goalDescriptor, NO_CAP, capExempt } from '../src/mindlink/translate.js'
import { SKILL_NAMES, validateArgs } from '../src/skills/schema.js'
import { SKILLS as BRAIN_SKILLS } from '../../brain/contract.js'

const lm = { get: (n) => (n === 'home' ? { x: 0, y: 64, z: 0 } : null) }
test('every brain skill translates to a body skill that validates (or is none)', () => {
  const samples = {
    none: {}, idle_activity: { kind: 'rest' }, gesture: { kind: 'wave' }, explore: { direction: 'north' }, move_to: { x: 1, y: 64, z: 2 }, go_to: { place: 'home' },
    follow: { target: 'bob' }, approach: { target: 'cow_1' }, flee: { from: 'zombie_1' }, eat: { item: 'bread' }, hunt: { target: 'cow_1' }, sleep: {},
    collect: { resource: 'wood' }, interact: { target: 'bob', verb: 'talk' }, defend: { target: 'bob' },
  }
  for (const name of Object.keys(BRAIN_SKILLS).filter((n) => !BRAIN_SKILLS[n].internal)) { // S1G: `pursue` (goal intents) goes to S1, not to a body skill
    const t = translate({ goal: name, args: samples[name] }, { landmarks: lm, me: { x: 0, y: 64, z: 0 }, hazards: [] })
    if (name === 'none') { assert.ok(t.skip); continue }
    assert.ok(!t.fail, name)
    assert.ok(SKILL_NAMES.includes(t.goal), `${name} -> ${t.goal}`)
    const v = validateArgs(t.goal, t.args)
    assert.ok(v.ok, `${name} -> ${t.goal}: ${v.errors}`)
  }
})
test('approach(place) -> go_to; flee(hazard) -> move_to away; interact use/open -> approach', () => {
  assert.equal(translate({ goal: 'approach', args: { target: 'home' } }, { landmarks: lm }).goal, 'go_to')
  const f = translate({ goal: 'flee', args: { from: 'lava_1' } }, { me: { x: 10, y: 64, z: 0 }, hazards: [{ id: 'lava_1', kind: 'lava', pos: [8, 64, 0] }] })
  assert.equal(f.goal, 'move_to'); assert.ok(f.args.x > 20)
  assert.equal(translate({ goal: 'interact', args: { target: 'cow_1', verb: 'use' } }, {}).goal, 'approach')
})
test('goal descriptor and cap exemptions', () => {
  assert.deepEqual(goalDescriptor('explore', { direction: 'north' }, '1,2'), { type: 'explore', target: null, place: '1,2' })
  assert.equal(goalDescriptor('hunt', { target: 'cow_1' }, '1,2').target, 'cow_1')
  for (const g of ['eat', 'flee', 'sleep']) assert.ok(NO_CAP.has(g))
  assert.ok(capExempt('go_to', { place: 'home' })); assert.ok(!capExempt('go_to', { place: 'chest_1' }))
})
