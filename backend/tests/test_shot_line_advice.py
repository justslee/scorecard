"""Unit tests for caddie/shot_line_advice.py — pure, no DB / no network.

Covers:
- Threshold gating: sub-threshold net change → None
- Elevated-green profile (net uphill + rising finish) → elevated advice
- Downhill landing zone → release / run-out advice
- Mid-line ridge (peak above both endpoints) → ridge advice
- Mid-line swale / valley (dip below both endpoints) → swale advice
- 2-point profile (start + end only) → correct dispatch
- Early-hill / flat-finish profile → no elevated-green advice (shape check)
- Determinism: identical inputs always return identical output
- Wired into generate_recommendation: advice in reasoning; club / aim /
  target_yards / miss_side.preferred are all unchanged by the profile

Mock strategy: pass fixture lists directly to ``shot_line_advice`` — no live
3DEP calls, no DB, no async.  The async ``sample_shot_line`` helper is not
tested here (it wraps ``fetch_3dep_samples`` which requires network; CI covers
it via the integration gate).
"""

from __future__ import annotations

from app.caddie.shot_line_advice import shot_line_advice


# ── helpers ───────────────────────────────────────────────────────────────────


def _p(*elevations: float) -> list[float]:
    """Shorthand for building a profile list."""
    return list(elevations)


# ══════════════════════════════════════════════════════════════════════════════
# Threshold gating
# ══════════════════════════════════════════════════════════════════════════════


class TestThresholdGating:
    """Sub-threshold net changes produce None; at-or-above threshold produce advice."""

    def test_flat_two_point_returns_none(self):
        assert shot_line_advice(_p(100.0, 100.0), 150) is None

    def test_small_uphill_below_threshold_returns_none(self):
        # NET_CHANGE_THRESHOLD_FT − ε
        assert shot_line_advice(_p(100.0, 109.9), 150) is None

    def test_small_downhill_below_threshold_returns_none(self):
        assert shot_line_advice(_p(100.0, 90.1), 150) is None

    def test_exactly_at_uphill_threshold_returns_advice(self):
        # net = 10.0 exactly; 2-pt profile → end_rise == net_change >= 5 ✓
        result = shot_line_advice(_p(100.0, 110.0), 150)
        assert result is not None

    def test_exactly_at_downhill_threshold_returns_advice(self):
        result = shot_line_advice(_p(100.0, 90.0), 150)
        assert result is not None

    def test_single_point_returns_none(self):
        assert shot_line_advice(_p(100.0), 150) is None

    def test_empty_profile_returns_none(self):
        assert shot_line_advice([], 150) is None

    def test_returns_string_or_none(self):
        result = shot_line_advice(_p(100.0, 120.0), 150)
        assert result is None or isinstance(result, str)


# ══════════════════════════════════════════════════════════════════════════════
# Elevated green
# ══════════════════════════════════════════════════════════════════════════════


class TestElevatedGreen:
    """Net uphill + second half still rising → elevated-green advice."""

    def test_two_point_elevated_returns_advice(self):
        # 2-pt: end_rise == net_change = 15 >= NET and >= END thresholds
        result = shot_line_advice(_p(100.0, 115.0), 150)
        assert result is not None
        assert "elevated" in result.lower()

    def test_five_point_steadily_rising(self):
        # 100 → 103 → 106 → 110 → 115; mid_idx=2, end_rise=115-106=9 ≥ 5
        result = shot_line_advice(_p(100.0, 103.0, 106.0, 110.0, 115.0), 150)
        assert result is not None
        assert "elevated" in result.lower()

    def test_elevated_mentions_carry_or_face(self):
        result = shot_line_advice(_p(100.0, 120.0), 150)
        assert result is not None
        assert "carry" in result.lower() or "face" in result.lower()

    def test_elevated_mentions_commit_or_full(self):
        result = shot_line_advice(_p(100.0, 115.0), 200)
        assert result is not None
        assert "commit" in result.lower() or "full" in result.lower()

    def test_early_hill_flat_finish_no_elevated_advice(self):
        # Profile rises early then stays flat: 100 → 112 → 112 → 112 → 112
        # net=12 >= 10, BUT end_rise = 112 − profile[2] = 0 < END_RISE_THRESHOLD_FT
        # No ridge (peak−max(endpoints)=112−112=0<8), no valley, not downhill
        result = shot_line_advice(_p(100.0, 112.0, 112.0, 112.0, 112.0), 150)
        assert result is None, f"Expected None for early-hill flat finish, got: {result!r}"

    def test_uphill_but_falling_finish_no_elevated_advice(self):
        # Rises then falls back, net still positive but end_rise is negative
        # 100 → 120 → 110 → 108 → 105; net=5 < 10 → misses threshold entirely
        result = shot_line_advice(_p(100.0, 120.0, 110.0, 108.0, 105.0), 200)
        # net=5 < NET_CHANGE_THRESHOLD_FT → no elevated/downhill advice
        # ridge check: peak=120, max(start,end)=max(100,105)=105, 120-105=15 >= 8 → RIDGE
        assert result is not None
        assert "rise" in result.lower() or "crest" in result.lower()


