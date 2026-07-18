"""Verdict-level guide gate — `app.caddie.verdict` (specs/caddie-two-tier-
routing-plan.md §5). Pure/offline except the `build_strategy_payload` read-
time wiring test, which follows `test_strategy_tool.py`'s DB-free
monkeypatch pattern.
"""

from __future__ import annotations

import logging
import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from app.caddie import strategy as strategy_mod  # noqa: E402
from app.caddie import tools as tools_mod  # noqa: E402
from app.caddie import verdict as verdict_mod  # noqa: E402
from app.caddie.session import RoundSession  # noqa: E402
from app.caddie.types import Hazard, HoleIntelligence, HoleStrategyGuide  # noqa: E402


@pytest.fixture(autouse=True)
def _no_db_persist(monkeypatch):
    async def _noop_set_recommendation(round_id, recommendation, current_hole):
        return None

    async def _no_profile(user_id):
        return None

    monkeypatch.setattr(tools_mod.sessions, "set_recommendation", _noop_set_recommendation)
    monkeypatch.setattr(tools_mod.memory_mod, "get_player_profile", _no_profile)


# ── extract_favor_side ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Favor the left side off the tee.", "left"),
        ("Hug the right edge of the fairway.", "right"),
        ("Best miss is left, short of the trees.", "left"),
        ("Bail out right if you're between clubs.", "right"),
        ("Away from the left — that's dead.", "right"),  # opposition guard
        ("Avoid the right side at all costs.", "left"),  # opposition guard
        ("Play down the middle, take it as it comes.", None),  # no claim
        ("Favor the left side, but miss right if forced.", "conflict"),
        # Negation guard (2026-07-17) — "never miss left" / "don't miss
        # left" claim the OPPOSITE lateral, not a left-miss claim; a
        # correctly-worded anti-left note must not read as pro-left.
        ("Never miss left off this tee.", "right"),
        ("Don't miss left here, it's dead.", "right"),
        ("You shouldn't bail left on this hole.", "right"),
        # Un-negated "miss left" still stands as a left claim.
        ("Miss left is fine, just not long.", "left"),
    ],
)
def test_extract_favor_side_left_right_none_conflict(text, expected):
    assert verdict_mod.extract_favor_side(text) == expected


# ── guide_agrees_with_verdict ────────────────────────────────────────────────


def _guide(play_line="", miss_side="") -> HoleStrategyGuide:
    return HoleStrategyGuide(play_line=play_line, miss_side=miss_side)


def test_lateral_flip_guide_dropped():
    guide = _guide(play_line="Favor the left side off the tee.")
    rec = {"miss_side": {"preferred": "right"}}
    assert verdict_mod.guide_agrees_with_verdict(guide, rec) is False


def test_agreeing_guide_included():
    guide = _guide(play_line="Favor the right side off the tee.")
    rec = {"miss_side": {"preferred": "right"}}
    assert verdict_mod.guide_agrees_with_verdict(guide, rec) is True


def test_no_favor_claim_guide_included():
    guide = _guide(play_line="Aim at the center of the fairway and commit.")
    rec = {"miss_side": {"preferred": "left"}}
    assert verdict_mod.guide_agrees_with_verdict(guide, rec) is True


def test_center_verdict_drops_any_lateral_favor():
    """The Red-1 class: the engine says no good miss (both sides in play),
    yet the guide confidently picks a lateral favor — dropped."""
    guide = _guide(play_line="Favor the left side for a better angle.")
    rec = {"miss_side": {"preferred": "center"}}
    assert verdict_mod.guide_agrees_with_verdict(guide, rec) is False


def test_center_verdict_keeps_non_lateral_guide():
    guide = _guide(play_line="Commit to the fairway, no good miss here.")
    rec = {"miss_side": {"preferred": "center"}}
    assert verdict_mod.guide_agrees_with_verdict(guide, rec) is True


def test_conflicting_sides_guide_dropped_fail_closed():
    guide = _guide(
        play_line="Favor the left side off the tee.",
        miss_side="Actually the best miss is right.",
    )
    rec = {"miss_side": {"preferred": "left"}}
    assert verdict_mod.guide_agrees_with_verdict(guide, rec) is False


def test_green_frame_verdict_keeps_lateral_guide():
    """A short/long (green-frame) verdict is a DIFFERENT frame than a
    lateral tee-shot favor claim — not comparable, never a false-reject."""
    guide = _guide(play_line="Favor the left side off the tee.")
    rec = {"miss_side": {"preferred": "short"}}
    assert verdict_mod.guide_agrees_with_verdict(guide, rec) is True


def test_missing_recommendation_drops_guide_fail_closed():
    assert verdict_mod.guide_agrees_with_verdict(_guide(play_line="Favor the left."), {"error": "no data"}) is False
    assert verdict_mod.guide_agrees_with_verdict(_guide(play_line="Favor the left."), {}) is False


# ── build_strategy_payload read-time wiring ─────────────────────────────────


def _session_with_poisoned_guide(preferred_side_hint: str) -> RoundSession:
    """A hole whose real hazards make the engine's positioning miss-side
    verdict disagree with a guide that favors LEFT. Trees close on the
    RIGHT only (so the engine favors left) when `preferred_side_hint` is
    'right'-disagreeing, or on BOTH sides (engine -> center) otherwise."""
    if preferred_side_hint == "center":
        hazards = [
            Hazard(type="trees", side="left", line_side="left", carry_yards=260),
            Hazard(type="trees", side="right", line_side="right", carry_yards=260),
        ]
    else:
        hazards = [
            Hazard(type="trees", side="right", line_side="right", carry_yards=260),
        ]
    guide = HoleStrategyGuide(
        play_line="Favor the left side off the tee for a better angle into the green.",
        miss_side="Best miss is left.",
    )
    return RoundSession(
        round_id="round-1",
        user_id="user-1",
        current_hole=1,
        hole_intel={
            1: HoleIntelligence(hole_number=1, par=4, yards=420, hazards=hazards, strategy_guide=guide)
        },
        club_distances={"driver": 280},
    )


async def test_build_strategy_payload_drops_disagreeing_guide_and_logs_key_free(caplog):
    session = _session_with_poisoned_guide("center")
    with caplog.at_level(logging.WARNING, logger="looper.caddie.strategy"):
        payload = await strategy_mod.build_strategy_payload(
            session, "round-1", "user-1", 1, hole_yards=420, yardage_basis="tee-card",
        )
    assert payload["local_knowledge"] == ""

    warnings = [r for r in caplog.records if "strategy guide dropped" in r.getMessage()]
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert "hole=1" in message or "hole=%s" not in message
    # Key-free: no guide text, no player/user identifiers in the log line.
    assert "Favor the left" not in message
    assert "user-1" not in message
