// S1G: the action repertoire per goal type: which skills can serve a goal, when they apply, and how to tell the goal is achieved.
// This is HOW, never WHAT: S2 chose the goal; S1 only picks among these skills (scored by utility + goal terms + learned scorer) and re-plans on failure.
// Extend with registerGoalOptions(type, [...]). Option = {name, skill|route, args(c, g), applies(c, g), base, goalTerm?(c, g, mods)}.
//   c = habit situation (inventory facts, animals, night, ...) + c.t (target facts), g = goal state {spec, t0, start, ...}
const pick = (rng, a) => a[Math.floor(rng() * a.length) % a.length]
const DIRS = ['north', 'south', 'east', 'west', 'any']
const o = (name, skill, args, applies, base, extra = {}) => ({ name, skill, args, applies, base, ...extra })

const RES = {
  wood: { re: /_log$/, skill: 'gather_wood', args: { count: 4 } },
  stone: { re: /^(cobblestone|stone)$/, skill: 'gather_stone', args: { count: 8 } },
  coal: { re: /^(coal|charcoal)$/, skill: 'collect', args: { resource: 'coal', count: 3 } },
  iron: { re: /^(raw_iron|iron_ore|iron_ingot)$/, skill: 'collect', args: { resource: 'iron', count: 3 } },
  sand: { re: /^sand$/, skill: 'collect', args: { resource: 'sand', count: 6 } },
  dirt: { re: /^dirt$/, skill: 'collect', args: { resource: 'dirt', count: 8 } },
  plants: { re: /(flower|tulip|dandelion|poppy|orchid|allium|cornflower|daisy|fern|seeds|berries)/, skill: 'collect', args: { resource: 'plants', count: 3 } },
}
export const resourceOf = (t) => RES[t] ?? null

const nearTarget = (c) => c.t?.pos && c.t.dist <= 4.5

