#!/usr/bin/env node
// Fake speech service for wrenvoice. Node >= 22, built-ins only (global WebSocket).
// Usage: node fake-service.mjs [--url ws://127.0.0.1:19520] [--secret S] [--tone] [--tone-delay 1500]
//                              [--echo] [--save-dir DIR] [--quiet-audio]
//  Prints every incoming message (audio_in pcm trimmed). Stdin commands: tone | flush | dist <n> | quit
//  --tone  sends a 2 s 440 Hz sine as audio_out right after hello (plus delay)
//  --echo  plays everything heard back (16k -> 48k by 3x sample repeat) as audio_out
//  --save-dir writes each speaker's audio_in to <uuid>.pcm (s16le 16 kHz) for inspection
import fs from 'node:fs'
import readline from 'node:readline'

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || i + 1 >= process.argv.length ? true : process.argv[i + 1]) }
const URL_ = arg('url', 'ws://127.0.0.1:19520')
const secret = arg('secret', '')
const echo = !!arg('echo', false)
const saveDir = arg('save-dir', '')
const quietAudio = !!arg('quiet-audio', false)
if (saveDir) fs.mkdirSync(saveDir, { recursive: true })

const ws = new WebSocket(URL_, secret ? { headers: { 'X-Wren-Secret': secret } } : undefined)
let utt = 0
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

function b64(i16) { return Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString('base64') }
function sendTone(ms = 2000) {
  const id = 'tone-' + (++utt), total = 48 * ms
  const pcm = new Int16Array(total)
  for (let i = 0; i < total; i++) pcm[i] = Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 48000))
  // chunks of 100 ms (4800 samples = 5 frames), sent a bit faster than real time; the mod queues max 2 s
  const CH = 4800; let seq = 0
  const timer = setInterval(() => {
    if (seq * CH >= total) return clearInterval(timer)
    ws.send(JSON.stringify({ type: 'audio_out', utt_id: id, seq, pcm48k: b64(pcm.subarray(seq * CH, (seq + 1) * CH)) }))
    seq++
  }, 80)
  log('sending tone', id, ms + ' ms')
}
function sendPcm16kAsOut(i16) {
  const o = new Int16Array(i16.length * 3)
  for (let i = 0; i < i16.length; i++) o[3 * i] = o[3 * i + 1] = o[3 * i + 2] = i16[i]
  ws.send(JSON.stringify({ type: 'audio_out', utt_id: 'echo-' + (++utt), seq: 0, pcm48k: b64(o) }))
}

ws.addEventListener('open', () => log('connected', URL_))
ws.addEventListener('close', (e) => { log('closed', e.code); process.exit(0) })
ws.addEventListener('error', () => log('error (is the server running / secret right / another client connected?)'))
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data) } catch { return log('non-JSON', String(ev.data).slice(0, 80)) }
  if (m.type === 'audio_in') {
    const raw = Buffer.from(m.pcm16k, 'base64')
    if (saveDir) fs.appendFileSync(`${saveDir}/${m.uuid}.pcm`, raw)
    if (!quietAudio) log('audio_in', m.name, 'dist', m.dist, 'in_range', m.in_range, 'seq', m.seq, 'samples', raw.length / 2)
    if (echo) sendPcm16kAsOut(new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2))
  } else if (m.type === 'players' && Array.isArray(m.all)) {
    // protocol v2: every online player with dist (null = bot offline / other dimension) and in_range
    log('players', 'bot', m.bot ? 'online' : 'offline', m.all.map((p) => `${p.name}:${p.dist === null ? 'null' : p.dist}${p.in_range ? '*' : ''}`).join(' ') || '(nobody)', '(* = in range)')
  } else log(JSON.stringify(m))
  if (m.type === 'hello' && arg('tone', false)) setTimeout(() => sendTone(), Number(arg('tone-delay', 1500)))
})

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const [c, a] = l.trim().split(/\s+/)
  if (c === 'tone') sendTone()
  else if (c === 'flush') ws.send(JSON.stringify({ type: 'flush', utt_id: a || '*' }))
  else if (c === 'dist') ws.send(JSON.stringify({ type: 'speak_distance', d: Number(a) }))
  else if (c === 'quit') { ws.close(); setTimeout(() => process.exit(0), 200) }
})
