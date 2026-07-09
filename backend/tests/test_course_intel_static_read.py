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

from unittest.mock import AsyncMock  # noqa: E402

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
    # Physics elevation-only plays-like (plan step 9): driver-class 412y,
    # 29.4ft uphill → +13 by descent geometry (was +10 under the 1yd/3ft rule).
    assert intel.effective_yards == 425
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


# ══════════════════════════════════════════════════════════════════════════════
# harden-elevation-writeback-holenumber — write-back key gating
#
# The write-back KEY must be a validated int in 1..36, never the display-only
# `hole_number` (which safely defaults an absent/None holeNumber to 1). These
# drive a genuine live compute (both elevation endpoints real) so the
# write-back branch is actually reached, then assert whether
# `update_green_feature_properties` fires.
# ══════════════════════════════════════════════════════════════════════════════


def _mock_live_compute(monkeypatch):
    """tee then green resolve to real, distinct elevations; no slope data —
    isolates the write-back gate from unrelated elevation/slope computation."""
    fetch = AsyncMock(side_effect=[90.0, 100.0])
    slope = AsyncMock(return_value=None)
    monkeypatch.setattr(course_intel, "fetch_elevation_cached", fetch)
    monkeypatch.setattr(course_intel, "compute_green_slope", slope)


def _hole_coords(hole_number_kwargs: dict) -> dict:
    return {
        **hole_number_kwargs,
        "tee": {"lat": 40.70, "lng": -73.45},
        "green": {"lat": 40.71, "lng": -73.46},
    }


@pytest.mark.asyncio
async def test_writeback_skipped_when_holenumber_absent(monkeypatch):
    _mock_live_compute(monkeypatch)
    write_mock = AsyncMock(return_value=True)
    monkeypatch.setattr(courses_mapped, "update_green_feature_properties", write_mock)

    intel = await course_intel.build_hole_intelligence(
        hole_coords=_hole_coords({}),  # no holeNumber key at all
        yards=350,
        persisted_elevation=None,
        course_id="course-1",
    )

    write_mock.assert_not_called()
    assert intel.hole_number == 1  # display default preserved, intel not dropped


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", ["3", 3.0, None, 0, -1, 9999, True, False])
async def test_writeback_skipped_for_malformed_holenumber(monkeypatch, bad):
    _mock_live_compute(monkeypatch)
    write_mock = AsyncMock(return_value=True)
    monkeypatch.setattr(courses_mapped, "update_green_feature_properties", write_mock)

    intel = await course_intel.build_hole_intelligence(
        hole_coords=_hole_coords({"holeNumber": bad}),
        yards=350,
        persisted_elevation=None,
        course_id="course-1",
    )

    write_mock.assert_not_called()
    assert intel.hole_number is not None  # display value still populated, intel not dropped


@pytest.mark.asyncio
@pytest.mark.parametrize("good", [1, 18, 36])
async def test_writeback_proceeds_for_valid_holenumber(monkeypatch, good):
    _mock_live_compute(monkeypatch)
    write_mock = AsyncMock(return_value=True)
    monkeypatch.setattr(courses_mapped, "update_green_feature_properties", write_mock)

    intel = await course_intel.build_hole_intelligence(
        hole_coords=_hole_coords({"holeNumber": good}),
        yards=350,
        persisted_elevation=None,
        course_id="course-1",
    )

    write_mock.assert_awaited_once()
    args = write_mock.await_args.args
    assert args[0] == "course-1"
    assert args[1] == good
    patch = args[2]
    assert patch["tee_elevation_ft"] == 90.0
    assert patch["green_elevation_ft"] == 100.0
    assert patch["delta_ft"] == 10.0
    assert intel.hole_number == good


# ══════════════════════════════════════════════════════════════════════════════
# `courses_mapped._valid_hole_number` — the single source of truth for the bound
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("value", [1, 2, 17, 18, 35, 36])
def test_valid_hole_number_accepts_1_to_36(value):
    assert courses_mapped._valid_hole_number(value) is True


