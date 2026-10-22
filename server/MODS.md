# Mods

None of the jars are in this repository. `fetch-mods.sh` downloads them from Modrinth into `data/mods/` and verifies the sha512 listed in `mods.lock`
(`./fetch-mods.sh --list` prints the table). Read each mod's licence on its Modrinth page.

**Simple Voice Chat (Max Henkel) is All Rights Reserved.** It is not part of this repository and may not be redistributed. Download it yourself with `fetch-mods.sh voice` (Modrinth). `wrenvoice` only compiles against its public API (`compileOnly`) as an addon; do not redistribute wrenvoice together with the Simple Voice Chat jar or put either in a container image or archive you share.

| Mod | Version (file) | Group | Needed for | Source |
|---|---|---|---|---|
| Fabric API | 0.116.17+1.21.1 | core | everything (required by the others) | https://modrinth.com/mod/fabric-api |
| Simple Voice Chat | 2.6.24 (`voicechat-fabric-1.21.1-2.6.24.jar`) | voice | voice: players talk to Wren. The same jar must be installed on every client | https://modrinth.com/plugin/simple-voice-chat |
| BlueMap | 5.7 (`bluemap-5.7-fabric.jar`) | map | live web map | https://modrinth.com/plugin/bluemap |
| Fabric Language Kotlin | 1.14.2+kotlin.2.4.21 | replay | required by ServerReplay | https://modrinth.com/mod/fabric-language-kotlin |
| ServerReplay | 1.2.10+mc1.21.1 | replay | optional: records the server as a replay file | https://modrinth.com/mod/server-replay |
| Skin Restorer | 2.11.0+1.21 (fabric) | skins | optional: give the bot a custom skin | https://modrinth.com/mod/skinrestorer |

Built from source in this repository (not downloaded):

| Mod | Source | Build | Needed for |
|---|---|---|---|
| wrenvoice | `../voice-mod` | `cd voice-mod && ./build.sh` (podman + gradle image, no host JDK) | voice: bridge between Simple Voice Chat and the speech service |
| wrenmap | `../map-addon` | `cd map-addon && ./build.sh` | BlueMap overlay: Wren's trail, home, mobs, status panel |

Copy the two built jars (`build-out/*.jar`) into `server/data/mods/`. The Fabric loader and the vanilla server jar are fetched by the container image at first start.
Minimal setup (bot only, no voice, no map): `./fetch-mods.sh core` and nothing else.
