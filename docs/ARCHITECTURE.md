# Architecture

## Two systems, one body

```
            +---------------------- brain/ (S2 host, separate process) ----------------------+
 digest --> | contract (format+validator) | scheduler (priority, deadlines) | prompt+menus | --> OpenAI-compatible /v1
 intent <-- |   intent store, speech release, template lines when S2 is offline/invalid      |
            +----------------------------------^---------------------------------------------+
                                               | loopback HTTP: POST /event, GET /intent (long-poll)
 +------------------------ bot/ (one Node process, 50 ms tick) -------------------------------+
 | lifecycle (connect/respawn/backoff) -> arbiter (owner tokens: reflex 3 > s1 2 > s2 1)       |
 |   reflexes | habits + goal stack (S1) | playbook engine | skill runner (progress watchdog)   |
 |   detectors: stuck, cycle, dead state, lockouts      mindlink: digest builder, intents,     |
 |                                                      chat, voice link, commitments          |
 +-----------------------------------------------------------------------------------------+
        |  mind/ (in-process): drives, SQLite memory, wants/goals, lessons -> constraints
```

- **S1** never waits for the LLM. Reflexes preempt everything; habits rank what to do from needs (hunger, energy, safety, curiosity, social) with equal fixed weights; playbooks and skills do the work. If S2 is slow, offline or invalid, S1 keeps living.
- **S2** is asked a question only on events (a player spoke, an activity finished or failed, a drive woke, a heartbeat, reflection time). It sees a compact JSON/text *digest* (state, inventory, nearby entities with ids, places, hazards, recent events, menu of options) and answers in a strict two-part format: a header line naming the action and arguments, `---`, then a sentence of speech. The validator checks names, types, ids against the digest and survival sanity (no walking into lava, no sleeping at noon ...); invalid answers get one repair retry, then S1 falls back to habits.
- **Ownership**: the arbiter gives the body to one owner at a time; a higher priority stops the pathfinder and clears control states synchronously, then revokes the older token.
- **Skills** are the only things that touch the world; each has a progress watchdog that aborts it when its `progress_fn` stops changing.
- **mind/** keeps memory (episodes, lessons from deaths and failures, facts), turns lessons into constraints (forbidden zones, goal lockouts) and builds the digest prefix. It is in-process and optional (`MINDLINK=brain` skips it).

## Process and port map (defaults)

| piece | port | bound to |
|---|---|---|
| Minecraft (container) | 25566 -> 25565 | 127.0.0.1 (+ `LAN_IP` if set) |
| Simple Voice Chat | 24454/udp | same |
| wrenvoice mod WebSocket | 19520 | 127.0.0.1 |
| voice service HTTP | 19521 | 127.0.0.1 |
| brain host | 19500 | 127.0.0.1 |
| S2 endpoint | 19400 (your choice) | wherever your model server runs |
| TTS / STT stream / Parakeet (AI server) | 19411 / 19412 / 19413 | loopback of that machine, reached through `voice/tunnel.sh` |
| BlueMap | 8100 | 127.0.0.1 (+ `LAN_IP`) |

## Voice path

Player mic -> Simple Voice Chat -> `voice-mod` (server mod, WebSocket server on 19520) -> `voice/` service (Node; one streaming STT stream per speaker uuid, endpointing, turn-taking, optional second-pass STT) -> text to the bot over `GET /heard`. The bot's speech goes back `POST /speak` -> TTS (Kokoro) -> audio chunks -> the mod plays them from the bot's position. Details in `voice/README.md` and the protocol in `voice-mod/README.md`.

## Data written at run time (all gitignored)

`bot/logs/` (JSONL trace, S1 decision log, thoughts), `bot/runtime/` (pid files, heatmap, landmarks, `mind.sqlite`), `brain/logs/` (every LLM call with its prompt), `voice/logs/` and `voice/archive/` (transcripts). Plan for these to contain personal chat and voice text.
