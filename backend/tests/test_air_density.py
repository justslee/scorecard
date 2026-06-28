"""Tests for compute_air_density_factor — the 'plays-like' air-density multiplier.

<1.0 = thinner air (ball flies farther): high altitude / hot / humid.
>1.0 = denser air (ball flies shorter): cold / dry / high pressure.
Altitude enters via the surface pressure the caller passes (Open-Meteo
surface_pressure is already altitude-adjusted) — see weather.py note.
"""

from app.services.weather import (
    STANDARD_PRESSURE_HPA,
    STANDARD_TEMP_F,
    compute_air_density_factor,
)


def _factor(temp_f, humidity, pressure, altitude_ft=0.0):
    return compute_air_density_factor(temp_f, humidity, pressure, altitude_ft)


def test_standard_conditions_are_near_unity():
    f = _factor(STANDARD_TEMP_F, 50.0, STANDARD_PRESSURE_HPA)
    assert abs(f - 1.0) < 0.01


def test_high_altitude_surface_pressure_is_thinner():
    # Denver-ish: ~5,280 ft → surface pressure ~840 hPa. Thinner air → <1.
    f = _factor(70.0, 50.0, 840.0, altitude_ft=5280.0)
    assert f < 0.9


def test_cold_dry_high_pressure_is_denser():
    f = _factor(40.0, 20.0, 1030.0)
    assert f > 1.0


def test_hot_humid_is_thinner_than_standard():
    f = _factor(95.0, 90.0, STANDARD_PRESSURE_HPA)
    assert f < 1.0


def test_pressure_dominates_altitude_param_no_double_count():
    # Same (already-altitude-adjusted) pressure → same factor regardless of the
    # altitude_ft hint: altitude must NOT be re-applied on top of surface pressure.
    a = _factor(70.0, 50.0, 900.0, altitude_ft=0.0)
    b = _factor(70.0, 50.0, 900.0, altitude_ft=4000.0)
    assert a == b
