"""Unit tests for caddie/decade.py — pure, deterministic, no DB/network.

Each test class documents WHAT BEHAVIOUR it proves and WHY the assertion holds.
"""

from __future__ import annotations

import math

import pytest

from app.caddie.decade import (
    LandingArea,
    Dispersion,
    _FAIRWAY_STROKES,
    _SAND_ROUGH_PENALTY,
    _RECOVERY_ROUGH_PENALTY,
    _PENALTY_STROKE,
    _N_GRID,
    _gauss_weights_1d,
    _grid_samples,
    _interp,
    expected_strokes_from,
    expected_strokes_for_aim,
    optimize_aim,
)


# ── Shared fixtures / helpers ─────────────────────────────────────────────────

PIN_ORIGIN: tuple[float, float] = (0.0, 0.0)


def _classify_all_fairway(x: float, y: float) -> LandingArea:
    """Trivial baseline: the whole landing zone is fairway (no hazards)."""
    return LandingArea.FAIRWAY


def _classify_water_left(x: float, y: float) -> LandingArea:
    """Water hazard to the left of x = -10 yards; fairway everywhere else."""
    if x < -10.0:
        return LandingArea.WATER
    return LandingArea.FAIRWAY


def _classify_bunker_left_of_pin(x: float, y: float) -> LandingArea:
    """Greenside bunker for x < -8 (tight left of a pin at −5, 0); green otherwise."""
    if x < -8.0:
        return LandingArea.SAND
    return LandingArea.GREEN


# ── _gauss_weights_1d ─────────────────────────────────────────────────────────


