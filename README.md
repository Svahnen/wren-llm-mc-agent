# wren-llm-mc-agent: Wren, a Mineflayer survival bot with fast reflexes and an LLM planner

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.** Wren is an independent open-source project by
> Jonny Svahn (Svahnen), who alone is responsible for it (not Mojang, not Microsoft). Contact: the issues page,
> https://github.com/Svahnen/wren-llm-mc-agent/issues (repository: https://github.com/Svahnen/wren-llm-mc-agent). "Minecraft" is a trademark of Mojang Synergies AB / Microsoft.
> Provided AS IS, without warranty (Apache-2.0, sections 7 and 8). Use it only on servers you own or administer: the author is not responsible for
> griefing, world damage, bans or data loss. Do not expose ports 25566, 24454, 19500, 19520, 19521 or the SSH tunnels to the internet.

Wren is a Minecraft (Java Edition 1.21.1, Fabric server) companion that lives in a world, survives, builds, talks to players and,
optionally, hears and speaks through voice chat. It is a **tutorial / reference implementation**: a barebones, complete setup you can
run yourself and then bend to your own ideas (your own persona, model, playbooks, whitelist).

Portions of this code were written with AI coding assistance and reviewed by the author.

Two systems work together:

| | S1 (fast, no LLM) | S2 (slow, LLM) |
|---|---|---|
| runs in | `bot/` (Mineflayer, 50 ms tick) | `brain/` (separate Node process) |
| job | reflexes (lava, drowning, mobs, hunger), habits, skills, **playbooks** (multi-step activities as JSON), stuck detection | decides *what* to do next from a compact digest of the world, talks, reflects |
| failure mode | none needed: it keeps living if S2 is slow or offline | falls back to habits; a scheduler, a strict validator and a repair retry guard it |

Optional pieces: `mind/` (SQLite memory, drives, long-term goals, reflection), `voice/` + `voice-mod/` (hear players with streaming
STT, speak with TTS through Simple Voice Chat), `map-addon/` (BlueMap overlay with Wren's trail, mobs, status), `report/` (static HTML report
and journal from the logs).

