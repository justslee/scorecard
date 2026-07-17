"""Course-discovery intel: precomputed Augusta-styled description cache +
pure-DB `CourseIntel` aggregation for `GET /api/courses/{id}/intel`.

Sibling of `app/services/course_guides.py` — same discipline. NOT
`app.caddie.course_intel` (the live per-hole caddie intelligence builder,
a distinct pre-existing system) — never imported here.

Two responsibilities:
  - `_precompute_course_intel(course_id)` / `run_course_intel_backfill()` —
    the ONE-Claude-call-per-course description precompute (fired as a
    BackgroundTask from `routes/courses_mapped.py`, AFTER the strategy-guide
    precompute) + its guarded, manual backfill entry point. Best-effort:
    never raises. Idempotent: skips if a description OR an attempt marker is
    already cached — negative-cached on failure/rejection so a bad course
    never re-spends on every trigger.
  - `get_course_intel_payload(course_id, owner_id)` — the pure-DB read
    behind the route. NEVER calls `courses_mapped.get_course` for STATS
    (its 18-hole default-fill fabricates par-4 placeholders that would
    invent a par-72 course out of a 3-hole-mapped one) — direct SQL / ORM
    selects only. `/intel` never calls Claude inline; description comes
    from the precomputed cache only.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select, text

from app.caddie.course_intel_writer import (
    build_course_ground_truth_block,
    validate_course_description,
    write_course_description,
)
from app.db.engine import async_session
from app.db.models import CourseReview as CourseReviewORM
from app.db.models import Round as RoundORM
from app.db.models import RoundPlayer as RoundPlayerORM
from app.db.models import Score as ScoreORM
from app.models import CourseIntel, CourseIntelDescription, CourseIntelStars, CourseIntelStats
from app.services import courses_mapped

log = logging.getLogger("looper.course_intel")

# Stored blob's `facts_used` entries are snake_case (the writer/validator's
# internal field names — §1 of the plan's stored-column example); the wire
# contract (`CourseIntelDescription.factsUsed`, types.ts) is camelCase.
# Translated in ONE place so the DB blob and the wire shape can never drift.
_FACT_KEY_TO_CAMEL: dict[str, str] = {
    "architect": "architect",
    "year_built": "yearBuilt",
    "style_notes": "styleNotes",
    "notable_history": "notableHistory",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _real_holes(course: dict) -> list[dict]:
    """Same "real hole" test as `course_intel_writer._real_holes` — a hole
    counts iff it has a non-empty feature collection or a non-zero stored
    yardage, filtering out `get_course`'s 18-hole default-fill."""
    holes = course.get("holes") or []
    return [
        h for h in holes
        if ((h.get("features") or {}).get("features"))
        or any(v for v in (h.get("yardages") or {}).values())
    ]


# ── Precompute (idempotent, negative-cached, best-effort) ──────────────────


async def _precompute_course_intel(course_id: str) -> None:
    """Research + cache an Augusta-styled description for `course_id` if
    missing. Best-effort: NEVER raises (mirrors
    `course_guides._precompute_course_guides`). Idempotent: skips when a
    `description` OR an `attempted_at` marker is already present — a course
    is only ever written-to-spend once, negative-cached on failure/rejection
    so a bad course never re-spends on every trigger (ingest, re-map, or a
    later manual backfill re-run)."""
    try:
        blob = await courses_mapped.get_course_intel_blob(course_id)
        if blob.get("description") is not None or blob.get("attempted_at") is not None:
            return  # already cached (forever), or already attempted (negative cache)

        course = await courses_mapped.get_course(course_id)
        if not course:
            return

        real_holes = _real_holes(course)
        if not real_holes:
            # No real geometry -> a landscape description needs geometry to
            # ground itself in. Skip entirely: no marker, no spend — a
            # course mapped later can still be precomputed then.
            return

        try:
            marked = await courses_mapped.merge_course_intel_blob(
                course_id, {"attempted_at": _now_iso()}
            )
        except Exception:
            log.warning(
                "course intel attempt-marker write failed course=%s", course_id, exc_info=True
            )
            return  # can't mark -> don't spend (runaway protection first)
        if not marked:
            return

        ground_truth = build_course_ground_truth_block(course)
        par_total = sum(h.get("par") or 0 for h in real_holes) or None

        try:
            draft = await write_course_description(
                course["name"], course.get("address"), ground_truth
            )
            composed = validate_course_description(draft, par_total)
        except Exception:
            log.warning("course intel research failed course=%s", course_id, exc_info=True)
            return  # honest: nothing beyond the marker is ever written -- no placeholder

        if composed is None:
            log.info("course intel rejected by validation course=%s", course_id)
            return  # rejected -> omit, never a placeholder

        try:
            await courses_mapped.merge_course_intel_blob(course_id, {"description": composed})
        except Exception:
            log.warning("course intel write-back failed course=%s", course_id, exc_info=True)
    except Exception:
        log.warning("course intel precompute failed course=%s", course_id, exc_info=True)


