// S1G: goal-typed S2 contract (intent + type + target + modulators), optional act, place notes, F3 facts. Old format must keep working.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseOutput, validate, makeIntent, validateIntent, normalizeDigest } from '../contract.js'
import { GOAL_TYPES, registerGoalType, compass8, facingFromYawDeg, clockFromTicks, parseRemember, parseRename, parsePlaceOps, parseCoords, textHash } from '../goaltypes.js'
import { renderDigest, buildSystem } from '../prompt.js'
import { dg } from './helpers.js'

const V = (t, d = dg(), o) => validate(parseOutput(t), d, o)
const codes = (r) => r.errors.map((e) => e.code)
const D = (o = {}) => dg({ players: [{ name: 'Alex', dist: 9 }], places: [{ id: 'home', kind: 'home', pos: [100, 64, 0], dist: 100 }, { id: 'lake', kind: 'place', pos: [0, 64, -50] }], pos: [0, 64, 0], ...o })

test('goal header: {type,target} + intent line, no act', () => {
  const r = V('{type:follow_person,target:Alex}\n---\nintent: stay with Alex and see where he goes\nurgency: 0.7\nSAY: Lead on.', D())
  assert.ok(r.ok, JSON.stringify(r.errors)); assert.equal(r.act, null)
  assert.deepEqual({ ...r.goal }, { type: 'follow_person', target: 'Alex', text: 'stay with Alex and see where he goes', via_act: false })
  const it = makeIntent(r, D())
  assert.equal(it.goal, 'pursue'); assert.deepEqual(it.args, { type: 'follow_person', target: 'Alex' }); assert.equal(it.goal_spec.hash, textHash(it.goal_spec.text))
  assert.equal(it.modulators.urgency, 0.7); assert.deepEqual(validateIntent(it), [])
})
test('headerless: intent/type lines only, header-only {} and mod keys in the header', () => {
  for (const t of ['intent: find something to eat\ntype: get_food\nSAY: Hungry.', '{}\n---\nintent: find something to eat\ntype: get_food\nSAY: Hungry.', '{type:get_food,intent:"find something to eat",urgency:0.9}\n---\nSAY: Hungry.']) {
    const r = V(t); assert.ok(r.ok, t + JSON.stringify(r.errors)); assert.equal(r.goal.type, 'get_food'); assert.equal(r.goal.text, 'find something to eat'); assert.equal(r.speech, 'Hungry.')
  }
  assert.equal(makeIntent(V('{type:get_food,urgency:0.9,intent:eat}\n---\nSAY: Hm.'), D()).modulators.urgency, 0.9)
})
test('old format unchanged: act+args still the closed vocabulary', () => {
  const r = V('{act:none,args:{}}\n---\nHello.'); assert.ok(r.ok); assert.equal(r.goal, null)
  const it = makeIntent(r, dg()); assert.equal(it.goal, 'none'); assert.equal(it.goal_spec, null); assert.deepEqual(it.place_ops, [])
  assert.ok(!V('{act:pursue,args:{}}\n---\nx').ok, 'pursue is internal and cannot be named')
  assert.ok(codes(V('{}\n---\nx')).includes('act_missing'))
  assert.ok(codes(V('{act:none}\n---\nx')).includes('args_missing'))
})
test('act plus type: a named skill annotated with the goal it serves', () => {
  const d = dg({ nearby: [{ id: 'cow_1', kind: 'cow', cat: 'animal', dist: 8, tags: ['animal'] }], food: 12 })
  const r = V('{act:hunt,args:{target:cow_1}}\n---\ntype: get_food\nintent: a cow nearby\nSAY: Hunting.', d)
  assert.ok(r.ok, JSON.stringify(r.errors)); assert.equal(r.act, 'hunt'); assert.equal(r.goal.type, 'get_food'); assert.equal(r.goal.via_act, true)
  const it = makeIntent(r, d); assert.equal(it.goal, 'hunt'); assert.equal(it.goal_spec.type, 'get_food')
})
test('targets: required ones are validated against the state; unknown type falls back to custom', () => {
  assert.ok(codes(V('{type:follow_person}\n---\nintent: follow\nSAY: ok', D())).includes('goal_target_missing'))
  assert.ok(codes(V('{type:follow_person,target:nobody}\n---\nintent: follow\nSAY: ok', D())).includes('id_unknown'))
  assert.ok(V('{type:go_to_place,target:lake}\n---\nintent: see the lake\nSAY: Going.', D()).ok)
  assert.ok(codes(V('{type:go_to_place,target:ocean}\n---\nintent: sea\nSAY: Going.', D())).includes('id_unknown'))
  const c = V('{type:go_to_place,target:"120, 64, -30"}\n---\nintent: there\nSAY: Going.', D()); assert.ok(c.ok); assert.equal(c.goal.target, '120,64,-30')
  const u = V('{type:fly_to_moon}\n---\nintent: dream\nSAY: ok', D()); assert.ok(u.ok); assert.equal(u.goal.type, 'custom'); assert.ok(u.warnings.some((w) => w.code === 'goal_type_unknown'))
  const fr = V('{type:find_resource,target:"some logs"}\n---\nintent: wood\nSAY: ok', D()); assert.equal(fr.goal.target, 'wood')
})
test('goal types are extensible', () => {
  registerGoalType('fish_for_dinner', { desc: 'x', target: null })
  assert.ok(V('{type:fish_for_dinner}\n---\nintent: fish\nSAY: ok', D()).ok); assert.equal(V('{type:fish_for_dinner}\n---\nintent: fish\nSAY: ok', D()).goal.type, 'fish_for_dinner')
  delete GOAL_TYPES.fish_for_dinner
  assert.throws(() => registerGoalType('Bad Name'))
})
test('places: remember / forget / rename parse and validate', () => {
  assert.deepEqual(parseRemember('Blue Lake - good fishing, cows'), { op: 'remember', name: 'blue_lake', note: 'good fishing, cows' })
  assert.deepEqual(parseRemember('mine'), { op: 'remember', name: 'mine', note: '' })
  assert.equal(parseRemember('north'), null)
  assert.deepEqual(parseRename('lake -> blue lake'), { op: 'rename', name: 'lake', to: 'blue_lake' })
  assert.deepEqual(parseRename('lake to pond'), { op: 'rename', name: 'lake', to: 'pond' })
  const r = V('{act:none,args:{}}\n---\nremember: cave mouth - iron seen here\nforget: lake\nrename: home -> base\nforget: ghost\nSAY: Noted.', D())
  assert.ok(r.ok); assert.deepEqual(r.place_ops.map((o) => o.op + ':' + o.name), ['remember:cave_mouth', 'forget:lake', 'rename:home'])
  assert.ok(r.warnings.some((w) => w.code === 'place_op' && /ghost/.test(w.msg)))
  assert.equal(makeIntent(r, D()).place_ops.length, 3)
  const only = V('remember: spawn hill\nSAY: Nice view.', D()); assert.ok(only.ok, JSON.stringify(only.errors)); assert.equal(only.act, 'none'); assert.equal(only.place_ops[0].name, 'spawn_hill')
  assert.equal(parsePlaceOps({ remember: ['a', 'b', 'c', 'd'] }).ops.length, 3)
  assert.deepEqual(parseCoords('10 -5'), { x: 10, y: null, z: -5 })
})
test('F3 facts: compass, facing, clock, places carry direction + distance, digest renders them', () => {
  assert.equal(compass8(0, -10), 'north'); assert.equal(compass8(10, 0), 'east'); assert.equal(compass8(0, 10), 'south'); assert.equal(compass8(-10, -10), 'northwest'); assert.equal(compass8(0, 0), null)
  assert.deepEqual(facingFromYawDeg(180), { yaw: -180, compass: 'north' }); assert.equal(facingFromYawDeg(0).compass, 'south'); assert.equal(facingFromYawDeg(-90).compass, 'east'); assert.equal(facingFromYawDeg(90).compass, 'west')
  assert.equal(clockFromTicks(0), '06:00'); assert.equal(clockFromTicks(6000), '12:00'); assert.equal(clockFromTicks(18000), '00:00'); assert.equal(clockFromTicks(13000), '19:00')
  const d = normalizeDigest({ pos: [0, 64, 0], facing: { yaw: -90, compass: 'east' }, biome: 'plains', dimension: 'overworld', light: 12, clock: '12:30', places: [{ id: 'lake', kind: 'place', pos: [0, 64, -50] }, { id: 'home', pos: [30, 64, 40] }],
    explored: { cells: 120, biomes: ['plains', 'forest'], unexplored: ['north', 'west'] } })
  assert.equal(d.places[0].dir, 'north'); assert.equal(d.places[0].dist, 50); assert.equal(d.places[1].dir, 'southeast')
  const t = renderDigest(d)
  assert.match(t, /position: 0,64,0, facing east \(yaw -90\)/); assert.match(t, /biome plains, dimension overworld, light level 12, clock 12:30/)
  assert.match(t, /lake at 0,64,-50, 50m north/); assert.match(t, /explored: 120 map cells walked, biomes seen: plains, forest; nothing walked yet toward: north, west/)
  assert.doesNotThrow(() => renderDigest(normalizeDigest({})))
})
test('system prompt explains goals after the skills list, high only', () => {
  const hi = buildSystem({ autonomy: 'high' }), cl = buildSystem({ autonomy: 'classic' })
  assert.match(hi, /Goal types:/); assert.match(hi, /remember: <short name>/); assert.doesNotMatch(cl, /Goal types:/)
  assert.ok(hi.indexOf('Goal types:') > hi.indexOf('Skills:')); assert.doesNotMatch(hi, /act:pursue/)
})

