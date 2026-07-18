"""Unit tests for boundary-polygon hole selection — pure geometry, no network, no DB.

Covers the Pebble Beach ingest path: multi-course facilities where individual
``golf=hole`` ways carry NO ``golf:course:name`` tag, so holes must be selected
by testing them against a NAMED ``leisure=golf_course`` boundary polygon
instead.

- ``app.services.osm._parse_boundary_geometry`` — way (Polygon) vs relation
  (MultiPolygon) OSM element shapes.
- ``app.services.osm.fetch_golf_course_boundaries`` — end-to-end fetch against
  a faked Overpass response (mixed way + relation, named + unnamed).
- ``app.services.osm_ingest._point_in_boundary`` — Polygon / MultiPolygon
  point-in-polygon test.
- ``app.services.osm_ingest.apply_boundary_hole_selection`` — holes fully
  inside / fully outside / straddling the boundary, the >=50% majority rule,
  non-mutation of input, and downstream course_name tagging.
- ``app.services.osm_ingest.match_boundary_by_name`` — exact vs substring
  name matching (both directions), no match, empty input.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.services.osm import (
    OverpassThrottledError,
    _parse_boundary_geometry,
    fetch_golf_course_boundaries,
)
from app.services.osm_ingest import (
    _hole_inside_boundary,
    _point_in_boundary,
    apply_boundary_hole_selection,
    match_boundary_by_name,
)


# ══════════════════════════════════════════════════════════════════════════════
# Fixtures: a square boundary polygon (~0.01° per side, near Pebble Beach)
# ══════════════════════════════════════════════════════════════════════════════

# Square: lon [-121.955, -121.945] x lat [36.565, 36.575]
_SQUARE_RING = [
    [-121.955, 36.565],
    [-121.945, 36.565],
    [-121.945, 36.575],
    [-121.955, 36.575],
    [-121.955, 36.565],  # closed
]
_SQUARE_POLYGON: dict = {"type": "Polygon", "coordinates": [_SQUARE_RING]}

# A second, disjoint square used to build a MultiPolygon boundary (relation-style).
_SQUARE2_RING = [
    [-121.935, 36.565],
    [-121.925, 36.565],
    [-121.925, 36.575],
    [-121.935, 36.575],
    [-121.935, 36.565],
]
_MULTI_POLYGON: dict = {
    "type": "MultiPolygon",
    "coordinates": [[_SQUARE_RING], [_SQUARE2_RING]],
}


def _hole(
    ref: str,
    coords: list[list[float]],
    course_name: str | None = None,
    osm_id: str | None = None,
) -> dict:
    """GeoJSON LineString hole Feature, matching osm.py's output shape."""
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {
            "featureType": "hole",
            "osm_id": osm_id or f"way/h{ref}",
            "ref": ref,
            "par": 4,
            "handicap": 9,
            "name": f"Hole {ref}",
            "course_name": course_name,
        },
    }


# ══════════════════════════════════════════════════════════════════════════════
# _parse_boundary_geometry
# ══════════════════════════════════════════════════════════════════════════════

class TestParseBoundaryGeometry:
    def test_way_produces_polygon(self):
        el = {
            "type": "way",
            "id": 1,
            "geometry": [{"lat": p[1], "lon": p[0]} for p in _SQUARE_RING],
        }
        result = _parse_boundary_geometry(el)
        assert result is not None
        assert result["type"] == "Polygon"
        assert result["coordinates"][0][0] == result["coordinates"][0][-1]  # closed

    def test_way_too_few_points_returns_none(self):
        el = {"type": "way", "id": 1, "geometry": [{"lat": 36.5, "lon": -121.9}]}
        assert _parse_boundary_geometry(el) is None

    def test_relation_produces_multipolygon(self):
        el = {
            "type": "relation",
            "id": 2,
            "members": [
                {
                    "role": "outer",
                    "geometry": [{"lat": p[1], "lon": p[0]} for p in _SQUARE_RING],
                },
                {
                    "role": "outer",
                    "geometry": [{"lat": p[1], "lon": p[0]} for p in _SQUARE2_RING],
                },
                # An "inner" member (polygon hole) must be ignored.
                {
                    "role": "inner",
                    "geometry": [{"lat": 36.57, "lon": -121.95}] * 4,
                },
            ],
        }
        result = _parse_boundary_geometry(el)
        assert result is not None
        assert result["type"] == "MultiPolygon"
        assert len(result["coordinates"]) == 2  # only the two "outer" rings

    def test_relation_with_no_outer_members_returns_none(self):
        el = {
            "type": "relation",
            "id": 3,
            "members": [{"role": "inner", "geometry": [{"lat": 1, "lon": 1}] * 4}],
        }
        assert _parse_boundary_geometry(el) is None

    def test_relation_with_no_members_returns_none(self):
        assert _parse_boundary_geometry({"type": "relation", "id": 4}) is None

    def test_unsupported_type_returns_none(self):
        assert _parse_boundary_geometry({"type": "node", "id": 5}) is None


