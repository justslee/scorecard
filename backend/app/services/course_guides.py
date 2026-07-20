"""Preemptive per-hole strategy-guide research at course-mapping time.

specs/caddie-hole-strategy-guides-plan.md §6 + §12 (Slice 3). Lives in its own
small services module (not `caddie/guide_writer.py`, not `routes/caddie.py`)
so BOTH `routes/courses_mapped.py` (primary — ingest/re-map) and
`routes/caddie.py` (fallback — cold-course `/session/start`) can import the
precompute job without a route -> route circular import.

Two entry points:
  - `_precompute_course_guides(course_id)` — the per-course BackgroundTask.
    Best-effort (never raises), idempotent (skips any hole that already has
    a persisted `properties.strategy_guide` — guides are cached FOREVER).
    Fired automatically by user actions already scoped to ONE course, so it
    needs no extra guard.
  - `run_guide_backfill()` — a SEPARATE, deliberately-manual, env-gated bulk
    op over the EXISTING mapped-course catalog (courses mapped before this
    feature existed). NOT wired to any route or scheduler. See its docstring
    for the cost guard.
"""

from __future__ import annotations

from datetime import datetime, timezone

import logging
import os
from typing import Any, Optional

from app.caddie.guide_writer import (
    research_hole_guide,
    research_hole_lore,
    validate_guide,
    validate_lore,
)
from app.caddie.hazards import extract_hole_hazards
from app.services import courses_mapped

log = logging.getLogger("looper.course_guides")

# Preferred tee-set order for picking ONE representative yardage per hole for
# the writer prompt (mirrors courses_mapped.DEFAULT_TEE_SETS, longest first).
_TEE_PRIORITY: tuple[str, ...] = ("Black", "Blue", "White", "Red")


def _green_properties(stored_hole: dict) -> Optional[dict]:
    """The green feature's full persisted `properties` dict for one stored
    hole (as returned by `courses_mapped.get_course`), or None when the hole
    has no green feature yet."""
    feats = (stored_hole.get("features") or {}).get("features") or []
    for f in feats:
        props = f.get("properties") or {}
        if props.get("featureType") == "green":
            return props
    return None


def _primary_yards(yardages: dict[str, Any]) -> Optional[int]:
    """One representative yardage for the writer prompt — prefers the
    longest/back tee set, falls back to whatever tee is stored first. None
    when the hole has no yardages at all (never fabricated,
    [[no-fake-data-fallbacks]])."""
    if not yardages:
        return None
    for name in _TEE_PRIORITY:
        value = yardages.get(name)
        if value:
            return value
    return next(iter(yardages.values()), None)


async def _precompute_course_guides(course_id: str) -> None:
    """Research + cache a strategy guide for every hole of `course_id` that is
    MISSING one. Best-effort: NEVER raises (mirrors
    `caddie._precompute_course_elevations`). Idempotent: skips any hole that
    already has `properties.strategy_guide` — guides are cached FOREVER, so a
    course is only ever fully researched once regardless of how many times
    this fires (ingest, re-map, or the cold-course session-start fallback).
    """
    try:
        course = await courses_mapped.get_course(course_id)
        if not course:
            return

        for h in course.get("holes", []):
            hole_number = h.get("number")
            if not courses_mapped._valid_hole_number(hole_number):
                continue

            green_props = _green_properties(h)
            if green_props is None:
                # No green feature -> nothing to persist a guide INTO; researching
                # would re-spend on every trigger forever (reviewer finding #4).
                continue
            if green_props.get("strategy_guide") is not None:
                continue  # already cached forever -- idempotent skip
            if green_props.get("strategy_guide_attempted_at") is not None:
                # Negative cache (security-review blocking finding): a hole
                # whose research failed or whose guide was validator-rejected
                # must NOT re-spend on every session start forever. The
                # plan's staleness policy is a MANUAL re-research trigger
                # (clear this marker) — courses change rarely.
                continue

            hazards = extract_hole_hazards(h.get("features"), tee=h.get("tee"), green=h.get("green"))
            par = h.get("par") or 4
            yards = _primary_yards(h.get("yardages") or {})
            elevation_change_ft = (green_props or {}).get("delta_ft")
            green_slope = (green_props or {}).get("green_slope")

            try:
                await courses_mapped.update_green_feature_properties(
                    course_id, hole_number,
                    {"strategy_guide_attempted_at": datetime.now(timezone.utc).isoformat()},
                )
            except Exception:
                log.warning(
                    "guide attempt-marker write failed course=%s hole=%s", course_id, hole_number,
                    exc_info=True,
                )
                continue  # can't mark -> don't spend (runaway protection first)

            try:
                guide = await research_hole_guide(
                    hole_number, par, yards, green_slope, elevation_change_ft, hazards,
                )
                guide = validate_guide(guide, hazards)
            except Exception:
                log.warning(
                    "guide research failed course=%s hole=%s", course_id, hole_number,
                    exc_info=True,
                )
                continue  # honest: nothing written for this hole -- no placeholder

            if guide is None:
                log.info(
                    "guide rejected by grounding validation course=%s hole=%s",
                    course_id, hole_number,
                )
                continue  # rejected -> omit, never a placeholder

            try:
                await courses_mapped.update_green_feature_properties(
                    course_id, hole_number, {"strategy_guide": guide.model_dump()}
                )
            except Exception:
                log.warning(
                    "guide write-back failed course=%s hole=%s", course_id, hole_number,
                    exc_info=True,
                )
    except Exception:
        log.warning("guide precompute failed course=%s", course_id, exc_info=True)


