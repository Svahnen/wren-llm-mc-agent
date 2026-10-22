import test from 'node:test'
import assert from 'node:assert/strict'
import { S2Scheduler } from '../scheduler.js'
import { wait } from './helpers.js'

const mk = (run, o = {}) => new S2Scheduler({ run, ...o })
const ev = (type, x = {}) => ({ type, ...x })

test('priority order: human > blocked > drive > heartbeat > reflection', async () => {
  const order = []; let release
  const gate = new Promise((r) => (release = r))
  const s = mk(async (job) => { order.push(job.kind); if (job.kind === 'drive_wake' && order.length === 1) await gate; return {} }, { deadlines: { drive_wake: 5000 } })
  s.push(ev('drive_wake', { drive: 'hunger' })) // occupies slot 1
  await wait(10)
  s.push(ev('reflection_due')); s.push(ev('heartbeat')); s.push(ev('report', { status: 'blocked', intent_id: 'a' }))
  s.push(ev('human_speech', { from: 'x', text: 'hi' }))
  await wait(30); release(); await wait(80)
  assert.deepEqual(order, ['drive_wake', 'human_speech', 'blocked', 'heartbeat', 'reflection'])
  s.close()
})
test('coalescing: same-type events within 2 s merge into one job', async () => {
  let runs = 0; let hold
  const s = mk(async (job) => { runs++; if (runs === 1) await new Promise((r) => (hold = r)); return {} })
  s.push(ev('heartbeat')); await wait(5)
  const a = s.push(ev('report', { status: 'failed', intent_id: '1' })), b = s.push(ev('report', { status: 'failed', intent_id: '2' }))
  assert.ok(!a.coalesced); assert.ok(b.coalesced); assert.equal(a.job_id, b.job_id)
  s.supersedeInflight = false
  s.push(ev('human_speech', { from: 'a', text: 'one' })) // goes straight in flight (slot 0 free)
  s.push(ev('human_speech', { from: 'a', text: 'two' })); const h3 = s.push(ev('human_speech', { from: 'a', text: 'three' }))
  assert.ok(h3.coalesced); assert.equal(s.queue.find((j) => j.kind === 'human_speech').events.length, 2)
  assert.equal(s.stats.coalesced, 2); hold(); s.close()
})
test('max depth drops the oldest of the LOWEST priority, never the human line', async () => {
  const s = mk(() => new Promise(() => {}), { maxDepth: 3, deadlines: { drive_wake: 60000 } })
  s.push(ev('drive_wake', { drive: 'x' })); await wait(5) // in flight, blocks slot 1
  s.push(ev('reflection_due')); s.push(ev('human_speech', { from: 'a', text: 'q' })); await wait(5)
  s.queue.length = 0 // reset for deterministic fill
  s.push(ev('reflection_due', { n: 1 })); s.queue[0].firstAt -= 10; s.push(ev('report', { status: 'failed', intent_id: 'z' })); s.push(ev('report', { status: 'blocked', intent_id: 'y' }))
  const r = s.push(ev('human_speech', { from: 'a', text: 'q2' }))
  assert.equal(r.dropped?.kind, 'reflection'); assert.equal(s.stats.dropped_depth, 1)
  assert.ok(s.queue.some((j) => j.kind === 'human_speech'))
  s.close()
})
test('deadline: slow call is aborted, result is dropped, not applied', async () => {
  const applied = []
  const s = mk(async (job, { signal }) => { await wait(150); return { v: 1 } }, { deadlines: { human_speech: 40 }, on: { result: (r) => applied.push(r) } })
  s.push(ev('human_speech', { from: 'a', text: 'hi' }))
  await wait(250)
  assert.equal(applied.length, 0); assert.equal(s.stats.late_dropped, 1); assert.equal(s.stats.failed, 1)
  assert.equal(s.inflight[0], null); s.close()
})
test('deadline is enforced even if run() ignores the abort signal', async () => {
  const s = mk(() => new Promise(() => {}), { deadlines: { heartbeat: 30 } })
  s.push(ev('heartbeat')); await wait(120)
  assert.equal(s.inflight[1], null); assert.equal(s.stats.failed, 1); s.close()
})
test('sleep pass refused when a human is present, accepted otherwise, one at a time', async () => {
  let human = true; const kinds = []
  const s = mk(async (j) => { kinds.push(j.kind); await wait(30); return {} }, { humanPresent: () => human })
  assert.equal(s.requestSleepPass().reason, 'human_present')
  human = false
  assert.ok(s.requestSleepPass().accepted); assert.equal(s.requestSleepPass().accepted, false)
  await wait(80); assert.deepEqual(kinds, ['sleep_pass']); s.close()
})
test('human speech aborts a running reflection/sleep pass and waits for dialogue', async () => {
  const log = []
  const s = mk(async (j, { signal }) => { log.push('start:' + j.kind); await new Promise((res, rej) => { signal.addEventListener('abort', () => rej(new Error('aborted'))); if (j.kind === 'human_speech') setTimeout(res, 20) }); log.push('end:' + j.kind); return {} }, { deadlines: { reflection: 5000 } })
  s.push(ev('reflection_due')); await wait(10)
  s.push(ev('human_speech', { from: 'a', text: 'hey' })); await wait(80)
  assert.deepEqual(log, ['start:reflection', 'start:human_speech', 'end:human_speech'])
  assert.equal(s.stats.failed, 0, 'our own abort is not an S2 fault'); s.close()
})
test('background jobs wait while dialogue is active', async () => {
  const log = []
  const s = mk(async (j) => { log.push('s:' + j.kind); await wait(40); log.push('e:' + j.kind); return {} })
  s.push(ev('human_speech', { from: 'a', text: 'x' })); s.push(ev('heartbeat')); await wait(150)
  assert.deepEqual(log, ['s:human_speech', 'e:human_speech', 's:heartbeat', 'e:heartbeat']); s.close()
})
test('stale queued jobs are dropped before start', async () => {
  const ran = []
  const s = mk(async (j) => { ran.push(j.kind); await wait(60); return {} }, { maxAgeMs: { heartbeat: 20 } })
  s.push(ev('human_speech', { from: 'a', text: 'x' })); s.push(ev('heartbeat')); await wait(150)
  assert.deepEqual(ran, ['human_speech']); assert.equal(s.stats.dropped_stale, 1); s.close()
})
test('S2-offline mode: trips after N failures, drops non-human events, probes, recovers', async () => {
  let fail = true; const flags = []
  const s = mk(async () => { if (fail) throw new Error('boom'); return {} }, { offline: { failThreshold: 2, probeIntervalMs: 60 }, on: { offline: (o) => flags.push(o.offline) } })
  s.push(ev('heartbeat')); await wait(10); s.push(ev('drive_wake', { drive: 'a' })); await wait(20)
  assert.equal(s.s2Offline, true); assert.equal(s.status().habits_only, true)
  assert.equal(s.push(ev('heartbeat')).reason, 's2_offline')
  await wait(70); fail = false
  assert.ok(s.push(ev('heartbeat')).accepted, 'probe let through after interval'); await wait(30)
  assert.equal(s.s2Offline, false); assert.deepEqual(flags, [true, false]); s.close()
})
test('offline: human speech notifies a template hook', async () => {
  let n = 0; const s = mk(async () => ({}), { on: { offlineEvent: () => n++ } })
  s.setOffline(true, 'gpu-lock'); s.push(ev('human_speech', { from: 'a', text: 'hi' })); assert.equal(n, 1); assert.equal(s.status().offline_reason, 'gpu-lock'); s.close()
})
test('budget: soft cap drops low-priority, human still allowed; hard cap drops all', async () => {
  const s = mk(async () => ({ tokens: 10 }), { budget: { windowMs: 60000, maxCalls: 2, maxTokens: 1e9, hardFactor: 2 } })
  s.push(ev('heartbeat')); await wait(10); s.push(ev('drive_wake', { drive: 'x' })); await wait(10)
  assert.equal(s.push(ev('heartbeat')).reason, 'budget')
  assert.ok(s.push(ev('human_speech', { from: 'a', text: 'x' })).accepted); await wait(10)
  s.push(ev('report', { status: 'failed', intent_id: 'q' })); await wait(10)
  assert.equal(s.push(ev('human_speech', { from: 'a', text: 'again' })).reason, 'budget')
  assert.ok(s.status().stats.dropped_budget >= 2); s.close()
})
test('new human message supersedes in-flight human job and carries the old text', async () => {
  const seen = []
  const s = mk(async (j, { signal }) => { seen.push(j.events.map((e) => e.text)); await new Promise((res, rej) => { signal.addEventListener('abort', () => rej(new Error('x'))); setTimeout(res, 50) }); return {} })
  s.push(ev('human_speech', { from: 'a', text: 'one' })); await wait(10); s.push(ev('human_speech', { from: 'a', text: 'two' })); await wait(120)
  assert.deepEqual(seen, [['one'], ['one', 'two']]); s.close()
})

