"""Unit tests for app/caddie/green_geometry.py — pure rotation geometry.

No network, no database (green_geometry.py has zero DB/network imports by
design, same as hazards.py — see test_hazards.py's header). Follows
specs/caddie-green-slope-spatial-plan.md Sec.6 — the adversarial test table
this module exists to survive.

**RESOLVED SIGN CONVENTION** (plan Sec.0 — read before touching this file):
the physically correct rule is ``uphill_leave_side == fall_side`` (the LOW
side / below the hole). "Slope falls left" -> LEFT is the low side -> a
miss LEFT sits below the hole -> the putt back is UPHILL -> leave/miss LEFT.
The spec's original worked chain ("miss RIGHT for the uphill putt") was
INVERTED and has been corrected (specs/caddie-physics-engine.md Sec.P1, same
commit). Do NOT "fix" this test file to match that inverted chain.
"""

import math

import pytest

from app.caddie.green_geometry import (
    DEADBAND_DEG,
    GREEN_GROUNDING_RULE,
    approach_bearing_deg,
    green_read,
)
from app.caddie.slope_advice import slope_miss_advice
from app.caddie.types import GreenSlope


# ── Coordinate helpers (mirrors test_hazards.py's fixture style) ────────────

_YARDS_TO_M = 0.9144
_LAT_M_PER_DEG = 111_320.0

_TEE_LAT, _TEE_LON = 40.700, -73.000


def _lat_offset_deg(base_lat: float, yards_north: float) -> float:
    return (yards_north * _YARDS_TO_M) / _LAT_M_PER_DEG


def _lon_offset_deg(base_lat: float, yards_east: float) -> float:
    cos_lat = math.cos(math.radians(base_lat))
    return (yards_east * _YARDS_TO_M) / (_LAT_M_PER_DEG * cos_lat)


def _point(base_lat: float, base_lon: float, yards_north: float, yards_east: float):
    """Return (lat, lon) `yards_north`/`yards_east` from (base_lat, base_lon)."""
    lat = base_lat + _lat_offset_deg(base_lat, yards_north)
    lon = base_lon + _lon_offset_deg(base_lat, yards_east)
    return lat, lon


def _green_at_bearing(bearing_deg: float, yards: float = 300.0):
    """A green `yards` downrange from the fixed tee along compass `bearing_deg`."""
    theta = math.radians(bearing_deg)
    yards_north = yards * math.cos(theta)
    yards_east = yards * math.sin(theta)
    return _point(_TEE_LAT, _TEE_LON, yards_north, yards_east)


# ── Sec.6a — the rule-engine matrix (grade=3.0, moderate; s = sin(beta-alpha)) ──

_MODERATE_GRADE = 3.0
_MODERATE_SEVERITY = "moderate"

# (beta, alpha, fall_side, high_side, uphill_leave_side, depth)
_MATRIX_BETA_0 = [
    (0, 0, "none", "none", "none", "long"),        # row 1
    (0, 45, "right", "left", "right", None),        # row 2
    (0, 90, "right", "left", "right", None),        # row 3
    (0, 135, "right", "left", "right", None),       # row 4
    (0, 180, "none", "none", "none", "short"),      # row 5
    (0, 225, "left", "right", "left", None),        # row 6
    (0, 270, "left", "right", "left", None),        # row 7
    (0, 315, "left", "right", "left", None),        # row 8
]

_MATRIX_BETA_225 = [
    (225, 0, "right", "left", "right", None),       # row 9
    (225, 45, "none", "none", "none", "short"),     # row 10
    (225, 90, "left", "right", "left", None),       # row 11
    (225, 135, "left", "right", "left", None),      # row 12
    (225, 180, "left", "right", "left", None),      # row 13
    (225, 225, "none", "none", "none", "long"),     # row 14
    (225, 270, "right", "left", "right", None),     # row 15
    (225, 315, "right", "left", "right", None),     # row 16
]

_FULL_MATRIX = _MATRIX_BETA_0 + _MATRIX_BETA_225


@pytest.mark.parametrize(
    "beta,alpha,fall_side,high_side,uphill_leave_side,depth", _FULL_MATRIX
)
def test_rule_engine_matrix(beta, alpha, fall_side, high_side, uphill_leave_side, depth):
    read = green_read(alpha, _MODERATE_GRADE, _MODERATE_SEVERITY, beta)
    assert read.fall_side == fall_side
    assert read.high_side == high_side
    assert read.uphill_leave_side == uphill_leave_side
    # downhill_leave_side always mirrors high_side — never disagrees.
    assert read.downhill_leave_side == high_side
    assert read.uphill_leave_depth == depth
    assert read.confidence == "high"  # moderate severity


