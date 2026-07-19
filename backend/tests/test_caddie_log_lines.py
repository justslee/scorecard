"""Lead 3 (specs/caddie-yardage-selector-p0-plan.md §4): the THREE named
yardage field-debug log sites' NUMBERS must live in `record.getMessage()`,
not only `extra=` — `hole_hazards_intel`, `caddie_reco_context`, and the
strategy.py guide-drop warning.

Root cause: `app/main.py` uses `logging.basicConfig(level=INFO)`, whose
default formatter renders only `record.getMessage()` — every number passed
via `extra=` at these sites vanished from journalctl in the field, leaving
only the bare event label. The fix folds the values into the printf-style
message itself (kept `extra=` too, for a future structured sink) — no
formatter change, so this is a local, zero-risk fix at each site.

`_log_caddie_usage` (a 4th site the plan initially added) is deliberately
NOT folded — it isn't the yardage field-debug payload the owner's report
named, and its numbers are already asserted via `extra=` in
test_caddie_caching.py; see `_log_caddie_usage`'s own docstring.

No network, no Postgres — these are pure/direct calls to the logging
helpers (route module import only; DB engine is lazy).
"""

from __future__ import annotations

import logging
import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from app.caddie import strategy as strategy_mod  # noqa: E402
from app.caddie import tools as tools_mod  # noqa: E402
from app.caddie.session import RoundSession  # noqa: E402
from app.caddie.types import Hazard, HoleIntelligence, HoleStrategyGuide  # noqa: E402
from app.routes import caddie as caddie_routes  # noqa: E402


@pytest.fixture(autouse=True)
def _no_db_persist(monkeypatch):
    async def _noop_set_recommendation(round_id, recommendation, current_hole):
        return None

    async def _no_profile(user_id):
        return None

    monkeypatch.setattr(tools_mod.sessions, "set_recommendation", _noop_set_recommendation)
    monkeypatch.setattr(tools_mod.memory_mod, "get_player_profile", _no_profile)


def test_log_hole_hazards_intel_numbers_in_message(caplog):
    hole = HoleIntelligence(
        hole_number=7,
        par=4,
        yards=400,
        hazards=[Hazard(type="water", side="left", line_side="left", carry_yards=230)],
    )
    tee = {"lat": 40.12345, "lng": -73.98765}
    with caplog.at_level(logging.INFO, logger="looper.caddie"):
        caddie_routes._log_hole_hazards_intel(hole, tee)
    records = [r for r in caplog.records if r.getMessage().startswith("hole_hazards_intel")]
    assert len(records) == 1
    message = records[0].getMessage()
    assert "hole=7" in message
    assert "n_hazards=1" in message
    assert "tee=40.12345,-73.98765" in message
    assert "water" in message  # the rendered hazards line's numbers/name


def test_log_hole_hazards_intel_missing_tee_is_honest_not_crashing(caplog):
    hole = HoleIntelligence(hole_number=3, par=3, yards=170)
    with caplog.at_level(logging.INFO, logger="looper.caddie"):
        caddie_routes._log_hole_hazards_intel(hole, None)
    records = [r for r in caplog.records if r.getMessage().startswith("hole_hazards_intel")]
    assert len(records) == 1
    assert "tee=unknown" in records[0].getMessage()


def test_log_caddie_reco_context_numbers_in_message(caplog):
    tsn = {"to_green_yards": 145, "drive_total_yards": 260}
    with caplog.at_level(logging.INFO, logger="looper.caddie"):
        caddie_routes._log_caddie_reco_context(5, "water left at 230y", tsn)
    records = [r for r in caplog.records if r.getMessage().startswith("caddie_reco_context")]
    assert len(records) == 1
    message = records[0].getMessage()
    assert "hole=5" in message
    assert "to_green=145" in message
    assert "drive_total=260" in message
    assert "water left at 230y" in message


def test_log_caddie_reco_context_no_tee_shot_numbers_is_honest(caplog):
    with caplog.at_level(logging.INFO, logger="looper.caddie"):
        caddie_routes._log_caddie_reco_context(9, "no hazards", None)
    records = [r for r in caplog.records if r.getMessage().startswith("caddie_reco_context")]
    assert len(records) == 1
    message = records[0].getMessage()
    assert "hole=9" in message
    assert "to_green=None" in message
    assert "drive_total=None" in message


# ── strategy.py:178 — guide-favor vs engine-verdict numbers/sides ──────────


def _session_with_poisoned_guide() -> RoundSession:
    """Trees close on BOTH sides — the engine's verdict is 'center' (no good
    miss), yet the guide confidently favors LEFT — the Red-1 disagreement
    class (specs/caddie-two-tier-routing-plan.md §5, mirrors
    test_guide_verdict_gate.py's `_session_with_poisoned_guide('center')`)."""
    hazards = [
        Hazard(type="trees", side="left", line_side="left", carry_yards=260),
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


async def test_strategy_guide_drop_logs_favor_and_verdict_numbers(caplog):
    session = _session_with_poisoned_guide()
    with caplog.at_level(logging.WARNING, logger="looper.caddie.strategy"):
        payload = await strategy_mod.build_strategy_payload(
            session, "round-1", "user-1", 1, hole_yards=420, yardage_basis="tee-card",
        )
    assert payload["local_knowledge"] == ""

    warnings = [r for r in caplog.records if "strategy guide dropped" in r.getMessage()]
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert "hole=1" in message
    assert "guide_favor=left" in message
    assert "engine_verdict=center" in message
    # Key-free: no guide text, no player/user identifiers in the log line.
    assert "Favor the left side off the tee" not in message
    assert "user-1" not in message
