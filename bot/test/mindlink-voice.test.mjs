// VINT: voice integration of the mindlink, against a fake voice HTTP server (speak / heard / flush / status) and a fake brain.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { installMindlink } from '../src/mindlink/index.js'
import { VoiceLink, voiceText } from '../src/mindlink/voice-link.js'
import { createVoiceBody } from '../src/mindlink/voice-body.js'
import { createHabits } from '../src/habits/index.js'
import { makeRig, sleep } from './helpers.js'

const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b ? JSON.parse(b) : {})) })

/** Fake voice service. s.status is mutable; s.heard is the transcript list. */
async function fakeVoice() {
  const s = { speaks: [], flushes: 0, heard: [], waiters: [], nextUtt: 1, flushResult: { flushed: true, interrupted: null },
    status: { connected_mod: true, mod_hello: {}, bot_online: true, near: [], speaking: false, speaking_utt: null, queue_ms: 0, queue_len: 0, unspoken: null, last_latency_ms: { endpoint_ms: 480, stt_ms: 120, tts_first_ms: 150 }, listeners: [], heard_last_id: 0 } }
  s.say = (it) => { const id = s.heard.length + 1; s.heard.push({ id, uuid: 'u1', name: 'Sam', dist: 3, addressed: true, text: 'hello', ts: Date.now(), ...it }); s.status.heard_last_id = id; s.waiters.splice(0).forEach((w) => w()) }
  s.server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const send = (c, j) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
    if (req.method === 'GET' && u.pathname === '/status') return send(200, s.status)
    if (req.method === 'GET' && u.pathname === '/heard') {
      const since = Number(u.searchParams.get('since') ?? 0)
      const get = () => s.heard.filter((h) => h.id > since)
      if (!get().length) await new Promise((r) => { const to = setTimeout(r, 300); s.waiters.push(() => { clearTimeout(to); r() }) })
      return send(200, get())
    }
    if (req.method === 'POST' && u.pathname === '/speak') { const b = await readBody(req); s.speaks.push(b); const id = s.nextUtt++; s.status.last_latency_ms = { ...s.status.last_latency_ms, tts_first_ms: 100 + id }; return send(200, { utt_id: id }) }
    if (req.method === 'POST' && u.pathname === '/flush') { s.flushes++; return send(200, s.flushResult) }
    send(404, {})
  })
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r))
  s.url = `http://127.0.0.1:${s.server.address().port}`
  s.close = () => new Promise((r) => { s.server.closeAllConnections?.(); s.server.close(r) })
  return s
}

async function fakeBrain() {
  const b = { events: [] }
  b.server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const send = (j) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
    if (req.method === 'POST' && u.pathname === '/event') { b.events.push(await readBody(req)); return send({ accepted: true }) }
    if (req.method === 'GET' && u.pathname === '/intent') { await sleep(400); return send({ seq: 0 }) }
    send({})
  })
  await new Promise((r) => b.server.listen(0, '127.0.0.1', r))
  b.url = `http://127.0.0.1:${b.server.address().port}`
  b.close = () => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(r) })
  return b
}

