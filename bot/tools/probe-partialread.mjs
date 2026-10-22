// T1 investigation helper: which packet raises the PartialReadError at login, and what do we lose?
import { createRequire } from 'node:module'
import mineflayer from 'mineflayer'
import fs from 'node:fs'
import mcdata from 'minecraft-data'
const require = createRequire(import.meta.url)
const { FullPacketParser } = require('protodef')
import { applyRecipeMappingFix } from '../src/protocol-fix.js'
if (process.env.FIX === '1') console.log('fix', applyRecipeMappingFix())
const data = mcdata('1.21.1')
const orig = FullPacketParser.prototype.parsePacketBuffer
let seen = {}
FullPacketParser.prototype.parsePacketBuffer = function (buf) {
  try { return orig.call(this, buf) } catch (e) {
    if (e.partialReadError) {
      // first varint = packet id (play state)
      let id = 0, shift = 0, i = 0
      for (; i < buf.length; i++) { id |= (buf[i] & 0x7f) << shift; if (!(buf[i] & 0x80)) break; shift += 7 }
      const names = data.protocol.play.toClient.types.packet[1][0].type[1].mappings
      console.log('PARTIAL READ id=0x' + id.toString(16), 'name=' + names['0x' + id.toString(16)], 'len=', buf.length, 'msg=', e.message.slice(0, 90))
      seen[id] = buf; fs.writeFileSync(process.env.DUMP ?? '/dev/null', buf)
    }
    throw e
  }
}
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: process.env.BOT_NAME ?? 'WrenT1', auth: 'offline', version: '1.21.1' })
bot.on('error', (e) => console.log('bot error', e.message))
bot.once('spawn', async () => {
  console.log('spawned; inventory items:', bot.inventory.items().length, 'slots ok:', bot.inventory.slots.length)
  console.log('heldItem', bot.heldItem?.name, 'armor slots', [5, 6, 7, 8].map((s) => bot.inventory.slots[s]?.name))
  if (process.env.GIVE) {
    await new Promise((r) => setTimeout(r, 500))
    const { execFileSync } = await import('node:child_process')
    const con = (cmd) => execFileSync('podman', ['exec', 'wren-mc', 'mc-send-to-console', cmd], { timeout: 20000 })
    con(`give ${bot.username} minecraft:diamond_chestplate[minecraft:trim={material:'minecraft:gold',pattern:'minecraft:coast'}]`)
    con(`item replace entity ${bot.username} armor.head with minecraft:iron_helmet[minecraft:trim={material:'minecraft:emerald',pattern:'minecraft:eye'}]`)
    await new Promise((r) => setTimeout(r, 1500))
    console.log('items:', bot.inventory.items().map((i) => `${i.name} nbt=${JSON.stringify(i.components?.map((c) => c.type)) ?? ''}`))
    console.log('head slot:', bot.inventory.slots[5]?.name, JSON.stringify(bot.inventory.slots[5]?.components?.map((c) => c.type)))
  }
  setTimeout(() => { console.log('quit'); bot.quit(); process.exit(0) }, 4000)
})
setTimeout(() => process.exit(1), 30000)
