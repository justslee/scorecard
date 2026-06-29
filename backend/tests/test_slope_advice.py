"""Unit tests for caddie/slope_advice.py — pure, no DB / no network.

Covers:
- back-to-front steep slope → advice contains "below the hole" and "miss short"
- right-to-left moderate slope → advice mentions "right" and "high"
- flat or mild → None (no noise)
- None slope → None
- severity gating: only moderate/severe produce advice
- relative-to-approach direction math (same physical slope → different advice
  for different approach bearings)
- determinism (identical inputs → identical output)
"""

from app.caddie.slope_advice import slope_miss_advice
from app.caddie.types import GreenSlope


# ── helpers ───────────────────────────────────────────────────────────────────


def _slope(direction: float, severity: str, percent_grade: float = 2.0) -> GreenSlope:
    return GreenSlope(
        direction=direction,
        severity=severity,
        percent_grade=percent_grade,
        description=f"{severity} slope at {direction}°",
    )


# ── severity gating ───────────────────────────────────────────────────────────


class TestSeverityGating:
    """Only moderate and severe slopes yield advice; flat and mild do not."""

    def test_flat_returns_none(self):
        s = _slope(direction=180.0, severity="flat")
        assert slope_miss_advice(s, approach_bearing_deg=0.0) is None

    def test_mild_returns_none(self):
        s = _slope(direction=180.0, severity="mild")
        assert slope_miss_advice(s, approach_bearing_deg=0.0) is None

    def test_moderate_returns_string(self):
        s = _slope(direction=180.0, severity="moderate")
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert result is not None
        assert isinstance(result, str)

    def test_severe_returns_string(self):
        s = _slope(direction=180.0, severity="severe")
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert result is not None
        assert isinstance(result, str)

    def test_none_slope_returns_none(self):
        assert slope_miss_advice(None, approach_bearing_deg=0.0) is None


# ── back-to-front steep slope (rel ≈ 180°) ───────────────────────────────────


class TestBackToFrontSlope:
    """Slope drops toward the front / near side — golfer should miss short."""

    def _back_to_front(self, approach: float, severity: str = "severe") -> GreenSlope:
        # To get rel ≈ 180°: slope_direction = approach + 180
        direction = (approach + 180) % 360
        return _slope(direction=direction, severity=severity)

    def test_severe_contains_below_hole(self):
        s = self._back_to_front(approach=0.0)
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert result is not None
        assert "below the hole" in result

    def test_severe_contains_miss_short(self):
        s = self._back_to_front(approach=0.0)
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert result is not None
        assert "miss short" in result

    def test_moderate_back_to_front_also_advises(self):
        s = self._back_to_front(approach=0.0, severity="moderate")
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert result is not None
        assert "miss short" in result

    def test_qualifier_word_severe(self):
        s = self._back_to_front(approach=0.0, severity="severe")
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert "hard" in result

    def test_qualifier_word_moderate(self):
        s = self._back_to_front(approach=0.0, severity="moderate")
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert "moderately" in result

    def test_different_approach_bearing_back_to_front(self):
        # Approaching from the west (bearing=270°); slope drops south (270+180=90 → 90°)
        # rel = (90 - 270) % 360 = (-180) % 360 = 180° → back-to-front
        s = _slope(direction=90.0, severity="severe")
        result = slope_miss_advice(s, approach_bearing_deg=270.0)
        assert result is not None
        assert "miss short" in result


# ── right-to-left moderate slope (rel ≈ 270°) ────────────────────────────────


class TestRightToLeftSlope:
    """Slope drops toward golfer's left — right side / high side is favored."""

    def _right_to_left(self, approach: float, severity: str = "moderate") -> GreenSlope:
        # To get rel ≈ 270°: slope_direction = approach + 270 (= approach - 90)
        direction = (approach + 270) % 360
        return _slope(direction=direction, severity=severity)

    def test_moderate_right_to_left_mentions_right(self):
        s = self._right_to_left(approach=0.0)
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert result is not None
        assert "right" in result.lower()

    def test_moderate_right_to_left_mentions_high(self):
        s = self._right_to_left(approach=0.0)
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert result is not None
        assert "high" in result.lower()

    def test_severe_right_to_left(self):
        s = self._right_to_left(approach=0.0, severity="severe")
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert result is not None
        assert "right" in result.lower()


