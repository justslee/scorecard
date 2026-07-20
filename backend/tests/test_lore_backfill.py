"""Unit tests for the LOCAL-LORE backfill in app/services/course_guides.py
(specs/caddie-guide-local-lore-plan.md §5, §8B).

No network, no database. Mirrors `test_course_guides.py`'s `DATABASE_URL`-
placeholder + `AsyncMock` pattern exactly — see that file's module docstring
for why we set a placeholder DATABASE_URL rather than stub `sys.modules`.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/test")

from unittest.mock import AsyncMock  # noqa: E402

import pytest  # noqa: E402

from app.caddie.guide_writer import LoreResearchResult  # noqa: E402
from app.caddie.types import LoreItem  # noqa: E402
from app.services import course_guides  # noqa: E402


def _course(name: str, holes: list[dict]) -> dict:
    return {"id": "course-1", "name": name, "holes": holes}


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


def _tactical_guide(**extra) -> dict:
    base = {
        "play_line": "Favor the center of the fairway.",
        "miss_side": "",
        "green_notes": "",
        "common_mistakes": [],
        "sources": ["https://example.com/hole-1"],
        "generated_at": "2026-07-01T00:00:00+00:00",
        "model": "claude-sonnet-5",
        "schema_version": 1,
        "local_lore": [],
        "lore_generated_at": "",
        "lore_model": "",
        "lore_sources": [],
    }
    base.update(extra)
    return base


def _lore_item(**kw) -> LoreItem:
    base = dict(
        text="The green is a famous turtleback that sheds anything long.",
        category="green_character",
        source="Golf Digest course guide",
        confidence="high",
    )
    base.update(kw)
    return LoreItem(**base)


def _result(items: list[LoreItem] | None = None) -> LoreResearchResult:
    return LoreResearchResult(
        items=items if items is not None else [_lore_item()],
        sources=["https://example.com/hole-1-lore"],
        generated_at="2026-07-19T00:00:00+00:00",
        model="claude-sonnet-5",
    )


# ── Skips ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_hole_with_no_tactical_guide_is_skipped(monkeypatch):
    """Lore only appends to a hole that ALREADY has a tactical guide."""
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course("Bethpage Black", [_hole(1)])),
    )
    research = AsyncMock(side_effect=AssertionError("must not research a hole with no tactical guide"))
    monkeypatch.setattr(course_guides, "research_hole_lore", research)
    write = AsyncMock()
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_lore("course-1")

    research.assert_not_called()
    write.assert_not_called()


@pytest.mark.asyncio
async def test_hole_with_existing_lore_is_skipped(monkeypatch):
    guide = _tactical_guide(local_lore=[_lore_item().model_dump()])
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course("Bethpage Black", [_hole(1, guide=guide)])),
    )
    research = AsyncMock(side_effect=AssertionError("must not re-research a hole with existing lore"))
    monkeypatch.setattr(course_guides, "research_hole_lore", research)
    write = AsyncMock()
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_lore("course-1")

    research.assert_not_called()
    write.assert_not_called()


@pytest.mark.asyncio
async def test_hole_with_lore_attempted_marker_is_skipped(monkeypatch):
    """The negative-cache marker is `lore_attempted_at` — DISTINCT from
    `strategy_guide_attempted_at`."""
    hole = _hole(1, guide=_tactical_guide())
    hole["features"]["features"][0]["properties"]["lore_attempted_at"] = "2026-07-10T00:00:00+00:00"
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course("Bethpage Black", [hole])),
    )
    research = AsyncMock(side_effect=AssertionError("must not re-research an attempted hole"))
    monkeypatch.setattr(course_guides, "research_hole_lore", research)
    write = AsyncMock()
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_lore("course-1")

    research.assert_not_called()
    write.assert_not_called()


@pytest.mark.asyncio
async def test_course_with_no_name_is_skipped_entirely(monkeypatch):
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course("", [_hole(1, guide=_tactical_guide())])),
    )
    research = AsyncMock(side_effect=AssertionError("must not research when course has no name"))
    monkeypatch.setattr(course_guides, "research_hole_lore", research)

    await course_guides._precompute_course_lore("course-1")  # must not raise

    research.assert_not_called()


@pytest.mark.asyncio
async def test_missing_course_is_a_no_op(monkeypatch):
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course", AsyncMock(return_value=None)
    )
    research = AsyncMock(side_effect=AssertionError("must not research when course is missing"))
    monkeypatch.setattr(course_guides, "research_hole_lore", research)

    await course_guides._precompute_course_lore("missing-course")  # must not raise

    research.assert_not_called()


# ── Marker-before-research, failure-honesty ─────────────────────────────


@pytest.mark.asyncio
async def test_marker_written_before_research(monkeypatch):
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course("Bethpage Black", [_hole(1, guide=_tactical_guide())])),
    )
    monkeypatch.setattr(course_guides, "research_hole_lore", AsyncMock(return_value=_result()))
    write = AsyncMock()
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_lore("course-1")

    assert write.await_count == 2
    first_patch = write.await_args_list[0].args[2]
    assert set(first_patch.keys()) == {"lore_attempted_at"}


@pytest.mark.asyncio
async def test_marker_write_failure_skips_research(monkeypatch):
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course("Bethpage Black", [_hole(1, guide=_tactical_guide())])),
    )
    research = AsyncMock(side_effect=AssertionError("must not research when the marker write failed"))
    monkeypatch.setattr(course_guides, "research_hole_lore", research)
    write = AsyncMock(side_effect=RuntimeError("db write failed"))
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_lore("course-1")  # must not raise

    research.assert_not_called()


@pytest.mark.asyncio
async def test_research_called_with_course_name(monkeypatch):
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course("Pinehurst No. 2", [_hole(1, guide=_tactical_guide())])),
    )
    research = AsyncMock(return_value=_result())
    monkeypatch.setattr(course_guides, "research_hole_lore", research)
    write = AsyncMock()
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_lore("course-1")

    research.assert_awaited_once()
    args = research.await_args.args
    assert args[0] == "Pinehurst No. 2"
    assert args[1] == 1  # hole_number


@pytest.mark.asyncio
async def test_research_failure_writes_only_the_marker(monkeypatch):
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course("Bethpage Black", [_hole(1, guide=_tactical_guide())])),
    )
    monkeypatch.setattr(
        course_guides, "research_hole_lore",
        AsyncMock(side_effect=RuntimeError("network error")),
    )
    write = AsyncMock()
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_lore("course-1")  # must not raise

    assert write.await_count == 1
    assert set(write.await_args_list[0].args[2].keys()) == {"lore_attempted_at"}


@pytest.mark.asyncio
async def test_no_survivors_writes_only_the_marker(monkeypatch):
    """Every researched item drops under `validate_lore` -> nothing written
    beyond the marker (honest omission, never a placeholder)."""
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course("Bethpage Black", [_hole(1, guide=_tactical_guide())])),
    )
    monkeypatch.setattr(course_guides, "research_hole_lore", AsyncMock(return_value=_result([])))
    write = AsyncMock()
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_lore("course-1")

    assert write.await_count == 1
    assert set(write.await_args_list[0].args[2].keys()) == {"lore_attempted_at"}


@pytest.mark.asyncio
async def test_write_back_failure_is_best_effort_and_continues(monkeypatch):
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course(
            "Bethpage Black", [_hole(1, guide=_tactical_guide()), _hole(2, guide=_tactical_guide())]
        )),
    )
    monkeypatch.setattr(course_guides, "research_hole_lore", AsyncMock(return_value=_result()))

    async def _write(course_id, hole_number, patch):
        if "strategy_guide" in patch:
            raise RuntimeError("db write failed")
        return True

    write = AsyncMock(side_effect=_write)
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_lore("course-1")  # must not raise

    # Both holes attempted (marker + guide-write attempt each) despite failure.
    assert write.call_count == 4


# ── The load-bearing read-modify-write (§5.1 step 8) ────────────────────


@pytest.mark.asyncio
async def test_write_patch_merges_lore_into_full_existing_guide(monkeypatch):
    """The JSONB merge is SHALLOW at the top level, so the write MUST be
    read-modify-write: every tactical byte survives verbatim, with the lore
    fields merged in, and the ENTIRE guide object is written back under
    `strategy_guide` (never a partial lore-only object)."""
    original_guide = _tactical_guide(
        play_line="Favor the center of the fairway.",
        miss_side="Best miss is short-right.",
        green_notes="Green runs back-to-front.",
        common_mistakes=["Overclubbing the approach"],
    )
    monkeypatch.setattr(
        course_guides.courses_mapped, "get_course",
        AsyncMock(return_value=_course("Bethpage Black", [_hole(1, guide=original_guide)])),
    )
    lore_items = [_lore_item(), _lore_item(text="A false front repels anything short.")]
    result = _result(lore_items)
    monkeypatch.setattr(course_guides, "research_hole_lore", AsyncMock(return_value=result))
    write = AsyncMock()
    monkeypatch.setattr(course_guides.courses_mapped, "update_green_feature_properties", write)

    await course_guides._precompute_course_lore("course-1")

    assert write.await_count == 2
    guide_patch = write.await_args_list[1].args[2]
    assert set(guide_patch.keys()) == {"strategy_guide"}
    merged = guide_patch["strategy_guide"]

    # Every tactical byte, byte-identical to the original guide.
    tactical_keys = {
        "play_line", "miss_side", "green_notes", "common_mistakes",
        "sources", "generated_at", "model", "schema_version",
    }
    assert {k: merged[k] for k in tactical_keys} == {k: original_guide[k] for k in tactical_keys}

    # Lore fields merged in.
    assert merged["local_lore"] == [i.model_dump() for i in lore_items]
    assert merged["lore_generated_at"] == result.generated_at
    assert merged["lore_model"] == result.model
    assert merged["lore_sources"] == result.sources


# ── Env gates (fully independent of GUIDE_BACKFILL_*) ───────────────────


@pytest.mark.asyncio
async def test_lore_backfill_is_a_no_op_with_empty_allowlist(monkeypatch):
    monkeypatch.delenv("LORE_BACKFILL_COURSES", raising=False)
    precompute = AsyncMock()
    monkeypatch.setattr(course_guides, "_precompute_course_lore", precompute)

    await course_guides.run_lore_backfill()

    precompute.assert_not_called()


@pytest.mark.asyncio
async def test_lore_backfill_is_capped_by_max_courses_even_with_a_longer_allowlist(monkeypatch):
    monkeypatch.setenv("LORE_BACKFILL_COURSES", "course-a,course-b,course-c")
    monkeypatch.setenv("LORE_BACKFILL_MAX_COURSES", "1")
    precompute = AsyncMock()
    monkeypatch.setattr(course_guides, "_precompute_course_lore", precompute)

    await course_guides.run_lore_backfill()

    precompute.assert_awaited_once_with("course-a")


def test_lore_backfill_env_is_independent_of_guide_backfill_env(monkeypatch):
    """`LORE_BACKFILL_COURSES`/`_MAX_COURSES` must never read the tactical
    `GUIDE_BACKFILL_*` envs — a fully separate op, separate gate."""
    monkeypatch.delenv("LORE_BACKFILL_COURSES", raising=False)
    monkeypatch.delenv("LORE_BACKFILL_MAX_COURSES", raising=False)
    monkeypatch.setenv("GUIDE_BACKFILL_COURSES", "some-other-course")
    monkeypatch.setenv("GUIDE_BACKFILL_MAX_COURSES", "5")

    assert course_guides._lore_backfill_course_ids() == []


@pytest.mark.asyncio
async def test_lore_backfill_default_max_courses_is_one(monkeypatch):
    monkeypatch.setenv("LORE_BACKFILL_COURSES", "course-a,course-b")
    monkeypatch.delenv("LORE_BACKFILL_MAX_COURSES", raising=False)
    precompute = AsyncMock()
    monkeypatch.setattr(course_guides, "_precompute_course_lore", precompute)

    await course_guides.run_lore_backfill()

    precompute.assert_awaited_once_with("course-a")
