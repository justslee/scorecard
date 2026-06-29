"""DECADE-style expected-strokes aim optimizer.

A pure, self-contained math module implementing the core DECADE / strokes-gained
framework for choosing the aim point that minimises expected strokes, given:

  * A 2-D Gaussian shot-dispersion model (sigma_long × sigma_lat)
  * A course hazard model supplied by the caller (a ``ClassifyFn`` callable)
  * PGA-baseline expected-strokes tables by landing area and distance to pin

Design principles
-----------------
* **Pure Python** — only ``math`` and ``enum`` from the stdlib.  No deps, no I/O.
* **Deterministic** — a regular Gaussian quadrature grid replaces Monte-Carlo
  sampling, so tests are stable and the optimizer is cacheable.
* **Seam-ready** — ``ClassifyFn`` is the only coupling to course geometry; real
  polygons plug in later without touching this module.
* **Not wired in yet** — this module is intentionally NOT called from
  ``generate_recommendation()``; that integration is a separate item
  (caddie-decade-wire-recommend).

Coordinate convention
---------------------
* ``(x, y)`` in yards.
* ``x`` increases to the right (positive = right of aim line).
* ``y`` increases away from the player toward the target (long is positive).
* The pin location is supplied by the caller; (0, 0) is a natural default.
"""

from __future__ import annotations

import math
from enum import Enum
from typing import Callable, NamedTuple


# ── Landing area ───────────────────────────────────────────────────────────────


class LandingArea(str, Enum):
    """Possible landing areas for a golf shot, ordered by expected cost (cheapest first).

    The cost ordering at any given distance to pin is:
        GREEN < FAIRWAY < ROUGH < SAND < RECOVERY < WATER ≈ OB
    """

    GREEN = "green"
    FAIRWAY = "fairway"
    ROUGH = "rough"
    SAND = "sand"
    RECOVERY = "recovery"  # deep rough / hardpan / tree roots / fried-egg lie
    WATER = "water"        # red/yellow penalty area — 1-stroke drop
    OB = "ob"              # out of bounds — stroke and distance


# ── Expected-strokes baseline tables ──────────────────────────────────────────
#
# All distances in yards.  Tables are sorted descending by distance so the
# shared ``_interp()`` helper can walk them top-to-bottom.
#
# Sources / calibration
# ---------------------
# GREEN:   Broadie (2014) "Every Shot Counts" PGA Tour putting statistics.
#          1 yard ≈ 3 feet; a 10-yd (30-ft) putt ≈ 1.63 expected strokes.
#          Identical to strokes_gained._GREEN_TABLE (already in-repo).
#
# FAIRWAY: DECADE Golf / Broadie benchmark for PGA Tour approach shots,
#          30–260 yards.  Identical to strokes_gained._FAIRWAY_TABLE.
#
# ROUGH:   Broadie rough baseline (PGA Tour); ~10–15 % worse than fairway
#          at each distance due to reduced contact and spin control.
#          Identical to strokes_gained._ROUGH_TABLE.
#
# SAND:    Rough baseline + _SAND_ROUGH_PENALTY (0.20 strokes).
#          Explanation: greenside bunkers for PGA pros can be slightly better
#          than rough at very short distances (high sand-save rate), but for
#          the purpose of this optimizer we model sand as consistently *worse*
#          than rough — which reflects amateur reality and keeps the ordering
#          GREEN < FAIRWAY < ROUGH < SAND strictly monotone.  Tunable via the
#          constant below.
#
# RECOVERY: Rough + _RECOVERY_ROUGH_PENALTY (0.50).  Covers deep rough,
#          tree roots, hardpan, plugged lies — no separate published table.
#
# WATER/OB: _PENALTY_STROKE (1.0) + fairway baseline from the same distance.
#           Under 2019 Rules of Golf: water/penalty area = 1-stroke penalty +
#           play from drop zone (approximated as fairway at same distance).
#           OB = stroke-and-distance (same cost model here).

