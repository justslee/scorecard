"""Unit tests for app/caddie/physics.py — the ball-flight physics engine.

Pure module: no network, no database, no env. Bands come from
specs/caddie-shot-physics-engine-plan.md; the headline case is THE INCIDENT
(owner escalation 2026-07-09): a 300-yard driver with a 4 mph tailwind and
38 ft downhill must total 315-330 — NOT the ~390 the caddie told the owner.

The calibration test PINS the aero constants: CLUB_REFERENCE is ground truth
(carry ±4 y, descent ±3° per row). Never widen these bands to make a change
pass — retune the constants or document why the band is unreachable.
"""

import pytest

from app.caddie.club_selection import DEFAULT_CLUB_DISTANCES
from app.caddie.physics import (
    CLUB_REFERENCE,
    NEUTRAL_CONDITIONS,
    PHYSICS_GROUNDING_RULE,
    RHO_NEUTRAL,
    WOOD_CLUBS,
    FlightSample,
    LaunchConditions,
    ShotConditions,
    air_density_kg_m3,
    club_class,
    conditions_from_weather,
    elevation_only_plays_like,
    fit_launch_to_carry,
    integrate_flight,
    neutral_carry_from_stored,
    plays_like_target,
    roll_out,
    shot_distance_for_club,
)

_MPH_TO_MPS = 0.44704
_M_PER_FT = 0.3048


class _Weather:
    """Duck-typed stand-in for app.caddie.types.WeatherConditions."""

    def __init__(self, **kw):
        self.temperature_f = 70.0
        self.humidity = 50.0
        self.wind_speed_mph = 0.0
        self.wind_direction = 0
        self.pressure_hpa = 1013.25
        self.altitude_ft = 0.0
        self.conditions = "medium"
        for k, v in kw.items():
            setattr(self, k, v)


def _driver_launch(carry: float = 275.0) -> LaunchConditions:
    return fit_launch_to_carry("driver", carry)


# ── Step 1: atmosphere ────────────────────────────────────────────────────────


def test_rho_neutral_matches_standard_conditions():
    assert air_density_kg_m3(70.0, 50.0, 1013.25) == pytest.approx(RHO_NEUTRAL, abs=0.001)


def test_density_denver_surface_pressure_is_thinner():
    # Denver-ish surface pressure (~840 hPa at 5,280 ft) → much thinner air.
    rho = air_density_kg_m3(70.0, 50.0, 840.0, altitude_ft=5280.0)
    assert rho < 1.02


def test_density_cold_dry_is_denser():
    assert air_density_kg_m3(40.0, 20.0, 1013.25) > RHO_NEUTRAL


def test_density_hot_humid_is_thinner():
    assert air_density_kg_m3(95.0, 90.0, 1013.25) < RHO_NEUTRAL


def test_density_humidity_thins_air_at_same_pressure():
    # Magnus treatment: moist air is LESS dense than dry at equal P and T.
    humid = air_density_kg_m3(90.0, 90.0, 1013.25)
    dry = air_density_kg_m3(90.0, 10.0, 1013.25)
    assert humid < dry


def test_density_pressure_given_ignores_altitude_no_double_count():
    # Mirrors weather.py's trap: surface pressure ALREADY encodes altitude.
    a = air_density_kg_m3(70.0, 50.0, 900.0, altitude_ft=0.0)
    b = air_density_kg_m3(70.0, 50.0, 900.0, altitude_ft=4000.0)
    assert a == b


def test_density_barometric_fallback_when_pressure_missing():
    denver = air_density_kg_m3(70.0, 50.0, None, altitude_ft=5280.0)
    sea = air_density_kg_m3(70.0, 50.0, None, altitude_ft=0.0)
    assert sea == pytest.approx(RHO_NEUTRAL, abs=0.001)
    assert 0.95 < denver < 1.01


# ── Step 1: integrator core ───────────────────────────────────────────────────


