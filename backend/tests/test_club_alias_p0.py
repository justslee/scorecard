"""Regression tests for the P0 field bug (owner, live round, v1.1.14):
LLM-natural club shorthand ('7i'/'3w') un-normalized into the strategy/
recommendation bag reached `physics._club_ref` and raised, 500ing the
strategy endpoint mid-round; a sibling int-typed-arg TypeError was in the
same family. specs/caddie-strategy-500-club-alias-plan.md.

No network, no Postgres — DB-touching calls (`sessions.append_shot`,
`sessions.set_recommendation`) are monkeypatched to no-ops so these stay
pure/offline; DB-backed integration coverage runs in CI.
"""

import logging
import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from app.caddie import strategy as strategy_mod  # noqa: E402
from app.caddie import tools as tools_mod  # noqa: E402
from app.caddie.aim_point import generate_recommendation  # noqa: E402
from app.caddie.session import RoundSession  # noqa: E402
from app.caddie.strategy_turn import run_strategy_turn  # noqa: E402
from app.caddie.tools import ToolContext, resolve_tool  # noqa: E402
from app.caddie.types import HoleIntelligence  # noqa: E402


def _session(hole_intel=None, club_distances=None) -> RoundSession:
    return RoundSession(
        round_id="round-1",
        user_id="user-1",
        current_hole=4,
        hole_intel=hole_intel or {},
        club_distances=club_distances or {},
    )


def _hole4_intel() -> dict[int, HoleIntelligence]:
    return {4: HoleIntelligence(hole_number=4, par=4, yards=400, effective_yards=400)}


@pytest.fixture(autouse=True)
def _no_db_writes(monkeypatch):
    """Every test in this module drives real engine code but must never hit
    a real DB — patch the session-persistence reads/writes to no-ops."""
    async def _noop_append_shot(round_id, shot):
        return None

    async def _noop_set_recommendation(round_id, rec, hole_number):
        return None

    async def _no_profile(user_id):
        return None

    monkeypatch.setattr(tools_mod.sessions, "append_shot", _noop_append_shot)
    monkeypatch.setattr(tools_mod.sessions, "set_recommendation", _noop_set_recommendation)
    monkeypatch.setattr(tools_mod.memory_mod, "get_player_profile", _no_profile)


# ── A: '3w' end-to-end — no 500, and the CORRECT 3wood numbers ─────────────


def test_generate_recommendation_3w_shorthand_matches_3wood_numbers():
    """The bag chokepoint (normalize_club_distances) must alias '3w' to
    3wood BEFORE physics ever sees it, so a '3w'-keyed bag produces the
    exact same recommendation as a '3wood'-keyed bag — not a degraded
    fallback, not a crash."""
    hole = HoleIntelligence(hole_number=4, par=4, yards=230, effective_yards=230)

    rec_shorthand = generate_recommendation(
        hole=hole, distance_yards=230, club_distances={"3w": 230, "7i": 160},
    )
    rec_canonical = generate_recommendation(
        hole=hole, distance_yards=230, club_distances={"3wood": 230, "7iron": 160},
    )

    assert rec_shorthand.club == rec_canonical.club == "3wood"
    assert rec_shorthand.target_yards == rec_canonical.target_yards
    assert rec_shorthand.raw_yards == rec_canonical.raw_yards


async def test_resolve_tool_get_shot_distance_3w_arg_matches_3wood():
    """The model says '3w', not '3wood' — the CLUB ARG alias must resolve to
    the player's real stored 3wood distance (session.club_distances is
    already canonical here, exactly as the route's normalizing bag
    assignment leaves it in production)."""
    ctx = ToolContext(
        session=_session(hole_intel=_hole4_intel(), club_distances={"3wood": 230}),
        round_id="round-1", user_id="user-1", default_hole=4,
    )
    out_shorthand = await resolve_tool("get_shot_distance", {"club": "3w"}, ctx)
    out_canonical = await resolve_tool("get_shot_distance", {"club": "3wood"}, ctx)

    assert out_shorthand["available"] is True
    assert out_shorthand["club"] == "3wood"
    assert out_shorthand["total_yards"] == out_canonical["total_yards"]
    assert out_shorthand["carry_yards"] == out_canonical["carry_yards"]


async def test_resolve_tool_get_shot_distance_bag_with_shorthand_key_is_honestly_unavailable():
    """A session bag that (somehow) still carries a raw shorthand KEY
    (unnormalized — e.g. a pre-fix DB row) is read directly by
    `shot_distance_payload`, not through the bag chokepoint; documents the
    existing honest-unavailable behavior rather than a crash or a silent
    wrong number. Production never constructs a session this way — the
    route's bag assignment (routes/caddie.py) normalizes on write."""
    ctx = ToolContext(
        session=_session(hole_intel=_hole4_intel(), club_distances={"3w": 230}),
        round_id="round-1", user_id="user-1", default_hole=4,
    )
    out = await resolve_tool("get_shot_distance", {"club": "3wood"}, ctx)
    assert out["available"] is False


