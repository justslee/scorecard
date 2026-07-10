"""
Tests for the S4a generalized multi-platform capability loading
(specs/teetime-availability-everywhere-plan.md §2a):
`load_all_capabilities`, the generalized dedup key, and the shipped
`booking_capabilities_seed.json` file.

`test_tee_time_capability_store.py` (untouched) already pins the ORIGINAL
`load_capabilities`/`_parse_row`/`match_capability` byte-identical — this
file only covers the NEW merged loader + generalized parse path.
"""

from __future__ import annotations

import json

import pytest

from app.services.tee_times.capability_store import (
    GENERALIZED_SEED_PATH,
    CourseBookingCapability,
    load_all_capabilities,
    load_capabilities,
    match_capability,
)


def _foreup_row(**overrides) -> dict:
    defaults = dict(
        platform="foreup",
        course_id=None,
        foreup_booking_id="20410",
        schedule_id="4467",
        booking_url="https://foreupsoftware.com/index.php/booking/20410/4467",
        phone="(716) 648-4410",
        is_private=False,
        verified_at="2026-07-09T00:00:00Z",
        name="18 Mile Creek Golf Course",
        lat=42.714304,
        lng=-78.813114,
        aliases=[],
    )
    defaults.update(overrides)
    return defaults


def _teeitup_row(**overrides) -> dict:
    defaults = dict(
        platform="teeitup",
        channel="api",
        platform_ids={"alias": "golf-nyc", "facility_id": "5044"},
        booking_url="https://golf-nyc.book.teeitup.com/",
        phone="(718) 224-6566",
        is_private=False,
        verified_at="2026-07-10T13:40:44Z",
        probe_status="verified",
        name="Douglaston Golf Course",
        lat=40.75944,
        lng=-73.73586,
        aliases=[],
        course_id=None,
    )
    defaults.update(overrides)
    return defaults