# ── Guarded catalog backfill (operator-invoked; NOT auto-wired anywhere) ────
#
# The per-course precompute above fires automatically and is inherently safe
# (scoped to ONE course a human just created/edited/started a round on). A
# BULK backfill across the existing mapped-course catalog is a different,
# deliberately-manual operation — capped so a bug can't burn spend across the
# whole catalog (owner approved ~$1.5/course, NOT a runaway).
#
# Default allowlist is EMPTY (safe-by-default: a bare call is a no-op). Set
# GUIDE_BACKFILL_COURSES to a comma-separated list of mapped-course UUIDs to
# backfill — e.g. the owner's Bethpage course id, looked up via
# `GET /api/courses/mapped?search=Bethpage` before running this. We do NOT
# hardcode a guessed id here — an unverified UUID would be exactly the kind
# of fabricated data [[no-fake-data-fallbacks]] warns against; it's an
# operator input, not a code constant.
_GUIDE_BACKFILL_MAX_COURSES_DEFAULT = 1


def _backfill_course_ids() -> list[str]:
    """Env-gated allowlist, capped by `GUIDE_BACKFILL_MAX_COURSES` (default
    1) even if the allowlist itself is longer — the hard stop against a
    misconfigured env burning the whole catalog."""
    raw = os.getenv("GUIDE_BACKFILL_COURSES", "")
    ids = [c.strip() for c in raw.split(",") if c.strip()]
    try:
        max_courses = int(
            os.getenv("GUIDE_BACKFILL_MAX_COURSES", str(_GUIDE_BACKFILL_MAX_COURSES_DEFAULT))
        )
    except ValueError:
        max_courses = _GUIDE_BACKFILL_MAX_COURSES_DEFAULT
    max_courses = max(0, max_courses)
    return ids[:max_courses]


async def run_guide_backfill() -> None:
    """Operator-invoked, env-gated bulk backfill for ALREADY-mapped courses
    (courses mapped before this feature existed). NOT wired to any route or
    scheduler — run manually (e.g. a one-off shell/script) after setting
    `GUIDE_BACKFILL_COURSES`. Processes courses ONE AT A TIME, never
    concurrently, and is hard-capped by `GUIDE_BACKFILL_MAX_COURSES` (default
    1) regardless of allowlist size. Each course's precompute is itself
    idempotent/best-effort (see `_precompute_course_guides`) — a course that
    already has every hole guided is a cheap all-skip pass with ZERO LLM
    calls, so re-running this is always safe.
    """
    course_ids = _backfill_course_ids()
    if not course_ids:
        log.info("guide backfill: no courses configured (GUIDE_BACKFILL_COURSES unset) -- no-op")
        return
    for course_id in course_ids:
        log.info("guide backfill: starting course=%s", course_id)
        await _precompute_course_guides(course_id)
        log.info("guide backfill: finished course=%s", course_id)


# ── LOCAL-LORE backfill (specs/caddie-guide-local-lore-plan.md §5) ─────────
#
# A SEPARATE, deliberately-manual, env-gated bulk op — NOT wired into
# `_precompute_course_guides` or any route/scheduler (the tactical precompute
# above never fires lore). Lore only ever appends to a hole that ALREADY has
# a persisted tactical `strategy_guide`; it never researches a hole on its
# own. `update_green_feature_properties`'s JSONB merge is SHALLOW at the
# `properties` top level, so writing `{"strategy_guide": {...}}` REPLACES the
# entire guide object — every write here is read-modify-write, merging the
# lore fields into a full copy of the existing guide, never a partial one.
#
# IMPORTANT — do not run this concurrently with `run_guide_backfill()` or
# `scripts/regen_rejected_guides.py`. Both of those ALSO write the whole
# `strategy_guide` object; a concurrent tactical rewrite racing this
# read-modify-write can silently drop whichever side loses the race. All
# three are manual, operator-invoked ops — sequence them, never overlap them.