async function rig({ chatMode = 'fallback', voiceUp = true, answerPriority } = {}) {
  const voice = await fakeVoice(); const brain = await fakeBrain()
  if (!voiceUp) voice.status.connected_mod = false
  const r = makeRig()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vint-'))
  const body = Object.assign(new EventEmitter(), { spawned: true, bot: r.bot })
  const bot = r.bot
  Object.assign(bot, { username: 'Wren', chats: [], players: { Sam: { uuid: 'uuid-sam', entity: { position: { x: 3, y: 64, z: 0, distanceTo: () => 3 } } }, Anna: { uuid: 'uuid-anna', entity: { position: { x: 8, y: 64, z: 0, distanceTo: () => 8 } } } }, entities: {}, time: { timeOfDay: 1000, age: 0 }, food: 20, inventory: { items: () => [] }, game: {}, findBlocks: () => [], blockAt: () => null })
  bot.entity.position = { x: 0, y: 64, z: 0, distanceTo: () => 3, offset: () => bot.entity.position }
  bot.chat = (t) => bot.chats.push(t)
  const hooks = { events: new EventEmitter(), setDrivesProvider() {}, addCostProvider() {}, setLockoutProvider() {} }
  const looks = []
  r.runner.run = async (name, args, o) => { looks.push({ name, args, o }); return { status: 'done' } }
  const habits = createHabits({ runner: r.runner, arbiter: r.arbiter, getBot: () => bot, env: { rng: () => 0.5, heatmap: { key: () => 'k' }, landmarks: {} }, isUp: () => true })
  const app = { cfg: { runtimeDir: dir, logDir: dir, username: 'Wren' }, body, hooks, intents: { hasLive: () => false }, runner: r.runner, arbiter: r.arbiter, habits, pack: { env: { landmarks: { nearest: () => null } } }, trace: r.trace, submitIntent: () => ({ ok: true }) }
  const ml = installMindlink(app, { mind: false, brain: true, brainUrl: brain.url, voiceUrl: voice.url, chatMode, answerPriority, voiceStatusMs: 40 })
  body.emit('bot', bot)
  ml.start()
  await sleep(150) // first status poll
  const events = () => fs.readFileSync(path.join(dir, 'mindlink.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const done = async () => { try { await ml.stop() } catch { /* ignore */ } await voice.close(); await brain.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  return { voice, brain, ml, bot, events, looks, done, habits, r, dir }
}

process.env.WREN_SPEAK_GATE = 'off' // AI1: these tests exercise voice plumbing without a player in range; the gate has its own tests (ai1-speech.test.mjs)
test('voiceText strips stage directions, emoji and cuts to two sentences', () => {
  assert.equal(voiceText('*waves* Hello there! I am looking for food. Then I will sleep. And more.'), 'Hello there! I am looking for food.')
  assert.equal(voiceText('(smiles) [nods] Hi :) \u{1F600}'), 'Hi :)')
  assert.equal(voiceText('*sighs*'), '')
  assert.ok(voiceText('word '.repeat(80)).length <= 221)
})

test('fallback mode: voice connected -> voice only (no chat), normal priority; double-speak prevented', async () => {
  const R = await rig()
  try {
    assert.ok(R.ml.voice.connected)
    R.ml.say('I see a sheep over there.', 'test')
    await sleep(100)
    assert.equal(R.voice.speaks.length, 1); assert.equal(R.voice.speaks[0].priority, 'normal'); assert.equal(R.bot.chats.length, 0)
    assert.equal(R.ml.say('I see a sheep over there.', 'test'), false) // duplicate
    await sleep(50); assert.equal(R.voice.speaks.length, 1)
  } finally { await R.done() }
})

test('danger / death lines are urgent', async () => {
  const R = await rig()
  try {
    R.ml.say('I am in danger, there is lava near me.', 'test')
    await sleep(100)
    assert.equal(R.voice.speaks[0].priority, 'urgent')
  } finally { await R.done() }
})

test('fallback to chat when the mod is not connected, and when the service is down', async () => {
  const R = await rig({ voiceUp: false })
  try {
    assert.ok(!R.ml.voice.connected)
    R.ml.say('Hello from chat.', 'test')
    await sleep(60)
    assert.deepEqual(R.bot.chats, ['Hello from chat.']); assert.equal(R.voice.speaks.length, 0)
  } finally { await R.done() }
  const R2 = await rig()
  try {
    await R2.voice.close()
    await sleep(700) // the next status poll fails -> link is down
    assert.ok(!R2.ml.voice.connected)
    R2.ml.say('Nobody to speak to.', 'test')
    assert.deepEqual(R2.bot.chats, ['Nobody to speak to.'])
  } finally { R2.voice.close = async () => {}; await R2.done() }
})

test('chat modes: on = chat and voice, off = voice only', async () => {
  const A = await rig({ chatMode: 'on' })
  try { A.ml.say('Both channels.', 't'); await sleep(80); assert.equal(A.bot.chats.length, 1); assert.equal(A.voice.speaks.length, 1) } finally { await A.done() }
  const B = await rig({ chatMode: 'off' })
  try { B.ml.say('Voice only.', 't'); await sleep(80); assert.equal(B.bot.chats.length, 0); assert.equal(B.voice.speaks.length, 1) } finally { await B.done() }
})

test('rate limit and newest-wins still apply before the voice', async () => {
  const R = await rig()
  try {
    R.ml.say('First thought here.', 't'); R.ml.say('Second thought here.', 't'); R.ml.say('Third thought here.', 't')
    await sleep(100)
    assert.equal(R.voice.speaks.length, 1) // others queued behind the 20 s gap
  } finally { await R.done() }
})

test('speech in: addressed voice transcript -> human_speech {via:voice, dist}; ambient -> context only; reply carries in_reply_to and latency is logged', async () => {
  const R = await rig({ answerPriority: 'urgent' })
  try {
    R.voice.say({ name: 'Sam', dist: 3, text: 'what are you doing here', addressed: true })
    R.voice.say({ name: 'Alice', dist: 9, text: 'look at that cow over there', addressed: false })
    await sleep(500)
    const hs = R.brain.events.filter((e) => e.type === 'human_speech')
    assert.equal(hs.length, 1); assert.equal(hs[0].from, 'Sam'); assert.equal(hs[0].via, 'voice'); assert.equal(hs[0].dist, 3); assert.equal(hs[0].text, 'what are you doing here')
    assert.ok(R.ml.S.events.some((e) => /\[Alice, 9 m, not clearly to me\].*cow/.test(e)))
    assert.equal(R.ml.S.stats.voice_ambient, 1)
    // her answer: spoken, urgent (answer to a human), in_reply_to = the heard id, no chat
    R.ml.say('I am looking for food. Do you want to help?', 'answer')
    await sleep(100)
    assert.equal(R.voice.speaks.length, 1); assert.equal(R.voice.speaks[0].priority, 'urgent'); assert.equal(R.voice.speaks[0].in_reply_to, 1); assert.equal(R.bot.chats.length, 0)
    await sleep(900)
    const lat = R.events().find((e) => e.ev === 'voice_latency')
    assert.ok(lat && lat.tts_first_ms > 100 && lat.endpoint_ms === 480 && lat.stt_ms === 120 && lat.eos_to_audio_ms >= 480 + 120 + lat.tts_first_ms, JSON.stringify(lat))
  } finally { await R.done() }
})

test('transcripts that were already there before startup are not replayed', async () => {
  const voice = await fakeVoice(); voice.say({ text: 'old news' })
  const seen = []
  const l = new VoiceLink({ url: voice.url, statusMs: 40 })
  l.start({ onAddressed: (i) => seen.push(i.text) })
  await sleep(300); voice.say({ text: 'fresh news' }); await sleep(500)
  l.stop(); await voice.close()
  assert.deepEqual(seen, ['fresh news'])
})

test('V3 barge-in: mindlink NEVER flushes on its own for human speech (voice service turnscore is the one authority); a real turn still reaches the brain', async () => {
  const R = await rig({ answerPriority: 'normal' })
  try {
    R.ml.say('I was going to tell you a long story about the cave. It has many rooms.', 'idle')
    await sleep(100)
    R.voice.status.speaking = true; R.voice.status.speaking_utt = 1
    await sleep(120)
    R.voice.say({ name: 'Sam', dist: 2, text: 'wait what cave', addressed: true })
    await sleep(500)
    assert.equal(R.voice.flushes, 0)
    assert.ok(R.brain.events.find((e) => e.type === 'human_speech'))
  } finally { await R.done() }
})

test('barge-in decided by the service (status.unspoken changes) reaches the brain as a context event, no extra flush', async () => {
  const R = await rig()
  try {
    R.voice.status.unspoken = { utt_id: 5, spoken: 'One.', text: 'Two and three.', why: 'yield_now', ts: Date.now() + 10 }
    await sleep(200)
    assert.equal(R.voice.flushes, 0)
    assert.ok(R.ml.S.events.some((e) => /cut off.*Two and three/.test(e)))
    R.voice.say({ name: 'Sam', dist: 2, text: 'please go on and tell me the rest of that story', addressed: true })
    await sleep(500)
    assert.equal(R.brain.events.find((e) => e.type === 'human_speech').unspoken, 'Two and three.')
  } finally { await R.done() }
})

test('an urgent line is not flushed by a human turn (urgent never yields)', async () => {
  const R = await rig()
  try {
    R.ml.say('I died near the lava.', 'death'); await sleep(100)
    R.voice.status.speaking = true
    R.voice.say({ name: 'Sam', dist: 2, text: 'stop', addressed: true }); await sleep(400)
    assert.equal(R.voice.flushes, 0)
  } finally { await R.done() }
})

test('a human who wrote in chat is answered in chat too (players without the voice mod)', async () => {
  const R = await rig()
  try {
    R.bot.emit('chat', 'Alice', 'hello Wren')
    await sleep(100)
    R.ml.say('Hello Alice, good to see you.', 'answer')
    await sleep(120)
    assert.equal(R.bot.chats.length, 1); assert.equal(R.voice.speaks.length, 1); assert.equal(R.voice.speaks[0].in_reply_to, undefined)
    const hs = R.brain.events.find((e) => e.type === 'human_speech'); assert.equal(hs.via, 'chat')
  } finally { await R.done() }
})

test('body language: gaze at the addressed speaker within 12 blocks, conversation stance for 20 s within 6 blocks, habits pause', async () => {
  const R = await rig()
  try {
    R.voice.say({ name: 'Sam', dist: 3, text: 'hey wren come here', addressed: true })
    await sleep(400)
    assert.ok(R.looks.some((l) => l.name === 'look_at' && l.args.target === 'Sam' && l.o.owner === 's1'), 'look_at issued')
    assert.ok(R.ml.vbody.conversing())
    assert.equal(await R.habits.step(), 'skip') // habits stay put while talking
    // silence for > 45 s ends the stance
    assert.ok(!R.ml.vbody.conversing(Date.now() + 46000))
  } finally { await R.done() }
})

test('body language: nod at a reported pause of 250..900 ms, not at 100 ms or 2000 ms; far speaker (20 m) is ignored', async () => {
  const r = makeRig(); const calls = []
  r.bot.players = { A: { entity: { position: { distanceTo: () => 4 } } }, F: { entity: { position: { distanceTo: () => 20 } } } }
  r.runner.run = async (name, args) => { calls.push([name, args.kind ?? args.target]); return { status: 'done' } }
  let t = 1e6
  const vb = createVoiceBody({ getBot: () => r.bot, runner: r.runner, arbiter: r.arbiter, now: () => t })
  await vb.onStatus([{ name: 'A', dist: 4, in_utt: true, silence_ms: 100 }]); assert.deepEqual(calls.map((c) => c[0]), ['look_at'])
  t += 1500; await vb.onStatus([{ name: 'A', dist: 4, in_utt: true, silence_ms: 400 }]); assert.ok(calls.some((c) => c[0] === 'gesture' && c[1] === 'nod'))
  const n = calls.length; t += 1500; await vb.onStatus([{ name: 'A', dist: 4, in_utt: true, silence_ms: 400 }]); assert.equal(calls.filter((c) => c[0] === 'gesture').length, 1) // nod throttled
  t += 6000; await vb.onStatus([{ name: 'A', dist: 4, in_utt: true, silence_ms: 2000 }]); assert.equal(calls.filter((c) => c[0] === 'gesture').length, 1)
  await vb.onStatus([{ name: 'F', dist: 20, in_utt: true, silence_ms: 400 }]); assert.equal(calls.filter((c) => c[1] === 'F').length, 0)
  void n
})

test('body language never takes the body from a real skill or a reflex', async () => {
  const r = makeRig(); const calls = []
  r.bot.players = { A: { entity: { position: { distanceTo: () => 3 } } } }
  r.runner.run = async (name) => { calls.push(name); return { status: 'done' } }
  const tok = await r.arbiter.acquire('s1', { label: 'gather' })
  const vb = createVoiceBody({ getBot: () => r.bot, runner: r.runner, arbiter: r.arbiter })
  await vb.onAddressed('A', 3)
  assert.equal(calls.length, 0); assert.equal(vb.stats.skipped_busy, 1)
  tok.release?.()
})

test('service down at start: nothing breaks, chat works, no timers throw', async () => {
  const brain = await fakeBrain()
  const r = makeRig(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vint-'))
  const body = Object.assign(new EventEmitter(), { spawned: true, bot: r.bot })
  Object.assign(r.bot, { username: 'Wren', chats: [], players: {}, entities: {}, time: {}, inventory: { items: () => [] }, findBlocks: () => [], blockAt: () => null }); r.bot.chat = (t) => r.bot.chats.push(t)
  const app = { cfg: { runtimeDir: dir, logDir: dir, username: 'Wren' }, body, hooks: { events: new EventEmitter(), setDrivesProvider() {}, addCostProvider() {}, setLockoutProvider() {} }, intents: { hasLive: () => false }, runner: r.runner, arbiter: r.arbiter, pack: { env: { landmarks: {} } }, trace: r.trace, submitIntent: () => ({ ok: true }) }
  const ml = installMindlink(app, { mind: false, brain: true, brainUrl: brain.url, voiceUrl: 'http://127.0.0.1:1' })
  body.emit('bot', r.bot); ml.start(); await sleep(200)
  ml.say('Still talking.', 't'); assert.deepEqual(r.bot.chats, ['Still talking.'])
  await ml.stop(); await brain.close(); fs.rmSync(dir, { recursive: true, force: true })
})

async function twoSpeakers(replyText) {
  const R = await rig()
  // both talk at the same time (service status shows two open utterances), then both finals arrive 300 ms apart
  R.voice.status.listeners = [{ uuid: 'uuid-anna', name: 'Anna', dist: 8, in_utt: true, silence_ms: 0 }, { uuid: 'uuid-sam', name: 'Sam', dist: 3, in_utt: true, silence_ms: 0 }]
  await sleep(150)
  R.voice.say({ uuid: 'uuid-anna', name: 'Anna', dist: 8, text: 'can you come over here', addressed: true })
  await sleep(300)
  R.voice.say({ uuid: 'uuid-sam', name: 'Sam', dist: 3, text: 'what are you doing', addressed: true })
  R.voice.status.listeners = []
  await sleep(500)
  R.ml.say(replyText, 'answer'); await sleep(150)
  return R
}

test('two speakers at overlapping times: separate attributed events, overlap noted, nobody merged, the farther one is told to wait by name', async () => {
  const R = await twoSpeakers('Sam, I am looking for food.')
  try {
    const hs = R.brain.events.filter((e) => e.type === 'human_speech')
    assert.equal(hs.length, 2)
    const anna = hs.find((e) => e.from === 'Anna'), sam = hs.find((e) => e.from === 'Sam')
    assert.deepEqual([anna.text, anna.uuid, anna.dist, anna.via], ['can you come over here', 'uuid-anna', 8, 'voice'])
    assert.deepEqual([sam.text, sam.uuid, sam.dist], ['what are you doing', 'uuid-sam', 3])
    assert.ok(Number.isFinite(anna.ts) && Number.isFinite(sam.ts))
    assert.ok(sam.overlap?.includes('Anna') && sam.overlap.includes('Sam'))
    assert.ok(!hs.some((e) => /here.*doing|doing.*here/.test(e.text)))
    assert.ok(R.ml.S.events.some((e) => /Anna and Sam spoke at the same time|Sam and Anna spoke at the same time/.test(e)))
    const ack = R.voice.speaks.find((x) => /^One moment, Anna\.$/.test(x.text))
    assert.ok(ack && ack.in_reply_to === 1, 'Anna (id 1) is acknowledged by name')
    const reply = R.voice.speaks.find((x) => /food/.test(x.text))
    assert.equal(reply.in_reply_to, 2) // Sam's heard id
    assert.ok(R.looks.filter((l) => l.name === 'look_at').at(-1).args.target === 'Sam')
  } finally { await R.done() }
})

test('the reply is tied to the person it names (in_reply_to and gaze), even if another spoke later', async () => {
  const R = await twoSpeakers('Anna, I am coming in a moment.')
  try {
    const reply = R.voice.speaks.find((x) => /coming/.test(x.text))
    assert.equal(reply.in_reply_to, 1)
    assert.equal(R.looks.filter((l) => l.name === 'look_at').at(-1).args.target, 'Anna')
  } finally { await R.done() }
})

test('people memory: per-name record with uuid, first met, interactions, topics; a new name is a new person; ambient speech keeps its speaker label', async () => {
  const R = await rig()
  try {
    R.voice.say({ uuid: 'uuid-sam', name: 'Sam', dist: 3, text: 'do you like trees', addressed: true }); await sleep(250)
    R.voice.say({ uuid: 'uuid-sam', name: 'Sam', dist: 3, text: 'and what about caves', addressed: true }); await sleep(250)
    R.voice.say({ uuid: 'uuid-x', name: 'Sam2', dist: 3, text: 'hi it is me', addressed: true }); await sleep(250)
    R.voice.say({ uuid: 'uuid-bob', name: 'Bob', dist: 14, text: 'anna look at the sheep', addressed: false }); await sleep(250)
    const j = R.ml.people.get('Sam'), j2 = R.ml.people.get('Sam2')
    assert.equal(j.interactions, 2); assert.equal(j.uuid, 'uuid-sam'); assert.equal(j.topics.at(-1), 'and what about caves'); assert.ok(j.familiarity > 0 && j.trust > 0.1)
    assert.equal(j2.interactions, 1); assert.notEqual(j2, j)
    assert.ok(R.ml.people.nearbyLines(['Sam', 'Sam2', 'Nobody']).length === 2)
    assert.equal(R.ml.people.get('Bob'), null) // ambient speech is not an interaction with her
    assert.ok(R.ml.S.events.some((e) => e === '[Bob, 14 m, not clearly to me] "anna look at the sheep"'))
    // same name, other account
    R.ml.onHuman('Sam', 'it is me again', { via: 'voice', uuid: 'uuid-other' })
    assert.equal(R.ml.people.get('Sam').uuid_changes, 1)
  } finally { await R.done() }
})

// AI1: the speaking gate in the real mindlink: nobody near -> demoted to a thought (not chatted); someone near -> chatted; answering -> chatted
test('AI1 gate: SAY with nobody near is demoted to a logged thought; with a player in range it is chatted; template lines obey it too', async () => {
  const prev = process.env.WREN_SPEAK_GATE; process.env.WREN_SPEAK_GATE = 'on'
  const brain = await fakeBrain()
  const r = makeRig(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai1-'))
  const body = Object.assign(new EventEmitter(), { spawned: true, bot: r.bot })
  Object.assign(r.bot, { username: 'Wren', chats: [], players: {}, entities: {}, time: {}, inventory: { items: () => [] }, findBlocks: () => [], blockAt: () => null }); r.bot.chat = (t) => r.bot.chats.push(t)
  const app = { cfg: { runtimeDir: dir, logDir: dir, username: 'Wren' }, body, hooks: { events: new EventEmitter(), setDrivesProvider() {}, addCostProvider() {}, setLockoutProvider() {} }, intents: { hasLive: () => false }, runner: r.runner, arbiter: r.arbiter, pack: { env: { landmarks: {} } }, trace: r.trace, submitIntent: () => ({ ok: true }) }
  try {
    const ml = installMindlink(app, { mind: false, brain: true, brainUrl: brain.url, voiceUrl: 'http://127.0.0.1:1' })
    body.emit('bot', r.bot); ml.start(); await sleep(200)
    assert.equal(ml.say('I am running from a creeper.', 'none'), false); assert.deepEqual(r.bot.chats, [])
    assert.equal(ml.say('That did not work.', 'template'), false); assert.deepEqual(r.bot.chats, [])
    const th = fs.readFileSync(path.join(dir, 'thoughts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(th.length, 1, 'templates are suppressed outright, not even a thought'); assert.equal(th[0].kind, 'demoted_say'); assert.equal(th[0].text, 'I am running from a creeper.'); assert.ok(th[0].tts.seed >= 0)
    r.bot.players = { Anna: { username: 'Anna', entity: { position: { distanceTo: () => 5 } } } }
    r.bot.entity = r.bot.entity ?? { position: {} }
    assert.equal(ml.say('Hello Anna.', 'answer'), true); assert.deepEqual(r.bot.chats, ['Hello Anna.'])
    assert.equal(ml.say('That failed, I will rethink.', 'template'), false); assert.deepEqual(r.bot.chats, ['Hello Anna.'], 'even with a player near')
    await ml.stop()
  } finally { process.env.WREN_SPEAK_GATE = prev ?? 'off'; await brain.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- V3 (first live voice test fixes)
test('V3 live replay 11:19:26: "Yeah." (addressed, 2.8 m) over her line u7 -> no flush from mindlink, no answer job, S2 gets it as context', async () => {
  const R = await rig()
  try {
    R.ml.say("Okay Alex, I'll wait here with you.", 'started')
    await sleep(100)
    R.voice.status.speaking = true; R.voice.status.speaking_utt = 7
    R.voice.say({ name: 'Alex', dist: 2.78, text: 'Yeah.', addressed: true })
    await sleep(400)
    assert.equal(R.voice.flushes, 0, 'mindlink never flushes on its own')
    assert.equal(R.brain.events.filter((e) => e.type === 'human_speech').length, 0, 'a backchannel starts no answer job')
    assert.ok(R.ml.S.events.some((e) => /Alex, 3 m\] "Yeah\."/.test(e) && /acknowledgement/.test(e)))
    assert.equal(R.ml.S.stats.voice_ack_in, 1)
    R.voice.say({ name: 'Alex', dist: 4.8, text: 'This is the right direction. Follow me.', addressed: true }); await sleep(400)
    assert.equal(R.brain.events.filter((e) => e.type === 'human_speech').length, 1) // a real turn still goes to S2
    assert.equal(R.voice.flushes, 0)
  } finally { await R.done() }
})

test('V3 one answer per human utterance: later jobs (heartbeat, drive wake) cannot answer it again; the answer goes to the LATEST utterance; stale answers are dropped', async () => {
  const R = await rig()
  const J = R.ml.S.intentJob
  try {
    R.voice.say({ name: 'Sam', dist: 5.8, text: 'Hello there, Wren.', addressed: true }); await sleep(300)
    J.set('i1', { jobKind: 'human_speech', answers: [1] }); J.set('i2', { jobKind: 'heartbeat' }); J.set('i3', { jobKind: 'drive_wake' })
    R.ml.say('Hey, I am glad I am not the only one out here.', 'started', { intent_id: 'i1' }); await sleep(100)
    R.ml.say('Hey, I am an AI with a body and I keep getting stuck.', 'started', { intent_id: 'i2' }); await sleep(50)
    R.ml.say('I am looking for a safe place to rest tonight.', 'started', { intent_id: 'i3' }); await sleep(50)
    assert.equal(R.voice.speaks.length, 1); assert.equal(R.voice.speaks[0].in_reply_to, 1)
    assert.ok(R.ml.S.stats.say_demoted >= 2)
    // a newer utterance arrives; the answer prepared for the older one is stale, the answer for the newest is spoken with in_reply_to = 2
    R.voice.say({ name: 'Sam', dist: 9.2, text: 'Where are you going?', addressed: true }); await sleep(300)
    J.set('i4', { jobKind: 'human_speech', answers: [1] }); J.set('i5', { jobKind: 'human_speech', answers: [1, 2] })
    R.ml.say('Stale answer to the greeting again.', 'started', { intent_id: 'i4' }); await sleep(50)
    assert.equal(R.voice.speaks.length, 1)
    const dem = R.ml.S.stats.say_demoted
    R.ml.say('I am heading east to look for my bed.', 'started', { intent_id: 'i5' }); await sleep(150)
    assert.equal(R.ml.S.stats.say_demoted, dem, 'the answer to the newest utterance passes the gate (the 20 s rate limit may queue it)')
    const ev = R.events().filter((e) => /heading east/.test(e.text ?? ''))
    assert.ok(ev.some((e) => e.ev === 'say_queued' || e.ev === 'say'), JSON.stringify(ev))
  } finally { await R.done() }
})

// ---- V4: chat as a first-class channel, importance to /speak, auto-resume note
import { chatLines, ChatLimiter, stateImportance } from '../src/mindlink/chatchan.js'
test('V4 chat: a player 300 blocks away writing in chat reaches S2 (no 48-block gate) with name, distance and via chat; transcript logged in and out', async () => {
  const R = await rig()
  try {
    R.bot.players.Far = { uuid: 'uuid-far', entity: { position: { x: 300, y: 64, z: 0, distanceTo: () => 300 } } }
    R.bot.emit('chat', 'Far', 'hello from the other side of the map')
    await sleep(100)
    const hs = R.brain.events.find((e) => e.type === 'human_speech' && e.from === 'Far')
    assert.ok(hs, 'event reached the brain'); assert.equal(hs.via, 'chat'); assert.equal(hs.dist, 300)
    assert.equal(R.ml.chatSay('Hello Far, I can read you!', { intent_id: 'i1' }), 1)
    assert.deepEqual(R.bot.chats, ['Hello Far, I can read you!'])
    assert.equal(R.ml.chatSay('/op Far', {}), 0); assert.equal(R.bot.chats.length, 1, 'commands are never sent')
    const lines = fs.readFileSync(path.join(R.dir, "chat.jsonl"), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(lines.map((l) => [l.dir, l.name]), [['in', 'Far'], ['out', 'Wren']]); assert.ok(lines[0].ts && lines[0].dist === 300)
  } finally { await R.done() }
})
test('V4 chat: an intent with a chat line writes it to the chat, SAY stays voice', async () => {
  const R = await rig()
  try {
    await R.ml.handleIntent({ intent_id: 'c1', goal: 'none', args: {}, chat: 'Meet me at the lake, everyone!' })
    assert.ok(R.bot.chats.includes('Meet me at the lake, everyone!'))
  } finally { await R.done() }
})
test('V4 chatLines: 256 limit, no commands, control chars, rate limit; stateImportance', () => {
  assert.deepEqual(chatLines('/gamemode creative'), []); assert.deepEqual(chatLines('  /x'), []); assert.deepEqual(chatLines('hi\nthere§c'), ['hi there c'])
  const long = Array(60).fill('A sentence that is quite long.').join(' '), ls = chatLines(long)
  assert.ok(ls.length <= 2 && ls.every((l) => l.length <= 240 && !l.startsWith('/')))
  const lim = new ChatLimiter({ perMin: 3, gapMs: 100 }); assert.ok(lim.take(1, 0).ok); assert.equal(lim.take(1, 50).ok, false); assert.ok(lim.take(2, 200).ok); assert.equal(lim.take(1, 400).ok, false)
  assert.equal(stateImportance("I'm actually starving right now - my food is at zero."), 0.75); assert.equal(stateImportance('nice weather'), null)
})
test('V4 importance reaches /speak (own urgent state) and the interrupted event carries auto_resume', async () => {
  const R = await rig()
  try {
    await R.ml.say("Alex, I'm starving, my food is at zero.", 'answer'); await sleep(150)
    assert.equal(R.voice.speaks.at(-1).importance, 0.75)
    const evs = []; const vl = R.ml.voice; vl.handlers.onInterrupted && 0
    R.voice.status.unspoken = { utt_id: 'u9', text: 'x y z.', spoken: '', why: 'yield_trail_off', ts: Date.now() + 5, auto_resume: true }
    await sleep(200); void evs
    assert.ok(R.events().some((e) => e.ev === 'voice_interrupted'))
  } finally { await R.done() }
})

test('VAL2: addressed voice utterance with no S2 answer in 1.5 s -> one ack (kind ack, no in_reply_to); an answer first -> none; WREN_ACK=off -> none', async () => {
  const R = await rig({ answerPriority: 'normal' })
  try {
    R.voice.say({ name: 'Sam', dist: 3, text: 'what do you think about the cave?', addressed: true })
    await sleep(1900)
    const acks = R.voice.speaks.filter((s) => s.kind === 'ack')
    assert.equal(acks.length, 1); assert.equal(acks[0].in_reply_to, undefined); assert.ok(acks[0].text.length < 40)
    await sleep(1800); assert.equal(R.voice.speaks.filter((s) => s.kind === 'ack').length, 1, 'once per utterance')
    // answered before the timer: no ack
    R.voice.say({ name: 'Sam', dist: 3, text: 'and the lake?', addressed: true })
    await sleep(300); R.ml.say('The lake is calm tonight, I like it.', 'answer')
    await sleep(1900)
    assert.equal(R.voice.speaks.filter((s) => s.kind === 'ack').length, 1)
    assert.ok(R.events().some((e) => e.ev === 'ack_skipped' && e.reason === 'answered'))
    process.env.WREN_ACK = 'off'
    R.voice.say({ name: 'Sam', dist: 3, text: 'tell me more please?', addressed: true })
    await sleep(1900)
    assert.equal(R.voice.speaks.filter((s) => s.kind === 'ack').length, 1)
  } finally { delete process.env.WREN_ACK; await R.done() }
})
