#!/usr/bin/env bash
# Smoke-test /api/courses/mapped end-to-end against a real Postgres/PostGIS DB.
#
# Boots a TEMPORARY, auth-bypassed backend on its own port (default 8011, so it
# never clashes with a running prod service on :8000), exercises the full
# create -> list -> get -> nearby -> delete lifecycle, asserts the PostGIS
# geometry round-trips, and tears the temp server down. Writes exactly one test
# course (fixed UUID) and DELETEs it at the end (even on failure).
#
# Usage:
#   # provide the DB directly (must be the +asyncpg driver):
#   DATABASE_URL='postgresql+asyncpg://USER:PASS@HOST:5432/DB' bash scripts/verify_mapped_courses.sh
#
#   # or reuse an existing .env (e.g. the live service's) — the script extracts DATABASE_URL:
#   ENV_FILE=/home/ubuntu/scorecard/backend/.env bash scripts/verify_mapped_courses.sh
#
#   # override the temp port if 8011 is taken:
#   PORT=8021 ENV_FILE=... bash scripts/verify_mapped_courses.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${PORT:-8011}"
BASE="http://127.0.0.1:${PORT}"
CID="ffffffff-aaaa-bbbb-cccc-000000000001"   # fixed test UUID
LOG="/tmp/looper_verify_backend_${PORT}.log"

# Resolve DATABASE_URL: explicit env wins; otherwise extract from ENV_FILE.
if [[ -z "${DATABASE_URL:-}" && -n "${ENV_FILE:-}" && -f "${ENV_FILE}" ]]; then
  line="$(grep -E '^[[:space:]]*DATABASE_URL=' "$ENV_FILE" | tail -1)"
  val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"  # strip quotes
  export DATABASE_URL="$val"
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: no DATABASE_URL. Pass it directly or set ENV_FILE to a .env containing it."; exit 1
fi
case "$DATABASE_URL" in
  postgresql+asyncpg://*) : ;;
  *) echo "ERROR: DATABASE_URL must use the +asyncpg driver (postgresql+asyncpg://...)."; exit 1 ;;
esac

cd "$BACKEND_DIR" || exit 1
echo "→ uv sync"; uv sync >/dev/null 2>&1 || { echo "uv sync failed"; exit 1; }

echo "→ starting temporary backend on :$PORT (auth bypassed, reusing the DB)"
CLERK_JWKS_URL= OWNER_CLERK_USER_ID= ALLOW_ANONYMOUS=1 \
  uv run uvicorn app.main:app --host 127.0.0.1 --port "$PORT" >"$LOG" 2>&1 &
BPID=$!
trap 'kill "$BPID" >/dev/null 2>&1' EXIT

for _ in $(seq 1 40); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
if ! curl -fsS "$BASE/health" >/dev/null 2>&1; then
  echo "FAIL: backend did not come up. Last log lines:"; tail -25 "$LOG"; exit 1
fi
echo "  health OK"

PAYLOAD=$(cat <<JSON
{
  "id": "$CID", "name": "ZZ Verify Course", "address": "Verification St",
  "location": {"lat": 37.7749, "lng": -122.4194},
  "teeSets": [{"name": "Blue", "color": "#2563eb"}],
  "holes": [
    {"number": 1, "par": 4, "handicap": 5, "yardages": {"Blue": 410},
     "features": {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"featureType": "green"},
         "geometry": {"type": "Point", "coordinates": [-122.4194, 37.7749]}}
     ]}}
  ]
}
JSON
)

echo "→ PUT (upsert)";        PUT=$(curl -sS -X PUT "$BASE/api/courses/mapped/$CID" -H 'Content-Type: application/json' -d "$PAYLOAD")
echo "→ GET list";           LIST=$(curl -sS "$BASE/api/courses/mapped?search=ZZ%20Verify")
echo "→ GET by id";          ONE=$(curl -sS "$BASE/api/courses/mapped/$CID")
echo "→ GET nearby";         NEAR=$(curl -sS "$BASE/api/courses/mapped/nearby?lat=37.7749&lng=-122.4194&radiusMeters=20000")
echo "→ DELETE";             DEL=$(curl -sS -X DELETE "$BASE/api/courses/mapped/$CID")
echo "→ GET after delete";   GONE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/courses/mapped/$CID")

python3 - "$CID" "$PUT" "$LIST" "$ONE" "$NEAR" "$DEL" "$GONE" <<'PY'
import json, sys
cid, put, lst, one, near, dele, gone = sys.argv[1:8]
ok = True
def check(name, cond, extra=""):
    global ok
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {extra}" if extra and not cond else ""))
    ok = ok and cond
def loads(s):
    try: return json.loads(s)
    except Exception as e: return {"__parse_error__": str(e), "__raw__": s[:300]}

p = loads(put); c = p.get("course") or {}
check("PUT returns course", bool(c), put[:200])
check("PUT course id matches", c.get("id") == cid)
check("PUT fills 18 holes", len(c.get("holes", [])) == 18, f"got {len(c.get('holes', []))}")
h1 = (c.get("holes") or [{}])[0]
check("PUT hole1 yardage Blue=410", (h1.get("yardages") or {}).get("Blue") == 410, str(h1.get("yardages")))
feats = (h1.get("features") or {}).get("features") or []
geom = (feats[0].get("geometry") if feats else {}) or {}
check("PUT green geometry round-trips (Point)", geom.get("type") == "Point", str(geom))
coords = geom.get("coordinates") or []
check("PUT green coords ~ (-122.4194, 37.7749)",
      len(coords) == 2 and abs(coords[0] + 122.4194) < 1e-4 and abs(coords[1] - 37.7749) < 1e-4, str(coords))
check("PUT location set", bool((c.get("location") or {}).get("lat") and (c.get("location") or {}).get("lng")), str(c.get("location")))

l = loads(lst); lcourses = l.get("courses") or []
check("LIST contains the course", any(x.get("id") == cid for x in lcourses), f"{len(lcourses)} returned")
match = next((x for x in lcourses if x.get("id") == cid), {})
check("LIST item has location", bool(match.get("location")), str(match))

o = loads(one)
check("GET by id returns course", (o.get("course") or {}).get("id") == cid, one[:200])

n = loads(near); ncourses = n.get("courses") or []
check("NEARBY contains the course", any(x.get("id") == cid for x in ncourses), f"{len(ncourses)} returned")

d = loads(dele)
check("DELETE returns ok", d.get("ok") is True, dele[:200])
check("GET after delete is 404", gone == "404", f"got {gone}")

print(); print("RESULT:", "ALL PASS ✅" if ok else "SOME FAILED ❌")
sys.exit(0 if ok else 2)
PY
RC=$?
echo "(temp backend log: $LOG)"
exit $RC