def test_flight_is_deterministic():
    launch = _driver_launch()
    a = integrate_flight(launch, RHO_NEUTRAL, head_mps=2.0, cross_mps=1.0)
    b = integrate_flight(launch, RHO_NEUTRAL, head_mps=2.0, cross_mps=1.0)
    assert a == b  # identical inputs → identical FlightSample, bit for bit


def test_flight_terminates_on_flat_plane_with_sane_shape():
    f = integrate_flight(_driver_launch(), RHO_NEUTRAL)
    assert 0.0 < f.flight_time_s < 20.0
    assert f.carry_yards > 200.0
    assert f.apex_ft > 50.0
    assert 20.0 < f.descent_deg < 60.0
    assert f.landing_speed_mps > 10.0
    assert abs(f.lateral_yards) < 0.5  # still air: no drift


def test_downhill_plane_carries_farther_uphill_shorter():
    launch = _driver_launch()
    flat = integrate_flight(launch, RHO_NEUTRAL, landing_delta_m=0.0)
    down = integrate_flight(launch, RHO_NEUTRAL, landing_delta_m=-38.0 * _M_PER_FT)
    up = integrate_flight(launch, RHO_NEUTRAL, landing_delta_m=38.0 * _M_PER_FT)
    assert down.carry_yards > flat.carry_yards > up.carry_yards
    # The downhill gain is descent-geometry sized (Δh/tanγ ≈ 10-20 y for a
    # driver), nothing like the naive 1yd/3ft applied to a pin.
    assert 5.0 < down.carry_yards - flat.carry_yards < 25.0


def test_landing_plane_above_apex_terminates_finitely():
    # A wedge into a plane above its apex: honest short-of-the-plane result.
    launch = fit_launch_to_carry("sw", 100.0)
    apex_ft = integrate_flight(launch, RHO_NEUTRAL).apex_ft
    f = integrate_flight(launch, RHO_NEUTRAL, landing_delta_m=(apex_ft + 20.0) * _M_PER_FT)
    assert f.flight_time_s < 20.0
    assert 0.0 < f.carry_yards < 100.0


def test_carry_monotone_decreasing_in_headwind():
    launch = _driver_launch()
    carries = [
        integrate_flight(launch, RHO_NEUTRAL, head_mps=h).carry_yards
        for h in (-4.0, -2.0, 0.0, 2.0, 4.0, 8.0)
    ]
    assert carries == sorted(carries, reverse=True)


def test_carry_monotone_increasing_as_air_thins():
    launch = _driver_launch()
    carries = [
        integrate_flight(launch, rho).carry_yards for rho in (1.30, 1.20, 1.10, 1.00)
    ]
    assert carries == sorted(carries)


def test_crosswind_drifts_ball_downwind():
    launch = _driver_launch()
    f = integrate_flight(launch, RHO_NEUTRAL, cross_mps=5.0)
    assert f.lateral_yards > 3.0  # +cross blows toward +y → +lateral


# ── Step 2: CLUB_REFERENCE calibration (PINS the aero constants) ──────────────


@pytest.mark.parametrize("club", sorted(CLUB_REFERENCE))
def test_club_reference_calibration(club):
    """Each reference row must integrate to its own carry ±4 y / descent ±3°."""
    ref = CLUB_REFERENCE[club]
    f = integrate_flight(
        LaunchConditions(ref.ball_speed_mph * _MPH_TO_MPS, ref.launch_deg, ref.spin_rpm),
        RHO_NEUTRAL,
    )
    assert f.carry_yards == pytest.approx(ref.carry_yards, abs=4.0), (
        f"{club}: integrated carry {f.carry_yards:.1f} vs reference {ref.carry_yards}"
    )
    assert f.descent_deg == pytest.approx(ref.descent_deg, abs=3.0), (
        f"{club}: integrated descent {f.descent_deg:.1f} vs reference {ref.descent_deg}"
    )


