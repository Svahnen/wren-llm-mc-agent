// FOOD2: live escape_pillar_up 'ceiling' failures happened in water under a roof; pillar_up must not be offered there.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { pillarAllowed, planEscape } from '../src/escape/skills.js'
const AIR = { name: 'air', boundingBox: 'empty' }, STONE = { name: 'stone', boundingBox: 'block' }, WATER = { name: 'water', boundingBox: 'empty' }
function world() {
  const bot = new EventEmitter()
  bot.blockAt = (v) => { const y = Math.floor(v.y); if (y < 62) return STONE; if (y <= 63) return WATER; if (y === 65) return STONE; return AIR }   // water to y 63, roof at 65 (2 above feet 63)
  bot.entity = { position: new Vec3(0.5, 63, 0.5), onGround: false, isInWater: true, yaw: 0 }
  bot.health = 3; bot.time = { timeOfDay: 18000 }
  bot.inventory = { items: () => [{ name: 'cobblestone', count: 20, type: 1 }] }
  bot.registry = { blocksByName: { cobblestone: { boundingBox: 'block', transparent: false } } }
  return bot
}
test('in water under a roof within 2 blocks: pillar_up not allowed nor planned', () => {
  const bot = world()
  assert.equal(pillarAllowed(bot), false)
  assert.ok(!planEscape(bot).cands.includes('escape_pillar_up'))
})
