"""Ball-flight physics engine — deterministic carry/roll/total for ONE shot.

Pure, unit-testable module: stdlib only (math/dataclasses/functools), no DB, no
network, no async. This is the world model the caddie CITES instead of doing
distance arithmetic itself — the same pattern that fixed hazards (geometry is
ground truth, the model is a writer). See PHYSICS_GROUNDING_RULE.

Owner escalation (2026-07-09, 4-screenshot session): the caddie told the owner
a 300-yard drive with 4 mph downwind and 38 ft downhill "plays about 392 /
total around 390". Two failures: the plays-like adjustment was applied to the
390 PIN instead of the 300 DRIVE, and the underlying math was a stack of scalar
rules of thumb that can't distinguish CARRY from ROLL. This engine replaces
that math; the incident case is pinned in tests (total 315-330, NOT 390).

Model (specs/caddie-shot-physics-engine-plan.md):
  - CARRY: full RK4 integration of the flight ODEs on the AIRSPEED u = v − w
    (wind is a vector, not a head-component fudge):
        F_drag  = −½ ρ C_d(S) A |u| u
        F_lift  =  ½ ρ C_l(S) A |u|² (ŝ × û)      (Magnus, backspin axis)
        F_grav  = −m g ẑ
    with spin-ratio coefficients C_d(S) = CD0 + CD1·S (capped) and
    C_l(S) = CL1·S (capped), S = ωr/|u|, and exponential spin decay
    ω(t) = ω₀·exp(−t/τ). Termination on the LANDING PLANE (elevation delta),
    with sub-step linear interpolation — downhill shots fly farther because
    they fall longer, not because of a 1yd/3ft scalar.
  - ROLL: closed-form turf model (roll_out) — impact angle vs landing-area
    grade, speed retention falling with impact steepness, Coulomb friction
    with a −sin(γ) downslope term. Turf mechanics is genuinely messy; a
    calibrated closed form is honest, integrating it would be false precision.
  - DIFFERENTIAL use: the engine is reverse-fitted to the PLAYER'S own stored
    club distance (neutral_carry_from_stored + fit_launch_to_carry), so
    systematic aero-model error cancels — no launch monitor needed.

Calibration: CLUB_REFERENCE (Trackman-style tour averages) is ground truth;
the aero constants below were tuned until every row integrates to its
reference carry within ±4 y and descent within ±3° (test_physics.py pins
this). The roll constants are calibrated to the plan §5 roll-fraction targets
(driver ~20-24 y on 300 total, 7-iron 3-6 y, wedges 0-3 y, firm/soft spreads).

Every simplifying assumption is SURFACED as a string on the result so the
caddie can be honest about what it assumed ("treated your 300 as total",
"landing slope approximated from tee-to-target elevation change", ...).

Axes: x = downrange (toward the target), y = lateral, z = up. head_mps > 0 is
a HEADWIND (wind vector −x); cross_mps > 0 blows toward +y. Backspin axis is
ŝ = (0, −1, 0) so ŝ × û tilts the lift up and slightly back; sidespin is not
modeled (lateral drift comes from crosswind drag only).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from typing import NamedTuple, Optional

# ── Physical constants ────────────────────────────────────────────────────────

BALL_MASS_KG: float = 0.04593  # USGA maximum ball mass (1.62 oz)
BALL_RADIUS_M: float = 0.021335  # USGA minimum diameter 42.67 mm / 2
BALL_AREA_M2: float = math.pi * BALL_RADIUS_M**2  # frontal area ≈ 1.43e-3 m²
G: float = 9.80665

# Air density at the app's standard conditions (70°F, 50% RH, 1013.25 hPa) —
# matches air_density_kg_m3(70, 50) and mirrors weather.py's baseline.
RHO_NEUTRAL: float = 1.1938

# ── Aero coefficients (PINNED by the CLUB_REFERENCE calibration test) ─────────
# C_d(S) = CD0 + CD1·S capped at CD_MAX; C_l(S) = CL1·S capped at CL_MAX;
# spin decays ω(t) = ω₀·exp(−t/SPIN_DECAY_TAU_S). Tuned (from the plan's
# starting values 0.225/0.35/0.35/1.90/0.38/25) so every CLUB_REFERENCE row
# integrates to its reference carry ±4 y / descent ±3° (the table is ground
# truth; the constants serve it). Do not hand-edit without re-running
# test_physics.py's calibration test.
CD0: float = 0.224
CD1: float = 0.390
CD_MAX: float = 0.390
CL1: float = 1.760
CL_MAX: float = 0.392
SPIN_DECAY_TAU_S: float = 27.0

# Density-sensitivity correction (documented deviation from the plan's linear-ρ
# force law): with F ∝ ρ the model overstates thin-air gain — Denver
# (5,280 ft, ρ ≈ −17%) came out +18 y on a 7-iron vs the plan's measured band
# of +4-11 y (real balls lose Reynolds number in thin air, so C_d creeps up
# and eats part of the drag win; the linear model has no Re dependence). The
# minimal sound fix: the aero forces see an EFFECTIVE density
# ρ_eff = ρ_neutral · (ρ/ρ_neutral)^RHO_SENSITIVITY_EXP, identity at neutral
# density (the CLUB_REFERENCE calibration is untouched), monotone in ρ, and
# calibrated so Denver lands mid-band (~+7 y) and the 40°F/90°F spread stays
# in its 3-9 y band.
RHO_SENSITIVITY_EXP: float = 0.55

# ── Unit helpers ──────────────────────────────────────────────────────────────

_MPH_TO_MPS: float = 0.44704
_M_PER_FT: float = 0.3048
_FT_PER_M: float = 1.0 / _M_PER_FT
_M_PER_YARD: float = 0.9144
_YARDS_PER_M: float = 1.0 / _M_PER_YARD

# Integration guards
_MAX_FLIGHT_S: float = 20.0
_MIN_AIRSPEED_MPS: float = 1e-6

# Barometric fallback (used ONLY when no surface pressure is available —
# Open-Meteo surface_pressure is already altitude-adjusted; applying altitude
# on top of it would double-count, see app/services/weather.py lines ~72-80).
_SEA_LEVEL_PRESSURE_HPA: float = 1013.25
# Dry air / water vapor molar masses (kg/mol) and gas constant — same Magnus
# humidity treatment as weather.compute_air_density_factor, in absolute units.
_M_DRY: float = 0.0289647
_M_VAPOR: float = 0.018016
_R_GAS: float = 8.31446


def air_density_kg_m3(
    temp_f: float,
    humidity_pct: float,
    pressure_hpa: float | None = None,
    altitude_ft: float | None = None,
) -> float:
    """Absolute air density (kg/m³) from temperature, humidity and pressure.

    Mirrors weather.compute_air_density_factor's Magnus-humidity treatment but
    returns an ABSOLUTE density for the integrator instead of a ratio.

    Pressure precedence (the double-count trap): when ``pressure_hpa`` is
    given it is treated as the SURFACE pressure at the course (Open-Meteo's
    surface_pressure already reflects altitude) and ``altitude_ft`` is
    ignored. Only when pressure is missing is the barometric formula applied
    to ``altitude_ft`` (sea level assumed when both are missing).
    """
    temp_c = (temp_f - 32.0) * 5.0 / 9.0
    if pressure_hpa is None:
        alt_m = (altitude_ft or 0.0) * _M_PER_FT
        pressure_hpa = _SEA_LEVEL_PRESSURE_HPA * (1.0 - 2.25577e-5 * alt_m) ** 5.25588
    # Magnus saturation vapor pressure (hPa) — same formula as weather.svp.
    svp_hpa = 6.1078 * math.exp((17.27 * temp_c) / (temp_c + 237.3))
    vapor_hpa = max(0.0, min(humidity_pct, 100.0)) / 100.0 * svp_hpa
    dry_hpa = pressure_hpa - vapor_hpa
    temp_k = temp_c + 273.15
    return (dry_hpa * 100.0 * _M_DRY + vapor_hpa * 100.0 * _M_VAPOR) / (_R_GAS * temp_k)


# ── Flight integration (RK4) ──────────────────────────────────────────────────


@dataclass(frozen=True)
class LaunchConditions:
    """Initial ball state: speed (m/s), launch angle (deg), backspin (rpm)."""

    ball_speed_mps: float
    launch_deg: float
    spin_rpm: float


@dataclass(frozen=True)
class FlightSample:
    """The landing-plane crossing of one integrated trajectory."""

    carry_yards: float
    apex_ft: float
    flight_time_s: float
    descent_deg: float  # below horizontal at landing
    landing_speed_mps: float  # ground-frame speed at landing
    lateral_yards: float  # +y drift (crosswind); 0 in still air


def integrate_flight(
    launch: LaunchConditions,
    rho: float,
    head_mps: float = 0.0,
    cross_mps: float = 0.0,
    landing_delta_m: float = 0.0,
    dt: float = 0.01,
) -> FlightSample:
    """RK4-integrate one trajectory; terminate on the landing plane.

    ``landing_delta_m`` is the landing surface's height relative to the launch
    point (negative = downhill: the ball falls longer and carries farther).
    Termination: the first descending (vz < 0) crossing of z = landing_delta_m,
    located by sub-step linear interpolation. If the landing plane is ABOVE the
    apex (a severely uphill target the shot cannot reach on the fly), the
    trajectory terminates just past the apex — the honest "comes up short of
    the plane" carry — rather than integrating forever.

    Deterministic: pure float math, no randomness — identical inputs give
    identical outputs (pinned in tests).
    """
    wx, wy = -head_mps, cross_mps  # wind VECTOR in ground frame
    omega0 = launch.spin_rpm * 2.0 * math.pi / 60.0
    theta = math.radians(launch.launch_deg)
    v0 = launch.ball_speed_mps
    # Effective density for the aero forces (see RHO_SENSITIVITY_EXP note).
    rho = RHO_NEUTRAL * (max(rho, 1e-6) / RHO_NEUTRAL) ** RHO_SENSITIVITY_EXP

    def deriv(t: float, s: tuple[float, ...]) -> tuple[float, ...]:
        _, _, _, vx, vy, vz = s
        ux, uy, uz = vx - wx, vy - wy, vz  # airspeed u = v − w
        u = math.sqrt(ux * ux + uy * uy + uz * uz)
        if u < _MIN_AIRSPEED_MPS:
            return (vx, vy, vz, 0.0, 0.0, -G)
        omega = omega0 * math.exp(-t / SPIN_DECAY_TAU_S)
        spin_ratio = omega * BALL_RADIUS_M / u
        cd = min(CD0 + CD1 * spin_ratio, CD_MAX)
        cl = min(CL1 * spin_ratio, CL_MAX)
        q = 0.5 * rho * BALL_AREA_M2 * u  # ½ρA|u| — one |u| folded into vectors
        # Drag −cd·q·u ; Magnus with ŝ = (0,−1,0): ŝ × û |u|² = (−uz, 0, ux)·|u|
        fx = -cd * q * ux + cl * q * (-uz)
        fy = -cd * q * uy
        fz = -cd * q * uz + cl * q * ux
        return (vx, vy, vz, fx / BALL_MASS_KG, fy / BALL_MASS_KG, fz / BALL_MASS_KG - G)

    state: tuple[float, ...] = (
        0.0,
        0.0,
        0.0,
        v0 * math.cos(theta),
        0.0,
        v0 * math.sin(theta),
    )
    t = 0.0
    apex_m = 0.0

    def rk4_step(t: float, s: tuple[float, ...], h: float) -> tuple[float, ...]:
        k1 = deriv(t, s)
        k2 = deriv(t + h / 2.0, tuple(si + h / 2.0 * ki for si, ki in zip(s, k1)))
        k3 = deriv(t + h / 2.0, tuple(si + h / 2.0 * ki for si, ki in zip(s, k2)))
        k4 = deriv(t + h, tuple(si + h * ki for si, ki in zip(s, k3)))
        return tuple(
            si + h / 6.0 * (a + 2.0 * b + 2.0 * c + d)
            for si, a, b, c, d in zip(s, k1, k2, k3, k4)
        )

    while t < _MAX_FLIGHT_S:
        prev = state
        state = rk4_step(t, state, dt)
        t += dt
        apex_m = max(apex_m, state[2])
        if state[5] < 0.0 and state[2] <= landing_delta_m:
            if prev[2] > landing_delta_m:
                # Sub-step linear interpolation to the exact plane crossing.
                frac = (prev[2] - landing_delta_m) / (prev[2] - state[2])
            else:
                # Plane above the whole descent (uphill beyond apex): the shot
                # can't reach the plane on the fly — terminate at this step.
                frac = 0.0
            landed = tuple(p + frac * (c - p) for p, c in zip(prev, state))
            t_land = t - dt + frac * dt
            return _sample_from_state(landed, t_land, apex_m)

    # Time cap (pathological inputs only) — report the state where we stopped.
    return _sample_from_state(state, t, apex_m)


def _sample_from_state(
    s: tuple[float, ...], t: float, apex_m: float
) -> FlightSample:
    x, y, _, vx, vy, vz = s
    horiz = math.sqrt(vx * vx + vy * vy)
    descent = math.degrees(math.atan2(-vz, horiz)) if (horiz or vz) else 0.0
    return FlightSample(
        carry_yards=x * _YARDS_PER_M,
        apex_ft=apex_m * _FT_PER_M,
        flight_time_s=t,
        descent_deg=descent,
        landing_speed_mps=math.sqrt(vx * vx + vy * vy + vz * vz),
        lateral_yards=y * _YARDS_PER_M,
    )


# ── Club reference table (ground truth for the aero calibration) ──────────────


@dataclass(frozen=True)
class ClubReference:
    """Tour-average launch prior + the reference flight it must integrate to.

    ``carry_yards``/``descent_deg`` for driver..pw are published Trackman tour
    averages; the launch priors (ball speed / launch / spin) were nudged
    within tour-typical scatter so ONE global aero model reproduces every
    reference within ±4 y / ±3° (see the calibration test). gw/sw/lw are our
    extrapolations (Trackman publishes no gw/sw/lw row) — their references are
    the model's own integration of plausible priors, self-consistent by
    construction and labeled as such.

    ``roll_frac`` = typical roll as a fraction of TOTAL on medium turf. Load-
    bearing only for WOOD_CLUBS (stored distances are totals → carry is backed
    out via this fraction); informational for irons/wedges (stored = carry).
    The driver value is pinned by the plan's worked incident case
    (300 total → 277 neutral carry).
    """

    ball_speed_mph: float
    launch_deg: float
    spin_rpm: float
    carry_yards: float
    descent_deg: float
    roll_frac: float


CLUB_REFERENCE: dict[str, ClubReference] = {
    "driver": ClubReference(168.5, 10.3, 2786, 275.0, 38.0, 0.077),
    "3wood": ClubReference(156.5, 8.4, 3855, 243.0, 43.0, 0.050),
    "5wood": ClubReference(150.5, 8.6, 4350, 230.0, 47.0, 0.036),
    "hybrid": ClubReference(146.0, 9.6, 4237, 225.0, 47.0, 0.035),
    "4iron": ClubReference(136.0, 10.6, 4836, 203.0, 48.0, 0.040),
    "5iron": ClubReference(132.5, 12.1, 5261, 194.0, 49.0, 0.036),
    "6iron": ClubReference(128.5, 14.7, 6031, 183.0, 50.0, 0.032),
    "7iron": ClubReference(121.5, 16.9, 6797, 172.0, 50.0, 0.030),
    "8iron": ClubReference(116.5, 18.9, 7698, 160.0, 50.0, 0.026),
    "9iron": ClubReference(110.5, 21.2, 8447, 148.0, 51.0, 0.022),
    "pw": ClubReference(103.5, 25.0, 9304, 136.0, 52.0, 0.016),
    # Extrapolated rows (no published Trackman average) — references are the
    # model's own still-air integration of the priors, rounded.
    "gw": ClubReference(94.0, 26.5, 9800, 123.0, 48.0, 0.014),
    "sw": ClubReference(84.0, 29.0, 10200, 106.0, 48.0, 0.012),
    "lw": ClubReference(74.0, 31.0, 10500, 89.0, 46.0, 0.010),
}

# Clubs whose STORED distance is a TOTAL (players quote driver/wood numbers
# with roll included); everything else is stored as CARRY.
WOOD_CLUBS: frozenset[str] = frozenset({"driver", "3wood", "5wood", "hybrid"})
_WEDGE_CLUBS: frozenset[str] = frozenset({"pw", "gw", "sw", "lw"})


def club_class(club: str) -> str:
    """'wood' | 'iron' | 'wedge' — the roll model's club family."""
    if club in WOOD_CLUBS:
        return "wood"
    if club in _WEDGE_CLUBS:
        return "wedge"
    return "iron"