# ══════════════════════════════════════════════════════════════════════════════
# fetch_golf_course_boundaries (mocked Overpass response)
# ══════════════════════════════════════════════════════════════════════════════

class _Resp:
    def __init__(self, data: dict) -> None:
        self.status_code = 200
        self.is_success = True
        self.text = ""
        self._data = data

    def json(self) -> dict:
        return self._data


class TestFetchGolfCourseBoundaries:
    @pytest.mark.asyncio
    async def test_returns_named_way_and_relation_boundaries(self):
        data = {
            "elements": [
                {
                    "type": "way",
                    "id": 10,
                    "tags": {"leisure": "golf_course", "name": "Pebble Beach Golf Links"},
                    "geometry": [{"lat": p[1], "lon": p[0]} for p in _SQUARE_RING],
                },
                {
                    "type": "relation",
                    "id": 20,
                    "tags": {"leisure": "golf_course", "name": "Spyglass Hill Golf Course"},
                    "members": [
                        {
                            "role": "outer",
                            "geometry": [{"lat": p[1], "lon": p[0]} for p in _SQUARE2_RING],
                        },
                    ],
                },
            ],
        }
        mock_client = AsyncMock()
        mock_client.post.return_value = _Resp(data)
        with patch("httpx.AsyncClient") as mock_ctor:
            mock_ctor.return_value.__aenter__.return_value = mock_client
            results = await fetch_golf_course_boundaries(36.57, -121.95, radius_m=2500)

        assert len(results) == 2
        names = {r["name"] for r in results}
        assert names == {"Pebble Beach Golf Links", "Spyglass Hill Golf Course"}
        way_result = next(r for r in results if r["name"] == "Pebble Beach Golf Links")
        assert way_result["boundary"]["type"] == "Polygon"
        assert way_result["osm_id"] == "way/10"
        rel_result = next(r for r in results if r["name"] == "Spyglass Hill Golf Course")
        assert rel_result["boundary"]["type"] == "MultiPolygon"
        assert rel_result["osm_id"] == "relation/20"

    @pytest.mark.asyncio
    async def test_unnamed_element_is_skipped(self):
        data = {
            "elements": [
                {
                    "type": "way",
                    "id": 11,
                    "tags": {"leisure": "golf_course"},  # no "name" tag
                    "geometry": [{"lat": p[1], "lon": p[0]} for p in _SQUARE_RING],
                },
            ],
        }
        mock_client = AsyncMock()
        mock_client.post.return_value = _Resp(data)
        with patch("httpx.AsyncClient") as mock_ctor:
            mock_ctor.return_value.__aenter__.return_value = mock_client
            results = await fetch_golf_course_boundaries(36.57, -121.95)
        assert results == []

    @pytest.mark.asyncio
    async def test_non_golf_course_element_is_skipped(self):
        data = {
            "elements": [
                {
                    "type": "way",
                    "id": 12,
                    "tags": {"leisure": "park", "name": "Some Park"},
                    "geometry": [{"lat": p[1], "lon": p[0]} for p in _SQUARE_RING],
                },
            ],
        }
        mock_client = AsyncMock()
        mock_client.post.return_value = _Resp(data)
        with patch("httpx.AsyncClient") as mock_ctor:
            mock_ctor.return_value.__aenter__.return_value = mock_client
            results = await fetch_golf_course_boundaries(36.57, -121.95)
        assert results == []

    # ── Throttle/server-error contract (ingest-overpass-error-honesty) ─────────
    #
    # A persistent transient failure (429 / 5xx / timeout, retries exhausted)
    # is a RETRYABLE fault, not a genuine "no boundary matched" result — it
    # must raise OverpassThrottledError, never silently degrade to []. Only a
    # clean 200 response with nothing matching is an honest empty list.

    class _FailResp(_Resp):
        """A single failed Overpass HTTP response (default: transient 504)."""

        def __init__(self, status_code: int = 504) -> None:
            super().__init__({})
            self.status_code = status_code
            self.is_success = False

    @pytest.mark.asyncio
    async def test_504_exhausted_raises_throttled_error(self):
        mock_client = AsyncMock()
        mock_client.post.side_effect = [self._FailResp(504), self._FailResp(504)]
        with patch("httpx.AsyncClient") as mock_ctor, \
                patch("asyncio.sleep", new_callable=AsyncMock):
            mock_ctor.return_value.__aenter__.return_value = mock_client
            with pytest.raises(OverpassThrottledError):
                await fetch_golf_course_boundaries(36.57, -121.95)

    @pytest.mark.asyncio
    async def test_429_exhausted_raises_throttled_error(self):
        mock_client = AsyncMock()
        mock_client.post.side_effect = [self._FailResp(429), self._FailResp(429)]
        with patch("httpx.AsyncClient") as mock_ctor, \
                patch("asyncio.sleep", new_callable=AsyncMock):
            mock_ctor.return_value.__aenter__.return_value = mock_client
            with pytest.raises(OverpassThrottledError):
                await fetch_golf_course_boundaries(36.57, -121.95)

    @pytest.mark.asyncio
    async def test_timeout_exhausted_raises_throttled_error(self):
        mock_client = AsyncMock()
        mock_client.post.side_effect = [
            httpx.TimeoutException("timed out"),
            httpx.TimeoutException("timed out"),
        ]
        with patch("httpx.AsyncClient") as mock_ctor, \
                patch("asyncio.sleep", new_callable=AsyncMock):
            mock_ctor.return_value.__aenter__.return_value = mock_client
            with pytest.raises(OverpassThrottledError):
                await fetch_golf_course_boundaries(36.57, -121.95)

    @pytest.mark.asyncio
    async def test_true_empty_result_returns_empty_list(self):
        """A clean 200 with no matching elements is an honest empty — no raise."""
        mock_client = AsyncMock()
        mock_client.post.return_value = _Resp({"elements": []})
        with patch("httpx.AsyncClient") as mock_ctor:
            mock_ctor.return_value.__aenter__.return_value = mock_client
            results = await fetch_golf_course_boundaries(36.57, -121.95)
        assert results == []

    @pytest.mark.asyncio
    async def test_query_is_anchored_with_around(self):
        """The Overpass query must always be anchored — never an unanchored planet query."""
        data = {"elements": []}
        mock_client = AsyncMock()
        mock_client.post.return_value = _Resp(data)
        with patch("httpx.AsyncClient") as mock_ctor:
            mock_ctor.return_value.__aenter__.return_value = mock_client
            await fetch_golf_course_boundaries(36.5688, -121.9497, radius_m=2500)

        sent_query = mock_client.post.call_args.kwargs["data"]["data"]
        assert "around:2500,36.5688,-121.9497" in sent_query
        assert 'leisure"="golf_course"' in sent_query