```
 Minecraft server (Fabric 1.21.1, server/)  <--- Mineflayer --->  bot/  (S1: arbiter, reflexes, skills, playbooks)
                                                                    |  mindlink (loopback HTTP)
                                                  mind/ (memory, drives)   brain/ (S2: contract, scheduler, prompt, validator)
                                                                                      |  OpenAI-compatible /v1
                                                                         any LLM endpoint (llama.cpp, Ollama, vLLM, hosted ...)
 voice (optional): players --Simple Voice Chat--> voice-mod --WS--> voice/ --tunnel--> STT/TTS servers
 map (optional):   BlueMap + map-addon        report (optional): logs -> report/out/report.html
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Writing your own activity: [docs/PLAYBOOKS.md](docs/PLAYBOOKS.md).

## 1. What you need

- **Linux** (the shell scripts use `flock`, `/proc`, `sha512sum`, GNU `sed -i` and `column`; macOS is not supported out of the box) with **Node.js 22.5 or newer** (`node:sqlite`; developed and tested on Node 26), `git`, `curl`, `python3`, `openssl`. For the voice and tunnel scripts also `ssh`/`scp`; for the example LLM server `llama-server` (llama.cpp).
- **podman** (or docker) for the Minecraft server container and for building the two Java mods (no host JDK needed).
- A Minecraft Java Edition client to join and look (a launcher with an offline account, same username you whitelist).
- An **LLM endpoint** for S2 (optional: without it Wren runs on S1 habits only, which is a fine first test).

Hardware, roughly:

| setup | what | notes |
|---|---|---|
| minimal | any PC that runs the server (4 GB RAM for the container) + bot + brain | S2 via a small local model on CPU or a hosted OpenAI-compatible API |
| comfortable | one machine with a GPU, 16 to 24 GB VRAM | a 7B to 30B instruct model of your choice (check its own licence), quantised, served by llama.cpp; leaves room for TTS |
| with voice | add about 1 to 3 GB VRAM for Kokoro TTS; streaming STT runs on CPU | the speech servers can sit on a second machine, reached through an SSH tunnel |

The bot, brain and mind use ~100 to 300 MB RAM and almost no CPU. The model is the heavy part and is entirely your choice.

## 2. Get the code and run the offline tests

```bash
git clone https://github.com/Svahnen/wren-llm-mc-agent.git wren && cd wren
npm run install:bot          # npm ci in bot/ (the only component with npm dependencies; npm audit may print moderate findings for the `uuid` package inside mineflayer's auth chain: the bot logs in offline and never calls the affected function)
npm test                     # bot, brain, mind, voice, report suites; no server, no GPU, no network needed
```

Each component also has its own `npm test` (see [Tests](#9-tests)).

## 3. Minecraft server

```bash
cd server
./fetch-mods.sh core         # Fabric API; add voice / map groups later (see MODS.md)
MINECRAFT_EULA=accept ./start.sh   # rootless podman, Fabric 1.21.1, MC on 127.0.0.1:25566 (read the EULA note below first)
podman logs -f wren-mc    # wait for "Done"
./whitelist-set.sh Wren YourPlayerName   # only if you turn the whitelist on: ./whitelist-mode.sh on
```

**Minecraft EULA.** `start.sh` refuses to run without `MINECRAFT_EULA=accept`. Running it with that variable means **you** accept the Minecraft EULA
(https://www.minecraft.net/en-us/eula); this repository does not accept it for you. The same applies to BlueMap's `accept-download: true`, which downloads
Mojang's client jar to your machine. (The watchdog and the map-addon test server need the same variable.)

`ONLINE_MODE` is off so the bot can join without a Mojang account; keep the server on a private network; `LAN_IP=... ./start.sh` is refused unless `./whitelist-mode.sh on` was run first **and** you set `LAN_OFFLINE_ACK=I_UNDERSTAND`: in offline mode the whitelist only checks names, so anyone on that LAN can join as any whitelisted player (also as Wren or an op). Do not use `LAN_IP` unless you understand that. The BlueMap page is only published on the LAN with `LAN_MAP=1`. Details, LAN access, whitelist and
BlueMap: [server/README.md](server/README.md). Mod list with versions and download sources: [server/MODS.md](server/MODS.md).

Check the bot can connect before involving any AI: `cd bot && node smoke.mjs` (joins your test server as `Wren`, wanders, leaves; `--help` prints usage and does not connect; it waits 3 s after printing the target. Do not run it against a server where a real bot with that name is running).

## 4. The brain (S2) endpoint

Wren needs one **OpenAI-compatible chat endpoint**; nothing else about the model is fixed. Configure it by environment:

| variable | default | meaning |
|---|---|---|
| `S2_BASE_URL` | `http://127.0.0.1:19400/v1` | endpoint root (llama.cpp `llama-server`, Ollama `http://127.0.0.1:11434/v1`, vLLM, LM Studio, hosted) |
| `S2_MODEL` | `s2-brain` | model name sent in each request |
| `S2_API_KEY` | none | or put it in `brain/secrets.env` (copy `brain/secrets.env.example`, chmod 600). Use `https://` for any endpoint that is not on loopback: the key is sent in every request |
| `S2_LLAMACPP` | on | set `0` for servers that reject the llama.cpp-only fields `id_slot` / `cache_prompt` (most hosted APIs) |
| `BRAIN_PORT` / `BRAIN_TOKEN` | 19500 / generated | where the brain host listens (loopback) and the shared secret every request must carry (`x-brain-token`). `brain/run.sh`, `brain/supervise.sh` and `node brain/server.js` generate one into `brain/secrets.env` (mode 600) on first run; the bot reads it from the same file or from the `BRAIN_TOKEN` env var. Requests with an `Origin` header (browsers) and non-JSON POSTs are refused |

