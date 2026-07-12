"""Unit tests for `hazards.extract_corridor_profile` — pure geometry, no
DB/network (specs/corridor-width-club-selection-plan.md §2, §9-A).

Fixture convention: a straight hole travels due EAST (tee at lower longitude,
green at higher longitude), so the tee->green direction is (1, 0) in local
(east, north) metres. The module's pinned LEFT normal is `n = (-uy, ux)`, so
for an east-heading hole `n = (0, 1)` — LEFT = NORTH, RIGHT = SOUTH. All
fixture geometry below is built directly in local (east_yards, north_yards)
offsets from the tee and converted to (lon, lat) via `_pt`, matching the
equirectangular projection `hazards._xy_m` uses internally (small enough
offsets that the cos(lat) approximation introduces no meaningful error).
"""

from __future__ import annotations

import math

from app.caddie.hazards import extract_corridor_profile

# ── Coordinate helpers ────────────────────────────────────────────────────────

_YDS_TO_M = 0.9144
_LAT_M_PER_DEG = 111_320.0
_TEE_LON, _TEE_LAT = -73.000, 40.700
_COS_LAT = math.cos(math.radians(_TEE_LAT))


def _pt(east_yds: float, north_yds: float) -> list[float]:
    """(lon, lat) for a point `east_yds`/`north_yds` from the tee — GeoJSON
    [lon, lat] coordinate order."""
    lon = _TEE_LON + (east_yds * _YDS_TO_M) / (_LAT_M_PER_DEG * _COS_LAT)
    lat = _TEE_LAT + (north_yds * _YDS_TO_M) / _LAT_M_PER_DEG
    return [lon, lat]


def _tee_feature() -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": _pt(0, 0)},
        "properties": {"featureType": "tee"},
    }


def _green_feature(east_yds: float) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": _pt(east_yds, 0)},
        "properties": {"featureType": "green"},
    }


def _hole_linestring(*points_east_north: tuple[float, float]) -> dict:
    coords = [_pt(e, n) for e, n in points_east_north]
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {"featureType": "hole"},
    }


def _point_feature(feature_type: str, east_yds: float, north_yds: float) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": _pt(east_yds, north_yds)},
        "properties": {"featureType": feature_type},
    }


def _rect_polygon(feature_type: str, e_lo: float, e_hi: float, n_lo: float, n_hi: float) -> dict:
    ring = [
        _pt(e_lo, n_lo), _pt(e_hi, n_lo), _pt(e_hi, n_hi), _pt(e_lo, n_hi), _pt(e_lo, n_lo),
    ]
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"featureType": feature_type},
    }


def _polygon(feature_type: str, points_en: list[tuple[float, float]]) -> dict:
    """Arbitrary simple polygon from a list of (east, north) vertices — ring
    auto-closed."""
    ring = [_pt(e, n) for e, n in points_en] + [_pt(*points_en[0])]
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"featureType": feature_type},
    }


def _fc(*features: dict) -> dict:
    return {"type": "FeatureCollection", "features": list(features)}


def _straight_hole_fairway(east_len: float = 400.0, half_width: float = 20.0) -> dict:
    return _rect_polygon("fairway", -5, east_len, -half_width, half_width)


def _by_distance(corridor, d: int):
    return next((s for s in corridor if s.distance_yards == d), None)


# ── 1. Danger + fairway edges on a straight hole ──────────────────────────────


