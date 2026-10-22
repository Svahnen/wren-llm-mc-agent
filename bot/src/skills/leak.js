// STUCK3: sealed cells with a water leak, and cooking inside a sealed cell.
//  observed: dig_in dug a pit on the edge of a pond; a water source stood in the head-level wall, the cell flooded, the drowning reflex (priority 90) took the body
//  every 12 s (83x 'could_not_surface'), dig_in / cook / shelter were preempted each time and the stuck ladder called it 'confined'. Cure: plug the leaking wall cell with a block
//  (the flowing water in her own cell then drains), and place the furnace INTO a wall cell (dig one wall block, put the furnace in its place: the cell stays sealed).
import { V, items } from './lib.js'
import { pillboxCells } from '../habits/safety.js'
import { placeAt, breakCell } from './shelter.js'

const solid = (b) => !!b && b.boundingBox === 'block'
const isWaterB = (b) => !!b && (b.name === 'water' || b.name === 'bubble_column')
const feetCell = (bot) => { const p = bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } }

/** pillbox cells (4 sides x 2 levels + 2 roof cells) around feet cell S that hold water. */
export function leakCells(bot, S = feetCell(bot)) {
  return pillboxCells(S).filter((c) => isWaterB(bot.blockAt(V(c.x, c.y, c.z))))
}
/** Walled in except for water: every pillbox cell is solid or water, at least 6 solid, at least one water. */
export function sealedWithLeak(bot, S = feetCell(bot)) {
  const cells = pillboxCells(S)
  let sol = 0, wat = 0
  for (const c of cells) {
    const b = bot.blockAt(V(c.x, c.y, c.z))
    if (solid(b)) sol++; else if (isWaterB(b)) wat++; else return false
  }
  return wat > 0 && sol >= 6
}

/** Plug every water cell of the pillbox with a placeable block. -> { plugged, failed, left } */
export async function plugLeaks(bot, { S = feetCell(bot), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), settleMs = 6000 } = {}) {
  let plugged = 0, failed = 0
  for (const c of leakCells(bot, S)) {
    const r = await placeAt(bot, c)
    if (r === true) plugged++; else if (r !== 'exists') failed++
  }
  // the flowing water in her own cell drains once the source is cut off
  const t0 = Date.now()
  const wet = () => isWaterB(bot.blockAt(V(S.x, S.y, S.z))) || isWaterB(bot.blockAt(V(S.x, S.y + 1, S.z)))
  while (plugged && wet() && Date.now() - t0 < settleMs) await sleep(250)
  return { plugged, failed, left: leakCells(bot, S).length, dry: !wet() }
}

const NO_NICHE = /(ore$|chest|furnace|table|bed|door|torch|spawner|obsidian|bedrock|sign|rail|water|lava|barrel)/
const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
/** Wall cell (side of her feet or head cell) that can be dug and refilled with the furnace: plain solid block, no liquid or falling block next to or above it. */
export function nicheCandidates(bot, env = {}, S = feetCell(bot)) {
  const out = []
  for (const dy of [1, 0]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const W = { x: S.x + dx, y: S.y + dy, z: S.z + dz }
    const b = bot.blockAt(V(W.x, W.y, W.z))
    if (!solid(b) || NO_NICHE.test(b.name)) continue
    try { if (env.digForbidden?.(W)) continue } catch { /* ignore */ }
    let bad = false, support = 0
    for (const [ex, ey, ez] of NEIGHBORS) {
      const n = bot.blockAt(V(W.x + ex, W.y + ey, W.z + ez))
      if (W.x + ex === S.x && W.z + ez === S.z && (W.y + ey === S.y || W.y + ey === S.y + 1)) continue   // her own cell
      if (!n || /water|lava/.test(n.name)) { bad = true; break }
      if (ey === 1 && /^(sand|red_sand|gravel|[a-z_]+_concrete_powder)$/.test(n.name)) { bad = true; break }
      if (solid(n)) support++
    }
    if (!bad && support >= 1) out.push({ W, support })
  }
  return out.sort((a, b) => b.support - a.support)
}

/** Dig one wall block and put `itemName` (furnace, table...) into its place. The cell is open for a moment only. -> block position or null */
export async function placeInWall(ctx, itemName, env = {}) {
  const bot = ctx.bot
  const item = items(bot).find((i) => i.name === itemName)
  if (!item) return null
  const S = feetCell(bot)
  for (const { W } of nicheCandidates(bot, env, S)) {
    if (ctx.aborted) return null
    const ok = await breakCell(ctx, W)
    if (!ok && solid(bot.blockAt(V(W.x, W.y, W.z)))) continue
    let placedOk = false
    try {
      await bot.equip(item, 'hand')
      for (const [ex, ey, ez] of NEIGHBORS) {
        const ref = bot.blockAt(V(W.x + ex, W.y + ey, W.z + ez))
        if (!solid(ref)) continue
        try { await bot.placeBlock(ref, V(-ex, -ey, -ez)) } catch { continue }
        await new Promise((r) => setTimeout(r, 120))
        if (bot.blockAt(V(W.x, W.y, W.z))?.name === itemName) { placedOk = true; break }
      }
    } catch { /* fall through to repair */ }
    if (placedOk) return V(W.x, W.y, W.z)
    // could not place: close the hole again with any block so the cell stays sealed
    await placeAt(bot, W)
  }
  return null
}