class TestShippedGeneralizedSeed:
    """NOTE (S4c/S4c2): the shipped seed file grows across the epic's slices
    — its own docstring says so explicitly ("S4a+: teeitup, and future
    engines"). S4a pinned "8 rows, all teeitup" when teeitup was the only
    platform in the file yet; S4c appended 3 curated Chronogolf rows
    (deliverable 3, specs/teetime-availability-everywhere-plan.md §3/§6);
    S4c2 (coverage expansion) appended 12 more teeitup rows (2 new tenants:
    westchester-county, somerset-group-v2, plus 2 single-course tenants), 1
    more chronogolf row, and — new in S4c2 — 4 foreUP rows added to THIS
    generalized file (foreup_ny_seed.json itself stays untouched, per its own
    docstring). Every count/name-set below is re-scoped to the new verified
    totals — not weakened: every per-row quality check (platform_ids
    present, probe_status=="verified", real coords, booking_url shape) is
    unchanged or strengthened (the lat/lng sanity bounds are widened to
    admit real Long Island / Fairfield-County-CT extents that are
    genuinely outside the original NYC-only box, not loosened to hide bad
    data)."""

    def test_seed_parses_and_contains_twenty_teeitup_rows(self):
        raw = json.loads(GENERALIZED_SEED_PATH.read_text())
        rows = raw["courses"]
        teeitup_rows = [r for r in rows if r["platform"] == "teeitup"]
        assert len(teeitup_rows) == 20
        for row in teeitup_rows:
            assert row["platform_ids"]["alias"]
            assert row["platform_ids"]["facility_id"]
            assert row["probe_status"] == "verified"
            # Real coordinates, never placeholders (no-fake-data-fallbacks).
            assert row["lat"] != 0.0 and row["lng"] != 0.0
            # Sanity: NY-metro (NYC, Westchester, Long Island, NJ, Fairfield
            # County CT) — widened from the S4a-only NYC box to admit the
            # S4c2 tenants' real, independently-geocoded extents.
            assert 40.0 < row["lat"] < 41.5
            assert -75.0 < row["lng"] < -72.5

        golfnyc_rows = [r for r in teeitup_rows if r["platform_ids"]["alias"] == "golf-nyc"]
        assert len(golfnyc_rows) == 8

        westchester_rows = [r for r in teeitup_rows if r["platform_ids"]["alias"] == "westchester-county"]
        assert len(westchester_rows) == 5
        assert {r["name"] for r in westchester_rows} == {
            "Dunwoodie Golf Course", "Maple Moor Golf Course", "Mohansic Golf Course",
            "Saxon Woods Golf Course", "Sprain Lake Golf Course",
        }

        somerset_rows = [r for r in teeitup_rows if r["platform_ids"]["alias"] == "somerset-group-v2"]
        assert len(somerset_rows) == 5
        assert {r["name"] for r in somerset_rows} == {
            "Green Knoll Golf Course", "Neshanic Valley Golf Course", "Quail Brook Golf Course",
            "Spooky Brook Golf Course", "Warren Brook Golf Course",
        }

        assert any(r["name"] == "Middle Island Country Club" for r in teeitup_rows)
        assert any(r["name"] == "Chris Bargas Golf Club at Whitney Farms" for r in teeitup_rows)

    def test_seed_contains_four_chronogolf_rows(self):
        raw = json.loads(GENERALIZED_SEED_PATH.read_text())
        rows = raw["courses"]
        chronogolf_rows = [r for r in rows if r["platform"] == "chronogolf"]
        assert len(chronogolf_rows) == 4
        for row in chronogolf_rows:
            assert row["channel"] == "scrape_http"
            ids = row["platform_ids"]
            assert ids["club_id"] and ids["course_id"] and ids["affiliation_type_id"]
            assert row["probe_status"] == "verified"
            assert row["booking_url"] and row["booking_url"].startswith("https://www.chronogolf.com/club/")
            assert row["lat"] != 0.0 and row["lng"] != 0.0
        assert "Putnam County Golf Course" in {r["name"] for r in chronogolf_rows}

    def test_seed_contains_four_generalized_foreup_rows(self):
        """S4c2: unlike S4a/S4c, foreUP rows can now also live in the
        generalized seed file (capability_store._parse_generalized_row
        already accepted platform=="foreup" — this is the first slice that
        exercises it). foreup_ny_seed.json's original single 18-Mile-Creek
        row is untouched (TestGeneralizedLoaderBackCompat / the legacy
        `load_capabilities` suite pin that separately)."""
        raw = json.loads(GENERALIZED_SEED_PATH.read_text())
        rows = raw["courses"]
        foreup_rows = [r for r in rows if r["platform"] == "foreup"]
        assert len(foreup_rows) == 4
        for row in foreup_rows:
            assert row["channel"] == "api"
            ids = row["platform_ids"]
            assert ids["booking_id"] and ids["schedule_id"]
            assert row["probe_status"] == "verified"
            assert row["booking_url"] and row["booking_url"].startswith(
                "https://foreupsoftware.com/index.php/booking/"
            )
            assert row["lat"] != 0.0 and row["lng"] != 0.0
        assert {r["name"] for r in foreup_rows} == {
            "Weequahic Golf Course",
            "Francis A. Byrne Golf Course",
            "Hendricks Field Golf Course",
            "Rockland Lake State Park Championship Golf Course",
        }

    def test_load_all_capabilities_includes_both_legacy_and_generalized_rows(self):
        caps = load_all_capabilities()
        platforms = {c.platform for c in caps}
        assert "foreup" in platforms
        assert "teeitup" in platforms
        assert "chronogolf" in platforms

        legacy = load_capabilities()
        assert len(caps) == len(legacy) + 20 + 4 + 4

        teeitup_caps = [c for c in caps if c.platform == "teeitup"]
        assert len(teeitup_caps) == 20
        by_name = {c.name for c in teeitup_caps}
        assert "Douglaston Golf Course" in by_name
        assert "South Shore Golf Course" in by_name
        assert "Sprain Lake Golf Course" in by_name
        assert "Middle Island Country Club" in by_name

        douglaston = next(c for c in teeitup_caps if c.name == "Douglaston Golf Course")
        assert douglaston.platform_ids == {"alias": "golf-nyc", "facility_id": "5044"}
        assert douglaston.channel == "api"
        assert douglaston.probe_status == "verified"
        # Legacy convenience fields stay honestly absent for a non-foreup row.
        assert douglaston.foreup_booking_id is None
        assert douglaston.schedule_id is None

        chronogolf_caps = [c for c in caps if c.platform == "chronogolf"]
        assert len(chronogolf_caps) == 4
        assert {c.name for c in chronogolf_caps} == {
            "Rock Spring Golf Club at West Orange",
            "Pleasantville Country Club",
            "Beaver Brook Country Club",
            "Putnam County Golf Course",
        }

        foreup_caps = [c for c in caps if c.platform == "foreup"]
        # legacy foreup_ny_seed.json's 1 row (18 Mile Creek) + the 4 new
        # generalized-file foreup rows.
        assert len(foreup_caps) == 5
        assert {c.name for c in foreup_caps} == {
            "18 Mile Creek Golf Course",
            "Weequahic Golf Course",
            "Francis A. Byrne Golf Course",
            "Hendricks Field Golf Course",
            "Rockland Lake State Park Championship Golf Course",
        }
        # The 3 new Essex County foreUP rows carry real ids distinct from
        # the rejected essex-group TeeItUp tenant (that tenant is not, and
        # must never be, in this seed file — resident-gated dead end).
        weequahic = next(c for c in foreup_caps if c.name == "Weequahic Golf Course")
        assert weequahic.platform_ids == {"booking_id": "22527", "schedule_id": "11077"}
        assert weequahic.channel == "api"