def test_club_reference_covers_all_app_club_keys():
    # The engine must answer for every club key the app stores distances under.
    assert set(DEFAULT_CLUB_DISTANCES) <= set(CLUB_REFERENCE)


# ── Step 3: reverse fit to the player's stored distances ──────────────────────


def test_neutral_carry_from_stored_woods_back_out_roll():
    carry, assumption = neutral_carry_from_stored("driver", 300.0)
    assert carry == pytest.approx(300.0 * (1.0 - CLUB_REFERENCE["driver"].roll_frac))
    assert carry == pytest.approx(277.0, abs=1.0)  # the plan's worked case
    assert "TOTAL" in assumption


def test_neutral_carry_from_stored_irons_are_carry():
    carry, assumption = neutral_carry_from_stored("7iron", 160.0)
    assert carry == 160.0
    assert "CARRY" in assumption


def test_unknown_club_raises():
    with pytest.raises(ValueError, match="unknown club"):
        neutral_carry_from_stored("2iron", 210.0)


@pytest.mark.parametrize("stored", [120.0, 180.0, 250.0, 300.0, 350.0])
def test_fit_converges_across_driver_range(stored):
    carry, _ = neutral_carry_from_stored("driver", stored)
    launch = fit_launch_to_carry("driver", carry)
    f = integrate_flight(launch, RHO_NEUTRAL)
    # solve tolerance 0.1 y + 0.1 y cache-key rounding
    assert f.carry_yards == pytest.approx(carry, abs=0.2)


@pytest.mark.parametrize("stored", [60.0, 100.0, 160.0, 220.0])
def test_fit_converges_across_iron_range(stored):
    launch = fit_launch_to_carry("7iron", stored)
    f = integrate_flight(launch, RHO_NEUTRAL)
    assert f.carry_yards == pytest.approx(stored, abs=0.2)


def test_round_trip_driver_300_total():
    """stored 300 → back out carry → fit → fly + roll → ≈300 again (±2)."""
    result = shot_distance_for_club("driver", 300.0, NEUTRAL_CONDITIONS)
    assert result.total_yards == pytest.approx(300.0, abs=2.0)


# ── Step 4: roll model (plan §5 calibration targets) ──────────────────────────


def test_driver_neutral_roll_band():
    r = shot_distance_for_club("driver", 300.0, NEUTRAL_CONDITIONS)
    assert 20.0 <= r.roll_yards <= 24.0


def test_seven_iron_neutral_roll_band():
    r = shot_distance_for_club("7iron", 160.0, NEUTRAL_CONDITIONS)
    assert 3.0 <= r.roll_yards <= 6.0


@pytest.mark.parametrize("club,stored", [("pw", 130.0), ("gw", 115.0), ("sw", 100.0), ("lw", 85.0)])
def test_wedge_neutral_roll_band(club, stored):
    r = shot_distance_for_club(club, stored, NEUTRAL_CONDITIONS)
    assert 0.0 <= r.roll_yards <= 3.0


def test_firmness_sweep_driver():
    medium = shot_distance_for_club("driver", 300.0, ShotConditions(firmness="medium"))
    firm = shot_distance_for_club("driver", 300.0, ShotConditions(firmness="firm"))
    soft = shot_distance_for_club("driver", 300.0, ShotConditions(firmness="soft"))
    assert firm.roll_yards >= medium.roll_yards + 6.0
    assert soft.roll_yards <= medium.roll_yards - 8.0
    # carry is untouched by firmness — only the roll moves
    assert firm.carry_yards == pytest.approx(medium.carry_yards)


def test_strong_headwind_kills_driver_roll():
    neutral = shot_distance_for_club("driver", 300.0, NEUTRAL_CONDITIONS)
    head = shot_distance_for_club(
        "driver", 300.0, ShotConditions(head_mps=20.0 * _MPH_TO_MPS)
    )
    assert head.roll_yards < 0.6 * neutral.roll_yards


