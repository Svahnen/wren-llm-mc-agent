// Shared helpers. Time unit everywhere: GAME SECONDS (gs). One Minecraft day = 1200 gs (24000 ticks at 20 TPS).
export const DAY_S = 1200;
export const CELL = 16; // place cell size in blocks (one chunk column)

export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const dayOf = (t) => Math.floor(t / DAY_S);
export const cellOf = (x, z, size = CELL) => [Math.floor(x / size), Math.floor(z / size)];
export const cellKey = (x, z, size = CELL) => cellOf(x, z, size).join(',');
export function parseCell(key) { const [a, b] = String(key).split(',').map(Number); return [a, b]; }
export function posKey(p) { return p && Number.isFinite(p.x) ? cellKey(p.x, p.z) : null; }
export const dist3 = (a, b) => Math.hypot(a.x - b.x, (a.y ?? 0) - (b.y ?? 0), a.z - b.z);

const STOP = new Set('the a an and or of to in on at is it i my me was were be been for with that this as by from are'.split(' '));
export function tokens(text) {
  return String(text || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.filter((w) => w.length > 1 && !STOP.has(w)) ?? [];
}
export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a), B = b instanceof Set ? b : new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
export function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}
// Deterministic seeded RNG (mulberry32).
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function hashStr(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export const estimateTokens = (obj) => Math.ceil((typeof obj === 'string' ? obj : JSON.stringify(obj)).length / 3.5);
