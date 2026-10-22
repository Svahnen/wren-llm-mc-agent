import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { loadAll, loadMind, readJsonl } from '../lib/data.mjs'
import { analyze, skillRows } from '../lib/analyze.mjs'
import { entropy, pct, esc, compass, mdToHtml, ymd } from '../lib/util.mjs'
import { buildJournal } from '../lib/journal-text.mjs'
import { buildReport } from '../build-report.mjs'
import { writeJournals, llmParagraph } from '../journal.mjs'
import { createServer } from '../serve.mjs'

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const opts = { logsDir: path.join(FX, 'logs'), runtimeDir: path.join(FX, 'runtime'), brainDir: path.join(FX, 'brain'), root: '/nonexistent-root' }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wren-report-'))
const model = async () => { const L = loadAll(opts); return { L, m: analyze({ events: L.trace.events, metrics: L.metrics, heat: L.heat, landmarks: L.landmarks, brain: L.brain, now: L.trace.events.at(-1).ts + 1000 }) } }

test('util: entropy, percentile, escaping, compass', () => {
  assert.equal(entropy({ a: 5 }).bits, 0)
  assert.ok(Math.abs(entropy({ a: 1, b: 1 }).bits - 1) < 1e-9)
  assert.equal(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10)
  assert.equal(pct([], 95), null)
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  assert.match(compass(0, -100), /100 blocks north of home/)
  assert.match(mdToHtml('# T\n- a **b**\n<script>'), /<h1>T<\/h1>\n<ul>\n<li>a <b>b<\/b><\/li>\n<\/ul>\n<p>&lt;script&gt;<\/p>/)
})

test('loaders skip corrupt lines and missing dirs', () => {
  assert.equal(readJsonl(path.join(FX, 'nope.jsonl')).length, 0)
  const L = loadAll(opts)
  assert.ok(L.trace.events.length > 40)
  assert.equal(loadAll({ ...opts, logsDir: '/nonexistent', brainDir: '/nonexistent', runtimeDir: '/nonexistent' }).trace.events.length, 0)
})

test('analyze: fixture numbers', async () => {
  const { m } = await model()
  assert.equal(m.sessions.length, 2)
  assert.equal(m.restarts, 1)
  assert.equal(m.uptime_s, 420 + 100)
  assert.equal(m.deaths.length, 1)
  assert.deepEqual(m.deaths[0].pos, [-120.4, 64, 70.2])
  assert.equal(m.reflexes.lava_fire, 1)
  assert.equal(m.stuck.events.length, 2)
  assert.deepEqual(m.stuck.byType, { no_progress: 1, stuck_in_hole: 1 })
  assert.equal(m.stuck.unrecovered, 1)
  assert.equal(m.stuck.p95Ms, 60000)
  assert.equal(m.stuck.maxMs, 60000)
  assert.equal(m.stuck.layers.nudge, 1)
  assert.equal(m.reconnects, 1)
  assert.equal(m.lag.warns, 1)
  assert.equal(m.lag.p99max, 20)
  assert.equal(m.lag.maxEver, 120)
  assert.equal(m.goalSource, 'habit_choice')
  assert.equal(m.habitCounts.wander, 4)
  assert.equal(m.heatStats.cells, 5)
  assert.equal(m.home.x, -140)
  const w = skillRows(m).find((r) => r.name === 'wander')
  assert.equal(w.started, 4); assert.equal(w.done, 2); assert.equal(w.failed, 2); assert.equal(w.failRate, 0.5)
  assert.equal(w.reasons.NoPath, 2)
  assert.equal(m.brain.intents.length, 1); assert.equal(m.brain.humanEvents, 1); assert.equal(m.brain.invalid, 1)
})

test('analyze: empty input does not throw', () => {
  const m = analyze({})
  assert.equal(m.empty, true); assert.equal(m.uptime_s, 0)
})

