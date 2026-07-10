"""Unit tests for scripts/tree_spike_geometry.py — pure geometry, no numpy/DB/network.

These run under the app venv (the module is dependency-free) so CI verifies the
committed spike helpers without pulling in numpy/Pillow. See
specs/tree-detection-cv-spike-plan.md.
"""

import os
import sys

import pytest

# scripts/ is not a package; add it to the path.
sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")
)

from tree_spike_geometry import (  # noqa: E402
    carry_yards,
    corridor_bbox,
    latlng_to_tile,
    meters_per_pixel,
    runs_from_bools,
    tile_to_latlng,
)

# Bethpage Black hole 1 (from OSM Overpass).
BETH_TEE = (40.742998, -73.454575)
BETH_GREEN = (40.745071, -73.451351)


def test_tile_roundtrip_returns_to_origin():
    for z in (16, 18, 19):
        xt, yt, px, py = latlng_to_tile(*BETH_TEE, z)
        # reconstruct the fractional tile coord and invert
        lat, lng = tile_to_latlng(xt + px / 256.0, yt + py / 256.0, z)
        assert lat == pytest.approx(BETH_TEE[0], abs=1e-6)
        assert lng == pytest.approx(BETH_TEE[1], abs=1e-6)


def test_pixel_offsets_in_range():
    _, _, px, py = latlng_to_tile(*BETH_GREEN, 18)
    assert 0.0 <= px < 256.0
    assert 0.0 <= py < 256.0


def test_meters_per_pixel_bethpage_z18():
    # Web-Mercator at lat 40.744, z18 ≈ 0.45 m/px; z19 halves it.
    mpp18 = meters_per_pixel(40.744, 18)
    assert mpp18 == pytest.approx(0.452, abs=0.01)
    assert meters_per_pixel(40.744, 19) == pytest.approx(mpp18 / 2.0, rel=1e-6)


def test_corridor_bbox_contains_tee_and_green_with_margin():
    lat_min, lng_min, lat_max, lng_max = corridor_bbox(BETH_TEE, BETH_GREEN, buffer_yd=60)
    for lat, lng in (BETH_TEE, BETH_GREEN):
        assert lat_min < lat < lat_max
        assert lng_min < lng < lng_max
    # buffer is ~60yd ≈ 55m ≈ 0.0005deg lat beyond the tighter tee/green extent
    tight_lat_min = min(BETH_TEE[0], BETH_GREEN[0])
    assert tight_lat_min - lat_min == pytest.approx(60 / 1.09361 / 111_320.0, rel=0.02)


def test_carry_yards_symmetry_and_scale():
    d1 = carry_yards(BETH_TEE, BETH_GREEN)
    d2 = carry_yards(BETH_GREEN, BETH_TEE)
    assert d1 == pytest.approx(d2, rel=1e-9)
    # Black 1 tee->green straight line is ~390 yd.
    assert 370 < d1 < 410


def test_carry_yards_zero_for_same_point():
    assert carry_yards(BETH_TEE, BETH_TEE) == pytest.approx(0.0, abs=1e-6)


def test_runs_from_bools_basic_interval():
    # indices 2..4 True at 1yd step -> (2.0, 4.0)
    samples = [False, False, True, True, True, False]
    assert runs_from_bools(samples, 1.0) == [(2.0, 4.0)]


def test_runs_from_bools_multiple_and_edges():
    samples = [True, True, False, True, False, False, True]
    assert runs_from_bools(samples, 5.0) == [(0.0, 5.0), (15.0, 15.0), (30.0, 30.0)]


def test_runs_from_bools_all_true_and_all_false():
    assert runs_from_bools([True, True, True], 2.0) == [(0.0, 4.0)]
    assert runs_from_bools([False, False], 2.0) == []
    assert runs_from_bools([], 1.0) == []
