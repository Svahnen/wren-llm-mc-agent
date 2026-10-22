# bot/src/skills : the skill pack (T4)

Every skill follows the T1 contract `{name, max_s, stall_s?, progress_fn, precondition?, run, abort?}` (see `bot/README.md`) and
verifies its result against the world (inventory delta, block exists, position, `bot.isSleeping`), never against the model.
`skills.json` is the CLOSED VOCABULARY with typed args; `schema.js` validates against it and is dependency free:

    import { SKILL_NAMES, SKILLS, validateArgs } from '../bot/src/skills/schema.js'
    validateArgs('craft', { item: 'torch' })   // {ok:true,args:{item:'torch',count:1}}  |  {ok:false,errors:[...]}
    validateArgs('teleport', {})               // {ok:false,errors:['unknown skill ...'],valid:[...]}

Arg names for the skills that also exist in `brain/contract.js` (`explore`, `move_to`, `go_to`, `follow`, `approach`, `eat`, `hunt`, `sleep`,
`collect`, `gesture`, `idle_activity`, `flee`) match it (unit test). `registerSkills` throws if `skills.json` and the code drift apart.

## Wiring (main.js is T1's file, so this is what to add there)

    import { registerSkills } from './skills/index.js'
    import { createHabits } from './habits/index.js'
    const pack = registerSkills(runner, { heatmap, rng, runtimeDir: cfg.runtimeDir })   // replaces makeWander
    pack.start(() => body.bot)                                                         // breadcrumb sampling, 1 Hz
    const habits = createHabits({ runner, arbiter, getBot: () => body.bot, env: pack.env, trace, isUp: () => body.spawned, hasLiveIntent })
    habits.start()                                                                     // replaces habitLoop

`pack.env` = `{rng, heatmap, landmarks, trail, costAt}` is shared state; `pack.env.costAt = (pt) => extraCost` lets mind/ push target
selection away from danger zones (used by wander, explore, gather).

## Skills (24)

| skill | what | success is verified by | main failure reasons |
|---|---|---|---|
| `wander` / `explore` | one leg to a STANDABLE, A*-verified, novelty-biased target (radius 28 / 70) | distance to target <= 4 | `no_reachable_target` |
| `move_to` x,y,z | walk to coordinates (y snapped to a standable cell) | distance <= radius+1.5 | `NoPath`, `not_reached` |
| `go_to` place | walk to a landmark (`home`, `bed`, `chest_1`) | same | `precondition` (unknown place) |
| `follow` player, duration_s | GoalFollow for a while | still present at the end | `target_gone` |
| `approach` player/entity | walk up and look at it | distance <= 4 | `target_moved`, `target_gone` |
| `flee` from | run 22 blocks away on a standable column | distance gained >= 8 | `no_escape_route` |
| `set_home` | store position as `home` (persisted) | stored == here | |
| `return_home` | goto home; fallback retraces the breadcrumb trail | distance to home <= 5 | `NoPath` |
| `return_to_surface` | retrace trail until `openSky` | open sky above | `no_route_to_surface` |
| `gather_wood` / `gather_stone` / `collect` | dig exposed logs/stone/coal/iron/sand/dirt/flowers, pick up drops; crafts a wooden pickaxe if none | item count delta | `inventory_full`, `no_tool`, `no_target_found`, `nothing_gained` |
| `hunt` | kill nearest cow/pig/sheep/chicken/rabbit, collect | meat item delta | `no_animal_nearby`, `no_drop` |
| `fish` | needs rod + water | catch item delta | `no_rod`, `no_water`, `no_catch` |
| `craft` item,count | planks stick crafting_table chest wooden/stone pickaxe axe sword shovel torch furnace bed; places/uses a table, makes planks and sticks on demand | item count delta | `missing_*`, `no_table`, `craft_failed` |
| `eat` | best food first, bad food only at food <= 6 | `bot.food` increased | `not_hungry`, `no_food` |
| `sleep` | night/thunder only; finds or places a bed, walks, sleeps up to `max_stay_s`, wakes | `bot.isSleeping` observed >= 3 s | `not_night`, `no_bed`, `bed_occupied`, `too_far`, `monsters_nearby` |
| `place_torch` | only when effective light <= level (default 4) unless `force` | torch block exists and count -1 | `no_torch`, `light_ok`, `no_spot` |
| `drop_junk` | tosses junk + surplus (cobble >64, dirt >32, logs >32), then walks away | free-slot delta | `nothing_to_drop` |
| `store_in_chest` | uses a chest within 32 or places a held one, deposits everything but tools/food/torches | free-slot delta | `no_chest`, `open_failed` |
| `look_at`, `gesture`, `idle_activity` | non-LLM body animation | declared steps | |

Preconditions: collecting skills (`gather_*`, `collect`, `hunt`) are rejected with `inventory_full` below 2 free slots; `eat` with `not_hungry`/`no_food`;
`sleep` outside night/thunder with `not_night`.

## Progress signals
Item counts, best distance so far (never oscillates), step counters for animations, declared wait ticks while sleeping/fishing/resting.

## Files
`lib.js` (standable/openSky/inventory/placeNearby/collectDrops), `landmarks.js` (Landmarks, Trail), `wander.js`, `move.js`, `gather.js`,
`craft.js`, `survival.js`, `inventory.js`, `body.js`, `schema.js` + `skills.json`, `index.js` (`registerSkills`).

## Gotchas found
* A bot on a tree top (oak leaves) gets only `partial` paths: the test rig teleports to the ground first.
* Sky light is not block light: daylight outdoors has `block.light` 0, so `lightAt` combines `skyLight` (minus 11 at night).
* Crafting order matters: table first (4 planks), then sticks (2 planks), then the recipe planks, otherwise the wooden pickaxe is 1 plank short.
* Dropped item entities are `name === 'item'`; `entity.objectType` logs a deprecation trace on every access.

## H1 additions: `shelter`, `take_cover` (src/skills/shelter.js)
`shelter {max_wait_s}`: finds a site on the real floor (never inside protected boxes, every wall cell needs a solid neighbour to be placed against, no lava/water), walks there, places the 10 pillbox cells (`placeAt`: any solid neighbour as reference, floor first), waits with a declared tick progress (skill is `stationary: true` for the stuck ladder), then breaks head-level walls first and picks up the blocks. Fails with `no_blocks`, `no_site`, `build_failed`.
`take_cover`: see habits README. `hunt` now reaches 80 blocks, shears sheep when it holds shears, and gives up with `unreachable_animal` when its best distance does not improve for 15 s.