class TestGaussWeights1d:
    """Validates the deterministic 1-D Gaussian quadrature grid."""

    def test_weights_sum_to_one(self):
        weights = _gauss_weights_1d(sigma=10.0)
        total = sum(w for _, w in weights)
        assert total == pytest.approx(1.0, abs=1e-9)

    def test_node_count(self):
        # Should return exactly _N_GRID nodes.
        weights = _gauss_weights_1d(sigma=10.0)
        assert len(weights) == _N_GRID

    def test_symmetric_about_zero(self):
        # Gaussian is even-symmetric: w(-x) == w(+x).
        weights = _gauss_weights_1d(sigma=10.0)
        offsets = [off for off, _ in weights]
        ws = [w for _, w in weights]
        n = len(offsets)
        for i in range(n // 2):
            assert offsets[i] == pytest.approx(-offsets[n - 1 - i], abs=1e-10)
            assert ws[i] == pytest.approx(ws[n - 1 - i], abs=1e-12)

    def test_centre_node_has_highest_weight(self):
        # The node at offset=0 should have the highest weight (peak of Gaussian).
        weights = _gauss_weights_1d(sigma=10.0)
        centre_w = max(w for _, w in weights)
        centre_idx = _N_GRID // 2
        _, w_centre = weights[centre_idx]
        assert w_centre == pytest.approx(centre_w, abs=1e-12)

    def test_zero_sigma_collapses_to_point_mass(self):
        # Zero dispersion → all probability at offset 0.
        weights = _gauss_weights_1d(sigma=0.0)
        assert weights == [(0.0, 1.0)]

    def test_negative_sigma_collapses_to_point_mass(self):
        weights = _gauss_weights_1d(sigma=-5.0)
        assert weights == [(0.0, 1.0)]


# ── _grid_samples ──────────────────────────────────────────────────────────────


class TestGridSamples:
    """The 2-D product grid has correct shape and probability sum."""

    def test_sample_count(self):
        aim = (0.0, 0.0)
        disp = Dispersion(sigma_long=10.0, sigma_lat=8.0)
        samples = _grid_samples(aim, disp)
        assert len(samples) == _N_GRID * _N_GRID

    def test_probabilities_sum_to_one(self):
        aim = (5.0, -3.0)
        disp = Dispersion(sigma_long=12.0, sigma_lat=10.0)
        samples = _grid_samples(aim, disp)
        total = sum(p for _, p in samples)
        assert total == pytest.approx(1.0, abs=1e-9)

    def test_landing_points_centred_on_aim(self):
        # The probability-weighted mean landing point equals the aim point.
        aim = (7.0, -4.0)
        disp = Dispersion(sigma_long=8.0, sigma_lat=6.0)
        samples = _grid_samples(aim, disp)
        mean_x = sum(lx * p for (lx, _), p in samples)
        mean_y = sum(ly * p for (_, ly), p in samples)
        assert mean_x == pytest.approx(aim[0], abs=1e-8)
        assert mean_y == pytest.approx(aim[1], abs=1e-8)

    def test_aim_shift_moves_samples(self):
        disp = Dispersion(sigma_long=10.0, sigma_lat=10.0)
        s1 = _grid_samples((0.0, 0.0), disp)
        s2 = _grid_samples((5.0, 0.0), disp)
        mean_x1 = sum(lx * p for (lx, _), p in s1)
        mean_x2 = sum(lx * p for (lx, _), p in s2)
        assert mean_x2 == pytest.approx(mean_x1 + 5.0, abs=1e-8)


# ── _interp ───────────────────────────────────────────────────────────────────


class TestInterp:
    """Verifies the shared linear-interpolation helper."""

    def test_exact_hit(self):
        assert _interp(_FAIRWAY_STROKES, 150.0) == pytest.approx(2.92, abs=1e-6)

    def test_above_max_clamped(self):
        assert _interp(_FAIRWAY_STROKES, 999.0) == pytest.approx(_FAIRWAY_STROKES[0][1])

    def test_below_min_clamped(self):
        assert _interp(_FAIRWAY_STROKES, 0.0) == pytest.approx(_FAIRWAY_STROKES[-1][1])

    def test_midpoint_interpolation(self):
        # Between 120 (2.78) and 110 (2.74): midpoint 115 → 2.76
        assert _interp(_FAIRWAY_STROKES, 115.0) == pytest.approx(2.76, abs=1e-6)

    def test_empty_table_fallback(self):
        assert _interp([], 100.0) == pytest.approx(3.0)


# ── expected_strokes_from ─────────────────────────────────────────────────────


class TestExpectedStrokesFrom:
    """Proves the expected-strokes function returns sensible PGA baselines."""

    def test_area_ordering_at_100_yards(self):
        """GREEN < FAIRWAY < ROUGH < SAND < RECOVERY at 100 yards.

        Why: the tables are calibrated so each area is strictly harder than
        the previous.  This is the core invariant the optimizer relies on.
        """
        d = 100.0
        green_val = expected_strokes_from(LandingArea.GREEN, d)
        fairway_val = expected_strokes_from(LandingArea.FAIRWAY, d)
        rough_val = expected_strokes_from(LandingArea.ROUGH, d)
        sand_val = expected_strokes_from(LandingArea.SAND, d)
        recovery_val = expected_strokes_from(LandingArea.RECOVERY, d)

        assert green_val < fairway_val, "green should beat fairway"
        assert fairway_val < rough_val, "fairway should beat rough"
        assert rough_val < sand_val, "rough should beat sand"
        assert sand_val < recovery_val, "sand should beat recovery"

    def test_area_ordering_at_30_yards(self):
        """Ordering holds at short distances too."""
        d = 30.0
        green_val = expected_strokes_from(LandingArea.GREEN, d)
        fairway_val = expected_strokes_from(LandingArea.FAIRWAY, d)
        rough_val = expected_strokes_from(LandingArea.ROUGH, d)
        sand_val = expected_strokes_from(LandingArea.SAND, d)

        assert green_val < fairway_val
        assert fairway_val < rough_val
        assert rough_val < sand_val

    def test_water_adds_penalty_stroke(self):
        """WATER = FAIRWAY + 1 penalty stroke (approx)."""
        d = 100.0
        fairway_val = expected_strokes_from(LandingArea.FAIRWAY, d)
        water_val = expected_strokes_from(LandingArea.WATER, d)
        # Water should be exactly fairway + _PENALTY_STROKE
        assert water_val == pytest.approx(fairway_val + _PENALTY_STROKE, abs=1e-9)

    def test_ob_same_as_water(self):
        """OB uses the same cost model as WATER (stroke-and-distance ≈ drop)."""
        d = 150.0
        assert expected_strokes_from(LandingArea.OB, d) == pytest.approx(
            expected_strokes_from(LandingArea.WATER, d), abs=1e-9
        )

    def test_sand_penalty_exact(self):
        d = 80.0
        rough_val = expected_strokes_from(LandingArea.ROUGH, d)
        sand_val = expected_strokes_from(LandingArea.SAND, d)
        assert sand_val == pytest.approx(rough_val + _SAND_ROUGH_PENALTY, abs=1e-9)

    def test_recovery_penalty_exact(self):
        d = 50.0
        rough_val = expected_strokes_from(LandingArea.ROUGH, d)
        recovery_val = expected_strokes_from(LandingArea.RECOVERY, d)
        assert recovery_val == pytest.approx(rough_val + _RECOVERY_ROUGH_PENALTY, abs=1e-9)

    def test_monotone_in_distance_green(self):
        """Longer putts cost more strokes (green)."""
        distances = [5.0, 10.0, 20.0, 30.0, 50.0]
        values = [expected_strokes_from(LandingArea.GREEN, d) for d in distances]
        for i in range(len(values) - 1):
            assert values[i] < values[i + 1], (
                f"green monotonicity violated at {distances[i]} vs {distances[i + 1]} yds"
            )

    def test_monotone_in_distance_fairway(self):
        """Further from pin on fairway costs more strokes."""
        distances = [30.0, 60.0, 100.0, 150.0, 200.0]
        values = [expected_strokes_from(LandingArea.FAIRWAY, d) for d in distances]
        for i in range(len(values) - 1):
            assert values[i] < values[i + 1]

    def test_zero_distance_clamped(self):
        """Distance of 0 yards returns the minimum-distance table entry."""
        # At d=0, clamps to the smallest distance in each table → finite value.
        for area in LandingArea:
            val = expected_strokes_from(area, 0.0)
            assert val > 0.0
            assert math.isfinite(val)

    def test_water_worse_than_sand_at_100_yards(self):
        """Water/OB is always worse than sand at practical distances."""
        d = 100.0
        assert expected_strokes_from(LandingArea.WATER, d) > expected_strokes_from(
            LandingArea.SAND, d
        )


# ── expected_strokes_for_aim ─────────────────────────────────────────────────


class TestExpectedStrokesForAim:
    """Unit tests for the dispersion convolution evaluator."""

    def test_returns_positive_strokes(self):
        es, _ = expected_strokes_for_aim(
            aim=(0.0, 0.0),
            dispersion=Dispersion(sigma_long=10.0, sigma_lat=8.0),
            classify_point=_classify_all_fairway,
            pin=PIN_ORIGIN,
        )
        assert es > 0.0
        assert math.isfinite(es)

    def test_breakdown_sums_to_one(self):
        _, breakdown = expected_strokes_for_aim(
            aim=(0.0, 0.0),
            dispersion=Dispersion(sigma_long=10.0, sigma_lat=8.0),
            classify_point=_classify_all_fairway,
            pin=PIN_ORIGIN,
        )
        assert sum(breakdown.values()) == pytest.approx(1.0, abs=1e-9)

    def test_all_fairway_breakdown_has_only_fairway(self):
        _, breakdown = expected_strokes_for_aim(
            aim=(0.0, 0.0),
            dispersion=Dispersion(sigma_long=5.0, sigma_lat=5.0),
            classify_point=_classify_all_fairway,
            pin=PIN_ORIGIN,
        )
        assert set(breakdown.keys()) == {"fairway"}
        assert breakdown["fairway"] == pytest.approx(1.0, abs=1e-9)

    def test_closer_aim_to_pin_lower_cost_no_hazard(self):
        """With no hazards, aiming at the pin beats aiming away from it.

        Why: all landing points are fairway, and the expected_strokes_from(fairway, d)
        is monotonically increasing in d.  The probability-weighted average distance
        to the pin is minimised when we aim at the pin (for a symmetric Gaussian).
        """
        disp = Dispersion(sigma_long=10.0, sigma_lat=10.0)
        at_pin, _ = expected_strokes_for_aim((0.0, 0.0), disp, _classify_all_fairway, PIN_ORIGIN)
        far_away, _ = expected_strokes_for_aim((30.0, 0.0), disp, _classify_all_fairway, PIN_ORIGIN)
        assert at_pin < far_away

    def test_water_left_raises_cost_when_aiming_left(self):
        """Aiming into a water hazard is costlier than aiming away from it."""
        disp = Dispersion(sigma_long=10.0, sigma_lat=15.0)  # wide lateral
        aim_into_water, _ = expected_strokes_for_aim(
            (-15.0, 0.0), disp, _classify_water_left, PIN_ORIGIN
        )
        aim_safe, _ = expected_strokes_for_aim(
            (10.0, 0.0), disp, _classify_water_left, PIN_ORIGIN
        )
        assert aim_into_water > aim_safe


# ── optimize_aim — behavioural tests ─────────────────────────────────────────


class TestOptimizeAimBehaviour:
    """High-level behavioural tests that prove the optimizer makes smart decisions."""

    def test_water_left_aim_shifts_right_vs_baseline(self):
        """Water hazard on the left shifts optimal aim to the RIGHT of the no-hazard case.

        Scenario: pin at origin; water for x < -10.  Wide lateral dispersion (σ_lat=20)
        means a significant fraction of shots reach the water when aiming at the pin.
        The optimizer should react by shifting aim to the right to reduce water exposure.

        Baseline (all fairway): optimal aim is at the pin (x=0) because without
        hazards the expected strokes are minimised by minimising distance to pin.

        With water on left: optimal aim must be strictly right of the baseline.
        """
        pin = PIN_ORIGIN
        disp = Dispersion(sigma_long=15.0, sigma_lat=20.0)
        candidates = [(-5.0, 0.0), (0.0, 0.0), (5.0, 0.0), (10.0, 0.0), (15.0, 0.0)]

        baseline = optimize_aim(candidates, disp, _classify_all_fairway, pin)
        hazard = optimize_aim(candidates, disp, _classify_water_left, pin)

        # Baseline: no-hazard optimum is at or very close to pin (x=0).
        assert baseline.aim[0] == pytest.approx(0.0, abs=1e-6)

        # With water on left, optimizer must shift aim to the right.
        assert hazard.aim[0] > baseline.aim[0], (
            f"Expected optimal aim to shift right of {baseline.aim[0]:.1f}, "
            f"but got {hazard.aim[0]:.1f}"
        )

    def test_wide_dispersion_favors_safe_aim_over_flag(self):
        """Wide dispersion → safe (away-from-bunker) aim beats the flag.

        Scenario: pin at (-5, 0) on the left edge of a green.  A bunker sits
        immediately left of the pin (x < -8).  Candidates span the pin, halfway
        to centre, and the centre of green.

        With WIDE dispersion (σ=12) many shots miss left into the bunker when
        aimed at the flag; the optimizer should choose an aim to the RIGHT of
        the flag (i.e., toward the centre of the green).

        With NARROW dispersion (σ=2) the risk of reaching the bunker is
        negligible, so the optimizer should choose the flag itself.
        """
        pin = (-5.0, 0.0)
        # Bunker just left of pin (x < -8); rest is green.
        flag_aim = (-5.0, 0.0)
        center_aim = (0.0, 0.0)
        candidates = [flag_aim, (-3.0, 0.0), (-1.0, 0.0), center_aim, (2.0, 0.0)]

        wide = Dispersion(sigma_long=12.0, sigma_lat=12.0)
        # sigma=1.0 → bunker is 3σ away from flag; probability of reaching it
        # is ~0.13 %, which is negligible — the flag is clearly optimal.
        narrow = Dispersion(sigma_long=1.0, sigma_lat=1.0)

        result_wide = optimize_aim(candidates, wide, _classify_bunker_left_of_pin, pin)
        result_narrow = optimize_aim(candidates, narrow, _classify_bunker_left_of_pin, pin)

        # Wide: should NOT choose the flag (too risky with the bunker right there)
        assert result_wide.aim[0] > flag_aim[0], (
            f"Wide dispersion should avoid the flag at x={flag_aim[0]}; "
            f"chose x={result_wide.aim[0]}"
        )

        # Narrow: should choose the flag (bunker risk is negligible)
        assert result_narrow.aim == flag_aim, (
            f"Narrow dispersion should choose the flag at {flag_aim}; "
            f"chose {result_narrow.aim}"
        )

    def test_wider_dispersion_yields_higher_expected_strokes(self):
        """Wider dispersion → higher expected strokes for the optimal aim.

        Why: wider dispersion means shots land farther from the aim on average
        → farther from the pin → more expected strokes, BEFORE considering
        hazards.  With hazards present the effect is amplified.

        Scenario: water on the left; compare a tight (σ=5) and loose (σ=20) player.
        Both choose their best aim from the same candidate list; the loose player
        still has higher expected strokes even at THEIR optimum.
        """
        pin = PIN_ORIGIN
        candidates = [(0.0, 0.0), (5.0, 0.0), (10.0, 0.0), (15.0, 0.0)]

        narrow = Dispersion(sigma_long=5.0, sigma_lat=5.0)
        wide = Dispersion(sigma_long=20.0, sigma_lat=20.0)

        r_narrow = optimize_aim(candidates, narrow, _classify_water_left, pin)
        r_wide = optimize_aim(candidates, wide, _classify_water_left, pin)

        assert r_wide.expected_strokes > r_narrow.expected_strokes, (
            f"Wide player E[strokes]={r_wide.expected_strokes:.3f} should exceed "
            f"narrow player E[strokes]={r_narrow.expected_strokes:.3f}"
        )

    def test_wider_dispersion_more_conservative_aim(self):
        """Wider dispersion → optimal aim is farther from the hazard than narrow.

        Same hazard scenario as above.  The narrow player can aim at or near the
        pin without risking water; the wide player must shift further right.
        """
        pin = PIN_ORIGIN
        candidates = [(0.0, 0.0), (5.0, 0.0), (10.0, 0.0), (15.0, 0.0)]

        narrow = Dispersion(sigma_long=5.0, sigma_lat=5.0)
        wide = Dispersion(sigma_long=20.0, sigma_lat=20.0)

        r_narrow = optimize_aim(candidates, narrow, _classify_water_left, pin)
        r_wide = optimize_aim(candidates, wide, _classify_water_left, pin)

        assert r_wide.aim[0] > r_narrow.aim[0], (
            f"Wide player should aim right of narrow player; "
            f"wide={r_wide.aim[0]}, narrow={r_narrow.aim[0]}"
        )

    def test_determinism(self):
        """Identical inputs produce identical outputs (no hidden randomness).

        The optimizer uses a deterministic grid; calling it twice in succession
        must return byte-for-byte identical floats.
        """
        pin = PIN_ORIGIN
        disp = Dispersion(sigma_long=10.0, sigma_lat=8.0)
        candidates = [(-5.0, 0.0), (0.0, 0.0), (5.0, 0.0)]

        r1 = optimize_aim(candidates, disp, _classify_water_left, pin)
        r2 = optimize_aim(candidates, disp, _classify_water_left, pin)

        assert r1.aim == r2.aim
        assert r1.expected_strokes == r2.expected_strokes   # exact float equality
        assert r1.breakdown == r2.breakdown

    def test_empty_candidates_raises(self):
        """Empty candidate list raises ValueError immediately."""
        with pytest.raises(ValueError, match="candidate_aims must not be empty"):
            optimize_aim([], Dispersion(10.0, 8.0), _classify_all_fairway, PIN_ORIGIN)

    def test_single_candidate_returns_that_aim(self):
        """A single candidate is trivially optimal."""
        only_aim = (3.0, 2.0)
        result = optimize_aim(
            [only_aim],
            Dispersion(sigma_long=5.0, sigma_lat=5.0),
            _classify_all_fairway,
            PIN_ORIGIN,
        )
        assert result.aim == only_aim
        assert len(result.all_results) == 1

    def test_all_results_length_matches_candidates(self):
        candidates = [(float(i), 0.0) for i in range(10)]
        result = optimize_aim(
            candidates,
            Dispersion(sigma_long=8.0, sigma_lat=6.0),
            _classify_all_fairway,
            PIN_ORIGIN,
        )
        assert len(result.all_results) == len(candidates)

    def test_result_aim_is_minimum_in_all_results(self):
        """The returned aim must be the actual minimum across all candidates."""
        candidates = [(-5.0, 0.0), (0.0, 0.0), (5.0, 0.0), (10.0, 0.0)]
        result = optimize_aim(
            candidates,
            Dispersion(sigma_long=10.0, sigma_lat=10.0),
            _classify_water_left,
            PIN_ORIGIN,
        )
        best_in_all = min(result.all_results, key=lambda r: r.expected_strokes)
        assert result.aim == best_in_all.aim
        assert result.expected_strokes == best_in_all.expected_strokes

    def test_zero_dispersion_aims_exactly_at_candidate(self):
        """With zero dispersion every shot lands exactly where aimed.

        The optimal aim is the candidate that gives the lowest
        expected_strokes_from at the aim-to-pin distance — i.e. the candidate
        closest to the pin (which is the pin itself when it's a candidate).

        We classify as GREEN (not fairway) because the fairway table clamps
        distances below 30 yards to 2.47, making all close candidates
        equivalent.  The green table has distinct values: green(0)≈1.02 vs
        green(10)≈1.63, so (0,0) is unambiguously the best candidate.
        """
        pin = PIN_ORIGIN
        candidates = [(-10.0, 0.0), (0.0, 0.0), (10.0, 0.0)]
        result = optimize_aim(
            candidates,
            Dispersion(sigma_long=0.0, sigma_lat=0.0),
            lambda x, y: LandingArea.GREEN,
            pin,
        )
        # (0, 0) is at the pin → green(0) ≈ 1.02 < green(10) ≈ 1.63
        assert result.aim == (0.0, 0.0)