# ── Reverse fit: anchor the model to the PLAYER'S stored distance ─────────────


def neutral_carry_from_stored(club: str, stored_yards: float) -> tuple[float, str]:
    """Back out the player's NEUTRAL CARRY from their stored club distance.

    Woods: stored is treated as TOTAL → carry = stored·(1 − roll_frac).
    Irons/wedges: stored is treated as CARRY, used as-is.
    Returns (neutral_carry_yards, the surfaced assumption string).
    """
    ref = _club_ref(club)
    if club in WOOD_CLUBS:
        carry = stored_yards * (1.0 - ref.roll_frac)
        return carry, (
            f"treated your {stored_yards:.0f}y {club} as TOTAL distance; "
            f"carry backed out as {carry:.0f}y assuming ~{ref.roll_frac:.0%} roll"
        )
    return float(stored_yards), (
        f"treated your {stored_yards:.0f}y {club} as CARRY distance"
    )


def _club_ref(club: str) -> ClubReference:
    try:
        return CLUB_REFERENCE[club]
    except KeyError:
        raise ValueError(
            f"unknown club {club!r}; expected one of {sorted(CLUB_REFERENCE)}"
        ) from None


_FIT_TOL_YARDS: float = 0.1
_FIT_MAX_ITER: int = 30
_FIT_K_MIN: float = 0.35
_FIT_K_MAX: float = 2.0
# Spin scales with ball speed only up to a point — real players' spin rates
# plateau (a 220y-carry 7-iron does not spin 12k rpm). Without this cap the
# ×k spin scaling makes carry(k) SATURATE (~219 y for the 7-iron at k≈1.8,
# falling beyond — ballooning), leaving the top of the fit range unreachable
# and the secant solve oscillating. Fits with k ≤ 1.4 are bit-identical.
_FIT_SPIN_K_CAP: float = 1.4


