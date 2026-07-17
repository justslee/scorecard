"""Unit tests for app/services/course_intel.py — the course-discovery-intel
precompute BackgroundTask + its guarded backfill (specs/course-discovery-
intel-plan.md §3c, §6).

No network, no database. Mirrors test_course_guides.py's documented approach:
a placeholder DATABASE_URL lets `app.services.course_intel` (which
transitively imports `app.db.engine`/`app.db.models`) import cleanly with
zero network I/O (the lazy `create_async_engine` never connects at import
time). All I/O (`courses_mapped.get_course_intel_blob`,
`courses_mapped.get_course`, `courses_mapped.merge_course_intel_blob`,
`course_intel_writer.write_course_description`,
`course_intel_writer.validate_course_description`) is monkeypatched.
Deliberately does NOT stub `sys.modules["app.db"]` — see test_course_guides.py's
docstring for why that pattern is collection-order-fragile.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/test")

from unittest.mock import AsyncMock, MagicMock  # noqa: E402

import pytest  # noqa: E402

from app.caddie.course_intel_writer import CourseDescriptionDraft  # noqa: E402
from app.services import course_intel  # noqa: E402


def _course(holes: list[dict], name: str = "Test Links", address: str | None = "Somewhere, USA") -> dict:
    return {"id": "course-1", "name": name, "address": address, "teeSets": [], "holes": holes}


def _mapped_hole(number: int, par: int = 4, yards: int = 400) -> dict:
    return {
        "number": number,
        "par": par,
        "yardages": {"Blue": yards},
        "features": {
            "type": "FeatureCollection",
            "features": [{"type": "Feature", "properties": {"featureType": "green"}, "geometry": {}}],
        },
    }


def _unmapped_hole(number: int) -> dict:
    return {"number": number, "par": 4, "yardages": {}, "features": {"type": "FeatureCollection", "features": []}}


def _draft() -> CourseDescriptionDraft:
    return CourseDescriptionDraft(landscape="A calm layout among mature trees.")


# ── Idempotent skip ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_existing_description_is_skipped_with_zero_llm_calls(monkeypatch):
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course_intel_blob",
        AsyncMock(return_value={"description": {"text": "already cached"}}),
    )
    get_course = AsyncMock(side_effect=AssertionError("must not fetch course when already cached"))
    monkeypatch.setattr(course_intel.courses_mapped, "get_course", get_course)
    write = AsyncMock(side_effect=AssertionError("must not spend when already cached"))
    monkeypatch.setattr(course_intel, "write_course_description", write)

    await course_intel._precompute_course_intel("course-1")

    get_course.assert_not_called()
    write.assert_not_called()


@pytest.mark.asyncio
async def test_existing_attempt_marker_is_never_re_researched(monkeypatch):
    """Negative cache: a course whose research previously failed or was
    validator-rejected must not re-spend on every later trigger."""
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course_intel_blob",
        AsyncMock(return_value={"attempted_at": "2026-07-17T00:00:00+00:00"}),
    )
    get_course = AsyncMock(side_effect=AssertionError("must not fetch course when already attempted"))
    monkeypatch.setattr(course_intel.courses_mapped, "get_course", get_course)

    await course_intel._precompute_course_intel("course-1")

    get_course.assert_not_called()


# ── Zero-mapped-holes guard ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_zero_mapped_holes_writes_no_marker_and_spends_nothing(monkeypatch):
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course_intel_blob", AsyncMock(return_value={})
    )
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course",
        AsyncMock(return_value=_course([_unmapped_hole(1), _unmapped_hole(2)])),
    )
    merge = AsyncMock()
    monkeypatch.setattr(course_intel.courses_mapped, "merge_course_intel_blob", merge)
    write = AsyncMock(side_effect=AssertionError("must not spend with zero mapped holes"))
    monkeypatch.setattr(course_intel, "write_course_description", write)

    await course_intel._precompute_course_intel("course-1")

    merge.assert_not_called()
    write.assert_not_called()


@pytest.mark.asyncio
async def test_missing_course_is_a_no_op(monkeypatch):
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course_intel_blob", AsyncMock(return_value={})
    )
    monkeypatch.setattr(course_intel.courses_mapped, "get_course", AsyncMock(return_value=None))
    write = AsyncMock(side_effect=AssertionError("must not spend when course is missing"))
    monkeypatch.setattr(course_intel, "write_course_description", write)

    await course_intel._precompute_course_intel("missing-course")  # must not raise

    write.assert_not_called()


# ── Marker-write-fails -> no spend ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_marker_write_failure_stops_before_any_spend(monkeypatch):
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course_intel_blob", AsyncMock(return_value={})
    )
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course",
        AsyncMock(return_value=_course([_mapped_hole(1)])),
    )
    monkeypatch.setattr(
        course_intel.courses_mapped, "merge_course_intel_blob",
        AsyncMock(side_effect=RuntimeError("db write failed")),
    )
    write = AsyncMock(side_effect=AssertionError("must not spend when the marker can't be written"))
    monkeypatch.setattr(course_intel, "write_course_description", write)

    await course_intel._precompute_course_intel("course-1")  # must not raise

    write.assert_not_called()


# ── Writer raises -> marker only ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_writer_failure_leaves_only_the_attempt_marker(monkeypatch):
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course_intel_blob", AsyncMock(return_value={})
    )
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course",
        AsyncMock(return_value=_course([_mapped_hole(1)])),
    )
    merge = AsyncMock(return_value=True)
    monkeypatch.setattr(course_intel.courses_mapped, "merge_course_intel_blob", merge)
    monkeypatch.setattr(
        course_intel, "write_course_description",
        AsyncMock(side_effect=RuntimeError("network error")),
    )

    await course_intel._precompute_course_intel("course-1")  # must not raise

    assert merge.await_count == 1  # marker only — no description patch
    marker_patch = merge.await_args_list[0].args[1]
    assert set(marker_patch.keys()) == {"attempted_at"}


# ── Validator rejects -> marker only ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_validator_rejection_leaves_only_the_attempt_marker(monkeypatch):
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course_intel_blob", AsyncMock(return_value={})
    )
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course",
        AsyncMock(return_value=_course([_mapped_hole(1)])),
    )
    merge = AsyncMock(return_value=True)
    monkeypatch.setattr(course_intel.courses_mapped, "merge_course_intel_blob", merge)
    monkeypatch.setattr(course_intel, "write_course_description", AsyncMock(return_value=_draft()))
    monkeypatch.setattr(course_intel, "validate_course_description", MagicMock(return_value=None))

    await course_intel._precompute_course_intel("course-1")

    assert merge.await_count == 1  # marker only — a rejected draft is never persisted
    marker_patch = merge.await_args_list[0].args[1]
    assert set(marker_patch.keys()) == {"attempted_at"}


# ── Success -> merged description patch ──────────────────────────────────────


@pytest.mark.asyncio
async def test_accepted_description_is_merged_with_exact_patch_shape(monkeypatch):
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course_intel_blob", AsyncMock(return_value={})
    )
    monkeypatch.setattr(
        course_intel.courses_mapped, "get_course",
        AsyncMock(return_value=_course([_mapped_hole(1), _mapped_hole(2)])),
    )
    merge = AsyncMock(return_value=True)
    monkeypatch.setattr(course_intel.courses_mapped, "merge_course_intel_blob", merge)
    monkeypatch.setattr(course_intel, "write_course_description", AsyncMock(return_value=_draft()))
    composed = {
        "text": "A calm layout among mature trees.",
        "provenance": "landscape",
        "facts_used": [],
        "generated_at": None,
        "model": None,
        "schema_version": 1,
    }
    monkeypatch.setattr(course_intel, "validate_course_description", MagicMock(return_value=composed))

    await course_intel._precompute_course_intel("course-1")

    assert merge.await_count == 2  # marker first (runaway protection), then the description
    assert set(merge.await_args_list[0].args[1].keys()) == {"attempted_at"}
    assert merge.await_args_list[1].args == ("course-1", {"description": composed})


# ── Guarded backfill (env-gated, capped) ─────────────────────────────────────


@pytest.mark.asyncio
async def test_backfill_is_a_no_op_with_empty_allowlist(monkeypatch):
    monkeypatch.delenv("COURSE_INTEL_BACKFILL_COURSES", raising=False)
    precompute = AsyncMock()
    monkeypatch.setattr(course_intel, "_precompute_course_intel", precompute)

    await course_intel.run_course_intel_backfill()

    precompute.assert_not_called()


@pytest.mark.asyncio
async def test_backfill_is_capped_by_max_courses_even_with_a_longer_allowlist(monkeypatch):
    monkeypatch.setenv("COURSE_INTEL_BACKFILL_COURSES", "course-a,course-b,course-c")
    monkeypatch.setenv("COURSE_INTEL_BACKFILL_MAX_COURSES", "1")
    precompute = AsyncMock()
    monkeypatch.setattr(course_intel, "_precompute_course_intel", precompute)

    await course_intel.run_course_intel_backfill()

    precompute.assert_awaited_once_with("course-a")