import { Brain } from '../brain.js'
import { FakeS2 } from '../fake-s2.js'
import { wait } from './helpers.js'
test('brain end to end: a goal answer becomes a pursue intent with goal_spec, place_ops and modulators; the report closes it', async () => {
  const b = new Brain({ llm: new FakeS2({ mode: 'scripted', script: ['{type:go_to_place,target:lake}\n---\nintent: see the lake again\nurgency: 0.4\nremember: lookout - good view\nSAY: Off to the lake.'] }), log: () => {}, autonomy: 'high' })
  b.handleEvent({ type: 'heartbeat', digest: D() }); await wait(60)
  const r = await b.getIntent()
  assert.equal(r.intent.goal, 'pursue'); assert.deepEqual(r.intent.args, { type: 'go_to_place', target: 'lake' }); assert.equal(r.intent.goal_spec.text, 'see the lake again')
  assert.equal(r.intent.modulators.urgency, 0.4); assert.deepEqual(r.intent.place_ops, [{ op: 'remember', name: 'lookout', note: 'good view' }]); assert.equal(r.speech.text, 'Off to the lake.')
  assert.equal(b.status().brain.valid_first, 1)
  b.handleEvent({ type: 'report', intent_id: r.intent.intent_id, status: 'failed', reason_code: 'options_exhausted', digest: D() })   // S1 escalation is a normal report
  assert.equal(b.recent.at(-1).status, 'failed'); assert.equal(b.recent.at(-1).text, 'see the lake again')
  b.close()
})

