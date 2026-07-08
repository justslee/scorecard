"""Unit tests for caddie/aim_point.py — pure, no DB/network."""

from app.caddie.aim_point import (
    classify_pin_position,
    compute_aim_point,
    compute_miss_side,
    generate_recommendation,
)
from app.caddie.types import (
    HoleIntelligence,
    Hazard,
    PlayerStatistics,
    PlayerTendencies,
    WeatherConditions,
    CaddieRecommendation,
)


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_hole(
    hazards: list | None = None,
    par: int = 4,
    yards: int = 400,
    elevation: float = 0.0,
) -> HoleIntelligence:
    return HoleIntelligence(
        hole_number=1,
        par=par,
        yards=yards,
        elevation_change_ft=elevation,
        hazards=hazards or [],
    )


def _water(side: str, severity: str = "severe", distance: float = 5.0) -> Hazard:
    return Hazard(type="water", side=side, penalty_severity=severity, distance_from_green=distance)


def _bunker(side: str, severity: str = "moderate", distance: float = 5.0) -> Hazard:
    return Hazard(type="bunker", side=side, penalty_severity=severity, distance_from_green=distance)


def _player_stats(miss_dir: str = "balanced", rounds: int = 0) -> PlayerStatistics:
    return PlayerStatistics(
        rounds_analyzed=rounds,
        tendencies=PlayerTendencies(miss_direction=miss_dir),
    )


# ── classify_pin_position ─────────────────────────────────────────────────────

class TestClassifyPinPosition:
    """Traffic-light classification: green / yellow / red."""

    def test_no_hazards_green(self):
        assert classify_pin_position(_make_hole()) == "green"

    def test_one_severe_close_yellow(self):
        hole = _make_hole(hazards=[_water("right", severity="severe", distance=5.0)])
        assert classify_pin_position(hole) == "yellow"

    def test_two_severe_close_red(self):
        hole = _make_hole(hazards=[
            _water("right", severity="severe", distance=5.0),
            _water("left", severity="severe", distance=3.0),
        ])
        assert classify_pin_position(hole) == "red"

    def test_death_hazard_yellow(self):
        hole = _make_hole(hazards=[_water("right", severity="death", distance=15.0)])
        assert classify_pin_position(hole) == "yellow"

    def test_two_death_hazards_close_red(self):
        hole = _make_hole(hazards=[
            _water("right", severity="death", distance=5.0),
            _water("left", severity="death", distance=5.0),
        ])
        assert classify_pin_position(hole) == "red"

    def test_mild_hazard_far_green(self):
        # severity="mild" → not severe/death → only death_hazards check, no deaths → green
        hole = _make_hole(hazards=[
            Hazard(type="bunker", side="right", penalty_severity="mild", distance_from_green=20.0)
        ])
        assert classify_pin_position(hole) == "green"

    def test_severe_hazard_far_away_green(self):
        # distance > 10 → not in severe_close → green (no death either)
        hole = _make_hole(hazards=[
            Hazard(type="water", side="right", penalty_severity="severe", distance_from_green=15.0)
        ])
        assert classify_pin_position(hole) == "green"


# ── compute_aim_point ─────────────────────────────────────────────────────────

class TestComputeAimPoint:
    """Returns AimPoint with a human description."""

    def test_green_light_no_trouble(self):
        hole = _make_hole()
        aim = compute_aim_point(hole, player_stats=None)
        assert "flag" in aim.description.lower() or "green light" in aim.description.lower()

    def test_red_light_aim_center(self):
        hole = _make_hole(hazards=[
            _water("right", severity="severe", distance=5.0),
            _water("left", severity="severe", distance=3.0),
        ])
        aim = compute_aim_point(hole, player_stats=None)
        assert "center" in aim.description.lower()

    def test_yellow_light_intermediate(self):
        hole = _make_hole(hazards=[_water("right", severity="severe", distance=5.0)])
        aim = compute_aim_point(hole, player_stats=None)
        assert "between" in aim.description.lower() or "pin" in aim.description.lower()

    def test_death_right_balanced_player_favors_left(self):
        hole = _make_hole(hazards=[_water("right", severity="death", distance=5.0)])
        aim = compute_aim_point(hole, player_stats=_player_stats("balanced"))
        assert "left" in aim.description.lower()

    def test_death_left_left_miss_player_favors_right(self):
        hole = _make_hole(hazards=[_water("left", severity="death", distance=5.0)])
        aim = compute_aim_point(hole, player_stats=_player_stats("left"))
        assert "right" in aim.description.lower()

    def test_returns_aim_point_type(self):
        from app.caddie.types import AimPoint
        hole = _make_hole()
        aim = compute_aim_point(hole, player_stats=None)
        assert isinstance(aim, AimPoint)


# ── compute_miss_side ─────────────────────────────────────────────────────────

