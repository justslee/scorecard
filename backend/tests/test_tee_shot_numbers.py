"""Regression tests for `TeeShotNumbers` — the one-solve tee/positioning-shot
numbers block (specs/caddie-numbers-coherence-plan.md §2, §7 T-N1-T-N5).

Owner incident (2026-07, Bethpage Black hole 1, 466y par 4): the caddie
spoke a leave of 125, a raw bag driver of 300, and a physics total of 280 —
three truthful-in-isolation numbers from three unconnected sources that
never had to agree. This file locks the fix: ONE computed block that closes
exactly, and the structural root cause (the `/session/recommend` HTTP path
solving the hardcoded `yards=400` default instead of the real hole yardage).

Pure, no DB/network — mirrors `test_positioning_shot.py`'s bag/fixture style.
`recommend_payload` (T-N3) is DB-touching only for its persistence write
(`sessions.set_recommendation`), monkeypatched to a no-op here.
"""

from __future__ import annotations

import itertools
import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from app.caddie.aim_point import generate_recommendation  # noqa: E402
from app.caddie.club_selection import DEFAULT_CLUB_DISTANCES  # noqa: E402
from app.caddie.session import RoundSession  # noqa: E402
from app.caddie import tools as tools_mod  # noqa: E402
from app.caddie.tools import shot_distance_payload  # noqa: E402
from app.caddie.types import HoleIntelligence, WeatherConditions  # noqa: E402


def _hole(yards: int = 466, par: int = 4, elevation: float = 0.0) -> HoleIntelligence:
    return HoleIntelligence(hole_number=1, par=par, yards=yards, elevation_change_ft=elevation)


# ── T-N1: closure matrix ─────────────────────────────────────────────────────

_DISTANCES = [320, 400, 425, 466, 560]
_BAGS: list[dict[str, int]] = [
    {"driver": 230},
    {"driver": 280},
    {"driver": 300},
    {"driver": 320},
    {},  # empty -> DEFAULT_CLUB_DISTANCES fallback
]
# (label, weather, elevation_ft, competition_legal)
_CONDITIONS: list[tuple[str, "WeatherConditions | None", float, bool]] = [
    ("still", None, 0.0, False),
    ("head6", WeatherConditions(wind_speed_mph=6, wind_direction=0), 0.0, False),
    ("head12", WeatherConditions(wind_speed_mph=12, wind_direction=0), 0.0, False),
    ("tail8", WeatherConditions(wind_speed_mph=8, wind_direction=180), 0.0, False),
    ("up40ft", None, 40.0, False),
    ("competition_legal", WeatherConditions(wind_speed_mph=10, wind_direction=0), 0.0, True),
]


_MATRIX_CASES = list(itertools.product(_DISTANCES, _BAGS, _CONDITIONS))


@pytest.mark.parametrize(
    "distance,bag,cond",
    _MATRIX_CASES,
    ids=[
        f"{d}y-{','.join(f'{k}{v}' for k, v in b.items()) or 'default'}-{c[0]}"
        for d, b, c in _MATRIX_CASES
    ],
)
def test_closure_matrix(distance, bag, cond):
    _label, weather, elevation, competition_legal = cond
    hole = _hole(yards=distance, elevation=elevation)
    rec = generate_recommendation(
        hole, distance, bag, handicap=15, weather=weather,
        shot_bearing=0.0, competition_legal=competition_legal,
    )

    if rec.shot_kind == "approach":
        # Reachable cells (e.g. 320 vs a 320y-driver bag) never produce a
        # tee-shot-numbers block — the reachable/flag path is untouched.
        assert rec.tee_shot_numbers is None
        return

    n = rec.tee_shot_numbers
    assert n is not None

    # Gate (1) invariants — specs/caddie-numbers-coherence-plan.md §6.
    assert n.to_green_yards - n.drive_total_yards == n.leave_exact_yards
    assert abs(n.leave_yards - n.leave_exact_yards) <= 2
    assert n.plays_like_yards == rec.target_yards

    clubs = bag or DEFAULT_CLUB_DISTANCES
    assert n.club_stored_yards == clubs[n.club]

    if competition_legal:
        assert n.drive_total_yards == n.club_stored_yards
        assert n.drive_carry_yards is None
        assert n.plays_like_yards == n.to_green_yards


# ── T-N2: Bethpage-1 incident pin ────────────────────────────────────────────


def test_bethpage1_incident_pin_125_is_unconstructible():
    """466y, driver 300, still air: the leave closes exactly against the
    physics-solved drive total, and 125 — the incident's spoken number — is
    structurally impossible once intel.yards (466) is consulted instead of
    the old fake 400 default."""
    hole = _hole(yards=466, par=4)
    rec = generate_recommendation(hole, 466, {"driver": 300}, handicap=15)

    assert rec.shot_kind == "positioning"
    n = rec.tee_shot_numbers
    assert n is not None
    assert n.to_green_yards == 466
    assert n.leave_exact_yards == 466 - n.drive_total_yards
    assert n.leave_yards != 125
    # The old incident's exact solve (400 fake input, still air) landed at
    # 100; even the closest legitimate near-miss the incident traced (a
    # ~425-adjusted solve) landed at exactly 125 — neither is reachable from
    # the real 466y input.
    assert n.leave_yards not in (100, 125)
    # The aim description speaks the SAME leave the payload carries — no
    # second, independently-derived number.
    assert str(n.leave_yards) in rec.aim_point.description


