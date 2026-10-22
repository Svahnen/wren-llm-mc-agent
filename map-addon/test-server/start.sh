#!/bin/bash
# THROWAWAY test server: container wren-maptest, MC 127.0.0.1:25573, BlueMap web 127.0.0.1:8101.
set -euo pipefail
[ "${MINECRAFT_EULA:-}" = "accept" ] || { echo "Read https://www.minecraft.net/en-us/eula and rerun with MINECRAFT_EULA=accept to agree to it." >&2; exit 1; }
cd "$(dirname "$0")"
timeout 60 podman run -d -it --name wren-maptest \
  -p 127.0.0.1:25573:25565 -p 127.0.0.1:8101:8100 \
  -e EULA=TRUE -e TYPE=FABRIC -e VERSION=1.21.1 -e FABRIC_LOADER_VERSION=0.19.5 \
  -e INIT_MEMORY=1G -e MAX_MEMORY=2G -e ONLINE_MODE=FALSE -e ENFORCE_SECURE_PROFILE=FALSE \
  -e ENABLE_WHITELIST=FALSE -e CREATE_CONSOLE_IN_PIPE=true -e VIEW_DISTANCE=4 -e SIMULATION_DISTANCE=4 \
  -e LEVEL_TYPE=flat -e SPAWN_PROTECTION=0 -e SPAWN_MONSTERS=FALSE -e MODE=creative \
  -v "$PWD/data":/data:Z --userns=keep-id docker.io/itzg/minecraft-server:java21@sha256:d3678c0711702eb3d4b3ff2e890502f0b008c1778ddb2db9c01e8f3dde01c853
