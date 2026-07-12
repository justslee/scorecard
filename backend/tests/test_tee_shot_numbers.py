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
from app.caddie.types import HoleIntelligence, TeeShotNumbers, WeatherConditions  # noqa: E402
from app.caddie.voice_prompts import format_tee_numbers_line  # noqa: E402


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


# ── T-N6: downhill short-hole frame-alignment (reviewer BLOCKING fix) ───────
#
# Reviewer repro (2026-07): a steep-downhill short hole — 250y hole, a
# driver-200 (stored) bag, -60ft elevation. The physics drive
# (`drive_total_yards`) lands ~254y, which is > the 250y hole — the hole IS
# drivable. But the OLD `is_green_reachable` check judged reachability on
# the still-air plays-like frame (adjusted ~218y vs the stored 200y club +
# margin), which said NOT reachable, so the code took the positioning
# branch and printed a non-closing equation: "to_green 250 - drive 254 =
# leave 0" (floored; truth -4) while claiming the green was out of reach —
# the exact owner-does-the-subtraction confabulation trigger this whole
# cycle exists to kill. Fixed by reclassifying reachable whenever the
# PHYSICS-delivered drive total for the selected club reaches the raw
# to-green distance, even when the still-air frame disagrees.


def test_down60ft_reclassified_reachable_not_confabulated_zero_leave():
    """The reviewer's exact repro: 250y hole, driver-200 bag, -60ft
    elevation. The selected club's physics drive total (254) beats the raw
    hole distance (250), so this MUST classify reachable/approach — never a
    positioning block claiming "green's out of reach ... leaves about 0 in"
    while the drive total already reaches the green."""
    hole = _hole(yards=250, par=3, elevation=-60.0)
    rec = generate_recommendation(hole, 250, {"driver": 200}, handicap=15)

    assert rec.shot_kind == "approach"
    assert rec.tee_shot_numbers is None
    assert rec.leave_yards is None
    assert "out of reach" not in " ".join(rec.reasoning).lower()
    assert "leaves about 0" not in rec.aim_point.description.lower()


@pytest.mark.parametrize(
    "elevation_ft,expect_reachable",
    [
        (-60.0, True),   # physics drive (254) >= hole (250) -> reclassified reachable
        (-55.0, True),   # still clears the hole once elevation is consulted
        (-45.0, False),  # sub-boundary: drive falls just short -> stays positioning
        (-30.0, False),
        (0.0, False),    # flat: nowhere close, unambiguous positioning shot
    ],
    ids=["down60ft", "down55ft", "down45ft-subboundary", "down30ft", "flat"],
)
def test_downhill_short_hole_closure_matrix(elevation_ft, expect_reachable):
    """The missing closure-matrix cell: a 250y hole with a driver-200 bag
    across a downhill elevation sweep, from squarely reclassified-reachable
    (down60ft) through a sub-boundary case that still falls short (down45ft)
    down to flat (unambiguous positioning). Every non-reachable cell must
    close its equation EXACTLY with a genuinely positive leave — reaching
    this branch at all now structurally implies the selected club's physics
    drive fell short of the raw hole distance."""
    hole = _hole(yards=250, par=3, elevation=elevation_ft)
    rec = generate_recommendation(hole, 250, {"driver": 200}, handicap=15)

    if expect_reachable:
        assert rec.shot_kind == "approach"
        assert rec.tee_shot_numbers is None
        return

    assert rec.shot_kind == "positioning"
    n = rec.tee_shot_numbers
    assert n is not None
    # Gate (1) invariant, still signed — closes EXACTLY.
    assert n.to_green_yards - n.drive_total_yards == n.leave_exact_yards
    # A positioning verdict now structurally implies the drive fell short.
    assert n.leave_exact_yards > 0
    assert n.drive_total_yards < n.to_green_yards


# ── T-N7: format_tee_numbers_line corridor clause
# (specs/corridor-width-club-selection-plan.md §7, §9-D) ───────────────────


def _base_numbers(**overrides) -> TeeShotNumbers:
    fields = dict(
        hole_number=3, to_green_yards=400, plays_like_yards=400, club="hybrid",
        club_stored_yards=200, drive_carry_yards=193, drive_total_yards=217,
        leave_exact_yards=183, leave_yards=185,
    )
    fields.update(overrides)
    return TeeShotNumbers(**fields)


def test_corridor_fields_none_is_byte_identical_to_todays_string():
    """No corridor fields set (every v1/reachable turn today) -> the line is
    exactly what `format_tee_numbers_line` produced before this change —
    no trailing clause, no extra characters."""
    n = _base_numbers()
    line = format_tee_numbers_line(n)
    assert "Corridor" not in line
    assert line == (
        "Tee-shot numbers for hole 3 (AUTHORITATIVE — they close: "
        "400 − 217 = 183): 400 to the green; plays like 400; "
        "Hybrid — 200 stored, carries 193 and totals 217 in these conditions; "
        "leaves about 185 in. Speak ONLY these numbers for this tee shot."
    )


def test_corridor_fields_set_appends_exact_numbers():
    """Corridor fields set -> an append-only clause naming exactly those
    numbers, nothing else invented."""
    n = _base_numbers(
        corridor_pinch_width_yards=30,
        corridor_pinch_distance_yards=220,
        corridor_capped_from_club="driver",
        corridor_capped_from_window_yards=45,
        corridor_club_window_yards=36,
    )
    line = format_tee_numbers_line(n)
    # The base sentence is untouched (append-only, not a rewrite).
    assert line.startswith(
        "Tee-shot numbers for hole 3 (AUTHORITATIVE — they close: "
        "400 − 217 = 183): 400 to the green; plays like 400; "
        "Hybrid — 200 stored, carries 193 and totals 217 in these conditions; "
        "leaves about 185 in. Speak ONLY these numbers for this tee shot."
    )
    assert (
        " Corridor: pinches to ~30 at 220; Driver's zone needs ~45, "
        "Hybrid's ~36 fits."
    ) in line