# ── T-N3: fake-default dead (recommend_payload) ──────────────────────────────


def _session(hole_intel=None, club_distances=None, weather=None) -> RoundSession:
    return RoundSession(
        round_id="round-1", user_id="user-1", current_hole=1,
        hole_intel=hole_intel or {}, club_distances=club_distances or {}, weather=weather,
    )


@pytest.fixture(autouse=True)
def _no_db_persist(monkeypatch):
    """`recommend_payload` persists via `sessions.set_recommendation` (a real
    DB write) — irrelevant to what this file tests (the distance-resolution
    ladder), so it's a no-op here, same pattern as test_golden_tier1.py's
    DB-dependency monkeypatches."""
    async def _noop(round_id, recommendation, current_hole):
        return None

    monkeypatch.setattr(tools_mod.sessions, "set_recommendation", _noop)


async def test_recommend_payload_solves_intel_yards_not_400():
    """`distance_yards=None, yards=None`, but the cached hole_intel carries
    the real 466y — the structural root cause of the '125' incident (the
    `/session/recommend` HTTP path solving the hardcoded yards=400 default
    instead of ever consulting intel.yards)."""
    session = _session(
        hole_intel={1: HoleIntelligence(hole_number=1, par=4, yards=466)},
        club_distances={"driver": 300},
    )
    payload = await tools_mod.recommend_payload(
        session, "round-1", 1, distance_yards=None, yards=None,
    )
    assert payload.get("error") is None
    assert payload["raw_yards"] == 466
    # The old fake default can never be the solved distance again.
    assert payload["raw_yards"] != 400


async def test_recommend_payload_no_signal_is_honest_error_not_400():
    """All three distance signals absent (no explicit distance, no resolved
    yards, no cached intel) → an honest error dict, never a solve on a
    fabricated 400."""
    session = _session()
    payload = await tools_mod.recommend_payload(
        session, "round-1", 1, distance_yards=None, yards=None,
    )
    assert "error" in payload
    assert "raw_yards" not in payload


async def test_recommend_payload_explicit_distance_still_wins():
    """The explicit distance_yards beats both yards and intel — unchanged
    ladder ordering (spec §2.1)."""
    session = _session(
        hole_intel={1: HoleIntelligence(hole_number=1, par=4, yards=466)},
    )
    payload = await tools_mod.recommend_payload(
        session, "round-1", 1, distance_yards=150, yards=400,
    )
    assert payload["raw_yards"] == 150


# ── T-N4: physics parity with get_shot_distance ──────────────────────────────


def test_drive_physics_matches_get_shot_distance_tool():
    """`compute_tee_shot_numbers`'s drive carry/total is the EXACT SAME call
    shape `shot_distance_payload` (`get_shot_distance`) uses — same weather,
    same bearing, same elevation, same stored club distance — so the two
    numbers can never disagree within one caddie turn."""
    weather = WeatherConditions(wind_speed_mph=6, wind_direction=0)
    session = _session(
        hole_intel={1: HoleIntelligence(hole_number=1, par=4, yards=466, elevation_change_ft=0.0)},
        club_distances={"driver": 300},
        weather=weather,
    )
    hole = session.hole_intel[1]
    rec = generate_recommendation(
        hole, 466, session.club_distances, handicap=15, weather=weather, shot_bearing=0.0,
    )
    n = rec.tee_shot_numbers
    assert n is not None

    tool_payload = shot_distance_payload(session, hole_number=1, club="driver")
    assert tool_payload["available"] is True
    assert n.drive_carry_yards == tool_payload["carry_yards"]
    assert n.drive_total_yards == tool_payload["total_yards"]


# ── T-N5: headwind-leaves-MORE inversion pin ─────────────────────────────────


def test_headwind_leave_is_never_less_than_still_air():
    """The confabulated incident line ('wind adding effective yards, that's
    why we leave LESS') is backwards — a hole playing longer into the wind
    leaves MORE after the drive, never less. Pinned here so a physics or
    wiring regression can't silently reintroduce the inversion."""
    hole_still = _hole(yards=466)
    rec_still = generate_recommendation(hole_still, 466, {"driver": 300}, handicap=15)

    hole_wind = _hole(yards=466)
    weather = WeatherConditions(wind_speed_mph=10, wind_direction=0)
    rec_wind = generate_recommendation(
        hole_wind, 466, {"driver": 300}, handicap=15, weather=weather, shot_bearing=0.0,
    )

    assert rec_still.tee_shot_numbers is not None
    assert rec_wind.tee_shot_numbers is not None
    assert rec_wind.tee_shot_numbers.leave_exact_yards >= rec_still.tee_shot_numbers.leave_exact_yards