test('V3: a human utterance aborts a running heartbeat (single LLM) and takes the dialogue slot at once; wait_ms is measured', async () => {
  const log = []
  const s = mk(async (j, { signal }) => { log.push('start:' + j.kind); await new Promise((res, rej) => { signal.addEventListener('abort', () => rej(new Error('aborted'))); if (j.kind === 'human_speech') setTimeout(res, 10) }); log.push('end:' + j.kind); return {} }, { deadlines: { heartbeat: 5000 } })
  s.push(ev('heartbeat')); await wait(10)
  s.push(ev('human_speech', { from: 'a', text: 'Where are you going?', utt_id: 2 })); await wait(60)
  assert.deepEqual(log, ['start:heartbeat', 'start:human_speech', 'end:human_speech'])
  assert.ok(s.waits.find((w) => w.kind === 'human_speech').wait_ms < 20)
  assert.equal(s.stats.failed, 0); s.close()
})
test('V3: three utterances from one person become ONE answer job carrying all of them', async () => {
  const seen = []
  const s = mk(async (j, { signal }) => { seen.push(j.events.map((e) => e.utt_id)); await new Promise((res, rej) => { signal.addEventListener('abort', () => rej(new Error('x'))); setTimeout(res, 50) }); return {} })
  s.push(ev('human_speech', { from: 'a', text: 'one', utt_id: 1 })); await wait(5)
  s.push(ev('human_speech', { from: 'a', text: 'two', utt_id: 2 })); await wait(5)
  s.push(ev('human_speech', { from: 'a', text: 'three', utt_id: 3 })); await wait(120)
  assert.deepEqual(seen.at(-1), [1, 2, 3]); s.close()
})
