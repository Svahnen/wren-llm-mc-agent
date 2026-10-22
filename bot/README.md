# bot/ : Wren's body (System 1)

Mineflayer body with a lifecycle state machine, owner-token arbitration, a skill runner with per-skill
progress watchdog, JSONL tracing and metrics. The body runs on its own; the optional brain (../brain) and mind (../mind) plug in through `src/mindlink/`.

Pins (exact): mineflayer 4.39.0, minecraft-protocol 1.68.0, minecraft-data 3.117.0, mineflayer-pathfinder 2.4.5.
Node 22.5+ (tested on Node 26). ESM. Auth offline, version 1.21.1.

## Run

    cd bot && npm ci
    npm test                          # unit tests, no server needed
    node src/main.js                  # body only, foreground (Ctrl-C / SIGTERM = graceful)
    node src/mindlink/run.js          # body + mind + brain client (needs ../brain running), foreground
    src/mindlink/supervise-mind.sh start   # same, supervised, restarts on crash (copy run.env.example to run.env first)
    ./run.sh                          # detached (nohup+setsid), pid in runtime/bot.pid, stdout in logs/stdout.log
    ./stop.sh                         # SIGTERM, waits up to 15 s, never SIGKILLs
    BOT_NAME=WrenT1 ./run.sh          # use another whitelisted name (see below)

Config (`config.js`, manual validation, bad values abort with a list of errors). Environment:

| var | default | note |
|---|---|---|
| MC_HOST / MC_PORT | 127.0.0.1 / 25566 | the default port 25565 is refused unless `ALLOW_PORT_25565=I_KNOW` (guard against pointing the bot at a main server by accident) |
| BOT_NAME | Wren | 3-16 chars `[A-Za-z0-9_]`, must be whitelisted |
| MC_VERSION | 1.21.1 | |
| SEED | random | seeds the wander RNG |
| BOT_LOG_DIR / BOT_RUNTIME_DIR | bot/logs, bot/runtime | |
| TRACE_MAX_BYTES, TRACE_ECHO=1 | 5 MiB, off | rotate size, echo trace to stdout |
| RECONNECT_BASE_MS / RECONNECT_MAX_MS | 1000 / 60000 | x2 per failed attempt, +-20 % jitter, reset after 30 s stable spawn |
| CONNECT_TIMEOUT_MS, METRICS_INTERVAL_MS | 30000, 30000 | |

Only ONE session per player name can be online: a second login with the same name kicks the first
(`duplicate_login`) and the lifecycle would then reconnect and kick back. The trap-map probe (T5a) uses `Wren`,
so T1 tests use `WrenT1` (added with `server/whitelist-set.sh Wren YourName WrenT1`).

## Files

| file | role |
|---|---|
| `src/lifecycle.js` | `Body`: states connecting / spawned / dead / respawning / disconnected; per-connection generation (stale events ignored); reconnect with backoff; connect timeout; emits `bot`, `state` (synchronous), `spawn` |
| `src/arbiter.js` | `Arbiter`: owner token, priority reflex(3) > s1(2) > s2(1). `acquire(owner,{label,onPreempt})` returns a `Token` or `null` (denied). A higher priority stops the pathfinder and clears keys synchronously, revokes the old token (its `signal` aborts), awaits `onPreempt` (bounded, default 2.5 s), then grants. `release()`, `revokeAll(reason)`, `runAs(owner,label,fn)` (traces `reflex` events) |
| `src/skills/runner.js` | `SkillRunner`: registration, precondition, watchdog (`progress_fn`, `max_s`, `stall_s`), bounded abort, `ctx.goto` that never throws |
| `src/body-control.js` | `stopBody(bot)`: pathfinder stop + `setGoal(null)`, `stopDigging`, `deactivateItem`, `clearControlStates` (all guarded) |
| `src/trace.js` | JSONL trace `logs/trace-YYYYMMDD[.N].jsonl`, rotation by size, in-memory ring for tests |
| `src/metrics.js` | event-loop lag (`monitorEventLoopDelay`, windowed p50/p99/max), skill/abort-reason/reflex/state counters, intent age, deaths, reconnects |
| `src/main.js` | wiring + habit loop + SIGTERM/SIGINT shutdown; `createApp(cfg,{createBot})` is testable |
| `src/skills/wander.js`, `src/heatmap.js` | default skill: one leg toward the least-visited of 16 sampled points (8-block cells, neighbours weighted 0.25), unreachable targets penalised, heatmap persisted to `runtime/heatmap.json` |
| `src/protocol-fix.js` | runtime patch of the wrong recipe mapping in minecraft-data 3.117.0 (removes the login `PartialReadError`) |
| `tools/probe-partialread.mjs` | which packet fails to parse; `FIX=1` applies the patch, `GIVE=1` hands the bot trimmed armour |
| `test/*.test.js` | node:test unit tests with a bot double (`test/helpers.js`) |