def test_downslope_adds_roll_upslope_removes_it():
    flight = FlightSample(
        carry_yards=275.0,
        apex_ft=100.0,
        flight_time_s=7.0,
        descent_deg=40.0,
        landing_speed_mps=27.0,
        lateral_yards=0.0,
    )
    flat = roll_out(flight, grade_pct=0.0, firmness="medium", club_cls="wood")
    down = roll_out(flight, grade_pct=-5.0, firmness="medium", club_cls="wood")
    up = roll_out(flight, grade_pct=5.0, firmness="medium", club_cls="wood")
    assert down > flat > up


def test_club_class_mapping():
    assert club_class("driver") == "wood"
    assert club_class("hybrid") == "wood"
    assert club_class("7iron") == "iron"
    assert club_class("sw") == "wedge"


# ── Step 5: the two questions + THE INCIDENT ──────────────────────────────────


def _incident_conditions():
    """300y driver, 4 mph tailwind, 38 ft downhill (the owner's screenshot)."""
    weather = _Weather(wind_speed_mph=4.0, wind_direction=180)  # from behind
    return conditions_from_weather(
        weather, shot_bearing_deg=0.0, elevation_delta_ft=-38.0, carry_hint_yards=300.0
    )


def test_the_incident_driver_total_is_sane_not_390():
    """Plan table row 2 — the eval-teeth case this whole engine exists for."""
    cond, cond_assumptions = _incident_conditions()
    assert cond.head_mps < 0.0  # tailwind
    result = shot_distance_for_club("driver", 300.0, cond)
    assert 292.0 <= result.carry_yards <= 305.0
    assert 24.0 <= result.roll_yards <= 34.0
    assert 315.0 <= result.total_yards <= 330.0
    # The hard line: whatever recalibration ever happens, 390 stays dead.
    assert result.total_yards < 340.0
    assert result.assumptions  # every simplification is surfaced
    assert any("TOTAL" in a for a in result.assumptions)
    assert cond_assumptions


def test_the_incident_390_pin_plays_shorter_not_longer():
    """Failure A's other half: the 390 PIN plays ~358-365 — SHORTER, opposite
    sign of the caddie's 'plays about 392'."""
    cond, _ = _incident_conditions()
    distances = dict(DEFAULT_CLUB_DISTANCES)
    distances["driver"] = 300
    plays_like, club, assumptions = plays_like_target(390.0, distances, cond)
    assert plays_like < 390.0
    assert 350.0 <= plays_like <= 368.0
    assert club == "driver"
    assert assumptions


def test_plays_like_150_into_10mph_headwind():
    """Plan table row 3: a 150 target into 10 mph plays ~160-170."""
    weather = _Weather(wind_speed_mph=10.0, wind_direction=0)  # dead into
    cond, _ = conditions_from_weather(weather, shot_bearing_deg=0.0)
    plays_like, club, _ = plays_like_target(150.0, DEFAULT_CLUB_DISTANCES, cond)
    assert 160.0 <= plays_like <= 170.0
    assert club in {"6iron", "7iron"}


def test_plays_like_wedge_uphill_20ft():
    """Plan table row 4: 100 y, 20 ft up: steep wedge descent barely moves it."""
    weather = _Weather()
    cond, _ = conditions_from_weather(
        weather, shot_bearing_deg=0.0, elevation_delta_ft=20.0, carry_hint_yards=100.0
    )
    plays_like, club, _ = plays_like_target(100.0, DEFAULT_CLUB_DISTANCES, cond)
    assert 105.0 <= plays_like <= 110.0
    roll = shot_distance_for_club(club, DEFAULT_CLUB_DISTANCES[club], cond).roll_yards
    assert 0.0 <= roll <= 3.0


def test_denver_altitude_adds_realistic_carry():
    """Plan table row 5: 5,280 ft adds ~4-11 y to a 7-iron, not 2%/1000ft."""
    weather = _Weather(pressure_hpa=840.0, altitude_ft=5280.0)
    cond, _ = conditions_from_weather(weather, shot_bearing_deg=0.0)
    result = shot_distance_for_club("7iron", 160.0, cond)
    assert 4.0 <= result.carry_yards - 160.0 <= 11.0


