"""Non-DB unit tests for the `/session/start` elevation precompute job
(`app.routes.caddie._precompute_course_elevations` + `_feature_center`).

Covers the non-DB half of plan item (d): synth-hole construction skips holes
lacking a tee/green feature and skips holes that already carry persisted
elevation (idempotent), including the zero-sample early return (no
`sample_course_elevations` call at all when nothing is computable).

No network, no database — `courses_mapped.get_course` / `update_green_feature_properties`
and `sample_course_elevations` are all monkeypatched.

Import note
-----------
`app.routes.caddie` transitively imports `app.db.engine` (raises at import
time without DATABASE_URL) and `app.db.models`. We stub DATABASE_URL to a
dummy asyncpg URL (not a real connection — the async engine is lazy), same
pattern as `tests/test_realtime_tools.py`.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://u:p@localhost:5432/x")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

import app.routes.caddie as caddie_routes  # noqa: E402


def _point_feature(feature_type: str, lng: float, lat: float, **extra_props) -> dict:
    return {
        "type": "Feature",
        "properties": {"featureType": feature_type, **extra_props},
        "geometry": {"type": "Point", "coordinates": [lng, lat]},
    }


def _make_course(holes: list[dict]) -> dict:
    return {"id": "course-1", "name": "Fixture Course", "holes": holes}


# ══════════════════════════════════════════════════════════════════════════════
# _feature_center
# ══════════════════════════════════════════════════════════════════════════════


def test_feature_center_point():
    feats = [_point_feature("green", -73.45, 40.71)]
    assert caddie_routes._feature_center(feats, "green") == (-73.45, 40.71)


def test_feature_center_absent_returns_none():
    feats = [_point_feature("tee", -73.45, 40.70)]
    assert caddie_routes._feature_center(feats, "green") is None


def test_feature_center_polygon_uses_ring_centroid():
    ring = [[-73.0, 40.0], [-73.0, 40.001], [-72.999, 40.001], [-72.999, 40.0], [-73.0, 40.0]]
    feats = [{
        "type": "Feature",
        "properties": {"featureType": "green"},
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }]
    center = caddie_routes._feature_center(feats, "green")
    assert center is not None
    lon, lat = center
    assert -73.0 <= lon <= -72.999
    assert 40.0 <= lat <= 40.001


# ══════════════════════════════════════════════════════════════════════════════
# _precompute_course_elevations — synth-hole construction + skip logic
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_precompute_skips_holes_missing_tee_or_green_and_already_persisted(monkeypatch):
    holes = [
        {  # hole 1 — computable: has tee + green, no persisted elevation.
            "number": 1,
            "features": {"type": "FeatureCollection", "features": [
                _point_feature("tee", -73.451, 40.700),
                _point_feature("green", -73.452, 40.710),
            ]},
        },
        {  # hole 2 — already persisted: skip (idempotent).
            "number": 2,
            "features": {"type": "FeatureCollection", "features": [
                _point_feature("tee", -73.461, 40.700),
                _point_feature(
                    "green", -73.462, 40.710,
                    tee_elevation_ft=100.0, green_elevation_ft=110.0,
                ),
            ]},
        },
        {  # hole 3 — no tee feature: cannot sample, skip (absent != zero).
            "number": 3,
            "features": {"type": "FeatureCollection", "features": [
                _point_feature("green", -73.472, 40.710),
            ]},
        },
    ]
    course = _make_course(holes)

    async def fake_get_course(course_id):
        assert course_id == "course-1"
        return course

    sample_calls: list[list[dict]] = []

    async def fake_sample_course_elevations(synth_holes, target_course_name):
        sample_calls.append(synth_holes)
        assert target_course_name == "precompute"
        # Only hole 1 profile succeeds (mirrors sample_course_elevations'
        # "omit holes where either endpoint is None" contract).
        return {1: {
            "tee_elevation_ft": 90.0,
            "green_elevation_ft": 100.0,
            "net_change_ft": 10.0,
            "plays_like_yards": 3.3,
            "green_slope": None,
        }}

    write_calls: list[tuple] = []

    async def fake_update_green_feature_properties(course_id, hole_number, patch):
        write_calls.append((course_id, hole_number, patch))
        return True

    monkeypatch.setattr(caddie_routes.courses_mapped, "get_course", fake_get_course)
    monkeypatch.setattr(caddie_routes, "sample_course_elevations", fake_sample_course_elevations)
    monkeypatch.setattr(
        caddie_routes.courses_mapped,
        "update_green_feature_properties",
        fake_update_green_feature_properties,
    )

    await caddie_routes._precompute_course_elevations("course-1")

    # Only hole 1 was sampled — hole 2 (already persisted) and hole 3 (no tee)
    # were excluded from the batch entirely.
    assert len(sample_calls) == 1
    synth_refs = {f["properties"]["ref"] for f in sample_calls[0]}
    assert synth_refs == {1}

    # Write-back happened for the one computable hole, using _elevation_patch.
    assert write_calls == [(
        "course-1",
        1,
        {
            "tee_elevation_ft": 90.0,
            "green_elevation_ft": 100.0,
            "delta_ft": 10.0,
            "plays_like_yards": 3.3,
        },
    )]


@pytest.mark.asyncio
async def test_precompute_zero_sample_early_return_when_nothing_computable(monkeypatch):
    """All holes already persisted or missing tee/green -> zero USGS calls:
    sample_course_elevations must not be called at all."""
    holes = [
        {  # already persisted
            "number": 1,
            "features": {"type": "FeatureCollection", "features": [
                _point_feature("tee", -73.451, 40.700),
                _point_feature(
                    "green", -73.452, 40.710,
                    tee_elevation_ft=90.0, green_elevation_ft=95.0,
                ),
            ]},
        },
        {  # missing green
            "number": 2,
            "features": {"type": "FeatureCollection", "features": [
                _point_feature("tee", -73.461, 40.700),
            ]},
        },
    ]
    course = _make_course(holes)

    async def fake_get_course(course_id):
        return course

    def fail_sample(*_args, **_kwargs):
        raise AssertionError("sample_course_elevations must not be called")

    def fail_write(*_args, **_kwargs):
        raise AssertionError("update_green_feature_properties must not be called")

    monkeypatch.setattr(caddie_routes.courses_mapped, "get_course", fake_get_course)
    monkeypatch.setattr(caddie_routes, "sample_course_elevations", fail_sample)
    monkeypatch.setattr(caddie_routes.courses_mapped, "update_green_feature_properties", fail_write)

    # Must not raise.
    await caddie_routes._precompute_course_elevations("course-1")


@pytest.mark.asyncio
async def test_precompute_is_resilient_to_get_course_failure(monkeypatch):
    """Best-effort: an exception fetching the course must never propagate
    (the job runs post-response in a BackgroundTask)."""
    async def raise_get_course(course_id):
        raise RuntimeError("db exploded")

    monkeypatch.setattr(caddie_routes.courses_mapped, "get_course", raise_get_course)

    await caddie_routes._precompute_course_elevations("course-1")  # must not raise
