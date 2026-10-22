#!/bin/bash
# Usage: whitelist-set.sh Name [Name...]
# Rewrites data/whitelist.json with OFFLINE UUIDs (md5 "OfflinePlayer:<exact name>"), then reloads
# the whitelist if the container is running. Reason: the console `whitelist add` asks Mojang first, so for
# a real account name (e.g. Wren) it stores the REAL online UUID, and for unknown names it stores the offline
# UUID of the LOWERCASED name; both fail to match an offline-mode login. Names are case-sensitive here.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
python3 -I - "$DIR/data/whitelist.json" "$@" <<'PY'
import hashlib, json, sys, uuid
path, names = sys.argv[1], sys.argv[2:]
out = []
for n in names:
    h = bytearray(hashlib.md5(("OfflinePlayer:" + n).encode()).digest())
    h[6] = h[6] & 0x0F | 0x30
    h[8] = h[8] & 0x3F | 0x80
    out.append({"uuid": str(uuid.UUID(bytes=bytes(h))), "name": n})
json.dump(out, open(path, "w"), indent=2)
print(json.dumps(out, indent=2))
PY
podman exec wren-mc mc-send-to-console "whitelist reload" 2>/dev/null && echo "reloaded" || echo "(container not running; applies on next start)"
