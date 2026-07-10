#!/usr/bin/env python3
"""Generalized booking-capability probe (specs/teetime-availability-everywhere
-plan.md §2b, S4c).

Given a course name + location (+ optional website), figures out WHICH
booking engine (if any) the course uses, extracts that engine's platform ids
from the engine's own page/bootstrap (never hardcoded), runs ONE read-only
availability probe through the matching adapter's exact request shape, and
writes a capability row (`probe_status`) — same shape `capability_store.py`
loads — to the generalized *validated* file (fail-soft, script-appended;
`--dry-run` prints, writes nothing).

This is the S4c generalization of `validate_foreup_courses.py` (kept
UNTOUCHED and independently runnable — this script does not replace it,
foreUP courses can still be probed either way). Never imported by tests,
never run in CI — hand-run only, same as its predecessor.

Pipeline
--------
1. Fingerprint the course's website: fetch the homepage + a few
   tee-times-ish paths (honest UA, no auth), regex for a known
   booking-engine marker (foreUP / TeeItUp / EZLinks / Chronogolf /
   Club Prophet / Quick18 / Teesnap). No website, or no match -> falls
   through to `phone_only`/`none`.
2. Extract that engine's platform ids from the matched page/bootstrap:
   - foreUP: `booking_id`/`schedule_id` straight from the matched
     `/index.php/booking/{id}/{sid}` URL path (same as
     `validate_foreup_courses.py`).
   - TeeItUp: tenant `alias` from the `<alias>.book.teeitup.(com|golf)`
     subdomain; `facility_id` from an embedded `facilityId(s)` JSON literal
     on the page (best-effort — pass `--facility-id` to override/supply it
     when the page doesn't expose one plainly).
   - Chronogolf: club `slug` from the matched `chronogolf.com/club/<slug>`
     URL, then ONE lookup `GET marketplace/v2/clubs/<slug>` (STEP A) to
     resolve `club_id`/`course_id`/`affiliation_type_id`/lat/lng/phone —
     never hardcoded, always read from that response.
3. ONE read-only availability probe through the matching adapter's exact
   request shape (`build_times_request`) for `--date` (default: today + 3)
   and `--players` (default 1).
4. `--capture-fixture PATH` writes the RAW response body verbatim — the
   sanctioned live-capture path for a new CI fixture.
5. Prints an honest summary (course, platform, ids, slot count observed).
   `--dry-run` prints the capability row and writes nothing; otherwise
   appends/upserts it into `--out` (default
   `backend/data/booking_capabilities_validated.json`), de-duping on
   `(platform, sorted platform_ids)` — same key `capability_store.py` uses.
   No match / no website: writes a `platform="phone_only", channel="call"`
   row when `--phone` is known, else `channel="none"`.

Usage
-----
Fingerprint + probe a Chronogolf course, capture a fixture, dry-run only::

    uv run backend/scripts/probe_booking_capability.py \\
        --name "Rock Spring Golf Club at West Orange" \\
        --website https://www.chronogolf.com/club/rock-spring-golf-club-at-west-orange \\
        --lat 40.768991 --lng -74.264034 --phone "(973) 731-6464" \\
        --capture-fixture backend/tests/fixtures/chronogolf_rockspring_times.json --dry-run

Probe a course by its OWN site (fingerprints + extracts ids automatically)::

    uv run backend/scripts/probe_booking_capability.py \\
        --name "Some Public Course" --website https://somepubliccourse.example.com \\
        --lat 40.7 --lng -73.9 --phone "(555) 555-1234"

No website known (phone-only fallback, writes nothing without --lat/--lng)::

    uv run backend/scripts/probe_booking_capability.py \\
        --name "Tiny Muni" --lat 40.5 --lng -74.0 --phone "(555) 555-0000" --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import re
import sys
from pathlib import Path
from typing import Any

# Make the backend package importable when run from the repo root or backend/.
sys.path.insert(0, str(Path(__file__).parent.parent))

import httpx  # noqa: E402

from app.services.tee_times.adapters.chronogolf import (  # noqa: E402
    build_times_request as chronogolf_times_request,
)
from app.services.tee_times.adapters.teeitup import (  # noqa: E402
    build_times_request as teeitup_times_request,
)
from app.services.tee_times.fetch_discipline import USER_AGENT  # noqa: E402
from app.services.tee_times.foreup import (  # noqa: E402
    build_times_request as foreup_times_request,
)

_DATA_DIR = Path(__file__).parent.parent / "data"
_DEFAULT_OUT = _DATA_DIR / "booking_capabilities_validated.json"

_REQUEST_TIMEOUT_S = 8.0

# ─── Step 1: fingerprint markers (plan §2b / §1 table) ─────────────────────────
# Order matters only as a tie-break when a page happens to reference more than
# one engine (rare) — first match wins.

_FOREUP_RE = re.compile(r"foreupsoftware\.com/index\.php/booking/(\d+)/(\d+)", re.I)
_TEEITUP_RE = re.compile(r"([a-z0-9-]+)\.book\.teeitup\.(?:com|golf)", re.I)
_EZLINKS_RE = re.compile(r"([a-z0-9-]+)\.ezlinksgolf\.com", re.I)
_CHRONOGOLF_RE = re.compile(r"chronogolf\.com/club/([a-z0-9-]+)", re.I)
_CLUBPROPHET_RE = re.compile(r"book\.cps\.golf", re.I)
_QUICK18_RE = re.compile(r"quick18\.com", re.I)
_TEESNAP_RE = re.compile(r"([a-z0-9-]+)\.teesnap\.net", re.I)

_CANDIDATE_PATHS = ("", "/tee-times", "/tee-times/rates", "/booking", "/book", "/golf/tee-times")


class Fingerprint:
    def __init__(self, platform: str, match: str, source_url: str) -> None:
        self.platform = platform
        self.match = match          # the captured group (slug/subdomain/ids) or "" when N/A
        self.source_url = source_url


async def _fetch(client: httpx.AsyncClient, url: str) -> httpx.Response | None:
    try:
        return await client.get(url, follow_redirects=True)
    except (httpx.TimeoutException, httpx.TransportError):
        return None


async def fingerprint_website(website: str) -> Fingerprint | None:
    """Fetch the homepage + a few tee-times-ish paths (honest UA, no auth),
    regex for a known booking-engine marker. Returns the first match found,
    or `None` (no known engine detected — falls through to phone_only/none).
    """
    website = website.rstrip("/")
    async with httpx.AsyncClient(
        timeout=_REQUEST_TIMEOUT_S, headers={"User-Agent": USER_AGENT}
    ) as client:
        for path in _CANDIDATE_PATHS:
            url = f"{website}{path}"
            resp = await _fetch(client, url)
            if resp is None or resp.status_code != 200:
                continue
            body = resp.text

            m = _CHRONOGOLF_RE.search(body)
            if m:
                return Fingerprint("chronogolf", m.group(1), url)
            m = _TEEITUP_RE.search(body)
            if m:
                return Fingerprint("teeitup", m.group(1), url)
            m = _FOREUP_RE.search(body)
            if m:
                return Fingerprint("foreup", f"{m.group(1)}/{m.group(2)}", url)
            m = _EZLINKS_RE.search(body)
            if m:
                return Fingerprint("ezlinks", m.group(1), url)
            if _CLUBPROPHET_RE.search(body):
                return Fingerprint("clubprophet", "", url)
            if _QUICK18_RE.search(body):
                return Fingerprint("quick18", "", url)
            m = _TEESNAP_RE.search(body)
            if m:
                return Fingerprint("teesnap", m.group(1), url)

        # The URL itself (not just the fetched body) may already BE an
        # engine URL (e.g. --website passed as a chronogolf.com/club/<slug>
        # deep link directly) — check it too.
        for pattern, platform in (
            (_CHRONOGOLF_RE, "chronogolf"), (_TEEITUP_RE, "teeitup"),
            (_FOREUP_RE, "foreup"), (_EZLINKS_RE, "ezlinks"),
            (_TEESNAP_RE, "teesnap"),
        ):
            m = pattern.search(website)
            if m:
                groups = m.groups()
                match = "/".join(g for g in groups if g) if groups else ""
                return Fingerprint(platform, match, website)
    return None


# ─── Step 2 + 3: per-platform id extraction + one probe ────────────────────────

def _default_date() -> str:
    return (datetime.date.today() + datetime.timedelta(days=3)).strftime("%Y-%m-%d")


async def probe_foreup(
    fp: Fingerprint, *, date: str, players: int
) -> tuple[dict[str, str], httpx.Response | None]:
    booking_id, schedule_id = fp.match.split("/")
    date_mmddyyyy = datetime.datetime.strptime(date, "%Y-%m-%d").strftime("%m-%d-%Y")
    url, params, headers = foreup_times_request(schedule_id, date_mmddyyyy, players)
    print(f"GET {url} (booking_id={booking_id}, schedule_id={schedule_id}, date={date_mmddyyyy})")
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_S) as client:
        try:
            resp = await client.get(url, params=params, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            print(f"error: foreup times probe failed: {exc!r}", file=sys.stderr)
            return {"booking_id": booking_id, "schedule_id": schedule_id}, None
    ids = {"booking_id": booking_id, "schedule_id": schedule_id}
    return ids, resp


async def probe_teeitup(
    fp: Fingerprint, *, date: str, facility_id: str | None
) -> tuple[dict[str, str], httpx.Response | None]:
    alias = fp.match
    resolved_facility_id = facility_id
    if resolved_facility_id is None:
        # Best-effort extraction from the fingerprinted page — TeeItUp pages
        # commonly embed a `facilityId`/`facilityIds` JSON literal in their
        # bootstrap data. Never guessed if not found: the caller must supply
        # --facility-id.
        async with httpx.AsyncClient(
            timeout=_REQUEST_TIMEOUT_S, headers={"User-Agent": USER_AGENT}
        ) as client:
            resp = await _fetch(client, fp.source_url)
        if resp is not None and resp.status_code == 200:
            m = re.search(r'"facilityIds?"\s*:\s*"?(\d+)"?', resp.text)
            if m:
                resolved_facility_id = m.group(1)
    if resolved_facility_id is None:
        print(
            "error: could not extract a TeeItUp facility_id from the page — pass --facility-id",
            file=sys.stderr,
        )
        return {"alias": alias}, None

    url, params, headers = teeitup_times_request(alias, resolved_facility_id, date)
    print(f"GET {url} (alias={alias}, facility_id={resolved_facility_id}, date={date})")
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_S) as client:
        try:
            resp = await client.get(url, params=params, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            print(f"error: teeitup times probe failed: {exc!r}", file=sys.stderr)
            return {"alias": alias, "facility_id": resolved_facility_id}, None
    ids = {"alias": alias, "facility_id": resolved_facility_id}
    return ids, resp


async def _lookup_chronogolf_club(slug: str) -> dict[str, Any] | None:
    """Step A (module docstring): resolve club_id/course_id/
    default_affiliation_type_id/lat/lng/phone from the club's own JSON —
    NEVER hardcoded. `GET marketplace/v2/clubs/<slug>` (no auth)."""
    url = f"https://www.chronogolf.com/marketplace/v2/clubs/{slug}"
    print(f"GET {url} (club id lookup)")
    async with httpx.AsyncClient(
        timeout=_REQUEST_TIMEOUT_S, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    ) as client:
        try:
            resp = await client.get(url)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            print(f"error: chronogolf club lookup failed: {exc!r}", file=sys.stderr)
            return None
    if resp.status_code != 200:
        print(f"error: chronogolf club lookup returned HTTP {resp.status_code}", file=sys.stderr)
        return None
    try:
        return resp.json()
    except Exception:
        print("error: chronogolf club lookup response was not valid JSON", file=sys.stderr)
        return None


async def probe_chronogolf(
    fp: Fingerprint, *, date: str, course_hint: str | None
) -> tuple[dict[str, str], httpx.Response | None, dict[str, Any] | None]:
    slug = fp.match
    club = await _lookup_chronogolf_club(slug)
    if club is None:
        return {}, None, None

    club_id = str(club.get("id") or "")
    courses = club.get("courses") or []
    course = None
    if course_hint:
        course = next(
            (c for c in courses if isinstance(c, dict) and course_hint.lower() in str(c.get("name", "")).lower()),
            None,
        )
    if course is None and courses:
        course = courses[0] if isinstance(courses[0], dict) else None
    course_id = str(course.get("id")) if course else ""
    affiliation_type_id = str(club.get("default_affiliation_type_id") or "")

    if not club_id or not course_id or not affiliation_type_id:
        print(
            "error: chronogolf club JSON missing id/courses[0].id/default_affiliation_type_id "
            "— cannot probe availability",
            file=sys.stderr,
        )
        return {"club_id": club_id, "course_id": course_id, "affiliation_type_id": affiliation_type_id}, None, club

    url, params, headers = chronogolf_times_request(club_id, course_id, affiliation_type_id, date)
    print(f"GET {url} (club_id={club_id}, course_id={course_id}, affiliation_type_id={affiliation_type_id}, date={date})")
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_S) as client:
        try:
            resp = await client.get(url, params=params, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            print(f"error: chronogolf times probe failed: {exc!r}", file=sys.stderr)
            return (
                {"club_id": club_id, "course_id": course_id, "affiliation_type_id": affiliation_type_id},
                None, club,
            )
    ids = {"club_id": club_id, "course_id": course_id, "affiliation_type_id": affiliation_type_id}
    return ids, resp, club


# ─── Summary + record building ──────────────────────────────────────────────────

def _summarize_array_response(entries: Any) -> None:
    if not isinstance(entries, list):
        print(f"  response was not a JSON array (type={type(entries).__name__})")
        return
    print(f"  raw entries: {len(entries)}")


def _load_courses(path: Path) -> dict:
    if not path.exists():
        return {"courses": []}
    try:
        data = json.loads(path.read_text())
        data.setdefault("courses", [])
        return data
    except Exception:
        print(f"warning: {path} was malformed — starting fresh", file=sys.stderr)
        return {"courses": []}


def _dedupe_key(record: dict) -> tuple:
    return (record["platform"], tuple(sorted((record.get("platform_ids") or {}).items())))


def _upsert_record(data: dict, record: dict) -> dict:
    key = _dedupe_key(record)
    courses = [c for c in data.get("courses", []) if _dedupe_key(c) != key]
    courses.append(record)
    data["courses"] = courses
    return data


def _build_record(
    *, platform: str, channel: str, platform_ids: dict[str, str], name: str,
    lat: float | None, lng: float | None, phone: str | None, booking_url: str | None,
    probe_status: str,
) -> dict:
    verified_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "platform": platform,
        "channel": channel,
        "platform_ids": platform_ids,
        "course_id": None,
        "booking_url": booking_url,
        "phone": phone,
        "is_private": False,
        "verified_at": verified_at,
        "probe_status": probe_status,
        "name": name,
        "lat": lat,
        "lng": lng,
        "aliases": [],
    }


# ─── Main pipeline ──────────────────────────────────────────────────────────────

async def _run(args: argparse.Namespace) -> int:
    date_str = args.date or _default_date()
    try:
        datetime.datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        print(f"error: --date {date_str!r} is not YYYY-MM-DD", file=sys.stderr)
        return 1

    record: dict | None = None
    raw_body: bytes | None = None

    if args.website:
        print(f"fingerprinting {args.website} ...")
        fp = await fingerprint_website(args.website)
    else:
        fp = None

    if fp is None:
        # No website, or no known engine matched -> phone-only / none fallback
        # (plan §2b step 5).
        if args.phone:
            print(f"\n{args.name}\n  no known booking engine detected — phone_only")
            record = _build_record(
                platform="phone_only", channel="call", platform_ids={},
                name=args.name, lat=args.lat, lng=args.lng, phone=args.phone,
                booking_url=args.website, probe_status="verified",
            )
        else:
            print(f"\n{args.name}\n  no known booking engine detected, no phone known — channel=none")
            record = _build_record(
                platform="unknown", channel="none", platform_ids={},
                name=args.name, lat=args.lat, lng=args.lng, phone=None,
                booking_url=args.website, probe_status="failed",
            )
    else:
        print(f"fingerprinted platform={fp.platform!r} match={fp.match!r} url={fp.source_url}")
        resp: httpx.Response | None = None
        ids: dict[str, str] = {}
        booking_url = args.website

        if fp.platform == "foreup":
            ids, resp = await probe_foreup(fp, date=date_str, players=args.players)
            booking_url = f"https://foreupsoftware.com/index.php/booking/{ids.get('booking_id')}/{ids.get('schedule_id')}"
        elif fp.platform == "teeitup":
            ids, resp = await probe_teeitup(fp, date=date_str, facility_id=args.facility_id)
        elif fp.platform == "chronogolf":
            ids, resp, club = await probe_chronogolf(fp, date=date_str, course_hint=args.course_name)
            if club is not None:
                # Real values from the club JSON win over hand-passed
                # --lat/--lng/--phone when present (never guessed).
                loc = club.get("location") or {}
                if args.lat is None and loc.get("lat") is not None:
                    args.lat = float(loc["lat"])
                if args.lng is None and loc.get("lon") is not None:
                    args.lng = float(loc["lon"])
                if args.phone is None and club.get("phone"):
                    args.phone = club["phone"]
        else:
            print(
                f"note: fingerprinted platform={fp.platform!r} has no probe implementation yet "
                "(plan §1: expand as new adapters ship) — writing a channel=none row",
                file=sys.stderr,
            )
            record = _build_record(
                platform=fp.platform, channel="scrape_http", platform_ids={},
                name=args.name, lat=args.lat, lng=args.lng, phone=args.phone,
                booking_url=args.website, probe_status="failed",
            )

        if record is None:
            if resp is None:
                print(f"\n{args.name}\n  platform={fp.platform} — probe failed, writing probe_status=failed")
                probe_status = "failed"
                entries: Any = None
            elif resp.status_code != 200:
                print(f"\n{args.name}\n  platform={fp.platform} — HTTP {resp.status_code}, probe_status=failed")
                probe_status = "failed"
                entries = None
            else:
                try:
                    entries = resp.json()
                except Exception:
                    entries = None
                print(f"\n{args.name}")
                for k, v in ids.items():
                    print(f"  {k}: {v}")
                print(f"  date: {date_str}")
                _summarize_array_response(entries)
                probe_status = "verified" if isinstance(entries, list) else "failed"
                raw_body = resp.content

            if args.capture_fixture and raw_body is not None:
                fixture_path = Path(args.capture_fixture)
                fixture_path.parent.mkdir(parents=True, exist_ok=True)
                fixture_path.write_bytes(raw_body)
                print(f"\ncaptured raw response -> {fixture_path}")

            channel = "api" if fp.platform in ("foreup", "teeitup") else "scrape_http"
            record = _build_record(
                platform=fp.platform, channel=channel, platform_ids=ids,
                name=args.name, lat=args.lat, lng=args.lng, phone=args.phone,
                booking_url=booking_url, probe_status=probe_status,
            )

    assert record is not None

    if args.dry_run:
        print("\n--dry-run: would write —")
        print(json.dumps(record, indent=2))
        return 0

    if record["lat"] is None or record["lng"] is None:
        print(
            "error: --lat/--lng are required to write a capability row "
            "(pass --dry-run to skip writing)",
            file=sys.stderr,
        )
        return 1

    out_path = Path(args.out)
    data = _load_courses(out_path)
    data = _upsert_record(data, record)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"\nwrote capability row -> {out_path}")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "Fingerprint a course's booking engine, extract platform ids, probe "
            "availability once, and write a capability row."
        )
    )
    p.add_argument("--name", required=True, help="Course display name (real, never guessed)")
    p.add_argument("--website", default=None, help="Course (or booking engine) URL to fingerprint")
    p.add_argument("--lat", type=float, default=None, help="Course latitude (real, never guessed)")
    p.add_argument("--lng", type=float, default=None, help="Course longitude (real, never guessed)")
    p.add_argument("--phone", default=None, help="Pro shop phone number")
    p.add_argument("--date", default=None, help="YYYY-MM-DD (default: today + 3 days)")
    p.add_argument("--players", type=int, default=1, help="Party size for the foreUP probe (default 1)")
    p.add_argument("--facility-id", default=None, help="TeeItUp facility_id override (when not page-extractable)")
    p.add_argument("--course-name", default=None, help="Chronogolf: match a specific course by name substring (multi-course clubs)")
    p.add_argument("--out", default=str(_DEFAULT_OUT), help="Output JSON path (validated rows)")
    p.add_argument("--dry-run", action="store_true", help="Print the row; write nothing")
    p.add_argument(
        "--capture-fixture", default=None, metavar="PATH",
        help="Write the RAW times response body verbatim to PATH (test fixture capture)",
    )
    return p


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()
    exit_code = asyncio.run(_run(args))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
