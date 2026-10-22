// S1G: mindlink hands a goal intent (type/target/intent text) to System 1, applies S2's place notes, and reports the outcome back to S2.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { installMindlink } from '../src/mindlink/index.js'
import { Landmarks } from '../src/skills/landmarks.js'
import { Heatmap } from '../src/heatmap.js'
import { brainDigest, worldFacts } from '../src/mindlink/digest.js'
import { makeRig, sleep } from './helpers.js'

const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(JSON.parse(s || '{}'))) })
const intent = (extra = {}) => ({ v: 1, intent_id: 'i-goal-1', goal: 'pursue', args: { type: 'get_food' }, goal_spec: { type: 'get_food', target: null, text: 'find something to eat', hash: 'abc', via_act: false },
  modulators: { urgency: 0.8, caution: 0.2, sociability: 0 }, constraints: { avoid: [] }, ttl_s: 600, interruptible: true, created_at_ms: Date.now(), place_ops: [{ op: 'remember', name: 'berry_patch', note: 'sweet berries' }], ...extra })

test('goal intent: place note applied, S1 pursues with S2 modulators, outcome reported with reason_code', async () => {
  const events = []; let served = false
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const send = (j) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
    if (req.method === 'POST' && u.pathname === '/event') { events.push(await readBody(req)); return send({ accepted: true }) }
    if (req.method === 'GET' && u.pathname === '/intent') { if (!served) { served = true; return send({ v: 1, seq: 1, changed: true, intent: intent(), speech: { intent_id: 'i-goal-1', text: 'I will look for food.', kind: 'say' }, autonomy: 'high' }) } await sleep(300); return send({ seq: 1, changed: false }) }
    send({})
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const r = makeRig(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1g-ml-'))
  const body = Object.assign(new EventEmitter(), { spawned: true, bot: r.bot })
  Object.assign(r.bot, { username: 'Wren', chats: [], players: {}, entities: {}, time: { timeOfDay: 6000, age: 100 }, inventory: { items: () => [], emptySlotCount: () => 20 }, findBlocks: () => [], blockAt: () => null, food: 10, game: { dimension: 'minecraft:overworld' } })
  r.bot.entity.position = { x: 10.2, y: 70, z: -4.4, distanceTo: () => 3 }; r.bot.chat = (t) => r.bot.chats.push(t)
  const landmarks = new Landmarks({ file: path.join(dir, 'lm.json') })
  const pursued = []; let finishCb = null, cancelled = 0
  const s1 = { active: () => pursued.length > 0 && !finishCb.done, pursue: (spec, o) => { pursued.push({ spec, o }); return o.intent_id }, cancel: async () => { cancelled++ }, setOnFinish: (fn) => { finishCb = fn } }
  const hooks = { events: new EventEmitter(), setDrivesProvider() {}, addCostProvider() {}, setLockoutProvider() {} }
  const app = { cfg: { runtimeDir: dir, logDir: dir, username: 'Wren' }, body, hooks, intents: { hasLive: () => false }, runner: r.runner, arbiter: r.arbiter, habits: { setSteer() {}, setConversing() {}, setDrives() {} },
    pack: { env: { landmarks, heatmap: new Heatmap() } }, trace: r.trace, submitIntent: () => assert.fail('a goal intent must not go through the S2 skill path'), s1 }
  const ml = installMindlink(app, { mind: false, brain: true, brainUrl: `http://127.0.0.1:${srv.address().port}`, voice: false })
  body.emit('bot', r.bot); ml.start()
  for (let i = 0; i < 40 && !pursued.length; i++) await sleep(50)
  assert.equal(pursued.length, 1); assert.equal(pursued[0].spec.type, 'get_food'); assert.equal(pursued[0].spec.text, 'find something to eat'); assert.equal(pursued[0].spec.mods.urgency, 0.8)
  assert.equal(pursued[0].o.intent_id, 'i-goal-1')
  assert.equal(Math.round(landmarks.get('berry_patch').x), 10); assert.equal(landmarks.get('berry_patch').note, 'sweet berries')
  await sleep(100); assert.ok(events.some((e) => e.type === 'report' && e.intent_id === 'i-goal-1' && e.status === 'started'))
  finishCb({ intent_id: 'i-goal-1', status: 'failed', reason_code: 'options_exhausted', reason: 'every option failed', summary: 'get_food: every option failed. Tried: hunt failed x1 (no_animal_nearby)', steps: 3, ms: 9000 })
  for (let i = 0; i < 100 && !events.some((e) => e.type === 'report' && e.status === 'failed'); i++) await sleep(50)
  const fail = events.find((e) => e.type === 'report' && e.status === 'failed'); assert.ok(fail, JSON.stringify(events.map((e) => e.type + ':' + e.status)))
  assert.equal(fail.reason_code, 'options_exhausted')
  assert.ok(ml.S.events.some((e) => /could not get you what you wanted .*hunt failed/.test(e)), 'S2 sees what was tried'); assert.ok(ml.S.events.some((e) => /you saved "berry_patch"/.test(e)))
  assert.ok(ml.S.recent.some((x) => x.goal === 'pursue' && x.status === 'failed'))
  ml.brain.stop(); await ml.stop?.(); await new Promise((x) => { srv.closeAllConnections?.(); srv.close(x) }); fs.rmSync(dir, { recursive: true, force: true })
})

test('digest carries F3 facts and annotated places (note, nearest first); worldFacts reads yaw/biome/dimension/light/clock', () => {
  const bot = { username: 'W', health: 20, food: 20, entity: { position: { x: 0, y: 64, z: 0, floored() { return this } }, yaw: 0 }, entities: {}, players: {}, time: { timeOfDay: 6000, age: 24000 }, inventory: { items: () => [], emptySlotCount: () => 3 },
    game: { dimension: 'minecraft:overworld' }, blockAt: () => ({ biome: { name: 'minecraft:plains' }, light: 11, skyLight: 15 }), findBlocks: () => [] }
  const lm = new Landmarks(); lm.set('far', { x: 90, y: 64, z: 0 }, 'place'); lm.set('near', { x: 0, y: 64, z: -10 }, 'place'); lm.places.near.note = 'fishing'
  const d = brainDigest(bot, { landmarks: lm, hazards: [], explored: { cells: 3, biomes: ['plains'], unexplored: ['north'] } })
  assert.deepEqual(d.facing, { yaw: -180, compass: 'north' }); assert.equal(d.biome, 'plains'); assert.equal(d.dimension, 'overworld'); assert.equal(d.light, 15); assert.equal(d.clock, '12:00')
  assert.deepEqual(d.places.map((p) => p.id), ['near', 'far']); assert.equal(d.places[0].note, 'fishing'); assert.equal(d.explored.cells, 3)
  assert.deepEqual(worldFacts({ entity: {}, blockAt: () => null }), {})
})

test('regression: template lines ("That failed, I will rethink.") are never spoken or chatted; S2 gets an event; contract tokens never reach chat', async () => {
  let served = 0
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const send = (j) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
    if (req.method === 'POST' && u.pathname === '/event') { await readBody(req); return send({ accepted: true }) }
    if (req.method === 'GET' && u.pathname === '/intent') { if (!served++) return send({ v: 1, seq: 1, changed: true, template_line: { text: 'That failed, I will rethink.' }, intent: { v: 1, intent_id: 'i-n', goal: 'none', args: {}, modulators: {}, constraints: { avoid: [] }, ttl_s: 20, interruptible: true, created_at_ms: Date.now() }, speech: { intent_id: 'i-n', text: 'serve: G2', kind: 'say' } }); await sleep(300); return send({ seq: 1 }) }
    send({})
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const r = makeRig(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1g-tpl-'))
  const body = Object.assign(new EventEmitter(), { spawned: true, bot: r.bot })
  Object.assign(r.bot, { username: 'Wren', chats: [], players: { Sam: { entity: { position: { x: 2, y: 64, z: 0, distanceTo: () => 2 } } } }, entities: {}, time: { timeOfDay: 6000, age: 100 }, inventory: { items: () => [], emptySlotCount: () => 20 }, findBlocks: () => [], blockAt: () => null })
  r.bot.entity.position = { x: 0, y: 64, z: 0, distanceTo: () => 2 }; r.bot.chat = (t) => r.bot.chats.push(t)
  const app = { cfg: { runtimeDir: dir, logDir: dir, username: 'Wren' }, body, hooks: { events: new EventEmitter(), setDrivesProvider() {}, addCostProvider() {}, setLockoutProvider() {} }, intents: { hasLive: () => false }, runner: r.runner, arbiter: r.arbiter, habits: { setSteer() {}, setConversing() {}, setDrives() {} }, pack: { env: { landmarks: new Landmarks(), heatmap: new Heatmap() } }, trace: r.trace, submitIntent: () => ({ ok: true }) }
  const ml = installMindlink(app, { mind: false, brain: true, brainUrl: `http://127.0.0.1:${srv.address().port}`, voice: false })
  body.emit('bot', r.bot); ml.start(); await sleep(1500)
  assert.deepEqual(r.bot.chats, [], JSON.stringify(r.bot.chats))
  assert.ok(ml.S.events.some((e) => /decide yourself whether to say anything/.test(e)))
  ml.brain.stop(); await ml.stop?.(); await new Promise((x) => { srv.closeAllConnections?.(); srv.close(x) }); fs.rmSync(dir, { recursive: true, force: true })
})