def test_matrix_magnitudes_spot_check():
    """cross_grade_pct/along_grade_pct = percent_grade * |s| / |c| (row 3 and row 1)."""
    row3 = green_read(90, _MODERATE_GRADE, _MODERATE_SEVERITY, 0)  # s=-1, c=0
    assert row3.cross_grade_pct == pytest.approx(3.0, abs=0.01)
    assert row3.along_grade_pct == pytest.approx(0.0, abs=0.01)

    row1 = green_read(0, _MODERATE_GRADE, _MODERATE_SEVERITY, 0)  # s=0, c=1
    assert row1.cross_grade_pct == pytest.approx(0.0, abs=0.01)
    assert row1.along_grade_pct == pytest.approx(3.0, abs=0.01)


def test_read_line_never_speaks_a_bare_compass_word_as_a_side():
    """The spoken sentence is player-frame (left/right/short/long), never a
    raw compass word standing in for a side."""
    for beta, alpha, *_ in _FULL_MATRIX:
        read = green_read(alpha, _MODERATE_GRADE, _MODERATE_SEVERITY, beta)
        for compass in ("north", "south", "east", "west"):
            assert compass not in read.read_line.lower()


# ── Fault-injection sanity: uphill/downhill inversion must be caught ───────


def test_uphill_leave_side_is_never_the_high_side():
    """Pins the exact bug class Sec.0 rules out: an inverted engine would set
    uphill_leave_side == high_side. For every sided row, assert the opposite."""
    for beta, alpha, fall_side, high_side, uphill_leave_side, _ in _FULL_MATRIX:
        if fall_side == "none":
            continue
        read = green_read(alpha, _MODERATE_GRADE, _MODERATE_SEVERITY, beta)
        assert read.uphill_leave_side != read.high_side
        assert read.uphill_leave_side == read.fall_side


# ── Deadband boundary (Sec.2 point 5, Sec.6a fault-detection) ──────────────


def test_deadband_boundary_alpha_beta_plus_or_minus_10_is_none():
    assert green_read(10, _MODERATE_GRADE, _MODERATE_SEVERITY, 0).fall_side == "none"
    assert green_read(350, _MODERATE_GRADE, _MODERATE_SEVERITY, 0).fall_side == "none"


def test_deadband_boundary_alpha_beta_plus_or_minus_25_is_sided():
    right = green_read(25, _MODERATE_GRADE, _MODERATE_SEVERITY, 0)
    assert right.fall_side == "right"
    left = green_read(335, _MODERATE_GRADE, _MODERATE_SEVERITY, 0)
    assert left.fall_side == "left"


def test_deadband_constant_is_20_degrees():
    assert DEADBAND_DEG == 20.0


# ── Severity gating (Sec.2, Sec.6a) ─────────────────────────────────────────


def test_flat_green_is_always_none_regardless_of_angle():
    """A flat green (grade<1%) never reports a side, even at a sideways
    angle that would otherwise be strongly sided."""
    read = green_read(90, 0.5, "flat", 0)
    assert read.fall_side == "none"
    assert read.high_side == "none"
    assert read.uphill_leave_side == "none"
    assert read.confidence == "none"
    assert "flat" in read.read_line.lower()


def test_mild_green_is_sided_but_low_confidence():
    read = green_read(90, 2.0, "mild", 0)  # s=-1, sided
    assert read.fall_side == "right"
    assert read.confidence == "low"


def test_moderate_and_severe_green_are_high_confidence():
    moderate = green_read(90, 3.0, "moderate", 0)
    severe = green_read(90, 6.0, "severe", 0)
    assert moderate.confidence == "high"
    assert severe.confidence == "high"


# ── Sec.6b — coordinate-level: approach_bearing_deg ─────────────────────────


@pytest.mark.parametrize(
    "bearing_deg",
    [0.0, 90.0, 225.0],
)
def test_approach_bearing_deg_matches_the_built_bearing(bearing_deg):
    green_lat, green_lon = _green_at_bearing(bearing_deg, yards=300.0)
    got = approach_bearing_deg(_TEE_LAT, _TEE_LON, green_lat, green_lon)
    assert got == pytest.approx(bearing_deg, abs=0.5)


def test_approach_bearing_deg_degenerate_tee_equals_green_is_none():
    assert approach_bearing_deg(_TEE_LAT, _TEE_LON, _TEE_LAT, _TEE_LON) is None


def test_approach_bearing_deg_degenerate_sub_meter_baseline_is_none():
    # 0.5 metres apart — below the 1m degenerate threshold.
    yards_for_half_meter = 0.5 / _YARDS_TO_M
    near_lat, near_lon = _point(_TEE_LAT, _TEE_LON, yards_for_half_meter, 0)
    assert approach_bearing_deg(_TEE_LAT, _TEE_LON, near_lat, near_lon) is None


