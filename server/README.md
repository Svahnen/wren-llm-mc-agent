# server/ : a Fabric 1.21.1 Minecraft server for Wren (rootless podman)

- Image `docker.io/itzg/minecraft-server:java21` pinned by digest in `start.sh` (`IMAGE`; to update: `podman pull` the tag, read its digest with `podman image inspect --format {{.Digest}}`, edit the line), Minecraft 1.21.1, Fabric loader 0.19.5, mods in `data/mods` (see `MODS.md`).
- Container `wren-mc`. World, configs and mods live in `server/data/` (gitignored).
- Ports: Minecraft `25566` (container 25565), Simple Voice Chat `24454/udp`, wrenvoice mod WebSocket `19520`, BlueMap `8100`.
  By default everything is published on `127.0.0.1` only. To let other machines on your LAN join, first run `./whitelist-mode.sh on` (start.sh refuses `LAN_IP` with the whitelist off, because ONLINE_MODE is off and anyone could join under any name), then `LAN_OFFLINE_ACK=I_UNDERSTAND LAN_IP=<this host's LAN address> ./start.sh` (start.sh refuses `LAN_IP` without that acknowledgement; see the warning below); the BlueMap page is only published on the LAN with `LAN_MAP=1`
  (it also rewrites the voice chat `voice_host`). Re-run start.sh if that address changes.
- **Whitelist is name-only in offline mode.** With `ONLINE_MODE=FALSE` nothing authenticates players: anyone on the LAN who knows or sees a whitelisted name (names appear in chat and the player list) can join as that player, including `Wren` (kicking the real bot) or any op. Do not op anyone and do not give whitelisted names permissions you would not give the whole LAN; treat every device on that LAN as able to act as any listed player. Only set `LAN_OFFLINE_ACK=I_UNDERSTAND` if you accept that.
- `ONLINE_MODE=FALSE` (the bot logs in without a Mojang account) and `ENFORCE_SECURE_PROFILE=FALSE`: anyone who can reach the port can join under ANY name.
  Keep the server on a private network, never expose it to the internet.
- Memory 3G-4G, view-distance 8, simulation-distance 6 (edit start.sh).

## Use
    ./fetch-mods.sh core                  # downloads + sha512-verifies the third-party mods; groups: core voice map replay skins
    ./start.sh                            # idempotent: replaces any old container; first boot 10-30 s
    ./stop.sh                             # graceful stop (saves the world), removes the container; data stays
    ./watchdog.sh start|stop|status       # optional: restart the container if it exits
    podman logs -f wren-mc             # live logs; also data/logs/latest.log
    podman exec wren-mc mc-send-to-console "op <name>"     # console command

Docker instead of podman: replace `podman` with `docker` in the scripts (rootless podman is what was used and tested).

## Whitelist (optional, your choice)
`./whitelist-mode.sh on|off` switches the whitelist (marker `data/.whitelist-mode`, read by start.sh; default off).
With offline mode the console command `whitelist add <name>` asks Mojang and stores the wrong UUID. Use the helper, which writes the correct
offline UUIDs (md5 of `OfflinePlayer:<exact name>`, names are case-sensitive) and reloads the list:

    ./whitelist-set.sh Wren YourPlayerName     # REPLACES the list, so always list everyone, including the bot's name

`data/whitelist.example.json` shows the file format. Your own `whitelist.json` stays in `data/` (gitignored).

## Notes
- `server-ip` is left empty inside the container: setting 127.0.0.1 there would bind the container's loopback and break port forwarding.
  Loopback-only exposure is done on the host side with `-p 127.0.0.1:...`.
- Firewall: if you use `LAN_IP`, open `25566/tcp` and `24454/udp` on the host firewall for your LAN only.
- Test the bot against it: `cd ../bot && MC_HOST=127.0.0.1 WANDER_MS=15000 node smoke.mjs`.

## Minecraft EULA
`start.sh` (and the watchdog, which calls it) refuses to run unless the environment has `MINECRAFT_EULA=accept`. Read https://www.minecraft.net/en-us/eula first: setting the variable means you accept it.

## Live map (BlueMap, optional)
- Install BlueMap with `./fetch-mods.sh map`; open `http://127.0.0.1:8100/` (or `http://<LAN_IP>:8100/` with `LAN_MAP=1`; the page shows live player positions and has no login). The first start downloads the Mojang client jar once into `data/bluemap/`.
- Config: `data/config/bluemap/` (`core.conf`: `accept-download: true`, which downloads Mojang's client jar to your machine: your acceptance, see the Minecraft EULA https://www.minecraft.net/en-us/eula). Apply changes without a restart: `podman exec wren-mc mc-send-to-console "bluemap reload"`.
- Console commands: `bluemap`, `bluemap maps`, `bluemap update world`, `bluemap render world`, `bluemap purge world`, `bluemap pause|resume`.
- The `map-addon/` mod adds Wren's markers and a status panel on top of BlueMap (see `../map-addon`).