# ── Guarded catalog backfill (operator-invoked; NOT auto-wired anywhere) ────
#
# Mirrors `course_guides.run_guide_backfill` exactly, at course-description
# scope. Default allowlist is EMPTY (safe-by-default: a bare call is a
# no-op). Set COURSE_INTEL_BACKFILL_COURSES to a comma-separated list of
# mapped-course UUIDs — e.g. the owner's Bethpage Black/Red + Pebble Beach
# ids, looked up via `GET /api/courses/mapped?search=…` before running this.
# We do NOT hardcode a guessed id here — an unverified UUID is exactly the
# kind of fabricated data [[no-fake-data-fallbacks]] warns against.
_COURSE_INTEL_BACKFILL_MAX_COURSES_DEFAULT = 1


def _backfill_course_ids() -> list[str]:
    """Env-gated allowlist, capped by `COURSE_INTEL_BACKFILL_MAX_COURSES`
    (default 1) even if the allowlist itself is longer."""
    raw = os.getenv("COURSE_INTEL_BACKFILL_COURSES", "")
    ids = [c.strip() for c in raw.split(",") if c.strip()]
    try:
        max_courses = int(
            os.getenv(
                "COURSE_INTEL_BACKFILL_MAX_COURSES",
                str(_COURSE_INTEL_BACKFILL_MAX_COURSES_DEFAULT),
            )
        )
    except ValueError:
        max_courses = _COURSE_INTEL_BACKFILL_MAX_COURSES_DEFAULT
    max_courses = max(0, max_courses)
    return ids[:max_courses]


async def run_course_intel_backfill() -> None:
    """Operator-invoked, env-gated bulk backfill for the seed set (Bethpage
    Black, Bethpage Red, Pebble Beach) or any already-mapped course. NOT
    wired to any route or scheduler — run manually after setting
    `COURSE_INTEL_BACKFILL_COURSES`. Processes courses ONE AT A TIME. Each
    course's precompute is itself idempotent/best-effort — a course that
    already has a cached description or attempt marker is a cheap all-skip
    pass with ZERO LLM calls, so re-running this is always safe.
    """
    course_ids = _backfill_course_ids()
    if not course_ids:
        log.info(
            "course intel backfill: no courses configured "
            "(COURSE_INTEL_BACKFILL_COURSES unset) -- no-op"
        )
        return
    for course_id in course_ids:
        log.info("course intel backfill: starting course=%s", course_id)
        await _precompute_course_intel(course_id)
        log.info("course intel backfill: finished course=%s", course_id)


# ── CourseIntel aggregation (GET /api/courses/{id}/intel) ──────────────────


def _description_from_blob(blob: dict) -> CourseIntelDescription:
    desc = blob.get("description")
    if not isinstance(desc, dict):
        return CourseIntelDescription(
            text=None, provenance=None, factsUsed=[], generatedAt=None, model=None
        )
    facts_used_raw = desc.get("facts_used") or []
    facts_used = [_FACT_KEY_TO_CAMEL.get(f, f) for f in facts_used_raw]
    return CourseIntelDescription(
        text=desc.get("text"),
        provenance=desc.get("provenance"),
        factsUsed=facts_used,
        generatedAt=desc.get("generated_at"),
        model=desc.get("model"),
    )


