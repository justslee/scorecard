"""Tests for the relevance gate + ranking + write-through helpers added to
services/course_finder.py (course-search-fix-plan, Work item 1).

The owner's literal acceptance test: q="bethpa" returns ONLY Bethpage courses;
q="bethpage black" returns exactly Bethpage Black; town names (Bethel Island,
Bethanga) can NEVER be emitted as course results.
"""

from app.services import course_finder
from app.services.course_finder import (
    external_course_key,
    external_course_rows,
    matches_query_prefix,
    normalize_query,
    rank_courses,
    significant_tokens,
)


# ─────────────────────────────────────────────────────────────────────────────
# matches_query_prefix — the Bethpage repro table
# ─────────────────────────────────────────────────────────────────────────────

class TestMatchesQueryPrefixBethpageRepro:
    def test_bethpa_matches_all_bethpage_courses(self):
        assert matches_query_prefix("Bethpage Black Course", "bethpa")
        assert matches_query_prefix("Bethpage Red Course", "bethpa")
        assert matches_query_prefix("Bethpage Green Course", "bethpa")

    def test_bethpa_never_matches_towns(self):
        # The owner's exact repro: geocoder towns must never pass the gate.
        assert not matches_query_prefix("Bethel Island", "bethpa")
        assert not matches_query_prefix("Bethanga", "bethpa")

    def test_bethpage_black_matches_only_black(self):
        assert matches_query_prefix("Bethpage Black Course", "bethpage black")
        assert not matches_query_prefix("Bethpage Red Course", "bethpage black")
        assert not matches_query_prefix("Bethpage Green Course", "bethpage black")

    def test_bethpage_black_rejects_non_matches(self):
        assert not matches_query_prefix("Bethel Island", "bethpage black")
        assert not matches_query_prefix("Bethpage State Park", "bethpage black")


class TestMatchesQueryPrefixEdgeCases:
    def test_multi_word_prefix_every_token_must_match(self):
        # Every query token must prefix-match SOME name token — order doesn't
        # matter, but ALL tokens must be satisfied.
        assert matches_query_prefix("Pebble Beach Golf Links", "peb bea")
        assert not matches_query_prefix("Pebble Beach Golf Links", "peb xyz")

    def test_stopwords_dropped_from_query(self):
        # "golf course" alone would be all-stopwords → falls back to matching
        # literally, but "bethpage golf course" drops "golf"/"course" and
        # matches on "bethpage" only.
        assert matches_query_prefix("Bethpage Black Course", "bethpage golf course")
        assert matches_query_prefix("Bethpage Black Course", "the bethpage")

    def test_all_stopword_query_still_falls_back_to_matching(self):
        # significant_tokens falls back to ALL tokens when query is only
        # stopwords, so "golf club" can still match "The Golf Club at X".
        assert matches_query_prefix("The Golf Club at Peachtree", "golf club")

    def test_case_and_punctuation_insensitive(self):
        assert matches_query_prefix("St. Andrews Golf Club", "ST ANDREWS")
        assert matches_query_prefix("O'Brien's Golf Course", "obrien")

    def test_accents_folded(self):
        assert matches_query_prefix("Café Golf Course", "cafe")
        assert matches_query_prefix("Château de Golf", "chateau")

    def test_empty_query_never_matches(self):
        assert not matches_query_prefix("Bethpage Black Course", "")
        assert not matches_query_prefix("Bethpage Black Course", "   ")

    def test_prefix_not_substring_bethel_does_not_match_beth(self):
        # "Bethel" does NOT start with "beth" + "p"... but critically a
        # substring match (not prefix) would wrongly let "Bethel" pass a
        # naive "beth" in name check; the real gate requires "bethpa" as a
        # literal PREFIX of a name token, so "Bethel" (no "bethpa" prefix
        # token) correctly fails.
        assert not matches_query_prefix("Bethel Island Golf Club", "bethpa")


# ─────────────────────────────────────────────────────────────────────────────
# significant_tokens / normalize_query
# ─────────────────────────────────────────────────────────────────────────────

class TestNormalizeQuery:
    def test_stopwords_and_case_normalized_to_same_key(self):
        assert normalize_query("Bethpage") == normalize_query("Bethpage Golf Course")
        assert normalize_query("bethpage") == normalize_query("BETHPAGE")

    def test_word_order_normalized(self):
        assert normalize_query("black bethpage") == normalize_query("bethpage black")

    def test_significant_tokens_drops_stopwords(self):
        assert significant_tokens("bethpage golf course") == ["bethpage"]


# ─────────────────────────────────────────────────────────────────────────────
# rank_courses — tiered, stable ranking
# ─────────────────────────────────────────────────────────────────────────────

