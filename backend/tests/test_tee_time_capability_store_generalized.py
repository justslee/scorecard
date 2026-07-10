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
    def test_seed_parses_and_contains_eight_golfnyc_teeitup_rows(self):
        raw = json.loads(GENERALIZED_SEED_PATH.read_text())
        rows = raw["courses"]
        assert len(rows) == 8
        for row in rows:
            assert row["platform"] == "teeitup"
            assert row["platform_ids"]["alias"] == "golf-nyc"
            assert row["platform_ids"]["facility_id"]
            assert row["probe_status"] == "verified"
            # Real coordinates, never placeholders (no-fake-data-fallbacks).
            assert row["lat"] != 0.0 and row["lng"] != 0.0
            assert 40.0 < row["lat"] < 41.5  # sanity: NYC metro
            assert -75.0 < row["lng"] < -73.0

    def test_load_all_capabilities_includes_both_legacy_and_generalized_rows(self):
        caps = load_all_capabilities()
        platforms = {c.platform for c in caps}
        assert "foreup" in platforms
        assert "teeitup" in platforms

        legacy = load_capabilities()
        assert len(caps) == len(legacy) + 8

        teeitup_caps = [c for c in caps if c.platform == "teeitup"]
        assert len(teeitup_caps) == 8
        by_name = {c.name for c in teeitup_caps}
        assert "Douglaston Golf Course" in by_name
        assert "South Shore Golf Course" in by_name

        douglaston = next(c for c in teeitup_caps if c.name == "Douglaston Golf Course")
        assert douglaston.platform_ids == {"alias": "golf-nyc", "facility_id": "5044"}
        assert douglaston.channel == "api"
        assert douglaston.probe_status == "verified"
        # Legacy convenience fields stay honestly absent for a non-foreup row.
        assert douglaston.foreup_booking_id is None
        assert douglaston.schedule_id is None


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
