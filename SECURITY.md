# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's private "Report a vulnerability" (Security tab of
https://github.com/Svahnen/wren-llm-mc-agent/security). Include what you found, how to reproduce it and the version (git commit). Never paste tokens, API keys or real
player names/chat into a report. You will get an answer as soon as the maintainer can; this is a one-person hobby project, with no SLA.

## Supported versions

Only the latest commit on `main` is supported.

## Scope and threat model

- Everything binds to loopback by default (Minecraft 25566, voice mod WebSocket 19520, voice service 19521, brain 19500, speech servers 19411 to 19413,
  report server 8890). The voice mod WebSocket needs a shared secret and refuses browser origins.
- The Minecraft server runs with `ONLINE_MODE=FALSE` so the bot can join without an account: anyone who can reach the port can join under any name. The whitelist only checks names, so exposing the server on a LAN (`LAN_IP`, which needs `LAN_OFFLINE_ACK=I_UNDERSTAND`) lets anyone on that LAN act as any whitelisted player.
  Keep it on loopback, and never expose 25566, 24454, 19500, 19520, 19521 or SSH tunnels to the internet.
- The brain HTTP API (19500) needs a generated shared secret (`brain/secrets.env`), refuses any request carrying an `Origin` header and accepts POST only as `application/json`, so a web page you visit cannot reach it. The report server (8890) checks the Host header. The speech servers refuse requests with an `Origin` header and, when `COMPANION_API_KEY` is set, require the key.
- Supply chain: the container images are pinned by digest and the mod jars by sha512 (`server/mods.lock`), but the Gradle builds of `voice-mod` and `map-addon` do NOT use Gradle dependency verification: Maven artefacts (Fabric, Simple Voice Chat API, Maven Central) are fetched over HTTPS without per-artefact checksum pinning. Review `build.gradle` before building, or generate `gradle/verification-metadata.xml` yourself (`gradle --write-verification-metadata sha256 build`) and commit it for your fork.
- Player chat and voice transcripts are untrusted input to the LLM planner. The planner's output is restricted to a closed menu of skills and
  validated; nothing the model writes is executed as code or shell. A player can still steer Wren within that menu.
- Wren can dig, place and fight. Run her only on servers you own or administer.
- Logs (`bot/logs`, `brain/logs`, `voice/archive`, `bot/runtime/mind.sqlite`) contain chat, speech transcripts and positions. Treat them as private.

The software is provided AS IS, without warranty (Apache-2.0, sections 7 and 8).