# ══════════════════════════════════════════════════════════════════════════════
# Downhill landing zone
# ══════════════════════════════════════════════════════════════════════════════


class TestDownhillLanding:
    """Net downhill clears threshold → release / run-out advice."""

    def test_two_point_downhill_returns_advice(self):
        result = shot_line_advice(_p(100.0, 85.0), 150)
        assert result is not None
        assert "downhill" in result.lower() or "release" in result.lower()

    def test_five_point_steadily_downhill(self):
        result = shot_line_advice(_p(100.0, 97.0, 94.0, 91.0, 88.0), 180)
        assert result is not None
        assert "release" in result.lower() or "run" in result.lower()

    def test_downhill_mentions_land_short(self):
        result = shot_line_advice(_p(120.0, 100.0), 200)
        assert result is not None
        assert "land" in result.lower() or "short" in result.lower()

    def test_downhill_returns_string(self):
        result = shot_line_advice(_p(150.0, 130.0), 150)
        assert isinstance(result, str)


# ══════════════════════════════════════════════════════════════════════════════
# Mid-line ridge
# ══════════════════════════════════════════════════════════════════════════════


class TestMidLineRidge:
    """A mid-line peak clearing both endpoints by ≥ MID_FEATURE_THRESHOLD_FT."""

    def test_symmetric_ridge_returns_advice(self):
        # start=100, peak=115, end=100: peak − max(100,100) = 15 ≥ 8
        result = shot_line_advice(_p(100.0, 115.0, 100.0), 200)
        assert result is not None
        assert "rise" in result.lower() or "crest" in result.lower()

    def test_asymmetric_ridge_higher_end(self):
        # start=100, peak=120, end=108: peak − max(100,108) = 12 ≥ 8
        result = shot_line_advice(_p(100.0, 120.0, 108.0), 200)
        assert result is not None
        assert "rise" in result.lower() or "downslope" in result.lower()

    def test_ridge_mentions_downslope_or_control(self):
        result = shot_line_advice(_p(100.0, 115.0, 100.0), 200)
        assert result is not None
        assert "downslope" in result.lower() or "control" in result.lower() or "crest" in result.lower()

    def test_small_ridge_below_threshold_returns_none(self):
        # peak only 5 ft above max(start,end) < MID_FEATURE_THRESHOLD_FT=8
        # net_change=0, no downhill
        result = shot_line_advice(_p(100.0, 105.0, 100.0), 200)
        assert result is None

    def test_ridge_exactly_at_threshold(self):
        # peak − max(100,100) == 8.0 → just at threshold (>=)
        result = shot_line_advice(_p(100.0, 108.0, 100.0), 200)
        assert result is not None

    def test_peak_only_clears_one_endpoint_no_ridge(self):
        # start=100, peak=110, end=104: peak−max(100,104)=6 < 8 → no ridge
        # net=4 < 10 → no elevated/downhill; no swale
        result = shot_line_advice(_p(100.0, 110.0, 104.0), 200)
        assert result is None


# ══════════════════════════════════════════════════════════════════════════════
# Mid-line valley / swale
# ══════════════════════════════════════════════════════════════════════════════