async def get_course_intel_payload(course_id: str, owner_id: str) -> CourseIntel:
    """Pure-DB aggregation behind `GET /api/courses/{id}/intel`. Never raises
    for a well-formed id: an empty/missing courses row (or one with no
    reviews/holes/rounds) simply yields all-null/zero fields — never a 404
    (the route's contract, plan §0 decision 5). Reads only Postgres —
    `course_reviews`, `holes`, `hole_yardages`, `tee_sets`, `rounds`,
    `scores`, and the cached `course_intel` jsonb column. NO LLM call, NO
    Places/GolfAPI call.
    """
    blob = await courses_mapped.get_course_intel_blob(course_id)
    description = _description_from_blob(blob)

    async with async_session() as db:
        # ── stars — owner-scoped, exact identity CourseDetailClient.tsx
        # already passes for a mapped course's course_key (plan §0 decision 6).
        stars_row = (
            await db.execute(
                select(func.avg(CourseReviewORM.rating), func.count(CourseReviewORM.id)).where(
                    CourseReviewORM.course_key == course_id,
                    CourseReviewORM.owner_id == owner_id,
                )
            )
        ).first()
        stars_count = int(stars_row[1] or 0) if stars_row else 0
        stars_avg = (
            float(stars_row[0])
            if stars_row is not None and stars_row[0] is not None and stars_count > 0
            else None
        )

        # ── par / holes-mapped — direct SQL over public.holes, NEVER
        # courses_mapped.get_course (its 18-hole default-fill fabricates
        # par-4 placeholders — see the module docstring).
        holes_row = (
            await db.execute(
                text(
                    "select coalesce(sum(par), 0) as par_total, count(*) as holes_mapped "
                    "from public.holes where course_id = :id"
                ),
                {"id": course_id},
            )
        ).mappings().first()
        holes_mapped = int(holes_row["holes_mapped"] or 0) if holes_row else 0
        par_total = int(holes_row["par_total"] or 0) if holes_mapped > 0 else None

        # ── yardage by tee — join hole_yardages -> holes -> tee_sets.
        yardage_rows = (
            await db.execute(
                text(
                    """
                    select ts.name as tee_name, sum(hy.yards) as total_yards
                    from public.hole_yardages hy
                    join public.holes h on h.id = hy.hole_id
                    join public.tee_sets ts on ts.id = hy.tee_set_id
                    where h.course_id = :id
                    group by ts.name
                    """
                ),
                {"id": course_id},
            )
        ).mappings().all()
        yardage_by_tee = (
            {r["tee_name"]: int(r["total_yards"] or 0) for r in yardage_rows}
            if yardage_rows
            else None
        )

        # ── roundsPlayed — NOT owner-scoped (PM decision, plan §): honest by
        # construction. A round whose mapped_course_id was never resolved
        # (legacy rows, or a round anchored to a different course) simply
        # doesn't count — never estimated or backfilled.
        rounds_result = await db.execute(
            select(RoundORM.id, RoundORM.owner_player_id).where(
                RoundORM.mapped_course_id == course_id
            )
        )
        round_rows = rounds_result.all()
        rounds_played = len(round_rows)

        # ── avgScore — only over COMPLETE rounds (every mapped hole scored
        # for the owner's player in that round). Small result sets at
        # single-user scale; done in Python over already-fetched rows rather
        # than a heavier SQL aggregate.
        avg_score: Optional[float] = None
        if holes_mapped > 0 and round_rows:
            hole_number_rows = await db.execute(
                text("select hole_number from public.holes where course_id = :id"),
                {"id": course_id},
            )
            mapped_hole_numbers = {r[0] for r in hole_number_rows.all()}

            complete_totals: list[int] = []
            for round_id, owner_player_id in round_rows:
                player_id = owner_player_id
                if not player_id:
                    # Legacy fallback: the first round_player row, same
                    # established fallback as routes/rounds.py:102.
                    rp_result = await db.execute(
                        select(RoundPlayerORM.player_id)
                        .where(RoundPlayerORM.round_id == round_id)
                        .limit(1)
                    )
                    player_id = rp_result.scalars().first()
                if not player_id:
                    continue

                score_result = await db.execute(
                    select(ScoreORM.hole_number, ScoreORM.strokes).where(
                        ScoreORM.round_id == round_id,
                        ScoreORM.player_id == player_id,
                        ScoreORM.strokes.isnot(None),
                    )
                )
                scored = {hn: strokes for hn, strokes in score_result.all()}
                if mapped_hole_numbers and mapped_hole_numbers.issubset(scored.keys()):
                    complete_totals.append(sum(scored[hn] for hn in mapped_hole_numbers))

            if complete_totals:
                avg_score = sum(complete_totals) / len(complete_totals)

    return CourseIntel(
        courseId=course_id,
        description=description,
        stars=CourseIntelStars(avg=stars_avg, count=stars_count),
        stats=CourseIntelStats(
            parTotal=par_total,
            yardageByTee=yardage_by_tee,
            holesMapped=holes_mapped or None,
            roundsPlayed=rounds_played,
            avgScore=avg_score,
        ),
    )