import { cleanSpeech } from '../goaltypes.js'
test('regression ("serve: G2" and every structured line is stripped from speech; a token-only SAY is dropped', () => {
  assert.equal(cleanSpeech('serve: G2'), '')
  assert.equal(cleanSpeech('G2'), '')
  assert.equal(cleanSpeech('Okay, I will go. serve: G2'), 'Okay, I will go.')
  assert.equal(cleanSpeech('{act:none,args:{}}\n---\nHello there.\nplan: a; b\ndone: G1\nabandon: G3 no\nintent: x\nremember: lake\nTHINK: hm\nMUTTER: hm\nCHAT: hm'), 'Hello there.')
  assert.equal(cleanSpeech('SAY: Hi Alex.'), 'Hi Alex.')
  assert.equal(cleanSpeech('Note that it is late.'), 'Note that it is late.')
  const p = parseOutput('{act:none,args:{}}\n---\nSAY: serve: G2'); assert.equal(p.speech, '')
  const q = parseOutput('{act:explore,args:{}}\n---\nserve: G2'); assert.equal(q.speech, ''); assert.equal(q.meta.serves, 'G2')
  const r = V('{act:none,args:{}}\n---\nSAY: Sure.\nserve: G2\ngoal: see hills'); assert.equal(r.speech, 'Sure.')
})

import { describeItem, gearNotes } from '../goaltypes.js'
test('means: gear in plain words, food sources and recent failures are rendered; low food asks for a concrete plan', () => {
  assert.equal(describeItem('iron_sword'), 'iron sword: weapon (melee)'); assert.match(describeItem('beef', 2), /beef x2: food \(raw; cooking/); assert.equal(describeItem('dirt_path_xyz'), null)
  const d = normalizeDigest({ food: 5, inventory: { iron_sword: 1, beef: 2 }, gear: gearNotes({ iron_sword: 1, beef: 2 }), food_sources: [{ name: 'cow', dist: 22, dir: 'northeast', ago_s: 30 }], failures: [{ what: 'hunt', reason: 'unreachable_animal', ago_s: 40 }] })
  const t = renderDigest(d); assert.match(t, /your gear: iron sword: weapon/); assert.match(t, /food seen recently: cow 22m northeast \(30s ago\)/); assert.match(t, /recent failures: hunt: unreachable_animal \(40s ago\)/)
  assert.match(renderDigest(normalizeDigest({ food: 5 })), /no animals, crops or berries in view or memory/)
  const m = buildMessages({ job: { events: [{ type: 'heartbeat' }] }, digest: d, autonomy: 'high' }); assert.match(m[1].content, /get_food is a playbook/)
})
import { buildMessages } from '../prompt.js'