def test_end_to_end_coords_tee_south_of_green_slopes_west_leaves_left():
    """Tee south of green (approach bearing ~0, due north) + a green sloping
    west (alpha=270) -> uphill_leave_side == "left", computed entirely from
    coordinates through approach_bearing_deg (no hand-fed bearing)."""
    green_lat, green_lon = _green_at_bearing(0.0, yards=300.0)  # green north of tee
    beta = approach_bearing_deg(_TEE_LAT, _TEE_LON, green_lat, green_lon)
    assert beta == pytest.approx(0.0, abs=0.5)
    read = green_read(270.0, _MODERATE_GRADE, _MODERATE_SEVERITY, beta)
    assert read.uphill_leave_side == "left"


# ── Sec.6c — the owner golden case (pinned) ─────────────────────────────────


def test_owner_golden_slope_falls_left_uphill_leave_is_the_low_side():
    """The owner's 2026-07-09 session: a green "slopes west" (alpha=270),
    approach due north (beta=0). Physically: falls-left -> low side LEFT ->
    a miss/leave LEFT sits below the hole -> the putt back up is UPHILL.

    This fails against pre-fix-by-construction: no `get_green_read` tool or
    `green_geometry` module existed before this slice, so there was nothing
    to return anything but a fabricated answer. specs/
    caddie-green-slope-spatial-plan.md Sec.0: the spec's original worked
    example ("miss RIGHT for the uphill putt") is the HIGH/downhill side —
    that chain is WRONG and must never be restored to "fix" this test.
    """
    read = green_read(270.0, _MODERATE_GRADE, _MODERATE_SEVERITY, 0.0)
    assert read.fall_side == "left"
    assert read.high_side == "right"
    assert read.uphill_leave_side == "left"
    assert read.downhill_leave_side == "right"
    assert "left" in read.read_line.lower()
    # The read speaks the resolved side, never the bare compass word.
    assert "west" not in read.read_line.lower()


# ── Sec.6d — grounding rule + slope_advice cross-consistency ───────────────


def test_green_grounding_rule_is_non_empty_and_names_the_tool():
    assert GREEN_GROUNDING_RULE.strip()
    assert "get_green_read" in GREEN_GROUNDING_RULE
    assert "available:false" in GREEN_GROUNDING_RULE


@pytest.mark.parametrize(
    "beta,alpha,expected_high_side_word",
    [
        (0.0, 90.0, "left"),   # rel=(alpha-beta)%360=90 -> slope_advice: drops right, left is high
        (0.0, 270.0, "right"),  # rel=270 -> slope_advice: drops left, right is high (owner case)
    ],
)
def test_green_read_never_disagrees_with_slope_advice_on_the_high_side(
    beta, alpha, expected_high_side_word
):
    read = green_read(alpha, _MODERATE_GRADE, _MODERATE_SEVERITY, beta)
    assert read.high_side == expected_high_side_word

    slope = GreenSlope(
        direction=alpha, severity=_MODERATE_SEVERITY, percent_grade=_MODERATE_GRADE,
        description="test",
    )
    advice = slope_miss_advice(slope, beta)
    assert advice is not None
    assert f"aim {expected_high_side_word}" in advice.lower()


@pytest.mark.parametrize(
    "beta,alpha",
    [
        (0.0, 90.0),    # rel=90  — falls right
        (0.0, 270.0),   # rel=270 — falls left (owner case)
        (225.0, 315.0), # rel=90  — falls right, non-trivial beta
        (225.0, 135.0), # rel=270 — falls left, non-trivial beta
    ],
)
def test_slope_advice_lateral_framing_matches_green_read(beta, alpha):
    """Framing reconcile (caddie-slope-framing-reconcile): when both modules
    speak about the same lateral tilt, slope_advice must (1) tell the player to
    AIM at green_read's high side, and (2) name green_read's uphill_leave_side
    as the miss that leaves the uphill putt — same words, no opposite-sounding
    cues. A sign flip in slope_advice's rel branches makes aim==fall_side and
    fails here."""
    read = green_read(alpha, _MODERATE_GRADE, _MODERATE_SEVERITY, beta)
    slope = GreenSlope(
        direction=alpha, severity=_MODERATE_SEVERITY,
        percent_grade=_MODERATE_GRADE, description="test",
    )
    advice = slope_miss_advice(slope, beta)
    assert advice is not None
    low = advice.lower()
    assert f"aim {read.high_side}" in low            # aim = HIGH side
    assert f"aim {read.fall_side}" not in low        # never aim at the low side (sign-flip tooth)
    assert f"a miss {read.uphill_leave_side}" in low # miss low side -> uphill putt
    assert "uphill putt" in low                      # shared causal phrase with read_line
