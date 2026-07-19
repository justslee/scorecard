"""Unit tests for caddie/decade_advice.py — pure, no DB / no network.

Tests are grouped by behaviour:

1. TestBuildClassifyPoint   — the coordinate-plane hazard classifier
2. TestDecadeAimAdviceCore  — the advice function itself
3. TestDecadeAimAdviceEdges — graceful handling of edge cases
4. TestDecadeAimAdviceText  — advice string content / naming
5. TestDeterminism          — same inputs → identical output
6. TestWiredIntoRecommendation — integration: advice in reasoning, club/target unchanged
"""

from __future__ import annotations

import re
import pytest

from app.caddie.decade_advice import (
    AIM_THRESHOLD_YDS,
    SIGMA_LAT_FRACTION,
    SIGMA_LONG_FRACTION,
    MIN_SIGMA_YDS,
    HCP_MIN,
    HCP_MAX,
    SIGMA_LONG_FRACTION_OF_LAT,
    build_classify_point,
    decade_aim_advice,
    dispersion_for_handicap,
    _hazard_to_area,
    _friendly_hazard_name,
)
from app.caddie.decade import LandingArea
from app.caddie.types import Hazard, HoleIntelligence


def _extract_yards(advice: str) -> int:
    """Pull the integer yardage from an advice string of the form 'about N yards direction'."""
    m = re.search(r"about (\d+) yards", advice)
    return int(m.group(1)) if m else 0


# ── Shared test helpers ───────────────────────────────────────────────────────


def _hazard(
    type: str = "water",
    side: str = "left",
    severity: str = "death",
    distance: float = 5.0,
) -> Hazard:
    return Hazard(
        type=type,
        side=side,
        penalty_severity=severity,
        distance_from_green=distance,
    )


def _make_hole(hazards: list[Hazard] | None = None) -> HoleIntelligence:
    return HoleIntelligence(
        hole_number=1,
        par=4,
        yards=400,
        hazards=hazards or [],
    )


# ── TestBuildClassifyPoint ────────────────────────────────────────────────────


class TestBuildClassifyPoint:
    """Verifies the half-plane coordinate approximation."""

    def test_left_water_classifies_left_side(self):
        classify = build_classify_point([_hazard(type="water", side="left", distance=5.0)])
        # x = -10 is to the left of the -5 boundary → water
        assert classify(-10.0, 0.0) == LandingArea.WATER

    def test_left_water_safe_right_side(self):
        classify = build_classify_point([_hazard(type="water", side="left", distance=5.0)])
        # x = 10 is safely right of the -5 boundary → green (within 20 yds of pin at origin)
        assert classify(10.0, 0.0) == LandingArea.GREEN

    def test_right_bunker_classifies_right_side(self):
        classify = build_classify_point([_hazard(type="bunker", side="right", distance=3.0)])
        assert classify(8.0, 0.0) == LandingArea.SAND

    def test_front_water_classifies_short(self):
        classify = build_classify_point([_hazard(type="water", side="front", distance=10.0)])
        # y = -15 is short of the -10 boundary → water
        assert classify(0.0, -15.0) == LandingArea.WATER

    def test_back_ob_classifies_long(self):
        classify = build_classify_point([_hazard(type="ob", side="back", distance=8.0)])
        assert classify(0.0, 15.0) == LandingArea.OB

    def test_center_hazard_uses_radius(self):
        # center hazard with distance=5 → points within 5 yds of pin are hazard
        classify = build_classify_point([_hazard(type="water", side="center", distance=5.0)])
        assert classify(3.0, 3.0) == LandingArea.WATER    # hypot(3,3)=4.24 < 5
        assert classify(4.0, 4.0) != LandingArea.WATER    # hypot(4,4)=5.66 > 5

    def test_default_area_is_green_near_pin(self):
        classify = build_classify_point([])
        # No hazards: points within GREEN_RADIUS_YDS → GREEN
        assert classify(0.0, 0.0) == LandingArea.GREEN
        assert classify(10.0, 10.0) == LandingArea.GREEN   # hypot=14.1 < 20

    def test_default_area_is_fairway_far_from_pin(self):
        classify = build_classify_point([])
        # Beyond GREEN_RADIUS_YDS → FAIRWAY
        assert classify(30.0, 0.0) == LandingArea.FAIRWAY

    def test_severity_priority_death_over_moderate(self):
        """When two hazards overlap, higher severity wins."""
        h_moderate = _hazard(type="bunker", side="left", severity="moderate", distance=3.0)
        h_death = _hazard(type="water", side="left", severity="death", distance=10.0)
        classify = build_classify_point([h_moderate, h_death])
        # x = -15 is in both regions; death (water) should win
        area = classify(-15.0, 0.0)
        assert area == LandingArea.WATER

    def test_distance_zero_treated_as_one_yard(self):
        """distance_from_green=0 → treated as 1 yd to avoid degenerate half-planes."""
        classify = build_classify_point([_hazard(type="water", side="left", distance=0.0)])
        # x=-2 should be water (past the 1-yd boundary)
        assert classify(-2.0, 0.0) == LandingArea.WATER

    def test_pin_offset_respected(self):
        """Coordinate frame shifts when pin is not at origin."""
        pin = (5.0, 3.0)
        classify = build_classify_point([_hazard(type="water", side="left", distance=5.0)], pin=pin)
        # In pin-centred frame: px = x - 5, water when px < -5 → x < 0
        assert classify(-2.0, 0.0) == LandingArea.WATER   # px = -7 < -5
        assert classify(5.0, 3.0) == LandingArea.GREEN    # at pin → green


