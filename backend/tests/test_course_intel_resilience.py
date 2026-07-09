"""Hazard classification must never sink a hole's intel (2026-07-07: a
malformed OSM feature threw per-hole, discarding computed elevation — every
tile showed '+0ft').

2026-07-08 (hazard-side-flip incident): `build_hole_intelligence` no longer
classifies hazards from raw OSM features at all — that path was a second,
broken side classifier and has been deleted (see `app.caddie.hazards` for the
one true, sign-correct hazard-geometry path). This function now always
returns `hazards == []`; the malformed-input regression below is kept (with
the removed `osm_features` kwarg) to pin that elevation stays computed
regardless, and a new test locks the always-empty contract in explicitly."""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

import pytest  # noqa: E402

from app.caddie import course_intel  # noqa: E402


@pytest.mark.asyncio
async def test_malformed_osm_features_keep_elevation(monkeypatch):
    """Renamed contract: `build_hole_intelligence` no longer accepts/classifies
    raw OSM features at all (the OSM side classifier was deleted — it was the
    hazard-side-flip incident's second, broken geometry path). Elevation must
    still compute correctly and `hazards` is always `[]` from this function."""
    async def fake_elev(lat, lng):
        # tee 96ft, green 125ft — the real Bethpage hole-1 shape
        return 96.0 if lat < 40.746 else 125.4

    async def fake_slope(green):
        return None

    monkeypatch.setattr(course_intel, "fetch_elevation_cached", fake_elev)
    monkeypatch.setattr(course_intel, "compute_green_slope", fake_slope)

    intel = await course_intel.build_hole_intelligence(
        hole_coords={
            "holeNumber": 1,
            "tee": {"lat": 40.7458939, "lng": -73.4507039},
            "green": {"lat": 40.7496381, "lng": -73.4520769},
        },
        par=4,
        yards=412,
        handicap_rating=7,
    )

    assert intel.elevation_change_ft == pytest.approx(29.4, abs=0.1)
    # Physics elevation-only plays-like (plan step 9): 412y is driver-class
    # (shallow ~38° descent), so 29.4ft uphill costs Δh/tan(descent) ≈ +13y —
    # more than the old club-blind 1yd/3ft rule's +10 (412→422). Retuned, not
    # weakened: 425 is the engine's correct number for this hole.
    assert intel.effective_yards == 425
    assert intel.hazards == []


@pytest.mark.asyncio
async def test_unmapped_course_yields_no_hazards(monkeypatch):
    """A round not resolved to a curated/stored course (no `hole_features`
    geometry) must honestly report no hazards — never a guessed side — which
    is what triggers HAZARD_GROUNDING_RULE's generic-language fallback in the
    caddie prompt ([[no-fake-data-fallbacks]])."""
    async def fake_elev(lat, lng):
        return 100.0

    async def fake_slope(green):
        return None

    monkeypatch.setattr(course_intel, "fetch_elevation_cached", fake_elev)
    monkeypatch.setattr(course_intel, "compute_green_slope", fake_slope)

    intel = await course_intel.build_hole_intelligence(
        hole_coords={
            "holeNumber": 4,
            "tee": {"lat": 40.7458939, "lng": -73.4507039},
            "green": {"lat": 40.7496381, "lng": -73.4520769},
        },
        par=4,
        yards=430,
        handicap_rating=1,
    )

    assert intel.hazards == []


@pytest.mark.asyncio
async def test_none_inputs_never_throw_and_stay_honest():
    """Null yards/par/handicap from the route (stored round had no yardage)
    must not crash. yards unknown → effective_yards stays None (no fabricated
    400); par/handicap coalesce to display defaults. No tee/green ⇒ zero
    network calls, elevation stays 0.0."""
    intel = await course_intel.build_hole_intelligence(
        hole_coords={"holeNumber": 1},
        yards=None,
        par=None,
        handicap_rating=None,
    )
    assert intel.yards is None
    assert intel.effective_yards is None
    assert intel.par == 4
    assert intel.handicap_rating == 9
    assert intel.elevation_change_ft == 0.0
