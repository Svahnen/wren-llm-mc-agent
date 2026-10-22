import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseOutput, validate, makeIntent, validateIntent, validateEvent, speechPolicy, templateLine, splitSentences, intentExpired, SKILL_NAMES } from '../contract.js'
import { dg } from './helpers.js'

const V = (text, d = dg(), o) => validate(parseOutput(text), d, o)
const codes = (r) => r.errors.map((e) => e.code)

test('parser: canonical, quoted and bare forms', () => {
  const p = parseOutput('{act:follow,args:{target:"Alex"}}\n---\nOkay, lead on.')
  assert.ok(p.ok); assert.equal(p.act, 'follow'); assert.deepEqual(p.args, { target: 'Alex' }); assert.equal(p.speech, 'Okay, lead on.')
  assert.deepEqual(parseOutput('{"act":"move_to","args":{"x":1,"y":64,"z":-3}}\n---\nGo.').args, { x: 1, y: 64, z: -3 })
  assert.deepEqual(parseOutput('{act:none,args:{}}\n---\nHm.').args, {})
})
test('parser: failures never throw and are specific', () => {
  for (const [t, c] of [['', 'empty'], ['hello there', 'header_syntax'], ['{act:none,args:{}}\n{act:none,args:{}}', 'delimiter_missing'], ['{act:none}\n---\nx', 'args_missing'],
    ['{act:none,args:[1]}\n---\nx', 'args_not_object'], ['{act:none,args:{},foo:1}\n---\nx', 'unknown_header_key'], ['```\n{act:none,args:{}}\n```', 'code_fence'], ['{act:none,args:{}} trailing\n---\nx', 'header_syntax'], ['{act:none,args:{a:1,a:2}}\n---\nx', 'header_syntax']]) {
    const p = parseOutput(t); assert.ok(!p.ok, t); assert.ok(p.errors.some((e) => e.code === c), `${t} -> ${JSON.stringify(p.errors)}`)
  }
})
test('parser R1: tolerant variants parse, strictness on skills/args stays', () => {
  const ok = (t, act, speech) => { const p = parseOutput(t); assert.ok(p.ok, t + JSON.stringify(p.errors)); assert.equal(p.act, act); assert.equal(p.speech, speech, t) }
  ok('{act:none,args:{}}', 'none', '')                                   // header only
  ok('{act:none,args:{}}\n', 'none', '')
  ok('{act:explore,args:{direction:north}}\n\n---\nOff I go.', 'explore', 'Off I go.')   // blank before ---
  ok('{act:explore,args:{direction:north}}\n---\n\nOff I go.', 'explore', 'Off I go.')
  ok('{act:explore,args:{direction:north}}\n----\nOff I go.', 'explore', 'Off I go.')
  ok('{act:explore,args:{direction:north}} --- Off I go.', 'explore', 'Off I go.')           // inline
  ok('{act:explore,args:{direction:north}}\nOff I go.', 'explore', 'Off I go.')              // no delimiter, plain speech
  ok('act:eat,args:{item:bread}\n---\nYum.', 'eat', 'Yum.')                                // outer braces missing
  ok('{act:eat,args:{item:bread}\n---\nYum.', 'eat', 'Yum.')                               // one closing brace missing
  assert.ok(!parseOutput('{act:eat,args:{item:"bread').ok, 'unterminated string is not guessed')
  // strictness: unknown skill / args still rejected by the validator
  assert.ok(!V('{act:dance,args:{}}').ok); assert.ok(!V('act:eat,args:{item:diamond}\n---\nx').ok)
})
test('validator: accepts a good output and trims speech', () => {
  const r = V('{act:approach,args:{target:cow_1}}\n---\nA cow. I will go look. And then more words.')
  assert.ok(r.ok, JSON.stringify(r.errors)); assert.equal(r.speech, 'A cow. '.trim()); assert.ok(r.trimmed)
  assert.equal(V('{act:none,args:{}}\n---\nOne. Two. Three. Four.').speech, 'One. Two. Three.')
})
test('validator: vocabulary, args, ids', () => {
  assert.deepEqual(codes(V('{act:dance,args:{}}\n---\nx')), ['vocab'])
  assert.ok(codes(V('{act:idle_activity,args:{kind:observe}}\n---\nx')).includes('arg_enum'))
  assert.ok(codes(V('{act:interact,args:{target:cow_1,verb:speak}}\n---\nx')).includes('arg_enum'))
  assert.ok(codes(V('{act:approach,args:{target:ghost_9}}\n---\nx')).includes('id_unknown'))
  assert.ok(codes(V('{act:follow,args:{target:cow_1}}\n---\nx')).includes('id_wrong_kind'))
  assert.ok(codes(V('{act:move_to,args:{x:1.5,y:64,z:0}}\n---\nx')).includes('arg_type'))
  assert.ok(codes(V('{act:move_to,args:{x:1,y:64}}\n---\nx')).includes('arg_missing'))
  assert.ok(codes(V('{act:none,args:{foo:1}}\n---\nx')).includes('arg_unknown'))
  assert.ok(codes(V('{act:eat,args:{item:cooked_beef}}\n---\nx')).includes('item_missing'))
  assert.ok(codes(V('{act:eat,args:{item:oak_log}}\n---\nx', dg({ food: 10 }))).includes('item_not_edible'))
  assert.ok(codes(V('{act:move_to,args:{x:9000,y:64,z:0}}\n---\nx')).includes('too_far'))
  assert.ok(V('{act:go_to,args:{place:home}}\n---\nx').ok)
  assert.ok(codes(V('{act:hunt,args:{target:zombie_1}}\n---\nx')).includes('id_wrong_kind'))
})
test('needs: starving with food known rejects explore, accepts eat', () => {
  const d = dg({ food: 2, health: 8 })
  assert.ok(codes(V('{act:explore,args:{}}\n---\nGoing.', d)).includes('needs_starving'))
  assert.ok(codes(V('{act:idle_activity,args:{kind:rest}}\n---\nResting.', d)).includes('needs_starving'))
  assert.ok(V('{act:eat,args:{item:bread}}\n---\nEating.', d).ok)
  assert.ok(V('{act:hunt,args:{target:cow_1}}\n---\nHunting.', d).ok)
})
test('needs: hunt a safe animal when starving and no inventory food', () => {
  const d = dg({ food: 2, inventory: {}, hazards: [], nearby: [{ id: 'cow_1', kind: 'cow', cat: 'animal', dist: 5, pos: [36, 70, -10], tags: ['animal'] }] })
  assert.ok(V('{act:hunt,args:{target:cow_1}}\n---\nHunting.', d).ok)
  assert.ok(V('{act:approach,args:{target:cow_1}}\n---\nFood.', d).ok)
  assert.ok(V('{act:explore,args:{}}\n---\nGoing.', d).errors.some((e) => e.code === 'needs_starving'))
})
test('needs: starving but no food known only warns on passive acts', () => {
  const d = dg({ food: 2, inventory: {}, nearby: [], hazards: [] })
  const r = V('{act:idle_activity,args:{kind:rest}}\n---\nResting.', d)
  assert.ok(r.ok); assert.ok(r.warnings.some((w) => w.code === 'needs_starving_idle'))
  assert.ok(V('{act:explore,args:{}}\n---\nLooking for food.', d).ok)
})
test('hazards: ore next to lava rejected, far from lava accepted', () => {
  assert.ok(codes(V('{act:approach,args:{target:diamond_ore_1}}\n---\nSparkly.')).includes('hazard_near_target'))
  assert.ok(codes(V('{act:approach,args:{target:lava_1}}\n---\nx')).includes('id_wrong_kind'))
  assert.ok(codes(V('{act:move_to,args:{x:46,y:69,z:-11}}\n---\nx')).includes('hazard_near_target'))
  assert.ok(V('{act:move_to,args:{x:30,y:70,z:-12}}\n---\nx').ok)
})
test('threats: close hostile + low hp rejects passive; approach hostile always rejected', () => {
  const d = dg({ health: 8, nearby: [{ id: 'zombie_1', kind: 'zombie', cat: 'hostile', dist: 4, pos: [44, 70, -12] }], hazards: [] })
  assert.ok(codes(V('{act:idle_activity,args:{kind:look_around}}\n---\nHm.', d)).includes('threat_ignored'))
  assert.ok(V('{act:flee,args:{from:zombie_1}}\n---\nRun.', d).ok)
  assert.ok(codes(V('{act:approach,args:{target:zombie_1}}\n---\nx', dg({ health: 20, nearby: d.nearby, hazards: [] }))).includes('approach_hostile'))
})
test('move_to onto a hostile is rejected', () => {
  const d = dg({ nearby: [{ id: 'zombie_1', kind: 'zombie', cat: 'hostile', dist: 5, pos: [44, 70, -9] }], hazards: [] })
  assert.ok(codes(V('{act:move_to,args:{x:44,y:70,z:-9}}\n---\nx', d)).includes('move_to_hostile'))
})
test('injured, sleep, inventory, repeat', () => {
  assert.ok(codes(V('{act:explore,args:{}}\n---\nx', dg({ health: 4, nearby: [], hazards: [] }))).includes('injured'))
  assert.ok(codes(V('{act:sleep,args:{}}\n---\nx')).includes('sleep_daytime'))
  const night = dg({ time: { day: 3, phase: 'night' }, nearby: [], hazards: [] })
  assert.ok(codes(V('{act:sleep,args:{}}\n---\nx', night)).includes('no_bed'))
  assert.ok(V('{act:sleep,args:{}}\n---\nx', { ...night, places: [{ id: 'bed_1', kind: 'bed', pos: [0, 64, 0] }] }).ok)
  assert.ok(codes(V('{act:collect,args:{resource:wood}}\n---\nx', dg({ free_slots: 0 }))).includes('inventory_full'))
  const rec = Array(3).fill({ goal: 'explore', args: {} })
  assert.ok(codes(V('{act:explore,args:{}}\n---\nx', dg(), { recent: rec })).includes('repeat_goal'))
  assert.ok(V('{act:none,args:{}}\n---\nx', dg(), { recent: Array(5).fill({ goal: 'none', args: {} }) }).ok)
})
test('speech: reply required when a human spoke; header-like speech rejected', () => {
  const d = dg({ chat: [{ from: 'Alex', text: 'hi' }] })
  assert.ok(codes(V('{act:none,args:{}}\n---\n', d)).includes('reply_missing'))
  assert.ok(codes(V('{act:none,args:{}}\n---\nsure {act:flee,args:{}}')).includes('speech_format'))
  assert.ok(V('{act:none,args:{}}\n---\n').warnings.some((w) => w.code === 'silent'))
})
test('intent object and event schema', () => {
  const v = V('{act:follow,args:{target:Alex}}\n---\nOk.')
  const i = makeIntent(v, dg(), { intent_id: 'i1', now: 1000 })
  assert.deepEqual(validateIntent(i), []); assert.equal(i.v, 1); assert.equal(i.plan_id, null)
  assert.ok(i.constraints.avoid.includes('lava_1')); assert.ok(!intentExpired(i, 1000 + 5000)); assert.ok(intentExpired(i, 1000 + 121_000))
  assert.ok(validateIntent({ ...i, goal: 'dance' }).length)
  assert.ok(validateEvent({ type: 'report', intent_id: 'i1', status: 'blocked', reason_code: 'stuck' }).ok)
  assert.ok(!validateEvent({ type: 'report', intent_id: 'i1', status: 'weird' }).ok)
  assert.ok(!validateEvent({ type: 'report', intent_id: 'i1', status: 'done', reason_code: 'nope' }).ok)
  assert.ok(!validateEvent({ type: 'human_speech', from: 'a' }).ok)
  assert.ok(!validateEvent({ type: 'bogus' }).ok)
})
test('templates and speech policy are deterministic, no LLM', () => {
  assert.equal(templateLine('failed', 'a'), templateLine('failed', 'a'))
  assert.equal(speechPolicy('preempted', 'reflex').template, null); assert.ok(speechPolicy('preempted', 'reflex').cancel_speech)
  assert.ok(speechPolicy('failed', 'stuck').template); assert.ok(!speechPolicy('done', 'ok').cancel_speech)
  assert.deepEqual(splitSentences('Hi there. How are you? Fine!'), ['Hi there.', 'How are you?', 'Fine!'])
})
test('validation runs well under 50 ms', () => {
  const t = performance.now(); for (let i = 0; i < 200; i++) V('{act:approach,args:{target:cow_1}}\n---\nA cow.')
  assert.ok((performance.now() - t) / 200 < 5)
})
test('vocabulary is the closed list', () => { assert.ok(SKILL_NAMES.includes('none') && SKILL_NAMES.length >= 10) })