## Skill contract

    { name, max_s, stall_s?, progress_fn(ctx), run(ctx), precondition?(ctx), abort?(reason, ctx) }

* Registration throws without `progress_fn`, `run` or `max_s > 0`.
* `progress_fn` returns any comparable value; a CHANGE counts as progress. It is sampled every 1 s by the watchdog, which
  runs regardless of pathfinder state. No change for `stall_s` (default 20 s) aborts with `no_progress`; `max_s` aborts with `max_s`.
  Use measures that cannot oscillate (best distance so far, item counts, chunks seen); `ctx.progress()` declares progress by hand.
* `run(ctx)` returns `undefined|true|{ok:true}` = done, `false|{ok:false,reason}` = failed; throwing = failed (`exception`).
* `ctx`: `bot`, `args`, `state` (scratch), `signal` (AbortSignal), `aborted`, `log(type,fields)`, `sleep(ms)` (abortable, false if aborted),
  `goto(goal,{timeoutMs})` -> `{ok:true}` or `{ok:false,reason}` (PathStopped/NoPath/GotoTimeout, never throws), `progress()`.
* `abort(reason)` is skill-specific cleanup. The runner ALWAYS additionally runs `stopBody`, and `run()` resolves within `abortGraceMs` (2 s)
  even if the skill ignores the abort (result has `orphaned:true`; the stray promise is ignored). A skill that keeps touching `bot` after an
  orphaned abort is a skill bug; the runner cannot kill a promise.
* `runner.run(name, args, {owner, intent_id, created_at, precondition})` -> `{status: done|failed|aborted|rejected, reason, ms}`; never throws.
  Rejected reasons: `unknown_skill`, `no_body`, `precondition`, `busy` (equal or higher priority holds the body), `revoked`.
* Verify results against the world yourself: `pathfinder.goto()` RESOLVES when no path exists (empty path counts as success in
  mineflayer-pathfinder 2.4.5), so the wander skill checks the distance left.

## Using the arbiter from a reflex (T2)

    await arbiter.runAs('reflex', 'lava_escape', async (token) => { /* body is yours; stop when token.signal.aborted */ })

## Trace event types

`app_start app_stop state login kicked bot_error reconnect_scheduled connect_timeout death health intent skill_start skill_target
skill_end skill_abort_begin skill_abort skill_reject arb_grant arb_preempt arb_preempt_timeout arb_release arb_deny reflex metrics
lag_warn protocol_fix`. Every line has `t` (ISO), `ts`, `seq`, `type`. Metrics snapshots are traced every 30 s and the latest is
overwritten in `runtime/metrics.json`.

## Gotchas found while building (keep)

* `bot.pathfinder.stop()` only ARMS a latch; if no path is active it stays armed and the next `goto()` dies instantly with `PathStopped`.
  `stopBody` calls `stop()` first and `setGoal(null)` second (consumes the latch).
* Mineflayer's `end` event is the only reliable disconnect signal; `error` includes harmless parse errors and is not treated as a disconnect.
* Mineflayer auto-respawns; the lifecycle sees `death -> respawn -> spawn` as dead -> respawning -> spawned.