class TestComputeMissSide:
    """Identifies safest miss direction; penalizes the dangerous side."""

    def test_no_hazards_prefers_short(self):
        hole = _make_hole()
        miss = compute_miss_side(hole, player_stats=None)
        assert miss.preferred == "short"

    def test_water_right_prefers_left(self):
        hole = _make_hole(hazards=[_water("right", severity="death", distance=5.0)])
        miss = compute_miss_side(hole, player_stats=None)
        assert miss.preferred == "left"

    def test_water_left_prefers_right(self):
        hole = _make_hole(hazards=[_water("left", severity="death", distance=5.0)])
        miss = compute_miss_side(hole, player_stats=None)
        assert miss.preferred == "right"

    def test_avoid_side_opposite_preferred(self):
        hole = _make_hole(hazards=[_water("right", severity="death", distance=5.0)])
        miss = compute_miss_side(hole, player_stats=None)
        avoid_map = {"left": "right", "right": "left", "short": "long", "long": "short"}
        assert miss.avoid.startswith(f"Don't miss {avoid_map[miss.preferred]}")

    def test_returns_miss_side_type(self):
        from app.caddie.types import MissSide
        hole = _make_hole()
        miss = compute_miss_side(hole, player_stats=None)
        assert isinstance(miss, MissSide)

    def test_front_water_prefers_long(self):
        hole = _make_hole(hazards=[
            Hazard(type="water", side="front", penalty_severity="death", distance_from_green=5.0)
        ])
        miss = compute_miss_side(hole, player_stats=None)
        assert miss.preferred == "long"


# ── generate_recommendation ───────────────────────────────────────────────────

class TestGenerateRecommendation:
    """Full orchestration: club + aim + miss + adjustments + confidence."""

    def _standard_bag(self) -> dict:
        return {
            "driver": 250,
            "7iron": 160,
            "9iron": 140,
            "pw": 130,
            "sw": 100,
        }

    def test_returns_caddie_recommendation_type(self):
        hole = _make_hole()
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        assert isinstance(rec, CaddieRecommendation)

    def test_club_is_string(self):
        hole = _make_hole()
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        assert isinstance(rec.club, str)
        assert len(rec.club) > 0

    def test_target_yards_close_to_raw(self):
        # No weather/elevation → target_yards == distance_yards
        hole = _make_hole(elevation=0.0)
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        assert rec.raw_yards == 150
        assert rec.target_yards == 150

    def test_elevation_adjusts_target(self):
        hole = _make_hole(elevation=15.0)  # 15ft uphill → +5 yards
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        assert rec.target_yards == 155
        assert rec.raw_yards == 150

    def test_reasoning_is_list_of_strings(self):
        hole = _make_hole()
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        assert isinstance(rec.reasoning, list)
        assert all(isinstance(s, str) for s in rec.reasoning)
        assert len(rec.reasoning) > 0

    def test_confidence_in_range(self):
        hole = _make_hole()
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        assert 0.0 <= rec.confidence <= 1.0

    def test_aggressiveness_valid_value(self):
        hole = _make_hole()
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        assert rec.aggressiveness in ("conservative", "moderate", "aggressive")

    def test_red_pin_conservative_aggressiveness(self):
        # Two severe hazards → red pin → conservative aggressiveness
        hole = _make_hole(hazards=[
            _water("right", severity="severe", distance=5.0),
            _water("left", severity="severe", distance=5.0),
        ])
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        assert rec.aggressiveness == "conservative"

    def test_no_hazards_no_weather_aggressive(self):
        # Green pin + no hazards → aggressive
        hole = _make_hole()
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        assert rec.aggressiveness == "aggressive"

    def test_expected_score_is_float(self):
        hole = _make_hole()
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        assert rec.expected_score is not None
        assert isinstance(rec.expected_score, float)
        # Reasonable range: 2–5 strokes from 150 yards for most handicaps
        assert 1.5 <= rec.expected_score <= 5.5

    def test_empty_club_distances_uses_defaults(self):
        hole = _make_hole()
        rec = generate_recommendation(hole, 150, {}, handicap=15)
        # Should not raise; club comes from DEFAULT_CLUB_DISTANCES
        assert isinstance(rec.club, str)
        assert len(rec.club) > 0

    def test_adjustments_list_type(self):
        hole = _make_hole()
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        assert isinstance(rec.adjustments, list)

    def test_weather_adds_to_confidence(self):
        hole = _make_hole()
        rec_no_weather = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        weather = WeatherConditions(temperature_f=70.0, wind_speed_mph=0.0)
        rec_weather = generate_recommendation(hole, 150, self._standard_bag(), handicap=15, weather=weather)
        assert rec_weather.confidence > rec_no_weather.confidence

    def test_hazards_add_to_confidence(self):
        no_haz = _make_hole()
        haz_hole = _make_hole(hazards=[_water("right", severity="moderate", distance=10.0)])
        rec_no = generate_recommendation(no_haz, 150, self._standard_bag(), handicap=15)
        rec_haz = generate_recommendation(haz_hole, 150, self._standard_bag(), handicap=15)
        assert rec_haz.confidence > rec_no.confidence

    def test_none_yards_never_throws(self):
        """hole.yards can be None (unknown yardage, honest — no fake 400).
        line 286's is_tee_shot check must not crash on None * 0.85; falls
        back to the conservative (approach-shot) bias."""
        hole = HoleIntelligence(hole_number=1, par=4, yards=None, hazards=[])
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15)
        assert isinstance(rec, CaddieRecommendation)
        assert isinstance(rec.club, str)
        assert len(rec.club) > 0

    def test_player_stats_with_history_adds_reasoning(self):
        from app.caddie.types import HolePlayerHistory
        hole = HoleIntelligence(
            hole_number=1, par=4, yards=400,
            player_history=HolePlayerHistory(
                times_played=5, avg_score=4.8, best_score=4, worst_score=6
            ),
            hazards=[],
        )
        stats = _player_stats("balanced", rounds=10)
        rec = generate_recommendation(hole, 150, self._standard_bag(), handicap=15, player_stats=stats)
        # Player history with ≥3 rounds should appear in reasoning
        history_lines = [r for r in rec.reasoning if "history" in r.lower() or "rounds" in r.lower()]
        assert len(history_lines) >= 1