def fit_launch_to_carry(club: str, neutral_carry_yards: float) -> LaunchConditions:
    """Solve the launch prior scale so still-air carry matches the player.

    Secant solve on a single multiplier k applied to the reference BALL SPEED
    (spin scales ×k with it — spin rises roughly with ball speed — launch
    angle held) until the integrated still-air, neutral-density carry equals
    ``neutral_carry_yards`` within ±0.1 y. Cached (carry rounded to 0.1 y for
    cache stability; well inside the solve tolerance).
    """
    _club_ref(club)  # validate before touching the cache
    return _fit_cached(club, round(neutral_carry_yards, 1))


@lru_cache(maxsize=1024)
def _fit_cached(club: str, neutral_carry_yards: float) -> LaunchConditions:
    ref = CLUB_REFERENCE[club]

    def launch_for(k: float) -> LaunchConditions:
        return LaunchConditions(
            ball_speed_mps=ref.ball_speed_mph * _MPH_TO_MPS * k,
            launch_deg=ref.launch_deg,
            spin_rpm=ref.spin_rpm * min(k, _FIT_SPIN_K_CAP),
        )

    def carry_err(k: float) -> float:
        flight = integrate_flight(launch_for(k), RHO_NEUTRAL)
        return flight.carry_yards - neutral_carry_yards

    k0 = min(max(neutral_carry_yards / ref.carry_yards, _FIT_K_MIN), _FIT_K_MAX)
    k1 = min(max(k0 * 1.03, _FIT_K_MIN), _FIT_K_MAX)
    if k1 == k0:
        k1 = k0 * 0.97
    f0, f1 = carry_err(k0), carry_err(k1)
    best_k, best_err = (k0, abs(f0)) if abs(f0) < abs(f1) else (k1, abs(f1))
    for _ in range(_FIT_MAX_ITER):
        if abs(f1) <= _FIT_TOL_YARDS:
            return launch_for(k1)
        if f1 == f0:  # flat — cannot improve further
            break
        k2 = k1 - f1 * (k1 - k0) / (f1 - f0)
        k2 = min(max(k2, _FIT_K_MIN), _FIT_K_MAX)
        k0, f0, k1 = k1, f1, k2
        f1 = carry_err(k1)
        if abs(f1) < best_err:
            best_k, best_err = k1, abs(f1)
    # Exhausted (target outside the reachable range): closest achievable fit.
    return launch_for(best_k)