# ══════════════════════════════════════════════════════════════════════════════
# _point_in_boundary
# ══════════════════════════════════════════════════════════════════════════════

class TestPointInBoundary:
    def test_point_inside_polygon(self):
        assert _point_in_boundary(-121.950, 36.570, _SQUARE_POLYGON) is True

    def test_point_outside_polygon(self):
        assert _point_in_boundary(-121.900, 36.570, _SQUARE_POLYGON) is False

    def test_point_inside_first_multipolygon_ring(self):
        assert _point_in_boundary(-121.950, 36.570, _MULTI_POLYGON) is True

    def test_point_inside_second_multipolygon_ring(self):
        assert _point_in_boundary(-121.930, 36.570, _MULTI_POLYGON) is True

    def test_point_outside_both_multipolygon_rings(self):
        assert _point_in_boundary(-121.900, 36.570, _MULTI_POLYGON) is False

    def test_unsupported_geometry_type_returns_false(self):
        assert _point_in_boundary(-121.950, 36.570, {"type": "Point", "coordinates": []}) is False

    def test_empty_coordinates_returns_false(self):
        assert _point_in_boundary(-121.950, 36.570, {"type": "Polygon", "coordinates": []}) is False


# ══════════════════════════════════════════════════════════════════════════════
# _hole_inside_boundary / apply_boundary_hole_selection
# ══════════════════════════════════════════════════════════════════════════════

