"""Tests for the course-selection matching core
(specs/teetime-course-ids-wiring-plan.md).

`candidate_ids` / `matches_selection` are pure — no DB. `resolve_selectors`
does one DB lookup and must NEVER raise; we stub DATABASE_URL (same pattern
as test_caddie_caching.py etc.) so `app.services.courses_mapped` can be
imported/monkeypatched without a real Postgres.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

from app.services.tee_times.selection import (
    CourseSelector,
    candidate_ids,
    matches_selection,
    resolve_selectors,
)
from app.services.course_finder import deterministic_course_id


class TestCandidateIds:
    def test_id_and_osm_id_both_present(self):
        course = {"id": "gplaces-abc", "osm_id": "way/123", "name": "Foo Golf Course"}
        cids = candidate_ids(course)
        assert "gplaces-abc" in cids
        assert "way/123" in cids

    def test_osm_only_includes_deterministic_uuid_of_osm_key(self):
        course = {"osm_id": "way/102", "name": "Foo"}
        cids = candidate_ids(course)
        assert "way/102" in cids
        assert deterministic_course_id("osm-way/102") in cids
        assert "" not in cids

    def test_no_id_no_osm_id_no_key_returns_empty_set(self):
        assert candidate_ids({"name": "Nothing Identifiable"}) == set()

    def test_gplaces_id_deterministic_key_included(self):
        course = {"id": "gplaces-xyz", "name": "Foo"}
        cids = candidate_ids(course)
        assert deterministic_course_id("gplaces-xyz") in cids


class TestMatchesSelection:
    def test_direct_id_match(self):
        course = {"osm_id": "way/102", "name": "Foo Golf Course"}
        selectors = [CourseSelector(id="way/102")]
        assert matches_selection(course, selectors) is True

    def test_no_match_when_id_and_name_differ(self):
        course = {"osm_id": "way/102", "name": "Foo Golf Course"}
        selectors = [CourseSelector(id="way/999")]
        assert matches_selection(course, selectors) is False

    def test_name_and_proximity_match(self):
        course = {"name": "Bethpage Black", "center": {"lat": 40.745, "lng": -73.456}}
        selectors = [CourseSelector(id="unrelated-uuid", name="Bethpage Black", lat=40.7451, lng=-73.4561)]
        assert matches_selection(course, selectors) is True

    def test_same_name_different_center_is_not_a_match(self):
        # Two courses that happen to share a normalized name but sit far
        # apart — the plan's mandatory NEGATIVE case (mirrors
        # capability_store's residual-risk bound).
        course = {"name": "Valley Golf Course", "center": {"lat": 40.0, "lng": -73.0}}
        selectors = [CourseSelector(id="unrelated-uuid", name="Valley Golf Course", lat=45.0, lng=-90.0)]
        assert matches_selection(course, selectors) is False

    def test_name_match_without_any_center_matches_on_name_alone(self):
        course = {"name": "Bethpage Black"}
        selectors = [CourseSelector(id="unrelated-uuid", name="Bethpage Black")]
        assert matches_selection(course, selectors) is True

    def test_empty_selectors_never_matches(self):
        course = {"id": "gplaces-abc", "name": "Foo"}
        assert matches_selection(course, []) is False

    def test_selector_without_name_or_id_match_is_ignored(self):
        course = {"name": "Foo Golf Course"}
        selectors = [CourseSelector(id="some-other-id")]  # no name resolved
        assert matches_selection(course, selectors) is False


class TestResolveSelectors:
    async def test_empty_course_ids_returns_empty_list(self):
        assert await resolve_selectors([]) == []

    async def test_never_raises_falls_back_to_id_only_selectors(self, monkeypatch):
        async def boom(_ids):
            raise RuntimeError("db down")

        monkeypatch.setattr("app.services.courses_mapped.courses_by_ids", boom)

        raw_ids = ["way/102", "gplaces-abc"]
        selectors = await resolve_selectors(raw_ids)
        assert [s.id for s in selectors] == raw_ids
        assert all(s.name is None and s.lat is None and s.lng is None for s in selectors)

    async def test_resolves_name_and_center_when_db_hit(self, monkeypatch):
        raw_id = "osm-bethpage-black"
        det_uuid = deterministic_course_id(raw_id)

        async def fake_courses_by_ids(ids):
            assert det_uuid in ids
            return [{"id": det_uuid, "name": "Bethpage Black", "lat": 40.745, "lng": -73.456}]

        monkeypatch.setattr("app.services.courses_mapped.courses_by_ids", fake_courses_by_ids)

        selectors = await resolve_selectors([raw_id])
        assert len(selectors) == 1
        assert selectors[0].id == raw_id
        assert selectors[0].name == "Bethpage Black"
        assert selectors[0].lat == 40.745

    async def test_unresolved_raw_id_yields_id_only_selector(self, monkeypatch):
        async def fake_courses_by_ids(_ids):
            return []

        monkeypatch.setattr("app.services.courses_mapped.courses_by_ids", fake_courses_by_ids)

        selectors = await resolve_selectors(["way/999"])
        assert selectors == [CourseSelector(id="way/999")]


class TestCsvEmptyMemberGuard:
    """Mirrors the exact guard expression at routes/tee_times.py §3.1 — pure,
    no route/DB needed. A regression here means a legacy `courseIds=","`
    client would filter every course out instead of being treated as
    'no selection'."""

    @staticmethod
    def _parse(course_ids_param: str | None) -> list[str]:
        return (
            [c for c in (s.strip() for s in course_ids_param.split(",")) if c]
            if course_ids_param
            else []
        )

    def test_comma_only_param_parses_to_empty_list(self):
        assert self._parse(",") == []

    def test_leading_trailing_empty_members_dropped(self):
        assert self._parse(",way/102,,gplaces-abc,") == ["way/102", "gplaces-abc"]

    def test_none_param_is_empty_list(self):
        assert self._parse(None) == []

    def test_whitespace_only_members_dropped(self):
        assert self._parse(" , way/102 ,  ") == ["way/102"]
