# bot/src/reflex : reflex layer (T2)

No LLM, always on, owner `reflex` on the arbiter (reflex > s1 > s2). Plan refs: 3.1, 5, 12.1 (3-5), 12.3 (3-4).

## Wiring

    import { installReflexes } from './reflex/index.js'
    const reflex = installReflexes(body, arbiter, trace, metrics, { cfg: {/* overrides of defaults.js */} })

`main.js` is T1's file and is NOT wired yet: add the line above after `arbiter` is created. The engine
listens to `body` ('state', 'bot') and `arbiter` ('preempted'), ticks every 100 ms and stops with `await reflex.stop()`.

## Files

| file | role |
|---|---|
| `engine.js` | `ReflexEngine`: tick loop, priority, supersede, cooldown + jitter, pause, bounded runs, events |
| `reflexes.js` | the nine reflexes (table below), `chooseFood`, `placeableBlock` |
| `danger.js` | `DangerMap`: pluggable cost knowledge |
| `nav.js` | `search()` (Dijkstra, walk/jump/drop/swim, lava only if already in lava) and `walkPath()` (control states, never leaves keys pressed) |
| `threats.js` | hostile table, `assess()` fight/flee decision, `bestWeapon` |
| `defaults.js` | all thresholds |

## Reflexes (priority high to low)

| name | prio | critical | fires when | does |
|---|---|---|---|---|
| lava_fire | 100 | yes | feet/head in lava, in fire/cactus/campfire/magma cell, or burning | water bucket at feet if present (then picks it up), else Dijkstra to the nearest safe dry cell (lava crossed only when already inside it), waits out the fire |
| suffocation | 95 | yes | head block is an opaque full block | digs head (and feet) block; refuses a roof with lava above, tries a side block |
| falling_block | 92 | yes | a `falling_block` entity within 1.2 blocks horizontally and 0.5..12 above | steps >= 2 blocks aside |
| drowning | 90 | yes | head in water and oxygenLevel < 12 | own swim-up (not the pathfinder): path to the nearest dry standable cell through water incl. vertical swimming, jump held; boxed in: surfaces, treads water, reports `surfaced_no_exit` |
| low_health_flee | 80 | no | `assess` says flee: flee-class mob (warden, vindicator ...), hp <= 8 with fighters near, unarmed vs group, or estimated kill time > 60 % of survive time | sprints to the cell that maximises distance from all threats, re-planned every ~5 cells; disengage budget 3 per 120 s, then shelter (8 blocks around, hp to 16, leaves through a wall) or, without blocks, `lastStand` (mob_defense fights to the end) |
| creeper_distance | 78 | no | creeper within 6 | backs off to >= 9; hits it only when cornered |
| edge_guard | 70 | no | on ground, moving toward a column with >= 5 free fall, or lava below | stops, steps back to a cell with no cliff neighbour; ignores idling at an edge |
| mob_defense | 60 | no | `assess` says fight | equips best sword/axe, closes in, attacks on the weapon's cooldown, never advances over a ledge/hazard, drops to flee if the odds turn |
| eat | 40 | no | food <= 14 (or hp <= 12 and food <= 17) and edible food present, no hostile within 8 unless food <= 6 | eats the smallest food that fits; rotten flesh and similar only when starving; no food -> one `no_food` event per minute |

## Guarantees

* One reflex at a time; a higher priority supersedes a running lower one (`reflex_superseded`).
* Every run: `maxMs` bound, then `stopBody()` + token release, always (also on exception/abort/state change). Control states are never left pressed (unit tested for every reflex).
* Cooldown after each run (`cooldownMs`, `failCooldownMs` on failure) with +-25 % jitter. Critical reflexes have 300-400 ms so a persisting hazard is handled again at once.
* Pausing: `reflex.paused = true` pauses all NON-critical reflexes; `reflex.pause({names:'soft'|'all'|[...], force, ttlMs, reason})` returns `{resume()}`. Critical reflexes ignore pauses unless `force:true`. A pause expires after 120 s by default.
* Events (trace + `reflex.drainEvents()` + EventEmitter `'event'`): `reflex_start`, `reflex_end {name,ok,reason,ms,aborted}`, `reflex_superseded`, `reflex_pause/resume`, and `reflex_interrupt {text:"your action X was interrupted by Y", action, owner, by}` whenever a reflex takes the body from an s1/s2 holder. Also `shelter`, `disengage_budget_exhausted`, `lava_fire_plan`, `drowning_plan`.

## Danger knowledge for mind/

    reflex.danger.addProvider((cell, dm) => remembered_lava_cost(cell))   // number >= 0, Infinity = forbidden; returns an unregister fn
    reflex.danger.forbid({x,y,z}, ttlMs)   /   .unforbid(cell)   /   .costAt(cell)   /   .standable(cell)

`cell` = integer feet block. Costs add to the built-in block costs. `>= HARD (1000)` = never choose to stand there. Providers that throw are ignored.
Reflex route planning (`nav.search`) honours it; skills can reuse `reflex.danger.costAt` for their own pathing.

## Known limits (honest)

* The shelter is open on top (spiders climb, skeletons shoot), needs >= 8 placeable blocks and solid floor next to the bot. No dig-down shelter.
* No fall clutch (water bucket while falling) and no ranged weapons; fighting is melee only, no strafing, no shield.
* Hostile table is hand written (1.21); unknown mobs are ignored. `enderman` is neutral and never looked at.
* Reflexes do not know about the pathfinder's own `maxDropDown`; they react to cliffs >= 5 blocks only when moving toward them.
* `bot.oxygenLevel` is derived from `air_supply / 15`.
