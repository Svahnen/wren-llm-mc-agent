// FARM1: means for a renewable food supply near home. Skills `breed_animals` (feed two adults of one kind in/at the pen with their food; success = a baby appeared)
// and `pen_slaughter` (kill ONE adult of a pen only when the pen holds >= 3 animals, so the herd keeps breeding). Both are means; S2 chooses when.
// Pure helpers (penAnimals, feedFor, isBaby, canSlaughter) are exported for the digest and the tests.
import { goals, V, dist3, items, countMatch, equipBest, collectDrops } from './lib.js'
import { placeAt } from './shelter.js'
import { penCells, placeItemAt } from './activities.js'

export const BREEDABLE = ['cow', 'sheep', 'pig', 'chicken']
/** which held item feeds which animal (vanilla breeding foods) */
export const FEED = { cow: /^wheat$/, sheep: /^wheat$/, pig: /^(carrot|potato|beetroot)$/, chicken: /^(wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds)$/ }
export const MIN_SLAUGHTER = 3
// RS3 breed guard (RS2 entry 20): parents have a 5 min cooldown after breeding, a baby needs 20 min to grow, and a pen is kept at 4-6 animals of a kind.
export const BREED_COOLDOWN_MS = 5 * 60000, BABY_GROW_MS = 20 * 60000, BREED_CAP = 6
/** Pure. animals = penAnimals(...) list, log = { [kind]: lastFedAt ms }. -> null (go ahead) | { reason: 'pen_full'|'breed_cooldown', detail, wait_s? } */
export function breedGuard(animals, kind, log = {}, now = Date.now()) {
  const of = animals.filter((a) => a.name === kind), adults = of.filter((a) => !a.baby).length, babies = of.length - adults
  if (of.length >= BREED_CAP) return { reason: 'pen_full', detail: `${of.length} ${kind}s here (${adults} adults, ${babies} babies); the pen is kept at ${BREED_CAP - 2}-${BREED_CAP}: take meat (pen_slaughter) instead of breeding more` }
  const t = log[kind]
  if (Number.isFinite(t) && now - t < BREED_COOLDOWN_MS) {
    const left = Math.ceil((BREED_COOLDOWN_MS - (now - t)) / 1000)
    return { reason: 'breed_cooldown', wait_s: left, detail: `the ${kind}s bred ${Math.round((now - t) / 60000)} min ago: parents can breed again in ${Math.ceil(left / 60)} min (5 min cooldown), a baby needs 20 min to grow (feeding it wheat/seeds speeds that up)` }
  }
  return null
}
const solid = (b) => !!b && b.boundingBox === 'block'
const at = (bot, x, y, z) => bot.blockAt(V(x, y, z))

/** baby animal? The ageable `baby` flag sits in the entity metadata as a boolean; a baby is also about half the height. */
export function isBaby(e) {
  if (!e) return false
  if (e.isBaby === true || e.baby === true) return true
  const md = e.metadata
  if (Array.isArray(md) && md.some((m, i) => (i === 16 || i === 17) && m === true)) return true
  return false
}
/** animals standing in the pen square around `c` (half-width 2.6). -> [{e, name, baby}] */
export function penAnimals(bot, c, half = 2.6) {
  const out = []
  for (const e of Object.values(bot.entities ?? {})) {
    if (!e || e === bot.entity || !e.position || !BREEDABLE.includes(e.name)) continue
    if (Math.abs(e.position.x - (c.x + 0.5)) > half || Math.abs(e.position.z - (c.z + 0.5)) > half || Math.abs(e.position.y - c.y) > 3) continue
    out.push({ e, name: e.name, baby: isBaby(e) })
  }
  return out
}
/** kinds with >= 2 adults and a held feed item. -> [{kind, adults, babies, food}] best first */
export function breedable(bot, animals) {
  const by = {}
  for (const a of animals) { const o = (by[a.name] ??= { kind: a.name, adults: 0, babies: 0 }); a.baby ? o.babies++ : o.adults++ }
  return Object.values(by).filter((o) => o.adults >= 2 && items(bot).some((i) => FEED[o.kind].test(i.name))).sort((a, b) => b.adults - a.adults)
}
/** slaughter rule: the kind with the most adults, only when the pen holds >= 3 animals in total and that kind has >= 2 adults (one stays to breed). -> kind | null */
export function canSlaughter(animals) {
  if (animals.length < MIN_SLAUGHTER) return null
  const by = {}; for (const a of animals) if (!a.baby) by[a.name] = (by[a.name] ?? 0) + 1
  const best = Object.entries(by).sort((a, b) => b[1] - a[1])[0]
  return best && best[1] >= 2 ? best[0] : null
}