def test_01_straight_hole_danger_and_fairway_edges():
    tee = _tee_feature()
    green = _green_feature(400)
    hole_ls = _hole_linestring((0, 0), (400, 0))
    fairway = _straight_hole_fairway()

    # Woods polygon: leading (south... no, LEFT=north) edge at north=25y,
    # spanning east 240-320y — several ring vertices on that leading edge so
    # >=3 fall inside the +/-20y window around d=270 (i.e. carry 250-290).
    woods = _polygon("woods", [
        (250, 25), (258, 25), (264, 25), (270, 25), (276, 25), (282, 25), (290, 25),
        (290, 45), (250, 45),
    ])
    # >=3 individual tree points on the RIGHT (south, negative north) around
    # carry ~270, lateral ~-26.
    tree_pts = [
        _point_feature("tree", 260, -26),
        _point_feature("tree", 270, -26),
        _point_feature("tree", 280, -26),
    ]

    fc = _fc(tee, green, hole_ls, fairway, woods, *tree_pts)
    corridor = extract_corridor_profile(fc)

    assert corridor is not None
    s270 = _by_distance(corridor, 270)
    assert s270 is not None
    assert s270.left_yards == 25
    assert abs(s270.right_yards - 26) <= 1
    assert s270.width_yards == s270.left_yards + s270.right_yards
    assert abs(s270.left_fairway_yards - 20) <= 1
    assert abs(s270.right_fairway_yards - 20) <= 1
    assert s270.left_source == "trees"
    assert s270.right_source == "trees"


# ── 2. No danger evidence at a given sample -> that sample's width is None ────


def test_02_sample_with_no_danger_evidence_is_none_but_profile_returned():
    tee = _tee_feature()
    green = _green_feature(400)
    hole_ls = _hole_linestring((0, 0), (400, 0))
    fairway = _straight_hole_fairway()
    woods = _polygon("woods", [
        (250, 25), (258, 25), (264, 25), (270, 25), (276, 25), (282, 25), (290, 25),
        (290, 45), (250, 45),
    ])
    tree_pts = [
        _point_feature("tree", 260, -26),
        _point_feature("tree", 270, -26),
        _point_feature("tree", 280, -26),
    ]
    fc = _fc(tee, green, hole_ls, fairway, woods, *tree_pts)
    corridor = extract_corridor_profile(fc)

    assert corridor is not None
    s100 = _by_distance(corridor, 100)
    assert s100 is not None
    assert s100.width_yards is None


# ── 3. No hole LineString -> None ──────────────────────────────────────────────


def test_03_no_hole_linestring_returns_none():
    tee = _tee_feature()
    green = _green_feature(400)
    fairway = _straight_hole_fairway()
    fc = _fc(tee, green, fairway)
    assert extract_corridor_profile(fc) is None


# ── 4. Fairway-only (zero danger evidence anywhere) -> None ──────────────────


def test_04_fairway_only_no_danger_evidence_returns_none():
    tee = _tee_feature()
    green = _green_feature(400)
    hole_ls = _hole_linestring((0, 0), (400, 0))
    fairway = _straight_hole_fairway()
    fc = _fc(tee, green, hole_ls, fairway)
    assert extract_corridor_profile(fc) is None


# ── 5. Coverage guard: <3 tree points stay silent; 1 water vertex sets edge ──


def test_05_tree_coverage_guard_vs_water_min_obs_one():
    tee = _tee_feature()
    green = _green_feature(400)
    hole_ls = _hole_linestring((0, 0), (400, 0))
    fairway = _straight_hole_fairway()

    # Full danger coverage around d=270 so the all-or-nothing gate passes and
    # this test can isolate the d=150 assertions.
    woods = _polygon("woods", [
        (250, 25), (258, 25), (264, 25), (270, 25), (276, 25), (282, 25), (290, 25),
        (290, 45), (250, 45),
    ])
    tree_pts_270 = [
        _point_feature("tree", 260, -26),
        _point_feature("tree", 270, -26),
        _point_feature("tree", 280, -26),
    ]

    # Only 2 stray tree points near d=150 on the LEFT (north) — below
    # _TREE_MIN_OBS(3) -> that side stays None.
    stray_trees = [
        _point_feature("tree", 145, 15),
        _point_feature("tree", 155, 15),
    ]

    # A single small water polygon (traced pond edge) near d=150 on the
    # RIGHT (south) — min-obs 1 -> DOES set the edge.
    water = _polygon("water", [(145, -18), (155, -18), (150, -20)])

    fc = _fc(tee, green, hole_ls, fairway, woods, water, *tree_pts_270, *stray_trees)
    corridor = extract_corridor_profile(fc)

    assert corridor is not None
    s150 = _by_distance(corridor, 150)
    assert s150 is not None
    assert s150.left_yards is None  # coverage guard: only 2 stray points
    assert s150.right_yards is not None
    assert abs(s150.right_yards - 18) <= 2
    assert s150.right_source == "water"