class TestGeneralizedLoaderBackCompat:
    def test_legacy_foreup_row_still_parses_via_load_all_capabilities(self, tmp_path):
        seed = tmp_path / "foreup_seed.json"
        seed.write_text(json.dumps({"courses": [_foreup_row()]}))
        generalized_seed = tmp_path / "generalized_seed.json"
        generalized_seed.write_text(json.dumps({"courses": []}))

        caps = load_all_capabilities(
            seed_path=seed,
            validated_path=tmp_path / "missing_validated.json",
            generalized_seed_path=generalized_seed,
            generalized_validated_path=tmp_path / "missing_generalized_validated.json",
        )
        assert len(caps) == 1
        cap = caps[0]
        assert cap.platform == "foreup"
        assert cap.foreup_booking_id == "20410"
        assert cap.schedule_id == "4467"
        # Back-compat: platform_ids is ALSO populated for a legacy-shape row.
        assert cap.platform_ids == {"booking_id": "20410", "schedule_id": "4467"}

    def test_generalized_seed_parses_teeitup_row(self, tmp_path):
        seed = tmp_path / "foreup_seed.json"
        seed.write_text(json.dumps({"courses": []}))
        generalized_seed = tmp_path / "generalized_seed.json"
        generalized_seed.write_text(json.dumps({"courses": [_teeitup_row()]}))

        caps = load_all_capabilities(
            seed_path=seed,
            validated_path=tmp_path / "missing_validated.json",
            generalized_seed_path=generalized_seed,
            generalized_validated_path=tmp_path / "missing_generalized_validated.json",
        )
        assert len(caps) == 1
        cap = caps[0]
        assert cap.platform == "teeitup"
        assert cap.platform_ids == {"alias": "golf-nyc", "facility_id": "5044"}
        assert cap.name == "Douglaston Golf Course"
        assert cap.probe_status == "verified"

    def test_malformed_generalized_seed_raises_fail_loud(self, tmp_path):
        seed = tmp_path / "foreup_seed.json"
        seed.write_text(json.dumps({"courses": []}))
        bad_generalized = tmp_path / "bad_generalized_seed.json"
        bad_generalized.write_text("{not json")
        with pytest.raises(Exception):
            load_all_capabilities(
                seed_path=seed,
                validated_path=tmp_path / "missing_validated.json",
                generalized_seed_path=bad_generalized,
                generalized_validated_path=tmp_path / "missing.json",
            )

    def test_missing_generalized_validated_file_yields_seed_rows_only(self, tmp_path):
        seed = tmp_path / "foreup_seed.json"
        seed.write_text(json.dumps({"courses": []}))
        generalized_seed = tmp_path / "generalized_seed.json"
        generalized_seed.write_text(json.dumps({"courses": [_teeitup_row()]}))

        caps = load_all_capabilities(
            seed_path=seed,
            validated_path=tmp_path / "missing_validated.json",
            generalized_seed_path=generalized_seed,
            generalized_validated_path=tmp_path / "totally_missing.json",
        )
        assert len(caps) == 1

    def test_malformed_generalized_validated_is_ignored_fail_soft(self, tmp_path):
        seed = tmp_path / "foreup_seed.json"
        seed.write_text(json.dumps({"courses": []}))
        generalized_seed = tmp_path / "generalized_seed.json"
        generalized_seed.write_text(json.dumps({"courses": [_teeitup_row()]}))
        bad_validated = tmp_path / "bad_validated.json"
        bad_validated.write_text("{not json")

        caps = load_all_capabilities(
            seed_path=seed,
            validated_path=tmp_path / "missing_validated.json",
            generalized_seed_path=generalized_seed,
            generalized_validated_path=bad_validated,
        )
        assert len(caps) == 1  # seed row only — bad script write doesn't take down search

    def test_row_with_no_platform_is_skipped(self, tmp_path):
        seed = tmp_path / "foreup_seed.json"
        seed.write_text(json.dumps({"courses": []}))
        generalized_seed = tmp_path / "generalized_seed.json"
        generalized_seed.write_text(json.dumps({"courses": [
            _teeitup_row(),
            {"name": "No Platform Course", "lat": 0.0, "lng": 0.0},
        ]}))

        caps = load_all_capabilities(
            seed_path=seed,
            validated_path=tmp_path / "missing_validated.json",
            generalized_seed_path=generalized_seed,
            generalized_validated_path=tmp_path / "missing.json",
        )
        assert len(caps) == 1
        assert caps[0].platform == "teeitup"