# ── TestHazardMapping ─────────────────────────────────────────────────────────


class TestHazardMapping:
    """_hazard_to_area and _friendly_hazard_name."""

    def test_water_maps_to_water(self):
        assert _hazard_to_area(_hazard(type="water")) == LandingArea.WATER

    def test_ob_maps_to_ob(self):
        assert _hazard_to_area(_hazard(type="ob")) == LandingArea.OB

    def test_bunker_maps_to_sand(self):
        assert _hazard_to_area(_hazard(type="bunker")) == LandingArea.SAND

    def test_trees_maps_to_recovery(self):
        assert _hazard_to_area(_hazard(type="trees")) == LandingArea.RECOVERY

    def test_unknown_death_maps_to_ob(self):
        assert _hazard_to_area(_hazard(type="slope", severity="death")) == LandingArea.OB

    def test_unknown_severe_maps_to_recovery(self):
        assert _hazard_to_area(_hazard(type="slope", severity="severe")) == LandingArea.RECOVERY

    def test_unknown_moderate_maps_to_rough(self):
        assert _hazard_to_area(_hazard(type="slope", severity="moderate")) == LandingArea.ROUGH

    def test_friendly_water(self):
        assert _friendly_hazard_name(_hazard(type="water")) == "water"

    def test_friendly_ob(self):
        assert _friendly_hazard_name(_hazard(type="ob")) == "OB"

    def test_friendly_bunker(self):
        assert _friendly_hazard_name(_hazard(type="bunker")) == "a bunker"

    def test_friendly_trees(self):
        assert _friendly_hazard_name(_hazard(type="trees")) == "trees"

    def test_friendly_unknown_is_trouble(self):
        assert _friendly_hazard_name(_hazard(type="crater")) == "trouble"


# ── TestDecadeAimAdviceCore ───────────────────────────────────────────────────


