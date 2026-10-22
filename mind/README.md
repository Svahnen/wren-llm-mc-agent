# mind/ : Wren's drives, memory, wants

Plain Node ESM, zero dependencies (uses `node:sqlite`, needs FTS5; tested on Node 26). No authored personality: needs are body physics with equal fixed weights, mood decays to a neutral (0,0,0) baseline, and self-summary / reflections / preferences are written only from HER episodes via an injected callback.
Time unit everywhere is GAME SECONDS (1 day = 1200 gs). Tests: `cd mind && node --test test/*.test.js` .

## Modules
| file | what |
|---|---|
| `drives.js` | hunger, energy, safety, curiosity, social. `urgency=(1-level)^2`. `tick(dtReal, digest)` at 1 Hz (TPS-aware: game dt = dt*min(tps,20)/20), `offlineDecay(gapGs)`, threshold events (`low` 0.4, `critical` 0.15, hysteresis 0.55, per-drive cooldown), `satisfy/frustrate`, PAD `appraise(type, magnitude)` (damage, death, discovery, social, goal_done, goal_failed, satisfaction, frustration). |
| `memory.js` | SQLite memory (below). `remember, retrieve, lessonsFor, recordLesson, verifyFact/setFact, sleepPass, addReflection, setSelfSummary, addCore, preferences, embedPending`. |
| `wants.js` | `WantsBook`: wants/goals/projects, `canStart` (repeat cap 2/day per goal+target, 4 starts/day and 3 fails per (type, place), lockouts), cycle detector (period 2..6, 30 min window, locks tokens `type@cell` for 30 min and sets `forceDifferentDrive`), visited-cell map, `noveltyAt`, sightings, `curiosityTargets(pos)` (unexamined sightings, frontier cells, once-seen kinds; all from her own observations). |
| `lessons-to-constraints.js` | `buildConstraints(lessons, {lockouts})` -> `costAt({x,y,z})`, `forbidden(p)`, `goalPenalty(type, place)`, `lockouts`, `zones`. Lava death: forbid radius max(3, extent), cost radius max(6, extent+3). |
| `digest.js` | `buildDigest(raw, ctx)` -> JSON <=1200 estimated tokens (chars/3.5), stable prefix (self_summary, core, preferences) first, volatile (needs, goal, lessons, curiosity, nearby, retrieved episodes) last. |
| `api.js` | `createMind({dbPath, summarize})` with `await mind.handle({op, ...})` -> `{ok, result}` / `{ok:false, error}`. |
| `cli.js` | JSON lines on stdin/stdout: `node mind/cli.js --db /path/mind.sqlite`. Optional `id` echoed back. |
| `sim/` | deterministic grid world, fake S2, A/B harness (`node mind/sim/ab.js`). |

## API ops (api.js / cli.js)
`tick {dt, digest:{food,hp,tps,threats,danger,humansNearby,newCells,sleeping,resting,pos}}` -> events + drive snapshot;
`event {type, magnitude, text, pos, activity, goal_type, outcome, damage, hpMin, satisfied[], novelty, social}` (appraises mood + stores episode);
`lesson {lesson:{goal_type,x,y,z,result:'death'|'fail'|'success',cause,approach,extent}}`; `cost {pos}` -> `{cost, forbidden}`; `constraints`;
`can_start {goal:{type,target,place}}`; `goal_start {goal}`; `goal_finish {id, outcome:'done'|'failed'|'died'}`; `want {want}`; `sighting {sighting}`; `curiosity {pos}`;
`digest {raw, query?}`; `retrieve {query,k,ctx}`; `lessons_for`; `fact {subject,key,value}` (verify-or-supersede); `self_summary {text}`; `sleep {now?}`; `status`; `save`.

## Tables (SQLite, WAL)
`episodes` (+`episodes_fts` FTS5; kind, text, cell, xyz, importance, valence/arousal, strength, count, recall_count, core, habit, archived, optional embedding BLOB), `facts` (+`facts_fts`; valid_from, valid_to, superseded_by, confidence, last_verified, identity), `lessons` (goal_type, cell, xyz, approach, result, cause, extent, strength, used_count, changed_count; unique per goal/cell/approach/result/cause), `places` (visits, notable, danger), `relationships`, `preferences` (grown only from pleasant episodes on 3+ separate days; "pleasant" = `isPleasant()` in memory.js: no death, <2 damage, hpMin>=10, pleasure>=0 and a satisfied drive or novelty or social contact), `self_summary` (versioned, author), `core_memories`, `reflections` (dedupe Jaccard>0.9), `meta`.
Score = 0.35 relevance + 0.2 recency + 0.2 importance*strength + 0.15 emotion + 0.1 use, then MMR (lambda 0.7). Embeddings: `new Memory(path,{embedder:{model,embed(text)}})`, call `await embedPending()`, pass `ctx.queryVec`; default off, retrieval needs none; stored `emb_model` enables re-embed when the model changes.

## sleepPass(now, {summarize})
Merges repeated low-importance episodes (same kind/activity/cell/outcome, >=3) into one `habit` episode, archives the originals (purged after 2 days), decays unrecalled episodes (half-life 3 days, per-row elapsed), prunes faded ones (never core/habit/importance>=0.7/lessons of death), enforces `maxEpisodes`, builds a compact digest, then calls `summarize(digest)` (async, may throw; error is returned in `res.error`, DB stays consistent) only if there are new episodes. The callback returns `{self_summary?, reflections?[], facts?[], core?[]}`, which is HER output and applied with dedupe. Same `now` twice = no change.

## Single-writer rule
Exactly one process (the brain host running `createMind`/`cli.js`) opens the DB read-write. The bot never opens the file; it sends JSON ops. Read-only tools may open `new Memory(path,{readOnly:true})` with `touch:false`. `retrieve()` writes recall counters, so it is a writer call.

## Wiring into the bot (not done here: bot/ belongs to T1)
1. Brain host: `const mind = createMind({dbPath:'runtime/mind.sqlite', summarize: callS2Reflection})`; spawn or import. Bot process can spawn `node mind/cli.js --db ...` and talk JSON lines.
2. Bot every 1 s: `tick {dt:1, digest}` with food/hp/tps/threats/humansNearby/pos; react to returned `events` (drive_threshold -> S2 wake).
3. Pathfinder cost hook: periodically fetch `constraints` (zones) or call `cost` per node; treat `forbidden` as impassable.
4. Before starting a skill: `can_start`; at start `goal_start`; at end `goal_finish`. On death: `event {type:'death'}` + `lesson {result:'death', cause, x,y,z, extent}` (extent = radius of lava blocks seen around the death point).
5. S2 wake: `digest {raw}`. Nightly game time: `sleep`.

## Mood scale (M4)
Mood is PAD in [-1, 1] with 0 = neutral (not 0..1 with 0.5 neutral). `snapshot().mood` = `{p, a, d, label, desc, scale}`, recomputed on every call. Label = octant (exuberant +++, relaxed +-+, dependent ++-, docile +--, hostile -++, anxious -+-, disdainful --+, bored ---) with a neutral deadband (radius 0.25, every axis < 0.12). 0.22/0.17/0.29 is therefore mildly positive on all three axes, i.e. "mildly happy, alert and confident"; only negative numbers mean low.
