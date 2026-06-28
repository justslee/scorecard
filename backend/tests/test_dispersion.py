"""Unit tests for caddie/dispersion.py — pure, no DB/network."""

import pytest
from app.caddie.dispersion import (
    _interpolate_handicap,
    get_dispersion,
    dispersion_covers_hazard,
    _DISPERSION_BY_CLUB_AND_HANDICAP,
)


# ── _interpolate_handicap ─────────────────────────────────────────────────────

class TestInterpolateHandicap:
    """Linear interpolation between handicap breakpoints in a dispersion table."""

    def _driver_table(self):
        return _DISPERSION_BY_CLUB_AND_HANDICAP["driver"]

    def test_exact_breakpoint(self):
        # handicap=10 is an exact key → driver table 10: (65, 40, 45)
        result = _interpolate_handicap(self._driver_table(), 10)
        assert result == pytest.approx((65.0, 40.0, 45.0), abs=1e-6)

    def test_below_min_clamped(self):
        # handicap=-5 → clamped to 0 → driver table 0: (42, 30, 40)
        result = _interpolate_handicap(self._driver_table(), -5)
        assert result == pytest.approx((42.0, 30.0, 40.0), abs=1e-6)

    def test_above_max_clamped(self):
        # handicap=40 → clamped to 30 → driver table 30: (110, 70, 58)
        result = _interpolate_handicap(self._driver_table(), 40)
        assert result == pytest.approx((110.0, 70.0, 58.0), abs=1e-6)

    def test_midpoint_interpolation(self):
        # Between 0 (42,30,40) and 5 (52,35,42): at 2.5 → t=0.5
        # (42+5, 30+2.5, 40+1) = (47, 32.5, 41)
        result = _interpolate_handicap(self._driver_table(), 2.5)
        assert result == pytest.approx((47.0, 32.5, 41.0), abs=1e-6)

    def test_monotone_increasing_width(self):
        # Higher handicap → wider dispersion
        hcps = [0, 5, 10, 15, 20, 25, 30]
        widths = [_interpolate_handicap(self._driver_table(), h)[0] for h in hcps]
        for i in range(len(widths) - 1):
            assert widths[i] < widths[i + 1]


# ── get_dispersion ────────────────────────────────────────────────────────────

class TestGetDispersion:
    """Returns a dict with width, depth, short_bias_pct, center_bias."""

    def test_return_shape(self):
        result = get_dispersion("7iron", handicap=15)
        assert set(result.keys()) >= {"width_yards", "depth_yards", "short_bias_pct", "center_bias"}

    def test_scratch_driver(self):
        result = get_dispersion("driver", handicap=0)
        assert result["width_yards"] == pytest.approx(42.0, abs=0.1)
        assert result["depth_yards"] == pytest.approx(30.0, abs=0.1)
        assert result["short_bias_pct"] == pytest.approx(40.0, abs=0.1)

    def test_handicap_15_driver(self):
        result = get_dispersion("driver", handicap=15)
        assert result["width_yards"] == pytest.approx(75.0, abs=0.1)

    def test_unknown_club_falls_back_to_mid_iron(self):
        result_unknown = get_dispersion("magic_wand", handicap=15)
        result_mid = get_dispersion("7iron", handicap=15)
        assert result_unknown["width_yards"] == result_mid["width_yards"]
        assert result_unknown["depth_yards"] == result_mid["depth_yards"]

    def test_none_handicap_defaults_to_15(self):
        result_none = get_dispersion("7iron", handicap=None)
        result_15 = get_dispersion("7iron", handicap=15)
        assert result_none["width_yards"] == result_15["width_yards"]

    def test_wedge_tighter_than_driver(self):
        driver = get_dispersion("driver", handicap=15)
        wedge = get_dispersion("sw", handicap=15)
        assert wedge["width_yards"] < driver["width_yards"]

    def test_camelcase_club_key(self):
        # Both "7iron" and "sevenIron" map to mid_iron
        result_short = get_dispersion("7iron", handicap=10)
        result_camel = get_dispersion("sevenIron", handicap=10)
        assert result_short["width_yards"] == result_camel["width_yards"]

    def test_center_bias_is_none(self):
        # Without player data, center_bias is always "none"
        result = get_dispersion("driver", handicap=10)
        assert result["center_bias"] == "none"

    def test_rounded_values(self):
        # round(..., 1) applied — no 4-decimal float noise
        result = get_dispersion("driver", handicap=7)
        for key in ("width_yards", "depth_yards", "short_bias_pct"):
            val = result[key]
            assert val == round(val, 1), f"{key} not rounded to 1dp"


# ── dispersion_covers_hazard ──────────────────────────────────────────────────

class TestDispersionCoversHazard:
    """Returns True if hazard falls within the left-right dispersion half-width."""

    def _dispersion(self, width: float) -> dict:
        return {"width_yards": width, "depth_yards": 20.0, "short_bias_pct": 55.0, "center_bias": "none"}

    def test_hazard_inside_width(self):
        # width=40 → half=20; aim=0, hazard=15 → distance=15 < 20 → True
        assert dispersion_covers_hazard(self._dispersion(40), 0, 15) is True

    def test_hazard_outside_width(self):
        # width=40 → half=20; aim=0, hazard=25 → distance=25 >= 20 → False
        assert dispersion_covers_hazard(self._dispersion(40), 0, 25) is False

    def test_hazard_exactly_at_half_width_not_covered(self):
        # Strict less-than: distance == half_width → False
        assert dispersion_covers_hazard(self._dispersion(40), 0, 20) is False

    def test_aim_offset_shifts_window(self):
        # Aim right (+5), hazard at +22; relative distance = 17 < 20 → True
        assert dispersion_covers_hazard(self._dispersion(40), 5, 22) is True

    def test_aim_offset_shifts_window_miss(self):
        # Aim right (+5), hazard at -20; relative distance = 25 >= 20 → False
        assert dispersion_covers_hazard(self._dispersion(40), 5, -20) is False

    def test_left_hazard_covered(self):
        # Hazard at -10 (left); aim=0; distance=10 < 20 → True
        assert dispersion_covers_hazard(self._dispersion(40), 0, -10) is True

    def test_real_dispersion_driver_hcp15(self):
        disp = get_dispersion("driver", handicap=15)
        # driver hcp15: width=75, half=37.5; hazard at 30 from center → covered
        assert dispersion_covers_hazard(disp, 0, 30) is True

    def test_real_dispersion_wedge_hcp15(self):
        disp = get_dispersion("sw", handicap=15)
        # wedge hcp15: width=30, half=15; hazard at 20 from center → NOT covered
        assert dispersion_covers_hazard(disp, 0, 20) is False