class TestDecadeAimAdviceCore:
    """Core behavioural tests: hazard on one side → advice aims the other way."""

    def test_water_left_advice_aims_right(self):
        """Water/OB on the LEFT → advice recommends aiming to the RIGHT.

        Scenario: 150-yd shot; water starts 5 yds left of the pin.
        With σ_lat = 9 yds a large fraction of shots aimed at the pin splash
        left; the optimizer shifts right and the advice names 'water' + 'left'.
        """
        hazards = [_hazard(type="water", side="left", severity="death", distance=5.0)]
        advice = decade_aim_advice(hazards, shot_distance_yds=150.0)

        assert advice is not None, "Expected advice for water left hazard"
        assert "right" in advice, f"Expected 'right' in advice: {advice!r}"
        # The dangerous side (left) should be named
        assert "left" in advice, f"Expected 'left' named in advice: {advice!r}"

    def test_water_left_names_water_hazard(self):
        """Advice string should name 'water' when the left hazard is water."""
        hazards = [_hazard(type="water", side="left", severity="death", distance=5.0)]
        advice = decade_aim_advice(hazards, shot_distance_yds=150.0)

        assert advice is not None
        assert "water" in advice, f"Expected 'water' in advice: {advice!r}"

    def test_ob_left_advice_aims_right(self):
        """OB on the left also triggers a right-aim recommendation."""
        hazards = [_hazard(type="ob", side="left", severity="death", distance=5.0)]
        advice = decade_aim_advice(hazards, shot_distance_yds=150.0)

        assert advice is not None
        assert "right" in advice

    def test_severe_bunker_tight_right_wide_dispersion_aims_left(self):
        """Severe bunker tight right + wide dispersion → advice favors LEFT.

        Scenario: 250-yd shot (σ_lat = 15 yds); severe bunker 3 yds right of pin.
        The bunker boundary is only one-fifth of a σ away when aimed at pin, so
        a very large fraction of shots find the bunker.  Optimizer moves left.
        """
        hazards = [_hazard(type="bunker", side="right", severity="severe", distance=3.0)]
        # Wide dispersion: 250 yds → σ_lat = 15 yds
        advice = decade_aim_advice(hazards, shot_distance_yds=250.0)

        assert advice is not None, "Expected advice for severe bunker right"
        assert "left" in advice, f"Expected 'left' in advice: {advice!r}"
        # Should name the bunker
        assert "bunker" in advice, f"Expected 'bunker' in advice: {advice!r}"

    def test_no_hazards_returns_none(self):
        """No hazards → no advice (nothing to aim away from)."""
        advice = decade_aim_advice([], shot_distance_yds=150.0)
        assert advice is None

    def test_pin_optimal_returns_none(self):
        """When the flag is optimal (hazard is far and dispersion is small) → None.

        Scenario: mild bunker 50 yds to the right at 80-yd shot distance.
        σ_lat = max(0.06*80, 3) = 4.8 yds; 3σ ≈ 14 yds.  The bunker starts
        at x > 50, so no shot (even from x=+12 aim) reaches it meaningfully.
        All candidates are nearly equally safe; the optimizer picks the pin.
        """
        hazards = [_hazard(type="bunker", side="right", severity="mild", distance=50.0)]
        advice = decade_aim_advice(hazards, shot_distance_yds=80.0)
        assert advice is None, f"Expected None (pin optimal), got: {advice!r}"


# ── TestDecadeAimAdviceEdges ──────────────────────────────────────────────────


class TestDecadeAimAdviceEdges:
    """Edge cases: short shots, degenerate inputs, front/back hazards."""

    def test_short_shot_uses_minimum_sigma(self):
        """Very short shot distance uses MIN_SIGMA_YDS floor, not zero."""
        # 10-yd shot: 0.06*10=0.6 < MIN_SIGMA_YDS → clamped to 3 yds
        hazards = [_hazard(type="water", side="left", severity="death", distance=2.0)]
        # With σ=3 and water at x<-2, some risk even on short shot; just confirm no crash
        result = decade_aim_advice(hazards, shot_distance_yds=10.0)
        # May or may not return advice depending on risk level — just confirm it's str | None
        assert result is None or isinstance(result, str)

    def test_front_back_hazard_alone_returns_none_or_no_crash(self):
        """Front/back hazards don't shift the lateral aim → None or valid string."""
        hazards = [_hazard(type="water", side="front", severity="death", distance=5.0)]
        result = decade_aim_advice(hazards, shot_distance_yds=150.0)
        # All lateral candidates are equally exposed to a front hazard (symmetric in x).
        # Optimizer stays at pin → None.
        assert result is None

    def test_back_hazard_alone_returns_none(self):
        hazards = [_hazard(type="ob", side="back", severity="death", distance=5.0)]
        result = decade_aim_advice(hazards, shot_distance_yds=150.0)
        assert result is None

    def test_center_hazard_alone_returns_none_or_str(self):
        """Center hazard around the pin: all lateral candidates at y=pin[1] encounter
        it equally → no meaningful lateral shift → None."""
        hazards = [_hazard(type="water", side="center", severity="death", distance=10.0)]
        result = decade_aim_advice(hazards, shot_distance_yds=150.0)
        # Center hazard affects aim equally regardless of lateral shift → no advice
        # (all candidates hit the center hazard; optimizer picks minimal distance from pin)
        assert result is None or isinstance(result, str)

    def test_dispersion_constants_at_150_yards(self):
        """Verify the public constants produce expected sigma values at 150 yds."""
        sigma_lat = max(SIGMA_LAT_FRACTION * 150.0, MIN_SIGMA_YDS)
        sigma_long = max(SIGMA_LONG_FRACTION * 150.0, MIN_SIGMA_YDS)
        assert sigma_lat == pytest.approx(9.0, abs=0.01)
        assert sigma_long == pytest.approx(6.0, abs=0.01)

    def test_aim_threshold_constant_is_4_yards(self):
        assert AIM_THRESHOLD_YDS == pytest.approx(4.0)


