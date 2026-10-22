#!/usr/bin/env node
// Read-only static server for report/out (GET/HEAD only, no directory listing, no path escape). LAN only by convention.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, isMain } from './lib/args.mjs'

const TYPES = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.edl': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' }

export function createServer(root, { allowHosts = [] } = {}) {
  const base = path.resolve(root)
  const okHosts = new Set(['localhost', ...allowHosts])
  const ipLiteral = /^(\d{1,3}\.){3}\d{1,3}$|^\[[0-9a-f:.]+\]$/i // a DNS-rebinding page needs a hostname; an IP literal in Host cannot be one
  return http.createServer((req, res) => {
    const send = (code, body, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : body) }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'read-only')
    const hostName = String(req.headers.host || '').replace(/:\d+$/, '')
    if (!okHosts.has(hostName) && !ipLiteral.test(hostName)) return send(403, 'forbidden host') // DNS-rebinding guard
    let p
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch { return send(400, 'bad request') }
    if (p.includes('\0')) return send(400, 'bad request')
    if (p === '/' || p === '') p = '/report.html'
    const file = path.resolve(base, '.' + p)
    if (file !== base && !file.startsWith(base + path.sep)) return send(403, 'forbidden')
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(404, 'not found')
      fs.readFile(file, (e2, buf) => (e2 ? send(500, 'read error') : send(200, buf, TYPES[path.extname(file)] ?? 'application/octet-stream')))
    })
  })
}

if (isMain(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2))
  const root = a.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'out')
  const port = +(a.port ?? 8890), host = a.host ?? '127.0.0.1'
  fs.mkdirSync(root, { recursive: true })
  const s = createServer(root, { allowHosts: [host] })
  s.on('error', (e) => { console.error('serve error:', e.message); process.exit(1) })
  s.listen(port, host, () => console.log(`serving ${root} on ${host}:${port}`))
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => s.close(() => process.exit(0)))
}
