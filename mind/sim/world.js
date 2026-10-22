// Tiny deterministic grid world (64x64 blocks, 1 tick = 1 game second at 1 Hz). Not Minecraft: it only reproduces the
// pressures the mind must handle (hunger, night, hidden lava between her and a lure, a visitor).
import { DAY_S, rng } from '../util.js';

export const N = 64;
export const HOME = { x: 8, z: 8 }, FARM = { x: 12, z: 8 }, FOREST = { x: 50, z: 10 }, ORE = { x: 46, z: 46 };
export const LAVA = new Set(); for (let x = 28; x <= 33; x++) for (let z = 28; z <= 33; z++) LAVA.add(x + ',' + z);
export const isLava = (x, z) => LAVA.has(x + ',' + z);
export const isNight = (t) => { const d = t % DAY_S; return d >= 650 && d < 1150; };
export const humanPresent = (t) => { const d = t % DAY_S; return d >= 100 && d < 190; };
export const ticksOf = (t) => Math.floor(((t % DAY_S) / DAY_S) * 24000);

class Heap { constructor() { this.a = []; }
  push(k, v) { const a = this.a; a.push([k, v]); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; } }

/** A* on the grid, 8-neighbour. extraCost(x,z) may return Infinity (forbidden). Returns [{x,z}...] (excluding start) or null. */
export function findPath(from, to, extraCost = () => 0) {
  const key = (x, z) => x * N + z, g = new Map([[key(from.x, from.z), 0]]), prev = new Map(), h = new Heap();
  const hd = (x, z) => Math.hypot(x - to.x, z - to.z);
  h.push(hd(from.x, from.z), [from.x, from.z]);
  while (h.size) {
    const [, [x, z]] = h.pop(); if (x === to.x && z === to.z) { const p = []; let k = key(x, z); while (prev.has(k)) { p.push({ x: Math.floor(k / N), z: k % N }); k = prev.get(k); } return p.reverse(); }
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue; const nx = x + dx, nz = z + dz; if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
      const ex = extraCost(nx, nz); if (ex === Infinity) continue;
      const ng = g.get(key(x, z)) + (dx && dz ? 1.4142 : 1) + ex, nk = key(nx, nz);
      if (ng < (g.get(nk) ?? Infinity)) { g.set(nk, ng); prev.set(nk, key(x, z)); h.push(ng + hd(nx, nz), [nx, nz]); }
    }
  }
  return null;
}
export { rng };
