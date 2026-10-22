// Lessons -> hard/soft constraints for System 1 (pathfinding costs, forbidden cells, goal penalties, lockouts).
// Lessons are numbers here, not prompt text: the pathfinder consults costAt()/forbidden(), the utility scorer consults goalPenalty().
import { cellKey } from './util.js';

// per-cause hazard shape: cost radius (blocks), hard-forbid radius, peak cost, min strength to forbid
export const HAZARDS = {
  lava: { radius: 6, forbid: 3, cost: 60, forbidMin: 1 },
  fall: { radius: 5, forbid: 2, cost: 40, forbidMin: 1 },
  drown: { radius: 6, forbid: 2, cost: 40, forbidMin: 1 },
  fire: { radius: 4, forbid: 2, cost: 40, forbidMin: 1 },
  cactus: { radius: 3, forbid: 1, cost: 20, forbidMin: 1 },
  mob: { radius: 20, forbid: 0, cost: 12, forbidMin: 99 },
  other: { radius: 4, forbid: 1.5, cost: 25, forbidMin: 1.5 },
};

// a hazard seen to span `extent` blocks around the lesson point grows both radii
const widen = (h, e) => (e > 0 ? { ...h, forbid: Math.max(h.forbid, e), radius: Math.max(h.radius, e + 3) } : h);

// L1: zone distance is mostly horizontal (a lava lake is a flat thing: a death at y=50 in a cave and one at y=63 on the lake above are the
// same hazard); the vertical part counts only beyond 6 blocks, at half weight.
export const zoneDist = (p, q) => Math.hypot(p.x - q.x, p.z - q.z, Math.max(0, Math.abs((p.y ?? q.y) - (q.y ?? p.y)) - 6) * 0.5);
const CLUSTER_CAUSES = new Set(['lava', 'fire', 'fall', 'drown', 'cactus']);
const CLUSTER_RANGE = 48; // horizontal blocks: another death of the same hazard kind this close means the area is worse than one zone says

export function buildConstraints(lessons = [], { lockouts = [], now = 0 } = {}) {
  const zones = lessons.filter((l) => (l.result === 'death' || (l.result === 'fail' && l.cause)) && Number.isFinite(l.x))
    .map((l) => ({ id: l.id, p: { x: l.x, y: l.y ?? 0, z: l.z }, h: widen(HAZARDS[l.cause] ?? HAZARDS.other, l.extent || 0), s: Math.min(2, l.strength), cause: l.cause || 'other', goal_type: l.goal_type }));
  // L1: repeat deaths of the same hazard kind close together enlarge and strengthen each zone (radius +4 / forbid +1 per neighbour, max +12 / +3; strength +0.5 each)
  for (const z of zones) {
    if (!CLUSTER_CAUSES.has(z.cause)) continue;
    const nb = zones.filter((o) => o !== z && o.cause === z.cause && Math.hypot(o.p.x - z.p.x, o.p.z - z.p.z) <= CLUSTER_RANGE);
    if (!nb.length) continue;
    const k = Math.min(3, nb.length);
    z.h = { ...z.h, radius: z.h.radius + 4 * k, forbid: z.h.forbid + k };
    z.s = Math.min(2, z.s + 0.5 * nb.length);
  }
  const pen = lessons.filter((l) => l.result === 'fail' || l.result === 'death');
  return {
    zones: zones.map((z) => ({ x: z.p.x, y: z.p.y, z: z.p.z, cause: z.cause, radius: z.h.radius, forbid: z.s >= z.h.forbidMin ? z.h.forbid : 0 })),
    lockouts: lockouts.filter((l) => !l.until || l.until > now),
    /** extra path cost at a block position {x,y,z} (0 = no knowledge). Pathfinder adds this to its step cost. */
    costAt(p) {
      let c = 0;
      for (const z of zones) { const d = zoneDist(p, z.p); if (d < z.h.radius) c += z.h.cost * Math.min(1, z.s) * (1 - d / z.h.radius); }
      return c;
    },
    /** hard no-go: within the forbid radius of a lethal lesson */
    forbidden(p) { for (const z of zones) if (z.s >= z.h.forbidMin && z.h.forbid > 0 && zoneDist(p, z.p) <= z.h.forbid) return true; return false; },
    /** subtractive utility for choosing goalType near place ({x,z} or cell key) based on earlier failures/deaths. 0..0.8 */
    goalPenalty(goalType, place) {
      const cell = place && typeof place === 'object' ? cellKey(place.x, place.z) : place; let s = 0;
      for (const l of pen) if (l.goal_type === goalType && (!cell || !l.cell || l.cell === cell)) s += 0.25 * Math.min(2, l.strength);
      return Math.min(0.8, s);
    },
    isLockedOut(goalType, place, t = now) { const tok = `${goalType}@${place ?? '-'}`; return lockouts.some((l) => (l.token === tok || (l.type === goalType && l.place === place)) && (!l.until || l.until > t)); },
    lessonIdsNear(p, goalType) { return zones.filter((z) => zoneDist(p, z.p) < z.h.radius && (!goalType || z.goal_type === goalType)).map((z) => z.id); },
  };
}