@pytest.mark.parametrize(
    "value", ["3", 3.0, None, 0, -1, 9999, 37, True, False]
)
def test_valid_hole_number_rejects_malformed_and_out_of_range(value):
    assert courses_mapped._valid_hole_number(value) is False


# ══════════════════════════════════════════════════════════════════════════════
# `update_green_feature_properties` defense-in-depth — invalid key returns
# False WITHOUT ever opening a DB session (no SQL executed).
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", ["3", 3.0, None, 0, -1, 9999, True, False])
async def test_update_green_feature_returns_false_on_invalid_hole_number(monkeypatch, bad):
    session_factory = MagicMock()
    monkeypatch.setattr(courses_mapped, "async_session", session_factory)

    result = await courses_mapped.update_green_feature_properties(
        "course-1", bad, {"tee_elevation_ft": 1.0}
    )

    assert result is False
    session_factory.assert_not_called()  # early return — no DB session, no SQL


# ══════════════════════════════════════════════════════════════════════════════
# caddie-hole-strategy-guides Slice 1 — `persisted_guide` read-through
#
# No writer runs yet in Slice 1, so `persisted_guide` is normally None; these
# tests seed it directly to exercise the read-through contract end-to-end
# ahead of any writer landing.
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_persisted_guide_populates_strategy_guide(monkeypatch):
    monkeypatch.setattr(course_intel, "fetch_elevation_cached", _fail)
    monkeypatch.setattr(course_intel, "compute_green_slope", _fail)

    seeded_guide = {
        "play_line": "Favor the left side off the tee.",
        "miss_side": "Bail out short-right.",
        "green_notes": "Green runs back-to-front.",
        "common_mistakes": ["Overclubbing the approach"],
        "sources": ["https://example.com/hole-7"],
        "generated_at": "2026-07-08T00:00:00Z",
        "model": "claude-sonnet-5",
        "schema_version": 1,
    }
    persisted_elevation = {"tee_elevation_ft": 90.0, "green_elevation_ft": 100.0}

    intel = await course_intel.build_hole_intelligence(
        hole_coords={
            "holeNumber": 7,
            "tee": {"lat": 40.70, "lng": -73.45},
            "green": {"lat": 40.71, "lng": -73.46},
        },
        par=4,
        yards=410,
        persisted_elevation=persisted_elevation,
        persisted_guide=seeded_guide,
    )

    assert intel.strategy_guide is not None
    assert intel.strategy_guide.play_line == "Favor the left side off the tee."
    assert intel.strategy_guide.common_mistakes == ["Overclubbing the approach"]
    assert intel.strategy_guide.schema_version == 1


@pytest.mark.asyncio
async def test_persisted_guide_none_yields_strategy_guide_none(monkeypatch):
    monkeypatch.setattr(course_intel, "fetch_elevation_cached", _fail)
    monkeypatch.setattr(course_intel, "compute_green_slope", _fail)

    intel = await course_intel.build_hole_intelligence(
        hole_coords={
            "holeNumber": 8,
            "tee": {"lat": 40.70, "lng": -73.45},
            "green": {"lat": 40.71, "lng": -73.46},
        },
        par=4,
        yards=410,
        persisted_elevation={"tee_elevation_ft": 90.0, "green_elevation_ft": 100.0},
        persisted_guide=None,
    )

    assert intel.strategy_guide is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "malformed",
    [
        {"schema_version": "oops"},  # wrong type for an int field
        "not-a-dict",
        123,
        ["also", "not", "a", "dict"],
    ],
)
async def test_persisted_guide_malformed_never_raises_yields_none(monkeypatch, malformed):
    monkeypatch.setattr(course_intel, "fetch_elevation_cached", _fail)
    monkeypatch.setattr(course_intel, "compute_green_slope", _fail)

    intel = await course_intel.build_hole_intelligence(
        hole_coords={
            "holeNumber": 9,
            "tee": {"lat": 40.70, "lng": -73.45},
            "green": {"lat": 40.71, "lng": -73.46},
        },
        par=4,
        yards=410,
        persisted_elevation={"tee_elevation_ft": 90.0, "green_elevation_ft": 100.0},
        persisted_guide=malformed,
    )

    assert intel.strategy_guide is None
