// PB2: the sleep approach goes to a free cell beside the bed; a remembered far bed is not "no_bed".
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { bedApproachCells, makeSleep } from '../src/skills/survival.js'

function world(cells) {   // cells: 'x,y,z' -> name
  return { entity: { position: new Vec3(0, 64, 0) }, health: 20, time: { timeOfDay: 14000 }, isABed: (b) => /_bed$/.test(b.name),
    blockAt: (p) => { const n = cells[`${p.x},${p.y},${p.z}`] ?? 'air'; return { name: n, position: new Vec3(p.x, p.y, p.z), boundingBox: n === 'air' ? 'empty' : 'block' } }, inventory: { items: () => [] } }
}
const floorAll = (extra = {}) => { const c = {}; for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) c[`${x},63,${z}`] = 'stone'; return { ...c, ...extra } }

test('bed in a corridor with walls: only the free standable cells are goals', () => {
  // bed head at (0,64,0), foot at (1,64,0); stone walls at z=-1 and the east end blocked
  const c = floorAll({ '0,64,0': 'red_bed', '1,64,0': 'red_bed', '0,64,-1': 'stone', '1,64,-1': 'stone', '-1,64,-1': 'stone', '2,64,-1': 'stone', '2,64,0': 'stone', '2,64,1': 'stone' })
  const bot = world(c)
  const bed = bot.blockAt(new Vec3(0, 64, 0))
  const cells = bedApproachCells(bot, bed, new Vec3(-3, 64, 3)).map((v) => `${v.x},${v.y},${v.z}`)
  assert.ok(cells.includes('0,64,1') && cells.includes('1,64,1') && cells.includes('-1,64,0'))
  assert.ok(!cells.includes('0,64,-1') && !cells.includes('2,64,0') && !cells.includes('1,64,0'), cells.join(' '))
  // a roof over a cell makes it unstandable
  const bot2 = world({ ...c, '0,65,1': 'stone', '0,66,1': 'stone' }); bot2.blockAt = ((f) => (p) => f(p))(bot2.blockAt)
  const cells2 = bedApproachCells(bot2, bot2.blockAt(new Vec3(0, 64, 0))).map((v) => `${v.x},${v.y},${v.z}`)
  assert.ok(!cells2.includes('0,64,1'), 'head blocked')
})
test('sleep precondition: a remembered bed beyond findBlock range is accepted, no memory = no_bed', () => {
  const bot = world(floorAll()); bot.findBlock = () => null; bot.isNight = true
  const mk = (lm) => makeSleep({ landmarks: { get: (k) => (k === 'bed' ? lm : null), set() {} } })
  const night = { ...bot, time: { timeOfDay: 14000, day: 1 } }
  const r1 = mk(null).precondition({ bot: night }), r2 = mk({ x: 100, y: 64, z: 98 }).precondition({ bot: night })
  assert.deepEqual(r1, { ok: false, reason: 'no_bed' })
  assert.equal(r2, true)
})
