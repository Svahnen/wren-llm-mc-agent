// Entry point of the mind+brain build of Wren: the unchanged body (createApp from ../main.js) + mindlink. Same env as main.js (BOT_NAME, MC_PORT, BOT_RUNTIME_DIR, ...),
// plus BRAIN_URL (default http://127.0.0.1:19500), BRAIN_TOKEN, MIND_DB (default <runtimeDir>/mind.sqlite), MINDLINK=off|mind|brain (default both).
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../../config.js'
import { createApp } from '../main.js'
import { errInfo } from '../util.js'
import { installMindlink } from './index.js'

let cfg
try { cfg = loadConfig() } catch (e) { console.error(e.message); process.exit(2) }
const app = createApp(cfg)
const mode = process.env.MINDLINK || 'both'
const ml = installMindlink(app, { mind: mode !== 'brain' && mode !== 'off', brain: mode !== 'mind' && mode !== 'off', dbPath: process.env.MIND_DB, brainUrl: process.env.BRAIN_URL })
const pidFile = path.join(cfg.runtimeDir, 'bot.pid')
fs.writeFileSync(pidFile, String(process.pid))
let stopping = false
const shutdown = async (sig) => {
  if (stopping) return
  stopping = true
  const hard = setTimeout(() => { app.trace.event('shutdown_forced', { sig }); process.exit(1) }, 12000)
  hard.unref()
  try { await ml.stop() } catch (e) { app.trace.event('shutdown_error', errInfo(e)) }
  try { await app.stop(sig) } catch (e) { app.trace.event('shutdown_error', errInfo(e)) }
  try { fs.unlinkSync(pidFile) } catch { /* ignore */ }
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (e) => { app.trace.event('uncaught', errInfo(e)); console.error(e) })
process.on('unhandledRejection', (e) => { app.trace.event('unhandled_rejection', errInfo(e)) })
app.start()
ml.start()