const gateCell = (C) => penCells(C).find((c) => c.gate)
/** open the pen gate for work: break the block(s) in the gate cell (or open a gate), remembering what to put back. -> { restore() } */
async function openGate(ctx, C) {
  const bot = ctx.bot, g = gateCell(C), removed = []
  for (const dy of [0, 1]) {
    const b = at(bot, g.x, g.y + dy, g.z)
    if (!solid(b) && !/fence/.test(b?.name ?? '')) continue
    if (/_fence_gate$/.test(b.name)) { try { await bot.activateBlock(b) } catch { /* ignore */ } continue }
    const r = await goNear(ctx, g.x, g.y, g.z + 2); if (!r) break
    try { await equipBest(bot, 'pickaxe').catch(() => {}); await bot.dig(b); removed.push({ y: g.y + dy, name: b.name }) } catch { /* next */ }
  }
  return {
    gate: g, removed,
    async restore() {
      for (const rm of removed) {
        const cell = { x: g.x, y: rm.y, z: g.z }
        try {
          if (/_fence$/.test(rm.name)) await placeItemAt(bot, cell, /_fence$/)
          else { const it = items(bot).find((i) => i.name === rm.name) ?? items(bot).find((i) => /^(dirt|cobblestone|stone|[a-z_]+_planks)$/.test(i.name)); if (it) { await bot.equip(it, 'hand'); await placeAt(bot, cell) } }
        } catch { /* best effort */ }
      }
    },
  }
}
async function goNear(ctx, x, y, z, r = 1) { const g = await ctx.goto(new goals.GoalNear(x, y, z, r), { timeoutMs: 15000 }); return !!g?.ok }

let ENV = null
function penOf() { return ENV?.landmarks?.get?.('pen') ?? null }

export function makeBreedAnimals(env) {
  return {
    name: 'breed_animals', max_s: 120, stall_s: 40,
    precondition: ({ bot }) => {
      if (!bot?.entity || bot.health <= 0) return false
      if (!items(bot).some((i) => Object.values(FEED).some((re) => re.test(i.name)))) return { ok: false, reason: 'no_feed', note: 'wheat for cows and sheep, carrots/potatoes/beetroot for pigs, seeds for chickens' }
      return true
    },
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.fed ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, lm = penOf(ctx) ?? (() => { const p = bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } })()
      const C = { x: Math.floor(lm.x), y: Math.floor(lm.y), z: Math.floor(lm.z) }
      ctx.state.stage = 'look'
      const here = (penOf(ctx) ? penAnimals(bot, C) : Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && BREEDABLE.includes(e.name) && dist3(e.position, bot.entity.position) <= 12).map((e) => ({ e, name: e.name, baby: isBaby(e) })))
      const pick = breedable(bot, here)[0]
      if (!pick) return { ok: false, reason: 'cannot_breed', note: here.length ? `need 2 adults of one kind and their food (${here.length} animals here)` : 'no animals in the pen or near me', animals: here.length }
      const guard = breedGuard(here, pick.kind, (env.breedLog ??= {}))   // RS3: cooldown and pen size
      if (guard) return { ok: false, reason: guard.reason, detail: guard.detail, kind: pick.kind }
      const before = here.filter((a) => a.name === pick.kind && a.baby).length   // success = a NEW baby (totals also change when an animal wanders in through the open gate)
      ctx.state.stage = 'feed'
      // reach: close to the animal and in line of sight; a walled pen is opened at the gate first
      let gate = null
      if (penOf(ctx) && dist3(bot.entity.position, V(C.x + 0.5, C.y, C.z + 0.5)) > 2.5) { const g = gateCell(C); if (await goNear(ctx, g.x, g.y, g.z + 2)) gate = await openGate(ctx, C) }
      let fed = 0
      try {
        if (gate) await goNear(ctx, C.x, C.y, C.z, 1)
        for (const a of here.filter((x) => x.name === pick.kind && !x.baby).slice(0, 2)) {
          if (ctx.aborted) break
          const food = items(bot).find((i) => FEED[pick.kind].test(i.name)); if (!food) break
          if (dist3(a.e.position, bot.entity.position) > 2.8) await goNear(ctx, a.e.position.x, a.e.position.y, a.e.position.z, 2)
          try { await bot.equip(food, 'hand'); await bot.lookAt(a.e.position.offset(0, (a.e.height ?? 1) * 0.6, 0)); await bot.activateEntity(a.e); fed++; ctx.state.fed = fed } catch { /* next */ }
          await ctx.sleep(500)
        }
        if (gate) { const g0 = gate; gate = null; await goNear(ctx, g0.gate.x, g0.gate.y, g0.gate.z + 2); await g0.restore() }   // close the gate before the baby is born: it must not wander out
        if (fed >= 2) (env.breedLog ??= {})[pick.kind] = Date.now()   // love mode used the food: the parents' 5 min cooldown starts now, baby or not
        ctx.state.stage = 'wait'
        const t0 = Date.now(); let after = before
        while (fed >= 2 && Date.now() - t0 < 35000 && !ctx.aborted) {
          await ctx.sleep(1500)
          const now = penOf(ctx) ? penAnimals(bot, C) : Object.values(bot.entities ?? {}).filter((e) => e && e.position && e.name === pick.kind && dist3(e.position, bot.entity.position) <= 14).map((e) => ({ e, name: e.name, baby: isBaby(e) }))
          after = now.filter((a) => a.name === pick.kind && a.baby).length
          if (after > before) break
        }
        ctx.state.stage = 'done'
        if (fed < 2) return { ok: false, reason: 'could_not_feed', fed, kind: pick.kind }
        return after > before ? { ok: true, reason: 'baby_born', kind: pick.kind, fed, babies: after } : { ok: false, reason: 'no_offspring_yet', kind: pick.kind, fed, note: 'both are in love mode for 30 s; they need to stay together, try again later' }
      } finally { if (gate) { await goNear(ctx, gate.gate.x, gate.gate.y, gate.gate.z + 2); await gate.restore() } }
    },
    abort: (_r, ctx) => { try { ctx.bot.clearControlStates?.() } catch { /* ignore */ } },
  }
}