_GREEN_STROKES: list[tuple[float, float]] = [
    (90.0, 2.60), (80.0, 2.55), (70.0, 2.50), (60.0, 2.40),
    (50.0, 2.30), (45.0, 2.25), (40.0, 2.20), (35.0, 2.14),
    (30.0, 2.10), (25.0, 2.02), (20.0, 1.94), (15.0, 1.80),
    (10.0, 1.63), ( 8.0, 1.50), ( 6.0, 1.38), ( 5.0, 1.28),
    ( 4.0, 1.20), ( 3.0, 1.13), ( 2.0, 1.06), ( 1.0, 1.02),
]

_FAIRWAY_STROKES: list[tuple[float, float]] = [
    (260.0, 3.60), (240.0, 3.50), (220.0, 3.40), (200.0, 3.25),
    (190.0, 3.18), (180.0, 3.12), (175.0, 3.08), (170.0, 3.05),
    (160.0, 2.98), (150.0, 2.92), (140.0, 2.86), (130.0, 2.82),
    (125.0, 2.80), (120.0, 2.78), (110.0, 2.74), (100.0, 2.70),
    ( 90.0, 2.66), ( 80.0, 2.62), ( 70.0, 2.58), ( 60.0, 2.55),
    ( 50.0, 2.52), ( 40.0, 2.50), ( 30.0, 2.47),
]

_ROUGH_STROKES: list[tuple[float, float]] = [
    (200.0, 3.60), (180.0, 3.45), (160.0, 3.30), (150.0, 3.15),
    (140.0, 3.10), (130.0, 3.05), (120.0, 3.00), (100.0, 2.95),
    ( 80.0, 2.85), ( 60.0, 2.78), ( 50.0, 2.75), ( 40.0, 2.72),
    ( 30.0, 2.68), ( 20.0, 2.63),
]

# Penalties added to the rough baseline for higher-cost areas.
# Tuning these four constants is the primary calibration lever.
_SAND_ROUGH_PENALTY: float = 0.20      # SAND = ROUGH + 0.20
_RECOVERY_ROUGH_PENALTY: float = 0.50  # RECOVERY = ROUGH + 0.50
_PENALTY_STROKE: float = 1.0           # WATER / OB: +1 stroke, re-play from fairway


# ── Dispersion model ───────────────────────────────────────────────────────────


class Dispersion(NamedTuple):
    """2-D Gaussian shot-dispersion model (axis-aligned, 1-σ radii in yards).

    The distribution is axis-aligned in the aim-line frame:
        * ``sigma_long`` — std dev along the aim line (long/short, Y axis).
        * ``sigma_lat``  — std dev perpendicular to it (left/right, X axis).

    Both are *one*-standard-deviation values (68 % of shots within ±1σ).
    To convert from the "total spread" convention used in ``dispersion.py``
    (which stores 2 × std dev):

        sigma_lat  = width_yards / 4    # half-width / 2
        sigma_long = depth_yards / 4    # half-depth / 2

    Typical reference values (PGA Tour, 150-yd 7-iron):
        sigma_long ≈ 8 yds, sigma_lat ≈ 5 yds

    Typical reference values (15-hcp, same club):
        sigma_long ≈ 16 yds, sigma_lat ≈ 12 yds
    """

    sigma_long: float  # std dev along aim line (long/short), yards
    sigma_lat: float   # std dev perpendicular to aim (left/right), yards


# ── Course model abstraction ───────────────────────────────────────────────────

# A callable that maps a 2-D landing coordinate (x, y) to a LandingArea.
# This is the seam where real course geometry (circles, polygons, GeoJSON) plugs
# in later without touching the optimizer logic.
ClassifyFn = Callable[[float, float], LandingArea]


# ── Deterministic Gaussian quadrature grid ─────────────────────────────────────

# 21 nodes from −3.5σ to +3.5σ (captures ~99.97 % of a Gaussian; residual tail
# error ≤ 0.03 % — negligible for sub-yard aim-point optimisation).
_N_GRID: int = 21
_GRID_SIGMA_RANGE: float = 3.5


