"""Tests for the private-club filter (specs/teetime-s0-plan.md §2).

Matching is exact normalized-name equality (name/alias) + optional `near`
geo-gate + optional exact ids — NEVER substring/token-subset.
"""

import json

import pytest

from app.services.tee_times.private_filter import (
    DEFAULT_PATH,
    NearAnchor,
    PrivateClubEntry,
    exclude_private,
    is_private,
    load_private_clubs,
    normalize,
)

_LIBERTY_NEAR = NearAnchor(lat=40.7095, lng=-74.0532, radius_miles=10)
_LIBERTY = PrivateClubEntry(
    name="Liberty National Golf Club",
    aliases=("Liberty National Golf Course", "Liberty National"),
    ids=(),
    near=_LIBERTY_NEAR,
)
_CLUBS = (_LIBERTY,)


def _course(name: str, lat: float | None = None, lng: float | None = None, **extra) -> dict:
    c = {"name": name, **extra}
    if lat is not None and lng is not None:
        c["center"] = {"lat": lat, "lng": lng}
    return c


class TestNameVariants:
    def test_places_variant_excluded(self):
        # Within the `near` radius.
        assert is_private(_course("Liberty National Golf Club", 40.71, -74.05), _CLUBS)

    def test_osm_variant_excluded(self):
        assert is_private(_course("Liberty National Golf Course", 40.71, -74.05), _CLUBS)

    def test_bare_alias_excluded(self):
        assert is_private(_course("Liberty National", 40.71, -74.05), _CLUBS)


class TestPublicCourseKept:
    def test_lincoln_park_kept(self):
        assert not is_private(_course("Lincoln Park Golf Course", 37.78, -122.49), _CLUBS)


class TestNoFalsePositives:
    def test_different_course_similar_name_kept(self):
        # "Liberty Golf Course" normalizes to "liberty", not "liberty national" —
        # must NOT match via substring/token-subset.
        assert not is_private(_course("Liberty Golf Course", 40.71, -74.05), _CLUBS)

    def test_same_name_outside_radius_kept(self):
        # Same normalized name, but far from the `near` anchor (e.g. a
        # same-named muni in another state) — not a match.
        assert not is_private(_course("Liberty National Golf Club", 34.0, -118.0), _CLUBS)

    def test_course_without_center_matches_on_name_alone(self):
        # No coordinates to gate on — the entry HAS a `near`, but the course
        # doesn't carry a center, so name-only equality still excludes it
        # (per spec: "courses without a center match on name alone").
        assert is_private(_course("Liberty National Golf Club"), _CLUBS)


class TestCaseAndPunctuation:
    def test_case_insensitive(self):
        assert is_private(_course("LIBERTY NATIONAL GOLF CLUB", 40.71, -74.05), _CLUBS)

    def test_punctuation_insensitive(self):
        assert is_private(_course("Liberty National, Golf Club!", 40.71, -74.05), _CLUBS)


class TestIdMatch:
    def test_id_match_excludes_regardless_of_name(self):
        entry = PrivateClubEntry(name="Liberty National Golf Club", ids=("gplaces-xyz",))
        assert is_private(_course("Totally Different Name", id="gplaces-xyz"), (entry,))

    def test_osm_id_match(self):
        entry = PrivateClubEntry(name="Liberty National Golf Club", ids=("way/999",))
        assert is_private({"name": "Some Course", "osm_id": "way/999"}, (entry,))


class TestNormalize:
    def test_strips_one_generic_suffix(self):
        assert normalize("Liberty National Golf Club") == "liberty national"
        assert normalize("Liberty National Golf Course") == "liberty national"

    def test_never_folds_twice(self):
        # "Liberty National" must never fold further to "Liberty".
        assert normalize("Liberty National") == "liberty national"

    def test_collapses_whitespace_and_punctuation(self):
        assert normalize("  Liberty   National, Golf Club!! ") == "liberty national"


class TestExcludePrivate:
    def test_filters_liberty_keeps_public(self):
        courses = [
            _course("Liberty National Golf Club", 40.71, -74.05),
            _course("Lincoln Park Golf Course", 37.78, -122.49),
        ]
        kept = exclude_private(courses, _CLUBS)
        assert [c["name"] for c in kept] == ["Lincoln Park Golf Course"]


class TestShippedFileLoads:
    def test_shipped_file_parses_and_contains_liberty_national(self):
        clubs = load_private_clubs(DEFAULT_PATH)
        names = {c.name for c in clubs}
        assert "Liberty National Golf Club" in names

    def test_malformed_json_raises(self, tmp_path):
        bad_path = tmp_path / "malformed.json"
        bad_path.write_text("{not json")
        with pytest.raises(json.JSONDecodeError):
            load_private_clubs(bad_path)

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_private_clubs(tmp_path / "does-not-exist.json")

    def test_missing_clubs_key_raises(self, tmp_path):
        path = tmp_path / "no-clubs-key.json"
        path.write_text(json.dumps({"_comment": "oops"}))
        with pytest.raises(KeyError):
            load_private_clubs(path)