export function makePenSlaughter(env) {
  return {
    name: 'pen_slaughter', max_s: 90, stall_s: 30,
    precondition: ({ bot }) => {
      if (!bot?.entity || bot.health <= 0) return false
      const lm = env.landmarks?.get?.('pen'); if (!lm) return { ok: false, reason: 'no_pen_known' }
      const an = penAnimals(bot, { x: Math.floor(lm.x), y: Math.floor(lm.y), z: Math.floor(lm.z) })
      return canSlaughter(an) ? true : { ok: false, reason: 'pen_too_small', note: `the pen holds ${an.length} animals; killing waits until it has ${MIN_SLAUGHTER} (breed first)` }
    },
    progress_fn: (ctx) => `${ctx.state.stage ?? 'start'}:${ctx.state.hits ?? 0}`,
    async run(ctx) {
      const bot = ctx.bot, lm = env.landmarks.get('pen'), C = { x: Math.floor(lm.x), y: Math.floor(lm.y), z: Math.floor(lm.z) }
      const an = penAnimals(bot, C), kind = canSlaughter(an); if (!kind) return { ok: false, reason: 'pen_too_small' }
      const target = an.filter((a) => a.name === kind && !a.baby).sort((a, b) => dist3(a.e.position, bot.entity.position) - dist3(b.e.position, bot.entity.position))[0]
      const before = countMatch(bot, /^(beef|porkchop|mutton|chicken)$/)
      ctx.state.stage = 'open'
      let gate = null
      if (dist3(bot.entity.position, V(C.x + 0.5, C.y, C.z + 0.5)) > 2.5) { const g = gateCell(C); if (await goNear(ctx, g.x, g.y, g.z + 2)) gate = await openGate(ctx, C) }
      try {
        await equipBest(bot, 'sword').catch(() => {})
        ctx.state.stage = 'kill'
        const t0 = Date.now(); const e = target.e
        while (Date.now() - t0 < 30000 && !ctx.aborted && bot.entities[e.id]) {
          if (dist3(e.position, bot.entity.position) > 3) await goNear(ctx, e.position.x, e.position.y, e.position.z, 2)
          try { await bot.lookAt(e.position.offset(0, (e.height ?? 1) * 0.6, 0)); bot.attack(e); ctx.state.hits = (ctx.state.hits ?? 0) + 1 } catch { /* ignore */ }
          await ctx.sleep(650)
        }
        await ctx.sleep(400)
        await collectDrops(ctx, e.position, { r: 6, max: 4 })
      } finally { if (gate) { await goNear(ctx, gate.gate.x, gate.gate.y, gate.gate.z + 2); await gate.restore() } }
      const gained = countMatch(bot, /^(beef|porkchop|mutton|chicken)$/) - before
      return gained > 0 ? { ok: true, reason: 'slaughtered', kind, gained, left: an.length - 1 } : { ok: false, reason: 'nothing_gained', kind }
    },
    abort: (_r, ctx) => { try { ctx.bot.clearControlStates?.() } catch { /* ignore */ } },
  }
}

export function makeFarm1Skills(env) { ENV = env; return [makeBreedAnimals(env), makePenSlaughter(env)] }