export const OPTIONS = {
  get_food: [
    o('eat', 'eat', () => ({}), (c) => (c.inv.food > 0 || (c.inv.badFood > 0 && ((c.bot.food ?? 20) <= 6 || ((c.bot.health ?? 20) <= 6 && (c.bot.food ?? 20) < 18)))) && (c.bot.food ?? 20) < 20, 3.0, { goalTerm: (c, g, m) => 1.2 * (m.urgency ?? 0.3) + ((c.bot.health ?? 20) < 20 && (c.bot.food ?? 20) < 18 ? 1.5 : 0) }),
    // G2 cooking: raw meat in the pack is cooked first (cooked gives 2-3x the food) unless she is starving right now; no furnace -> stock cobblestone for one
    o('cook', 'cook', () => ({}), (c) => c.inv.raw > 0 && c.inv.fuel >= Math.min(c.inv.raw, 2) && (c.inv.furnace > 0 || c.inv.cobble >= 8 || c.furnaceKnown) && (c.bot.food ?? 20) > 5, 3.4, { goalTerm: (c, g, m) => 0.8 * (1 - (m.urgency ?? 0.3)) }),
    o('stock_cobble', 'gather_stone', () => ({ count: 8 }), (c) => c.inv.raw > 0 && c.inv.fuel >= Math.min(c.inv.raw, 2) && c.inv.furnace === 0 && c.inv.cobble < 8 && !c.furnaceKnown && c.inv.free >= 2 && !c.dark && (c.bot.food ?? 20) > 6, 2.2),
    o('hunt', 'hunt', () => ({}), (c) => c.animals > 0 && c.inv.free >= 2, 2.4, { goalTerm: (c) => (c.animalNear < 24 ? 0.4 : 0) }),
    // VAL1: cod/salmon in view and no land animal (or a sword in hand): hit it from the bank; fishing needs a rod, hunting does not
    o('hunt_fish', 'hunt', () => ({ target: 'fish' }), (c) => c.fish > 0 && c.inv.free >= 2, 2.3, { goalTerm: (c) => (c.animals === 0 ? 0.8 : -0.4) + (c.inv.sword > 0 || c.inv.axe > 0 ? 0.4 : 0) }),
    o('go_to_food_source', null, null, (c) => c.animals === 0 && !!c.foodSrc && c.foodSrc.dist > 6 && c.inv.free >= 2, 2.3, { route: 'food' }), // a remembered animal herd (perception memory), then hunt again
    o('fish', 'fish', () => ({}), (c) => c.inv.rod > 0 && c.water && !c.dark, 1.3),
    o('seek_food', 'explore', (c) => ({ direction: pick(c.rng, DIRS) }), (c) => c.inv.food === 0 && !c.dark && !c.underground, 1.0, { goalTerm: (c, g, m) => -1.2 * (m.caution ?? 0) }),
    o('wander_food', 'wander', () => ({}), (c) => c.inv.food === 0 && !c.dark && !c.underground, 0.6),
  ],
  find_resource: [
    o('collect_target', null, null, () => false, 0), // replaced per goal by resourceOptions()
  ],
  go_to_place: [
    o('go_direct', (c, g) => (g.target.place ? 'go_to' : 'move_to'), (c, g) => (g.target.place ? { place: g.target.place } : { x: g.target.x, y: g.target.y, z: g.target.z, radius: 3 }), (c, g) => !!g.target && (c.t?.dist ?? 0) <= 90, 3.0),
    o('travel_route', null, null, (c, g) => !!g.target && (c.t?.dist ?? 0) > 4.5, 2.0, { route: true, goalTerm: (c) => (c.t?.dist > 60 ? 1.5 : 0) }),
    o('explore_toward', 'explore', (c, g) => ({ direction: g.target?.dir ?? 'any' }), (c, g) => !!g.target && (c.t?.dist ?? 0) > 20, 0.5),
  ],
  follow_person: [
    o('approach_person', 'approach', (c, g) => ({ target: g.spec.target }), (c) => !!c.t?.pos && c.t.dist > 12, 3.0),
    o('follow', 'follow', (c, g) => ({ target: g.spec.target, duration_s: 45 }), (c) => !!c.t?.pos, 2.6),
    o('look_for_person', 'explore', (c) => ({ direction: pick(c.rng, DIRS) }), (c) => !c.t?.pos && !c.dark, 0.7),
  ],
  build_shelter: [
    o('shelter', 'shelter', () => ({}), (c) => c.inv.blocks >= 9 || c.sealed, 3.0),
    o('stock_blocks', 'collect', () => ({ resource: 'dirt', count: 12 }), (c) => c.inv.blocks < 9 && c.inv.free >= 2, 2.5),
    o('take_cover', 'take_cover', () => ({}), (c) => c.exposed?.length > 0, 4.0),
    o('dig_in', 'dig_in', () => ({}), (c) => !c.sealed && (c.inv.blocks >= 6 || (c.inv.pickaxe > 0 && c.inv.blocks >= 1)) && ((c.bot.health ?? 20) <= 10 || c.dark), 3.2, { goalTerm: (c) => ((c.bot.health ?? 20) <= 6 ? 2.5 : 0) }),
  ],
  explore_area: [
    o('explore', 'explore', (c, g) => ({ direction: g.target?.dir ?? pick(c.rng, DIRS) }), (c) => !c.underground && !c.dark, 2.4, { goalTerm: (c, g, m) => -1.5 * (m.caution ?? 0) }),
    o('wander', 'wander', () => ({}), (c) => !c.underground && !c.dark, 1.2),
    o('return_to_surface', 'return_to_surface', () => ({}), (c) => c.underground, 2.5),
  ],
  rest: [
    o('sleep', 'sleep', () => ({ max_stay_s: 120 }), (c) => (c.night || c.thunder) && (c.bedKnown || c.inv.beds > 0) && !c.sleepLocked, 3.5),
    o('shelter', 'shelter', () => ({}), (c) => c.dark && (c.inv.blocks >= 9 || c.sealed), 2.5),
    o('dig_in', 'dig_in', () => ({}), (c) => !c.sealed && (c.inv.blocks >= 6 || (c.inv.pickaxe > 0 && c.inv.blocks >= 1)) && ((c.bot.health ?? 20) <= 10 || c.dark) && (c.dark || c.hostiles > 0), 2.6, { goalTerm: (c) => ((c.bot.health ?? 20) <= 6 ? 2.5 : 0) }),
    o('rest', 'idle_activity', () => ({ kind: 'rest' }), () => true, 2.0),
    o('sit', 'idle_activity', () => ({ kind: 'sit' }), () => true, 1.0),
  ],
  talk: [
    o('approach_person', 'approach', (c, g) => ({ target: g.spec.target }), (c, g) => !!g.spec?.target && !!c.t?.pos && c.t.dist > 5, 2.6),
    o('look_at', 'look_at', (c, g) => (g.spec.target ? { target: g.spec.target, hold_ms: 2000 } : {}), (c) => c.players.length > 0 || !!c.t?.pos, 2.0, { goalTerm: (c, g, m) => 1.5 * (m.sociability ?? 0) }),
    o('wave', 'gesture', () => ({ kind: 'wave' }), (c) => c.playerNear || nearTarget(c), 1.0),
  ],
  defend: [
    o('take_cover', 'take_cover', () => ({}), (c) => c.exposed?.length > 0, 4.0),
    // G2: defending means FIGHTING with the best weapon she holds (she once ran from a zombie while holding a sword); fleeing stays for low health
    o('fight', 'fight', (c, g) => (g.spec.target ? { target: g.spec.target } : {}), (c) => c.hostiles > 0 && (c.bot.health ?? 20) > 6, 4.2, { goalTerm: (c, g, m) => (c.inv.sword > 0 ? 2.2 : c.inv.axe > 0 ? 1.0 : -0.8) + 0.8 * (1 - (m.caution ?? 0.3)) - (c.bot.health <= 10 ? 1.2 : 0) }),
    o('flee', 'flee', (c, g) => (g.spec.target ? { from: g.spec.target } : {}), (c) => c.hostiles > 0 && (c.bot.health ?? 20) <= 10, 3.0, { goalTerm: (c, g, m) => 2 * (m.caution ?? 0) }),
    o('dig_in', 'dig_in', () => ({}), (c) => !c.sealed && (c.inv.blocks >= 6 || (c.inv.pickaxe > 0 && c.inv.blocks >= 1)) && ((c.bot.health ?? 20) <= 10 || c.dark) && ((c.bot.health ?? 20) <= 6 || c.hostiles > 0), 3.4, { goalTerm: (c) => ((c.bot.health ?? 20) <= 6 ? 2.5 : 0) }),
    o('hold', 'idle_activity', () => ({ kind: 'look_around' }), () => true, 0.8),
  ],
  avoid: [
    o('flee', 'flee', (c, g) => (g.spec.target && !g.target?.pos ? { from: g.spec.target } : {}), (c, g) => !!g.spec.target && !g.target?.isPlace, 2.5),
    o('move_away', 'move_to', (c, g) => awayPoint(c, g), (c, g) => !!c.t?.pos, 3.0),
    o('shelter', 'shelter', () => ({}), (c) => c.dark && (c.inv.blocks >= 9 || c.sealed), 1.0),
    o('dig_in', 'dig_in', () => ({}), (c) => !c.sealed && (c.inv.blocks >= 6 || (c.inv.pickaxe > 0 && c.inv.blocks >= 1)) && ((c.bot.health ?? 20) <= 10 || c.dark) && (c.hostiles > 0 || (c.bot.health ?? 20) <= 6), 2.8, { goalTerm: (c) => ((c.bot.health ?? 20) <= 6 ? 2.5 : 0) }),
  ],
  custom: [], // filled from the habit repertoire (see selector.customOptions)
}
function awayPoint(c, g) {
  const me = c.bot.entity.position, t = c.t.pos
  const dx = me.x - t.x, dz = me.z - t.z, n = Math.hypot(dx, dz) || 1
  return { x: Math.round(me.x + (dx / n) * 24), y: Math.round(me.y), z: Math.round(me.z + (dz / n) * 24), radius: 4 }
}

