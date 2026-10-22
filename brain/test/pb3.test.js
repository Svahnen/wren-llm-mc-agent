// PB3: {act:playbook,args:{name:..}} accepted; test bots (WrenT<n>) are not people.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDigest, validate, parseOutput } from '../contract.js'

const DG = (o = {}) => ({ time: { day: 5, phase: 'day' }, pos: [0, 64, 0], health: 20, food: 20, inventory: {}, nearby: [], places: [{ id: 'chest_1', kind: 'chest', pos: [3, 64, 0], dist: 3 }, { id: 'home', kind: 'home', pos: [5, 64, 0], dist: 5 }], ...o })
test('act:playbook with args.name (exact log string)', () => {
  for (const h of [
    '{act:playbook,args:{name:show_place_to_person, person:WrenT2, place:chest_1}}',
    '{act:show_place_to_person,args:{person:Sam, place:chest_1}}',
    '{"act":"playbook","args":{"name":"show_place_to_person","person":"Sam","place":"chest_1"}}',
    '{act:playbook,args:{playbook:go_home}}',
  ]) {
    const p = parseOutput(h + '\n---\nTHINK: ok.')
    assert.ok(!p.errors.some((e) => e.code === 'vocab'), h)
    const v = validate(p, normalizeDigest(DG()), { advisory: true })
    assert.ok(!(v.errors ?? []).some((e) => (e.code ?? e) === 'vocab'), `${h} -> ${JSON.stringify(v.errors)}`)
    assert.equal(v.goal?.type, 'playbook', h)
  }
})

import { activityMenu } from '../menu.js'
test('get_food cooldown shows in the menu NOT NOW line and survives normalizeDigest', () => {
  const dg = normalizeDigest(DG({ food: 15, playbook_cooldowns: [{ name: 'get_food', text: 'tried get_food here 2 min ago: no food within 32 m', left_s: 60 }] }))
  assert.equal(dg.playbook_cooldowns.length, 1)
  const m = activityMenu(dg)
  assert.ok(!/get_food:/.test(m.split('NOT NOW')[0])); assert.match(m, /NOT NOW:.*get_food \(tried get_food here 2 min ago: no food within 32 m\)/)
})
