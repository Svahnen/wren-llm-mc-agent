// Mock world + bot with a tiny physics sim for reflex unit tests. Not a Minecraft emulator: just enough to
// make walking, swimming, stepping up, falling and digging observable.
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { Trace } from '../src/trace.js'
import { Arbiter } from '../src/arbiter.js'
import { Metrics } from '../src/metrics.js'
import { installReflexes } from '../src/reflex/index.js'

const SOLID = new Set(['stone', 'cobblestone', 'dirt', 'sand', 'gravel', 'oak_planks', 'magma_block', 'cactus', 'bedrock'])
const mk = (name, x, y, z) => ({
  name, position: new Vec3(x, y, z),
  boundingBox: SOLID.has(name) ? 'block' : 'empty',
  transparent: !SOLID.has(name),
  metadata: 0,
})

export class World {
  constructor(def = () => 'air') { this.def = def; this.over = new Map() }
  set(x, y, z, name) { this.over.set(`${x},${y},${z}`, name) }
  fill(x1, y1, z1, x2, y2, z2, name) { for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) this.set(x, y, z, name) }
  name(x, y, z) { return this.over.get(`${x},${y},${z}`) ?? this.def(x, y, z) }
  block(x, y, z) { return mk(this.name(x, y, z), x, y, z) }
}
/** flat stone ground, top surface at y=63 (stand at y=64) */
export const flat = () => new World((x, y, z) => (y <= 63 ? 'stone' : 'air'))

