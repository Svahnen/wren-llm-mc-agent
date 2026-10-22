// SEC2: the service sends the mod secret (X-Wren-Secret) on the mod WebSocket and the speech-server key (X-API-Key) on STT/TTS/second pass.
import test from 'node:test'
import assert from 'node:assert/strict'
import { VoiceService } from '../src/service.js'
import { TtsClient } from '../src/tts.js'
import { ParakeetClient } from '../src/stt2.js'
import { loadSecret } from '../src/http.js'

test('mod WebSocket gets X-Wren-Secret only when configured', () => {
  const seen = []
  class FakeWS { constructor(url, opts) { seen.push({ url, opts }) } close() {} }
  const a = new VoiceService({ archive: false, modSecret: 's3cret' }, { WS: FakeWS }); a._connect()
  const b = new VoiceService({ archive: false }, { WS: FakeWS }); b._connect()
  assert.equal(seen[0].opts.headers['X-Wren-Secret'], 's3cret')
  assert.equal(seen[1].opts, undefined)
  a.stopped = b.stopped = true
})

test('TTS and second-pass STT clients send X-API-Key when a key is set, nothing otherwise', async () => {
  const calls = []
  const fetchFn = async (url, init) => { calls.push(init?.headers ?? {}); return { ok: true, json: async () => ({ text: 'hi' }) } }
  await new ParakeetClient({ apiKey: 'k1', fetchFn }).transcribe(Buffer.alloc(320))
  await new ParakeetClient({ fetchFn }).transcribe(Buffer.alloc(320))
  assert.equal(calls[0]['x-api-key'], 'k1'); assert.equal(calls[1]['x-api-key'], undefined)
  const t = new TtsClient({ apiKey: 'k2' }); assert.deepEqual(t._auth, { 'x-api-key': 'k2' })
  assert.deepEqual(new TtsClient()._auth, {})
})

test('loadSecret: env wins, file parsed, missing = empty', () => {
  assert.equal(loadSecret('COMPANION_API_KEY', { COMPANION_API_KEY: ' e ' }, '/nonexistent'), 'e')
  assert.equal(loadSecret('COMPANION_API_KEY', {}, '/nonexistent'), '')
})
