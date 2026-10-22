// Spawns mind-host.js and talks JSON lines. Never throws: call() resolves {ok:false,error} when the host is down or slow.
// The host is restarted automatically (state is persisted by the host: `save` every minute, on shutdown and after a sleep pass).
import { spawn } from 'node:child_process'
import { cleanEnv } from './cleanenv.js'
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mind-host.js')

export class MindClient {
  constructor({ dbPath, env = {}, log = () => {}, timeoutMs = 8000 }) {
    Object.assign(this, { dbPath, env, log, timeoutMs })
    this.child = null; this.pending = new Map(); this.seq = 0; this.stopping = false; this.restarts = 0; this.up = false
  }
  start() {
    if (this.child) return
    const c = spawn(process.execPath, [HOST, '--db', this.dbPath], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...cleanEnv(process.env), ...this.env } })
    this.child = c; this.up = true
    readline.createInterface({ input: c.stdout }).on('line', (line) => {
      let r; try { r = JSON.parse(line) } catch { return }
      const p = this.pending.get(r.id); if (!p) return
      this.pending.delete(r.id); clearTimeout(p.timer); p.resolve(r)
    })
    c.stdin.on('error', () => {})
    c.on('exit', (code, sig) => {
      this.up = false; this.child = null
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'mind_host_exit' }) }
      this.pending.clear()
      this.log('mind_host_exit', { code, sig })
      if (!this.stopping) { this.restarts++; setTimeout(() => this.start(), Math.min(10000, 1000 * this.restarts)).unref?.() }
    })
  }
  call(req, timeoutMs = this.timeoutMs) {
    if (!this.child || !this.up) return Promise.resolve({ ok: false, error: 'mind_host_down' })
    const id = ++this.seq
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'timeout' }) }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      try { this.child.stdin.write(JSON.stringify({ ...req, id }) + '\n') } catch { this.pending.delete(id); clearTimeout(timer); resolve({ ok: false, error: 'write_failed' }) }
    })
  }
  async stop() {
    this.stopping = true
    if (!this.child) return
    const c = this.child
    await this.call({ op: 'save' }, 3000).catch(() => {})
    try { c.stdin.end() } catch { /* ignore */ }
    await new Promise((r) => { const t = setTimeout(r, 4000); c.once('exit', () => { clearTimeout(t); r() }) })
    if (this.child) { try { c.kill('SIGTERM') } catch { /* ignore */ } }
  }
}
