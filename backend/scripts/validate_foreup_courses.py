#!/usr/bin/env python3
"""Validate a foreUP booking page + probe live availability once
(specs/teetime-s1-foreup-plan.md §7).

Read-only, honest UA (the same `Looper/1.0 (golf tee-time availability)`
foreup.py uses), ONE probe of the times endpoint per invocation. **Never run
in CI** — nothing imports this module; it exists to be run by hand (or once,
by the builder, to seed/refresh capability rows and to capture the CI test
fixture).

Pipeline
--------
1. Parse `foreup_booking_id` / `schedule_id` out of the booking-page URL path
   (`/index.php/booking/{id}/{sid}`).
2. GET the booking page (honest UA); fingerprint it as a real foreUP page
   (200 + a foreUP marker in the body). Extract a display name from the page
   when `--name` is not given. Not a foreUP page -> exit 2, write nothing.
3. ONE probe of the times endpoint (foreup.py's exact request builder — same
   params/header/timeout) for `--date` (default: today + 2 days) and
   `--players` (default 1, the superset view). Non-200 / non-array -> exit 3,
   write nothing.
4. Print an honest summary: course, ids, slot count, first/last time seen,
   min/max green fee seen.
5. `--capture-fixture PATH` writes the RAW response body verbatim to PATH —
   this is the ONE sanctioned live capture that produced
   backend/tests/fixtures/foreup_18mile_times.json. Never hand-edit that file.
6. Appends the capability record (capability_store.py §4a shape) to `--out`
   (default `backend/data/foreup_validated.json`); with `--seed`, targets
   `backend/data/foreup_ny_seed.json` instead. De-dupes on
   `(foreup_booking_id, schedule_id)` — replaces the existing row, refreshing
   `verified_at`. `--dry-run` prints the row and writes nothing.

Usage
-----
Capture the CI fixture (the one sanctioned live probe for this build)::

    uv run backend/scripts/validate_foreup_courses.py \\
        --url https://foreupsoftware.com/index.php/booking/20410/4467 \\
        --name "18 Mile Creek Golf Course" --lat 42.714304 --lng -78.813114 \\
        --phone "(716) 648-4410" --players 1 \\
        --capture-fixture backend/tests/fixtures/foreup_18mile_times.json --dry-run

Refresh / append a validated capability row (real, not the curated seed)::

    uv run backend/scripts/validate_foreup_courses.py \\
        --url https://foreupsoftware.com/index.php/booking/20410/4467 \\
        --name "18 Mile Creek Golf Course" --lat 42.714304 --lng -78.813114
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import re
import sys
from pathlib import Path

# Make the backend package importable when run from the repo root or backend/.
sys.path.insert(0, str(Path(__file__).parent.parent))

import httpx  # noqa: E402

from app.services.tee_times.foreup import (  # noqa: E402
    USER_AGENT,
    build_times_request,
)

_DATA_DIR = Path(__file__).parent.parent / "data"
_DEFAULT_OUT = _DATA_DIR / "foreup_validated.json"
_DEFAULT_SEED = _DATA_DIR / "foreup_ny_seed.json"

_BOOKING_URL_RE = re.compile(r"/index\.php/booking/(\d+)/(\d+)")
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_FOREUP_MARKER_RE = re.compile(r"foreupsoftware", re.IGNORECASE)


def _parse_booking_ids(url: str) -> tuple[str, str]:
    m = _BOOKING_URL_RE.search(url)
    if not m:
        print(
            f"error: could not parse booking id/schedule id from URL {url!r} "
            "— expected .../index.php/booking/{id}/{schedule_id}",
            file=sys.stderr,
        )
        sys.exit(1)
    return m.group(1), m.group(2)


def _extract_name(body: str) -> str | None:
    m = _TITLE_RE.search(body)
    if not m:
        return None
    title = re.sub(r"\s+", " ", m.group(1)).strip()
    # foreUP titles are commonly "<Course Name> | Online Tee Times" or
    # "<Course Name> - foreUP" — strip a trailing separator segment.
    for sep in (" | ", " - "):
        if sep in title:
            title = title.split(sep)[0].strip()
    return title or None


async def _fetch_booking_page(url: str) -> httpx.Response:
    async with httpx.AsyncClient(
        timeout=8.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True
    ) as client:
        return await client.get(url)


async def _fetch_times(schedule_id: str, date_mmddyyyy: str, players: int) -> httpx.Response:
    url, params, headers = build_times_request(schedule_id, date_mmddyyyy, players)
    async with httpx.AsyncClient(timeout=8.0) as client:
        return await client.get(url, params=params, headers=headers)


def _default_date() -> str:
    return (datetime.date.today() + datetime.timedelta(days=2)).strftime("%Y-%m-%d")


def _summarize(entries: list) -> None:
    times = sorted(
        e.get("time") for e in entries
        if isinstance(e, dict) and isinstance(e.get("time"), str)
    )
    fees = [
        e.get("green_fee") for e in entries
        if isinstance(e, dict) and isinstance(e.get("green_fee"), (int, float))
        and not isinstance(e.get("green_fee"), bool) and e.get("green_fee") > 0
    ]
    print(f"  slots:       {len(entries)}")
    if times:
        print(f"  first time:  {times[0]}")
        print(f"  last time:   {times[-1]}")
    if fees:
        print(f"  green fee:   ${min(fees):.2f} - ${max(fees):.2f}")


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


def _upsert_record(data: dict, record: dict) -> dict:
    key = (record["foreup_booking_id"], record["schedule_id"])
    courses = [
        c for c in data.get("courses", [])
        if (c.get("foreup_booking_id"), c.get("schedule_id")) != key
    ]
    courses.append(record)
    data["courses"] = courses
    return data


async def _run(args: argparse.Namespace) -> int:
    booking_id, schedule_id = _parse_booking_ids(args.url)

    print(f"GET {args.url}")
    try:
        page_resp = await _fetch_booking_page(args.url)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        print(f"error: could not reach booking page: {exc!r}", file=sys.stderr)
        return 2

    if page_resp.status_code != 200 or not _FOREUP_MARKER_RE.search(page_resp.text):
        print(
            f"error: {args.url} does not look like a foreUP booking page "
            f"(status={page_resp.status_code})",
            file=sys.stderr,
        )
        return 2

    name = args.name or _extract_name(page_resp.text)
    if not name:
        print(
            "error: could not extract a course name from the page — pass --name",
            file=sys.stderr,
        )
        return 2

    date_str = args.date or _default_date()
    try:
        date_mmddyyyy = datetime.datetime.strptime(date_str, "%Y-%m-%d").strftime("%m-%d-%Y")
    except ValueError:
        print(f"error: --date {date_str!r} is not YYYY-MM-DD", file=sys.stderr)
        return 1

    print(f"GET {build_times_request(schedule_id, date_mmddyyyy, args.players)[0]} "
          f"(schedule_id={schedule_id}, date={date_mmddyyyy}, players={args.players})")
    try:
        times_resp = await _fetch_times(schedule_id, date_mmddyyyy, args.players)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        print(f"error: times probe failed: {exc!r}", file=sys.stderr)
        return 3

    if times_resp.status_code != 200:
        print(f"error: times probe returned HTTP {times_resp.status_code}", file=sys.stderr)
        return 3

    try:
        entries = times_resp.json()
    except Exception:
        print("error: times probe response was not valid JSON", file=sys.stderr)
        return 3

    if not isinstance(entries, list):
        print(
            f"error: times probe response was not a JSON array (type={type(entries).__name__})",
            file=sys.stderr,
        )
        return 3

    print(f"\n{name}")
    print(f"  booking_id:  {booking_id}")
    print(f"  schedule_id: {schedule_id}")
    print(f"  date:        {date_str}")
    _summarize(entries)

    if args.capture_fixture:
        fixture_path = Path(args.capture_fixture)
        fixture_path.parent.mkdir(parents=True, exist_ok=True)
        fixture_path.write_bytes(times_resp.content)
        print(f"\ncaptured raw response -> {fixture_path}")

    verified_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    booking_url = f"https://foreupsoftware.com/index.php/booking/{booking_id}/{schedule_id}"
    record = {
        "platform": "foreup",
        "course_id": None,
        "foreup_booking_id": booking_id,
        "schedule_id": schedule_id,
        "booking_url": booking_url,
        "phone": args.phone,
        "is_private": False,
        "verified_at": verified_at,
        "name": name,
        "lat": args.lat,
        "lng": args.lng,
        "aliases": [],
    }

    if args.dry_run:
        print("\n--dry-run: would write —")
        print(json.dumps(record, indent=2))
        return 0

    if args.lat is None or args.lng is None:
        print(
            "error: --lat/--lng are required to write a capability row "
            "(pass --dry-run to skip writing)",
            file=sys.stderr,
        )
        return 1

    out_path = _DEFAULT_SEED if args.seed else Path(args.out)
    data = _load_courses(out_path)
    data = _upsert_record(data, record)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"\nwrote capability row -> {out_path}")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Validate a foreUP booking page + probe live availability once."
    )
    p.add_argument("--url", required=True, help="foreUP booking page URL")
    p.add_argument("--name", default=None, help="Course display name (else extracted from the page)")
    p.add_argument("--lat", type=float, default=None, help="Course latitude (real, never guessed)")
    p.add_argument("--lng", type=float, default=None, help="Course longitude (real, never guessed)")
    p.add_argument("--phone", default=None, help="Pro shop phone number")
    p.add_argument("--date", default=None, help="YYYY-MM-DD (default: today + 2 days)")
    p.add_argument("--players", type=int, default=1, help="Party size for the probe (default 1)")
    p.add_argument("--out", default=str(_DEFAULT_OUT), help="Output JSON path (validated rows)")
    p.add_argument("--seed", action="store_true", help="Write to foreup_ny_seed.json instead of --out")
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