test('report html: sections, no scripts, escaping, empty sections', async () => {
  const { html } = await buildReport({ ...opts, journalDir: '/nonexistent' })
  for (const id of ['timeline', 'events', 'habits', 'map', 'metrics', 'skills', 'mind', 'brain', 'verified']) assert.match(html, new RegExp(`id="${id}"`))
  assert.match(html, /prefers-color-scheme:dark/)
  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/)
  assert.match(html, /No mind SQLite DB found/)
  assert.doesNotMatch(html, /<b>now<\/b>/) // speech must be escaped
  assert.match(html, /&lt;b&gt;now&lt;\/b&gt;/)
  assert.match(html, /Not verified/)
  assert.match(html, /<svg[^>]*viewBox/)
})

test('report: totally empty inputs still produce a page', async () => {
  const d = tmp()
  const { html } = await buildReport({ root: d, logsDir: path.join(d, 'l'), runtimeDir: path.join(d, 'r'), brainDir: path.join(d, 'b'), journalDir: path.join(d, 'j') })
  assert.match(html, /no data/); assert.match(html, /No trace events yet/); assert.match(html, /No heatmap data/)
})

test('mind DB is read read-only and rendered', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const d = tmp(), f = path.join(d, 'mind.sqlite')
  const db = new DatabaseSync(f)
  db.exec(`CREATE TABLE lessons(id INTEGER PRIMARY KEY, goal_type TEXT, cell TEXT, x REAL, y REAL, z REAL, approach TEXT, result TEXT, cause TEXT, extent REAL, strength REAL, count INTEGER, created_t REAL, last_t REAL, used_count INTEGER, changed_count INTEGER);
    CREATE TABLE preferences(activity TEXT PRIMARY KEY, pleasant_count INTEGER, days TEXT, status TEXT, first_t REAL, last_t REAL);
    CREATE TABLE self_summary(version INTEGER PRIMARY KEY, t REAL, text TEXT, author TEXT);`)
  const { m: m0 } = await model()
  const dt = m0.deaths[0].ts
  db.prepare('INSERT INTO lessons(goal_type,cell,result,cause,count,created_t,last_t,used_count,changed_count) VALUES(?,?,?,?,?,?,?,?,?)').run('wander', '-15,8', 'death', 'lava', 2, dt / 1000, dt / 1000, 3, 1)
  db.prepare('INSERT INTO preferences VALUES(?,?,?,?,?,?)').run('fishing', 4, '[1,2,3]', 'preference', 1, 2)
  db.prepare('INSERT INTO self_summary VALUES(1,1,?,?)').run('I like the lake <3', 'self')
  db.close()
  const before = fs.statSync(f).mtimeMs
  const mind = await loadMind(f)
  assert.equal(mind.lessons.length, 1); assert.equal(mind.preferences[0].activity, 'fishing')
  assert.equal(fs.statSync(f).mtimeMs, before)
  const { html } = await buildReport({ ...opts, mindDb: f, journalDir: '/nonexistent' })
  assert.match(html, /Lessons learned/); assert.match(html, /fishing/); assert.match(html, /I like the lake &lt;3/)
  assert.match(html, /3 retrieved, 1 changed/)
  const L = loadAll(opts)
  const md = buildJournal({ events: L.trace.events, brain: L.brain, mind, landmarks: L.landmarks, day: ymd(dt) })
  assert.match(md, /The lesson she recorded: cause lava while doing wander/)
  assert.match(md, /Lessons:\n- wander: death \(lava\)/)
})

