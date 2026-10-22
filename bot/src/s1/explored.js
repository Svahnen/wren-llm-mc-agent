// S1G: explored / unexplored summary for curiosity, from HER heatmap (cells she walked) and the biomes she has stood in. Perception only.
import { compass8 } from '../../../brain/goaltypes.js'

const DIRS = [['north', 0, -1], ['northeast', 1, -1], ['east', 1, 0], ['southeast', 1, 1], ['south', 0, 1], ['southwest', -1, 1], ['west', -1, 0], ['northwest', -1, -1]]
/** heat: Heatmap; pos: {x,z}; biomes: Set|array of names. -> {cells, biomes[], unexplored[], nearest_new} */
export function exploredSummary(heat, pos, biomes = [], { ring = [32, 64, 96], seen = 0 } = {}) {
  const out = { cells: heat.size, biomes: [...biomes].slice(0, 10), unexplored: [], nearest_new: null }
  for (const [name, sx, sz] of DIRS) {
    const n = Math.hypot(sx, sz)
    // a direction counts as unexplored when none of its sample cells (at 32/64/96 blocks) was ever walked
    const walked = ring.some((r) => heat.count(pos.x + (sx / n) * r, pos.z + (sz / n) * r) > seen)
    if (!walked) out.unexplored.push(name)
  }
  for (const r of [16, 32, 48, 64, 96]) {
    const free = DIRS.filter(([, sx, sz]) => { const n = Math.hypot(sx, sz); return heat.count(pos.x + (sx / n) * r, pos.z + (sz / n) * r) === 0 })
    if (free.length) { out.nearest_new = `${r}m ${free[0][0]}`; break }
  }
  if (out.unexplored.length === 8) out.unexplored = ['every direction']
  return out
}
export { compass8 }
