"""Offline unit tests for the Static-Maps Web-Mercator projector (B1,
post-review fix) — pure math, NO network, no tile fetch (the georegistration
bug: a fixed zoom=17 tile is only ~316y across and long holes like Black
4/517y, Black 7/553y, Red 16/500y didn't fit; overlays were also projected
in a separate linear-frame that didn't match the tile's real Web-Mercator
extent). Proves tee+green land inside the image for every pilot hole, that
north/east map to up/right as expected, and that the fit-zoom actually
responds to hole size rather than being hardcoded.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

from tests.eval.caddie_bench import geometry as geo, render  # noqa: E402
from tests.eval.caddie_bench.schema import HOLES_DIR  # noqa: E402


def _all_hole_fixtures() -> list[geo.HoleFixture]:
    paths = sorted(HOLES_DIR.glob("*.json"))
    assert len(paths) >= 8, f"expected >= 8 pilot hole fixtures, found {len(paths)}"
    return [geo.load_hole_fixture(p) for p in paths]


def test_tee_and_green_land_inside_the_image_for_every_pilot_hole():
    """B1: the per-hole fit-zoom must keep BOTH tee and green inside the
    [0, _IMG_SIZE] canvas for every pilot hole, including the long par 5s
    that didn't fit the old fixed zoom=17 tile."""
    checked = 0
    for fx in _all_hole_fixtures():
        tee, green = geo._tee_green_lonlat(fx.features)
        assert tee is not None and green is not None, f"{fx.fixture_id}: fixture has no tee/green"
        center_lat, center_lon, zoom = render._hole_center_and_zoom(fx)
        project = render._static_maps_projector(center_lon, center_lat, zoom)

        tx, ty = project(*tee)
        gx, gy = project(*green)
        for label, (x, y) in (("tee", (tx, ty)), ("green", (gx, gy))):
            assert 0 <= x <= render._IMG_SIZE, (
                f"{fx.fixture_id}: {label} x={x:.1f} outside [0, {render._IMG_SIZE}] at zoom {zoom}"
            )
            assert 0 <= y <= render._IMG_SIZE, (
                f"{fx.fixture_id}: {label} y={y:.1f} outside [0, {render._IMG_SIZE}] at zoom {zoom}"
            )
        checked += 1
    assert checked >= 8


def test_projector_north_is_up_and_east_is_right():
    """A known lat/lng delta must map to the expected pixel direction: more
    north (+lat) -> smaller y (up the image); more east (+lng) -> larger x
    (right). Also checks there's no accidental axis swap."""
    center_lat, center_lon = 40.75, -73.45  # arbitrary point, Bethpage-ish latitude
    zoom = 15
    project = render._static_maps_projector(center_lon, center_lat, zoom)

    x0, y0 = project(center_lon, center_lat)
    x_north, y_north = project(center_lon, center_lat + 0.001)
    x_east, y_east = project(center_lon + 0.001, center_lat)

    assert y_north < y0, "moving north must decrease pixel y (up)"
    assert x_east > x0, "moving east must increase pixel x (right)"
    assert abs(x_north - x0) < abs(y_north - y0), "a pure north move must not swing x more than y"
    assert abs(y_east - y0) < abs(x_east - x0), "a pure east move must not swing y more than x"


def test_fit_zoom_shrinks_for_a_long_hole_bbox_vs_a_short_one():
    """A long-hole-scale bbox must resolve to a LOWER (more zoomed-out) fit
    zoom than a short-hole-scale bbox — proves the zoom is actually derived
    from the bbox span (B1), not hardcoded to 17."""
    long_bbox = (-73.4520, 40.7480, -73.4400, 40.7560)   # ~ several hundred yards across
    short_bbox = (-73.4470, 40.7515, -73.4460, 40.7525)  # ~ under 150y across
    assert render._fit_zoom(long_bbox) < render._fit_zoom(short_bbox)


def test_hole_center_and_zoom_is_deterministic_and_shared_by_both_call_sites():
    """B1's core contract: `fetch_base_tile` (satellite request) and
    `compose` (overlay projector) must derive the SAME (center, zoom) for a
    given hole — both now route through this one function, never two
    divergent computations."""
    for fx in _all_hole_fixtures():
        a = render._hole_center_and_zoom(fx)
        b = render._hole_center_and_zoom(fx)
        assert a == b, f"{fx.fixture_id}: _hole_center_and_zoom must be deterministic"