test('Q1: a closing --- after the speech is not part of the speech', () => {
  const r = parseOutput("{act:none,args:{}}\n---\nI'm tired but safe for now, and that social need is nagging at me.\n---")
  assert.equal(r.ok, true); assert.equal(r.speech, "I'm tired but safe for now, and that social need is nagging at me.")
  assert.ok(r.warnings.some((w) => w.code === 'trailing_delimiter'))
  const e = parseOutput('{act:none,args:{}}\n---\nOne sentence — and another thought.')
  assert.equal(e.speech, 'One sentence — and another thought.', 'a dash inside the speech stays')
})

test('V4: CHAT section is parsed (tolerant), reaches the intent, and chat human_speech keeps via and dist', async () => {
  const p = parseOutput('{act:none,args:{}}\n---\nTHINK: far away\nSAY: Hi nearby.\nCHAT: Hello everyone, I am by the lake!')
  assert.equal(p.chat, 'Hello everyone, I am by the lake!'); assert.equal(p.speech, 'Hi nearby.')
  assert.equal(parseOutput('{act:none,args:{}}\n---\n**Chat**: yo').chat, 'yo')
  assert.equal(parseOutput('{act:none,args:{}}\n---\nSAY: only voice').chat, '')
  const e = validateEvent({ type: 'human_speech', from: 'Far', text: 'hi', via: 'chat', dist: 300.04 })
  const ev = e.event ?? e.ev ?? e; assert.equal(ev.via, 'chat'); assert.equal(ev.dist, 300)
})