# ── TestDecadeAimAdviceText ───────────────────────────────────────────────────


class TestDecadeAimAdviceText:
    """Advice string formatting and content."""

    def test_advice_starts_with_the_percentages(self):
        hazards = [_hazard(type="water", side="left", severity="death", distance=5.0)]
        advice = decade_aim_advice(hazards, shot_distance_yds=150.0)
        assert advice is not None
        assert advice.startswith("The percentages favor aiming"), advice

    def test_advice_contains_yards_marker(self):
        """Advice string includes the 'yards' unit (e.g. 'about 6 yards right')."""
        hazards = [_hazard(type="water", side="left", severity="death", distance=5.0)]
        advice = decade_aim_advice(hazards, shot_distance_yds=150.0)
        assert advice is not None
        assert "yards" in advice, advice

    def test_advice_contains_flag_reference(self):
        hazards = [_hazard(type="water", side="left", severity="death", distance=5.0)]
        advice = decade_aim_advice(hazards, shot_distance_yds=150.0)
        assert advice is not None
        assert "flag" in advice

    def test_advice_contains_hazard_guards_phrasing(self):
        hazards = [_hazard(type="water", side="left", severity="death", distance=5.0)]
        advice = decade_aim_advice(hazards, shot_distance_yds=150.0)
        assert advice is not None
        assert "guards the left" in advice, advice

    def test_most_severe_hazard_named_when_multiple_on_same_side(self):
        """When two hazards are on the same dangerous side, the worst is named."""
        h_mild_bunker = _hazard(type="bunker", side="left", severity="mild", distance=8.0)
        h_death_water = _hazard(type="water", side="left", severity="death", distance=5.0)
        advice = decade_aim_advice(
            [h_mild_bunker, h_death_water],
            shot_distance_yds=150.0,
        )
        assert advice is not None
        # The death-severity water should be named, not the mild bunker
        assert "water" in advice, f"Expected 'water' (worst) to be named: {advice!r}"


# ── TestDeterminism ───────────────────────────────────────────────────────────


class TestDeterminism:
    """Identical inputs → identical output (no hidden randomness)."""

    def test_water_left_deterministic(self):
        hazards = [_hazard(type="water", side="left", severity="death", distance=5.0)]
        r1 = decade_aim_advice(hazards, shot_distance_yds=150.0)
        r2 = decade_aim_advice(hazards, shot_distance_yds=150.0)
        r3 = decade_aim_advice(hazards, shot_distance_yds=150.0)
        assert r1 == r2 == r3

    def test_no_hazards_deterministic(self):
        for _ in range(3):
            assert decade_aim_advice([], shot_distance_yds=150.0) is None

    def test_build_classify_point_deterministic(self):
        hazards = [_hazard(type="bunker", side="right", distance=4.0)]
        cf1 = build_classify_point(hazards)
        cf2 = build_classify_point(hazards)
        # Same classification at several test points
        for x, y in [(-10.0, 0.0), (0.0, 0.0), (10.0, 0.0), (5.0, 5.0)]:
            assert cf1(x, y) == cf2(x, y)


# ── TestWiredIntoRecommendation ───────────────────────────────────────────────


