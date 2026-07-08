"""Unit tests for app/services/course_guides.py — the preemptive per-hole
strategy-guide precompute BackgroundTask (plan §6, §12 Slice 3).

No network, no database. `_precompute_course_guides` calls `courses_mapped`
(which transitively imports `app.db.engine`, raising at import time without
`DATABASE_URL`) — we set a placeholder `DATABASE_URL` before import so the
(lazy — `create_async_engine` never connects at import time) SQLAlchemy
engine can be constructed with zero network I/O. NOTE: we deliberately do
NOT stub `sys.modules["app.db"]` with a `MagicMock` (the pattern used by
`test_course_intel_static_read.py`) — that stub is collection-order-fragile:
whichever test file hits it FIRST in the alphabetically-sorted test session
permanently replaces the real `app.db.models` classes (e.g. `CaddieMemory`)
with `MagicMock` attributes for the rest of the process, which silently broke
an unrelated test (`test_voice_stream.py`) purely because this new file
happened to sort earlier. All I/O (`courses_mapped.get_course`,
`courses_mapped.update_green_feature_properties`,
`guide_writer.research_hole_guide`, `guide_writer.validate_guide`) is
monkeypatched regardless.

Covers failure-honesty (plan §10) at the precompute layer specifically:
  - a research failure -> nothing written for that hole, job continues
  - a validation rejection -> nothing written for that hole, job continues
  - a write-back failure -> best-effort, job continues to the next hole
  - idempotent skip: a hole with an existing `strategy_guide` never triggers
    research/validation at all (ZERO LLM calls, matching the cost contract)
  - success: an accepted guide is written via `update_green_feature_properties`
    with exactly the `{"strategy_guide": ...}` patch
"""

from __future__ import annotations

import os

# `create_async_engine` (app/db/engine.py) is LAZY — building it performs
# zero network I/O, it only raises if DATABASE_URL is unset. A placeholder
# value lets `app.services.courses_mapped` / `app.services.course_guides`
# import cleanly with no real database and no sys.modules stubbing (see the
# module docstring for why we avoid the MagicMock-stub pattern here).
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/test")

from unittest.mock import AsyncMock, MagicMock  # noqa: E402

import pytest  # noqa: E402

from app.services import course_guides  # noqa: E402
from app.caddie.types import HoleStrategyGuide  # noqa: E402


def _course(holes: list[dict]) -> dict:
    return {"id": "course-1", "holes": holes}


def _hole(number: int, *, guide: dict | None = None, par: int = 4, yards: int = 400) -> dict:
    green_props: dict = {"featureType": "green"}
    if guide is not None:
        green_props["strategy_guide"] = guide
    return {
        "number": number,
        "par": par,
        "yardages": {"Blue": yards},
        "features": {
            "type": "FeatureCollection",
            "features": [{"type": "Feature", "properties": green_props, "geometry": {}}],
        },
    }


def _guide() -> HoleStrategyGuide:
    return HoleStrategyGuide(play_line="Favor the center of the fairway.")


@pytest.mark.asyncio
async def test_already_guided_hole_is_skipped_with_zero_llm_calls(monkeypatch):
    """Idempotent skip: a hole with a persisted `strategy_guide` never
    triggers research/validation — the cost contract (cached forever)."""
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course([_hole(1, guide={"play_line": "already cached"})])),
    )
    research = AsyncMock(side_effect=AssertionError("must not research an already-guided hole"))
    monkeypatch.setattr(course_guides, "research_hole_guide", research)
    write = AsyncMock()
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_guides("course-1")

    research.assert_not_called()
    write.assert_not_called()


@pytest.mark.asyncio
async def test_research_failure_writes_nothing_and_never_raises(monkeypatch):
    """Failure-honesty (§10): a research exception must not sink the job and
    must never fabricate/write a placeholder guide for that hole."""
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course([_hole(1)])),
    )
    monkeypatch.setattr(
        course_guides, "research_hole_guide",
        AsyncMock(side_effect=RuntimeError("network error")),
    )
    write = AsyncMock()
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_guides("course-1")  # must not raise

    # New contract (security review): the attempt MARKER is written first
    # (negative cache — failed holes never re-spend per session), but no
    # guide/placeholder is ever written.
    assert write.await_count == 1
    marker_patch = write.await_args_list[0].args[2]
    assert set(marker_patch.keys()) == {"strategy_guide_attempted_at"}


