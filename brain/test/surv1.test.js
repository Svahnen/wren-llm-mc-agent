// SURV1: critical-state facts, risky food, words-are-not-actions inference/re-prompt.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDigest, validate, parseOutput, inferAction, foodKnown, RISKY_FOOD, isFood } from '../contract.js'
import { survivalOptions, renderCritical, fmtHp, isCritical } from '../survival.js'
import { buildMessages, renderDigest, fmtAgo } from '../prompt.js'
import { Brain } from '../brain.js'
import { FakeS2 } from '../fake-s2.js'
import { wait } from './helpers.js'

const NIGHT = (o = {}) => ({ time: { day: 5, phase: 'night' }, pos: [0, 64, 0], health: 2.8, food: 10, inventory: { rotten_flesh: 4, iron_sword: 1, egg: 16, cobblestone: 9, dirt: 10, stone_pickaxe: 1 }, nearby: [{ id: 'skeleton_1', kind: 'skeleton', cat: 'hostile', dist: 15 }], places: [{ id: 'home', kind: 'home', pos: [100, 64, 0], dist: 162, dir: 'east' }], ...o })

test('hp shown with a decimal below 10, never 0 while alive', () => {
  assert.equal(fmtHp(0.27), '0.3'); assert.equal(fmtHp(0.01), '0.1'); assert.equal(fmtHp(2.77), '2.8'); assert.equal(fmtHp(14.2), '14'); assert.equal(fmtHp(0), '0')
  assert.match(renderDigest(NIGHT({ health: 0.3 })), /health 0\.3\/20/)
})
test('critical state lists feasible means, fastest first, with exact numbers', () => {
  const dg = normalizeDigest(NIGHT())
  assert.ok(isCritical(dg))
  const o = survivalOptions(dg)
  assert.deepEqual(o.map((x) => x.key).slice(0, 2), ['eat', 'dig_in'])
  assert.ok(o.some((x) => x.key === 'go_refuge' && /162 m/.test(x.text)))
  assert.match(o[0].text, /rotten_flesh x4/); assert.match(o[0].text, /food is 18 or more/)
  const t = renderCritical(dg)
  assert.match(t, /CRITICAL STATE: health 2\.8\/20/); assert.match(t, /\{act:eat,args:\{item:rotten_flesh\}\}/)
  assert.equal(renderCritical(normalizeDigest(NIGHT({ health: 20, food: 20 }))), '')
})
test('critical block reaches the prompt; self-summary carries its age', () => {
  const m = buildMessages({ job: { events: [] }, digest: NIGHT(), ctx: { self_summary: 'I died a lot.', self_summary_age_s: 4 * 3600 }, autonomy: 'high' })
  assert.match(m[1].content, /CRITICAL STATE/); assert.match(m[1].content, /written 4 h ago/)
  assert.equal(fmtAgo(30), '30 s'); assert.equal(fmtAgo(7200), '2 h')
})
test('rotten flesh is valid food for eat; eggs are not', () => {
  assert.ok(RISKY_FOOD.has('rotten_flesh') && isFood('rotten_flesh') && !isFood('egg'))
  const dg = normalizeDigest(NIGHT())
  assert.equal(validate(parseOutput('{act:eat,args:{item:rotten_flesh}}\n---\nTHINK: eat'), dg, { advisory: true }).ok, true)
  const bad = validate(parseOutput('{act:eat,args:{item:egg}}\n---\nTHINK: eat'), dg, { advisory: true })
  assert.equal(bad.ok, false); assert.match(bad.errors[0].msg, /Edible: rotten_flesh x4/)
  assert.deepEqual(foodKnown(normalizeDigest(NIGHT({ health: 20, food: 15 }))).inventory, [])
  assert.deepEqual(foodKnown(dg).inventory, ['rotten_flesh'])
})
test('inferAction: one clear option maps, negation/ambiguity do not', () => {
  const dg = NIGHT()
  assert.deepEqual(inferAction({ think: 'I can eat the rotten flesh to heal.', speech: '' }, dg).hit, { act: 'eat', args: { item: 'rotten_flesh' } })
  assert.equal(inferAction({ think: 'I should not eat the rotten flesh.', speech: '' }, dg).none, true)
  assert.ok(inferAction({ think: 'Either build a shelter or eat rotten flesh', speech: '' }, dg).ambiguous)
  assert.equal(inferAction({ think: 'I will dig in right here.', speech: '' }, dg).hit.goal.type, 'build_shelter')
  assert.equal(inferAction({ think: 'I want to eat an egg', speech: '' }, dg).none, true)
})

const mk = (script) => { const llm = new FakeS2({ mode: 'scripted', script }); const logs = []; const b = new Brain({ llm, log: (e) => logs.push(e), autonomy: 'high' }); return { b, llm, logs } }
test('act:none + "eat the rotten flesh" becomes an eat intent (no extra LLM call)', async () => {
  const { b, llm, logs } = mk(['{act:none,args:{}}\n---\nTHINK: I am at 2.8 health. I should eat the rotten flesh now to start healing.'])
  b.handleEvent({ type: 'heartbeat', digest: NIGHT() }); await wait(150)
  const it = (await b.getIntent()).intent
  assert.equal(it?.goal, 'eat'); assert.equal(it.args.item, 'rotten_flesh'); assert.equal(llm.calls.length, 1)
  assert.ok(logs.some((l) => l.ev === 'action_inferred')); b.close()
})
test('critical + ambiguous words + act:none -> one re-prompt for an action line', async () => {
  const { b, llm, logs } = mk(['{act:none,args:{}}\n---\nTHINK: I will build a shelter, or maybe eat the rotten flesh first.', '{act:eat,args:{item:rotten_flesh}}\n---\nTHINK: eat first'])
  b.handleEvent({ type: 'heartbeat', digest: NIGHT() }); await wait(200)
  assert.equal(llm.calls.length, 2); assert.equal((await b.getIntent()).intent?.goal, 'eat')
  assert.ok(logs.some((l) => l.ev === 'action_reprompt' && l.ok)); b.close()
})
test('healthy and passive: nothing is inferred or re-prompted', async () => {
  const { b, llm } = mk(['{act:none,args:{}}\n---\nTHINK: I will eat the rotten flesh later.'])
  b.handleEvent({ type: 'heartbeat', digest: NIGHT({ health: 20, food: 20, nearby: [] }) }); await wait(150)
  assert.equal(llm.calls.length, 1); assert.equal((await b.getIntent()).intent?.goal, 'none'); b.close()
})
test('flee from a fish/animal is rejected, from a hostile is fine', () => {
  const dg = normalizeDigest(NIGHT({ nearby: [{ id: 'salmon_4', kind: 'salmon', cat: 'neutral', dist: 20 }, { id: 'zombie_1', kind: 'zombie', cat: 'hostile', dist: 9 }] }))
  const bad = validate(parseOutput('{act:flee,args:{from:salmon_4}}\n---\nTHINK: x'), dg, { advisory: true })
  assert.equal(bad.ok, false); assert.equal(bad.errors[0].code, 'flee_nonhostile')
  assert.equal(validate(parseOutput('{act:flee,args:{from:zombie_1}}\n---\nTHINK: x'), dg, { advisory: true }).ok, true)
})