class TestMidLineValley:
    """A mid-line valley dipping below both endpoints by ≥ MID_FEATURE_THRESHOLD_FT."""

    def test_symmetric_swale_returns_advice(self):
        # start=100, valley=88, end=100: min(100,100)−88 = 12 ≥ 8
        result = shot_line_advice(_p(100.0, 88.0, 100.0), 200)
        assert result is not None
        assert "swale" in result.lower() or "low" in result.lower()

    def test_swale_mentions_carry_or_low_point(self):
        result = shot_line_advice(_p(100.0, 85.0, 100.0), 200)
        assert result is not None
        assert "carry" in result.lower() or "low point" in result.lower()

    def test_asymmetric_swale_lower_start(self):
        # start=95, valley=83, end=100: min(95,100)−83 = 12 ≥ 8
        result = shot_line_advice(_p(95.0, 83.0, 100.0), 200)
        assert result is not None

    def test_small_valley_below_threshold_returns_none(self):
        # valley only 5 ft below min(start,end) < 8
        result = shot_line_advice(_p(100.0, 95.0, 100.0), 200)
        assert result is None

    def test_swale_exactly_at_threshold(self):
        # min(100,100)−92 = 8.0 → at threshold
        result = shot_line_advice(_p(100.0, 92.0, 100.0), 200)
        assert result is not None

    def test_valley_only_below_one_end_no_swale(self):
        # start=100, valley=93, end=97: min(100,97)−93 = 4 < 8 → no swale
        # No ridge, no net-threshold uphill/downhill (net=-3)
        result = shot_line_advice(_p(100.0, 93.0, 97.0), 200)
        assert result is None


# ══════════════════════════════════════════════════════════════════════════════
# Determinism
# ══════════════════════════════════════════════════════════════════════════════


class TestDeterminism:
    """Pure function: identical inputs always return identical output."""

    def test_elevated_is_deterministic(self):
        profile = _p(100.0, 108.0, 115.0)
        r1 = shot_line_advice(profile, 150)
        r2 = shot_line_advice(profile, 150)
        r3 = shot_line_advice(profile, 150)
        assert r1 == r2 == r3

    def test_none_is_deterministic(self):
        profile = _p(100.0, 102.0)  # net=2 < 10
        for _ in range(5):
            assert shot_line_advice(profile, 150) is None

    def test_downhill_is_deterministic(self):
        profile = _p(100.0, 85.0)
        r1 = shot_line_advice(profile, 200)
        r2 = shot_line_advice(profile, 200)
        assert r1 == r2

    def test_ridge_is_deterministic(self):
        profile = _p(100.0, 115.0, 100.0)
        r1 = shot_line_advice(profile, 200)
        r2 = shot_line_advice(profile, 200)
        assert r1 == r2


# ══════════════════════════════════════════════════════════════════════════════
# Priority: mid-line features before net-change features
# ══════════════════════════════════════════════════════════════════════════════


class TestPriorityOrder:
    """Ridge / swale checks fire before elevated / downhill checks."""

    def test_ridge_plus_net_uphill_returns_ridge_advice(self):
        # Net uphill 8 ft (below threshold) + ridge peak: ridge fires
        # 100 → 112 → 103: ridge check: peak=112, max(100,103)=103, 112-103=9 ≥ 8 → ridge
        result = shot_line_advice(_p(100.0, 112.0, 103.0), 150)
        assert result is not None
        assert "rise" in result.lower() or "crest" in result.lower()

    def test_swale_plus_net_uphill_returns_swale_advice(self):
        # 110 → 96 → 120: start=110, valley=96, end=120
        # ridge: peak=120 (endpoint, not in mid_section=[96]) — no ridge
        # swale: valley=96, min(110,120)=110, 110-96=14 ≥ 8 → swale
        result = shot_line_advice(_p(110.0, 96.0, 120.0), 200)
        assert result is not None
        assert "swale" in result.lower() or "low" in result.lower()


# ══════════════════════════════════════════════════════════════════════════════
# Integration: wired into generate_recommendation
# ══════════════════════════════════════════════════════════════════════════════


