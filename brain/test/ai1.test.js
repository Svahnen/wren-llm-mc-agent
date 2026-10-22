// AI1: sections (THINK/SAY/MUTTER), goal ops, advisory validator, prompt (no biased suggestions), old-format compatibility.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Brain } from '../brain.js'
import { FakeS2 } from '../fake-s2.js'
import { parseOutput, validate } from '../contract.js'
import { buildMessages, buildSystem, sensations } from '../prompt.js'
import { GoalStore } from '../../mind/goals.js'
import { dg, wait } from './helpers.js'

const quiet = () => {}
const mk = (script, o = {}) => new Brain({ llm: new FakeS2({ mode: 'scripted', script }), log: quiet, autonomy: 'high', ...o })
const hb = (d = dg()) => ({ type: 'heartbeat', digest: d })

test('parse: THINK / SAY / MUTTER / goal lines after the header', () => {
  const p = parseOutput('{act:explore,args:{direction:east}}\n---\nTHINK: The river looks promising.\nand there may be fish.\nSAY: Heading east.\nMUTTER: hm.\ngoal: find the river source\nwhy: I am curious\nplan: follow the bank; look for caves\nurgency: 0.8')
  assert.equal(p.ok, true); assert.equal(p.speech_kind, 'say'); assert.equal(p.speech, 'Heading east.')
  assert.equal(p.think, 'The river looks promising. and there may be fish.'); assert.equal(p.mutter, 'hm.')
  assert.equal(p.meta.goal, 'find the river source'); assert.equal(p.meta.mod.urgency, 0.8)
})
test('parse: old format prose stays speech (kind legacy); labels directly under the header work; --- before labels is dropped', () => {
  const o = parseOutput('{act:none,args:{}}\n---\nHello there.')
  assert.equal(o.speech, 'Hello there.'); assert.equal(o.speech_kind, 'legacy'); assert.equal(o.think, '')
  const n = parseOutput('{act:none,args:{}}\nTHINK: quiet')
  assert.equal(n.ok, true); assert.equal(n.think, 'quiet'); assert.equal(n.speech, '')
  const m = parseOutput('{act:none,args:{}}\nTHINK: a\n---\nSAY: b')
  assert.equal(m.think, 'a'); assert.equal(m.speech, 'b')
})
test('advisory: starving + chose explore is a warning, not an error, in high; hard error in classic', () => {
  const starving = dg({ food: 3, inventory: { bread: 2 } })
  const p = parseOutput('{act:explore,args:{direction:any}}\n---\nTHINK: go.')
  const hi = validate(p, starving, { advisory: true }); assert.equal(hi.ok, true); assert.ok(hi.warnings.some((w) => w.code === 'needs_starving_advisory' && w.advisory))
  const cl = validate(p, starving, {}); assert.equal(cl.ok, false)
  const bad = validate(parseOutput('{act:eat,args:{item:diamond}}\n---\nx'), starving, { advisory: true }); assert.equal(bad.ok, false, 'impossible actions stay hard errors')
})
test('brain high: advisory becomes a consequence note in the NEXT prompt, is logged, and the act proceeds', async () => {
  const logs = []
  const b = mk(['{act:explore,args:{direction:any}}\n---\nTHINK: I will risk it.', '{act:none,args:{}}\n---\nTHINK: ok'], { log: (r) => logs.push(r) })
  b.handleEvent(hb(dg({ food: 3, inventory: { bread: 2 } }))); await wait(60)
  assert.equal((await b.getIntent()).intent.goal, 'explore')
  assert.ok(logs.some((r) => r.ev === 'advisory_overridden'))
  b.handleEvent({ type: 'heartbeat', digest: dg() }); await wait(60)
  assert.match(b.llm.calls[1].messages.at(-1).content, /Heads-up \(not blocked/)
  b.close()
})
test('brain high: goals authored by S2 are stored, served by the intent, and shown in every later prompt', async () => {
  const b = mk(['{act:explore,args:{direction:east}}\n---\nTHINK: want a goal\ngoal: map the east river\nwhy: curiosity\nplan: walk east; note landmarks', '{act:none,args:{}}\n---\nTHINK: continuing'])
  b.handleEvent(hb()); await wait(60)
  const r = await b.getIntent(); assert.equal(r.intent.serves, 'G1'); assert.equal(r.goals.goals[0].text, 'map the east river'); assert.equal(r.goals.goals[0].plan.length, 2)
  b.handleEvent(hb()); await wait(60)
  assert.match(b.llm.calls[1].messages.at(-1).content, /G1 \[active.*map the east river/)
  b.close()
})
test('goal store: done/abandon/step/limit and persistence round trip', () => {
  const g = new GoalStore()
  assert.equal(g.apply({ goal: 'a', plan: 'x; y' }).created, 'G1')
  g.apply({ done: 'G1.1' }); assert.equal(g.get('G1').plan[0].done, true)
  g.apply({ goal: 'b' }); g.apply({ abandon: 'G2 too hard' }); assert.equal(g.get('G2').status, 'abandoned'); assert.equal(g.get('G2').reason, 'too hard')
  g.apply({ done: 'G1' }); assert.equal(g.get('G1').status, 'done')
  const g2 = GoalStore.fromJSON(JSON.parse(JSON.stringify(g.snapshot()))); assert.equal(g2.goals.length, 2)
  for (let i = 0; i < 8; i++) g2.apply({ goal: 'g' + i }); assert.equal(g2.active().length, 3, 'G2: at most 3 long-term goals')
})
test('prompt: high has channels + open question, no goal-biasing suggestions; classic idle keeps old behaviour', () => {
  const sys = buildSystem({ autonomy: 'high' })
  assert.match(sys, /THINK:/); assert.match(sys, /Only SAY is heard/); assert.match(sys, /do not narrate/)
  assert.doesNotMatch(sys.split('Skills:')[0], /wood|shelter|tools|craft a|progress/i)
  const m = buildMessages({ job: { events: [{ type: 'heartbeat' }] }, digest: dg(), autonomy: 'high', idle: { min: 5, choices: ['explore'] } })
  assert.match(m[1].content, /what do you want to do next, and why/i); assert.doesNotMatch(m[1].content, /for example/i); assert.doesNotMatch(m[1].content, /needs \(0 fine/)
  assert.ok(sensations(dg({ food: 3 })).some((s) => /hungry/.test(s)))
})
test('parse: goal, why and plan on one line are split', () => {
  const p = parseOutput('{act:hunt,args:{target:cow_1}}\n---\nTHINK: x\ngoal: survive and eat, why: my food is low, plan: hunt a cow; eat it')
  assert.equal(p.meta.goal, 'survive and eat'); assert.equal(p.meta.why, 'my food is low'); assert.equal(p.meta.plan, 'hunt a cow; eat it')
})
test('goal store: a copied rendered line refers to the existing goal instead of creating a duplicate', () => {
  const g = new GoalStore(); g.apply({ goal: 'find food' })
  const r = g.apply({ goal: 'G1 [active, 2 min] find food (why: hungry)' }); assert.equal(r.created, null); assert.equal(g.goals.length, 1); assert.equal(r.serves, 'G1')
})

// OPS7: prompt token budget
import { buildMessages as bmB, estTokens as estB } from '../prompt.js'
import { dg as dgB } from './helpers.js'
test('OPS7 prompt over budget is trimmed, logged, never fails', () => {
  const big = dgB({ events: Array.from({ length: 40 }, (_, i) => 'old event number ' + i + ' '.repeat(40)), places: Array.from({ length: 40 }, (_, i) => ({ id: 'place_' + i, kind: 'place', pos: [i, 64, i], dist: i })), explored: { cells: 99, biomes: ['plains', 'forest'], unexplored: ['north'] } })
  const job = { kind: 'idle', events: [] }
  const full = bmB({ job, digest: big, autonomy: 'high' })
  const slot = estB(full) - 200 + 800
  let tr = null
  const m = bmB({ job, digest: big, autonomy: 'high', budget: { slotTokens: slot, onTrim: (d) => { tr = d } } })
  assert.ok(tr && tr.before > tr.after && tr.level >= 1)
  assert.ok(estB(m) < estB(full))
  const tiny = bmB({ job, digest: big, autonomy: 'high', budget: { slotTokens: 100 } })
  assert.equal(tiny.length, 2)
  let none = false
  bmB({ job, digest: big, autonomy: 'high', budget: { slotTokens: 100000, onTrim: () => { none = true } } })
  assert.equal(none, false)
})