# ── Roll model (closed-form turf mechanics, calibrated to plan §5) ────────────
# The bounce-roll transition speed is modeled from IMPACT GEOMETRY: the
# effective impact angle γ_eff (descent vs the landing-area grade — a
# downslope shallows the impact, an upslope steepens it) sets a retention that
# falls exponentially with steepness and is capped (a shallow skip still
# bleeds energy into the turf); firmness and club family scale it. The
# reference horizontal speed _ROLL_V_REF (not the raw landing speed) carries
# the speed scale — landing-speed² amplification made hot downhill landings
# roll far past the plan's calibration bands, and calibration showed roll-out
# is dominated by geometry, so raw landing speed enters only through γ_eff
# and the descent shape. The rolling ball then decelerates under Coulomb
# friction with the −sin(γ) downslope term: a = g(μ·cosφ + sinφ) — a
# downslope both shallows the impact AND weakens the braking.
# Constants calibrated to the plan §5 targets (driver ~20-24 y roll on a 300
# total on medium turf, round-tripping 300±2; 7-iron 3-6 y; wedges 0-3 y;
# firm ≥ medium+6; soft ≤ medium−8; a 20 mph headwind kills >40% of driver
# roll; the incident case rolls 24-34).

_ROLL_V_REF_MPS: float = 27.0  # reference landing speed carrying the scale
_ROLL_R_BASE: float = 0.72  # retention at the 38° reference impact, medium
_ROLL_GAMMA_REF_DEG: float = 38.0
_ROLL_GAMMA_SCALE_DEG: float = 22.0
_ROLL_R_CAP: float = 0.654  # skid cap — shallow impacts don't retain forever
_ROLL_MU: float = 0.45  # effective turf friction (bounce losses folded in)
_ROLL_MIN_DECEL: float = 0.8  # m/s² floor — a steep downslope never rolls forever
_ROLL_MIN_GAMMA_DEG: float = 5.0
_ROLL_FIRMNESS_RETENTION: dict[str, float] = {"firm": 1.15, "medium": 1.0, "soft": 0.72}
_ROLL_CLASS_RETENTION: dict[str, float] = {"wood": 1.0, "iron": 0.70, "wedge": 0.45}


