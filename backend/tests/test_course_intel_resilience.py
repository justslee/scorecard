"""Hazard classification must never sink a hole's intel (2026-07-07: a
malformed OSM feature threw per-hole, discarding computed elevation — every
tile showed '+0ft')."""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

import pytest  # noqa: E402

from app.caddie import course_intel  # noqa: E402


@pytest.mark.asyncio
async def test_malformed_osm_features_keep_elevation(monkeypatch):
    async def fake_elev(lat, lng):
        # tee 96ft, green 125ft — the real Bethpage hole-1 shape
        return 96.0 if lat < 40.746 else 125.4

    async def fake_slope(green):
        return None

    monkeypatch.setattr(course_intel, "fetch_elevation_cached", fake_elev)
    monkeypatch.setattr(course_intel, "compute_green_slope", fake_slope)

    # Malformed bunker: center present but missing lat/lng keys → the old code
    # raised inside classification and the route discarded the whole hole.
    bad_osm = {"bunkers": [{"center": {"x": 1}}], "water": []}

    intel = await course_intel.build_hole_intelligence(
        hole_coords={
            "holeNumber": 1,
            "tee": {"lat": 40.7458939, "lng": -73.4507039},
            "green": {"lat": 40.7496381, "lng": -73.4520769},
        },
        par=4,
        yards=412,
        handicap_rating=7,
        osm_features=bad_osm,
    )

    assert intel.elevation_change_ft == pytest.approx(29.4, abs=0.1)
    assert intel.effective_yards == 422
    assert intel.hazards == []  # dropped defensively, never fatal
