// PB4: predicates and ops for the activity playbooks, kept out of predicates.js / ops.js.
// Hook: catalog.js imports this file for its side effect (`import './predicates-pb4.js'`); it adds to the exported PRED and OPS tables.
import { PRED, evalPred, allTrue } from './predicates.js'
import { OPS } from './ops.js'
import { boxedIn } from '../skills/shelter.js'
import { countMatch } from '../skills/lib.js'
import { placeableCount } from '../habits/safety.js'
import { items } from '../skills/lib.js'

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const near = (c, re, r) => { const me = c.bot.entity?.position; return !!me && Object.values(c.bot.entities ?? {}).some((e) => e && e !== c.bot.entity && e.position && re.test(e.name ?? '') && d3(e.position, me) <= r) }

const PRED_ADD = {
  rain: (c) => !!c.bot.isRaining || (c.bot.thunderState ?? 0) > 0.3,
  shooter_near: (c, r = 28) => near(c, /^(skeleton|stray|bogged|pillager)$/, +r),
  phantom_near: (c, r = 40) => near(c, /^phantom$/, +r),
  sky_threat: (c) => PRED.shooter_near(c) || PRED.phantom_near(c),
  open_sky_above: (c) => { const p = c.bot.entity?.position?.floored(); if (!p) return false; for (let y = p.y + 2; y < p.y + 40; y++) { const b = c.bot.blockAt(p.offset(0, y - p.y, 0)); if (b && b.boundingBox === 'block') return false } return true },
  in_hole: (c) => { try { return boxedIn(c.bot) } catch { return false } },
  safe_to_leave: (c) => PRED.day(c) && !PRED.hostile_near(c) && !PRED.thunder(c),
  torches_ge: (c, n) => countMatch(c.bot, /^torch$/) >= +n,
  can_make_torches: (c) => countMatch(c.bot, /^(coal|charcoal)$/) >= 1 && (countMatch(c.bot, /^stick$/) >= 1 || countMatch(c.bot, /_planks$/) >= 2 || countMatch(c.bot, /_log$/) >= 1),
  has_coal: (c) => countMatch(c.bot, /^(coal|charcoal)$/) >= 1,
  has_hoe: (c) => countMatch(c.bot, /_hoe$/) >= 1,
  has_seeds: (c) => countMatch(c.bot, /^(wheat_seeds|beetroot_seeds|carrot|potato)$/) >= 1,
  has_string: (c, n = 2) => countMatch(c.bot, /^string$/) >= +n,
  can_make_rod: (c) => PRED.has_string(c, 2) && (countMatch(c.bot, /^stick$/) >= 3 || countMatch(c.bot, /_planks$/) >= 2 || countMatch(c.bot, /_log$/) >= 1),
  // FOOD4: a wooden hoe is 2 planks + 2 sticks (2 planks make 4 sticks) at a crafting table; a table within 24 m is free, otherwise 4 more planks
  can_make_hoe: (c) => { const b = c.bot, units = countMatch(b, /_planks$/) + countMatch(b, /_log$/) * 4
    let table = countMatch(b, /^crafting_table$/) > 0; if (!table) { try { table = !!b.findBlock({ matching: b.registry.blocksByName.crafting_table.id, maxDistance: 24 }) } catch { /* unknown: assume none */ } }
    return units >= 2 + (countMatch(b, /^stick$/) >= 2 ? 0 : 2) + (table ? 0 : 4) },
  farm_known: (c) => !!c.env?.landmarks?.get?.('farm'),
  pen_known: (c) => !!c.env?.landmarks?.get?.('pen'),
  has_feed: (c) => countMatch(c.bot, /^(wheat|carrot|potato|beetroot|wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds)$/) >= 2,   // FARM1: enough to feed two animals
  y_gt: (c, n) => (c.bot.entity?.position?.y ?? 0) > +n,
  fences_ge: (c, n) => countMatch(c.bot, /_fence$/) >= +n,
  blocks_or_fences: (c, n) => placeableCount(items(c.bot)) >= +n || countMatch(c.bot, /_fence$/) >= 15,
  water_within: (c, r = 16) => { try { return !!c.bot.findBlock({ matching: c.bot.registry.blocksByName.water.id, maxDistance: +r }) } catch { return false } },
}

const OPS_ADD = {
  /** wait until all predicates hold, at most max_s (default 600). Done when they hold; failed 'wait_timeout' otherwise. Interruptible between polls. */
  async wait_until(x, step, a) {
    const t0 = x.now(), list = [].concat(a.until ?? []), ctx = () => ({ bot: x.bot(), env: x.env, params: x.params, state: x.state, now: x.now })
    while (x.now() - t0 < (a.max_s ?? 600) * 1000) {
      if (x.aborted()) return { status: 'failed', reason: 'aborted' }
      if (allTrue(list, ctx())) return { status: 'done' }
      await x.sleep(a.poll_ms ?? 2000)
    }
    return { status: 'failed', reason: 'wait_timeout' }
  },
}
// cycle-safe registration: when this file is reached while ops.js / predicates.js are still evaluating (import cycle) the tables are in their TDZ; retry after the module graph is done
const register = () => { Object.assign(PRED, PRED_ADD); Object.assign(OPS, OPS_ADD) }
try { register() } catch { queueMicrotask(register) }
export { evalPred }