def roll_out(
    flight: FlightSample,
    grade_pct: float = 0.0,
    firmness: str = "medium",
    club_cls: str = "iron",
) -> float:
    """Roll-out (yards) after the carry, from the landing state.

    ``grade_pct`` is the landing-area grade in percent (negative = downslope
    in the direction of play). ``firmness`` ∈ soft|medium|firm (unknown values
    fall back to medium). ``club_cls`` ∈ wood|iron|wedge (see club_class).
    """
    slope_rad = math.atan(grade_pct / 100.0)
    gamma_eff = max(
        _ROLL_MIN_GAMMA_DEG, flight.descent_deg + math.degrees(slope_rad)
    )
    gamma_term = _ROLL_R_BASE * math.exp(
        -(gamma_eff - _ROLL_GAMMA_REF_DEG) / _ROLL_GAMMA_SCALE_DEG
    )
    retention = (
        min(gamma_term, _ROLL_R_CAP)
        * _ROLL_FIRMNESS_RETENTION.get(firmness, 1.0)
        * _ROLL_CLASS_RETENTION.get(club_cls, 1.0)
    )
    v_roll = max(0.0, _ROLL_V_REF_MPS * math.cos(math.radians(gamma_eff)) * retention)
    decel = max(G * (_ROLL_MU * math.cos(slope_rad) + math.sin(slope_rad)), _ROLL_MIN_DECEL)
    return (v_roll * v_roll) / (2.0 * decel) * _YARDS_PER_M


