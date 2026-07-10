"""
Course-selection matching — wires ``TeeTimeQuery.course_ids`` into the real
tee-time path (specs/teetime-course-ids-wiring-plan.md).

A "selector" is what the golfer actually picked (a raw id from
``courseIds``, optionally resolved to a name + center from our mapped
``courses`` table). A "candidate id set" is every id a DISCOVERED course
could plausibly be known by (its own id/osm_id, plus the deterministic UUID
its write-through row would get). Matching a selector against a discovered
course tries id equality first, then falls back to name+proximity — the same
two-step shape as ``capability_store.match_capability`` /
``private_filter.is_private``.

Honesty posture: a selection that reconciles with nothing actually
discovered is dropped, never fabricated (see routing.py callsite). This
module is pure except for ``resolve_selectors``, which does ONE DB lookup and
NEVER raises — any DB error degrades to id-only selectors, which still
satisfy the direct-id match cells (see plan §risk 2).
"""

from __future__ import annotations

import logging
import math
import uuid
from dataclasses import dataclass
from typing import Sequence

from app.services import course_finder

from .capability_store import MATCH_RADIUS_MILES
from .private_filter import normalize

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class CourseSelector:
    """One resolved course selection. ``name``/``lat``/``lng`` are populated
    from a mapped ``courses`` row when the raw id resolves to one (homegrown
    slug-keyed rows) — ``None`` when unresolved (id-only selector)."""

    id: str
    name: str | None = None
    lat: float | None = None
    lng: float | None = None


def _haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = rlat2 - rlat1
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(a))


def candidate_ids(course: dict) -> set[str]:
    """Every id a discovered course could plausibly be selected by: its own
    ``id``/``osm_id``, plus the deterministic UUID its write-through row
    would get (so a UUID selected from a mapped/search-added row matches an
    OSM/Places discovery hit with zero DB work)."""
    ids = {str(course.get("id") or ""), str(course.get("osm_id") or "")}
    key = course_finder.external_course_key(course)
    if key:
        ids.add(course_finder.deterministic_course_id(key))
    ids.discard("")
    return ids


def matches_selection(course: dict, selectors: Sequence[CourseSelector]) -> bool:
    """True iff any selector matches this discovered course.

    1. Exact id: ``selector.id`` is in ``candidate_ids(course)``.
    2. Name (normalized, exact — never substring) + proximity: for selectors
       carrying a resolved name, ``normalize(selector.name) ==
       normalize(course["name"])`` AND, when both sides have coordinates,
       haversine <= MATCH_RADIUS_MILES. Selector or course missing a center
       -> name equality alone (mirrors ``match_capability``)."""
    cids = candidate_ids(course)
    for sel in selectors:
        if sel.id and sel.id in cids:
            return True

    course_name = normalize(course.get("name") or "")
    if not course_name:
        return False
    center = course.get("center") or {}
    has_center = center.get("lat") is not None and center.get("lng") is not None

    for sel in selectors:
        if not sel.name:
            continue
        if normalize(sel.name) != course_name:
            continue
        if sel.lat is not None and sel.lng is not None and has_center:
            dist = _haversine_miles(sel.lat, sel.lng, center["lat"], center["lng"])
            if dist <= MATCH_RADIUS_MILES:
                return True
            continue  # same normalized name, outside the radius — not a match
        return True  # selector or course missing a center — name alone matches

    return False


async def resolve_selectors(course_ids: list[str]) -> list[CourseSelector]:
    """Resolve raw selected ids to ``CourseSelector``s, filling in
    name/center from the mapped ``courses`` table when the raw id (or a
    deterministic UUID derived from it) matches a row — rescues homegrown
    slug-keyed mapped courses (§1 of the plan), which have no derivable
    relationship to any discovery dict.

    NEVER raises: any DB/lookup failure degrades to id-only selectors, which
    still satisfy every direct-id candidate match."""
    if not course_ids:
        return []

    try:
        # Lazy import: app.services.courses_mapped pulls in app.db.engine at
        # module level, which raises at import time when DATABASE_URL is
        # unset. Deferring the import here keeps `selection.py` (and every
        # module that imports it, e.g. `base.py`) importable in DB-free unit
        # tests (fake finders, no DB) — only THIS call needs a real session.
        from app.services.courses_mapped import courses_by_ids

        lookup_keys_by_raw: dict[str, list[str]] = {}
        db_ids: set[str] = set()
        for raw in course_ids:
            keys: list[str] = []
            try:
                uuid.UUID(raw)
                keys.append(raw)
            except (ValueError, AttributeError, TypeError):
                pass
            keys.append(course_finder.deterministic_course_id(raw))
            keys.append(course_finder.deterministic_course_id(f"osm-{raw}"))
            lookup_keys_by_raw[raw] = keys
            db_ids.update(keys)

        rows = await courses_by_ids(sorted(db_ids))
        rows_by_id = {row["id"]: row for row in rows}

        selectors: list[CourseSelector] = []
        for raw in course_ids:
            row = None
            for key in lookup_keys_by_raw[raw]:
                if key in rows_by_id:
                    row = rows_by_id[key]
                    break
            if row is not None:
                selectors.append(
                    CourseSelector(id=raw, name=row.get("name"), lat=row.get("lat"), lng=row.get("lng"))
                )
            else:
                selectors.append(CourseSelector(id=raw))
        return selectors
    except Exception:
        log.warning("resolve_selectors: DB lookup failed — falling back to id-only selectors", exc_info=True)
        return [CourseSelector(id=raw) for raw in course_ids]
