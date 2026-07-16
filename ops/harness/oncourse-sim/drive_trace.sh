#!/usr/bin/env bash
# drive_trace.sh — drive an iOS Simulator's location along the Bethpage Red
# walking trace and screenshot each station for the on-course GPS readiness
# review (specs/oncourse-gps-readiness-plan.md Step 2).
#
# Usage:
#   drive_trace.sh <udid> <waypoints.json> <evidence-dir> [--loss] [--holes 1,2,3]
#
#   <udid>            simctl device UDID, e.g. D4DB2397-D23A-4D55-A049-8E7D4B738E8D
#   <waypoints.json>  fixtures/red-trace-waypoints.json (from extract_red_trace.py)
#   <evidence-dir>    directory to write hN-<station>.png screenshots into
#   --loss            after the normal drive, run `simctl location clear` and
#                      take one more screenshot (hLOSS-clear.png) to capture
#                      the honest from-tee fallback (Step 5's one sim-checkable
#                      loss path).
#   --holes 1,2,3     restrict to a comma-separated list of hole numbers
#                      (default: all holes present in the waypoints file)
#
# Requires: xcrun (Xcode CLT), python3 (stdlib json only), jq is NOT required.
#
# Each station: `simctl location set` -> sleep ~4s (let the Capacitor
# geolocation watch settle) -> `simctl io screenshot`. This is best-effort:
# the Capacitor watch may not fire reliably off simulated location on every
# OS build — if the "You" dot / overlay don't move between screenshots, that
# is a HARNESS limitation, not necessarily an app bug (see README).
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <udid> <waypoints.json> <evidence-dir> [--loss] [--holes 1,2,3]" >&2
  exit 1
fi

UDID="$1"
WAYPOINTS="$2"
EVIDENCE_DIR="$3"
shift 3

DO_LOSS=0
HOLES_FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --loss) DO_LOSS=1; shift ;;
    --holes) HOLES_FILTER="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$EVIDENCE_DIR"

SETTLE_S="${SETTLE_S:-4}"

echo "== drive_trace.sh =="
echo "udid:       $UDID"
echo "waypoints:  $WAYPOINTS"
echo "evidence:   $EVIDENCE_DIR"
echo "holes:      ${HOLES_FILTER:-all}"
echo

# Emit "hole station lat lng" rows (space-separated, one per line) from the
# waypoints JSON, filtered to HOLES_FILTER if given. Stdlib json only.
rows="$(python3 - "$WAYPOINTS" "$HOLES_FILTER" <<'PYEOF'
import json, sys
path, holes_filter = sys.argv[1], sys.argv[2]
wanted = set(int(h) for h in holes_filter.split(",")) if holes_filter else None
with open(path) as f:
    data = json.load(f)
for row in data:
    if wanted is not None and row["hole"] not in wanted:
        continue
    print(f'{row["hole"]} {row["station"]} {row["lat"]} {row["lng"]}')
PYEOF
)"

if [[ -z "$rows" ]]; then
  echo "no waypoints matched (check --holes filter)" >&2
  exit 1
fi

prev_lat=""
prev_lng=""

while IFS=' ' read -r hole station lat lng; do
  [[ -z "$hole" ]] && continue
  label="h${hole}-${station}"
  echo "-> $label  ($lat, $lng)"

  if [[ -n "$prev_lat" ]]; then
    # Simulate a realistic walk from the previous station to this one at
    # ~1.4 m/s (an average walking pace) before settling on the exact point.
    xcrun simctl location "$UDID" start --speed=1.4 "$prev_lat,$prev_lng" "$lat,$lng" >/dev/null 2>&1 || true
  fi
  xcrun simctl location "$UDID" set "$lat,$lng"
  sleep "$SETTLE_S"
  xcrun simctl io "$UDID" screenshot "$EVIDENCE_DIR/${label}.png"

  prev_lat="$lat"
  prev_lng="$lng"
done <<< "$rows"

if [[ "$DO_LOSS" == "1" ]]; then
  echo "-> hLOSS-clear (simctl location clear — GPS loss fallback)"
  xcrun simctl location "$UDID" clear
  sleep "$SETTLE_S"
  xcrun simctl io "$UDID" screenshot "$EVIDENCE_DIR/hLOSS-clear.png"
fi

echo
echo "done. screenshots in $EVIDENCE_DIR"
