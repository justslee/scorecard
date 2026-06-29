"""Unit tests for caddie/dispersion.py and dispersion_for_handicap — pure, no DB/network."""

import pytest
from app.caddie.dispersion import (
    _interpolate_handicap,
    get_dispersion,
    dispersion_covers_hazard,
    _DISPERSION_BY_CLUB_AND_HANDICAP,
)
from app.caddie.decade_advice import (
    dispersion_for_handicap,
    HCP_MIN,
    HCP_MAX,
    MIN_SIGMA_YDS,
    SIGMA_LONG_FRACTION_OF_LAT,
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


# ── TestDispersionForHandicap ─────────────────────────────────────────────────


class TestDispersionForHandicap:
    """dispersion_for_handicap(handicap, distance_yds) → (sigma_lat, sigma_long).

    Pure function from decade_advice; no DB/network required.

    Model reference (piecewise-linear, DECADE / Broadie-calibrated):
        hcp  2 → sigma_lat = 5.0 % of distance
        hcp 15 → sigma_lat = 6.5 %
        hcp 25 → sigma_lat = 9.0 %
        hcp 36 → sigma_lat = 11.8 %
        sigma_long = 2/3 × sigma_lat (Broadie: long/short spread is tighter)
        Both floored at MIN_SIGMA_YDS.
    """

    # ── Return values at calibration breakpoints ───────────────────────────────

    def test_scratch_at_150yds(self):
        """hcp=2 at 150 yds: sigma_lat = 5 % × 150 = 7.5, sigma_long = 2/3 × 7.5 = 5.0."""
        sigma_lat, sigma_long = dispersion_for_handicap(2.0, 150.0)
        assert sigma_lat == pytest.approx(7.5, abs=1e-6)
        assert sigma_long == pytest.approx(5.0, abs=1e-6)

    def test_mid_hcp_at_150yds(self):
        """hcp=15 at 150 yds: sigma_lat = 6.5 % × 150 = 9.75."""
        sigma_lat, sigma_long = dispersion_for_handicap(15.0, 150.0)
        assert sigma_lat == pytest.approx(9.75, abs=1e-6)
        assert sigma_long == pytest.approx(9.75 * SIGMA_LONG_FRACTION_OF_LAT, abs=1e-6)

    def test_high_hcp_at_150yds(self):
        """hcp=25 at 150 yds: sigma_lat = 9 % × 150 = 13.5."""
        sigma_lat, sigma_long = dispersion_for_handicap(25.0, 150.0)
        assert sigma_lat == pytest.approx(13.5, abs=1e-6)
        assert sigma_long == pytest.approx(9.0, abs=1e-6)

    # ── Monotonicity: lower handicap → tighter dispersion ────────────────────

    def test_sigma_lat_monotone_ascending_with_handicap(self):
        """Higher handicap → wider lateral dispersion at any fixed distance."""
        distance = 150.0
        hcps = [2, 10, 15, 20, 25, 30]
        sigmas = [dispersion_for_handicap(h, distance)[0] for h in hcps]
        for i in range(len(sigmas) - 1):
            assert sigmas[i] < sigmas[i + 1], (
                f"sigma_lat not strictly increasing: hcp {hcps[i]}→{hcps[i+1]}: "
                f"{sigmas[i]:.3f}→{sigmas[i+1]:.3f}"
            )

    def test_scratch_tighter_than_mid_tighter_than_high(self):
        """sigma_lat(scratch=2) < sigma_lat(mid=15) < sigma_lat(high=25)."""
        d = 150.0
        lat_scratch, _ = dispersion_for_handicap(2.0, d)
        lat_mid, _ = dispersion_for_handicap(15.0, d)
        lat_high, _ = dispersion_for_handicap(25.0, d)
        assert lat_scratch < lat_mid < lat_high

    def test_sigma_long_monotone_with_handicap(self):
        """sigma_long also increases with handicap (derived from sigma_lat)."""
        distance = 200.0
        hcps = [2, 15, 25]
        longs = [dispersion_for_handicap(h, distance)[1] for h in hcps]
        for i in range(len(longs) - 1):
            assert longs[i] < longs[i + 1]

    # ── Scales with distance ──────────────────────────────────────────────────

    def test_scales_with_distance_scratch(self):
        """sigma_lat doubles when distance doubles (above the MIN_SIGMA_YDS floor)."""
        lat_100, _ = dispersion_for_handicap(2.0, 100.0)
        lat_200, _ = dispersion_for_handicap(2.0, 200.0)
        # Both above floor (0.05 × 100 = 5 > 3): ratio should be exactly 2.
        assert lat_200 == pytest.approx(2.0 * lat_100, abs=1e-6)

    def test_scales_with_distance_high_hcp(self):
        """Same scaling behaviour for a high handicapper."""
        lat_100, _ = dispersion_for_handicap(25.0, 100.0)
        lat_200, _ = dispersion_for_handicap(25.0, 200.0)
        assert lat_200 == pytest.approx(2.0 * lat_100, abs=1e-6)

    def test_sigma_long_is_two_thirds_of_sigma_lat(self):
        """sigma_long = (2/3) × sigma_lat when above the MIN_SIGMA_YDS floor."""
        for hcp in (2.0, 15.0, 25.0):
            sigma_lat, sigma_long = dispersion_for_handicap(hcp, 150.0)
            expected_long = SIGMA_LONG_FRACTION_OF_LAT * sigma_lat
            assert sigma_long == pytest.approx(max(expected_long, MIN_SIGMA_YDS), abs=1e-6)

    # ── Handicap clamping ─────────────────────────────────────────────────────

    def test_below_hcp_min_clamped(self):
        """Handicap < HCP_MIN (plus-handicap player) is clamped to HCP_MIN."""
        lat_minus2, _ = dispersion_for_handicap(-2.0, 150.0)
        lat_min, _ = dispersion_for_handicap(HCP_MIN, 150.0)
        assert lat_minus2 == pytest.approx(lat_min, abs=1e-9)

    def test_above_hcp_max_clamped(self):
        """Handicap > HCP_MAX (very high beginner) is clamped to HCP_MAX."""
        lat_50, _ = dispersion_for_handicap(50.0, 150.0)
        lat_max, _ = dispersion_for_handicap(HCP_MAX, 150.0)
        assert lat_50 == pytest.approx(lat_max, abs=1e-9)

    def test_clamp_at_exact_boundaries(self):
        """Exact HCP_MIN and HCP_MAX values are not clamped (they're within range)."""
        lat_min, _ = dispersion_for_handicap(HCP_MIN, 150.0)
        lat_max, _ = dispersion_for_handicap(HCP_MAX, 150.0)
        # Min should be tighter than max
        assert lat_min < lat_max

    # ── MIN_SIGMA_YDS floor ───────────────────────────────────────────────────

    def test_very_short_shot_floored_at_min_sigma(self):
        """Very short shots: fraction × distance < MIN_SIGMA_YDS → clamped to floor."""
        # hcp=2: 5 % × 1 yd = 0.05, well below MIN_SIGMA_YDS=3
        sigma_lat, sigma_long = dispersion_for_handicap(2.0, 1.0)
        assert sigma_lat == pytest.approx(MIN_SIGMA_YDS, abs=1e-9)
        assert sigma_long == pytest.approx(MIN_SIGMA_YDS, abs=1e-9)

    def test_floor_does_not_apply_at_normal_distances(self):
        """At 150 yds even scratch exceeds the floor: 7.5 > MIN_SIGMA_YDS=3."""
        sigma_lat, _ = dispersion_for_handicap(2.0, 150.0)
        assert sigma_lat > MIN_SIGMA_YDS

    # ── Determinism ───────────────────────────────────────────────────────────

    def test_deterministic(self):
        """Same inputs always produce the same outputs."""
        for hcp, dist in [(2.0, 150.0), (15.0, 100.0), (25.0, 200.0)]:
            r1 = dispersion_for_handicap(hcp, dist)
            r2 = dispersion_for_handicap(hcp, dist)
            assert r1 == r2, f"Non-deterministic at hcp={hcp}, dist={dist}"

    # ── Return type ───────────────────────────────────────────────────────────

    def test_returns_tuple_of_two_floats(self):
        result = dispersion_for_handicap(15.0, 150.0)
        assert isinstance(result, tuple)
        assert len(result) == 2
        assert all(isinstance(v, float) for v in result)

    def test_both_values_positive(self):
        """Both sigma values must always be positive (≥ MIN_SIGMA_YDS)."""
        for hcp in (2.0, 15.0, 25.0):
            for dist in (5.0, 50.0, 150.0, 300.0):
                sigma_lat, sigma_long = dispersion_for_handicap(hcp, dist)
                assert sigma_lat > 0, f"sigma_lat <= 0 at hcp={hcp}, dist={dist}"
                assert sigma_long > 0, f"sigma_long <= 0 at hcp={hcp}, dist={dist}"
