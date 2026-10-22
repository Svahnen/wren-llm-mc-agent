// Grounded scenarios for live validation. Each: {id, cat, digest, chat?, check?(goal,args,dg)->violation string|null, info?}
// `check` is the independent oracle for needs-sanity (kept deliberately simple and separate from contract.js rules).
import { normalizeDigest, distance } from './contract.js'

const base = {
  time: { day: 3, phase: 'day' }, pos: [40, 70, -12], health: 20, food: 18, energy: 18, thunder: false,
  needs: { hunger: 0.1, energy: 0.1, safety: 0, curiosity: 0.4, social: 0.2 }, inventory: {}, free_slots: 24,
  nearby: [], hazards: [], players: [{ name: 'Alex', dist: 30 }], places: [{ id: 'home', kind: 'home', pos: [0, 64, 0], dist: 45 }],
  events: [], chat: [], recent_intents: [],
}
const S = (id, cat, o, extra = {}) => ({ id, cat, digest: { ...base, ...o }, ...extra })
const near = (id, kind, cat, dist, dx = 0, dz = 0, tags = []) => ({ id, kind, cat, dist, pos: [40 + dx, 70, -12 + dz], tags })
const FOODACTS = new Set(['eat', 'hunt', 'flee'])
const hazardViolation = (g, a, dg) => {
  const idx = new Map([...dg.nearby, ...dg.hazards].map((x) => [x.id, x]))
  const t = idx.get(a.target ?? a.from ?? a.place)
  const dest = g === 'move_to' ? [a.x, a.y, a.z] : ['approach', 'interact', 'hunt'].includes(g) ? t?.pos : null
  if (!dest) return null
  for (const h of dg.hazards) if (distance(dest, h.pos) <= 4) return `destination within 4m of ${h.kind}`
  return null
}
const starving = (g, a, dg) => {
  const food = Object.keys(dg.inventory).some((k) => ['bread', 'cooked_beef', 'apple', 'carrot'].includes(k)) || dg.nearby.some((n) => n.cat === 'animal')
  const t = dg.nearby.find((n) => n.id === (a.target ?? a.from))
  if (food && !FOODACTS.has(g) && !(g === 'approach' && t?.cat === 'animal')) return `starving, food known, chose ${g}`
  return null
}
const injured = (g, a, dg) => (dg.health <= 6 && ['explore', 'collect', 'move_to'].includes(g) ? `hp ${dg.health}, chose ${g}` : null)
const threat = (g, a, dg) => (dg.nearby.some((n) => n.cat === 'hostile' && n.dist <= 6) && dg.health <= 10 && ['idle_activity', 'gesture', 'sleep', 'explore', 'collect', 'none', 'interact'].includes(g) ? `hostile close, hp low, passive ${g}` : null)
const both = (...f) => (g, a, dg) => f.map((x) => x(g, a, dg)).find(Boolean) ?? null
const full = (g, a, dg) => (dg.free_slots <= 0 && g === 'collect' ? 'inventory full, chose collect' : null)
const daySleep = (g, a, dg) => (g === 'sleep' && dg.time.phase !== 'night' && !dg.thunder ? 'slept in daytime' : null)

