# wrenvoice: Simple Voice Chat bridge for Wren (Fabric server mod)

Server-side mod (Minecraft 1.21.1, Fabric loader 0.19.5, Fabric API 0.116.17+1.21.1, SVC 2.6.24, Java 21).
Lets an external speech service HEAR real players near the bot and SPEAK from the bot's body over a local WebSocket.
No SVC client is needed for the bot.

## Build (rootless podman, no host JDK)
    cd voice-mod && ./build.sh        # clean build + unit tests, ~3 min first time (downloads), ~30 s after
Equivalent: `podman run --rm --userns=keep-id -v $PWD:/work:Z -w /work -e GRADLE_USER_HOME=/work/.gradle-home docker.io/library/gradle:8-jdk21@sha256:c71fc6625c18e889654adeb86c99974028bc888505f6e1fd7eccad057174877d gradle --no-daemon clean build`.
Output: build-out/wrenvoice-1.0.0.jar and .sha512. Sources: official Maven (maven.fabricmc.net, maven.maxhenkel.de, Mojang libraries, Maven Central via Gradle).

## Install
1. Copy build-out/wrenvoice-1.0.0.jar to server/data/mods/ (next to fabric-api and voicechat jars).
2. `server/start.sh` writes `server/data/config/wrenvoice.json` with `{"bindAddress":"0.0.0.0"}` if it does not exist; the mod then fills in the defaults
   (`botName`, `hearRadius`, `speakDistance`, `wsPort`, `transcribeAll: false`) and **generates a random `secret`** on first start. Config shape:
       {"botName":"Wren","hearRadius":16.0,"transcribeAll":false,"speakDistance":20,"wsPort":19520,"bindAddress":"127.0.0.1","secret":"<random>"}
3. Start the server. Log line: `wrenvoice: WebSocket listening on ...`. Copy the generated `secret` into `voice/secrets.env` as `WRENVOICE_SECRET=...`
   (the voice service sends it as header `X-Wren-Secret`).

Security: the WebSocket carries player microphone audio and lets a client make the bot speak, so (1) a shared secret is always required (generated if you
leave it empty), (2) any handshake that carries an `Origin` header is refused, so a web page open in your browser cannot connect to the loopback
port, (3) `transcribeAll` is off by default (only players within `hearRadius` are forwarded), (4) only one client may be connected at a time.

Container: inside the podman container "127.0.0.1" is the container's own loopback, so the host cannot reach it; hence `"bindAddress":"0.0.0.0"` in the
container config together with the host-side `-p 127.0.0.1:19520:19520` publish in server/start.sh, which keeps it loopback-only. Never publish 19520
on a LAN or the internet.

Licence note: Simple Voice Chat is All Rights Reserved (Max Henkel). wrenvoice does not contain any of its code: it only compiles against the
public voicechat API (`compileOnly`) as an addon, the documented extension mechanism (https://modrepo.de/minecraft/voicechat/api). The API's licence is not
published separately; do not redistribute wrenvoice bundled with the Simple Voice Chat jar. Builds also download Mojang's official mappings (Microsoft
licence: development use only, no redistribution of the mappings); the built jar contains remapped intermediary names, not the mappings.

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

## Protocol v2 (v1-compatible; v2 only adds fields) (JSON text messages, one object each; ws://127.0.0.1:19520, max one client, a second one gets HTTP 409)
mod -> service
- `{"type":"hello","version":2,"bot":"Wren","botOnline":bool,"transcribeAll":bool,"hearRadius":num}` on connect
- `{"type":"players","t":ms,"bot":{x,y,z,uuid}|null,"near":[{uuid,name,dist,x,y,z}],"all":[{uuid,name,dist|null,in_range,x,y,z}]}` every 500 ms. `near` = real players within hearRadius, same dimension (v1). v2 `all` = EVERY online real player except the bot; dist null = bot offline or other dimension; in_range = dist != null && dist <= hearRadius
- `{"type":"audio_in","uuid","name","dist"(null if unknown),"in_range"(bool, v2),"in_range","seq","t":epochMs,"pcm16k":"<b64 s16le mono 16 kHz>"}` one per 20 ms mic packet (320 samples; no batching)
- `{"type":"audio_end","uuid","name"}` after 400 ms without packets (or SVC end-of-stream packet, or the speaker walked out of range)
- `{"type":"played","utt_id","ms_played","done"}`: progress every ~240 ms while speaking (done:false); done:true when the utterance queue has been empty for 100 ms (so send chunks faster than real time); reply to flush (done:false)
- `{"type":"error","msg"}`: bad_chunk_size, queue_overflow, bot_offline (rate limited 1/s), bad message
service -> mod
- `{"type":"audio_out","utt_id","seq","pcm48k":"<b64 s16le mono 48 kHz>"}` any multiple of 960 samples; mod paces 1 frame / 20 ms, queue max 2 s (a chunk that would exceed it is dropped whole + error)
- `{"type":"flush","utt_id":"<id>|*"}` stop within one frame, reply played{done:false}
- `{"type":"speak_distance","d":float}`
Audio is only forwarded while a client is connected. On disconnect all queued speech is dropped.

## Test tools
    node tools/fake-service.mjs [--url ws://127.0.0.1:19520] [--secret S] [--tone] [--echo] [--save-dir DIR]
Stdin commands: `tone` (2 s 440 Hz), `flush [id]`, `dist <n>`, `quit`. Node >= 22, no packages needed.
Throwaway server test: `test-server/start.sh` (container wren-voicetest, 127.0.0.1:25570, WS 127.0.0.1:19571); last log in test-server/last-run.log.

## Layout
Pure (unit-tested): Resampler (48k->16k FIR), PlayoutQueue, Protocol, Proximity, MiniWsServer (own RFC 6455 server, no deps), VoiceBridge (WS <-> speaker/decoder interfaces).
MC/SVC glue: WrenVoiceMod (config, per-tick snapshot), WrenVoicePlugin (MicrophonePacketEvent, EntityAudioChannel, rebinding each tick when the bot ServerPlayer instance or dimension changes).

## transcribeAll (v2)
Config `transcribeAll` (default **false**; set true only with every player's consent, see the privacy section of the main README): audio_in is forwarded for EVERY real player (not the bot) regardless of distance, one opus decoder + resampler per player. The service must only let Wren PERCEIVE speech with `in_range:true`. `transcribeAll:false` = v1 behaviour (only players within hearRadius). Players with voice chat disabled/deafened (SVC `isDisabled()`) are skipped; SVC does not deliver packets of muted mics. Set `"transcribeAll":true` in wrenvoice.json only if you want it.