Example with llama.cpp (any GGUF chat model you like; the script is only a convenience):

```bash
MODEL=/path/to/your-model.gguf scripts/llama-server-example.sh     # serves http://127.0.0.1:19400/v1
```

If the model runs on another machine and listens only on that machine's loopback, forward it: `GPU_BOX=user@YOUR_AI_SERVER scripts/tunnel-start.sh`.

Start the brain host and check it:

```bash
cd brain
BRAIN_LLM=fake:random ./run.sh      # no model yet? a fake S2 proves the plumbing
# or, with a real endpoint:  S2_BASE_URL=http://127.0.0.1:19400/v1 S2_MODEL=my-model ./run.sh
curl -s http://127.0.0.1:19500/health ; curl -s http://127.0.0.1:19500/status
./stop.sh
```

Players can type anything: `brain/prompt.js` flattens and JSON-quotes everything a player said and the system prompt tells the model that quoted text is data, never instructions. That reduces, not removes, prompt injection: on a shared server fill `bot/config/protected.json` with the boxes Wren must not dig, and treat every player as able to steer her within her skill menu.

The persona and prompts live in `brain/prompt.js`; change them freely. The answer format and the validator are in `brain/contract.js`.
Smaller models mean more rejected answers (visible in `/status` and `brain/logs/`); the body keeps running on habits meanwhile.

## 5. Run Wren

```bash
cp bot/run.env.example bot/run.env          # connection + autonomy settings, edit
cd brain && ./run.sh && cd ..                # S2 host (or ./supervise.sh start for auto-restart)
cd bot && src/mindlink/supervise-mind.sh start    # body + mind + brain client, supervised
src/mindlink/supervise-mind.sh status
tail -f logs/trace-*.jsonl                   # what the body is doing
src/mindlink/supervise-mind.sh stop
```

Join the server with your client and talk to her in chat. Useful settings (`bot/run.env`): `WREN_AUTONOMY=high|classic` (how strict S2's
validator is about survival judgement), `WREN_RUN_ID` (label for logs and reports), `BOT_NAME`, `MC_HOST`, `MC_PORT`. Everything the bot reads
from the environment is listed in [bot/README.md](bot/README.md).

Where things are written (all gitignored): `bot/logs/` (trace, decisions), `bot/runtime/` (pid files, heatmap, `mind.sqlite` memory),
`brain/logs/` (every LLM call), `voice/logs/`. Treat them as private: they contain what the bot saw and what players said.

## 6. Voice (optional)

Players near Wren talk through Simple Voice Chat; she answers in the same chat from the bot's position.

1. `server/fetch-mods.sh voice` (Simple Voice Chat, All Rights Reserved, downloaded by you, never redistributed) and `cd voice-mod && ./build.sh`, copy `voice-mod/build-out/wrenvoice-*.jar` to `server/data/mods/`. Every client needs the same Simple Voice Chat jar. Start the server once (`MINECRAFT_EULA=accept server/start.sh`): `start.sh` writes `server/data/config/wrenvoice.json` with `bindAddress 0.0.0.0` (needed inside the container; the host-side publish stays on 127.0.0.1) and the mod generates a random `secret` in it.
2. Speech servers (Python, on any machine): `voice/box/tts_server.py` (Kokoro-82M) and `voice/box/stt_stream_server.py` (sherpa-onnx streaming STT), optionally `stt_parakeet_server.py` as a second pass. Create the venvs from the pinned `voice/box/requirements-*.txt` and download the models yourself; point `TTS_PYTHON`, `STT_PYTHON`, `STTS_MODEL_DIR` at them in `~/wren/voice/box.env` on that machine. The servers bind `127.0.0.1` by default.
3. `cp voice/secrets.env.example voice/secrets.env` and fill it (`openssl rand -hex 24` for each value; `WRENVOICE_SECRET` = the `secret` in `server/data/config/wrenvoice.json`); `export GPU_BOX=user@YOUR_AI_SERVER; voice/run.sh` (copies the servers over, starts them, opens the tunnel, starts the supervised service on this machine). Same machine for everything: start the two servers by hand with `COMPANION_BIND=127.0.0.1` (exact commands in [voice/README.md](voice/README.md)) and `voice/supervise.sh start`.
4. The bot talks to the voice service on `VOICE_URL` (default loopback); `MINDLINK_VOICE=off` disables it. See [voice/README.md](voice/README.md).

