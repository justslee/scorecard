"""
CourseBookingCapability store — S1 real foreUP availability
(specs/teetime-s1-foreup-plan.md §4).

A "capability" is a fact record: "this discovered course is known to be
bookable on foreUP at this booking_id/schedule_id, verified on this date."
NO DB TABLE — this machine has no local Postgres and the migrations
directory is guarded; the S1 record set is a curated handful of NY courses,
so the injectable file-backed pattern of ``search_cache.py`` /
``private_filter.py`` is sufficient and keeps every test DB-free. A real
table becomes worthwhile only at S3+ scale (specs/teetime-real-booking-plan.md).

Two files, two loading policies (mirrors private_filter.py's rationale):

- ``backend/data/foreup_ny_seed.json`` — curated, checked into the repo.
  **Fail-loud** on missing/malformed JSON: a broken edit must fail CI, not
  silently drop the real-data path (same reasoning as private_clubs.json).
- ``backend/data/foreup_validated.json`` — appended by
  ``scripts/validate_foreup_courses.py``, gitignored (runtime data, like
  ``tee_time_search_cache.json``). **Fail-soft**: missing file → no rows;
  malformed file → logged at ERROR, no rows. A bad script write must never
  take down search.

Matching (``match_capability``) reuses ``private_filter.normalize`` — exact
normalized-name equality (name or alias), never substring — plus a tight
proximity radius. See router_provider.py §5b for the full decision.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path

from .private_filter import normalize

log = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"
SEED_PATH = _DATA_DIR / "foreup_ny_seed.json"
VALIDATED_PATH = _DATA_DIR / "foreup_validated.json"

# A same-named different course is essentially never within a mile — see
# router_provider.py §5b for the full matching rule.
MATCH_RADIUS_MILES = 1.0


@dataclass(frozen=True)
class CourseBookingCapability:
    """One curated foreUP booking-capability fact record. Fields exactly as
    plan §4a — never invent a value; unknown fields are `None`."""

    platform: str                    # "foreup" (other values are skipped, forward-compat)
    course_id: str | None            # discovery-namespaced id (e.g. "gplaces-<id>"), when known
    foreup_booking_id: str
    schedule_id: str
    booking_url: str
    phone: str | None
    is_private: bool
    verified_at: str                 # ISO-8601 UTC of the last successful probe
    name: str
    lat: float
    lng: float
    aliases: tuple[str, ...] = ()


def _haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = rlat2 - rlat1
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(a))


def _parse_row(raw: dict) -> CourseBookingCapability | None:
    platform = raw.get("platform")
    if platform != "foreup":
        log.warning("capability_store: skipping row with platform=%r (only 'foreup' supported)", platform)
        return None
    return CourseBookingCapability(
        platform=platform,
        course_id=raw.get("course_id"),
        foreup_booking_id=str(raw["foreup_booking_id"]),
        schedule_id=str(raw["schedule_id"]),
        booking_url=raw["booking_url"],
        phone=raw.get("phone"),
        is_private=bool(raw.get("is_private", False)),
        verified_at=raw["verified_at"],
        name=raw["name"],
        lat=float(raw["lat"]),
        lng=float(raw["lng"]),
        aliases=tuple(raw.get("aliases") or ()),
    )


def _load_seed(path: Path) -> tuple[CourseBookingCapability, ...]:
    """Fail-loud: raises on missing/malformed JSON (checked-in, curated file)."""
    raw = json.loads(path.read_text())
    rows = raw["courses"]  # raises KeyError if the shape is wrong
    return tuple(cap for row in rows if (cap := _parse_row(row)) is not None)


def _load_validated(path: Path) -> tuple[CourseBookingCapability, ...]:
    """Fail-soft: missing file → (); malformed file → logged ERROR, ()."""
    if not path.exists():
        return ()
    try:
        raw = json.loads(path.read_text())
        rows = raw["courses"]
        return tuple(cap for row in rows if (cap := _parse_row(row)) is not None)
    except Exception:
        log.exception("capability_store: foreup_validated.json is malformed — ignoring")
        return ()


_cache: dict[tuple[Path, Path], tuple[CourseBookingCapability, ...]] = {}


def load_capabilities(
    seed_path: Path = SEED_PATH, validated_path: Path = VALIDATED_PATH
) -> tuple[CourseBookingCapability, ...]:
    """Load + merge the seed + validated capability rows.

    Module-cached per (seed_path, validated_path) pair. Validated rows are
    APPENDED after seed rows; on a duplicate ``(foreup_booking_id,
    schedule_id)`` the SEED row wins (curated beats script-appended).
    """
    key = (seed_path, validated_path)
    if key in _cache:
        return _cache[key]

    seed_rows = _load_seed(seed_path)
    validated_rows = _load_validated(validated_path)

    seen: set[tuple[str, str]] = {(c.foreup_booking_id, c.schedule_id) for c in seed_rows}
    merged = list(seed_rows)
    for cap in validated_rows:
        dedupe_key = (cap.foreup_booking_id, cap.schedule_id)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        merged.append(cap)

    result = tuple(merged)
    _cache[key] = result
    return result


def match_capability(
    course: dict, caps: tuple[CourseBookingCapability, ...]
) -> CourseBookingCapability | None:
    """Match a discovered course dict (course_finder/OSM shape) to a
    capability row. Returns the first non-skipped match (seed order —
    curated). See router_provider.py §5b for the full decision:

    1. Exact id: `course["id"]`/`course["osm_id"]` equals `cap.course_id`
       (when set).
    2. Name (normalized, exact — never substring) + proximity: the course's
       normalized name equals the capability's normalized name or any alias,
       AND (when the course has a center) haversine distance <=
       MATCH_RADIUS_MILES. A course with no center matches on name alone
       (seed rows are curated; the alternative silently loses the real-data
       path for hand-added courses).
    """
    course_id = str(course.get("id") or course.get("osm_id") or "")
    course_name = normalize(course.get("name") or "")
    center = course.get("center") or {}
    has_center = center.get("lat") is not None and center.get("lng") is not None

    for cap in caps:
        if course_id and cap.course_id and course_id == cap.course_id:
            return cap

        if not course_name:
            continue
        cap_names = {normalize(cap.name)} | {normalize(a) for a in cap.aliases}
        if course_name not in cap_names:
            continue

        if has_center:
            dist = _haversine_miles(center["lat"], center["lng"], cap.lat, cap.lng)
            if dist <= MATCH_RADIUS_MILES:
                return cap
            continue  # same normalized name, outside the radius — not a match

        return cap  # no center on the course — name alone matches

    return None
