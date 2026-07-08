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

from app.caddie.guide_writer import research_hole_guide, validate_guide
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