class TestHoleInsideBoundary:
    def test_hole_fully_inside(self):
        coords = [[-121.953, 36.567], [-121.947, 36.573]]
        assert _hole_inside_boundary(coords, _SQUARE_POLYGON, 0.5) is True

    def test_hole_fully_outside(self):
        coords = [[-121.900, 36.567], [-121.890, 36.573]]
        assert _hole_inside_boundary(coords, _SQUARE_POLYGON, 0.5) is False

    def test_hole_straddling_majority_inside_passes(self):
        # 3 of 4 points inside the square (>= 50%).
        coords = [
            [-121.953, 36.567],  # inside
            [-121.951, 36.569],  # inside
            [-121.947, 36.573],  # inside
            [-121.900, 36.567],  # outside
        ]
        assert _hole_inside_boundary(coords, _SQUARE_POLYGON, 0.5) is True

    def test_hole_straddling_minority_inside_fails(self):
        # Only 1 of 4 points inside the square (< 50%).
        coords = [
            [-121.953, 36.567],  # inside
            [-121.900, 36.567],  # outside
            [-121.890, 36.567],  # outside
            [-121.880, 36.567],  # outside
        ]
        assert _hole_inside_boundary(coords, _SQUARE_POLYGON, 0.5) is False

    def test_exactly_half_inside_passes_with_ge(self):
        # 1 of 2 points inside == 0.5 fraction; >= 0.5 threshold passes.
        coords = [
            [-121.953, 36.567],  # inside
            [-121.900, 36.567],  # outside
        ]
        assert _hole_inside_boundary(coords, _SQUARE_POLYGON, 0.5) is True

    def test_empty_coords_returns_false(self):
        assert _hole_inside_boundary([], _SQUARE_POLYGON, 0.5) is False


