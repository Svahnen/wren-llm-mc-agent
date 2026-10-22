#!/usr/bin/env bash
# Download the third-party Fabric mods listed in mods.lock from Modrinth (https://modrinth.com) into data/mods and verify their sha512.
# Usage: ./fetch-mods.sh [group ...]     groups: core voice map replay skins   (default: core)
#        ./fetch-mods.sh --list          print the table and exit
# The jars are NOT part of this repository: each mod has its own licence (read it on its Modrinth page).
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = "--list" ]; then column -t -s'|' "$D/mods.lock"; exit 0; fi
WANT_GROUPS=("$@"); [ ${#WANT_GROUPS[@]} -eq 0 ] && WANT_GROUPS=(core)
mkdir -p "$D/data/mods"
grep -v '^#' "$D/mods.lock" | while IFS='|' read -r slug grp file sha; do
  want=0; for g in "${WANT_GROUPS[@]}"; do [ "$g" = "$grp" ] && want=1; done
  [ $want -eq 1 ] || continue
  if [ -f "$D/data/mods/$file" ] && [ "$(sha512sum "$D/data/mods/$file" | cut -d' ' -f1)" = "$sha" ]; then echo "ok (already there): $file"; continue; fi
  url=$(timeout 60 curl -fsS -A "Svahnen-wren-llm-mc-agent/0.1.0 (https://github.com/Svahnen/wren-llm-mc-agent)" "https://api.modrinth.com/v2/project/$slug/version" | python3 -I -c "
import sys, json
f = sys.argv[1]
for v in json.load(sys.stdin):
    for x in v['files']:
        if x['filename'] == f:
            print(x['url']); sys.exit(0)
sys.exit(1)" "$file") || { echo "FAILED: $file not found on Modrinth project $slug" >&2; exit 1; }
  timeout 300 curl -fsSL -A "Svahnen-wren-llm-mc-agent/0.1.0 (https://github.com/Svahnen/wren-llm-mc-agent)" -o "$D/data/mods/$file.part" "$url"
  got=$(sha512sum "$D/data/mods/$file.part" | cut -d' ' -f1)
  if [ "$got" != "$sha" ]; then rm -f "$D/data/mods/$file.part"; echo "SHA512 MISMATCH for $file; refusing" >&2; exit 1; fi
  mv "$D/data/mods/$file.part" "$D/data/mods/$file"; echo "downloaded + verified: $file"
done
