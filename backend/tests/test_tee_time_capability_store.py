"""
Tests for capability_store.py (specs/teetime-s1-foreup-plan.md §8c).

Covers the checked-in seed file (fail-loud on malformed JSON), the gitignored
validated file (fail-soft), the seed/validated merge + de-dupe rule, and
match_capability's name+proximity / exact-id matching.
"""

from __future__ import annotations

import json

import pytest

from app.services.tee_times.capability_store import (
    CourseBookingCapability,
    load_capabilities,
    match_capability,
)


def _row(**overrides) -> dict:
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


class TestShippedSeedFile:
    def test_seed_parses_and_contains_18_mile_creek(self):
        caps = load_capabilities()
        assert len(caps) >= 1
        by_id = {c.foreup_booking_id: c for c in caps}
        assert "20410" in by_id
        cap = by_id["20410"]
        assert cap.schedule_id == "4467"
        assert cap.is_private is False
        assert cap.name == "18 Mile Creek Golf Course"
        assert cap.booking_url == "https://foreupsoftware.com/index.php/booking/20410/4467"
        # Real coordinates, never placeholders (plan §4a).
        assert cap.lat != 0.0 and cap.lng != 0.0
        assert 40.0 < cap.lat < 45.0  # sanity: western NY
        assert -80.0 < cap.lng < -77.0

    def test_malformed_seed_raises_fail_loud(self, tmp_path):
        bad = tmp_path / "bad_seed.json"
        bad.write_text("{not json")
        with pytest.raises(Exception):
            load_capabilities(seed_path=bad, validated_path=tmp_path / "no_validated.json")

    def test_seed_missing_courses_key_raises(self, tmp_path):
        bad = tmp_path / "bad_seed2.json"
        bad.write_text(json.dumps({"_comment": "oops, no courses key"}))
        with pytest.raises(KeyError):
            load_capabilities(seed_path=bad, validated_path=tmp_path / "no_validated.json")


class TestValidatedFileFailSoft:
    def test_missing_validated_file_yields_seed_rows_only(self, tmp_path):
        seed = tmp_path / "seed.json"
        seed.write_text(json.dumps({"courses": [_row()]}))
        caps = load_capabilities(seed_path=seed, validated_path=tmp_path / "missing.json")
        assert len(caps) == 1

    def test_malformed_validated_file_is_ignored(self, tmp_path):
        seed = tmp_path / "seed.json"
        seed.write_text(json.dumps({"courses": [_row()]}))
        validated = tmp_path / "validated.json"
        validated.write_text("{not json")
        caps = load_capabilities(seed_path=seed, validated_path=validated)
        assert len(caps) == 1  # seed rows only — bad script write doesn't take down search


class TestSeedValidatedMerge:
    def test_validated_row_appends(self, tmp_path):
        seed = tmp_path / "seed.json"
        seed.write_text(json.dumps({"courses": [_row()]}))
        validated = tmp_path / "validated.json"
        validated.write_text(json.dumps({"courses": [
            _row(foreup_booking_id="99999", schedule_id="1111", name="Other Course",
                 lat=41.0, lng=-79.0),
        ]}))
        caps = load_capabilities(seed_path=seed, validated_path=validated)
        assert len(caps) == 2
        ids = {c.foreup_booking_id for c in caps}
        assert ids == {"20410", "99999"}

    def test_duplicate_booking_id_schedule_id_seed_row_wins(self, tmp_path):
        seed = tmp_path / "seed.json"
        seed.write_text(json.dumps({"courses": [_row(name="Seed Name (curated)")]}))
        validated = tmp_path / "validated.json"
        validated.write_text(json.dumps({"courses": [
            _row(name="Validated Name (should be dropped)"),
        ]}))
        caps = load_capabilities(seed_path=seed, validated_path=validated)
        assert len(caps) == 1
        assert caps[0].name == "Seed Name (curated)"

    def test_platform_not_foreup_is_skipped(self, tmp_path):
        seed = tmp_path / "seed.json"
        seed.write_text(json.dumps({"courses": [
            _row(),
            _row(platform="chronogolf", foreup_booking_id="1", schedule_id="1"),
        ]}))
        caps = load_capabilities(seed_path=seed, validated_path=tmp_path / "missing.json")
        assert len(caps) == 1
        assert caps[0].platform == "foreup"


class TestMatchCapability:
    _CAP = CourseBookingCapability(
        platform="foreup", course_id=None, foreup_booking_id="20410", schedule_id="4467",
        booking_url="https://foreupsoftware.com/index.php/booking/20410/4467",
        phone="(716) 648-4410", is_private=False, verified_at="2026-07-09T00:00:00Z",
        name="18 Mile Creek Golf Course", lat=42.714304, lng=-78.813114,
        aliases=("18 Mile Creek Golf Club",),
    )
    _CAPS = (_CAP,)

    def test_alias_name_and_center_within_1mi_matches(self):
        course = {
            "id": "gplaces-abc",
            "name": "18 Mile Creek Golf Club",  # alias, not canonical name
            "center": {"lat": 42.7150, "lng": -78.8140},  # ~0.06 mi away
        }
        assert match_capability(course, self._CAPS) is self._CAP

    def test_same_normalized_name_5mi_away_does_not_match(self):
        course = {
            "id": "gplaces-far",
            "name": "18 Mile Creek Golf Course",
            "center": {"lat": 42.79, "lng": -78.83},  # ~5 mi north
        }
        assert match_capability(course, self._CAPS) is None

    def test_no_center_matches_on_name_alone(self):
        course = {"id": "gplaces-nocenter", "name": "18 Mile Creek Golf Course"}
        assert match_capability(course, self._CAPS) is self._CAP

    def test_exact_course_id_matches_regardless_of_name(self):
        cap_with_id = CourseBookingCapability(
            platform="foreup", course_id="gplaces-known-id", foreup_booking_id="20410",
            schedule_id="4467", booking_url=self._CAP.booking_url, phone=None,
            is_private=False, verified_at="2026-07-09T00:00:00Z",
            name="18 Mile Creek Golf Course", lat=42.714304, lng=-78.813114,
        )
        course = {
            "id": "gplaces-known-id",
            "name": "Some Totally Different Name",
            "center": {"lat": 0.0, "lng": 0.0},
        }
        assert match_capability(course, (cap_with_id,)) is cap_with_id

    def test_unrelated_course_does_not_match(self):
        course = {
            "id": "gplaces-other",
            "name": "Presidio Golf Course",
            "center": {"lat": 37.79, "lng": -122.46},
        }
        assert match_capability(course, self._CAPS) is None

    def test_empty_capabilities_never_matches(self):
        course = {"id": "x", "name": "18 Mile Creek Golf Course"}
        assert match_capability(course, ()) is None