# ── left-to-right slope (rel ≈ 90°) ──────────────────────────────────────────


class TestLeftToRightSlope:
    """Slope drops toward golfer's right — left / high side is favored."""

    def _left_to_right(self, approach: float, severity: str = "moderate") -> GreenSlope:
        # To get rel ≈ 90°: slope_direction = approach + 90
        direction = (approach + 90) % 360
        return _slope(direction=direction, severity=severity)

    def test_moderate_left_to_right_mentions_left(self):
        s = self._left_to_right(approach=0.0)
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert result is not None
        assert "left" in result.lower()

    def test_moderate_left_to_right_mentions_high(self):
        s = self._left_to_right(approach=0.0)
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert result is not None
        assert "high" in result.lower()


# ── front-to-back slope (rel ≈ 0°) ───────────────────────────────────────────


class TestFrontToBackSlope:
    """Slope drops toward the back — back edge is low; advice about pin depth."""

    def _front_to_back(self, approach: float, severity: str = "moderate") -> GreenSlope:
        # To get rel ≈ 0°: slope_direction = approach
        direction = approach % 360
        return _slope(direction=direction, severity=severity)

    def test_moderate_front_to_back_mentions_lower(self):
        s = self._front_to_back(approach=0.0)
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert result is not None
        assert "lower" in result.lower() or "below" in result.lower()

    def test_severe_front_to_back_has_qualifier(self):
        s = self._front_to_back(approach=0.0, severity="severe")
        result = slope_miss_advice(s, approach_bearing_deg=0.0)
        assert result is not None
        assert "hard" in result


# ── relative-to-approach direction math ──────────────────────────────────────


class TestRelativeDirectionMath:
    """Same physical slope gives different advice for different approach bearings."""

    def test_same_slope_opposite_approaches_give_different_advice(self):
        # Physical slope: drops toward north (direction=0°)
        # Approaching from south (bearing=0°, shooting north): rel = 0° → front-to-back
        # Approaching from north (bearing=180°, shooting south): rel = (0-180)%360=180° → back-to-front
        slope = _slope(direction=0.0, severity="severe")

        result_from_south = slope_miss_advice(slope, approach_bearing_deg=0.0)
        result_from_north = slope_miss_advice(slope, approach_bearing_deg=180.0)

        assert result_from_south is not None
        assert result_from_north is not None
        assert result_from_south != result_from_north

    def test_approach_south_shooting_north_front_to_back(self):
        # slope drops north (direction=0°), approach=0° (shooting north)
        # rel=0° → front-to-back category (back is low, pin depth keeps you below)
        slope = _slope(direction=0.0, severity="moderate")
        result = slope_miss_advice(slope, approach_bearing_deg=0.0)
        assert result is not None
        assert "front-to-back" in result.lower()

    def test_approach_north_shooting_south_back_to_front(self):
        # Same physical slope (drops north), but now approaching from north (shooting south)
        # rel = (0 - 180) % 360 = 180° → back-to-front → miss short
        slope = _slope(direction=0.0, severity="moderate")
        result = slope_miss_advice(slope, approach_bearing_deg=180.0)
        assert result is not None
        assert "miss short" in result

    def test_bearing_wraps_correctly_at_360(self):
        # bearing=350°, slope_direction=10°: rel = (10-350)%360 = -340%360 = 20° → front-to-back
        slope = _slope(direction=10.0, severity="moderate")
        result = slope_miss_advice(slope, approach_bearing_deg=350.0)
        assert result is not None
        assert "front-to-back" in result.lower()

    def test_boundary_exactly_45_degrees(self):
        # rel=45° is the boundary; per our definition rel<=45 → front-to-back
        slope = _slope(direction=45.0, severity="moderate")
        result = slope_miss_advice(slope, approach_bearing_deg=0.0)
        assert result is not None
        assert "front-to-back" in result.lower()

    def test_boundary_just_above_45_degrees(self):
        # rel=46° → left-to-right zone (45 < rel <= 135)
        slope = _slope(direction=46.0, severity="moderate")
        result = slope_miss_advice(slope, approach_bearing_deg=0.0)
        assert result is not None
        assert "left to right" in result.lower()


