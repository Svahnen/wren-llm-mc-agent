// Trap-map probe (T5a): joins as Wren (ONLY Wren), visits every trap start via testmap/teleport-to-trap.sh,
// waits for physics to settle and prints position + block under/at feet. Read-only: the bot never moves itself.
// Run only when no other Wren session is connected.  usage: node probe.mjs [trap ...]
import mineflayer from 'mineflayer'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const TM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../testmap')
const names = process.argv.length > 2 ? process.argv.slice(2) : execFileSync(path.join(TM, '../testmap/trapgen.py'), ['names']).toString().trim().split(' ')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bot = mineflayer.createBot({ host: process.env.MC_HOST ?? '127.0.0.1', port: Number(process.env.MC_PORT ?? 25566), username: 'Wren', auth: 'offline', version: '1.21.1' })
bot.on('error', (e) => console.log('error', e.message))
bot.on('kicked', (r) => console.log('kicked', JSON.stringify(r)))
bot.once('spawn', async () => {
  const fmt = (p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`
  let bad = 0
  for (const n of names) {
    const exp = execFileSync(path.join(TM, 'trapgen.py'), ['start', n]).toString().trim().split(' ').map(Number)
    execFileSync(path.join(TM, 'teleport-to-trap.sh'), [n], { stdio: 'pipe' })
    await sleep(3000)
    const p = bot.entity.position
    const b = (dy) => bot.blockAt(p.offset(0, dy, 0))?.name
    const moved = Math.hypot(p.x - exp[0], p.z - exp[2]) < 1.5
    console.log(n.padEnd(16), 'expected', exp.slice(0, 3).join(','), 'pos', fmt(p), 'onGround', bot.entity.onGround, 'below', b(-1), 'feet', b(0), 'head', b(1), moved ? 'XZ-OK' : 'XZ-MISMATCH', 'hp', bot.health)
    if (!moved) bad++
  }
  console.log(bad ? `PROBE FAILED (${bad})` : 'PROBE OK')
  bot.quit(); setTimeout(() => process.exit(bad ? 1 : 0), 500)
})
