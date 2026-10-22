// SEC1: voice HTTP guard (Host, token, JSON-only POST) on a stub service.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHttp, loadVoiceToken } from '../src/http.js'

const svc = { status: () => ({ ok: true }), speak: () => 'u1', heardSince: async () => [], speaker: { flush: () => false }, cfg: {}, _send() {}, fam: new Map() }
// raw request so we can set any Host header
const raw = (port, { method = 'GET', p = '/status', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, body: s })) })
  r.on('error', reject); if (body) r.write(body); r.end()
})

test('voice http guard: token, host, content-type', async () => {
  const port = 19671; const srv = await startHttp(svc, { port, token: 'sekret-1' })
  try {
    assert.equal((await raw(port)).status, 401)
    assert.equal((await raw(port, { headers: { 'x-voice-token': 'wrong' } })).status, 401)
    assert.equal((await raw(port, { headers: { 'x-voice-token': 'sekret-1' } })).status, 200)
    assert.equal((await raw(port, { p: '/heard?since=0', headers: { 'x-voice-token': 'sekret-1' } })).status, 200)
    assert.equal((await raw(port, { headers: { 'x-voice-token': 'sekret-1', host: 'evil.example:19521' } })).status, 403)
    assert.equal((await raw(port, { headers: { 'x-voice-token': 'sekret-1', host: 'localhost:19521' } })).status, 200)
    const post = (ct) => raw(port, { method: 'POST', p: '/speak', headers: { 'x-voice-token': 'sekret-1', ...(ct ? { 'content-type': ct } : {}) }, body: '{"text":"hi"}' })
    assert.equal((await post('text/plain')).status, 415); assert.equal((await post(null)).status, 415)
    assert.equal((await post('application/x-www-form-urlencoded')).status, 415)
    assert.equal((await post('application/json')).status, 200)
    assert.equal((await post('application/json; charset=utf-8')).status, 200)
  } finally { srv.close() }
})
test('voice http without token configured: still Host + JSON checks (backwards compatible with old callers that send no token)', async () => {
  const port = 19672; const srv = await startHttp(svc, { port })
  try {
    assert.equal((await raw(port)).status, 200)
    assert.equal((await raw(port, { headers: { host: 'evil.example' } })).status, 403)
    assert.equal((await raw(port, { method: 'POST', p: '/flush', headers: { 'x-voice-token': 'ignored' , 'content-type': 'application/json' }, body: '{}' })).status, 200)
  } finally { srv.close() }
})
test('loadVoiceToken: env wins, file parsed, missing = empty', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sec1v-')), 'secrets.env'); fs.writeFileSync(f, 'X=1\nVOICE_TOKEN=abc123\n')
  assert.equal(loadVoiceToken({}, f), 'abc123'); assert.equal(loadVoiceToken({ VOICE_TOKEN: 'e' }, f), 'e'); assert.equal(loadVoiceToken({}, f + '.none'), '')
})