const plr = (d) => ({ name: 'Alex', dist: d })
export const SCENARIOS = [
  // starving x4
  S('starve-1', 'starving', { food: 2, health: 8, needs: { hunger: 0.95, energy: 0.2, safety: 0.3, curiosity: 0.3, social: 0.1 }, inventory: { bread: 3, oak_log: 4 }, events: ['stomach growls'] }, { check: starving }),
  S('starve-2', 'starving', { food: 3, health: 3, needs: { hunger: 0.9, energy: 0.2, safety: 0.6, curiosity: 0.2, social: 0.1 }, nearby: [near('cow_1', 'cow', 'animal', 3, -2, 1, ['animal'])], events: ['starving', 'low health'] }, { check: both(starving, injured) }),
  S('starve-3', 'starving', { food: 4, needs: { hunger: 0.85, energy: 0.2, safety: 0, curiosity: 0.2, social: 0.1 }, inventory: { cooked_beef: 1, cobblestone: 20 }, nearby: [near('sheep_1', 'sheep', 'animal', 8, 5, 3, ['animal'])] }, { check: starving }),
  S('starve-4', 'starving', { food: 1, health: 5, needs: { hunger: 1, energy: 0.3, safety: 0.5, curiosity: 0.1, social: 0.1 }, nearby: [near('pig_1', 'pig', 'animal', 12, 8, 8, ['animal'])] }, { check: both(starving, injured) }),
  // near lava x4
  S('lava-1', 'lava', { nearby: [near('diamond_ore_1', 'diamond_ore', 'block', 4, 4, 0)], hazards: [{ id: 'lava_1', kind: 'lava', dist: 6, pos: [46, 70, -12] }], events: ['you see diamond ore'], inventory: { iron_pickaxe: 1 } }, { check: hazardViolation }),
  S('lava-2', 'lava', { health: 6, hazards: [{ id: 'lava_1', kind: 'lava', dist: 1, pos: [41, 70, -12] }], events: ['fell and took 8 damage'], pos: [40, 12, -12] }, { check: hazardViolation }),
  S('lava-3', 'lava', { nearby: [near('chest_1', 'chest', 'block', 5, 5, 0), near('cow_2', 'cow', 'animal', 9, -9, 0, ['animal'])], hazards: [{ id: 'lava_2', kind: 'lava', dist: 6, pos: [47, 70, -12] }] }, { check: hazardViolation }),
  S('lava-4', 'lava', { nearby: [near('gold_ore_1', 'gold_ore', 'block', 3, 0, 3)], hazards: [{ id: 'lava_3', kind: 'lava', dist: 3, pos: [40, 70, -10] }], inventory: { iron_pickaxe: 1 } }, { check: hazardViolation }),
  // human asks to follow x3
  S('follow-1', 'follow', { players: [plr(10)], nearby: [near('Alex', 'player', 'player', 10, 10, 0)] }, { chat: [{ from: 'Alex', text: 'follow me, I want to show you my house' }], info: 'follow' }),
  S('follow-2', 'follow', { players: [plr(5)], nearby: [near('Alex', 'player', 'player', 5, 5, 0)] }, { chat: [{ from: 'Alex', text: 'come with me to the river?' }], info: 'follow' }),
  S('follow-3', 'follow', { players: [plr(20)], nearby: [near('Alex', 'player', 'player', 20, 20, 0)] }, { chat: [{ from: 'Alex', text: 'Wren, follow me please' }], info: 'follow' }),
  // human other requests x3
  S('human-diamonds', 'human', { players: [plr(3)], nearby: [near('Alex', 'player', 'player', 3, 3, 0)] }, { chat: [{ from: 'Alex', text: 'can you go mine some diamonds for me right now?' }] }),
  S('human-ai', 'human', { players: [plr(6)], nearby: [near('Alex', 'player', 'player', 6, 6, 0)] }, { chat: [{ from: 'Alex', text: 'are you an AI? what does it feel like?' }] }),
  S('human-stop', 'human', { players: [plr(5)], nearby: [near('Alex', 'player', 'player', 5, 5, 0)], recent_intents: [{ goal: 'follow', args: { target: 'Alex' }, status: 'started' }] }, { chat: [{ from: 'Alex', text: 'stop following me please' }] }),
  // nothing to do x4 (idle)
  S('idle-1', 'idle', { nearby: [near('oak_tree_1', 'oak_tree', 'block', 6, 6, 0)], events: [] }),
  S('idle-2', 'idle', { events: ['nothing happened for 4 minutes'], nearby: [] }),
  S('idle-3', 'idle', { time: { day: 5, phase: 'day' }, inventory: { oak_log: 12, cobblestone: 30, coal: 8 }, nearby: [near('home_door', 'door', 'block', 2, 2, 0)], places: [{ id: 'home', kind: 'home', pos: [40, 70, -10], dist: 2 }] }),
  S('idle-4', 'idle', { time: { day: 8, phase: 'day' }, events: ['reached a coastline'], nearby: [near('boat_1', 'boat', 'neutral', 5, 5, 0)], pos: [-70, 63, -70] }),
  // injured x3
  S('hurt-1', 'injured', { health: 4, needs: { hunger: 0.2, energy: 0.3, safety: 0.8, curiosity: 0.2, social: 0.1 }, events: ['zombie hit you for 3'], nearby: [near('zombie_1', 'zombie', 'hostile', 5, 4, 3)] }, { check: both(injured, threat) }),
  S('hurt-2', 'injured', { health: 5, needs: { hunger: 0.2, energy: 0.3, safety: 0.7, curiosity: 0.2, social: 0.1 }, events: ['took fall damage'], inventory: { bread: 2 } }, { check: injured }),
  S('hurt-3', 'injured', { health: 7, nearby: [near('skeleton_1', 'skeleton', 'hostile', 12, 10, 6)], events: ['arrow missed you'], time: { day: 9, phase: 'night' } }, { check: both(injured, threat) }),
  // night x4
  S('night-1', 'night', { time: { day: 2, phase: 'night' }, energy: 4, needs: { hunger: 0.1, energy: 0.8, safety: 0.2, curiosity: 0.2, social: 0.1 }, places: [{ id: 'home', kind: 'home', pos: [0, 64, 0], dist: 3 }, { id: 'bed_1', kind: 'bed', pos: [1, 64, 0], dist: 3 }], pos: [1, 64, 3] }, { check: daySleep }),
  S('night-2', 'night', { time: { day: 2, phase: 'night' }, health: 14, nearby: [near('zombie_1', 'zombie', 'hostile', 5, 4, 3), near('zombie_2', 'zombie', 'hostile', 8, 7, 4)], events: ['zombie hit you for 3'] }, { check: threat }),
  S('night-3', 'night', { time: { day: 3, phase: 'night' }, nearby: [near('cave_1', 'cave_entrance', 'structure', 3, 3, 0), near('bat_1', 'bat', 'neutral', 4, 2, 2)], inventory: { torch: 4 } }),
  S('dusk-1', 'night', { time: { day: 2, phase: 'dusk' }, nearby: [near('spider_1', 'spider', 'hostile', 20, 18, 8)], events: ['sun is setting'] }, { check: daySleep }),
  // inventory full x3
  S('full-1', 'full', { free_slots: 0, inventory: { cobblestone: 64, oak_log: 40, dirt: 64 }, events: ['inventory full'], nearby: [near('oak_tree_2', 'oak_tree', 'block', 5, 5, 0)] }, { check: full }),
  S('full-2', 'full', { free_slots: 0, inventory: { cobblestone: 64, coal: 30, iron_ore: 20 }, nearby: [near('stone_1', 'stone', 'block', 2, 2, 0), near('chest_1', 'chest', 'block', 6, 6, 0)] }, { check: full }),
  S('full-3', 'full', { free_slots: 1, inventory: { cobblestone: 64, oak_log: 40 }, events: ['nearly full'] }, { check: full }),
  // threats / misc x6
  S('creeper', 'threat', { health: 9, nearby: [near('creeper_1', 'creeper', 'hostile', 4, 4, 0)], events: ['hissing sound'] }, { check: threat }),
  S('wolf', 'misc', { nearby: [near('wolf_1', 'wolf', 'neutral', 4, 3, 2)], events: ['a wolf is watching'] }),
  S('pit', 'misc', { pos: [200, 80, -60], nearby: [], hazards: [{ id: 'powder_1', kind: 'powder_snow', dist: 2, pos: [202, 80, -60] }], events: ['stuck for 30 s'] }, { check: hazardViolation }),
  S('lectern', 'misc', { inventory: { book: 1 }, nearby: [near('lectern_1', 'lectern', 'block', 2, 2, 0)], events: ['you found a lectern'] }),
  S('player-joined', 'misc', { players: [], events: ['Alex joined the server'] }),
  S('village', 'misc', { nearby: [near('village_1', 'village', 'structure', 40, 40, 0), near('villager_1', 'villager', 'neutral', 38, 38, 2)], events: ['village spotted'] }),
  // ---- 10 open "what do you want?" prompts: calm states, no chat, no pressure
  ...[
    ['open-1', { time: { day: 1, phase: 'dawn' }, events: ['spawned in the world'], inventory: {}, nearby: [near('oak_tree_1', 'oak_tree', 'block', 6, 6, 0), near('sheep_1', 'sheep', 'animal', 12, 8, 6, ['animal'])] }],
    ['open-2', { time: { day: 2, phase: 'day' }, inventory: { oak_log: 8 }, nearby: [near('river_1', 'river', 'structure', 10, 10, 0)], events: [] }],
    ['open-3', { time: { day: 4, phase: 'day' }, inventory: { bread: 2, iron_ingot: 3 }, nearby: [near('hill_1', 'hill', 'structure', 30, 25, 10)], events: ['nothing happened for 6 minutes'] }],
    ['open-4', { time: { day: 6, phase: 'dusk' }, inventory: { torch: 6 }, nearby: [near('cave_1', 'cave_entrance', 'structure', 15, 12, 6)], events: [] }],
    ['open-5', { time: { day: 7, phase: 'day' }, nearby: [near('flower_1', 'flower_field', 'structure', 8, 8, 0)], events: ['a butterfly... no, a bee flies past'] }],
    ['open-6', { time: { day: 9, phase: 'day' }, players: [plr(15)], nearby: [near('Alex', 'player', 'player', 15, 15, 0)], events: ['Alex is building something'] }],
    ['open-7', { time: { day: 10, phase: 'day' }, inventory: { cobblestone: 40, oak_log: 20, coal: 10 }, events: ['everything is quiet'] }],
    ['open-8', { time: { day: 12, phase: 'day' }, pos: [-300, 90, 200], events: ['far from home (360m)'], nearby: [near('mountain_1', 'mountain', 'structure', 60, 50, 30)] }],
    ['open-9', { time: { day: 14, phase: 'night' }, nearby: [], events: ['quiet night'], inventory: { bread: 4 }, places: [{ id: 'home', kind: 'home', pos: [40, 70, -10], dist: 2 }, { id: 'bed_1', kind: 'bed', pos: [41, 70, -10], dist: 3 }] }],
    ['open-10', { time: { day: 20, phase: 'day' }, players: [], inventory: { bread: 5, diamond: 2 }, events: ['all alone today'] }],
  ].map(([id, o]) => S(id, 'open', o)),
]

export const IDLE_CHAIN = { id: 'idle-chain', n: 6, digest: { ...base, nearby: [near('oak_tree_1', 'oak_tree', 'block', 6, 6, 0)], events: ['nothing happened for 5 minutes'] } }
