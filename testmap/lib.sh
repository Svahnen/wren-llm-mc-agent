# shared helpers (sourced). Console method: podman exec wren-mc mc-send-to-console "<cmd>" (see server/README.md)
CT="${MC_CONTAINER:-wren-mc}"
TM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN() { python3 -I "$TM_DIR/trapgen.py" "$@"; }
need_server() {
  podman ps --format '{{.Names}}' | grep -qx "$CT" || { echo "container $CT not running (server/start.sh)" >&2; exit 1; }
  [ "$CT" = "wren-mc" ] || { echo "refusing: only the test server container wren-mc" >&2; exit 1; }
}
send() { podman exec "$CT" mc-send-to-console "$1"; }
# stdin: one console command per line
send_stdin() { podman exec -i "$CT" bash -c 'while IFS= read -r l; do mc-send-to-console "$l"; done'; }
# wait_token TOKEN [seconds]: wait until the log shows "TOKEN" (from a `say`); echo the matching log lines
wait_token() {
  local tok="$1" n="${2:-30}" i
  for ((i=0;i<n*2;i++)); do
    podman logs --since 10m "$CT" 2>&1 | grep -q "$tok DONE_ALL" && return 0
    sleep 0.5
  done
  return 1
}
