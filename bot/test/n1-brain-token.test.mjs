// N1: the brain client sends the shared secret (env or brain/secrets.env) and plain JSON, never an Origin header.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BrainClient, loadBrainToken } from '../src/mindlink/brain-client.js'

test('loadBrainToken: env wins, then the secrets file, else empty', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-')), 'secrets.env'); fs.writeFileSync(f, 'S2_API_KEY=x\nBRAIN_TOKEN=filetok\n')
  assert.equal(loadBrainToken({ BRAIN_TOKEN: ' envtok ' }, f), 'envtok')
  assert.equal(loadBrainToken({}, f), 'filetok')
  assert.equal(loadBrainToken({}, '/nonexistent/secrets.env'), '')
})

test('BrainClient sends x-brain-token, application/json and no Origin', async () => {
  const seen = []
  const srv = http.createServer((req, res) => { seen.push(req.headers); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const c = new BrainClient({ url: `http://127.0.0.1:${srv.address().port}`, token: 'tok123' })
  await c.postEvent({ type: 'x' }); await c.postContext({ a: 1 }); await c.status()
  srv.close()
  assert.equal(seen.length, 3)
  for (const h of seen) { assert.equal(h['x-brain-token'], 'tok123'); assert.equal(h.origin, undefined) }
  assert.match(seen[0]['content-type'], /^application\/json/)
})