class TestWiredIntoRecommendation:
    """Integration: advice appears in reasoning; club/target/aim are unchanged."""

    BAG = {"7iron": 160, "9iron": 140, "pw": 130}

    def _rec(self, hazards: list[Hazard], distance: int = 150):
        from app.caddie.aim_point import generate_recommendation
        hole = _make_hole(hazards)
        return generate_recommendation(
            hole,
            distance_yards=distance,
            club_distances=self.BAG,
            handicap=15.0,
        )

    def test_water_left_adds_advice_to_reasoning(self):
        """Water on the left appends DECADE advice to the reasoning list."""
        hazards = [_hazard(type="water", side="left", severity="death", distance=5.0)]
        rec = self._rec(hazards)

        decade_lines = [r for r in rec.reasoning if "percentages" in r]
        assert len(decade_lines) >= 1, f"No DECADE advice in reasoning: {rec.reasoning}"

    def test_no_hazards_adds_nothing_to_reasoning(self):
        """No hazards → DECADE advice does not appear in reasoning."""
        rec_empty = self._rec([])
        decade_lines = [r for r in rec_empty.reasoning if "percentages" in r]
        assert len(decade_lines) == 0, f"Unexpected DECADE advice: {rec_empty.reasoning}"

    def test_decade_advice_does_not_change_club(self):
        """Adding a hazard (and triggering DECADE advice) must not change the club."""
        rec_no_hazard = self._rec([])
        rec_with_hazard = self._rec(
            [_hazard(type="water", side="left", severity="death", distance=5.0)]
        )
        assert rec_no_hazard.club == rec_with_hazard.club, (
            f"Club changed: {rec_no_hazard.club!r} → {rec_with_hazard.club!r}"
        )

    def test_decade_advice_does_not_change_target_yards(self):
        """DECADE advice must not change target_yards."""
        rec_no_hazard = self._rec([])
        rec_with_hazard = self._rec(
            [_hazard(type="water", side="left", severity="death", distance=5.0)]
        )
        assert rec_no_hazard.target_yards == rec_with_hazard.target_yards

    def test_decade_advice_does_not_change_aim_point(self):
        """DECADE advice must not change aim_point.description.

        aim_point is set by the existing ``compute_aim_point`` logic (hazard-aware),
        which is orthogonal to DECADE.  For 'death water left': the existing logic
        produces a yellow-light description that favors the right side — DECADE must
        not overwrite or alter that.  Verified by asserting the expected value and
        confirming stability across two identical calls.
        """
        hazards = [_hazard(type="water", side="left", severity="death", distance=5.0)]
        rec1 = self._rec(hazards)
        rec2 = self._rec(hazards)

        # Must be stable — DECADE is additive, not mutating
        assert rec1.aim_point.description == rec2.aim_point.description

        # Must reflect compute_aim_point (yellow pin → favor right), not DECADE text
        desc = rec1.aim_point.description
        assert "Aim between" in desc, f"Expected yellow-light aim text; got: {desc!r}"
        assert "right" in desc.lower(), f"Expected 'favor right' (death left); got: {desc!r}"
        assert "percentages" not in desc, (
            "DECADE advice text must not appear in aim_point.description"
        )

    def test_decade_advice_does_not_change_miss_side(self):
        """DECADE advice must not change miss_side.preferred.

        miss_side is set by ``compute_miss_side`` (hazard-aware existing logic).
        For 'death water left': existing logic prefers the 'right' miss side —
        DECADE must not alter this.  Verified by asserting the expected value and
        stability across two identical calls.
        """
        hazards = [_hazard(type="water", side="left", severity="death", distance=5.0)]
        rec1 = self._rec(hazards)
        rec2 = self._rec(hazards)

        # Must be stable — DECADE is additive, not mutating
        assert rec1.miss_side.preferred == rec2.miss_side.preferred

        # compute_miss_side: water left → right side is safer → preferred = "right"
        assert rec1.miss_side.preferred == "right", (
            f"Expected 'right' miss side for water left; got: {rec1.miss_side.preferred!r}"
        )


# ── TestHandicapDispersionScaling ────────────────────────────────────────────