class TestWiredIntoRecommendation:
    """Advice appears in reasoning; club / aim / target_yards / miss_side unchanged."""

    _BAG = {"7iron": 160, "9iron": 140, "pw": 130}

    def _hole(self, profile: list[float] | None = None):
        from app.caddie.types import HoleIntelligence
        return HoleIntelligence(
            hole_number=1,
            par=4,
            yards=400,
            hazards=[],
            shot_line_profile_ft=profile,
        )

    def test_elevated_profile_appears_in_reasoning(self):
        from app.caddie.aim_point import generate_recommendation
        hole = self._hole(_p(100.0, 108.0, 120.0))
        rec = generate_recommendation(hole, 150, self._BAG, handicap=15.0)
        elevated_lines = [r for r in rec.reasoning if "elevated" in r.lower()]
        assert len(elevated_lines) >= 1, f"No elevated-green advice in reasoning: {rec.reasoning}"

    def test_downhill_profile_appears_in_reasoning(self):
        from app.caddie.aim_point import generate_recommendation
        hole = self._hole(_p(100.0, 92.0, 85.0))
        rec = generate_recommendation(hole, 150, self._BAG, handicap=15.0)
        downhill_lines = [
            r for r in rec.reasoning
            if "downhill" in r.lower() or "release" in r.lower()
        ]
        assert len(downhill_lines) >= 1, f"No downhill advice in reasoning: {rec.reasoning}"

    def test_flat_profile_adds_nothing_to_reasoning(self):
        from app.caddie.aim_point import generate_recommendation
        hole_no = self._hole(None)
        hole_flat = self._hole(_p(100.0, 101.0, 100.5))  # net < 2 ft — flat
        rec_no = generate_recommendation(hole_no, 150, self._BAG, handicap=15.0)
        rec_flat = generate_recommendation(hole_flat, 150, self._BAG, handicap=15.0)
        assert rec_no.reasoning == rec_flat.reasoning

    def test_shot_line_advice_does_not_change_club(self):
        from app.caddie.aim_point import generate_recommendation
        hole_no = self._hole(None)
        hole_elevated = self._hole(_p(100.0, 110.0, 125.0))
        rec_no = generate_recommendation(hole_no, 150, self._BAG, handicap=15.0)
        rec_yes = generate_recommendation(hole_elevated, 150, self._BAG, handicap=15.0)
        assert rec_no.club == rec_yes.club

    def test_shot_line_advice_does_not_change_target_yards(self):
        from app.caddie.aim_point import generate_recommendation
        hole_no = self._hole(None)
        hole_elevated = self._hole(_p(100.0, 110.0, 125.0))
        rec_no = generate_recommendation(hole_no, 150, self._BAG, handicap=15.0)
        rec_yes = generate_recommendation(hole_elevated, 150, self._BAG, handicap=15.0)
        assert rec_no.target_yards == rec_yes.target_yards

    def test_shot_line_advice_does_not_change_aim_point(self):
        from app.caddie.aim_point import generate_recommendation
        hole_no = self._hole(None)
        hole_elevated = self._hole(_p(100.0, 110.0, 125.0))
        rec_no = generate_recommendation(hole_no, 150, self._BAG, handicap=15.0)
        rec_yes = generate_recommendation(hole_elevated, 150, self._BAG, handicap=15.0)
        assert rec_no.aim_point.description == rec_yes.aim_point.description

    def test_shot_line_advice_does_not_change_miss_side(self):
        from app.caddie.aim_point import generate_recommendation
        hole_no = self._hole(None)
        hole_elevated = self._hole(_p(100.0, 110.0, 125.0))
        rec_no = generate_recommendation(hole_no, 150, self._BAG, handicap=15.0)
        rec_yes = generate_recommendation(hole_elevated, 150, self._BAG, handicap=15.0)
        assert rec_no.miss_side.preferred == rec_yes.miss_side.preferred

    def test_none_profile_adds_nothing(self):
        from app.caddie.aim_point import generate_recommendation
        # Verify no crash and no extra reasoning when profile is None
        hole = self._hole(None)
        rec = generate_recommendation(hole, 150, self._BAG, handicap=15.0)
        assert isinstance(rec.reasoning, list)
