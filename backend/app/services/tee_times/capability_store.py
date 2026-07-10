"""
CourseBookingCapability store — S1 real foreUP availability
(specs/teetime-s1-foreup-plan.md §4), generalized to multi-platform in S4a
(specs/teetime-availability-everywhere-plan.md §2a).

A "capability" is a fact record: "this discovered course is known to be
bookable on <platform> at <platform_ids>, verified on this date."
NO DB TABLE — this machine has no local Postgres and the migrations
directory is guarded; the record set is a curated handful of NY/NJ courses,
so the injectable file-backed pattern of ``search_cache.py`` /
``private_filter.py`` is sufficient and keeps every test DB-free. A real
table becomes worthwhile only at S3+ scale (specs/teetime-real-booking-plan.md).

FOUR files, two loading policies, mirroring private_filter.py's rationale —
one seed/validated pair per "era":

- ``backend/data/foreup_ny_seed.json`` — the ORIGINAL foreUP-only curated
  seed (S1). **Fail-loud** on missing/malformed JSON. Its rows are the
  legacy flat shape (`foreup_booking_id`/`schedule_id`, no `platform_ids`);
  ``_parse_row`` maps those into `platform_ids={"booking_id":..,
  "schedule_id":..}` so downstream dedup/adapter-lookup code never has to
  know about the legacy shape. Loaded (unchanged, byte-identical) by
  ``load_capabilities`` — this function and its two files are UNTOUCHED by
  the S4a generalization; every S1 test keeps exercising exactly this path.
- ``backend/data/foreup_validated.json`` — appended by
  ``scripts/validate_foreup_courses.py``, gitignored. **Fail-soft**.
- ``backend/data/booking_capabilities_seed.json`` — the NEW generalized
  multi-platform curated seed (S4a+: teeitup, and future engines).
  **Fail-loud**, same reasoning.
- ``backend/data/booking_capabilities_validated.json`` — the generalized
  script-appended file (future ``probe_booking_capability.py``), gitignored.
  **Fail-soft**.

``load_all_capabilities`` merges all four sources (legacy foreUP rows +
generalized multi-platform rows) — this is the default capability source for
``RoutedTeeTimeProvider``. ``load_capabilities`` (unchanged) stays the
foreUP-only source that ``ForeUpProvider``'s standalone/debug mode uses.

Matching (``match_capability``) reuses ``private_filter.normalize`` — exact
normalized-name equality (name or alias), never substring — plus a tight
proximity radius. See router_provider.py §5b for the full decision. It is
platform-agnostic already (doesn't inspect ``cap.platform``), so no changes
were needed there.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from pathlib import Path

from .private_filter import normalize

log = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"
SEED_PATH = _DATA_DIR / "foreup_ny_seed.json"
VALIDATED_PATH = _DATA_DIR / "foreup_validated.json"
GENERALIZED_SEED_PATH = _DATA_DIR / "booking_capabilities_seed.json"
GENERALIZED_VALIDATED_PATH = _DATA_DIR / "booking_capabilities_validated.json"

# A same-named different course is essentially never within a mile — see
# router_provider.py §5b for the full matching rule.
MATCH_RADIUS_MILES = 1.0


@dataclass(frozen=True)
class CourseBookingCapability:
    """One curated booking-capability fact record — generalized to any
    platform (specs/teetime-availability-everywhere-plan.md §2a). Never
    invent a value; unknown fields are `None`.

    ``foreup_booking_id`` / ``schedule_id`` are the ORIGINAL S1 fields, kept
    as real (not derived) fields for back-compat: existing tests + foreup.py
    construct/read them directly, and every foreUP row (legacy or
    generalized-shape) still populates them. New platforms (teeitup, …)
    leave them `None` and use ``platform_ids`` instead.
    """

    platform: str                    # "foreup" | "teeitup" | … (forward-compat: unknown values just don't match an adapter)
    name: str
    lat: float
    lng: float
    channel: str = "api"             # "api" | "scrape_http" | "scrape_browser" | "call" | "none"
    platform_ids: dict[str, str] = field(default_factory=dict)
    course_id: str | None = None     # discovery-namespaced id (e.g. "gplaces-<id>"), when known
    booking_url: str | None = None
    phone: str | None = None
    is_private: bool = False
    verified_at: str = ""            # ISO-8601 UTC of the last successful probe
    probe_status: str = "verified"   # "verified" | "stale" | "failed" — drives router trust
    aliases: tuple[str, ...] = ()
    foreup_booking_id: str | None = None   # legacy foreUP convenience field (see docstring)
    schedule_id: str | None = None         # legacy foreUP convenience field (see docstring)


def _haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = rlat2 - rlat1
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(a))


def _dedupe_key(cap: CourseBookingCapability) -> tuple:
    """Generalized dedup key (specs/teetime-availability-everywhere-plan.md
    §2a): ``(platform, sorted platform_ids items)``. For a foreUP row this is
    equivalent to the original ``(foreup_booking_id, schedule_id)`` key
    (``_parse_row`` always populates ``platform_ids`` from those two fields),
    so this generalization changes zero observable dedup behavior for foreUP."""
    return (cap.platform, tuple(sorted(cap.platform_ids.items())))


def _parse_row(raw: dict) -> CourseBookingCapability | None:
    """Legacy foreUP-only row parser (the ORIGINAL S1 shape) — untouched
    skip/required-key behavior. Additive only: also populates
    ``platform_ids``/``channel``/``probe_status`` so a foreUP row loaded here
    dedupes/adapts identically to one loaded via the generalized files."""
    platform = raw.get("platform")
    if platform != "foreup":
        log.warning("capability_store: skipping row with platform=%r (only 'foreup' supported)", platform)
        return None
    foreup_booking_id = str(raw["foreup_booking_id"])
    schedule_id = str(raw["schedule_id"])
    return CourseBookingCapability(
        platform=platform,
        channel="api",
        platform_ids={"booking_id": foreup_booking_id, "schedule_id": schedule_id},
        course_id=raw.get("course_id"),
        foreup_booking_id=foreup_booking_id,
        schedule_id=schedule_id,
        booking_url=raw["booking_url"],
        phone=raw.get("phone"),
        is_private=bool(raw.get("is_private", False)),
        verified_at=raw["verified_at"],
        probe_status=raw.get("probe_status", "verified"),
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
    """Load + merge the LEGACY foreUP-only seed + validated capability rows
    (the original S1 files/behavior — unchanged by the S4a generalization).

    Module-cached per (seed_path, validated_path) pair. Validated rows are
    APPENDED after seed rows; on a duplicate dedup key the SEED row wins
    (curated beats script-appended).
    """
    key = (seed_path, validated_path)
    if key in _cache:
        return _cache[key]

    seed_rows = _load_seed(seed_path)
    validated_rows = _load_validated(validated_path)

    seen: set[tuple] = {_dedupe_key(c) for c in seed_rows}
    merged = list(seed_rows)
    for cap in validated_rows:
        dedupe_key = _dedupe_key(cap)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        merged.append(cap)

    result = tuple(merged)
    _cache[key] = result
    return result


# ─── Generalized multi-platform loading (S4a) ──────────────────────────────────

def _parse_generalized_row(raw: dict) -> CourseBookingCapability | None:
    """Parse a row from the generalized multi-platform seed/validated files.
    Accepts any platform (unlike the legacy `_parse_row`, which only accepts
    "foreup"). `platform_ids` is the primary id carrier; the legacy flat
    `foreup_booking_id`/`schedule_id` keys are also accepted (for a foreup-
    platform row expressed in the new file shape) and folded into
    `platform_ids` exactly like `_parse_row` does. Never raises — a malformed
    row is skipped + logged, like a foreUP row with a bad platform."""
    platform = raw.get("platform")
    if not platform:
        log.warning("capability_store: skipping generalized row with no platform: %r", raw.get("name"))
        return None

    platform_ids = {str(k): str(v) for k, v in (raw.get("platform_ids") or {}).items()}
    flat_booking_id = raw.get("foreup_booking_id")
    flat_schedule_id = raw.get("schedule_id")
    if platform == "foreup" and flat_booking_id and flat_schedule_id:
        platform_ids.setdefault("booking_id", str(flat_booking_id))
        platform_ids.setdefault("schedule_id", str(flat_schedule_id))

    foreup_booking_id = str(flat_booking_id) if flat_booking_id else platform_ids.get("booking_id")
    schedule_id = str(flat_schedule_id) if flat_schedule_id else platform_ids.get("schedule_id")

    try:
        return CourseBookingCapability(
            platform=platform,
            channel=raw.get("channel", "api"),
            platform_ids=platform_ids,
            course_id=raw.get("course_id"),
            foreup_booking_id=foreup_booking_id,
            schedule_id=schedule_id,
            booking_url=raw.get("booking_url"),
            phone=raw.get("phone"),
            is_private=bool(raw.get("is_private", False)),
            verified_at=raw.get("verified_at", ""),
            probe_status=raw.get("probe_status", "verified"),
            name=raw["name"],
            lat=float(raw["lat"]),
            lng=float(raw["lng"]),
            aliases=tuple(raw.get("aliases") or ()),
        )
    except (KeyError, TypeError, ValueError):
        log.warning("capability_store: skipping malformed generalized row: %r", raw.get("name"))
        return None


def _load_generalized_seed(path: Path) -> tuple[CourseBookingCapability, ...]:
    """Fail-loud: raises on missing/malformed JSON (checked-in, curated file)."""
    raw = json.loads(path.read_text())
    rows = raw["courses"]  # raises KeyError if the shape is wrong
    return tuple(cap for row in rows if (cap := _parse_generalized_row(row)) is not None)


def _load_generalized_validated(path: Path) -> tuple[CourseBookingCapability, ...]:
    """Fail-soft: missing file → (); malformed file → logged ERROR, ()."""
    if not path.exists():
        return ()
    try:
        raw = json.loads(path.read_text())
        rows = raw["courses"]
        return tuple(cap for row in rows if (cap := _parse_generalized_row(row)) is not None)
    except Exception:
        log.exception("capability_store: booking_capabilities_validated.json is malformed — ignoring")
        return ()


_all_cache: dict[tuple[Path, Path, Path, Path], tuple[CourseBookingCapability, ...]] = {}


def load_all_capabilities(
    seed_path: Path = SEED_PATH,
    validated_path: Path = VALIDATED_PATH,
    generalized_seed_path: Path = GENERALIZED_SEED_PATH,
    generalized_validated_path: Path = GENERALIZED_VALIDATED_PATH,
) -> tuple[CourseBookingCapability, ...]:
    """Merge ALL FOUR capability sources: the legacy foreUP seed+validated
    (via `load_capabilities`, unchanged) plus the new generalized
    multi-platform seed+validated. This is the default capability source for
    `RoutedTeeTimeProvider` (router_provider.py) — the ladder's
    ``ADAPTERS.get(cap.platform)`` lookup needs every platform's rows, not
    just foreUP's.

    Precedence on a dedup-key collision (curated beats script-appended,
    within each pair, same as `load_capabilities`): legacy seed > legacy
    validated > generalized seed > generalized validated.
    """
    key = (seed_path, validated_path, generalized_seed_path, generalized_validated_path)
    if key in _all_cache:
        return _all_cache[key]

    legacy = load_capabilities(seed_path, validated_path)
    generalized_seed_rows = _load_generalized_seed(generalized_seed_path)
    generalized_validated_rows = _load_generalized_validated(generalized_validated_path)

    seen: set[tuple] = {_dedupe_key(c) for c in legacy}
    merged = list(legacy)
    for cap in (*generalized_seed_rows, *generalized_validated_rows):
        dedupe_key = _dedupe_key(cap)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        merged.append(cap)

    result = tuple(merged)
    _all_cache[key] = result
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
