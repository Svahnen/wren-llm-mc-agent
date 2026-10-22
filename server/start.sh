#!/bin/bash
# Rootless podman Minecraft server (Fabric 1.21.1) for the Wren bot. Idempotent: any old container is replaced.
# Binds to loopback by default. To let other machines on your LAN join, turn the whitelist on first (./whitelist-mode.sh on), then:  LAN_OFFLINE_ACK=I_UNDERSTAND LAN_IP=<your-lan-ip> ./start.sh
# WARNING: offline mode = the whitelist only checks names; anyone on the LAN can join as any whitelisted player (see server/README.md). Do not op anyone.   (add LAN_MAP=1 to also publish the BlueMap page)
# Requires MINECRAFT_EULA=accept (you accept https://www.minecraft.net/en-us/eula yourself).
# Container wren-mc, MC port 25566, voice UDP 24454, BlueMap 8100.
set -euo pipefail
# The Minecraft server software is subject to the Minecraft EULA. Accepting it is YOUR decision, not this script's.
[ "${MINECRAFT_EULA:-}" = "accept" ] || { echo "Read https://www.minecraft.net/en-us/eula and rerun with MINECRAFT_EULA=accept to agree to it." >&2; exit 1; }
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$PROJECT_DIR/data"
# Serialise start/stop/watchdog (watchdog sets LOCK_HELD=1 because it already holds the lock).
if [ -z "${LOCK_HELD:-}" ]; then exec 9>"$PROJECT_DIR/.lifecycle.lock"; flock -w 180 9; fi
rm -f "$PROJECT_DIR/.intentional-stop"   # a start clears the intentional-stop marker (see watchdog.sh)
NAME="wren-mc"
# Pinned by digest (reproducible, no silent image change). To update: pull the tag, read the new digest, edit this line.
IMAGE="docker.io/itzg/minecraft-server:java21@sha256:d3678c0711702eb3d4b3ff2e890502f0b008c1778ddb2db9c01e8f3dde01c853"
# Whitelist on/off is your choice: ./whitelist-mode.sh on|off (marker file data/.whitelist-mode, default off). Note: ONLINE_MODE=FALSE below
# (the bot logs in without a Mojang account), so anyone who can reach the port can join under ANY name. Do not expose it to the internet.
WL_FLAG=FALSE; [ "$(cat "$DATA_DIR/.whitelist-mode" 2>/dev/null)" = on ] && WL_FLAG=TRUE

LAN_IP="${LAN_IP:-}"          # empty = loopback only
PUB=()
if [ -n "$LAN_IP" ]; then
  # ONLINE_MODE is off: on a LAN anyone could join under any name (incl. an op). Refuse unless the whitelist is on.
  [ "$WL_FLAG" = TRUE ] || { echo "LAN_IP is set but the whitelist is off. Run ./whitelist-mode.sh on first (offline-mode server: anyone on the LAN could join as any name)." >&2; exit 1; }
  # The whitelist only filters NAMES. With ONLINE_MODE=FALSE there is no authentication at all: anyone on the LAN who knows a whitelisted name
  # (names show in chat and the player list) can join AS that player, including Wren or an op. Require an explicit acknowledgement.
  [ "${LAN_OFFLINE_ACK:-}" = "I_UNDERSTAND" ] || { cat >&2 <<'MSG'
LAN_IP is set, but this server runs in OFFLINE mode (ONLINE_MODE=FALSE, the bot has no Mojang account). The whitelist only checks the player NAME:
anyone on that LAN who knows a whitelisted name can join as that player (also as Wren, or as an op). Do not op anyone, and treat every device on that
network as able to act as any listed player. If you understand and accept this, rerun with LAN_OFFLINE_ACK=I_UNDERSTAND. Refusing to start.
MSG
    exit 1; }
  echo "WARNING: LAN exposure of an offline-mode server: the whitelist is name-only; anyone on $LAN_IP's network can act as a whitelisted player." >&2
  PUB=(-p "$LAN_IP":25566:25565 -p "$LAN_IP":24454:24454/udp)
  # The BlueMap web page (live player positions, no login) is only published on the LAN with LAN_MAP=1.
  [ "${LAN_MAP:-0}" = 1 ] && PUB+=(-p "$LAN_IP":8100:8100)
fi
VOICE_HOST="${LAN_IP:-127.0.0.1}"

# SVC tells clients where to send voice UDP: must be the LAN address (kept in sync on every start).
VC="$DATA_DIR/config/voicechat/voicechat-server.properties"
[ -f "$VC" ] && sed -i "s|^voice_host=.*|voice_host=$VOICE_HOST:24454|" "$VC"

# Voice bridge mod (wrenvoice): inside the container it must listen on 0.0.0.0 (the host-side -p 127.0.0.1:19520 publish below keeps it
# loopback-only). Written once, only if absent; the mod fills in the rest and generates the shared secret on first start.
VMC="$DATA_DIR/config/wrenvoice.json"
[ -f "$VMC" ] || { mkdir -p "$DATA_DIR/config"; ( umask 077; echo '{"bindAddress":"0.0.0.0"}' > "$VMC" ); }
chmod 600 "$VMC" 2>/dev/null || true   # it will hold the shared secret of the voice bridge

podman stop -t 60 "$NAME" 2>/dev/null || true
podman rm "$NAME" 2>/dev/null || true

# server-ip is NOT set inside the container (it would bind the container loopback
# and break port forwarding). Loopback-only exposure is done by the host-side -p 127.0.0.1:... binds.
podman run -d -it \
  --restart=on-failure:5 \
  --name "$NAME" \
  "${PUB[@]}" \
  -p 127.0.0.1:25566:25565 \
  -p 127.0.0.1:24454:24454/udp \
  -p 127.0.0.1:19520:19520 \
  -p 127.0.0.1:8100:8100 \
  -e EULA=TRUE \
  -e TYPE=FABRIC \
  -e VERSION=1.21.1 \
  -e FABRIC_LOADER_VERSION=0.19.5 \
  -e INIT_MEMORY=3G -e MAX_MEMORY=4G \
  -e MOTD="Wren test server" \
  -e ONLINE_MODE=FALSE \
  -e ENFORCE_SECURE_PROFILE=FALSE \
  -e ENABLE_WHITELIST=$WL_FLAG \
  -e ENFORCE_WHITELIST=$WL_FLAG \
  -e CREATE_CONSOLE_IN_PIPE=true \
  -e ENABLE_RCON=FALSE \
  -e ENABLE_QUERY=FALSE \
  -e OP_PERMISSION_LEVEL=2 \
  -e SPAWN_PROTECTION=0 \
  -e VIEW_DISTANCE=8 \
  -e SIMULATION_DISTANCE=6 \
  -v "$DATA_DIR":/data:Z \
  --userns=keep-id \
  "$IMAGE"

echo "Started $NAME on ${LAN_IP:-127.0.0.1}:25566 (voice ${LAN_IP:-127.0.0.1}:24454/udp). Follow logs: podman logs -f $NAME"
echo "Wait for 'Done' with: until podman logs $NAME 2>&1 | grep -q 'For help, type'; do sleep 2; done"
