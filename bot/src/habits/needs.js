// Needs from the body. Level 1 = fine, 0 = urgent; urgency = (1-level)^2.
// mind/ may override any level via habits.setDrives({hunger:0.3,...}); the body-derived value is used otherwise.
import { isIgnoredPlayer } from '../ignore-players.js'
import { gameAge, items } from '../skills/lib.js'
import { placeableCount } from './safety.js'
import { MOBS, relevantThreat } from '../reflex/threats.js'

export const NEEDS = ['hunger', 'energy', 'safety', 'curiosity', 'social']
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
export const urgency = (level) => (1 - clamp(level)) ** 2

export const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'husk', 'drowned', 'pillager', 'phantom', 'slime', 'zombie_villager', 'cave_spider', 'stray', 'vindicator'])

export class NeedState {
  constructor({ now = Date.now } = {}) {
    this.now = now
    this.lastSleepAge = null    // game ticks
    this.lastNewCellAt = now()
    this.lastPlayerAt = now()
    this.lastSafeAt = now()
    this.override = {}
  }
  setOverride(o) { this.override = { ...(o ?? {}) } }
  noteSlept(bot) { this.lastSleepAge = gameAge(bot) }
  /** Resting restores a little energy (30 game seconds of sleep-equivalent per rest). */
  noteRested() { if (this.lastSleepAge !== null) this.lastSleepAge += 600 }
  noteNewCell() { this.lastNewCellAt = this.now() }

  /** @returns {{levels, urgencies, facts}} */
  read(bot, { heatmap } = {}) {
    const t = this.now()
    const age = gameAge(bot)
    if (this.lastSleepAge === null) this.lastSleepAge = Math.max(0, age - 6000) // start a bit rested
    const me = bot.entity?.position
    const ents = Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && me)
    const hostiles = ents.filter((e) => HOSTILE.has(e.name) && e.position.distanceTo(me) < 16 && (!MOBS[e.name] || relevantThreat(bot, e))).length
    const players = ents.filter((e) => e.type === 'player' && !isIgnoredPlayer(e.username) && e.position.distanceTo(me) < 48)
    if (players.length) this.lastPlayerAt = t
    if (!hostiles && bot.health >= 14) this.lastSafeAt = t
    const online = Object.keys(bot.players ?? {}).filter((n) => n !== bot.username && !isIgnoredPlayer(n)).length
    const levels = {
      hunger: clamp((bot.food ?? 20) / 20),
      energy: clamp(1 - (age - this.lastSleepAge) / 36000),            // empty after 1.5 game days awake
      safety: clamp(Math.min((bot.health ?? 20) / 20, 1 - 0.3 * hostiles)),
      curiosity: clamp(1 - (t - this.lastNewCellAt) / 240000),          // bored after ~4 min without a new cell
      social: online ? clamp(1 - (t - this.lastPlayerAt) / 900000) : 1,  // lonely after ~15 min, only if someone is on the server
    }
    for (const k of NEEDS) if (Number.isFinite(this.override[k])) levels[k] = clamp(this.override[k])
    const urgencies = Object.fromEntries(NEEDS.map((k) => [k, urgency(levels[k])]))
    return { levels, urgencies, facts: { hostiles, players: players.length, playersOnline: online } }
  }
}

// F1: wool = most of one colour (a bed needs 3 of ONE colour)
function woolByColour(bot) {
  const o = {}
  for (const i of bot.inventory?.items?.() ?? []) if (/_wool$/.test(i.name)) o[i.name] = (o[i.name] ?? 0) + i.count
  return o
}
export function inventoryFacts(bot) {
  const inv = items(bot)
  const n = (re) => inv.filter((i) => re.test(i.name)).reduce((s, i) => s + i.count, 0)
  const foods = bot.registry?.foodsByName ?? {}
  return {
    logs: n(/_log$/), planks: n(/_planks$/), sticks: n(/^stick$/), cobble: n(/^(cobblestone|cobbled_deepslate)$/), coal: n(/^(coal|charcoal)$/),
    torches: n(/^torch$/), beds: n(/_bed$/), wool: Math.max(0, ...Object.values(woolByColour(bot))), rod: n(/^fishing_rod$/), chest: n(/^chest$/), table: n(/^crafting_table$/),
    food: inv.filter((i) => foods[i.name] && !/^(rotten_flesh|spider_eye|poisonous_potato|pufferfish)$/.test(i.name)).reduce((s, i) => s + i.count, 0),
    pickaxe: n(/_pickaxe$/), axe: n(/_axe$/), sword: n(/_sword$/), stonePickaxe: n(/^(stone|iron|diamond)_pickaxe$/),
    free: bot.inventory?.emptySlotCount?.() ?? 30,
    blocks: placeableCount(inv), shears: n(/^shears$/),
    badFood: inv.filter((i) => foods[i.name] && i.name === 'rotten_flesh').reduce((s, i) => s + i.count, 0),   // SURV1/RS3: only rotten flesh is eaten out of need (spider eye / poisonous potato / pufferfish never)
    // G2: cooking inputs
    raw: n(/^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato)$/), furnace: n(/^furnace$/), fuel: n(/^(coal|charcoal)$/) * 8 + n(/(_planks|_log)$/) * 1.5, cooked: n(/^(cooked_(beef|porkchop|mutton|chicken|rabbit|cod|salmon)|baked_potato)$/),
  }
}
