#!/usr/bin/env python3
"""coverage_flywheel.py — S4f coverage flywheel: report / sweep / canary
(specs/teetime-s4f-coverage-flywheel-plan.md §3, §4c, §5, §6).

Sibling to `probe_booking_capability.py` (imports its pipeline; does NOT
retrofit subcommands into that script — plan §6: its CLI has `--name` as a
required top-level arg and documented exact invocations, so a sibling keeps
it byte-identical while reusing 100% of its pipeline code). Hand-run only:
never imported by tests, never run in CI (same convention as every script in
this directory).

Subcommands
-----------
  report   Print the coverage metric (coverage %, strict %, breakdown) and
            the probe-feed queue (`no_capability` courses, highest search
            count first) with a ready-to-paste probe_booking_capability.py
            command per row. Reads `search_telemetry.json` only — no
            network, no writes, safe to run anytime.
  sweep    Re-probes the demand-driven queue (telemetry rows whose
            `latest_outcome == "no_capability"`) PLUS a staleness pass over
            `booking_capabilities_validated.json` (`probe_status in
            {"stale","failed"}` or `verified_at` older than `--stale-days`),
            through the EXISTING `probe_booking_capability.py` pipeline
            (`fingerprint_website` -> `probe_foreup`/`probe_teeitup`/
            `probe_chronogolf` -> `_build_record`/`_upsert_record`). Seed
            rows are NEVER touched. `--dry-run` prints intended probes and
            makes zero network calls.
  canary   ONE live fetch per engine against a curated known-good course
            (the seed row carrying `"canary": true`, else the first
            `probe_status == "verified"` seed row for that platform), diffed
            via `schema_canary.check_shape`. Prints `PASS` / `DRIFT(<reason>)`
            / `SKIP(<why>)` per engine; exit code 1 if ANY engine drifted
            (cron-friendly). Report-only: mutates no store, no capability row.

BRIGHT LINES (restated, enforced by construction — never weaken):
  - No CAPTCHA solving, no fingerprint/UA spoofing, no login — all inherited
    from `probe_booking_capability.py`'s pipeline, which has none of these.
  - GolfAPI and Google Places are NEVER imported here — this file imports
    nothing from `app.services.golfapi*` or `app.services.course_finder`.
    The sweep never falls back to a Places lookup for a website-less course;
    it either has a phone (writes a `phone_only` row, same as the probe
    script's own fallback) or is skipped with an honest note.
  - Politeness: sequential (never concurrent), `asyncio.sleep(6)` between
    courses/engines (<=10 rpm global), every fetch inherits
    `fetch_discipline`'s honest UA + 8s timeout via the adapters' own
    request builders / the probe pipeline — never a bespoke fetch here.

Suggested cadence (ops/owner decision, not enforced by this script):
`report` any time; `sweep` and `canary` monthly, by hand or a scheduled cron
job — mirrors the parent plan's "re-probe cadence: breaker feedback + a
monthly manual sweep, never re-probe per search" (specs/teetime-availability
-everywhere-plan.md §2b).

Usage
-----
    uv run backend/scripts/coverage_flywheel.py report
    uv run backend/scripts/coverage_flywheel.py report --json
    uv run backend/scripts/coverage_flywheel.py sweep --dry-run
    uv run backend/scripts/coverage_flywheel.py sweep --limit 5 --stale-days 30
    uv run backend/scripts/coverage_flywheel.py canary
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as _dt
import json
import sys
from pathlib import Path

# Make `app` importable, then make this script's sibling `probe_booking_
# capability.py` importable too (same two-step every script in this
# directory that imports another script needs).
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent))

import httpx  # noqa: E402

import probe_booking_capability as probe  # noqa: E402
from app.services.tee_times.adapters.chronogolf import (  # noqa: E402
    build_times_request as chronogolf_times_request,
)
from app.services.tee_times.adapters.clubprophet import ClubProphetProvider  # noqa: E402
from app.services.tee_times.adapters.quick18 import (  # noqa: E402
    _searchmatrix_url as quick18_searchmatrix_url,
)
from app.services.tee_times.adapters.teeitup import (  # noqa: E402
    build_times_request as teeitup_times_request,
)
from app.services.tee_times.base import TeeTimeQuery  # noqa: E402
from app.services.tee_times.capability_store import (  # noqa: E402
    GENERALIZED_SEED_PATH,
    MATCH_RADIUS_MILES,
    SEED_PATH,
    CourseBookingCapability,
    _haversine_miles,
    _parse_generalized_row,
)
from app.services.tee_times.fetch_discipline import USER_AGENT  # noqa: E402
from app.services.tee_times.foreup import (  # noqa: E402
    build_times_request as foreup_times_request,
)
from app.services.tee_times.private_filter import normalize  # noqa: E402
from app.services.tee_times.router_provider import ADAPTERS  # noqa: E402
from app.services.tee_times.schema_canary import check_shape  # noqa: E402
from app.services.tee_times.search_cache import SearchCacheStore  # noqa: E402
from app.services.tee_times.search_telemetry import (  # noqa: E402
    FileSearchTelemetryStore,
    SearchedCourseRecord,
    coverage_summary,
    total_searches,
)

_DATA_DIR = Path(__file__).parent.parent / "data"
_VALIDATED_PATH = _DATA_DIR / "booking_capabilities_validated.json"

_SLEEP_S = 6.0             # <=10 rpm global politeness bound (plan §5.2/§4c)
_REQUEST_TIMEOUT_S = 8.0


# ─── report ──────────────────────────────────────────────────────────────────

def _coalesce_no_capability(records: tuple[SearchedCourseRecord, ...]) -> list[dict]:
    """Report-side (not store-side) coalescing of name-variant duplicates
    (plan §3): rows whose `private_filter.normalize(name)` match AND
    haversine <= MATCH_RADIUS_MILES are folded, counts summed. Display
    concern only — the store itself stays keyed by `course_id`."""
    groups: list[dict] = []
    for rec in records:
        norm_name = normalize(rec.name)
        placed = False
        if norm_name and rec.lat is not None and rec.lng is not None:
            for g in groups:
                if (
                    g["_norm_name"] == norm_name
                    and g["lat"] is not None and g["lng"] is not None
                    and _haversine_miles(rec.lat, rec.lng, g["lat"], g["lng"]) <= MATCH_RADIUS_MILES
                ):
                    g["searches"] += total_searches(rec)
                    placed = True
                    break
        if not placed:
            groups.append({
                "_norm_name": norm_name,
                "name": rec.name,
                "lat": rec.lat,
                "lng": rec.lng,
                "website": rec.website,
                "phone": rec.phone,
                "searches": total_searches(rec),
            })
    groups.sort(key=lambda g: -g["searches"])
    return groups


def _probe_command(row: dict) -> str:
    parts = ["uv run backend/scripts/probe_booking_capability.py", f'--name "{row["name"]}"']
    if row["lat"] is not None and row["lng"] is not None:
        parts.append(f'--lat {row["lat"]} --lng {row["lng"]}')
    else:
        parts.append("--lat <?> --lng <?>   # unknown — fill in before running")
    if row["website"]:
        parts.append(f'--website {row["website"]}')
    if row["phone"]:
        parts.append(f'--phone "{row["phone"]}"')
    parts.append("--dry-run")
    return " ".join(parts)


def _cmd_report(args: argparse.Namespace) -> int:
    store = FileSearchTelemetryStore()
    records = store.all_records()
    summary = coverage_summary(records)
    queue = _coalesce_no_capability(summary.no_capability_courses)

    if args.json:
        print(json.dumps({
            "total_courses": summary.total_courses,
            "denominator": summary.denominator,
            "coverage_pct": summary.coverage_pct,
            "strict_pct": summary.strict_pct,
            "coverage_count": summary.coverage_count,
            "strict_count": summary.strict_count,
            "outcome_breakdown": summary.outcome_breakdown,
            "couldnt_check_by_platform": summary.couldnt_check_by_platform,
            "probe_feed_queue": [
                {k: v for k, v in row.items() if not k.startswith("_")} for row in queue
            ],
        }, indent=2))
        return 0

    print("Coverage flywheel report")
    print("=========================")
    print(
        "NOTE: this counts searches the router actually executed against a "
        "provider — a search served from the 15-min route-level search cache "
        "never reaches this telemetry (honest undercount of raw searches, "
        "NOT of distinct-course coverage)."
    )
    print()
    print(f"distinct courses searched: {summary.total_courses}")
    print(f"denominator (excludes private): {summary.denominator}")
    if summary.coverage_pct is None:
        print("coverage %: n/a (no searches recorded yet)")
        print("strict %:   n/a")
    else:
        print(
            f"coverage % (real_availability + verified_empty): "
            f"{summary.coverage_pct:.1f}%  ({summary.coverage_count}/{summary.denominator})"
        )
        print(
            f"strict %   (real_availability only):             "
            f"{summary.strict_pct:.1f}%  ({summary.strict_count}/{summary.denominator})"
        )

    print()
    print("outcome breakdown (incl. private):")
    if not summary.outcome_breakdown:
        print("  (no searches recorded yet)")
    for outcome, count in sorted(summary.outcome_breakdown.items(), key=lambda kv: -kv[1]):
        print(f"  {outcome:<18} {count}")

    if summary.couldnt_check_by_platform:
        print()
        print("couldn't-check, by platform:")
        for platform, count in sorted(summary.couldnt_check_by_platform.items(), key=lambda kv: -kv[1]):
            print(f"  {platform:<18} {count}")

    print()
    print(f"probe-feed queue ({len(queue)} distinct course(s), highest demand first):")
    if not queue:
        print("  (empty)")
    for row in queue[: args.top]:
        print(f"  - {row['name']} — {row['searches']} search(es)")
        print(f"      {_probe_command(row)}")
    return 0


# ─── sweep ───────────────────────────────────────────────────────────────────

def _is_stale(row: dict, stale_days: int) -> bool:
    if row.get("probe_status") in ("stale", "failed"):
        return True
    verified_at = row.get("verified_at") or ""
    try:
        verified_dt = _dt.datetime.strptime(verified_at, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=_dt.timezone.utc
        )
    except ValueError:
        return True  # unparsable timestamp — treat as stale, never silently skip
    return (_dt.datetime.now(_dt.timezone.utc) - verified_dt).days >= stale_days


def _build_sweep_queue(*, stale_days: int, limit: int) -> list[dict]:
    """Demand-driven queue (`no_capability` telemetry, highest search count
    first) PLUS a staleness pass over the VALIDATED capability file. Seed
    rows are NEVER touched (plan §5.1)."""
    store = FileSearchTelemetryStore()
    coalesced = _coalesce_no_capability(coverage_summary(store.all_records()).no_capability_courses)

    queue: list[dict] = []
    seen_names: set[str] = set()
    for row in coalesced:
        queue.append({
            "name": row["name"], "lat": row["lat"], "lng": row["lng"],
            "website": row["website"], "phone": row["phone"], "reason": "no_capability",
        })
        seen_names.add(normalize(row["name"]))

    validated = probe._load_courses(_VALIDATED_PATH)
    for row in validated.get("courses", []):
        name = row.get("name") or ""
        if normalize(name) in seen_names:
            continue
        if _is_stale(row, stale_days):
            queue.append({
                "name": name, "lat": row.get("lat"), "lng": row.get("lng"),
                "website": row.get("booking_url"), "phone": row.get("phone"), "reason": "stale",
            })
            seen_names.add(normalize(name))

    return queue[:limit]


def _record_from_probe_response(
    platform: str, ids: dict, resp: httpx.Response | None, row: dict,
) -> dict | None:
    if row["lat"] is None or row["lng"] is None:
        print("  lat/lng unknown — cannot write a capability row (needs a hand probe with --lat/--lng)")
        return None
    if resp is None or resp.status_code != 200:
        probe_status = "failed"
    else:
        try:
            entries = resp.json()
        except Exception:
            entries = None
        probe_status = "verified" if isinstance(entries, list) else "failed"

    channel = "api" if platform in ("foreup", "teeitup") else "scrape_http"
    booking_url = row["website"]
    if platform == "foreup":
        booking_url = (
            f"https://foreupsoftware.com/index.php/booking/"
            f"{ids.get('booking_id')}/{ids.get('schedule_id')}"
        )
    return probe._build_record(
        platform=platform, channel=channel, platform_ids=ids, name=row["name"],
        lat=row["lat"], lng=row["lng"], phone=row["phone"], booking_url=booking_url,
        probe_status=probe_status,
    )


async def _run_sweep(args: argparse.Namespace) -> int:
    queue = _build_sweep_queue(stale_days=args.stale_days, limit=args.limit)
    if not queue:
        print("sweep: queue is empty — nothing to probe")
        return 0

    date_str = probe._default_date()
    validated_data = probe._load_courses(_VALIDATED_PATH)
    probed = 0

    for i, row in enumerate(queue):
        print(f"[{i + 1}/{len(queue)}] {row['name']} (reason={row['reason']})")

        if not row["website"] and not row["phone"]:
            print("  skip: no website, no phone — nothing to fingerprint (no Google Places lookup, ever)")
            continue

        if not row["website"]:
            # Website-less but phone-known -> the probe script's own
            # phone_only fallback treatment (plan §5.2).
            print("  no website, phone known -> phone_only row")
            if not args.dry_run and row["lat"] is not None and row["lng"] is not None:
                record = probe._build_record(
                    platform="phone_only", channel="call", platform_ids={},
                    name=row["name"], lat=row["lat"], lng=row["lng"], phone=row["phone"],
                    booking_url=None, probe_status="verified",
                )
                validated_data = probe._upsert_record(validated_data, record)
            probed += 1
            if i < len(queue) - 1:
                await asyncio.sleep(_SLEEP_S)
            continue

        if args.dry_run:
            print(f"  would fingerprint {row['website']} and probe (dry-run — no network, nothing written)")
            if i < len(queue) - 1:
                await asyncio.sleep(_SLEEP_S)
            continue

        fp = await probe.fingerprint_website(row["website"])
        if fp is None:
            print("  no known booking engine detected — skipping")
        elif fp.platform == "foreup":
            ids, resp = await probe.probe_foreup(fp, date=date_str, players=1)
            record = _record_from_probe_response("foreup", ids, resp, row)
            if record is not None:
                validated_data = probe._upsert_record(validated_data, record)
        elif fp.platform == "teeitup":
            ids, resp = await probe.probe_teeitup(fp, date=date_str, facility_id=None)
            record = _record_from_probe_response("teeitup", ids, resp, row)
            if record is not None:
                validated_data = probe._upsert_record(validated_data, record)
        elif fp.platform == "chronogolf":
            ids, resp, _club = await probe.probe_chronogolf(fp, date=date_str, course_hint=None)
            record = _record_from_probe_response("chronogolf", ids, resp, row)
            if record is not None:
                validated_data = probe._upsert_record(validated_data, record)
        else:
            print(f"  fingerprinted platform={fp.platform!r} has no probe implementation yet — skipping")

        probed += 1
        if i < len(queue) - 1:
            await asyncio.sleep(_SLEEP_S)

    if not args.dry_run:
        _VALIDATED_PATH.parent.mkdir(parents=True, exist_ok=True)
        _VALIDATED_PATH.write_text(json.dumps(validated_data, indent=2) + "\n")
        print(f"\nwrote {_VALIDATED_PATH}")

    print(f"\nsweep complete: probed {probed}/{len(queue)} course(s)")
    return 0


# ─── canary ──────────────────────────────────────────────────────────────────

class _NoopCache(SearchCacheStore):
    """In-memory no-op cache — forces the canary's ONE clubprophet fetch to
    actually hit the network rather than silently reading a stale cached
    day, without ever writing to `backend/data/`."""

    def get(self, key: str):
        return None

    def set(self, key: str, results: list[dict]) -> None:
        pass


def _load_raw_seed_rows() -> list[dict]:
    rows: list[dict] = []
    for path in (SEED_PATH, GENERALIZED_SEED_PATH):
        try:
            raw = json.loads(path.read_text())
            rows.extend(raw.get("courses", []))
        except Exception:
            continue
    return rows


def _select_canary_row(platform: str) -> dict | None:
    """Selection rule (plan §4c): the seed row carrying `"canary": true`,
    else the first `probe_status == "verified"` seed row for the platform.
    Reads the checked-in seed files directly (never the script-appended
    validated file) — a canary target is always curated, never guessed."""
    rows = [r for r in _load_raw_seed_rows() if r.get("platform") == platform]
    marked = [r for r in rows if r.get("canary") is True]
    if marked:
        return marked[0]
    verified = [r for r in rows if r.get("probe_status", "verified") == "verified"]
    return verified[0] if verified else None


def _select_canary_cap(platform: str) -> CourseBookingCapability | None:
    row = _select_canary_row(platform)
    if row is None:
        return None
    return _parse_generalized_row(row)   # handles both the legacy flat foreup
                                          # shape and the generalized shape.


async def _canary_one_engine(platform: str, date_str: str) -> tuple[bool, str]:
    """Returns (healthy, message) — `healthy=True` for both a real PASS and
    a SKIP (no seed row yet), so an unseeded engine never fails the run."""
    cap = _select_canary_cap(platform)
    if cap is None:
        return True, "SKIP (no canary-eligible seed row for this engine yet)"

    try:
        if platform == "foreup":
            date_mmddyyyy = _dt.datetime.strptime(date_str, "%Y-%m-%d").strftime("%m-%d-%Y")
            url, params, headers = foreup_times_request(cap.foreup_booking_id or "", date_mmddyyyy, 1)
            async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_S) as client:
                resp = await client.get(url, params=params, headers=headers)
            if resp.status_code != 200:
                return False, f"DRIFT(http-{resp.status_code})"
            result = check_shape("foreup", resp.content, query_date=date_str, party_size=1, expect_nonempty=True)

        elif platform == "teeitup":
            alias = cap.platform_ids.get("alias", "")
            facility_id = cap.platform_ids.get("facility_id", "")
            url, params, headers = teeitup_times_request(alias, facility_id, date_str)
            async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_S) as client:
                resp = await client.get(url, params=params, headers=headers)
            if resp.status_code != 200:
                return False, f"DRIFT(http-{resp.status_code})"
            result = check_shape("teeitup", resp.content, query_date=date_str, party_size=1, expect_nonempty=True)

        elif platform == "chronogolf":
            club_id = cap.platform_ids.get("club_id", "")
            course_id = cap.platform_ids.get("course_id", "")
            affiliation_type_id = cap.platform_ids.get("affiliation_type_id", "")
            url, params, headers = chronogolf_times_request(club_id, course_id, affiliation_type_id, date_str)
            async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_S) as client:
                resp = await client.get(url, params=params, headers=headers)
            if resp.status_code != 200:
                return False, f"DRIFT(http-{resp.status_code})"
            result = check_shape("chronogolf", resp.content, query_date=date_str, party_size=1, expect_nonempty=True)

        elif platform == "quick18":
            host = cap.platform_ids.get("host", "")
            url = quick18_searchmatrix_url(host, date_str)
            headers = {"User-Agent": USER_AGENT, "Accept": "text/html"}
            async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_S, follow_redirects=False) as client:
                resp = await client.get(url, headers=headers)
            if resp.status_code != 200:
                return False, f"DRIFT(http-{resp.status_code})"
            result = check_shape("quick18", resp.content, query_date=date_str, party_size=1, expect_nonempty=True)

        elif platform == "clubprophet":
            # The three-step token dance is NOT duplicated here — call the
            # real provider end-to-end (plan §4c) and treat `None` as
            # "couldn't check": honest, lower resolution, no logic
            # duplication of the token/transaction-id handshake.
            cp = ClubProphetProvider(cache=_NoopCache())
            query = TeeTimeQuery(
                date=date_str, time_window_start="00:00", time_window_end="23:59", party_size=1,
            )
            slots = await cp.slots_for_capability(cap, query, distance_miles=0.0)
            if slots is None:
                return False, "DRIFT(clubprophet: couldn't check — drift or transient, inspect)"
            return True, f"PASS (entries={len(slots)})"

        else:
            return True, "SKIP (no live canary implementation for this engine)"

    except (httpx.TimeoutException, httpx.TransportError) as exc:
        return False, f"DRIFT(request-error: {exc!r})"
    except Exception as exc:  # never raise out of a canary leg
        return False, f"DRIFT(unexpected: {exc!r})"

    if result.healthy:
        return True, f"PASS (entries={result.entries})"
    return False, f"DRIFT({result.reason})"


async def _run_canary(_args: argparse.Namespace) -> int:
    date_str = probe._default_date()
    engines = list(ADAPTERS.keys())
    any_drift = False
    for i, platform in enumerate(engines):
        healthy, message = await _canary_one_engine(platform, date_str)
        print(f"{platform:<12} {message}")
        if not healthy:
            any_drift = True
        if i < len(engines) - 1:
            await asyncio.sleep(_SLEEP_S)
    return 1 if any_drift else 0


# ─── CLI ─────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="S4f coverage flywheel: coverage report / re-probe sweep / schema-drift canary."
    )
    sub = p.add_subparsers(dest="command", required=True)

    report = sub.add_parser("report", help="Print the coverage metric + probe-feed queue (no network)")
    report.add_argument("--json", action="store_true", help="Machine-readable JSON output")
    report.add_argument("--top", type=int, default=20, help="Max probe-feed queue rows to print (default 20)")

    sweep = sub.add_parser("sweep", help="Re-probe the demand-driven queue + stale validated rows")
    sweep.add_argument("--limit", type=int, default=10, help="Max courses to probe this run (default 10)")
    sweep.add_argument("--stale-days", type=int, default=30, help="Validated-row staleness threshold (default 30)")
    sweep.add_argument("--dry-run", action="store_true", help="Print intended probes; make no network calls, write nothing")

    sub.add_parser("canary", help="One live fetch per engine against a known-good course; exit 1 on any drift")

    return p


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()
    if args.command == "report":
        sys.exit(_cmd_report(args))
    elif args.command == "sweep":
        sys.exit(asyncio.run(_run_sweep(args)))
    elif args.command == "canary":
        sys.exit(asyncio.run(_run_canary(args)))


if __name__ == "__main__":
    main()