export function resourceOptions(resource) {
  const r = RES[resource]
  if (!r) return [o('explore_search', 'explore', (c) => ({ direction: pick(c.rng, DIRS) }), (c) => !c.dark && !c.underground, 1.0)]
  return [
    o(`collect_${resource}`, r.skill, () => ({ ...r.args }), (c) => c.inv.free >= 2 && !c.dark, 3.0),
    o('explore_search', 'explore', (c) => ({ direction: pick(c.rng, DIRS) }), (c) => !c.dark && !c.underground, 1.0, { goalTerm: (c, g, m) => -1.2 * (m.caution ?? 0) }),
    o('wander_search', 'wander', () => ({}), (c) => !c.dark && !c.underground, 0.5),
  ]
}

export function registerGoalOptions(type, opts) { OPTIONS[type] = opts }

/** how the goal is judged achieved (S1 reports "done" to S2). Pure given facts f = {inv, food, heat, t, now}, g = goal state. */
export const ACHIEVED = {
  get_food: (f, g) => f.food >= 18 || (f.inv.food > g.start.invFood && (f.inv.food >= 2 || f.food >= 14)),
  find_resource: (f, g) => { const r = RES[g.spec.target]; return !!r && f.matchCount(r.re) - g.start.resCount >= (g.spec.target === 'wood' ? 3 : 4) },
  go_to_place: (f) => !!f.t?.pos && f.t.dist <= 4.5,
  follow_person: (f, g) => g.nearMs >= 90000,
  build_shelter: (f, g) => g.did.has('shelter:done') || g.did.has('dig_in:done'),
  explore_area: (f, g) => f.heat - g.start.heat >= 12,
  rest: (f, g) => g.did.has('sleep:done') || g.did.has('rest:done') && f.energyLevel > 0.7 || g.did.has('shelter:done') || g.did.has('dig_in:done'),
  talk: (f, g) => g.did.has('look_at:done') || g.did.has('approach_person:done') && (f.t?.dist ?? 99) <= 5,
  defend: (f, g) => (f.hostiles === 0 && g.steps >= 1) || g.did.has('dig_in:done'),
  avoid: (f, g) => !f.t?.pos || f.t.dist >= 26 || g.did.has('dig_in:done'),
  // VAL2: a custom goal is achieved ONLY when its text yields a verifiable predicate that the world confirms (a wave can never serve 'place chest')
  custom: (f, g) => !!g.pred && customPredOk(f, g),
}

