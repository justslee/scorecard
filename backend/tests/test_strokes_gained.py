"""Unit tests for caddie/strokes_gained.py — pure, no DB/network."""

import pytest
from app.caddie.strokes_gained import (
    _interpolate,
    _handicap_multiplier,
    personal_lookup,
    expected_strokes,
    strokes_gained,
    _FAIRWAY_TABLE,
    _GREEN_TABLE,
)


# ── _interpolate ───────────────────────────────────────────────────────────────

class TestInterpolate:
    """Linear interpolation from a sorted-descending (distance, strokes) table."""

    def test_exact_table_hit(self):
        # Distance 150 is an exact key in FAIRWAY_TABLE → (150, 2.92)
        result = _interpolate(_FAIRWAY_TABLE, 150)
        assert result == pytest.approx(2.92, abs=1e-6)

    def test_exact_top_entry(self):
        # Distance >= max (260 in FAIRWAY_TABLE) → clamped to first entry (3.60)
        assert _interpolate(_FAIRWAY_TABLE, 260) == pytest.approx(3.60, abs=1e-6)

    def test_above_max_clamped(self):
        # Beyond the highest distance → still returns the highest row
        assert _interpolate(_FAIRWAY_TABLE, 999) == pytest.approx(3.60, abs=1e-6)

    def test_below_min_clamped(self):
        # Below the smallest distance (30) → last row = 2.47
        assert _interpolate(_FAIRWAY_TABLE, 5) == pytest.approx(2.47, abs=1e-6)

    def test_exact_bottom_entry(self):
        assert _interpolate(_FAIRWAY_TABLE, 30) == pytest.approx(2.47, abs=1e-6)

    def test_midpoint_interpolation(self):
        # Between 120 (2.78) and 110 (2.74): midpoint 115 → 2.76
        result = _interpolate(_FAIRWAY_TABLE, 115)
        assert result == pytest.approx(2.76, abs=1e-6)

    def test_interpolation_quarter(self):
        # Between 120 (2.78) and 110 (2.74): 25% of the way from 110 → 112.5
        # t=(112.5-110)/(120-110)=0.25; value=2.74+0.25*(2.78-2.74)=2.75
        result = _interpolate(_FAIRWAY_TABLE, 112.5)
        assert result == pytest.approx(2.75, abs=1e-6)

    def test_monotone_decreasing(self):
        # Expected strokes should decrease as distance decreases (within table range)
        distances = [30, 60, 90, 120, 150, 180, 210, 240]
        values = [_interpolate(_FAIRWAY_TABLE, d) for d in distances]
        for i in range(len(values) - 1):
            assert values[i] < values[i + 1], (
                f"Monotonicity violated at {distances[i]}y vs {distances[i+1]}y"
            )

    def test_empty_table_fallback(self):
        assert _interpolate([], 100) == pytest.approx(3.0)

    def test_green_table_1ft(self):
        # 1-foot putt → 1.02 in the green table
        assert _interpolate(_GREEN_TABLE, 1) == pytest.approx(1.02, abs=1e-6)

    def test_green_table_above_max(self):
        # 100ft → clamped to max (90ft, 2.60)
        assert _interpolate(_GREEN_TABLE, 100) == pytest.approx(2.60, abs=1e-6)


# ── _handicap_multiplier ──────────────────────────────────────────────────────

class TestHandicapMultiplier:
    """Handicap scaling returns 1.0 at scratch, ~1.7 at 36, monotone in between."""

    def test_scratch(self):
        assert _handicap_multiplier(0) == pytest.approx(1.00, abs=1e-6)

    def test_max_handicap(self):
        assert _handicap_multiplier(36) == pytest.approx(1.70, abs=1e-6)

    def test_midpoint_15(self):
        # Exact key in the table → 1.22
        assert _handicap_multiplier(15) == pytest.approx(1.22, abs=1e-6)

    def test_interpolated_value(self):
        # Between 10 (1.14) and 15 (1.22): at 12.5 → t=0.5 → 1.18
        result = _handicap_multiplier(12.5)
        assert result == pytest.approx(1.18, abs=1e-6)

    def test_none_defaults_to_15(self):
        # None → default 15 → same as _handicap_multiplier(15)
        assert _handicap_multiplier(None) == pytest.approx(_handicap_multiplier(15))

    def test_below_zero_clamped(self):
        # Negative handicap → clamped to 0 → same as scratch
        assert _handicap_multiplier(-5) == pytest.approx(1.00, abs=1e-6)

    def test_above_36_clamped(self):
        # Handicap 54 → clamped to 36 → max multiplier
        assert _handicap_multiplier(54) == pytest.approx(1.70, abs=1e-6)

    def test_monotone_increasing(self):
        hcps = [0, 5, 10, 15, 20, 25, 30, 36]
        values = [_handicap_multiplier(h) for h in hcps]
        for i in range(len(values) - 1):
            assert values[i] < values[i + 1]


# ── personal_lookup ───────────────────────────────────────────────────────────