async def test_build_strategy_payload_3w_bag_no_crash_correct_numbers():
    """Full strategy assembly path (owner's exact repro shape) with a
    '3w'-keyed bag: no exception escapes, and the recommendation club/target
    match the canonical-keyed bag — not the degraded/fallback shape."""
    session = _session(hole_intel=_hole4_intel(), club_distances={"3w": 230, "7i": 160})
    payload = await strategy_mod.build_strategy_payload(
        session, "round-1", "user-1", 4, hole_yards=230,
    )
    rec = payload["recommendation"]
    assert "error" not in rec
    assert rec["club"] == "3wood"

    session_canonical = _session(hole_intel=_hole4_intel(), club_distances={"3wood": 230, "7iron": 160})
    payload_canonical = await strategy_mod.build_strategy_payload(
        session_canonical, "round-1", "user-1", 4, hole_yards=230,
    )
    assert rec["target_yards"] == payload_canonical["recommendation"]["target_yards"]


async def test_run_strategy_turn_3w_bag_no_500(monkeypatch):
    """The exact owner repro through the ONE brain both mouths share: a
    '3w'-shorthand bag must never raise past `run_strategy_turn` — no
    OPENAI_API_KEY configured here, so synth degrades to the deterministic
    line, but the point is: no unhandled exception, ever."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    session = _session(hole_intel=_hole4_intel(), club_distances={"3w": 230, "7i": 160})
    result = await run_strategy_turn(session, "round-1", "user-1", 4, hole_yards=230)
    assert result["available"] is True
    assert result["strategy"]  # degraded deterministic line, non-empty
    assert result["degraded"] is True


# ── B: unknown club never 500s ──────────────────────────────────────────────


def test_unknown_club_dropped_from_bag_recommendation_still_answers():
    """'shovel' in the bag is dropped (Layer 1); the recommendation still
    comes back from the rest of the (valid) bag — never a crash."""
    hole = HoleIntelligence(hole_number=4, par=4, yards=160, effective_yards=160)
    rec = generate_recommendation(
        hole=hole, distance_yards=160, club_distances={"7iron": 160, "shovel": 999},
    )
    assert rec.club == "7iron"


async def test_resolve_tool_record_shot_unknown_club_is_graceful(caplog):
    """An unrecognized club as a record_shot arg never crashes — it records
    honestly as typed (record_shot doesn't drop; only the bag chokepoint
    does)."""
    ctx = ToolContext(session=_session(), round_id="round-1", user_id="user-1", default_hole=4)
    out = await resolve_tool(
        "record_shot", {"hole_number": 4, "club": "shovel", "distance_yards": 40}, ctx,
    )
    assert out["status"] == "recorded"


async def test_build_strategy_payload_all_unknown_bag_degrades_not_crashes():
    """A bag of nothing but unknown clubs is dropped entirely — the
    recommendation degrades to the honest fallback bag (DEFAULT_CLUB_
    DISTANCES via select_club/compute_adjustments), never a raise."""
    session = _session(hole_intel=_hole4_intel(), club_distances={"shovel": 999, "spoon": 111})
    payload = await strategy_mod.build_strategy_payload(
        session, "round-1", "user-1", 4, hole_yards=230,
    )
    assert "error" not in payload["recommendation"]


# ── C: int-typed args never crash ───────────────────────────────────────────


async def test_resolve_tool_record_shot_int_club_never_crashes():
    ctx = ToolContext(session=_session(), round_id="round-1", user_id="user-1", default_hole=4)
    out = await resolve_tool(
        "record_shot", {"hole_number": 4, "club": 7, "distance_yards": 150}, ctx,
    )
    assert out["status"] == "recorded"


async def test_resolve_tool_get_shot_distance_int_club_never_crashes():
    ctx = ToolContext(
        session=_session(hole_intel=_hole4_intel(), club_distances={"7iron": 160}),
        round_id="round-1", user_id="user-1", default_hole=4,
    )
    out = await resolve_tool("get_shot_distance", {"club": 7}, ctx)
    # '7' has no canonical alias (only '7i'/'7iron' do) — honest unavailable,
    # never a raised exception.
    assert out["available"] is False


def test_canonical_club_int_arg_never_raises():
    from app.caddie.club_selection import canonical_club
    assert canonical_club(7) is None
    assert canonical_club(3.5) is None


# ── D: build_strategy_payload degrades on a forced internal error ──────────


async def test_build_strategy_payload_forced_error_degrades_never_raises(monkeypatch, caplog):
    async def _boom(*args, **kwargs):
        raise RuntimeError("forced internal error for the P0 degrade test")

    monkeypatch.setattr(strategy_mod, "recommend_payload", _boom)

    session = _session(hole_intel=_hole4_intel(), club_distances={"7iron": 160})
    with caplog.at_level(logging.ERROR, logger="looper.caddie.strategy"):
        payload = await strategy_mod.build_strategy_payload(
            session, "round-1", "user-1", 4, hole_yards=230,
        )

    assert payload["recommendation"]["error"]
    assert payload["conditions"] == {}
    assert payload["carries"] == {}
    assert any("payload assembly failed" in rec.message for rec in caplog.records)


async def test_run_strategy_turn_forced_error_degrades_to_honest_unavailable(monkeypatch):
    """The end-to-end contract: a forced internal error in payload assembly
    must surface as `run_strategy_turn`'s honest available:false branch —
    never an unhandled exception reaching the route (the exact P0 500)."""
    async def _boom(*args, **kwargs):
        raise RuntimeError("forced internal error")

    monkeypatch.setattr(strategy_mod, "recommend_payload", _boom)

    session = _session(hole_intel=_hole4_intel(), club_distances={"7iron": 160})
    result = await run_strategy_turn(session, "round-1", "user-1", 4, hole_yards=230)

    assert result["available"] is False
    assert result["strategy"] is None
    assert result["reason"]
