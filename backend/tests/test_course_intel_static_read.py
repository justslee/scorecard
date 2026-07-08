"""Unit tests for course-intel static (persisted) elevation read-first path.

No network, no database. Covers plan cases (a) and (c):

(a) A persisted-elevation cache HIT (`tee_elevation_ft` + `green_elevation_ft`
    both present) must skip `fetch_elevation_cached` / `compute_green_slope`
    entirely (ZERO USGS/3DEP calls) and build the returned intel straight
    from the persisted values.
(c) "Absent != zero": when a live compute produces a None for either
    endpoint, `update_green_feature_properties` must NOT be called — no
    write ever persists a fabricated 0/None. `_elevation_patch` must omit
    `green_slope` when the profile's `green_slope` is None.

Import note
-----------
``course_intel.py`` now imports ``app.services.courses_mapped``, which
transitively imports ``app.db.engine`` — that module raises ``RuntimeError``
at import time when ``DATABASE_URL`` is not configured. We stub the entire
``app.db`` namespace in ``sys.modules`` before importing any app code, same
pattern as ``tests/test_hole_elevation_ingest.py`` / ``test_elevation_profile.py``.
"""

from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock

# ── DB stub ──────────────────────────────────────────────────────────────────
if not os.getenv("DATABASE_URL"):
    for _m in ("app.db.engine", "app.db.models", "app.db"):
        sys.modules.setdefault(_m, MagicMock())
# ─────────────────────────────────────────────────────────────────────────────

import pytest  # noqa: E402

from app.caddie import course_intel  # noqa: E402
from app.services import courses_mapped  # noqa: E402
from app.services import elevation as elevation_mod  # noqa: E402


def _fail(*_args, **_kwargs):
    raise AssertionError("must not be called on a persisted cache hit")


# ══════════════════════════════════════════════════════════════════════════════
# (a) Persisted cache HIT — zero USGS/3DEP calls
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_persisted_hit_skips_all_elevation_calls(monkeypatch):
    async def fail_elev(lat, lng):
        raise AssertionError("fetch_elevation_cached must not be called on a cache hit")

    async def fail_slope(green):
        raise AssertionError("compute_green_slope must not be called on a cache hit")

    async def fail_3dep(*args, **kwargs):
        raise AssertionError("fetch_3dep_samples must not be called on a cache hit")

    monkeypatch.setattr(course_intel, "fetch_elevation_cached", fail_elev)
    monkeypatch.setattr(course_intel, "compute_green_slope", fail_slope)
    monkeypatch.setattr(elevation_mod, "fetch_3dep_samples", fail_3dep)

    persisted = {
        "featureType": "green",
        "tee_elevation_ft": 96.0,
        "green_elevation_ft": 125.4,
        "delta_ft": 29.4,
        "plays_like_yards": 9.8,
        "green_slope": {
            "direction": 180.0,
            "severity": "moderate",
            "percent_grade": 3.2,
            "description": "Green slopes moderately toward the south",
        },
    }

    intel = await course_intel.build_hole_intelligence(
        hole_coords={
            "holeNumber": 1,
            "tee": {"lat": 40.7458939, "lng": -73.4507039},
            "green": {"lat": 40.7496381, "lng": -73.4520769},
        },
        par=4,
        yards=412,
        handicap_rating=7,
        persisted_elevation=persisted,
        course_id="some-course-id",  # must not trigger a write-back either
    )

    assert intel.elevation_change_ft == 29.4
    assert intel.effective_yards == 412 + round(29.4 / 3)
    assert intel.green_slope is not None
    assert intel.green_slope.direction == 180.0
    assert intel.green_slope.severity == "moderate"
    assert intel.green_slope.percent_grade == 3.2
    assert intel.green_slope.description == "Green slopes moderately toward the south"


@pytest.mark.asyncio
async def test_persisted_hit_falls_back_to_green_minus_tee_when_delta_absent(monkeypatch):
    """delta_ft missing (older/partial blob) but both elevations present ->
    still a cache hit, computed as green - tee, zero network calls."""
    monkeypatch.setattr(course_intel, "fetch_elevation_cached", _fail)
    monkeypatch.setattr(course_intel, "compute_green_slope", _fail)

    persisted = {"tee_elevation_ft": 100.0, "green_elevation_ft": 90.0}

    intel = await course_intel.build_hole_intelligence(
        hole_coords={
            "holeNumber": 2,
            "tee": {"lat": 40.7, "lng": -73.45},
            "green": {"lat": 40.71, "lng": -73.46},
        },
        yards=300,
        persisted_elevation=persisted,
    )
    assert intel.elevation_change_ft == -10.0
    assert intel.green_slope is None


# ══════════════════════════════════════════════════════════════════════════════
# (c) Absent != zero — no write on a partial live compute; _elevation_patch
# omits green_slope when None
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_live_compute_partial_elevation_never_writes_back(monkeypatch):
    async def fake_elev(lat, lng):
        # Tee resolves; green does not (simulates a USGS miss on one endpoint).
        return 100.0 if lat < 40.705 else None

    async def fake_slope(green):
        return None

    def fail_write(*_args, **_kwargs):
        raise AssertionError("update_green_feature_properties must not be called")

    monkeypatch.setattr(course_intel, "fetch_elevation_cached", fake_elev)
    monkeypatch.setattr(course_intel, "compute_green_slope", fake_slope)
    monkeypatch.setattr(courses_mapped, "update_green_feature_properties", fail_write)

    intel = await course_intel.build_hole_intelligence(
        hole_coords={
            "holeNumber": 3,
            "tee": {"lat": 40.70, "lng": -73.45},
            "green": {"lat": 40.71, "lng": -73.46},
        },
        yards=350,
        persisted_elevation=None,
        course_id="some-course-id",
    )
    # No real elevation change was computed (green endpoint missing) -> stays honest 0.0.
    assert intel.elevation_change_ft == 0.0


def test_elevation_patch_omits_green_slope_when_none():
    profile = {
        "tee_elevation_ft": 96.0,
        "green_elevation_ft": 125.4,
        "net_change_ft": 29.4,
        "plays_like_yards": 9.8,
        "green_slope": None,
    }
    patch = courses_mapped._elevation_patch(profile)
    assert "green_slope" not in patch
    assert patch["delta_ft"] == 29.4
    assert patch["tee_elevation_ft"] == 96.0
    assert patch["green_elevation_ft"] == 125.4
    assert patch["plays_like_yards"] == 9.8


def test_elevation_patch_includes_green_slope_when_present():
    slope = {
        "direction": 90.0,
        "severity": "mild",
        "percent_grade": 1.5,
        "description": "Green slopes mildly toward the east",
    }
    profile = {
        "tee_elevation_ft": 50.0,
        "green_elevation_ft": 55.0,
        "net_change_ft": 5.0,
        "plays_like_yards": 1.7,
        "green_slope": slope,
    }
    patch = courses_mapped._elevation_patch(profile)
    assert patch["green_slope"] == slope