def _gauss_weights_1d(sigma: float) -> list[tuple[float, float]]:
    """Return ``(offset, normalised_weight)`` pairs for 1-D Gaussian integration.

    Offsets span ±``_GRID_SIGMA_RANGE`` × ``sigma``; weights are the un-normalised
    Gaussian PDF values divided by their sum so they add to exactly 1.0.

    If ``sigma <= 0`` the distribution collapses to a point mass at zero offset.
    """
    if sigma <= 0.0:
        return [(0.0, 1.0)]

    step = 2.0 * _GRID_SIGMA_RANGE * sigma / (_N_GRID - 1)
    raw: list[tuple[float, float]] = []
    total = 0.0
    for i in range(_N_GRID):
        offset = -_GRID_SIGMA_RANGE * sigma + i * step
        w = math.exp(-0.5 * (offset / sigma) ** 2)
        raw.append((offset, w))
        total += w
    return [(off, w / total) for off, w in raw]


def _grid_samples(aim: tuple[float, float], dispersion: Dispersion) -> list[tuple[tuple[float, float], float]]:
    """Return ``(landing_point, probability)`` pairs for a 2-D dispersion grid.

    The product of two independent 1-D Gaussian grids gives 21×21 = 441 cells.
    Probabilities sum to 1.0.
    """
    lat_weights = _gauss_weights_1d(dispersion.sigma_lat)
    long_weights = _gauss_weights_1d(dispersion.sigma_long)

    samples: list[tuple[tuple[float, float], float]] = []
    for dy, wy in long_weights:
        for dx, wx in lat_weights:
            landing: tuple[float, float] = (aim[0] + dx, aim[1] + dy)
            samples.append((landing, wx * wy))
    return samples


# ── Expected-strokes lookup ────────────────────────────────────────────────────


def _interp(table: list[tuple[float, float]], distance: float) -> float:
    """Linear interpolation from a descending-distance ``(dist, strokes)`` table."""
    if not table:
        return 3.0
    if distance >= table[0][0]:
        return table[0][1]
    if distance <= table[-1][0]:
        return table[-1][1]
    for i in range(len(table) - 1):
        d1, s1 = table[i]
        d2, s2 = table[i + 1]
        if d2 <= distance <= d1:
            t = (distance - d2) / (d1 - d2) if d1 != d2 else 0.0
            return s2 + t * (s1 - s2)
    return table[-1][1]  # pragma: no cover


def expected_strokes_from(area: LandingArea, distance_to_pin_yds: float) -> float:
    """Expected strokes to hole out from a given landing area and pin distance.

    All distances in yards.  Uses PGA Tour scratch baselines; callers that want
    handicap-adjusted values should scale the return value externally.

    For WATER and OB, ``distance_to_pin_yds`` is the approximate distance from
    the *drop / re-play location* to the pin (the landing point itself is used
    as a proxy here, which is a standard DECADE simplification).

    The ordering of returned values at any distance is:
        GREEN < FAIRWAY < ROUGH < SAND < RECOVERY, and WATER ≈ OB (both add
        ``_PENALTY_STROKE`` on top of the FAIRWAY baseline).
    """
    d = max(0.0, distance_to_pin_yds)

    if area == LandingArea.GREEN:
        return _interp(_GREEN_STROKES, d)
    if area == LandingArea.FAIRWAY:
        return _interp(_FAIRWAY_STROKES, d)
    if area == LandingArea.ROUGH:
        return _interp(_ROUGH_STROKES, d)
    if area == LandingArea.SAND:
        # Sand is rough + penalty (see module docstring for calibration notes)
        return _interp(_ROUGH_STROKES, d) + _SAND_ROUGH_PENALTY
    if area == LandingArea.RECOVERY:
        return _interp(_ROUGH_STROKES, d) + _RECOVERY_ROUGH_PENALTY
    if area in (LandingArea.WATER, LandingArea.OB):
        # 1-stroke penalty + play from fairway at approximately the same distance
        return _PENALTY_STROKE + _interp(_FAIRWAY_STROKES, d)
    # Unknown area — treat as rough
    return _interp(_ROUGH_STROKES, d)


