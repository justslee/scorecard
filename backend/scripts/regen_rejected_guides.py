#!/usr/bin/env python3
"""Operator script: clear the strategy-guide negative-cache marker for
specific holes and re-research them (guide-validator-carry-span-plan.md §5).

Context
-------
`_precompute_course_guides` (app/services/course_guides.py) never re-attempts
a hole once `properties.strategy_guide_attempted_at` is set — a hole whose
guide was validator-rejected stays "negative-cached" honest-empty FOREVER
(by design: no fabricated placeholder, no re-spend on every session start).
The carry-span acceptance fix closes a false-reject class in the validator;
some of those negative-cached holes may now validate. This script clears the
marker for an EXPLICIT, capped, operator-chosen set of holes so
`_precompute_course_guides` re-attempts them on its next run.

Clearing mechanism (confirmed from `courses_mapped.update_green_feature_properties`):
a JSONB merge `properties || cast(:patch as jsonb)`. Passing
`{"strategy_guide_attempted_at": None}` serializes to JSON `null`; the `||`
merge REPLACES the key's value with `null` (the key stays present, it is NOT
deleted). `get_course` then returns the property as Python `None`, and the
negative-cache guard (`if green_props.get("strategy_guide_attempted_at") is
not None: continue`) reads that as "never attempted" -> the hole is
re-researched. The `strategy_guide` key itself is untouched by this merge.

Spec
----
- Env gate `REGEN_GUIDES` = `course_id:hole,hole;course_id:hole,...` (empty
  ⇒ no-op, safe-by-default — mirrors `GUIDE_BACKFILL_COURSES`'s discipline in
  app/services/course_guides.py).
- Hard cap `REGEN_GUIDES_MAX_HOLES` (default 10) across the WHOLE spec, not
  per-course — the hard stop against a misconfigured env burning spend
  across a large batch.
- Per hole: fetch the course via `courses_mapped.get_course`; SKIP (log) any
  hole that already HAS a persisted `strategy_guide` (never clear a marker
  under a live guide — that would only re-spend for nothing) or that has NO
  `strategy_guide_attempted_at` marker (nothing to clear); otherwise clear
  the marker.
- Then run `_precompute_course_guides(course_id)` ONCE per course with >=1
  cleared hole — it skips every guided/still-marked hole, so only the
  cleared holes re-research.
- `--dry-run`: still reads the DB to report exactly what WOULD be cleared,
  writes nothing.

Usage
-----
    REGEN_GUIDES="269e1f2e-65cc-5cf6-a9b0-f5908e298155:1,8,18;2b8caab5-2c55-5752-8cda-336c3a396dac:7,11" \\
        uv run backend/scripts/regen_rejected_guides.py --dry-run

    REGEN_GUIDES="269e1f2e-65cc-5cf6-a9b0-f5908e298155:1,8,18;2b8caab5-2c55-5752-8cda-336c3a396dac:7,11" \\
        uv run backend/scripts/regen_rejected_guides.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

# Make the backend package importable when run from the repo root or backend/.
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))

_REGEN_GUIDES_MAX_HOLES_DEFAULT = 10


# ── REGEN_GUIDES spec parsing (pure, offline-testable — no DB, no import of
# any DB-touching module) ───────────────────────────────────────────────────


def parse_regen_guides_spec(raw: str, max_holes: int) -> list[tuple[str, list[int]]]:
    """Parse `REGEN_GUIDES` = `course_id:hole,hole;course_id:hole,...` into
    an ordered list of `(course_id, [hole_number, ...])` pairs.

    Blank/whitespace-only input -> `[]` (safe-by-default no-op, mirrors
    `GUIDE_BACKFILL_COURSES`). Malformed chunks (missing `:`, empty course
    id, non-digit hole tokens) are skipped rather than raising — this is
    operator input, not a code constant load, and a typo in one course's
    holes shouldn't crash the whole run.

    `max_holes` is a HARD CAP on the TOTAL number of `(course_id, hole)`
    pairs across the ENTIRE spec (not per-course) — once the cap is hit,
    every remaining hole/course chunk is dropped. `max_holes <= 0` yields
    `[]`. This is the same "hard stop against a misconfigured env burning
    spend" discipline as `course_guides._backfill_course_ids`'s
    `GUIDE_BACKFILL_MAX_COURSES` cap.
    """
    raw = (raw or "").strip()
    if not raw:
        return []
    max_holes = max(0, max_holes)
    if max_holes == 0:
        return []

    result: list[tuple[str, list[int]]] = []
    remaining = max_holes
    for course_chunk in raw.split(";"):
        course_chunk = course_chunk.strip()
        if not course_chunk or ":" not in course_chunk:
            continue
        course_id, holes_raw = course_chunk.split(":", 1)
        course_id = course_id.strip()
        if not course_id:
            continue

        holes: list[int] = []
        for token in holes_raw.split(","):
            token = token.strip()
            if not token.isdigit():
                continue
            if remaining <= 0:
                break
            holes.append(int(token))
            remaining -= 1

        if holes:
            result.append((course_id, holes))
        if remaining <= 0:
            break
    return result


def _max_holes_from_env() -> int:
    try:
        return int(os.getenv("REGEN_GUIDES_MAX_HOLES", str(_REGEN_GUIDES_MAX_HOLES_DEFAULT)))
    except ValueError:
        return _REGEN_GUIDES_MAX_HOLES_DEFAULT


# ── The DB-touching op (late-imported so the parser above stays importable/
# testable with zero DB engine initialisation) ─────────────────────────────


async def _regen(course_specs: list[tuple[str, list[int]]], dry_run: bool) -> None:
    # Late import: keeps DB engine init out of the pure-parser test path and
    # matches ingest_osm_course.py's "late import keeps DB engine
    # initialisation out of dry-run paths" idiom (here dry-run still READS
    # the DB to report what it would clear, so the import happens once we
    # know there is at least one course to process).
    from app.services.course_guides import _green_properties, _precompute_course_guides  # noqa: PLC0415
    from app.services.courses_mapped import get_course, update_green_feature_properties  # noqa: PLC0415

    for course_id, hole_numbers in course_specs:
        course = await get_course(course_id)
        if not course:
            print(f"SKIP course={course_id}: not found", flush=True)
            continue

        holes_by_number = {h.get("number"): h for h in course.get("holes", [])}
        cleared: list[int] = []
        for hole_number in hole_numbers:
            hole = holes_by_number.get(hole_number)
            if hole is None:
                print(f"SKIP course={course_id} hole={hole_number}: hole not found", flush=True)
                continue

            green_props = _green_properties(hole)
            if green_props is None:
                print(f"SKIP course={course_id} hole={hole_number}: no green feature", flush=True)
                continue
            if green_props.get("strategy_guide") is not None:
                print(
                    f"SKIP course={course_id} hole={hole_number}: already has a live "
                    "strategy_guide (never clear the marker under a live guide)",
                    flush=True,
                )
                continue
            if green_props.get("strategy_guide_attempted_at") is None:
                print(
                    f"SKIP course={course_id} hole={hole_number}: no "
                    "strategy_guide_attempted_at marker (nothing to clear)",
                    flush=True,
                )
                continue

            if dry_run:
                print(f"DRY-RUN would clear course={course_id} hole={hole_number}", flush=True)
                cleared.append(hole_number)
                continue

            ok = await update_green_feature_properties(
                course_id, hole_number, {"strategy_guide_attempted_at": None},
            )
            if ok:
                print(f"cleared course={course_id} hole={hole_number}", flush=True)
                cleared.append(hole_number)
            else:
                print(f"WARNING: clear failed course={course_id} hole={hole_number}", flush=True)

        if not cleared:
            print(f"course={course_id}: nothing cleared -- skipping precompute", flush=True)
            continue

        if dry_run:
            print(
                f"DRY-RUN would run _precompute_course_guides(course={course_id}) "
                f"for cleared hole(s) {cleared}",
                flush=True,
            )
            continue

        print(f"course={course_id}: re-researching {len(cleared)} cleared hole(s) …", flush=True)
        await _precompute_course_guides(course_id)
        print(f"course={course_id}: precompute pass complete", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print exactly what would be cleared/re-researched; write nothing.",
    )
    args = parser.parse_args()

    raw = os.getenv("REGEN_GUIDES", "")
    max_holes = _max_holes_from_env()
    course_specs = parse_regen_guides_spec(raw, max_holes)
    if not course_specs:
        print(
            "regen_rejected_guides: no holes configured (REGEN_GUIDES unset/empty) -- no-op",
            flush=True,
        )
        return

    total_holes = sum(len(holes) for _, holes in course_specs)
    print(
        f"regen_rejected_guides: {len(course_specs)} course(s), {total_holes} hole(s) "
        f"requested (cap={max_holes}) dry_run={args.dry_run}",
        flush=True,
    )
    asyncio.run(_regen(course_specs, args.dry_run))


if __name__ == "__main__":
    main()
