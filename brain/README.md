# brain/ : Wren's System 2 host

Separate Node process (no dependencies, Node >= 22, tests with `node --test`) that owns the S2 contract, scheduler, prompt builder and LLM client.
The Mineflayer body (bot/) talks to it over a loopback HTTP endpoint, so LLM/JSON/GC spikes never touch the 50 ms physics tick.

    cd brain && npm test          # contract, scheduler, brain pipeline with fake S2, HTTP, menus
    ./run.sh                      # detached, pid in runtime/brain.pid, stdout in logs/stdout.log
    ./stop.sh
    BRAIN_LLM=fake:random ./run.sh   # fake S2 (modes: random | same | garbage | stall | invalid)
    S2_BASE_URL=http://127.0.0.1:19400/v1 S2_MODEL=my-model ./run.sh   # any OpenAI-compatible /v1 endpoint
    # endpoint on another machine, bound to its loopback? use an SSH tunnel: scripts/tunnel-start.sh (needs GPU_BOX=user@YOUR_AI_SERVER)

Env: `BRAIN_PORT` (19500, 127.0.0.1 only), `BRAIN_LLM`, `S2_BASE_URL` (default http://127.0.0.1:19400/v1), `S2_MODEL` (the model name sent in the request), `S2_API_KEY` (or `secrets.env`, see `secrets.env.example`), `S2_LLAMACPP=0` (do not send the llama.cpp-only fields `id_slot`/`cache_prompt`, needed for hosted APIs that reject unknown fields), `BRAIN_TOKEN` (required shared secret, header `x-brain-token`; generated into `brain/secrets.env` with mode 600 on first run by `run.sh`/`supervise.sh`/`server.js`, read by the bot from the same file; the API also refuses any request with an `Origin` header and any POST that is not `application/json`), `BRAIN_LOG_DIR`, `BRAIN_LOG_PROMPTS=0`.

## Files
| file | job |
|---|---|
| `contract.js` | output format, relaxed header parser, STRICT validator, intent object, S1->S2 event schema, speech/cancel templates, digest schema |
| `scheduler.js` | priority queue, coalescing (2 s), depth cap, per-call deadline, sleep-pass rule, S2-offline mode, call/token budget |
| `prompt.js` | stable system prefix + volatile user message; repair prompt (1 retry); reflection prompt |
| `llm.js` | OpenAI-compatible streaming client (llama.cpp, Ollama /v1, vLLM, hosted), abort, timeout, early stop, JSONL log of every call |
| `brain.js` | wires it together: event -> scheduler -> prompt -> LLM -> early header check -> validate -> (1 repair) -> intent store |
| `fake-s2.js` | fake S2 with the same interface as the LLM client |
| `server.js`, `run.sh`, `stop.sh` | HTTP endpoint and process control |
| `menu.js`, `menu-*.js` | the activity menu S2 chooses from: facts and options built from the digest, one layer per feature area (playbooks, food, farming, roaming, expeditions, survival strategy, goals) |
| `scenarios.js` | grounded scenarios used by the tests |

## The contract in one screen
S2 answers: line 1 `{act:<skill>,args:{k:v}}`, line 2 `---`, then 1-3 sentences (exactly 1 when `act != none`; extra sentences are cut, not rejected).
Closed vocabulary (`SKILLS` in `contract.js`): none, idle_activity, gesture, explore, move_to, go_to, follow, approach, flee, eat, hunt, sleep, collect, interact.
Arg types: enums, whole numbers with ranges, `ref` ids that must exist in the digest with the right kind, inventory items.

The validator is the real defence (T8: the model is syntactically perfect but semantically weak). Besides types and ids it rejects:
starving while food is known and the act ignores it; walking to a target or coordinate within 4 m of lava/fire/etc.; approaching hostiles;
passive acts with a hostile within 6 m at hp <= 10; explore/collect/move_to at hp <= 6; sleep outside night/thunder or without a bed;
collect with a full inventory; a (act,args) repeated 3 times in the last 8 intents. Rejections list the valid names, and are fed to the single repair retry.
After the retry the caller falls back to habits (S1 keeps going; a human who spoke gets a template line, no LLM).

Intent (S2 -> S1): `{v:1, intent_id, goal, args, modulators{urgency,caution,sociability}, constraints{avoid[],area,max_s}, ttl_s, interruptible, plan_id, source, created_at_ms}`.
Modulators and constraints are derived from the digest by code, not by S2. `plan_id` is reserved (null) until multi-step plans exist.

S1 -> S2 events (`POST /event`, JSON, every one may carry the digest):
`human_speech{from,text}`, `report{intent_id,status: started|progress|done|failed|preempted|blocked, reason_code}`, `drive_wake{drive,level}`, `heartbeat`, `reflection_due`, `sleep_pass_due`, `body_state{state}`.
Only done/failed/blocked/human_speech/drive_wake/heartbeat/reflection/sleep_pass cause an S2 call; started/progress/preempted only update bookkeeping.

## Endpoint (127.0.0.1:19500, plain HTTP; long-poll instead of a WebSocket)
- `POST /event` -> 202 `{queued, coalesced, job_id}` or 422 with schema errors.
- `GET /intent?since=<seq>&wait=<ms, max 25000>` -> `{seq, changed, intent|null, speech{utterance_id,intent_id,text,released}|null, cancel_utterances[], template_line{text,intent_id}|null (one-shot), s2_offline, habits_only, expired}`.
  Latest wins. `habits_only: true` means S1 must run on habits (S2 offline, no intent, or the intent expired by `ttl_s`).
  Speech is released when S1 reports `started` for that intent_id; `failed|blocked` gives a template line (and cancels unreleased speech), `preempted` cancels silently.
- `GET /status` (queue depth/age, in-flight, budget, stats, valid rate, `s2_offline`), `GET /reflection`, `POST /context {self_summary, memories[]}`, `GET /health`.

## Scheduler rules
Priority: human speech > blocked/failed > drive wake and done > heartbeat > reflection > sleep pass. Same-kind queued events merge within 2 s (low-priority kinds always merge).
Depth cap (default 6) drops the oldest job of the LOWEST priority class, so a flood of heartbeats never evicts a human line (a deliberate refinement of plain drop-oldest).
Per-kind deadline (human 8 s ... reflection 60 s): the call is aborted and a late answer is dropped, even if the call ignores the abort signal. Queued jobs also expire (stale).
Two slots: dialogue (0) and planning (1); background work waits while dialogue is active or queued; human speech aborts a running reflection/sleep pass; a newer human message supersedes the in-flight one and carries the older text.
Sleep pass: refused if any human is on the server, one at a time, slot 1 only. Offline: 3 consecutive failures/timeouts -> `s2_offline` (habits only, visible in `/status` and `/intent`, template line "thinking is offline"); one probe job per interval; first success returns online. Budget: sliding window of calls/tokens; over the soft cap only human/blocked/failed pass, over 2x nothing does.

## Aligning with the body (T1/T4)
`SKILLS` is the contract's vocabulary, not a list of what bot/ has built. For every skill the body wants S2 to be able to choose, register a skill of the same name and arg shape in the bot's skill runner, and delete the others from `SKILLS` (prompt, validator and tests follow automatically). The digest builder in the bot must produce the fields documented above `normalizeDigest` in `contract.js` (ids like `cow_1`, positions of hazards and targets are what make the lava and hazard checks work). Unverified: no end-to-end run against the real bot yet.

## What is NOT here
No memory/drive code (see ../mind), no TTS/STT hooks, no multi-step plans (`plan_id` null), no WebSocket (HTTP long-poll), no auth beyond loopback + optional token.