# ── Conditions + the two questions the caddie asks ────────────────────────────


@dataclass(frozen=True)
class ShotConditions:
    """Resolved physical conditions for ONE shot (see conditions_from_weather)."""

    rho_kg_m3: float = RHO_NEUTRAL
    head_mps: float = 0.0  # >0 headwind, <0 tailwind
    cross_mps: float = 0.0  # >0 blowing toward +y
    elevation_delta_ft: float = 0.0  # landing surface vs launch (+ = uphill)
    grade_pct: float = 0.0  # landing-area grade (− = downslope)
    firmness: str = "medium"


NEUTRAL_CONDITIONS = ShotConditions()


@dataclass(frozen=True)
class ShotResult:
    """What one club actually does under the given conditions."""

    club: str
    neutral_carry_yards: float
    carry_yards: float
    roll_yards: float
    total_yards: float
    apex_ft: float
    descent_deg: float
    flight_time_s: float
    lateral_yards: float
    assumptions: tuple[str, ...]


def simulate_shot(
    launch: LaunchConditions, cond: ShotConditions, club_cls: str
) -> tuple[FlightSample, float]:
    """Integrate one launch under conditions; returns (flight, roll_yards)."""
    flight = integrate_flight(
        launch,
        rho=cond.rho_kg_m3,
        head_mps=cond.head_mps,
        cross_mps=cond.cross_mps,
        landing_delta_m=cond.elevation_delta_ft * _M_PER_FT,
    )
    roll = roll_out(flight, cond.grade_pct, cond.firmness, club_cls)
    return flight, roll


def shot_distance_for_club(
    club: str, stored_yards: float, cond: ShotConditions
) -> ShotResult:
    """Question 1: what does MY club do HERE? (the incident's missing answer)

    Anchors the model to the player's stored distance (reverse fit), then
    integrates the flight under the given conditions and adds the turf roll.
    """
    neutral_carry, stored_assumption = neutral_carry_from_stored(club, stored_yards)
    launch = fit_launch_to_carry(club, neutral_carry)
    flight, roll = simulate_shot(launch, cond, club_class(club))
    assumptions = (
        stored_assumption,
        f"launch profile assumed from tour-average {club} shape scaled to your number",
        f"landing turf {cond.firmness}; landing-area grade {cond.grade_pct:+.1f}%",
    )
    return ShotResult(
        club=club,
        neutral_carry_yards=neutral_carry,
        carry_yards=flight.carry_yards,
        roll_yards=roll,
        total_yards=flight.carry_yards + roll,
        apex_ft=flight.apex_ft,
        descent_deg=flight.descent_deg,
        flight_time_s=flight.flight_time_s,
        lateral_yards=flight.lateral_yards,
        assumptions=assumptions,
    )