# ── 6. Dogleg: post-corner sample uses the SECOND leg's heading, not chord ───


def test_06_dogleg_post_corner_sample_uses_second_leg_heading():
    tee = _tee_feature()
    # Corner at (200, 0); second leg turns to travel due NORTH (0,1) — a
    # dogleg LEFT (turn cross u1 x u2 = 1*1 - 0*0 = +1 > 0).
    green_pt_feature = {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": _pt(200, 200)},
        "properties": {"featureType": "green"},
    }
    hole_ls = _hole_linestring((0, 0), (200, 0), (200, 200))

    # L-shaped fairway (hexagon): 40y-wide corridor hugging leg1 (east 0-200,
    # north -20..20) then leg2 (north 0-220, east 180..220).
    l_fairway = _polygon("fairway", [
        (-20, -20), (220, -20), (220, 220), (180, 220), (180, 20), (-20, 20),
    ])

    # Trees on the OUTSIDE of the dogleg-left corner — the outside of a
    # dogleg-left is the RIGHT side of leg2 (east, x>200) — see hazards.py's
    # module docstring on dogleg-outside-corner sign flips.
    tree_pts = [
        _point_feature("tree", 215, 20),
        _point_feature("tree", 218, 28),
        _point_feature("tree", 222, 35),
    ]
    # Symmetric evidence on BOTH sides of leg1, well before the corner (~d100)
    # — satisfies the all-or-nothing gate on its own, so the d=230 assertions
    # below isolate the dogleg-frame question cleanly.
    leg1_trees = [
        _point_feature("tree", 95, 15), _point_feature("tree", 100, 15), _point_feature("tree", 105, 15),
        _point_feature("tree", 95, -15), _point_feature("tree", 100, -15), _point_feature("tree", 105, -15),
    ]

    fc = _fc(tee, green_pt_feature, hole_ls, l_fairway, *tree_pts, *leg1_trees)
    corridor = extract_corridor_profile(fc)

    assert corridor is not None
    s230 = _by_distance(corridor, 230)  # 30y past the corner, on leg2
    assert s230 is not None

    # Fairway edges: using leg2's own heading, both edges are ~20y (the
    # L-shape's 40y-wide corridor around leg2). A chord-frame bug (tee->green
    # diagonal) would cast at the wrong angle and miss this value.
    assert abs(s230.left_fairway_yards - 20) <= 2
    assert abs(s230.right_fairway_yards - 20) <= 2

    # Danger evidence sits on the RIGHT of leg2 (correct frame) — never LEFT
    # (which is what a chord-frame sign flip would report).
    assert s230.left_yards is None
    assert s230.right_yards is not None
    assert s230.right_source == "trees"


# ── 7. Split fairway with a gap: fairway edges None, danger still computed ───


def test_07_split_fairway_gap_fairway_none_danger_present():
    tee = _tee_feature()
    green = _green_feature(400)
    hole_ls = _hole_linestring((0, 0), (400, 0))

    fairway_a = _rect_polygon("fairway", -5, 140, -20, 20)
    fairway_b = _rect_polygon("fairway", 160, 400, -20, 20)

    left_trees = [
        _point_feature("tree", 145, 15),
        _point_feature("tree", 150, 15),
        _point_feature("tree", 155, 15),
    ]
    right_trees = [
        _point_feature("tree", 145, -16),
        _point_feature("tree", 150, -16),
        _point_feature("tree", 155, -16),
    ]

    fc = _fc(tee, green, hole_ls, fairway_a, fairway_b, *left_trees, *right_trees)
    corridor = extract_corridor_profile(fc)

    assert corridor is not None
    s150 = _by_distance(corridor, 150)
    assert s150 is not None
    assert s150.left_fairway_yards is None
    assert s150.right_fairway_yards is None
    assert s150.left_yards is not None
    assert s150.right_yards is not None
    assert s150.width_yards is not None
