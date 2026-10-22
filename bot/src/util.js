// Small shared helpers. No dependencies.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Resolve with the value of p, or with {timedOut:true} after ms. Never rejects. */
export async function settleWithin(p, ms) {
  let t
  const timeout = new Promise((r) => { t = setTimeout(() => r({ timedOut: true }), ms) })
  try {
    const v = await Promise.race([Promise.resolve(p).then((value) => ({ value }), (error) => ({ error })), timeout])
    return v
  } finally { clearTimeout(t) }
}

/** Deterministic RNG (mulberry32). */
export function makeRng(seed = Date.now() >>> 0) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function errInfo(e) {
  return { name: e?.name, message: String(e?.message ?? e).slice(0, 300) }
}