class TestGeneralizedDedupAcrossPlatforms:
    def test_same_platform_different_ids_both_kept(self, tmp_path):
        seed = tmp_path / "foreup_seed.json"
        seed.write_text(json.dumps({"courses": []}))
        generalized_seed = tmp_path / "generalized_seed.json"
        generalized_seed.write_text(json.dumps({"courses": [
            _teeitup_row(),
            _teeitup_row(
                name="Van Cortlandt Golf Course",
                platform_ids={"alias": "golf-nyc", "facility_id": "5043"},
            ),
        ]}))

        caps = load_all_capabilities(
            seed_path=seed,
            validated_path=tmp_path / "missing_validated.json",
            generalized_seed_path=generalized_seed,
            generalized_validated_path=tmp_path / "missing.json",
        )
        assert len(caps) == 2

    def test_duplicate_platform_ids_seed_wins_over_generalized_validated(self, tmp_path):
        seed = tmp_path / "foreup_seed.json"
        seed.write_text(json.dumps({"courses": []}))
        generalized_seed = tmp_path / "generalized_seed.json"
        generalized_seed.write_text(json.dumps({"courses": [
            _teeitup_row(name="Curated Name (seed)"),
        ]}))
        generalized_validated = tmp_path / "generalized_validated.json"
        generalized_validated.write_text(json.dumps({"courses": [
            _teeitup_row(name="Script-Appended Name (should be dropped)"),
        ]}))

        caps = load_all_capabilities(
            seed_path=seed,
            validated_path=tmp_path / "missing_validated.json",
            generalized_seed_path=generalized_seed,
            generalized_validated_path=generalized_validated,
        )
        assert len(caps) == 1
        assert caps[0].name == "Curated Name (seed)"

    def test_foreup_and_teeitup_never_collide_even_with_overlapping_id_strings(self, tmp_path):
        """A foreUP row and a teeitup row that happen to carry the SAME raw id
        string in different key namespaces must never dedupe against each
        other — the platform is part of the key."""
        seed = tmp_path / "foreup_seed.json"
        seed.write_text(json.dumps({"courses": [_foreup_row()]}))
        generalized_seed = tmp_path / "generalized_seed.json"
        generalized_seed.write_text(json.dumps({"courses": [
            _teeitup_row(platform_ids={"alias": "20410", "facility_id": "4467"}),
        ]}))

        caps = load_all_capabilities(
            seed_path=seed,
            validated_path=tmp_path / "missing_validated.json",
            generalized_seed_path=generalized_seed,
            generalized_validated_path=tmp_path / "missing.json",
        )
        assert len(caps) == 2


class TestMatchCapabilityStillWorksGeneralized:
    """match_capability is platform-agnostic already — sanity-check it still
    matches a generalized (teeitup) capability row exactly like a foreUP one."""

    def test_matches_teeitup_row_by_name_and_proximity(self):
        cap = CourseBookingCapability(
            platform="teeitup", name="Douglaston Golf Course", lat=40.75944, lng=-73.73586,
            channel="api", platform_ids={"alias": "golf-nyc", "facility_id": "5044"},
            booking_url="https://golf-nyc.book.teeitup.com/",
        )
        course = {
            "id": "gplaces-douglaston",
            "name": "Douglaston Golf Course",
            "center": {"lat": 40.7595, "lng": -73.7360},
        }
        assert match_capability(course, (cap,)) is cap

    def test_does_not_match_unrelated_teeitup_row(self):
        cap = CourseBookingCapability(
            platform="teeitup", name="Douglaston Golf Course", lat=40.75944, lng=-73.73586,
            platform_ids={"alias": "golf-nyc", "facility_id": "5044"},
        )
        course = {"id": "x", "name": "Some Other Course", "center": {"lat": 40.0, "lng": -73.0}}
        assert match_capability(course, (cap,)) is None
