"""Tests for the competition-legal (USGA-conforming) caddie mode.

USGA Rule 4-3/10.3a: a distance-measuring device that factors in slope, wind,
temperature, or other environmental conditions is NOT conforming for tournament
play.  When competition_legal=True, generate_recommendation() MUST:

  - Set target_yards == raw_yards (pure geometric distance only)
  - Return an empty adjustments list
  - Tag the response with competition_legal=True in the recommendation

When competition_legal=False (the default), environmental adjustments MUST still
be applied as before (regression guard).
"""

from app.caddie.aim_point import generate_recommendation
from app.caddie.types import (
    HoleIntelligence,
    Hazard,
    WeatherConditions,
)


# ── helpers ───────────────────────────────────────────────────────────────────


def _make_hole(elevation: float = 0.0, yards: int = 400) -> HoleIntelligence:
    return HoleIntelligence(
        hole_number=7,
        par=4,
        yards=yards,
        elevation_change_ft=elevation,
        hazards=[
            Hazard(type="water", side="right", penalty_severity="severe", distance_from_green=5.0)
        ],
    )


def _bag() -> dict[str, int]:
    return {
        "driver": 250,
        "7iron": 160,
        "9iron": 140,
        "pw": 130,
        "sw": 100,
    }


def _weather_with_adjustments() -> WeatherConditions:
    """Return a WeatherConditions object guaranteed to produce adjustments.

    Wind at 20 mph (above the 3 mph threshold), cold temperature (40°F, far from
    the 70°F baseline), and mild altitude all contribute non-zero adjustments for
    a 150-yard shot.
    """
    return WeatherConditions(
        temperature_f=40.0,   # 30°F cold → temp_adj significant
        wind_speed_mph=20.0,  # well above 3 mph threshold
        wind_direction=180,   # headwind (shot generally goes toward 0°)
        altitude_ft=3000.0,   # above 500 ft threshold
        conditions="medium",
    )


# ── competition_legal=True: all distance adjustments MUST be zeroed ───────────


class TestCompetitionLegalOn:
    """Core legal-correctness assertions."""

    def test_target_equals_raw_no_weather(self):
        """Elevation alone is zeroed in competition-legal mode."""
        hole = _make_hole(elevation=30.0)  # 10 yd uphill adjustment normally
        rec = generate_recommendation(hole, 150, _bag(), competition_legal=True)
        assert rec.target_yards == rec.raw_yards == 150, (
            f"Expected target=raw=150, got target={rec.target_yards}, raw={rec.raw_yards}"
        )

    def test_adjustments_list_empty_no_weather(self):
        hole = _make_hole(elevation=30.0)
        rec = generate_recommendation(hole, 150, _bag(), competition_legal=True)
        assert rec.adjustments == [], (
            f"Expected no adjustments in competition-legal mode, got: {rec.adjustments}"
        )

    def test_target_equals_raw_with_weather(self):
        """Wind + temperature + altitude ALL zeroed when competition_legal=True."""
        hole = _make_hole()
        weather = _weather_with_adjustments()
        rec = generate_recommendation(
            hole, 150, _bag(), weather=weather, competition_legal=True
        )
        assert rec.target_yards == rec.raw_yards == 150, (
            f"Expected target=raw=150, got target={rec.target_yards}, raw={rec.raw_yards}"
        )

    def test_adjustments_list_empty_with_weather(self):
        """The adjustments list is empty even when weather would normally produce entries."""
        hole = _make_hole()
        weather = _weather_with_adjustments()
        rec = generate_recommendation(
            hole, 150, _bag(), weather=weather, competition_legal=True
        )
        assert rec.adjustments == [], (
            f"Expected no adjustments, got: {rec.adjustments}"
        )

    def test_competition_legal_flag_true_on_response(self):
        """The recommendation object is tagged competition_legal=True."""
        hole = _make_hole()
        rec = generate_recommendation(hole, 150, _bag(), competition_legal=True)
        assert rec.competition_legal is True

    def test_reasoning_mentions_competition_legal(self):
        """Reasoning includes a note about competition-legal mode being active."""
        hole = _make_hole()
        rec = generate_recommendation(hole, 150, _bag(), competition_legal=True)
        legal_lines = [r for r in rec.reasoning if "competition" in r.lower()]
        assert len(legal_lines) >= 1, (
            f"Expected at least one reasoning line mentioning 'competition', got: {rec.reasoning}"
        )

    def test_club_selection_still_works(self):
        """Club selection runs correctly off raw yardage even in competition-legal mode."""
        hole = _make_hole(elevation=30.0)
        rec = generate_recommendation(hole, 150, _bag(), competition_legal=True)
        assert isinstance(rec.club, str) and len(rec.club) > 0

    def test_aim_miss_side_unchanged(self):
        """Aim point and miss-side logic are unaffected by the flag."""
        hole = _make_hole()
        rec_std = generate_recommendation(hole, 150, _bag(), competition_legal=False)
        rec_leg = generate_recommendation(hole, 150, _bag(), competition_legal=True)
        assert rec_std.aim_point.description == rec_leg.aim_point.description
        assert rec_std.miss_side.preferred == rec_leg.miss_side.preferred


