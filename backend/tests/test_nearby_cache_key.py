"""Unit tests for the nearby-search geo-cell cache key quantizer
(search-speed-and-golfapi-verify, latency half). Pure/no I/O — points inside
the same ~1.1km cell must collapse to the SAME key so a repeat open near the
same spot hits the positive-only nearby cache instead of re-hitting OSM."""

from app.routes.course_search import NEARBY_CELL_DECIMALS, _nearby_cache_key


class TestNearbyCacheKeyQuantization:
    def test_points_in_the_same_cell_produce_the_same_key(self):
        # Both round to lat=40.74, lng=-73.46 at 2 decimals.
        a = _nearby_cache_key(40.7442, -73.4593, 25000)
        b = _nearby_cache_key(40.7401, -73.4551, 25000)
        assert a == b

    def test_points_in_different_cells_produce_different_keys(self):
        a = _nearby_cache_key(40.7442, -73.4593, 25000)
        b = _nearby_cache_key(40.90, -73.60, 25000)
        assert a != b

    def test_radius_participates_in_the_key(self):
        a = _nearby_cache_key(40.7442, -73.4593, 25000)
        b = _nearby_cache_key(40.7442, -73.4593, 50000)
        assert a != b

    def test_key_is_deterministic(self):
        assert _nearby_cache_key(40.7442, -73.4593, 25000) == _nearby_cache_key(
            40.7442, -73.4593, 25000
        )

    def test_decimal_precision_constant_matches_key_rounding(self):
        # Sanity: the constant used for rounding is what the key format relies on.
        assert NEARBY_CELL_DECIMALS == 2
        assert _nearby_cache_key(40.744, -73.459, 25000) == "nearby:40.74:-73.46:25000"