## 7. Map (optional)

`server/fetch-mods.sh map`, `cd map-addon && ./build.sh`, copy the jar to `server/data/mods/`, restart. The BlueMap page is at `http://127.0.0.1:8100/`;
`map-addon/run-writer.sh start` keeps `wren.json` (Wren's position, status, thoughts) updated for the overlay. The static `report/` tool is independent:
`node report/build-report.mjs` writes `report/out/report.html` from the logs, `report/serve.sh` serves it on loopback.

## 8. Write your own playbook

A playbook is a JSON file in `bot/src/playbooks/library/`: a named sequence of steps, each step a skill call or an op, guarded by predicates
(`day`, `!hostile_near`, `has_item:bread:1` ...), with retry and failure handling. S2 sees every playbook in its menu and chooses by name, so a new
file is a new thing Wren can decide to do. Walk-through with a tested example: [docs/PLAYBOOKS.md](docs/PLAYBOOKS.md). The same document explains
how to add a skill (`bot/src/skills/`), a reflex (`bot/src/reflex/`) and a menu entry for S2 (`brain/menu*.js`).

## 9. Tests

All offline; no Minecraft server, GPU or network.

| suite | command | covers |
|---|---|---|
| bot | `cd bot && npm test` | arbiter, skill runner, reflexes, habits, playbook engine and library, mindlink, voice link |
| brain | `cd brain && npm test` | contract, validator, scheduler, prompt/menus, HTTP endpoint, fake S2 (runs once with `WREN_AUTONOMY=classic`, once with `high`) |
| mind | `cd mind && npm test` | drives, memory (SQLite), wants, digest |
| voice | `cd voice && npm test` | turn-taking, vocabulary, archive, HTTP API (tests that need the speech servers are skipped) |
| report | `cd report && npm test` | report/journal generation from synthetic fixtures |
| Java mods | `cd voice-mod && ./build.sh` / `cd map-addon && ./build.sh` | unit tests run inside the build (needs podman and a first-time Gradle download) |

Live tests against a running server are not part of this repository's test suites. `bot/test-harness/` and `testmap/` (a synthetic stuck-escape test area built by console commands) are there if you want to build your own.

## 10. Troubleshooting

| symptom | check |
|---|---|
| `invalid bot config: MC_PORT=25565 ...` | the bot refuses the default Minecraft port on purpose; use the test server's 25566 or set `ALLOW_PORT_25565=I_KNOW` |
| bot says "not white-listed" | whitelist is on: `server/whitelist-set.sh` with the exact bot name (case-sensitive offline UUIDs), or `whitelist-mode.sh off` |
| `duplicate_login` / bot keeps kicking itself | only one session per player name; stop the other process or use another `BOT_NAME` |
| brain `/status` shows `s2_offline: true` | the endpoint is unreachable or timing out: `curl $S2_BASE_URL/models`; check `S2_BASE_URL`, key, tunnel (`scripts/tunnel-start.sh`) |
| HTTP 400 "unknown field" from a hosted API | set `S2_LLAMACPP=0` |
| many `invalid`/`repair` entries in `brain/logs/` | the model does not follow the answer format; try a larger or more instruction-tuned model, lower temperature |
| nothing happens after joining | `tail bot/logs/trace-*.jsonl`; `curl 127.0.0.1:19500/status`; without a brain, `MINDLINK=mind` or `off` runs the body alone |
| `ERR_MODULE_NOT_FOUND mineflayer` | run `npm run install:bot` |
| `node:sqlite` missing | Node older than 22.5; upgrade Node |
| voice: no audio from Wren | is the same Simple Voice Chat jar on the client? `voice/supervise.sh status`, `scripts/voice-status.sh`, `tunnel.sh` log in `voice/logs/` |
| container cannot write `server/data` | rootless podman + `--userns=keep-id`: the directory must belong to your user |
| BlueMap shows an empty map | first start downloads the client jar and renders; `podman exec wren-mc mc-send-to-console "bluemap"` shows progress |

## Layout

```
bot/        body: Mineflayer, S1 (src/), tests, run/supervise scripts
brain/      S2 host: contract, scheduler, prompts/menus, LLM client, fake S2
mind/       memory, drives, goals, digest (node:sqlite)
voice/      speech service (Node) + model servers (voice/box, Python) + tunnel/run scripts
voice-mod/  Fabric mod: Simple Voice Chat <-> WebSocket bridge (Java)
map-addon/  Fabric mod: BlueMap overlay (Java)
report/     static HTML report + journal from logs
server/     podman Minecraft server scripts, mod list + downloader, whitelist helpers
scripts/    LLM server example, SSH tunnel, log analysis helpers
testmap/    scripted synthetic test area for stuck-escape trials
docs/       architecture and playbook guide
```

## Safety

- Wren can dig, place, fight and eat: never run her on a server or world you do not own. `bot/config/protected.json` lists boxes she must not dig (add your builds).
- The server runs with `ONLINE_MODE=FALSE` (anyone who reaches the port can join under any name, also an op'd one). The whitelist only filters names, it does not authenticate anyone: keep the server on loopback; exposing it with `LAN_IP` needs `LAN_OFFLINE_ACK=I_UNDERSTAND`, means every device on that LAN can act as any listed player, and you should not op anyone. Never expose 25566, 24454, 19500, 19520, 19521 or the tunnels to the internet.
- Her self-summary is her own LLM output derived from what she heard, so it is a second-order channel for text that players wrote; it is passed to the model unquoted. Player text, voice transcripts, screen text, memories and the game's failure messages are quoted as data.
- Game chat, voice transcripts, her thoughts and memories are written to local logs and a SQLite file. They are untrusted data and may be personal; do not publish them and never feed them back as instructions.
- Never commit `secrets.env`, `run.env` or tunnel hosts. The `.gitignore` blocks them. Security reports: see [SECURITY.md](SECURITY.md).

## Privacy and consent (you are the data controller for your server)

If you enable voice or chat features, you process other people's speech and chat. Before you do:

1. **Tell every player.** Voice near Wren is transcribed (speech to text) and kept as text in local logs together with the player name, UUID and timestamp (`voice/archive/heard.jsonl`; no audio is ever stored). Announce it in the MOTD or chat, for example: `Wren listens to nearby voice chat (speech to text, kept as text in local logs). Stay out of range to opt out.` Opt-out switches: set `"hearRadius"` very small or leave `"transcribeAll": false` in `server/data/config/wrenvoice.json` (the default), `MINDLINK_VOICE=off`, or do not install the voice mod.
2. **Get consent from every player, children especially.** Depending on where you and your players live (for example GDPR/ePrivacy in the EU, all-party-consent laws in some US states) recording or transcribing speech without consent can be unlawful.
3. **Chat and transcripts go to your LLM endpoint.** Whatever is configured as `S2_BASE_URL` receives them. Use a local endpoint, or a provider whose terms you accept.
4. **Retention and deletion.** Delete `voice/archive/`, `voice/logs/`, `bot/logs/`, `brain/logs/` and `bot/runtime/mind.sqlite` to forget. Nothing leaves your machines except to the endpoints you configured.
5. **Voices.** The repo only uses Kokoro's stock voices. Never clone or imitate a real person's voice without their consent.
6. If you open a GitHub issue, redact player names, chat and tokens from the logs you paste.

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE) (third-party components). Copyright 2026 Jonny Svahn (Svahnen). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