@pytest.mark.asyncio
async def test_validation_rejection_writes_nothing(monkeypatch):
    """Failure-honesty (§10): a grounding-rejected guide (validate_guide ->
    None) must never be persisted — omit, not a placeholder."""
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course([_hole(1)])),
    )
    monkeypatch.setattr(course_guides, "research_hole_guide", AsyncMock(return_value=_guide()))
    monkeypatch.setattr(course_guides, "validate_guide", MagicMock(return_value=None))
    write = AsyncMock()
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_guides("course-1")

    # Marker only — a rejected guide is never persisted (omit, no placeholder).
    assert write.await_count == 1
    marker_patch = write.await_args_list[0].args[2]
    assert set(marker_patch.keys()) == {"strategy_guide_attempted_at"}


@pytest.mark.asyncio
async def test_write_back_failure_is_best_effort_and_continues(monkeypatch):
    """A write-back exception on one hole must not sink the whole course's
    precompute (best-effort, mirrors `_precompute_course_elevations`)."""
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course([_hole(1), _hole(2)])),
    )
    monkeypatch.setattr(course_guides, "research_hole_guide", AsyncMock(return_value=_guide()))
    monkeypatch.setattr(course_guides, "validate_guide", MagicMock(side_effect=lambda g, h: g))
    write = AsyncMock(side_effect=RuntimeError("db write failed"))
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_guides("course-1")  # must not raise

    assert write.call_count == 2  # both holes attempted despite the failure


@pytest.mark.asyncio
async def test_accepted_guide_is_written_with_exact_patch_shape(monkeypatch):
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course([_hole(1)])),
    )
    guide = _guide()
    monkeypatch.setattr(course_guides, "research_hole_guide", AsyncMock(return_value=guide))
    monkeypatch.setattr(course_guides, "validate_guide", MagicMock(side_effect=lambda g, h: g))
    write = AsyncMock(return_value=True)
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_guides("course-1")

    # Marker first (runaway protection), then the exact guide patch.
    assert write.await_count == 2
    assert set(write.await_args_list[0].args[2].keys()) == {"strategy_guide_attempted_at"}
    assert write.await_args_list[1].args == ("course-1", 1, {"strategy_guide": guide.model_dump()})


@pytest.mark.asyncio
async def test_missing_course_is_a_no_op(monkeypatch):
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course", AsyncMock(return_value=None)
    )
    research = AsyncMock(side_effect=AssertionError("must not research when course is missing"))
    monkeypatch.setattr(course_guides, "research_hole_guide", research)

    await course_guides._precompute_course_guides("missing-course")  # must not raise

    research.assert_not_called()


# ── Guarded backfill (env-gated, capped) ─────────────────────────────────────


@pytest.mark.asyncio
async def test_backfill_is_a_no_op_with_empty_allowlist(monkeypatch):
    """Default allowlist is empty — safe-by-default, a bare call never
    triggers any research."""
    monkeypatch.delenv("GUIDE_BACKFILL_COURSES", raising=False)
    precompute = AsyncMock()
    monkeypatch.setattr(course_guides, "_precompute_course_guides", precompute)

    await course_guides.run_guide_backfill()

    precompute.assert_not_called()


@pytest.mark.asyncio
async def test_backfill_is_capped_by_max_courses_even_with_a_longer_allowlist(monkeypatch):
    monkeypatch.setenv("GUIDE_BACKFILL_COURSES", "course-a,course-b,course-c")
    monkeypatch.setenv("GUIDE_BACKFILL_MAX_COURSES", "1")
    precompute = AsyncMock()
    monkeypatch.setattr(course_guides, "_precompute_course_guides", precompute)

    await course_guides.run_guide_backfill()

    precompute.assert_awaited_once_with("course-a")


@pytest.mark.asyncio
async def test_attempted_hole_is_never_re_researched(monkeypatch):
    """Negative cache (security-review blocking finding): a hole with an
    attempt marker must not re-spend research on later triggers."""
    hole = _hole(1)
    hole["features"]["features"][0]["properties"]["strategy_guide_attempted_at"] = (
        "2026-07-09T00:00:00+00:00"
    )
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course([hole])),
    )
    research = AsyncMock(side_effect=AssertionError("must not re-research an attempted hole"))
    monkeypatch.setattr(course_guides, "research_hole_guide", research)
    write = AsyncMock()
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_guides("course-1")

    research.assert_not_called()
    write.assert_not_called()