class TestApplyBoundaryHoleSelection:
    def test_hole_inside_is_tagged_with_target_course_name(self):
        holes = [_hole("1", [[-121.953, 36.567], [-121.947, 36.573]])]
        result = apply_boundary_hole_selection(holes, _SQUARE_POLYGON, "Pebble Beach Golf Links")
        assert result[0]["properties"]["course_name"] == "Pebble Beach Golf Links"

    def test_hole_outside_is_left_untouched(self):
        holes = [_hole("2", [[-121.900, 36.567], [-121.890, 36.573]], course_name=None)]
        result = apply_boundary_hole_selection(holes, _SQUARE_POLYGON, "Pebble Beach Golf Links")
        assert result[0]["properties"]["course_name"] is None
        # Non-selected hole dict is returned as-is (same object) — no unnecessary copy.
        assert result[0] is holes[0]

    def test_straddling_hole_majority_inside_is_selected(self):
        holes = [_hole("3", [
            [-121.953, 36.567], [-121.951, 36.569], [-121.947, 36.573], [-121.900, 36.567],
        ])]
        result = apply_boundary_hole_selection(holes, _SQUARE_POLYGON, "Pebble Beach Golf Links")
        assert result[0]["properties"]["course_name"] == "Pebble Beach Golf Links"

    def test_mixed_selection_across_multiple_holes(self):
        holes = [
            _hole("1", [[-121.953, 36.567], [-121.947, 36.573]]),         # inside
            _hole("2", [[-121.900, 36.567], [-121.890, 36.573]]),         # outside (Spyglass)
            _hole("3", [[-121.952, 36.566], [-121.946, 36.572]]),         # inside
        ]
        result = apply_boundary_hole_selection(holes, _SQUARE_POLYGON, "Pebble Beach Golf Links")
        selected_refs = {
            h["properties"]["ref"] for h in result
            if h["properties"]["course_name"] == "Pebble Beach Golf Links"
        }
        assert selected_refs == {"1", "3"}
        assert len(result) == 3  # all holes preserved, just tagged/untagged

    def test_does_not_mutate_input_list_or_selected_hole_dicts(self):
        original_props = {
            "featureType": "hole", "osm_id": "way/h1", "ref": "1",
            "par": 4, "handicap": 9, "name": "Hole 1", "course_name": None,
        }
        hole = {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [[-121.953, 36.567], [-121.947, 36.573]],
            },
            "properties": dict(original_props),
        }
        holes = [hole]
        apply_boundary_hole_selection(holes, _SQUARE_POLYGON, "Pebble Beach Golf Links")
        # Original hole dict's properties are untouched — course_name still None.
        assert hole["properties"]["course_name"] is None
        assert hole["properties"] == original_props

    def test_relation_multipolygon_boundary_selects_holes_in_either_ring(self):
        holes = [
            _hole("1", [[-121.953, 36.567], [-121.947, 36.573]]),  # ring 1
            _hole("2", [[-121.933, 36.567], [-121.927, 36.573]]),  # ring 2
            _hole("3", [[-121.900, 36.567], [-121.890, 36.573]]),  # neither
        ]
        result = apply_boundary_hole_selection(holes, _MULTI_POLYGON, "Combined Course")
        selected_refs = {
            h["properties"]["ref"] for h in result
            if h["properties"]["course_name"] == "Combined Course"
        }
        assert selected_refs == {"1", "2"}


# ══════════════════════════════════════════════════════════════════════════════
# Duplicate-ref dedupe — two-course-one-boundary fixture (Pine Valley shape)
# ══════════════════════════════════════════════════════════════════════════════
#
# Regression coverage for the 2026-07-17 championship-course ingest incident:
# a club boundary enclosing BOTH a championship course and an executive/short
# course (Pine Valley main + short course) selects hole ways from both, and
# when they share refs (both have a "1", "2", ...) the par merge + polygon
# grouping downstream key on ref alone and silently blend them (first ingest
# produced holes 1-10 all par 3, from the short course overwriting the main
# course). Fix: keep only the longest way per ref among the inside-boundary
# set.

