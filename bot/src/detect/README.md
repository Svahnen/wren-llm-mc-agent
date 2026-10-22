# bot/src/detect + bot/src/escape (T3): stuck/loop detectors and the escape ladder

Plan references: 5, 12.3.1-12.3.4, 12.4. Everything is headless. Unit tests: `node --test test/detect-*.test.mjs`
(20 tests, no server; `npm test` globs only `*.test.js`, so run both).

## Wiring (main.js is not edited by T3; whoever owns main.js adds this)

    import { installDetectors } from './detect/index.js'
    const det = installDetectors(body, arbiter, runner, trace, metrics, {
      getHome: (bot) => ({ x, y, z }) | null,   // go-home target; fallback bot.spawnPoint
      onRestart: (reason) => ...,               // default: body.forceDisconnect('detector_restart:...') (reconnect); a supervisor may exit instead
      stateFile: 'runtime/detect-state.json',   // persists restart timestamps so restart loops are rate limited across process restarts
      enforceLockouts: false,                   // true: runner.run() rejects locked (goal type, place) with 'locked_out:*'
      hooks: { getBreadcrumb, lightMin: 7, undergroundY: 58, foodMax: 6, onDeadState(kind, info) },
      onCycle, onRepeat,                        // callbacks for the mind
    })

`installDetectors` (1) registers the escape/unstuck skills on the runner, (2) WRAPS `runner.run` (goal type/place bookkeeping, results to
the cycle/n-gram/failure-budget detectors, habits get `rejected: unstuck_active` while the ladder holds the body; internal skills and
reflex-owned runs pass), (3) wraps `metrics.snapshot` to add a `detect` object, (4) starts timers (all unref'd). `det.stop()` unwraps.
A goal's type is `args.goal_type ?? skill name`, its place is `args.place` or the 16-block chunk of `args.x/args.z`
(or `ctx.state.target` of the running skill, e.g. wander).

## Parts
| file | what |
|---|---|
| `detect/lag.js` `LagMonitor` | server TPS from world-age deltas of `time` packets (EMA), packet silence > 2.5 s, ping > 600 ms, event-loop drift > 350 ms, discontinuity grace (teleport/spawn). `status()` -> `{lagging, reasons, factor}`; a time update later than 3 s (vanilla sends one per second at 20 TPS) is immediate lag evidence even at `/tick rate 1`; `lagging` stays true 5 s after the last bad sign. `factor` = 20/TPS (1..6) scales all clocks. TPS is derived by the bot from `time_update`; no op rights needed. |
| `detect/watchdog.js` `SkillWatchdog` | own 1 s timer, samples every running skill's `progress_fn` regardless of pathfinder state; stall = no change for `stall_s` HEALTHY time (default 20 s); then emits `stall`, aborts with `no_progress`. While lagging it freezes the stall clock and SHIELDS the runner's own unscaled watchdog (calls `ctx.progress()`, shifts `entry.startedAt`), so a lag spike can neither abort a skill nor escalate. Backstop for `max_s` + 5 s. |
| `detect/stuck.js` `StuckMonitor` | decides when the ladder runs. Healthy-time clocks (frozen under lag). Triggers: (a) skill stall AND recent movement extent <= 4 blocks horizontally/vertically ("physical stuck"); a stall while roaming freely only counts as a skill failure; (b) no progress of any kind for 180 s (idle time counts only if `diagnose().trapped`); (c) CONFINED + TRAPPED: a non-`stationary` skill is running, the bot moved <= 4 blocks over the last 15 s and `diagnose().trapped` (ground truth, independent of the skill's progress_fn, which water drift can fool; skills that legitimately wait in enclosed spots, e.g. sleeping in a shelter, must declare `stationary: true`); (d) never inside the settle window after a verified step, never during the ladder's own backoff. Progress = moved >= 8 blocks from anchor, a skill finished `done`, or a progress_fn change. A position jump > 10 blocks in one tick is a teleport: discontinuity, clocks rebased, ladder reset. |
| `escape/ladder.js` `EscalationLadder` | nudge -> moveAway(5) -> escape ladder -> go home -> restart request. Chained without waiting while a step is NOT verified; a verified step ends the episode (settle 6 s). Verification = ground truth: moved >= 0.8 / 3 / 2 / 10 blocks (or +1.5 y) AND `diagnose().trapped == false`; a skill's own "done" is never trusted. Every step is a trace event (`unstuck_start/step/end`, `escape_try`, `unstuck_reset`, `restart_request/suppressed`). Reset on progress, on spawn/state change, and after 120 s quiet. Unstuck mode = pathfinder `Movements.canDig` temporarily true (restored after) and dig-skills allowed. Lag or state change mid-chain interrupts it without escalating. Top reached without success: restart request (rate limited: >= 30 min apart and <= 4 per 24 h, persisted), then exponential backoff 30 s..10 min and the next episode wraps to the escape rung. Restart suppression emits `help_needed` for the mind/manager. |
| `escape/skills.js` | real T1 skills (progress_fn, max_s, stall_s, abort via runner): `unstuck_nudge`, `unstuck_move_away`, `unstuck_go_home`, `escape_jump_spam`, `escape_place_under`, `escape_pillar_up`, `escape_dig_up`, `escape_staircase`, `escape_swim`, `escape_open_door`, `escape_cut_web`, `escape_bridge`. All require `args.unstuck === true`. Preconditions: blocks / pickaxe present, door in reach, in water, in web. Digging only in dig_up / staircase / cut_web (and pathfinder canDig in unstuck mode); never next to liquid, never below a gravity block. `planEscape(bot)` orders the candidates from the live situation. |
| `escape/world.js` | `diagnose(bot)` (exits, trapped, in water/lava/web/powder snow, ceiling, gap around, closed doors), `walkable`, `safeToDig`, item pickers. |
| `detect/cycle.js` | `CycleDetector` (goal-type@place sequences, period 2..6, 3 repetitions, 30 min window; same goal repeated is NOT a cycle), `VisitCounter` (3-block cells, >= 8 visits/h, `addExempt(pos)` for home/bed), `NgramCounter` (trigram repeats + entropy), `ChatRepeat`/`textSimilarity` (bigram Dice, 0.8, per player, 10 min). |
| `detect/lockout.js` | `LockoutList` (`lock`, `isLocked(type, place)`, `list`, `toJSON/load`; `*` wildcards; 30 min default) and `FailureBudget` (3 fails/h per (goal type, place) -> lockout). Cycles lock every goal in the cycle; repeat visits lock the place. **Mind API:** `det.isLocked(type, place)` / `det.lockouts.list()`. |
| `detect/deadstate.js` | hooks only: `dead_state` events (`inventory_full`, `no_light` (light <= `lightMin`), `disoriented_underground` (skyLight 0 and y < 58 for 90 s without `getBreadcrumb` trail), `hunger_no_food`), re-emitted every 60 s while active, `dead_state_clear` when gone. T4/mind implement the cures. |

## Known limits (honest)
* Boat is NOT implemented (swim only). Iron doors/trapdoors cannot be opened by hand and are skipped.
* `escape_bridge` places blocks across a gap at floor level; it does not build diagonal or vertical bridges.
* The wrapper around `runner.run` and the `entry.startedAt` shift (lag shield) rely on T1 internals; if T1 changes `runner.current` fields, `test/detect-ladder.test.mjs` will notice.
* Thresholds (20 s stall, 180 s global, 4-block radius) are untested over long soaks.
