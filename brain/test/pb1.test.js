// PB1: S2 contract for playbooks, true body facts, priority wording.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseOutput, validate, makeIntent, normalizeDigest } from '../contract.js'
import { buildMessages, buildSystem, renderDigest, sensations } from '../prompt.js'
import { bodyFacts } from '../bodyfacts.js'
import { renderCritical, isCritical } from '../survival.js'

const dg = (o = {}) => ({ time: { day: 1, phase: 'day' }, pos: [0, 64, 0], health: 20, food: 4, energy: 18, needs: {}, inventory: {}, free_slots: 20, nearby: [], hazards: [], players: [{ name: 'Alex', dist: 5 }], places: [{ id: 'house', kind: 'place', pos: [60, 64, 0], dist: 60, dir: 'east' }], events: [], chat: [], recent_intents: [], difficulty: 'easy', ...o })

test('playbook goal: {type:playbook,target:..} validates name, player and place and becomes a pursue intent', () => {
  const p = parseOutput('{type:playbook,target:"show_place_to_person person=Alex place=house"}\n---\nintent: show him my house\nSAY: Follow me, it is to the east.')
  assert.ok(p.ok, JSON.stringify(p.errors)); const v = validate(p, dg(), { advisory: true }); assert.ok(v.ok, JSON.stringify(v.errors))
  const it = makeIntent(v, dg()); assert.equal(it.goal, 'pursue'); assert.equal(it.goal_spec.type, 'playbook'); assert.match(it.goal_spec.target, /^show_place_to_person person=Alex place=house$/)
  const bad = validate(parseOutput('{type:playbook,target:"show_place_to_person person=nobody place=house"}\n---\nintent: x'), dg(), { advisory: true })
  assert.equal(bad.ok, false); assert.match(bad.errors[0].msg, /not a player online/)
  const unk = validate(parseOutput('{type:playbook,target:"fly_away"}\n---\nintent: x'), dg(), { advisory: true }); assert.equal(unk.ok, false); assert.match(unk.errors[0].msg, /show_place_to_person/)
})

test('now: <playbook> k=v starts it; the playbook name as the type works; goal types keep their names (get_food stays a goal type)', () => {
  const a = validate(parseOutput('now: gather resource=wood count=8\nintent: get some wood'), dg(), { advisory: true }); assert.ok(a.ok, JSON.stringify(a.errors))
  assert.equal(a.goal.type, 'playbook'); assert.match(a.goal.target, /gather resource=wood count=8/)
  const b = validate(parseOutput('{type:go_home}\n---\nintent: go back'), dg(), { advisory: true }); assert.ok(b.ok); assert.equal(b.goal.type, 'playbook')
  const c = validate(parseOutput('{type:get_food}\n---\nintent: eat'), dg(), { advisory: true }); assert.equal(c.goal.type, 'get_food')
})

test('steering lines: playbook: skip / abort why / set k=v are parsed and a steering-only answer is act none', () => {
  const s = validate(parseOutput('{}\n---\nplaybook: skip'), dg(), { advisory: true }); assert.ok(s.ok, JSON.stringify(s.errors))
  const it = makeIntent(s, dg()); assert.deepEqual(it.playbook_ops, [{ op: 'skip' }]); assert.equal(it.goal, 'none')
  const a = parseOutput('{act:none,args:{}}\n---\nplaybook: abort he left'); assert.deepEqual(a.meta.playbook_ops, [{ op: 'abort', reason: 'he left' }])
  assert.deepEqual(parseOutput('{act:none,args:{}}\n---\nplaybook: set radius=20 direction=north').meta.playbook_ops, [{ op: 'set', set: { radius: '20', direction: 'north' } }])
})

test('body facts: true to the game, scaled by the real difficulty', () => {
  const easy = bodyFacts(normalizeDigest(dg({ food: 0 })))
  assert.match(easy, /EASY/); assert.match(easy, /cannot kill you/); assert.match(easy, /10\/20/); assert.match(easy, /18 or more/); assert.match(easy, /food 0/)
  assert.match(bodyFacts(normalizeDigest(dg({ difficulty: 'normal' }))), /down to 1\/20/)
  assert.match(bodyFacts(normalizeDigest(dg({ difficulty: 'hard' }))), /CAN kill you/)
  assert.doesNotMatch(bodyFacts(normalizeDigest(dg({ difficulty: null }))), /cannot kill/)
  const m = buildMessages({ job: { events: [{ type: 'heartbeat' }] }, digest: dg(), autonomy: 'high' }); assert.match(m[1].content, /How your body works/)
})

test('no text claims starvation is lethal; low food is critical only on Hard, unknown difficulty, or when hurt', () => {
  const ndg = (o) => normalizeDigest(dg(o))
  assert.equal(isCritical(ndg({ food: 2, health: 20, difficulty: 'easy' })), false)
  assert.equal(isCritical(ndg({ food: 2, health: 9, difficulty: 'easy' })), true)
  assert.equal(isCritical(ndg({ food: 2, health: 20, difficulty: 'hard' })), true)
  assert.equal(isCritical(ndg({ food: 2, health: 20, difficulty: null })), true)
  const all = [renderDigest(dg({ food: 0 }), { autonomy: 'high' }), renderCritical(ndg({ food: 2, health: 8 })), buildSystem({}), sensations(dg({ food: 2 })).join(' ')].join('\n')
  assert.doesNotMatch(all, /starving|stomach hurts|you will die/i)
})

test('prompt shows the active playbook with step k/n, the after-this note, and drops the "food is low, plan now" nag for commitments', () => {
  const pb = { name: 'show_place_to_person', args: { person: 'Alex', place: 'house' }, status: 'running', k: 4, n: 6, step: 'escort', step_desc: 'walk there together', commitment: true, interruptions: 1, resumes: 1, after_this: ['get food (food 4/20)'], last_event: null }
  const m = buildMessages({ job: { events: [{ type: 'heartbeat' }] }, digest: dg({ playbook: pb }), autonomy: 'high' })
  assert.match(m[1].content, /step 4\/6 "escort"/); assert.match(m[1].content, /After this \(queued, not forgotten\): get food/); assert.doesNotMatch(m[1].content, /Your food is low/)
  assert.match(m[0].content, /Playbooks:/); assert.match(m[0].content, /show_place_to_person person=<player> place=<place or x,y,z>/)
  const m2 = buildMessages({ job: { events: [{ type: 'heartbeat' }] }, digest: dg(), autonomy: 'high' }); assert.match(m2[1].content, /Your food is low/)
})

test('activity menu: <= 7 feasible playbooks with parameters and a NOT NOW line with reasons (RS1 format)', async () => {
  const { activityMenu } = await import('../menu.js')
  const t = activityMenu(normalizeDigest(dg({ food: 10, inventory: { dirt: 3 } })))
  assert.ok(t.split('\n').filter((l) => /^\d+\./.test(l)).length <= 7); assert.match(t, /show_place_to_person person=Alex place=house/); assert.match(t, /NOT NOW:.*sleep_at_night \(it is day\)/); assert.match(t, /simple_hut \(3\/57 blocks/)
  assert.match(activityMenu(normalizeDigest(dg({ nearby: [{ id: 'zombie_1', kind: 'zombie', cat: 'hostile', dist: 6 }], inventory: { cobblestone: 12 } }))), /1\. dig_in/)
})