def plays_like_target(
    target_yards: float,
    club_distances: dict[str, float],
    cond: ShotConditions,
) -> tuple[float, str, tuple[str, ...]]:
    """Question 2: what does THIS target play like, and with which club?

    Runs the candidate club's flight under the conditions and scales the
    target by (stored / achieved), where "achieved" is TOTAL for woods and
    CARRY for irons/wedges (an approach wants the ball to LAND the number; a
    tee ball wants it to FINISH there). Iterates the club choice once so the
    suggestion reflects the plays-like number, not the raw target.

    Returns (plays_like_yards, suggested_club, assumptions).
    """
    known = {
        c: float(d)
        for c, d in (club_distances or {}).items()
        if c in CLUB_REFERENCE and d and d > 0
    }
    if not known:
        raise ValueError("plays_like_target needs at least one known club distance")

    def nearest_club(yards: float) -> str:
        return min(known, key=lambda c: (abs(known[c] - yards), -known[c]))

    club = nearest_club(target_yards)
    plays_like = float(target_yards)
    result = shot_distance_for_club(club, known[club], cond)
    for _ in range(3):
        result = shot_distance_for_club(club, known[club], cond)
        achieved = result.total_yards if club in WOOD_CLUBS else result.carry_yards
        if achieved <= 0:
            break
        plays_like = target_yards * known[club] / achieved
        nxt = nearest_club(plays_like)
        if nxt == club:
            break
        club = nxt
    basis = "total (carry + roll)" if club in WOOD_CLUBS else "carry"
    assumptions = result.assumptions + (
        f"plays-like solved from your {club}'s flight under these conditions "
        f"({basis} basis)",
    )
    return plays_like, club, assumptions


def conditions_from_weather(
    weather,
    shot_bearing_deg: float,
    elevation_delta_ft: float = 0.0,
    carry_hint_yards: float | None = None,
) -> tuple[ShotConditions, tuple[str, ...]]:
    """Resolve live weather + shot geometry into ShotConditions.

    ``weather`` is duck-typed against app.caddie.types.WeatherConditions
    (temperature_f, humidity, wind_speed_mph, wind_direction, pressure_hpa,
    altitude_ft, conditions) so this module stays import-free. Wind direction
    is meteorological (degrees the wind comes FROM): wind_direction ≈ bearing
    means a headwind. ``carry_hint_yards`` (the expected carry) turns the
    tee-to-target elevation delta into an approximate landing-area grade for
    the roll model; without it the roll is computed on flat ground.
    """
    assumptions: list[str] = []

    pressure = getattr(weather, "pressure_hpa", None)
    altitude_ft = getattr(weather, "altitude_ft", 0.0) or 0.0
    if pressure == _SEA_LEVEL_PRESSURE_HPA and altitude_ft > 500:
        # The model default (exactly 1013.25) alongside a real altitude means
        # no measured surface pressure ever arrived — fall back to barometric
        # altitude rather than silently treating a mile-high course as sea
        # level. A REAL Open-Meteo surface pressure is never exactly 1013.25
        # at altitude (weather.py's no-double-count note).
        pressure = None
        assumptions.append(
            f"no measured surface pressure; estimated from {altitude_ft:.0f} ft altitude"
        )
    rho = air_density_kg_m3(
        getattr(weather, "temperature_f", 70.0),
        getattr(weather, "humidity", 50.0),
        pressure_hpa=pressure,
        altitude_ft=altitude_ft,
    )

    wind_mph = getattr(weather, "wind_speed_mph", 0.0) or 0.0
    wind_dir = getattr(weather, "wind_direction", 0) or 0
    rel = math.radians(wind_dir - shot_bearing_deg)
    head_mps = wind_mph * _MPH_TO_MPS * math.cos(rel)
    cross_mps = wind_mph * _MPH_TO_MPS * math.sin(rel)
    if wind_mph:
        assumptions.append(
            f"steady {wind_mph:.0f} mph wind from {wind_dir:.0f}° (gusts not modeled)"
        )

    grade_pct = 0.0
    if carry_hint_yards and carry_hint_yards > 0 and elevation_delta_ft:
        grade_pct = elevation_delta_ft / (carry_hint_yards * 3.0) * 100.0
        assumptions.append(
            "landing-area slope approximated from the overall elevation change"
        )
    elif elevation_delta_ft:
        assumptions.append(
            "landing-area slope unknown; roll computed on flat ground"
        )

    firmness = getattr(weather, "conditions", "medium")
    if firmness not in _ROLL_FIRMNESS_RETENTION:
        firmness = "medium"

    return (
        ShotConditions(
            rho_kg_m3=rho,
            head_mps=head_mps,
            cross_mps=cross_mps,
            elevation_delta_ft=float(elevation_delta_ft),
            grade_pct=grade_pct,
            firmness=firmness,
        ),
        tuple(assumptions),
    )