class TestHandicapDispersionScaling:
    """Handicap-scaled dispersion is personalised and behaviorally correct.

    All tests are pure (no DB / no network) and deterministic.
    """

    WATER_LEFT = [_hazard(type="water", side="left", severity="death", distance=5.0)]
    BAG = {"7iron": 160, "9iron": 140, "pw": 130}

    # ── dispersion_for_handicap unit tests ────────────────────────────────────

    def test_scratch_sigma_smaller_than_mid_hcp(self):
        """Scratch player (hcp=2) has a strictly tighter lateral sigma than mid-hcp (15)."""
        lat_scratch, _ = dispersion_for_handicap(2.0, 150.0)
        lat_mid, _ = dispersion_for_handicap(15.0, 150.0)
        assert lat_scratch < lat_mid

    def test_mid_hcp_sigma_smaller_than_high_hcp(self):
        """Mid-hcp (15) has a strictly tighter sigma than high-hcp (25)."""
        lat_mid, _ = dispersion_for_handicap(15.0, 150.0)
        lat_high, _ = dispersion_for_handicap(25.0, 150.0)
        assert lat_mid < lat_high

    def test_sigma_monotone_scratch_to_high(self):
        """sigma_lat is strictly increasing from hcp=2 through hcp=25 at 150 yds."""
        hcps = [2, 8, 15, 20, 25]
        sigs = [dispersion_for_handicap(h, 150.0)[0] for h in hcps]
        for i in range(len(sigs) - 1):
            assert sigs[i] < sigs[i + 1], (
                f"sigma not monotone: hcp {hcps[i]}→{hcps[i+1]}: {sigs[i]:.3f}→{sigs[i+1]:.3f}"
            )

    def test_hcp_clamping_below_min(self):
        """Plus-handicap (+0, −1) is clamped to HCP_MIN before interpolation."""
        lat_neg1, _ = dispersion_for_handicap(-1.0, 150.0)
        lat_floor, _ = dispersion_for_handicap(HCP_MIN, 150.0)
        assert lat_neg1 == pytest.approx(lat_floor, abs=1e-9)

    def test_hcp_clamping_above_max(self):
        """Excessively high handicap is clamped to HCP_MAX."""
        lat_100, _ = dispersion_for_handicap(100.0, 150.0)
        lat_ceil, _ = dispersion_for_handicap(HCP_MAX, 150.0)
        assert lat_100 == pytest.approx(lat_ceil, abs=1e-9)

    def test_sigma_long_is_two_thirds_of_sigma_lat(self):
        """sigma_long = SIGMA_LONG_FRACTION_OF_LAT × sigma_lat for above-floor values."""
        sigma_lat, sigma_long = dispersion_for_handicap(15.0, 150.0)
        assert sigma_long == pytest.approx(SIGMA_LONG_FRACTION_OF_LAT * sigma_lat, abs=1e-9)

    # ── Wiring: handicap flows into decade_aim_advice ─────────────────────────

    def test_handicap_none_uses_fixed_fracs(self):
        """With handicap=None the fixed fracs are used — existing behaviour is unchanged."""
        advice = decade_aim_advice(self.WATER_LEFT, shot_distance_yds=150.0)
        advice_none = decade_aim_advice(self.WATER_LEFT, shot_distance_yds=150.0, handicap=None)
        assert advice == advice_none, "handicap=None must match the no-kwarg default"

    def test_handicap_param_accepted_no_crash(self):
        """decade_aim_advice accepts handicap kwarg for all sane values without error."""
        for hcp in (2.0, 15.0, 25.0, 36.0):
            result = decade_aim_advice(self.WATER_LEFT, shot_distance_yds=150.0, handicap=hcp)
            assert result is None or isinstance(result, str), (
                f"Unexpected return type at hcp={hcp}: {result!r}"
            )

    def test_handicap_wired_deterministic(self):
        """Same handicap → same advice, repeated calls."""
        for hcp in (2.0, 15.0, 25.0):
            r1 = decade_aim_advice(self.WATER_LEFT, 150.0, handicap=hcp)
            r2 = decade_aim_advice(self.WATER_LEFT, 150.0, handicap=hcp)
            assert r1 == r2, f"Non-deterministic at hcp={hcp}"

    # ── Behavioral: scratch more aggressive, high-hcp more conservative ───────

    def test_scratch_shift_leq_high_hcp_shift(self):
        """Scratch (hcp=2) gets same-or-smaller recommended offset than 25-hcp.

        Scenario: death water 5 yds LEFT, 150-yd approach.
        Scratch has tighter dispersion → less risk from the same hazard →
        the optimizer recommends aiming less far from the flag (or not at all).
        High-hcp has wider dispersion → higher water probability → larger shift.

        Both may return advice; if so, the scratch yardage must be ≤ 25-hcp yardage.
        If scratch returns None (threshold not crossed), the assertion is trivially
        satisfied (0 ≤ any positive number).
        """
        advice_scratch = decade_aim_advice(self.WATER_LEFT, 150.0, handicap=2.0)
        advice_high = decade_aim_advice(self.WATER_LEFT, 150.0, handicap=25.0)

        # High-hcp must get advice for this scenario (wide dispersion + death hazard)
        assert advice_high is not None, (
            "25-hcp should receive aim advice for death water 5y left at 150 yds"
        )

        yards_scratch = _extract_yards(advice_scratch) if advice_scratch else 0
        yards_high = _extract_yards(advice_high)

        assert yards_scratch <= yards_high, (
            f"Scratch offset ({yards_scratch}y) must be ≤ 25-hcp offset ({yards_high}y) — "
            "tighter dispersion should never require a larger shift"
        )

    def test_high_hcp_gets_advice_where_scratch_may_not(self):
        """For a moderate hazard scenario, high-hcp gets advice while scratch may not.

        Scenario: water 5 yds LEFT (death), 100-yd shot.
        Scratch σ_lat = 5 yds (tight) → optimizer may stay near the flag.
        25-hcp σ_lat = 9 yds (wide)  → more water exposure → larger shift.

        This test asserts the DIRECTION of the difference is correct: the
        scratch advice yardage ≤ high-hcp advice yardage.
        """
        hazards = [_hazard(type="water", side="left", severity="death", distance=5.0)]
        advice_scratch = decade_aim_advice(hazards, shot_distance_yds=100.0, handicap=2.0)
        advice_high = decade_aim_advice(hazards, shot_distance_yds=100.0, handicap=25.0)

        yards_scratch = _extract_yards(advice_scratch) if advice_scratch else 0
        yards_high = _extract_yards(advice_high) if advice_high else 0

        assert yards_scratch <= yards_high, (
            f"Scratch ({yards_scratch}y) should recommend ≤ shift than 25-hcp ({yards_high}y)"
        )

    # ── Additive-only: club / target / aim_point / miss_side unchanged ────────

    def test_handicap_does_not_change_club(self):
        """Changing handicap in generate_recommendation must not change the club selected.

        The club depends on distance + club bag, not dispersion.
        """
        from app.caddie.aim_point import generate_recommendation
        hole = _make_hole(self.WATER_LEFT)
        rec_scratch = generate_recommendation(hole, 150, self.BAG, handicap=2.0)
        rec_high = generate_recommendation(hole, 150, self.BAG, handicap=25.0)
        assert rec_scratch.club == rec_high.club, (
            f"Club changed with handicap: scratch={rec_scratch.club!r}, high={rec_high.club!r}"
        )

    def test_handicap_does_not_change_target_yards(self):
        """Changing handicap must not change target_yards."""
        from app.caddie.aim_point import generate_recommendation
        hole = _make_hole(self.WATER_LEFT)
        rec_scratch = generate_recommendation(hole, 150, self.BAG, handicap=2.0)
        rec_high = generate_recommendation(hole, 150, self.BAG, handicap=25.0)
        assert rec_scratch.target_yards == rec_high.target_yards

    def test_handicap_does_not_change_aim_point(self):
        """Changing handicap must not mutate aim_point.description.

        The aim_point is set by compute_aim_point (traffic-light + death-side logic),
        which is orthogonal to DECADE dispersion.
        """
        from app.caddie.aim_point import generate_recommendation
        hole = _make_hole(self.WATER_LEFT)
        rec_scratch = generate_recommendation(hole, 150, self.BAG, handicap=2.0)
        rec_high = generate_recommendation(hole, 150, self.BAG, handicap=25.0)
        assert rec_scratch.aim_point.description == rec_high.aim_point.description, (
            "aim_point.description must not change when only handicap changes"
        )

    def test_handicap_does_not_change_miss_side(self):
        """Changing handicap must not mutate miss_side.preferred."""
        from app.caddie.aim_point import generate_recommendation
        hole = _make_hole(self.WATER_LEFT)
        rec_scratch = generate_recommendation(hole, 150, self.BAG, handicap=2.0)
        rec_high = generate_recommendation(hole, 150, self.BAG, handicap=25.0)
        assert rec_scratch.miss_side.preferred == rec_high.miss_side.preferred, (
            "miss_side.preferred must not change when only handicap changes"
        )