class TestPersonalLookup:
    """Interpolation from player-logged shot data; falls back gracefully."""

    def _make_sg(self, lie: str, buckets: dict) -> dict:
        """Build a personal_sg dict with explicit bucket data."""
        return {lie: {str(k): {"mean_strokes": v, "samples": 10} for k, v in buckets.items()}}

    def test_none_personal_sg(self):
        assert personal_lookup(150, "fairway", None) is None

    def test_empty_personal_sg(self):
        assert personal_lookup(150, "fairway", {}) is None

    def test_missing_lie(self):
        sg = {"rough": {"100": {"mean_strokes": 2.9, "samples": 5}}}
        assert personal_lookup(150, "fairway", sg) is None

    def test_empty_lie_dict(self):
        sg = {"fairway": {}}
        assert personal_lookup(150, "fairway", sg) is None

    def test_exact_lower_bound_clamped(self):
        sg = self._make_sg("fairway", {100: 2.80, 150: 3.00})
        # target 80 → below lowest populated bucket 100 → returns 2.80
        result = personal_lookup(80, "fairway", sg)
        assert result == pytest.approx(2.80, abs=1e-6)

    def test_exact_upper_bound_clamped(self):
        sg = self._make_sg("fairway", {100: 2.80, 150: 3.00})
        # target 200 → above highest populated 150 → returns 3.00
        result = personal_lookup(200, "fairway", sg)
        assert result == pytest.approx(3.00, abs=1e-6)

    def test_interpolation_midpoint(self):
        sg = self._make_sg("fairway", {100: 2.80, 150: 3.10})
        # midpoint 125 → t=0.5 → 2.95
        result = personal_lookup(125, "fairway", sg)
        assert result == pytest.approx(2.95, abs=1e-6)

    def test_bucket_missing_mean_strokes_skipped(self):
        sg = {"fairway": {
            "100": {"mean_strokes": None, "samples": 0},
            "150": {"mean_strokes": 3.00, "samples": 5},
        }}
        # Only one populated bucket (150); target 80 → clamped to 3.00
        result = personal_lookup(80, "fairway", sg)
        assert result == pytest.approx(3.00, abs=1e-6)


# ── expected_strokes ──────────────────────────────────────────────────────────

class TestExpectedStrokes:
    """Orchestrates table lookup + handicap scaling; personal_sg overrides baseline."""

    def test_scratch_at_150_fairway(self):
        # Exact key 150 in FAIRWAY_TABLE (2.92), multiplier at 0 = 1.00
        result = expected_strokes(150, "fairway", handicap=0)
        assert result == pytest.approx(2.92, abs=1e-6)

    def test_handicap_scales_up(self):
        base = expected_strokes(150, "fairway", handicap=0)
        high = expected_strokes(150, "fairway", handicap=20)
        assert high > base

    def test_unknown_lie_falls_back_to_fairway(self):
        result_unknown = expected_strokes(150, "swamp", handicap=10)
        result_fairway = expected_strokes(150, "fairway", handicap=10)
        assert result_unknown == pytest.approx(result_fairway, abs=1e-6)

    def test_personal_sg_overrides_baseline(self):
        personal_sg = {"fairway": {"150": {"mean_strokes": 2.50, "samples": 20}}}
        result = expected_strokes(150, "fairway", handicap=15, personal_sg=personal_sg)
        # Should be the personal value (2.50), not the baseline*multiplier
        assert result == pytest.approx(2.50, abs=1e-6)

    def test_tee_lie_uses_tee_table(self):
        # 400 yards tee: from _TEE_TABLE nearest match 400 → 4.00, multiplier 1.0
        result = expected_strokes(400, "tee", handicap=0)
        assert result == pytest.approx(4.00, abs=1e-6)

    def test_green_lie_short_putt(self):
        # 1ft putt → 1.02 * 1.00 (scratch)
        result = expected_strokes(1, "green", handicap=0)
        assert result == pytest.approx(1.02, abs=1e-6)

    def test_none_handicap_defaults_to_15(self):
        result_none = expected_strokes(150, "fairway", handicap=None)
        result_15 = expected_strokes(150, "fairway", handicap=15)
        assert result_none == pytest.approx(result_15, abs=1e-6)


# ── strokes_gained ────────────────────────────────────────────────────────────

class TestStrokesGained:
    """SG = E(before) - E(after) - 1; positive means better than expected."""

    def test_holed_shot_from_fairway(self):
        # One shot, end at hole (distance=0, lie='hole')
        # SG = expected_strokes(150, fairway, 0) - 0.0 - 1
        expected = expected_strokes(150, "fairway", handicap=0) - 0.0 - 1
        result = strokes_gained(1, 150, "fairway", 0, "hole", handicap=0)
        assert result == pytest.approx(expected, abs=1e-6)

    def test_average_shot_zero_sg(self):
        # If you take exactly E(before)-E(after) shots you gain 0
        # Approximate: one shot from 150 to 10 yards, scratch
        before = expected_strokes(150, "fairway", handicap=0)
        after = expected_strokes(10, "green", handicap=0)
        expected_sg = before - after - 1
        result = strokes_gained(1, 150, "fairway", 10, "green", handicap=0)
        assert result == pytest.approx(expected_sg, abs=1e-6)

    def test_positive_sg_great_shot(self):
        # A scratch golfer holes a 150-yard shot in one → large positive SG
        result = strokes_gained(1, 150, "fairway", 0, "hole", handicap=0)
        assert result > 1.0

    def test_negative_sg_poor_shot(self):
        # Three-putts from 10 feet → SG should be negative
        result = strokes_gained(3, 10, "green", 0, "hole", handicap=0)
        assert result < 0

    def test_handicap_affects_expectation(self):
        # Higher handicap → higher expected strokes before → same shot looks better (less negative SG)
        sg_scratch = strokes_gained(2, 150, "fairway", 5, "green", handicap=0)
        sg_high = strokes_gained(2, 150, "fairway", 5, "green", handicap=20)
        # High handicap has bigger E(before) so SG is less negative (or more positive)
        assert sg_high >= sg_scratch