async def _precompute_course_lore(course_id: str) -> None:
    """Research + cache local-lore for every hole of `course_id` that already
    has a tactical `strategy_guide` but no lore yet. Best-effort: NEVER
    raises. Idempotent: skips a hole whose guide already carries `local_lore`
    (lore, like the tactical guide, is cached FOREVER) and negative-cached
    via the NEW `lore_attempted_at` marker — distinct from
    `strategy_guide_attempted_at`, so a lore attempt never masks (or is
    masked by) the tactical guide's own attempt marker.
    """
    try:
        course = await courses_mapped.get_course(course_id)
        if not course:
            return
        course_name = (course.get("name") or "").strip()
        if not course_name:
            log.warning("lore precompute: course %s has no name -- skipping", course_id)
            return

        for h in course.get("holes", []):
            hole_number = h.get("number")
            if not courses_mapped._valid_hole_number(hole_number):
                continue

            green_props = _green_properties(h)
            if green_props is None:
                continue  # no green feature -> nothing to persist lore INTO

            existing_guide = green_props.get("strategy_guide")
            if existing_guide is None:
                continue  # lore only appends to a hole that HAS a tactical guide
            if existing_guide.get("local_lore"):
                continue  # already cached forever -- idempotent skip
            if green_props.get("lore_attempted_at") is not None:
                # Negative cache, distinct from strategy_guide_attempted_at —
                # a hole whose lore research failed or whose items all got
                # dropped must not re-spend on every backfill run forever.
                continue

            hazards = extract_hole_hazards(h.get("features"), tee=h.get("tee"), green=h.get("green"))
            par = h.get("par") or 4
            yards = _primary_yards(h.get("yardages") or {})
            elevation_change_ft = (green_props or {}).get("delta_ft")
            green_slope = (green_props or {}).get("green_slope")

            try:
                await courses_mapped.update_green_feature_properties(
                    course_id, hole_number,
                    {"lore_attempted_at": datetime.now(timezone.utc).isoformat()},
                )
            except Exception:
                log.warning(
                    "lore attempt-marker write failed course=%s hole=%s", course_id, hole_number,
                    exc_info=True,
                )
                continue  # can't mark -> don't spend (runaway protection first)

            try:
                result = await research_hole_lore(
                    course_name, hole_number, par, yards, green_slope, elevation_change_ft, hazards,
                )
            except Exception:
                log.warning(
                    "lore research failed course=%s hole=%s", course_id, hole_number,
                    exc_info=True,
                )
                continue  # honest: nothing written for this hole -- no placeholder

            survivors = validate_lore(result.items, hazards)
            if not survivors:
                log.info(
                    "lore: no items survived validation course=%s hole=%s", course_id, hole_number,
                )
                continue  # rejected -> omit, never a placeholder

            # Read-modify-write (load-bearing, §5.1 step 8): the JSONB merge
            # is SHALLOW at the `properties` top level, so a bare
            # {"strategy_guide": {...local-lore-only...}} would REPLACE the
            # entire guide object and silently destroy every tactical byte.
            merged = {
                **existing_guide,   # every tactical byte, verbatim
                "local_lore": [i.model_dump() for i in survivors],
                "lore_generated_at": result.generated_at,
                "lore_model": result.model,
                "lore_sources": list(result.sources),
            }
            try:
                await courses_mapped.update_green_feature_properties(
                    course_id, hole_number, {"strategy_guide": merged}
                )
            except Exception:
                log.warning(
                    "lore write-back failed course=%s hole=%s", course_id, hole_number,
                    exc_info=True,
                )
    except Exception:
        log.warning("lore precompute failed course=%s", course_id, exc_info=True)


_LORE_BACKFILL_MAX_COURSES_DEFAULT = 1


def _lore_backfill_course_ids() -> list[str]:
    """Env-gated allowlist, capped by `LORE_BACKFILL_MAX_COURSES` (default
    1) — fully independent of `GUIDE_BACKFILL_COURSES`/`_MAX_COURSES` (a
    separate op, a separate env pair)."""
    raw = os.getenv("LORE_BACKFILL_COURSES", "")
    ids = [c.strip() for c in raw.split(",") if c.strip()]
    try:
        max_courses = int(
            os.getenv("LORE_BACKFILL_MAX_COURSES", str(_LORE_BACKFILL_MAX_COURSES_DEFAULT))
        )
    except ValueError:
        max_courses = _LORE_BACKFILL_MAX_COURSES_DEFAULT
    max_courses = max(0, max_courses)
    return ids[:max_courses]


async def run_lore_backfill() -> None:
    """Operator-invoked, env-gated bulk lore backfill for courses that
    already have tactical strategy guides. NOT wired to any route or
    scheduler — run manually after setting `LORE_BACKFILL_COURSES`.
    Processes courses ONE AT A TIME, hard-capped by
    `LORE_BACKFILL_MAX_COURSES` (default 1).

    Do NOT run this concurrently with `run_guide_backfill()` or
    `scripts/regen_rejected_guides.py` — both of those write the whole
    `strategy_guide` object too, so a concurrent tactical rewrite races this
    function's read-modify-write. All three are manual ops; sequence them.
    """
    course_ids = _lore_backfill_course_ids()
    if not course_ids:
        log.info("lore backfill: no courses configured (LORE_BACKFILL_COURSES unset) -- no-op")
        return
    for course_id in course_ids:
        log.info("lore backfill: starting course=%s", course_id)
        await _precompute_course_lore(course_id)
        log.info("lore backfill: finished course=%s", course_id)