# ── competition_legal=False: adjustments MUST still apply (regression guard) ──


class TestCompetitionLegalOff:
    """When the flag is False the existing adjustment logic must be unchanged."""

    def test_elevation_adjusts_target(self):
        """15 ft uphill → +5 yd adjustment (unchanged from existing behavior)."""
        hole = _make_hole(elevation=15.0)
        rec = generate_recommendation(hole, 150, _bag(), competition_legal=False)
        assert rec.target_yards == 155, (
            f"Expected 155 from 15ft elevation, got {rec.target_yards}"
        )

    def test_adjustments_present_with_elevation(self):
        hole = _make_hole(elevation=15.0)
        rec = generate_recommendation(hole, 150, _bag(), competition_legal=False)
        assert len(rec.adjustments) > 0, "Expected at least one elevation adjustment"
        types = {a.type for a in rec.adjustments}
        assert "elevation" in types

    def test_adjustments_present_with_weather(self):
        """Wind + temperature MUST appear in adjustments when flag is off."""
        hole = _make_hole()
        weather = _weather_with_adjustments()
        rec = generate_recommendation(
            hole, 150, _bag(), weather=weather, competition_legal=False
        )
        assert len(rec.adjustments) > 0, (
            "Expected at least one adjustment for significant wind + cold temp"
        )

    def test_competition_legal_flag_false_on_response(self):
        hole = _make_hole()
        rec = generate_recommendation(hole, 150, _bag(), competition_legal=False)
        assert rec.competition_legal is False

    def test_default_is_not_competition_legal(self):
        """Omitting competition_legal defaults to False (non-breaking change)."""
        hole = _make_hole(elevation=15.0)
        rec = generate_recommendation(hole, 150, _bag())  # no flag
        assert rec.competition_legal is False
        assert rec.target_yards == 155  # adjustment applied as before


# ── prove adjustments are present without flag so the zeroing is meaningful ───


class TestAdjustmentsActuallyZeroed:
    """Directly compare with/without flag on the same inputs to confirm zeroing."""

    def test_same_input_different_mode(self):
        hole = _make_hole(elevation=30.0)  # 10 yd uphill normally
        weather = _weather_with_adjustments()

        rec_normal = generate_recommendation(
            hole, 150, _bag(), weather=weather, competition_legal=False
        )
        rec_legal = generate_recommendation(
            hole, 150, _bag(), weather=weather, competition_legal=True
        )

        # Non-legal should have adjustments
        assert len(rec_normal.adjustments) > 0
        assert rec_normal.target_yards != rec_normal.raw_yards  # something moved

        # Legal should have none
        assert rec_legal.adjustments == []
        assert rec_legal.target_yards == rec_legal.raw_yards == 150
