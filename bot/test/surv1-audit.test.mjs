// SURV1: scripts/thought-audit.mjs on synthetic logs: grouping, new/growing state, latest.md <= 15 lines, optional --llm only when the brain queue is empty.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/thought-audit.mjs')
const NOW = '2026-06-15T13:00:00.000Z'
function fixture(extraThoughts = []) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), logs = path.join(d, 'logs'), blogs = path.join(d, 'blogs'), out = path.join(d, 'out')
  fs.mkdirSync(logs); fs.mkdirSync(blogs)
  const th = (min, text, kind = 'thought') => JSON.stringify({ ts_iso: new Date(Date.parse(NOW) - min * 60000).toISOString(), text, kind })
  fs.writeFileSync(path.join(logs, 'thoughts.jsonl'), [th(1, "I'm stuck in a loop and I can't reach the pig"), th(2, 'I keep dying here'), th(3, 'I should eat the rotten flesh now', 'demoted_say'), th(200, 'old stuck thought'), ...extraThoughts].join('\n') + '\n')
  const ml = (min, o) => JSON.stringify({ t: new Date(Date.parse(NOW) - min * 60000).toISOString(), ...o })
  fs.writeFileSync(path.join(logs, 'mindlink.jsonl'), [ml(2, { ev: 'death', cause: 'skeleton' }), ml(3, { ev: 'blocked_by_mind', goal: 'collect', reason: 'repeat_cap', desc: { type: 'collect' } })].join('\n') + '\n')
  fs.writeFileSync(path.join(logs, 'trace-x.jsonl'), [ml(1, { type: 'health', hp: 0.3, food: 10 }), ml(1, { type: 'skill_end', skill: 'hunt', status: 'failed', reason: 'unreachable_animal', ms: 10 })].join('\n') + '\n')
  return { d, logs, blogs, out }
}
const run = (f, extra = [], env = {}) => execFileSync('node', [SCRIPT, '--minutes', '15', '--logs', f.logs, '--brain-logs', f.blogs, '--out', f.out, '--now', NOW, ...extra], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000 })

test('audit groups complaints and signals, window-limited, with quotes', () => {
  const f = fixture(); run(f)
  const detail = fs.readFileSync(path.join(f.out, `thought-audit-2026-06-15.md`), 'utf8'), latest = fs.readFileSync(path.join(f.out, 'latest.md'), 'utf8')
  assert.match(detail, /she writes: stuck/); assert.match(detail, /she writes: loop/); assert.match(detail, /cant reach|can't reach|cant_reach/i)
  assert.match(detail, /\*\*deaths\*\*: 1x/); assert.match(detail, /min hp 0\.3/); assert.match(detail, /repeat_cap/); assert.match(detail, /unreachable_animal/)
  assert.match(detail, /intended action came out as SAY/); assert.doesNotMatch(detail, /old stuck thought/)
  assert.ok(latest.trim().split('\n').length <= 15)
})
test('second run: only NEW or GROWING issues reach latest.md, quotes are not repeated in the detail file', () => {
  const f = fixture(); run(f)
  run(f)
  const latest = fs.readFileSync(path.join(f.out, 'latest.md'), 'utf8')
  assert.match(latest, /No new or growing issues/)
  const detail = fs.readFileSync(path.join(f.out, 'thought-audit-2026-06-15.md'), 'utf8')
  assert.equal((detail.match(/I keep dying here/g) ?? []).length, 1, 'quote listed once')
  fs.appendFileSync(path.join(f.logs, 'thoughts.jsonl'), [1, 2, 3, 4].map((i) => JSON.stringify({ ts_iso: new Date(Date.parse(NOW) - 30000 * i / 4).toISOString(), text: `stuck again ${i}`, kind: 'thought' })).join('\n') + '\n')
  run(f)
  assert.match(fs.readFileSync(path.join(f.out, 'latest.md'), 'utf8'), /GROWING she writes: stuck/)
})
function serve(handler) { return new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res(s)) }) }
const runAsync = (f, extra, env) => new Promise((res, rej) => { import('node:child_process').then(({ execFile }) => execFile('node', [SCRIPT, '--minutes', '15', '--logs', f.logs, '--brain-logs', f.blogs, '--out', f.out, '--now', NOW, ...extra], { env: { ...process.env, ...env }, timeout: 30000 }, (e, so) => (e ? rej(e) : res(so)))) })
test('--llm: skipped quietly while the brain queue is busy; runs once when empty and adds a summary', async () => {
  let llmCalls = 0, depth = 3
  const status = await serve((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ queue_depth: depth, inflight: [null, null] })) })
  const llm = await serve((q, r) => { llmCalls++; let b = ''; q.on('data', (c) => { b += c }); q.on('end', () => { assert.ok(JSON.parse(b).max_tokens <= 400); r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ choices: [{ message: { content: '1. repeated stuck (3x): "I\'m stuck" - likely the escape ladder\n2. second' } }] })) }) })
  const env = { BRAIN_STATUS_URL: `http://127.0.0.1:${status.address().port}/status`, S2_BASE_URL: `http://127.0.0.1:${llm.address().port}` }
  try {
    const f = fixture(); await runAsync(f, ['--llm'], env)
    assert.equal(llmCalls, 0, 'busy: no request'); assert.doesNotMatch(fs.readFileSync(path.join(f.out, 'latest.md'), 'utf8'), /^> /m)
    depth = 0
    const g = fixture(); await runAsync(g, ['--llm'], env)
    assert.equal(llmCalls, 1); assert.match(fs.readFileSync(path.join(g.out, 'latest.md'), 'utf8'), /^> 1\. repeated stuck/m)
    assert.match(fs.readFileSync(path.join(g.out, 'thought-audit-2026-06-15.md'), 'utf8'), /Suspected bugs/)
    assert.ok(fs.readFileSync(path.join(g.out, 'latest.md'), 'utf8').trim().split('\n').length <= 15)
  } finally { status.close(); llm.close() }
})