# ── determinism ───────────────────────────────────────────────────────────────


class TestDeterminism:
    """Same inputs always produce identical output."""

    def test_same_severe_back_to_front_is_deterministic(self):
        slope = _slope(direction=180.0, severity="severe")
        r1 = slope_miss_advice(slope, approach_bearing_deg=0.0)
        r2 = slope_miss_advice(slope, approach_bearing_deg=0.0)
        r3 = slope_miss_advice(slope, approach_bearing_deg=0.0)
        assert r1 == r2 == r3

    def test_none_is_always_deterministic(self):
        slope = _slope(direction=180.0, severity="flat")
        for _ in range(5):
            assert slope_miss_advice(slope, approach_bearing_deg=0.0) is None


# ── integration: wired into generate_recommendation ──────────────────────────


class TestWiredIntoRecommendation:
    """Verify slope advice appears in reasoning without changing club/aim/target."""

    def test_severe_back_to_front_appended_to_reasoning(self):
        from app.caddie.aim_point import generate_recommendation
        from app.caddie.types import HoleIntelligence, GreenSlope as GS

        # Back-to-front from approach 0°: slope_direction = 180°
        hole = HoleIntelligence(
            hole_number=1,
            par=4,
            yards=400,
            green_slope=GS(direction=180.0, severity="severe", percent_grade=4.0,
                           description="steep back-to-front"),
            hazards=[],
        )
        rec = generate_recommendation(
            hole,
            distance_yards=150,
            club_distances={"7iron": 160, "9iron": 140, "pw": 130},
            handicap=15.0,
            shot_bearing=0.0,
        )

        # Slope advice must appear in reasoning
        slope_lines = [r for r in rec.reasoning if "miss short" in r or "below the hole" in r]
        assert len(slope_lines) >= 1, f"No slope advice in reasoning: {rec.reasoning}"

    def test_slope_advice_does_not_change_club_or_target(self):
        from app.caddie.aim_point import generate_recommendation
        from app.caddie.types import HoleIntelligence, GreenSlope as GS

        bag = {"7iron": 160, "9iron": 140, "pw": 130}

        # Same hole, without slope
        hole_no_slope = HoleIntelligence(
            hole_number=1, par=4, yards=400, hazards=[], green_slope=None,
        )
        # Same hole, with severe slope
        hole_with_slope = HoleIntelligence(
            hole_number=1, par=4, yards=400, hazards=[],
            green_slope=GS(direction=180.0, severity="severe", percent_grade=4.0,
                           description="steep"),
        )

        rec_no = generate_recommendation(hole_no_slope, 150, bag, handicap=15.0, shot_bearing=0.0)
        rec_yes = generate_recommendation(hole_with_slope, 150, bag, handicap=15.0, shot_bearing=0.0)

        # Club, target, aim_point, miss_side.preferred must be identical
        assert rec_no.club == rec_yes.club
        assert rec_no.target_yards == rec_yes.target_yards
        assert rec_no.aim_point.description == rec_yes.aim_point.description
        assert rec_no.miss_side.preferred == rec_yes.miss_side.preferred

    def test_flat_slope_adds_nothing_to_reasoning(self):
        from app.caddie.aim_point import generate_recommendation
        from app.caddie.types import HoleIntelligence, GreenSlope as GS

        bag = {"7iron": 160, "9iron": 140, "pw": 130}
        hole_flat = HoleIntelligence(
            hole_number=1, par=4, yards=400, hazards=[],
            green_slope=GS(direction=180.0, severity="flat", percent_grade=0.2,
                           description="flat"),
        )
        hole_no_slope = HoleIntelligence(
            hole_number=1, par=4, yards=400, hazards=[], green_slope=None,
        )

        rec_flat = generate_recommendation(hole_flat, 150, bag, handicap=15.0, shot_bearing=0.0)
        rec_none = generate_recommendation(hole_no_slope, 150, bag, handicap=15.0, shot_bearing=0.0)

        # Reasoning length should be identical — flat slope adds nothing
        assert rec_flat.reasoning == rec_none.reasoning