def test_temperature_spread_40f_vs_90f():
    """Plan table row 7: 40°F → 90°F is worth ~3-9 y on a 7-iron."""
    cold, _ = conditions_from_weather(_Weather(temperature_f=40.0), 0.0)
    hot, _ = conditions_from_weather(_Weather(temperature_f=90.0), 0.0)
    spread = (
        shot_distance_for_club("7iron", 160.0, hot).carry_yards
        - shot_distance_for_club("7iron", 160.0, cold).carry_yards
    )
    assert 3.0 <= spread <= 9.0


def test_conditions_from_weather_wind_components():
    # Wind FROM 90° on a due-north (0°) shot = pure left-to-right cross.
    cond, _ = conditions_from_weather(_Weather(wind_speed_mph=10.0, wind_direction=90), 0.0)
    assert cond.head_mps == pytest.approx(0.0, abs=1e-9)
    assert cond.cross_mps == pytest.approx(10.0 * _MPH_TO_MPS)
    # Wind FROM the shot bearing = headwind (meteorological convention).
    cond, _ = conditions_from_weather(_Weather(wind_speed_mph=10.0, wind_direction=45), 45.0)
    assert cond.head_mps == pytest.approx(10.0 * _MPH_TO_MPS)


def test_conditions_from_weather_defaulted_pressure_at_altitude():
    # A literal model-default 1013.25 hPa alongside a real altitude means no
    # measured pressure arrived — fall back to barometric, and say so.
    weather = _Weather(pressure_hpa=1013.25, altitude_ft=5280.0)
    cond, assumptions = conditions_from_weather(weather, 0.0)
    assert cond.rho_kg_m3 < RHO_NEUTRAL - 0.1
    assert any("pressure" in a for a in assumptions)


def test_conditions_from_weather_grade_needs_carry_hint():
    with_hint, _ = conditions_from_weather(_Weather(), 0.0, -38.0, carry_hint_yards=300.0)
    without, assumptions = conditions_from_weather(_Weather(), 0.0, -38.0)
    assert with_hint.grade_pct == pytest.approx(-38.0 / 900.0 * 100.0)
    assert without.grade_pct == 0.0
    assert any("slope unknown" in a for a in assumptions)


def test_plays_like_requires_a_club():
    with pytest.raises(ValueError):
        plays_like_target(150.0, {}, NEUTRAL_CONDITIONS)


def test_elevation_only_plays_like_is_club_aware():
    # Downhill shortens; uphill lengthens.
    assert elevation_only_plays_like(390, -38.0) < 390
    assert elevation_only_plays_like(150, 30.0) > 150
    # A shallow-descending driver distance moves MORE per foot than a steep
    # wedge distance — the whole point vs the flat 1yd/3ft rule.
    driver_shift = elevation_only_plays_like(275, 30.0) - 275
    wedge_shift = elevation_only_plays_like(100, 30.0) - 100
    assert driver_shift > wedge_shift
    # Physics says LESS than the naive 1 yd / 3 ft for steep-landing clubs.
    assert wedge_shift < 10.0


def test_physics_grounding_rule_forbids_model_arithmetic():
    assert "Never do distance arithmetic" in PHYSICS_GROUNDING_RULE
    assert "verbatim" in PHYSICS_GROUNDING_RULE


def test_shot_result_is_frozen_and_assumption_rich():
    result = shot_distance_for_club("driver", 300.0, NEUTRAL_CONDITIONS)
    with pytest.raises(Exception):
        result.total_yards = 390.0  # frozen dataclass
    assert len(result.assumptions) >= 2


def test_wood_clubs_match_club_selection_keys():
    assert WOOD_CLUBS <= set(DEFAULT_CLUB_DISTANCES)