class RelativeWind(NamedTuple):
    """Wind decomposed against the SHOT LINE, not raw compass — cycle-2 fix
    (caddie-bench-cycle2-plan.md §2.1). Reuses `conditions_from_weather`'s
    existing relative-angle convention (head_mps/cross_mps above) rather
    than forking a second decomposition; this is the same trig, just also
    surfaced as a spoken phrase for ground truth + degraded-line reuse."""

    speed_mph: float
    head_mph: float  # +into / -helping (speed * cos(rel))
    cross_mph: float  # +from the RIGHT of the shot line (speed * sin(rel))
    bucket: str  # "head" | "tail" | "cross_right" | "cross_left"
    spoken: str  # one phrase, composed here so ground truth + degraded line share it


def relative_wind(weather, shot_bearing_deg: float) -> Optional[RelativeWind]:
    """Decompose ``weather``'s wind against ``shot_bearing_deg`` (the compass
    direction the shot travels). ``None`` when there is no weather or the
    wind is calm (mirrors `club_selection.compute_adjustments`'s own
    `has_weather_effect` wind gate, `wind_speed_mph >= 3` — below that, calm
    says NOTHING new, never a fabricated frame).

    ``wind_direction`` is meteorological (degrees the wind comes FROM) — the
    same convention `conditions_from_weather` uses. ``rel`` is the wind's
    FROM-direction relative to the shot line, normalized to (-180, 180]:
    ``rel == 0`` means the wind blows FROM straight ahead (a headwind).
    Buckets on 45-degree boundaries: |rel| < 45 -> head; |rel| >= 135 -> tail
    (the boundary sample itself, 135, buckets tail — plan §4 edge case 9
    pins this exact choice); otherwise a crosswind, side determined by the
    sign of ``rel`` (positive -> wind is FROM the right of the shot line,
    which pushes the ball left).
    """
    if weather is None:
        return None
    wind_mph = getattr(weather, "wind_speed_mph", 0.0) or 0.0
    if wind_mph < 3:
        return None
    wind_dir = getattr(weather, "wind_direction", 0) or 0

    rel = (wind_dir - shot_bearing_deg) % 360.0
    if rel > 180.0:
        rel -= 360.0

    head_mph = wind_mph * math.cos(math.radians(rel))
    cross_mph = wind_mph * math.sin(math.radians(rel))

    if abs(rel) < 45.0:
        bucket = "head"
        spoken = f"{wind_mph:.0f} mph headwind — into you"
    elif abs(rel) >= 135.0:
        bucket = "tail"
        spoken = f"{wind_mph:.0f} mph tailwind — helping"
    elif rel > 0.0:
        bucket = "cross_right"
        spoken = f"{wind_mph:.0f} mph crosswind off the right — pushes it left"
    else:
        bucket = "cross_left"
        spoken = f"{wind_mph:.0f} mph crosswind off the left — pushes it right"

    return RelativeWind(
        speed_mph=wind_mph, head_mph=head_mph, cross_mph=cross_mph, bucket=bucket, spoken=spoken,
    )


def elevation_only_plays_like(yards: float, elevation_delta_ft: float) -> int:
    """Elevation-only plays-like (the physics replacement for the 1yd/3ft rule).

    Δcarry ≈ Δh / tan(descent angle) for the club that covers the distance —
    a wedge (steep descent) barely notices 20 ft; a driver (shallow) moves a
    lot. Used by course_intel's effective_yards once wired (plan step 9).
    """
    if yards <= 0:
        return int(round(yards))
    ref = CLUB_REFERENCE[
        min(CLUB_REFERENCE, key=lambda c: abs(CLUB_REFERENCE[c].carry_yards - yards))
    ]
    delta_yards = elevation_delta_ft / (3.0 * math.tan(math.radians(ref.descent_deg)))
    return int(round(yards + delta_yards))


# The grounding rule (mirrors hazards.HAZARD_GROUNDING_RULE): the engine is
# ground truth, the model is a writer. Wired into both prompt builders in the
# tool-integration slice (plan steps 6-8).
PHYSICS_GROUNDING_RULE = (
    "Never do distance arithmetic yourself. Any carry, roll, total, plays-like "
    "or club-adjustment number you speak must come verbatim from the shot "
    "physics engine (the get_shot_distance tool / plays_like data) — never "
    "add, subtract, or scale yardages for wind, elevation, temperature, "
    "altitude, or firmness on your own. If the engine's answer is not "
    "available for a shot, say so and speak in general terms instead of "
    "estimating a number."
)