class TestDuplicateHoleRefDedupe:
    def test_longest_way_wins_when_refs_collide(self):
        # Both fully inside the square boundary, both ref "1" — main-course
        # hole (~1 km) vs. short-course hole (~200 m).
        main_hole  = _hole("1", [[-121.953, 36.566], [-121.947, 36.574]], osm_id="way/main1")
        short_hole = _hole("1", [[-121.951, 36.569], [-121.949, 36.570]], osm_id="way/short1")
        result = apply_boundary_hole_selection(
            [main_hole, short_hole], _SQUARE_POLYGON, "Pine Valley"
        )
        tagged = [h for h in result if h["properties"]["course_name"] == "Pine Valley"]
        assert len(tagged) == 1
        assert tagged[0]["properties"]["osm_id"] == "way/main1"

    def test_short_course_loser_is_left_untagged(self):
        main_hole  = _hole("1", [[-121.953, 36.566], [-121.947, 36.574]], osm_id="way/main1")
        short_hole = _hole("1", [[-121.951, 36.569], [-121.949, 36.570]], osm_id="way/short1")
        result = apply_boundary_hole_selection(
            [main_hole, short_hole], _SQUARE_POLYGON, "Pine Valley"
        )
        loser = next(h for h in result if h["properties"]["osm_id"] == "way/short1")
        assert loser["properties"]["course_name"] is None
        assert loser is short_hole  # untouched original object, same as "outside" holes

    def test_non_colliding_refs_are_unaffected(self):
        # Two different refs, no collision — both should be selected as before.
        hole1 = _hole("1", [[-121.953, 36.567], [-121.947, 36.573]], osm_id="way/h1")
        hole2 = _hole("2", [[-121.952, 36.566], [-121.946, 36.572]], osm_id="way/h2")
        result = apply_boundary_hole_selection([hole1, hole2], _SQUARE_POLYGON, "Pine Valley")
        tagged_ids = {
            h["properties"]["osm_id"] for h in result
            if h["properties"]["course_name"] == "Pine Valley"
        }
        assert tagged_ids == {"way/h1", "way/h2"}

    def test_three_way_collision_keeps_only_longest(self):
        refs_and_ids = [
            ("way/short_a", [[-121.951, 36.5690], [-121.950, 36.5695]]),   # shortest
            ("way/short_b", [[-121.951, 36.5680], [-121.950, 36.5690]]),   # middle
            ("way/main",    [[-121.953, 36.566], [-121.947, 36.574]]),    # longest
        ]
        holes = [_hole("7", coords, osm_id=osm_id) for osm_id, coords in refs_and_ids]
        result = apply_boundary_hole_selection(holes, _SQUARE_POLYGON, "Pine Valley")
        tagged = [h for h in result if h["properties"]["course_name"] == "Pine Valley"]
        assert len(tagged) == 1
        assert tagged[0]["properties"]["osm_id"] == "way/main"

    def test_refless_holes_never_collide(self):
        # No ref tag at all — should not be deduped against each other.
        h_a = _hole("", [[-121.953, 36.567], [-121.947, 36.573]], osm_id="way/a")
        h_b = _hole("", [[-121.952, 36.566], [-121.946, 36.572]], osm_id="way/b")
        result = apply_boundary_hole_selection([h_a, h_b], _SQUARE_POLYGON, "Pine Valley")
        tagged_ids = {
            h["properties"]["osm_id"] for h in result
            if h["properties"]["course_name"] == "Pine Valley"
        }
        assert tagged_ids == {"way/a", "way/b"}


# ══════════════════════════════════════════════════════════════════════════════
# match_boundary_by_name
# ══════════════════════════════════════════════════════════════════════════════

class TestMatchBoundaryByName:
    _BOUNDARIES = [
        {"name": "Pebble Beach Golf Links", "osm_id": "way/1", "boundary": _SQUARE_POLYGON},
        {"name": "Spyglass Hill Golf Course", "osm_id": "way/2", "boundary": _SQUARE2_RING},
        {"name": "The Links at Spanish Bay", "osm_id": "way/3", "boundary": _SQUARE_POLYGON},
    ]

    def test_exact_match_case_insensitive(self):
        result = match_boundary_by_name(self._BOUNDARIES, "pebble beach golf links")
        assert result["name"] == "Pebble Beach Golf Links"

    def test_substring_query_matches_longer_name(self):
        result = match_boundary_by_name(self._BOUNDARIES, "Pebble Beach")
        assert result["name"] == "Pebble Beach Golf Links"

    def test_longer_query_matches_shorter_name_substring(self):
        result = match_boundary_by_name(self._BOUNDARIES, "Spyglass Hill Golf Course Pebble Beach")
        # "Spyglass Hill Golf Course" is a substring of the query (reverse direction).
        assert result["name"] == "Spyglass Hill Golf Course"

    def test_no_match_returns_none(self):
        assert match_boundary_by_name(self._BOUNDARIES, "Bethpage Black") is None

    def test_empty_query_returns_none(self):
        assert match_boundary_by_name(self._BOUNDARIES, "") is None

    def test_empty_boundaries_returns_none(self):
        assert match_boundary_by_name([], "Pebble Beach") is None

    def test_exact_match_preferred_over_substring(self):
        boundaries = [
            {"name": "Pebble Beach", "osm_id": "way/9"},
            {"name": "Pebble Beach Golf Links", "osm_id": "way/1"},
        ]
        result = match_boundary_by_name(boundaries, "Pebble Beach")
        assert result["osm_id"] == "way/9"  # exact match wins even though listed first
