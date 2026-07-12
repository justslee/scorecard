"""Regression tests for the `/caddie/recommend` rider fix
(specs/corridor-width-club-selection-plan.md §8, §9-C).

The old `yards: int = 400` default meant an absent distance silently solved
against a fake 400y hole — indistinguishable from a real 400y hole. This
locks the honest replacement: an explicit is-None distance-resolution ladder
(`distance_yards` -> `yards` -> `hole_intelligence.yards`), raising
`HTTPException(400, ...)` only when every signal is absent.

Pure, no DB/network — `get_recommendation` itself never touches the DB (the
session-aware `/session/recommend` path is the one with persistence); the
`Depends(caddie_rate_limited_user)` default is bypassed by calling the
coroutine directly with an explicit `user_id`, mirroring
`test_course_intel_resilience.py`'s direct-call style.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from app.caddie.types import HoleIntelligence, RecommendationRequest  # noqa: E402
from app.routes.caddie import get_recommendation  # noqa: E402


async def test_absent_distance_raises_400_not_a_fake_400y_solve():
    """No `distance_yards`, no `yards`, no `hole_intelligence.yards` -> an
    honest 400 error, never a silent solve against a fabricated 400y hole."""
    request = RecommendationRequest(hole_number=1)
    with pytest.raises(HTTPException) as exc:
        await get_recommendation(request, user_id="test-user")
    assert exc.value.status_code == 400


async def test_yards_only_solves_that_distance_never_a_fake_400():
    """`yards=466` only (no `distance_yards`) -> solves 466, never silently
    substitutes the old hardcoded 400."""
    request = RecommendationRequest(hole_number=1, yards=466)
    rec = await get_recommendation(request, user_id="test-user")
    assert rec["raw_yards"] == 466
    assert rec["raw_yards"] != 400


async def test_distance_yards_only_unaffected():
    """`distance_yards` alone (no `yards`) still solves — the ladder's first
    rung, unaffected by the `yards` default change."""
    request = RecommendationRequest(hole_number=1, distance_yards=150)
    rec = await get_recommendation(request, user_id="test-user")
    assert rec["raw_yards"] == 150


async def test_distance_yards_wins_over_yards():
    """Explicit `distance_yards` still beats `yards` — unchanged ladder
    ordering."""
    request = RecommendationRequest(hole_number=1, distance_yards=150, yards=400)
    rec = await get_recommendation(request, user_id="test-user")
    assert rec["raw_yards"] == 150


async def test_hole_intelligence_yards_is_the_last_resort():
    """`distance_yards`/`yards` both absent, but `hole_intelligence.yards` is
    known -> solves that, never a 400 when real intel is attached."""
    request = RecommendationRequest(
        hole_number=1,
        hole_intelligence=HoleIntelligence(hole_number=1, par=4, yards=412),
    )
    rec = await get_recommendation(request, user_id="test-user")
    assert rec["raw_yards"] == 412
