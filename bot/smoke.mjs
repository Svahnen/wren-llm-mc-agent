// M0 smoke test: join, log, greet once, wander ~2 min with pathfinder, quit cleanly.
// Usage: node smoke.mjs        (env: MC_HOST, MC_PORT, BOT_NAME, WANDER_MS). It connects to YOUR test server as BOT_NAME.
import mineflayer from 'mineflayer'
import pf from 'mineflayer-pathfinder'
import { applyRecipeMappingFix } from './src/protocol-fix.js'
const { pathfinder, Movements, goals } = pf

const HOST = process.env.MC_HOST ?? "127.0.0.1"
const PORT = Number(process.env.MC_PORT ?? 25566)
const NAME = process.env.BOT_NAME ?? 'Wren'
const WANDER_MS = Number(process.env.WANDER_MS ?? 120000)
const log = (...a) => console.log(new Date().toISOString(), ...a)

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`smoke.mjs: join a Minecraft server as ${NAME}, wander for WANDER_MS ms, quit.
  env: MC_HOST (default 127.0.0.1) MC_PORT (default 25566) BOT_NAME (default Wren) WANDER_MS (default 120000)
  It logs in with the player name BOT_NAME: stop any real bot with that name first (duplicate_login).
  Use only on a server you own. Waits 3 s after printing the target before connecting.`)
  process.exit(0)
}
applyRecipeMappingFix()   // minecraft-data 3.117.0 recipe-mapping bug (same fix as src/main.js), else login ends in PartialReadError
log(`connecting to ${HOST}:${PORT} as ${NAME} in 3 s (Ctrl-C to abort)`)
await new Promise((r) => setTimeout(r, 3000))

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, auth: 'offline', version: '1.21.1' })
bot.loadPlugin(pathfinder)

let result = 'unknown'
const stats = { goals: 0, reached: 0, pathStopped: 0, otherErr: 0 }
const fmt = (p) => `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`

bot.on('kicked', (r) => { result = 'KICKED'; log('kicked:', typeof r === 'string' ? r : JSON.stringify(r)) })
bot.on('error', (e) => { log('error:', e.message); })
bot.on('end', (r) => { log('end:', r, 'result=' + result, JSON.stringify(stats)); process.exit(result === 'ok' ? 0 : 1) })
bot.on('health', () => log('health', bot.health, 'food', bot.food))
bot.on('death', () => log('death'))
bot.on('login', () => log('login ok, entity id', bot.entity?.id))

bot.once('spawn', async () => {
  log('spawn at', fmt(bot.entity.position), 'uuid', bot.player?.uuid)
  bot.chat('Hello, I am Wren. Just testing my legs.')
  const mv = new Movements(bot)
  mv.canDig = false
  bot.pathfinder.setMovements(mv)
  bot.pathfinder.thinkTimeout = 3000
  const home = bot.entity.position.clone()
  const t0 = Date.now()
  while (Date.now() - t0 < WANDER_MS && bot.entity) {
    const gx = home.x + (Math.random() * 40 - 20)
    const gz = home.z + (Math.random() * 40 - 20)
    stats.goals++
    try {
      await bot.pathfinder.goto(new goals.GoalNearXZ(gx, gz, 2))
      stats.reached++
    } catch (e) {
      if (e?.name === 'PathStopped') stats.pathStopped++
      else { stats.otherErr++; log('goto error:', e?.name, e?.message) }
    }
    log('pos', fmt(bot.entity.position), 'hp', bot.health)
    await new Promise((r) => setTimeout(r, 500))
  }
  result = 'ok'
  log('wander done, quitting')
  bot.quit('smoke test done')
})
setTimeout(() => { log('hard timeout'); process.exit(2) }, WANDER_MS + 60000)