const PLACE_RE = /\b(place|put|build|set up|setup|install|put down|plant)\b/i
const GET_RE = /\b(craft|make|get|collect|gather|obtain|cook|smelt|find|fetch|pick up|mine)\b/i
/** 'place chest inside house' -> { kind:'block', name:'chest' } ; 'craft a wooden pickaxe' -> { kind:'item', name:'wooden_pickaxe' } ; unknown -> null. Needs the registry to know item names. */
export function customPredicate(text, registry) {
  const t = String(text ?? '').toLowerCase().replace(/[^a-z\s_]/g, ' ')
  const kind = PLACE_RE.test(t) ? 'block' : GET_RE.test(t) ? 'item' : null
  if (!kind || !registry) return null
  const w = t.split(/\s+/).filter(Boolean)
  for (let n = 3; n >= 1; n--) for (let i = 0; i + n <= w.length; i++) {
    const base = w.slice(i, i + n).join('_'), cands = [base, base.replace(/s$/, ''), base.replace(/ies$/, 'y')]
    for (const c of cands) if (registry.itemsByName?.[c] || registry.blocksByName?.[c]) { if (['air', 'it', 'a', 'the'].includes(c)) continue; return { kind, name: c, verb: kind === 'block' ? 'placed' : 'obtained' } }
  }
  return null
}
function customPredOk(f, g) {
  const p = g.pred
  if (p.kind === 'item') return f.matchCount(new RegExp(`^${p.name}$`)) - (g.start.predCount ?? 0) >= 1
  return (f.blockCount?.(p.name) ?? 0) - (g.start.predCount ?? 0) >= 1
}
/** habits that make no sense as a step toward an unrelated custom goal (greeting, idling, daydreaming) unless the text asks for them */
export function customRelevant(habit, text) {
  if (!['social', 'leisure', 'memory'].includes(habit?.category)) return true
  return /\b(greet|wave|hello|hi\b|talk|chat|say|play|relax|idle|look|think|remember)/i.test(String(text ?? ''))
}
