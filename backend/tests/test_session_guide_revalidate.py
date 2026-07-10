"""Session-reload guide re-validation (caddie-guide-session-reload-revalidate).

Closes the last thread from the 2026-07-10 strategy-guide security hardening:
the MED-2 fix re-validates persisted guides at /course-intel READ time, but a
caddie SESSION reloaded WITHOUT re-hitting /course-intel would serve a guide
baked into an OLD session blob (by a weaker/earlier validator) verbatim. The
fix runs `validate_guide` at the single session-hydrate seam
(`session._row_to_session`), grounded against the hazards persisted alongside
the guide in the SAME blob.

No network, no database: `_row_to_session` is a pure row->pydantic function.
`app.caddie.session` transitively imports `app.db.engine` (raises at import
without DATABASE_URL) — set a placeholder first (the engine is LAZY, it never
connects at import). We hand `_row_to_session` a `SimpleNamespace` shaped like
a `CaddieSessionRow`; only the JSONB `hole_intel` blob matters here.
"""

from __future__ import annotations

import os
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/test")

from app.caddie.session import _row_to_session  # noqa: E402
from app.caddie.types import (  # noqa: E402
    Hazard,
    HoleIntelligence,
    HoleStrategyGuide,
)


def _row(hole_intel_blob: dict) -> SimpleNamespace:
    """A CaddieSessionRow stand-in carrying only what `_row_to_session` reads.

    Timestamps are None (the reader guards each with a truthiness check), so no
    real datetimes are needed — the hole_intel JSONB is the whole point.
    """
    return SimpleNamespace(
        round_id="r1",
        user_id="u1",
        course_id="c1",
        personality_id="classic",
        created_at=None,
        last_accessed=None,
        weather=None,
        weather_fetched_at=None,
        hole_intel=hole_intel_blob,
        player_stats=None,
        current_hole=1,
        last_recommendation=None,
        shot_history=[],
        club_distances={},
        handicap=None,
        realtime_session_id=None,
        status="active",
    )


def _blob(intel: HoleIntelligence) -> dict:
    """Persisted JSONB form: {str(hole): HoleIntelligence.model_dump()} — exactly
    what `_session_to_row_kwargs` writes to `hole_intel`."""
    return {"1": intel.model_dump()}


# A hole whose ONLY surveyed hazard is a left bunker — the guide below claims
# water down the left, a type today's validate_guide has no geometry for.
_LEFT_BUNKER = Hazard(type="bunker", side="left", line_side="left", carry_yards=250)


def test_stale_ungrounded_guide_dropped_on_reload():
    """RED-before: a persisted guide that today's fail-closed validator rejects
    (mentions `water`, absent from this hole's surveyed hazards) must be DROPPED
    to None on session reload — before it can reach a caddie mouth.

    Pre-fix, `_row_to_session` returned the guide verbatim, so this asserts the
    NEW behavior (fails on the old code, where strategy_guide stays non-None).
    """
    ungrounded = HoleStrategyGuide(
        play_line="Favor the right side; the water down the left will grab any pull.",
        miss_side="Short and right is the safe bail-out.",
        green_notes="Green sits back to front.",
    )
    intel = HoleIntelligence(
        hole_number=1, par=4, yards=400, hazards=[_LEFT_BUNKER], strategy_guide=ungrounded,
    )

    session = _row_to_session(_row(_blob(intel)), messages=[])

    assert 1 in session.hole_intel
    # The hole itself survives (yardage/hazards intact) — only the ungrounded
    # guide is sanitized away, degrading to no local-knowledge line.
    assert session.hole_intel[1].strategy_guide is None
    assert session.hole_intel[1].hazards == [_LEFT_BUNKER]


def test_valid_guide_survives_reload_unchanged():
    """Guard: a generic, well-grounded guide (no hazard-type claim to falsify)
    must pass through session reload UNCHANGED — the re-validation must not drop
    valid guides (e.g. by grounding against empty hazards)."""
    valid = HoleStrategyGuide(
        play_line="Aim at the center of the fairway and take one more club into a deep green.",
        miss_side="Short is the safe miss; long leaves a slick downhill putt.",
        green_notes="Runs back to front — stay below the hole.",
    )
    intel = HoleIntelligence(
        hole_number=1, par=4, yards=400, hazards=[_LEFT_BUNKER], strategy_guide=valid,
    )

    session = _row_to_session(_row(_blob(intel)), messages=[])

    assert session.hole_intel[1].strategy_guide is not None
    assert session.hole_intel[1].strategy_guide == valid


def test_no_guide_reload_is_a_noop():
    """A session blob with no cached guide (None) reloads with no error and no
    guide — the re-validation must be skipped, never crash on absent guide."""
    intel = HoleIntelligence(
        hole_number=1, par=4, yards=400, hazards=[_LEFT_BUNKER], strategy_guide=None,
    )

    session = _row_to_session(_row(_blob(intel)), messages=[])

    assert session.hole_intel[1].strategy_guide is None
