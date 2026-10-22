# Trap map (synthetic stuck-escape test area)

Built by console commands on the wren test server (`server/README.md`, container `wren-mc`, port 25566), in the
SAME world as everything else but in a clearly separate sky region. A separate world is not practical with itzg (one
`LEVEL` per container, and Fabric multiworld needs a mod); a region 10000 blocks away, floating at y=200, is the documented alternative.

## Location (fixed)
- Region: x 10000..10099, z 10000..10039. Floor top block y=200 (stand at y=201). Stone slab below (y 189..200), air above, 4-high stone perimeter wall around each cell. Nothing outside the region is ever touched (bounds asserted in `trapgen.py`). The 28 chunks are forceloaded (`forceload add`), so rebuilds work without a player; `forceload remove 10000 10000 10099 10039` undoes that.
- 10 cells of 20x20 in a 5x2 grid, origin of cell = (10000 + 20*col, 10000 + 20*row):

| trap | cell origin (x,z) | start (x,y,z) for Wren | what it tests |
|---|---|---|---|
| pit2x2_3 | 10000,10000 | 10010.0, 198, 10010.0 | 2x2 pit, 3 deep |
| pit1x1_3 | 10020,10000 | 10029.5, 198, 10009.5 | 1x1 pit, 3 deep |
| pit1x1_6_walls | 10040,10000 | 10049.5, 195, 10009.5 | 1x1, 6 deep + 2-high collar (8 to climb) |
| lava_ring | 10060,10000 | 10069.5, 201, 10009.5 | 3x3 island, 3-wide 2-deep lava ring |
| cobweb_room | 10080,10000 | 10089.5, 201, 10009.5 | 5x5x3 cobweb room, door at west wall |
| powder_snow_pit | 10000,10020 | 10009.5, 201, 10029.5 | 3x3x3 powder snow (falls in) |
| water_column | 10020,10020 | 10029.5, 202, 10029.5 | 1x1 water shaft 10 deep, stone collar |
| trapdoor_cell | 10040,10020 | 10049.5, 199, 10029.5 | 1x1 cell, 2 high, closed oak trapdoor lid |
| stone_box | 10060,10020 | 10069.5, 201, 10029.5 | sealed 3x3x3 stone box, 1-block roof (dig) |
| thrash | 10080,10020 | 10089.5, 201, 10029.5 | fences/walls/slabs/stairs/panes/gates, seed 7 |

Full data (local coordinates, y relative to floor, per-trap `needs` and descriptions): `traps.json`. Start y is the feet block.

## Scripts (all idempotent; run from anywhere)
- `build-trapmap.sh [name|all] [--no-rules]`: wipes and rebuilds the cell(s), sets test gamerules (unless `--no-rules`). ~15 s for all.
- `reset-trap.sh <name>`: rebuild one cell, nothing else.
- `teleport-to-trap.sh <name> [--kit]`: tp Wren (only Wren) to the start. Fails if Wren is offline. `--kit` clears Wren and gives iron pickaxe, 64 cobblestone, shears, iron sword. Do NOT run while another process owns the Wren session unless that process is the test (it moves the live bot).
- `verify-trapmap.sh [name|all]`: checks every block written by a trap's own ops plus a sample of floor/air/wall via `execute unless block ... run say FAIL`; exit 1 on mismatch. Needs no player.
- `rules.sh on|off`: gamerules. `on`: keepInventory true, doMobSpawning false, doFireTick false, doDaylightCycle false, doWeatherCycle false, time day, weather clear. `off` restores vanilla defaults (they were all vanilla before the first `on`). Gamerules are world-wide, so while `on` the whole test world has no mob spawning and keeps inventory. Mob spawning is off instead of "peaceful" because peaceful would also change hunger/regen behaviour the soak should see.
- `trapgen.py`: command generator (`names`, `region`, `start <n>`, `build`, `verify`).
- `bot/test-harness/run-probe.sh`: optional mineflayer check (joins as Wren only if nobody is online, visits starts, prints position and blocks).

Console method: `podman exec wren-mc mc-send-to-console "<cmd>"` (commands streamed through one `podman exec -i`).

## Notes for test authors
- Pass criterion per plan 12.3: escaped (reached a position outside the trap's local footprint at rel y >= floor+1 and not in a hole) within 2 min, 100% of runs. Lava ring: any lava contact or death = failure (keepInventory means no item loss, health still drops).
- `trapdoor_cell` is an oak trapdoor (openable); an iron variant would be unopenable by hand. Facing north.
- Outer perimeter wall keeps the bot in its own cell, so a "wander off" after escaping stays inside 18x18.
- World backup taken before the first change: `backups/world-pre-trapmap-20261021-000131.tar.gz` (taken with save-off + save-all flush).