# ── Result types ───────────────────────────────────────────────────────────────


class AimResult(NamedTuple):
    """Expected-strokes evaluation for a single aim point."""

    aim: tuple[float, float]
    expected_strokes: float
    # Probability mass in each LandingArea.  Keys are LandingArea.value strings;
    # values sum to 1.0 (may not sum exactly due to floating-point rounding).
    breakdown: dict[str, float]


class OptimizeResult(NamedTuple):
    """Output of ``optimize_aim`` — the best aim point and supporting detail."""

    aim: tuple[float, float]
    expected_strokes: float
    breakdown: dict[str, float]      # area probabilities for the best aim
    all_results: list[AimResult]     # full candidate list, for inspection/debug


# ── Core evaluator ─────────────────────────────────────────────────────────────


def expected_strokes_for_aim(
    aim: tuple[float, float],
    dispersion: Dispersion,
    classify_point: ClassifyFn,
    pin: tuple[float, float],
) -> tuple[float, dict[str, float]]:
    """Compute expected strokes for one aim point by convolving the dispersion.

    Evaluates a deterministic 21×21 Gaussian grid centred on ``aim``, classifies
    each landing cell via ``classify_point``, and sums::

        E[strokes] = Σ_i  P(landing_i) × expected_strokes_from(area_i, dist_i_to_pin)

    Args:
        aim:            Where the player aims, (x, y) in yards.
        dispersion:     Shot-dispersion model (sigma_long, sigma_lat).
        classify_point: Course-geometry function ``(x, y) → LandingArea``.
        pin:            Pin location, (x, y) in yards.

    Returns:
        ``(expected_strokes, area_probability_breakdown)`` where the breakdown
        maps ``LandingArea.value`` strings to probability weights (sum ≈ 1.0).
    """
    samples = _grid_samples(aim, dispersion)

    total_es = 0.0
    area_probs: dict[str, float] = {}

    for (lx, ly), prob in samples:
        area = classify_point(lx, ly)
        dist = math.hypot(lx - pin[0], ly - pin[1])
        es = expected_strokes_from(area, dist)
        total_es += prob * es
        key = area.value
        area_probs[key] = area_probs.get(key, 0.0) + prob

    return total_es, area_probs


# ── Optimizer ─────────────────────────────────────────────────────────────────


def optimize_aim(
    candidate_aims: list[tuple[float, float]],
    dispersion: Dispersion,
    classify_point: ClassifyFn,
    pin: tuple[float, float],
) -> OptimizeResult:
    """Find the aim point that minimises expected strokes.

    Evaluates each candidate and returns the one with the lowest expected
    strokes.  A caller wishing a continuous optimum can pass a fine grid of
    candidates; the function makes no assumptions about their structure.

    Complexity: O(N_candidates × N_grid²) where N_grid = 21 (441 cells/candidate).

    Args:
        candidate_aims: List of ``(x, y)`` aim points to evaluate, yards.
                        At least one element required.
        dispersion:     Shot-dispersion model.
        classify_point: Course-geometry function ``(x, y) → LandingArea``.
        pin:            Pin location, (x, y) in yards.

    Returns:
        ``OptimizeResult`` containing the best aim, its expected strokes,
        area breakdown, and the full candidate list for post-analysis.

    Raises:
        ValueError: If ``candidate_aims`` is empty.
    """
    if not candidate_aims:
        raise ValueError("candidate_aims must not be empty")

    all_results: list[AimResult] = []
    for aim in candidate_aims:
        es, breakdown = expected_strokes_for_aim(aim, dispersion, classify_point, pin)
        all_results.append(AimResult(aim=aim, expected_strokes=es, breakdown=breakdown))

    best = min(all_results, key=lambda r: r.expected_strokes)

    return OptimizeResult(
        aim=best.aim,
        expected_strokes=best.expected_strokes,
        breakdown=best.breakdown,
        all_results=all_results,
    )
