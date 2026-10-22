// Shared secret for the brain HTTP API. Env BRAIN_TOKEN wins; else a line BRAIN_TOKEN=... in brain/secrets.env (mode 600, gitignored; override the path with BRAIN_SECRETS_FILE).
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const DEFAULT_FILE = fileURLToPath(new URL('./secrets.env', import.meta.url))

export function loadBrainToken(env = process.env, file = env.BRAIN_SECRETS_FILE || DEFAULT_FILE) {
  if (env.BRAIN_TOKEN) return env.BRAIN_TOKEN.trim()
  try { const m = fs.readFileSync(file, 'utf8').match(/^BRAIN_TOKEN=(.*)$/m); return m ? m[1].trim() : '' } catch { return '' }
}

/** First run: when no token exists yet, append a random one to the secrets file (created with mode 600). Returns the token. */
export function ensureBrainToken(env = process.env, file = env.BRAIN_SECRETS_FILE || DEFAULT_FILE) {
  const have = loadBrainToken(env, file)
  if (have) return have
  const tok = crypto.randomBytes(24).toString('hex')
  let old = ''; try { old = fs.readFileSync(file, 'utf8') } catch { /* new file */ }
  if (/^BRAIN_TOKEN=/m.test(old)) old = old.replace(/^BRAIN_TOKEN=.*$/m, `BRAIN_TOKEN=${tok}`)
  else old = old + (old && !old.endsWith('\n') ? '\n' : '') + `BRAIN_TOKEN=${tok}\n`
  fs.writeFileSync(file, old, { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* ignore */ }
  return tok
}

export function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(String(expected))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