test('journal: deterministic third person text', async () => {
  const L = loadAll(opts)
  const day = ymd(L.trace.events[0].ts)
  const a = buildJournal({ events: L.trace.events, brain: L.brain, landmarks: L.landmarks, day })
  const b = buildJournal({ events: L.trace.events, brain: L.brain, landmarks: L.landmarks, day })
  assert.equal(a, b)
  assert.match(a, /^# Wren's life journal: /)
  assert.match(a, /She died once/)
  assert.match(a, /gathered wood/); assert.match(a, /ate/); assert.match(a, /crafted things/)
  assert.match(a, /lava fire x1/); assert.match(a, /She got stuck 2 times/)
  assert.match(a, /blocks .* of home/)
  assert.match(a, /A human spoke to her once \(Alex\)/)
  assert.match(a, /She decided to gather wood and said: "I need wood/)
  assert.doesNotMatch(a, /\bI\b(?! need wood)/) // no first person outside her quoted speech
  assert.match(buildJournal({ events: [], day: '2020-01-01' }), /No trace or brain data/)
})

test('journal files: written once, unchanged on rerun, llm hook off by default and optional', async () => {
  const d = tmp()
  const r1 = await writeJournals({ ...opts, outDir: d })
  assert.ok(r1.written.length >= 1)
  const f = path.join(d, r1.days[0] + '.md')
  const mt = fs.statSync(f).mtimeMs
  const r2 = await writeJournals({ ...opts, outDir: d })
  assert.equal(r2.written.length, 0); assert.equal(fs.statSync(f).mtimeMs, mt)
  assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /Optional model paragraph/)
  const d2 = tmp()
  await writeJournals({ ...opts, outDir: d2, llmEndpoint: 'http://x', llmFn: async () => '\n## Optional model paragraph (LLM-written, not verified against the logs)\n\nhi\n' })
  assert.match(fs.readFileSync(path.join(d2, r1.days[0] + '.md'), 'utf8'), /Optional model paragraph/)
  const d3 = tmp()
  await writeJournals({ ...opts, outDir: d3, llmEndpoint: 'http://x', llmFn: async () => { throw new Error('down') } })
  assert.doesNotMatch(fs.readFileSync(path.join(d3, r1.days[0] + '.md'), 'utf8'), /Optional model paragraph/)
  const par = await llmParagraph('text', 'http://h:1', 'm', async (url, init) => { assert.equal(url, 'http://h:1/v1/chat/completions'); return { ok: true, json: async () => ({ choices: [{ message: { content: ' para ' } }] }) } })
  assert.match(par, /para/)
})

test('serve: read-only static, no traversal', async () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'report.html'), '<p>hi</p>'); fs.writeFileSync(path.join(path.dirname(d), 'secret-' + path.basename(d)), 'x')
  const srv = createServer(d); await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const get = (p, method = 'GET') => new Promise((res) => http.request({ port, host: '127.0.0.1', path: p, method }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ code: r.statusCode, body: b })) }).end())
  assert.equal((await get('/')).body, '<p>hi</p>')
  assert.equal((await get('/nope')).code, 404)
  assert.equal((await get('/..%2fsecret-' + path.basename(d))).code, 403)
  assert.equal((await get('/report.html', 'POST')).code, 405)
  const withHost = (h) => new Promise((res) => http.request({ port, host: '127.0.0.1', path: '/', headers: { host: h } }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)) }).end())
  assert.equal(await withHost('evil.example.com'), 403)       // N7: DNS-rebinding guard
  assert.equal(await withHost('evil.example.com:8890'), 403)
  assert.equal(await withHost('127.0.0.1:8890'), 200); assert.equal(await withHost('localhost'), 200)
  srv.close()
})

test('CLI entry works through a symlinked path and with empty inputs', async () => {
  const { execFileSync } = await import('node:child_process')
  const d = tmp(), link = path.join(d, 'lnk'); fs.symlinkSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), link)
  const out = path.join(d, 'o', 'report.html')
  const so = execFileSync('node', [path.join(link, 'build-report.mjs'), '--out', out, '--logs-dir', path.join(d, 'none'), '--runtime-dir', path.join(d, 'none'), '--brain-dir', path.join(d, 'none'), '--journal-dir', path.join(d, 'none')], { encoding: 'utf8', cwd: d })
  assert.match(so, /^report: /); assert.ok(fs.statSync(out).size > 1000)
  const jo = execFileSync('node', [path.join(link, 'journal.mjs'), '--out-dir', path.join(d, 'j'), '--logs-dir', path.join(d, 'none'), '--runtime-dir', path.join(d, 'none'), '--brain-dir', path.join(d, 'none'), '--mind-db', path.join(d, 'none.sqlite')], { encoding: 'utf8', cwd: d })
  assert.match(jo, /^journal: 1 day/)
  assert.equal(fs.readdirSync(path.join(d, 'j')).length, 1)
})

