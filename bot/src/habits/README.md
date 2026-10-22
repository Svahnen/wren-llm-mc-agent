# bot/src/habits : plausible life with NO LLM (T4)

When there is no live intent (`hasLiveIntent()` false), the arbiter is free and the body is spawned, `createHabits(...).step()`:
1. reads the needs (`needs.js`): hunger (food/20), energy (game ticks since sleep), safety (hp, hostiles within 16), curiosity (time since a new
   8x8 heatmap cell was entered), social (time since a player was near, only if someone else is online). Level 1 = fine, urgency = (1-level)^2.
2. builds the situation (inventory facts, light, night, animals, water, underground, home distance, bed/chest known, players).
3. scores every applicable habit in `catalog.js`: `utility = f(needs, situation) - recency penalty + seeded noise (0.25)`; habits locked out after a
   failure are skipped (per habit and 24-block place bucket, cool-down 20 s x 2^fails up to 10 min; `idle` is never locked, so something always applies).
4. runs the plan through `runner.run(skill, args, {owner:'s1'})` and records the outcome. Every choice is traced as `habit_choice`
   (habit, skill, score, three alternatives, need levels).

Habits: set_home, eat, hunt, sleep, rest, place_torch, return_to_surface, return_home, tidy (store_in_chest / drop_junk), craft (next missing tool, torch, bed, chest, furnace),
gather_wood, gather_stone, gather_coal, pick_flowers, fish, explore, wander, visit_player, greet, idle (animations).

## Interface for mind/
    habits.setDrives({ hunger: 0.3, curiosity: 0.1 })   // levels 0..1 (1 = satisfied) override the body-derived ones
    habits.setCostAt((pt) => extraCost)                  // danger-zone cost for target selection (wander/explore/gather)
    habits.rank()  habits.stats()  // {total, counts, skills, outcomes, entropy_bits, unique_cells}
No LLM is involved anywhere; with the same seed and state the choice is deterministic (seeded `rng` only).

## Fixed vs. chosen
Need strengths are fixed and equal; nothing here is a taste. Variety comes from boredom (curiosity urgency), recency damping and lockouts.

## H1 survival layer (night, ranged threats, food, return_home)

`safety.js` holds the pure logic (phase day/dusk/night incl. thunder, line of sight, hunger tiers, return reasons, pillbox geometry); unit tests `test/habits-h1.test.mjs`.
* Priority model: danger/survival utilities (take_cover 9, shelter/sleep 7+, hunger boosts up to +6) sit far above leisure (< 3.5).
* `take_cover` (skill): a skeleton/stray/bogged/pillager with a clear line to head or body within 30 blocks -> hide behind the nearest block (cover search r 2..10), or charge a lone shooter when hp >= 12 and a sword is held, else run away.
* Night routine: dusk (tick 11200+) or night/thunder, no bed -> `shelter` (skill: sealed 1x1x2 pillbox from >= 9 placeable blocks, 10 cells, outside protected boxes, waits until day, breaks the walls and picks the blocks up again). With a bed: `go_bed` at dusk, `sleep` at night. Fewer than 9 blocks -> `stock_blocks` (collect dirt) has top priority; in daylight she keeps 12 blocks in stock. No wandering/exploring/gathering/visiting in the dark or with a shooter in sight.
* Food: keep FOOD_RESERVE (4) edible items. `hunt` (reach 80 blocks, cows/pigs/sheep preferred, gives up on unreachable animals), `seek_food` (explore by day when hungry, no food, no animal known), `eat`. Hunger tier boosts: food <= 14 +1.2, <= 10 +3.5, <= 6 +6. Wool chain: `get_wool` (hunt sheep, shear if shears are held) -> craft bed (first in the craft order) -> sleep.
* `return_home` only with a reason (`far` > 160, `low_health` <= 8, `inventory_full` with a chest, `danger`), > 40 blocks from home, 5 min cool-down, never in the dark.
* Explore/wander targets pay a `hazardPenalty` (caves, lava within 3, lakes).
* Test hook: `bot._h1ForcePhase = 'dusk'|'night'|'day'` overrides the clock for the habit layer and `isNight` (live tests only; the world time is never changed).
