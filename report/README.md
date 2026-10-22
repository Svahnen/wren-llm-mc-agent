# report/ : static life report and journal for Wren

Plain Node ESM (v26), zero dependencies, read-only on `bot/`, `mind/`, `brain/`. Writes only `report/out/`, `report/run/`, `docs/journal/`.

| command | what |
|---|---|
| `node report/build-report.mjs [--out F] [--logs-dir D] [--runtime-dir D] [--brain-dir D] [--mind-db F] [--journal-dir D]` | writes ONE self-contained `report/out/report.html` (inline CSS + SVG, no scripts, no external requests, dark/light aware, phone width) |
| `node report/journal.mjs [--date YYYY-MM-DD] [--out-dir D] [--copy-to D]` | writes `docs/journal/YYYY-MM-DD.md` for every day that has data (deterministic third-person text; only rewrites a file if it changed) |
| `report/watch.sh` / `--once` / `--foreground`, `report/stop-watch.sh` | rebuild journal + report every `WATCH_INTERVAL` s (default 600), pid `report/run/watch.pid`, log `report/run/watch.log` |
| `report/serve.sh [start\|stop\|status]` | read-only static server of `report/out` on `127.0.0.1:8890` (`REPORT_BIND=0.0.0.0` opens it to your LAN; the report contains chat, thoughts and positions and has no login, so only do that on a network you trust), pid `report/run/serve.pid`; prints `http://127.0.0.1:8890/report.html`. Journal copies at `/journal/YYYY-MM-DD.md` |
| `cd report && npm test` | 11 tests with synthetic fixtures in `report/test/fixtures/` (brain logs, trace, heatmap, landmarks) |

## Inputs (all optional; missing data gives an empty section, never a crash)
* `bot/logs/trace-*.jsonl` (top level only, all days and rotated parts; test-run subfolders such as `t4-habits/` are ignored; corrupt lines skipped)
* `bot/runtime/metrics.json`, `heatmap.json` (8-block cells), `landmarks.json` (home)
* mind SQLite: first of `--mind-db`, `$MIND_DB`, `{bot,brain,mind,}/runtime/mind.sqlite`, `mind/mind.sqlite`, or any `*.sqlite|*.db` in those runtime dirs. Opened with `node:sqlite` `readOnly`.
* `brain/logs/brain-*.jsonl` (intents, speech, reflections, human events) and `llm-*.jsonl` (raw model output). `bake-*` subfolders are ignored.

## Report sections
Header (status, uptime, totals), timeline (skill starts per bucket by category plus death/reflex/stuck/restart markers), notable events, habit and time-share bars, reflex table, map heatmap with home and death markers, metrics table, per-skill table with fail rate and top reasons, lessons/preferences/self-summary (mind), wants/speech/model output (brain), latest journal day, "verified vs not" footer computed from which inputs were present.

## Journal
Per local day: Highlights, then one paragraph per hour (activities, completed things such as gathered/crafted/ate, destinations relative to home, failures, reflex dangers, deaths with the mind lesson if matched in time, stuck episodes and recoveries, reconnects, conversations, her decisions and speech), then a memory section from the mind DB. No clock, no randomness: same logs give the same file.
**Optional LLM hook, OFF by default:** `--llm-endpoint http://host:port [--llm-model NAME]` sends the finished entry to an OpenAI-compatible chat endpoint and appends one clearly marked paragraph. Nothing in `watch.sh` passes it; failures keep the deterministic entry.

## Known limits
* The trace has no per-hour position and no death cause; "where she went" uses `skill_target` destinations and the all-time heatmap. Repeat-cause deaths and lesson reuse need the mind DB.
* Mind timestamps are game seconds unless they look like epoch; game-time rows cannot be placed in an hour and are shown only in the memory section.
* The heatmap is an all-time visit counter, not a path.
* Layout was checked structurally, not in a real browser (none available headless on this box).

## R2 additions
* Report sections Conversation, Inner thoughts, Goals, Chat, Deaths and lessons, Run archive (`lib/convo.mjs` model, `lib/render-convo.mjs` HTML). Source: newest `voice/archive/<run>/` (not `synth`; `--run-id`, `--archive-root` override), `bot/logs/{thoughts,chat,mindlink}.jsonl`, mind DB `meta.state_goals`. Archive text files are copied to `report/out/archive/<run>/` and linked.
* Journal hour paragraphs now include conversations with reply latency, held/cut lines, overheard remarks, top-2 thoughts per hour, goal changes, death cause and first thought afterwards. Same inputs, same file.
* Thought importance: the logger writes none yet, so a deterministic heuristic (kind, someone near, keywords, mood intensity) ranks them; a logged `importance` wins when present.
* Goals: the store keeps created/ended and current status only (no per-change history); objectives come from mindlink `goal_start`/`goal_end`; the mind has no commitments store.