export function mockBot(world, { pos = [0.5, 64, 0.5], simMs = 20 } = {}) {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(...pos), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, isInWater: false, isInLava: false, metadata: [0], eyeHeight: 1.62, height: 1.8, isCollidedHorizontally: false }
  bot.health = 20; bot.food = 20; bot.oxygenLevel = 20
  bot.controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  bot.entities = {}
  bot.world = world
  bot.calls = { dig: [], place: [], attack: [], equip: [], consume: 0, clear: 0, activate: 0 }
  bot.items = []
  bot.inventory = { items: () => bot.items, slots: [] }
  bot.registry = { foodsByName: { bread: { foodPoints: 5 }, cooked_beef: { foodPoints: 8 }, rotten_flesh: { foodPoints: 4 }, apple: { foodPoints: 4 } }, blocksByName: { cobblestone: { boundingBox: 'block' }, dirt: { boundingBox: 'block' }, stone: { boundingBox: 'block' } } }
  bot.blockAt = (v) => world.block(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z))
  bot.setControlState = (k, v) => { bot.controlState[k] = !!v }
  bot.clearControlStates = () => { bot.calls.clear++; for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false }
  bot.stopDigging = () => {}
  bot.deactivateItem = () => {}
  bot.activateItem = () => { bot.calls.activate++ }
  bot.pathfinder = { stop() {}, setGoal() {} }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.lookAt = async (v) => { const p = bot.entity.position; bot.entity.yaw = Math.atan2(-(v.x - p.x), -(v.z - p.z)) }
  bot.equip = async (item) => { bot.calls.equip.push(item.name); bot.held = item }
  bot.canDigBlock = (b) => b.name !== 'bedrock'
  bot.dig = async (b) => { bot.calls.dig.push(b.name); world.set(b.position.x, b.position.y, b.position.z, 'air') }
  bot.placeBlock = async (ref, face) => {
    const t = ref.position.plus(face)
    bot.calls.place.push([t.x, t.y, t.z]); world.set(t.x, t.y, t.z, bot.held?.name ?? 'stone')
  }
  bot.attack = (e) => { bot.calls.attack.push(e.name); e.hits = (e.hits ?? 0) + 1; if (e.hits >= (e.hitsToKill ?? 4)) { e.isValid = false; e.health = 0; delete bot.entities[e.id] } }
  bot.consume = async () => { bot.calls.consume++; bot.food = Math.min(20, bot.food + (bot.held ? bot.registry.foodsByName[bot.held.name]?.foodPoints ?? 0 : 0)); const it = bot.held; if (it) { it.count--; if (it.count <= 0) bot.items = bot.items.filter((i) => i !== it) } }
  bot.give = (name, count = 1) => { const it = { name, count }; bot.items.push(it); return it }
  bot.addEntity = (name, x, y, z, extra = {}) => { const id = Object.keys(bot.entities).length + 1000 + Math.floor(Math.random() * 1e6); const e = { id, name, position: new Vec3(x, y, z), height: 1.95, health: 20, isValid: true, ...extra }; bot.entities[id] = e; return e }

  const cellName = (x, y, z) => world.name(Math.floor(x), Math.floor(y), Math.floor(z))
  const isSolidAt = (x, y, z) => SOLID.has(cellName(x, y, z))
  const liquidAt = (x, y, z) => { const n = cellName(x, y, z); return n === 'water' ? 'water' : n === 'lava' ? 'lava' : null }
  bot.sim = setInterval(() => {
    const e = bot.entity, p = e.position, c = bot.controlState
    const wet = liquidAt(p.x, p.y, p.z) || liquidAt(p.x, p.y + 1, p.z)
    e.isInWater = wet === 'water'; e.isInLava = wet === 'lava'
    const before = p.clone()
    if (bot.jumpHop && c.jump && !wet && e.onGround && isSolidAt(p.x, p.y - 0.01, p.z)) { p.y += 1.05; e.onGround = false; bot.__hover = Date.now() + 160 }   // SURV4: opt-in single hop for pillar tests
    if (c.forward) {
      const sp = c.sprint ? 0.13 : 0.1
      const nx = p.x - Math.sin(e.yaw) * sp, nz = p.z - Math.cos(e.yaw) * sp
      const fy = Math.floor(p.y + 0.001)
      const blocked = isSolidAt(nx, fy, nz) || isSolidAt(nx, fy + 1, nz)
      if (!blocked) { p.x = nx; p.z = nz; e.isCollidedHorizontally = false }
      else if (c.jump && !isSolidAt(nx, fy + 1, nz) && !isSolidAt(nx, fy + 2, nz) && !isSolidAt(p.x, fy + 2, p.z)) { p.x = nx; p.z = nz; p.y = fy + 1; e.isCollidedHorizontally = false }
      else if (wet && c.jump) { // vanilla/prismarine-physics: swimming into a ledge pops you out
        let done = false
        for (const yy of [fy + 1, fy + 2]) {
          if (!isSolidAt(nx, yy - 1, nz) || isSolidAt(nx, yy, nz) || isSolidAt(nx, yy + 1, nz)) continue
          if (yy - p.y <= 1.7) { p.x = nx; p.z = nz; p.y = yy; done = true; break }
        }
        e.isCollidedHorizontally = !done
      } else e.isCollidedHorizontally = true
    }
    if (wet) {
      if (c.jump) { const headWater = liquidAt(p.x, p.y + 0.12 + 1.62, p.z) || liquidAt(p.x, p.y + 0.12 + 1.0, p.z); if (headWater) p.y += 0.12 }
      else if (!isSolidAt(p.x, p.y - 0.05, p.z)) p.y -= 0.05
      e.onGround = false
      if (isSolidAt(p.x, p.y - 0.001, p.z)) { p.y = Math.floor(p.y - 0.001) + 1 }
    } else if (bot.__hover > Date.now()) { e.onGround = false
    } else if (!isSolidAt(p.x, p.y - 0.01, p.z)) {
      p.y -= 0.5
      if (isSolidAt(p.x, p.y - 0.01, p.z)) p.y = Math.floor(p.y - 0.01) + 1
      e.onGround = false
    } else { e.onGround = true }
    e.velocity.x = p.x - before.x; e.velocity.z = p.z - before.z; e.velocity.y = p.y - before.y
    // breath
    const headWet = liquidAt(p.x, p.y + 1.62, p.z) === 'water'
    bot.oxygenLevel = headWet ? Math.max(0, bot.oxygenLevel - 0.1) : Math.min(20, bot.oxygenLevel + 0.5)
  }, simMs)
  bot.sim.unref?.()   // HYG1: a leaked sim interval kept node alive after the tests passed
  bot.destroy = () => clearInterval(bot.sim)
  return bot
}

const rigs = []
export async function stopAll() { for (const s of rigs.splice(0)) await s().catch(() => {}) }
export function rig(world, botOpts = {}, reflexOpts = {}) {
  const bot = mockBot(world, botOpts)
  const body = new EventEmitter()
  body.bot = bot; body.state = 'spawned'; Object.defineProperty(body, 'spawned', { get: () => body.state === 'spawned' })
  const trace = new Trace({ keepLast: 2000 })
  const metrics = new Metrics()
  const arbiter = new Arbiter({ getBot: () => bot, trace, metrics, preemptTimeoutMs: 300 })
  const reflex = installReflexes(body, arbiter, trace, metrics, { autoStart: false, cfg: { tickMs: 30, ...reflexOpts.cfg }, ...reflexOpts })
  reflex.start()
  const stop = async () => { await reflex.stop(); bot.destroy(); metrics.stop() }
  rigs.push(stop)
  return { bot, body, trace, metrics, arbiter, reflex, stop }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export async function until(fn, ms = 5000, step = 20) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step) } return false }
export const noKeys = (bot) => Object.values(bot.controlState).every((v) => !v)
