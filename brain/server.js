// Local endpoint for the bot process (127.0.0.1 only, default port 19500). Plain HTTP; long-poll on GET /intent replaces a WebSocket
// (no dependencies). Every request needs the x-brain-token secret (BRAIN_TOKEN, generated into brain/secrets.env on first run), requests with an Origin header are refused, POST must be application/json. POST /event, GET /intent?since=<seq>&wait=<ms>, GET /status, GET /reflection, POST /context, GET /health.
import http from 'node:http'
import { Brain } from './brain.js'
import { LlmClient } from './llm.js'
import { FakeS2 } from './fake-s2.js'
import { makeLogger } from './jsonl.js'
import { loadBrainToken, ensureBrainToken, tokenMatches } from './token.js'

export function makeLlm(spec = process.env.BRAIN_LLM || 'real') {
  if (spec.startsWith('fake')) return new FakeS2({ mode: spec.split(':')[1] || 'random' })
  return new LlmClient()
}

export function createServer(brain, { token = loadBrainToken(), port = 19500 } = {}) {
  if (!token) throw new Error('BRAIN_TOKEN is required (the standalone host generates one into brain/secrets.env on first run)')
  const MAX = 256 * 1024
  const send = (res, code, obj) => { const b = obj === undefined ? '' : JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b) }
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const chunks = []
    req.on('data', (c) => { n += c.length; if (n > MAX) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) } catch { reject(Object.assign(new Error('bad json'), { code: 400 })) } })
  })
  const server = http.createServer(async (req, res) => {
    try {
      const host = (req.headers.host || '').replace(/:\d+$/, '')
      if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'host' }) // DNS-rebinding guard
      if (req.headers.origin !== undefined) return send(res, 403, { error: 'origin' }) // browsers always send Origin on cross-site requests; the bot's fetch client sends none
      if (!tokenMatches(req.headers['x-brain-token'], token)) return send(res, 401, { error: 'token' })
      if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'content-type must be application/json' })
      const u = new URL(req.url, 'http://x')
      if (req.method === 'POST' && u.pathname === '/event') {
        const r = brain.handleEvent(await readBody(req))
        return send(res, r.ok ? 202 : 422, r)
      }
      if (req.method === 'POST' && u.pathname === '/context') {
        const r = brain.handleEvent({ type: 'body_state', state: 'context', context: await readBody(req) })
        return send(res, 200, r)
      }
      if (req.method === 'GET' && u.pathname === '/intent') {
        const since = Number(u.searchParams.get('since') ?? -1)
        const wait = Math.min(Number(u.searchParams.get('wait') ?? 0), 25000)
        const r = await brain.getIntent({ since, waitMs: wait })
        return send(res, 200, r)
      }
      if (req.method === 'GET' && u.pathname === '/status') return send(res, 200, brain.status())
      if (req.method === 'GET' && u.pathname === '/reflection') return send(res, 200, brain.reflection ?? {})
      if (req.method === 'GET' && u.pathname === '/health') return send(res, 200, { ok: true })
      send(res, 404, { error: 'not found' })
    } catch (e) { send(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.message }) }
  })
  server.listen(port, '127.0.0.1')
  return server
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.BRAIN_PORT || 19500)
  const llm = makeLlm()
  const brain = new Brain({ llm })
  const srv = createServer(brain, { port, token: ensureBrainToken() })
  const hb = makeLogger('brain')
  hb({ ev: 'start', port, llm: process.env.BRAIN_LLM || 'real', base: llm.baseUrl })
  console.log(`brain listening on 127.0.0.1:${port} llm=${process.env.BRAIN_LLM || 'real'}`)
  const stop = () => { brain.close(); srv.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref() }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
}