class TestRankCourses:
    def test_exact_match_beats_prefix_match(self):
        courses = [
            {"name": "Bethpage Black Course", "source": "osm"},
            {"name": "Bethpage", "source": "osm"},
        ]
        ranked = rank_courses(courses, "bethpage")
        assert ranked[0]["name"] == "Bethpage"  # exact normalized match wins

    def test_local_source_beats_external_within_same_tier(self):
        courses = [
            {"name": "Bethpage Black East", "source": "osm"},
            {"name": "Bethpage Black West", "source": "local"},
        ]
        # Neither name's token set equals the query's (extra East/West token),
        # so both land in tier 2 (all-token prefix); local wins the source tier.
        ranked = rank_courses(courses, "bethpage black")
        assert ranked[0]["source"] == "local"

    def test_distance_breaks_ties_when_anchor_given(self):
        anchor = {"lat": 40.75, "lng": -73.46}
        # Both have an extra token beyond the query (tier 1, not exact) and
        # the same source, so distance is the deciding tier — "Zulu" would
        # sort last alphabetically, proving distance outranks alpha here.
        near = {"name": "Bethpage Black Zulu", "source": "osm",
                "center": {"lat": 40.751, "lng": -73.461}}
        far = {"name": "Bethpage Black Alpha", "source": "osm",
               "center": {"lat": 41.5, "lng": -74.5}}
        ranked = rank_courses([far, near], "bethpage black", anchor=anchor)
        assert ranked[0] is near

    def test_alpha_breaks_remaining_ties(self):
        courses = [
            {"name": "Bethpage Zebra", "source": "osm"},
            {"name": "Bethpage Alpha", "source": "osm"},
        ]
        ranked = rank_courses(courses, "bethpage")
        assert [c["name"] for c in ranked] == ["Bethpage Alpha", "Bethpage Zebra"]

    def test_stable_within_equal_keys(self):
        # Two courses with identical rank keys keep their input order.
        a = {"name": "Bethpage Black", "source": "osm", "id": "a"}
        b = {"name": "Bethpage Black", "source": "osm", "id": "b"}
        ranked = rank_courses([a, b], "bethpage black")
        assert [c["id"] for c in ranked] == ["a", "b"]


# ─────────────────────────────────────────────────────────────────────────────
# Write-through identity — deterministic UUIDs, idempotency
# ─────────────────────────────────────────────────────────────────────────────

class TestWriteThroughIdentity:
    def test_deterministic_course_id_is_stable(self):
        assert course_finder.deterministic_course_id("osm-way/123") == \
            course_finder.deterministic_course_id("osm-way/123")

    def test_deterministic_course_id_differs_by_key(self):
        assert course_finder.deterministic_course_id("osm-way/123") != \
            course_finder.deterministic_course_id("osm-way/456")

    def test_external_course_key_prefers_osm_id(self):
        assert external_course_key({"osm_id": "way/123", "id": "gplaces-abc"}) == "osm-way/123"

    def test_external_course_key_falls_back_to_id(self):
        assert external_course_key({"id": "gplaces-abc"}) == "gplaces-abc"

    def test_external_course_key_none_without_identity(self):
        assert external_course_key({"name": "X"}) is None

    def test_external_course_rows_skips_incomplete_hits(self):
        hits = [
            {"osm_id": "way/1", "name": "Bethpage Black", "center": {"lat": 1, "lng": 2}},
            {"osm_id": "way/2", "name": "", "center": {"lat": 1, "lng": 2}},  # no name
            {"osm_id": "way/3", "name": "No Center"},  # no center
            {"name": "No Key"},  # no osm_id/id
        ]
        rows = external_course_rows(hits)
        assert len(rows) == 1
        assert rows[0]["name"] == "Bethpage Black"
        assert rows[0]["lat"] == 1 and rows[0]["lng"] == 2

    def test_external_course_rows_idempotent_id(self):
        hit = {"osm_id": "way/123", "name": "Bethpage Black", "center": {"lat": 1, "lng": 2}}
        row1 = external_course_rows([hit])[0]
        row2 = external_course_rows([hit])[0]
        assert row1["id"] == row2["id"]

    def test_attach_stable_ids_only_fills_missing(self):
        with_id = {"id": "gplaces-abc", "osm_id": None, "name": "X"}
        without_id = {"osm_id": "way/1", "name": "Y"}
        course_finder.attach_stable_ids([with_id, without_id])
        assert with_id["id"] == "gplaces-abc"  # untouched
        assert without_id["id"]  # filled in, deterministic
        assert without_id["id"] == course_finder.deterministic_course_id("osm-way/1")
