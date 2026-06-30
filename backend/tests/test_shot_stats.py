"""Unit tests for shots.py — _aggregate_by_club pure function.

Pure function tests: no DB, no network, no imports of app.db or models
beyond the function under test.  All cases documented in the spec:
  - empty input
  - single shot
  - multiple clubs
  - ignores shots with no distance or no club
  - avg / median / stdev correctness
  - most_common_lie selection
  - sort order (longest → shortest)
  - stdev is None when n < 2
"""

import pytest
from app.caddie.shot_stats import aggregate_by_club as _aggregate_by_club, ShotAggRow


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_rows(*tuples: tuple) -> list[ShotAggRow]:
    """Build a list of (club, distance_yards, end_lie) rows."""
    return list(tuples)


# ---------------------------------------------------------------------------
# Empty input
# ---------------------------------------------------------------------------

class TestEmpty:
    def test_empty_list_returns_empty(self):
        assert _aggregate_by_club([]) == []

    def test_all_none_club_returns_empty(self):
        rows = make_rows(
            (None, 150.0, "fairway"),
            (None, 200.0, None),
        )
        assert _aggregate_by_club(rows) == []

    def test_all_none_distance_returns_empty(self):
        rows = make_rows(
            ("driver", None, "tee"),
            ("7iron", None, "fairway"),
        )
        assert _aggregate_by_club(rows) == []

    def test_all_both_none_returns_empty(self):
        rows = make_rows((None, None, None), (None, None, "green"))
        assert _aggregate_by_club(rows) == []


# ---------------------------------------------------------------------------
# Single shot
# ---------------------------------------------------------------------------

class TestSingleShot:
    def test_single_shot_avg_equals_distance(self):
        rows = make_rows(("7iron", 150.0, "fairway"))
        stats = _aggregate_by_club(rows)
        assert len(stats) == 1
        assert stats[0].club == "7iron"
        assert stats[0].n == 1
        assert stats[0].avg_distance == 150.0
        assert stats[0].median_distance == 150.0

    def test_single_shot_stdev_is_none(self):
        rows = make_rows(("driver", 250.0, "tee"))
        stats = _aggregate_by_club(rows)
        assert stats[0].stdev_distance is None

    def test_single_shot_with_lie(self):
        rows = make_rows(("sw", 80.0, "bunker"))
        stats = _aggregate_by_club(rows)
        assert stats[0].most_common_lie == "bunker"

    def test_single_shot_with_no_lie(self):
        rows = make_rows(("pw", 110.0, None))
        stats = _aggregate_by_club(rows)
        assert stats[0].most_common_lie is None


# ---------------------------------------------------------------------------
# Multiple shots, single club
# ---------------------------------------------------------------------------

class TestMultipleShotsOneClub:
    def _rows(self):
        return make_rows(
            ("driver", 240.0, "tee"),
            ("driver", 260.0, "tee"),
            ("driver", 220.0, "fairway"),
        )

    def test_n_correct(self):
        stats = _aggregate_by_club(self._rows())
        assert stats[0].n == 3

    def test_avg_distance(self):
        # (240 + 260 + 220) / 3 = 240.0
        stats = _aggregate_by_club(self._rows())
        assert stats[0].avg_distance == pytest.approx(240.0, abs=0.1)

    def test_median_distance(self):
        # sorted: 220, 240, 260 → median = 240
        stats = _aggregate_by_club(self._rows())
        assert stats[0].median_distance == pytest.approx(240.0, abs=0.1)

    def test_stdev_distance(self):
        # stdev of [240, 260, 220]: mean=240; deviations: 0, 20, -20
        # sample stdev = sqrt((0+400+400)/2) = sqrt(400) = 20.0
        stats = _aggregate_by_club(self._rows())
        assert stats[0].stdev_distance == pytest.approx(20.0, abs=0.1)

    def test_stdev_is_sample_not_population(self):
        # Two shots: stdev should be sample stdev (n-1 denominator)
        rows = make_rows(("driver", 200.0, None), ("driver", 300.0, None))
        stats = _aggregate_by_club(rows)
        # sample stdev of [200, 300] = sqrt((2500+2500)/1) = sqrt(5000) ≈ 70.71
        assert stats[0].stdev_distance is not None
        assert abs(stats[0].stdev_distance - 70.7) < 1.0

    def test_most_common_lie_majority(self):
        # tee × 2, fairway × 1 → most_common = "tee"
        stats = _aggregate_by_club(self._rows())
        assert stats[0].most_common_lie == "tee"

    def test_most_common_lie_all_same(self):
        rows = make_rows(
            ("pw", 100.0, "rough"),
            ("pw", 110.0, "rough"),
        )
        stats = _aggregate_by_club(rows)
        assert stats[0].most_common_lie == "rough"


# ---------------------------------------------------------------------------
# Multiple clubs — sort order
# ---------------------------------------------------------------------------

class TestMultipleClubs:
    def _rows(self):
        return make_rows(
            ("7iron", 155.0, "fairway"),
            ("driver", 255.0, "tee"),
            ("pw", 105.0, "fairway"),
        )

    def test_returns_all_clubs(self):
        stats = _aggregate_by_club(self._rows())
        assert len(stats) == 3

    def test_sorted_longest_first(self):
        stats = _aggregate_by_club(self._rows())
        clubs = [s.club for s in stats]
        # driver(255) > 7iron(155) > pw(105)
        assert clubs == ["driver", "7iron", "pw"]

    def test_per_club_n_correct(self):
        stats = _aggregate_by_club(self._rows())
        by_club = {s.club: s for s in stats}
        assert by_club["driver"].n == 1
        assert by_club["7iron"].n == 1
        assert by_club["pw"].n == 1

    def test_avg_distance_per_club(self):
        stats = _aggregate_by_club(self._rows())
        by_club = {s.club: s for s in stats}
        assert by_club["driver"].avg_distance == pytest.approx(255.0, abs=0.1)
        assert by_club["7iron"].avg_distance == pytest.approx(155.0, abs=0.1)
        assert by_club["pw"].avg_distance == pytest.approx(105.0, abs=0.1)

    def test_mixed_none_ignored_per_club(self):
        # Mix valid and invalid rows across clubs
        rows = make_rows(
            ("driver", 260.0, "tee"),
            ("driver", None, "tee"),     # no distance → skipped
            (None, 200.0, "fairway"),    # no club → skipped
            ("7iron", 160.0, "fairway"),
        )
        stats = _aggregate_by_club(rows)
        assert len(stats) == 2
        by_club = {s.club: s for s in stats}
        assert by_club["driver"].n == 1    # only 1 valid driver shot
        assert by_club["7iron"].n == 1


# ---------------------------------------------------------------------------
# Rounding
# ---------------------------------------------------------------------------

class TestRounding:
    def test_avg_rounded_to_1dp(self):
        # (150 + 151 + 152) / 3 = 151.0 — already clean
        # Use values that produce a repeating decimal: (100 + 101) / 2 = 100.5
        rows = make_rows(("7iron", 100.0, None), ("7iron", 101.0, None))
        stats = _aggregate_by_club(rows)
        avg = stats[0].avg_distance
        # Should be exactly 100.5 (1 dp)
        assert avg == 100.5
        assert str(avg) == str(round(avg, 1))

    def test_median_rounded_to_1dp(self):
        rows = make_rows(
            ("driver", 200.0, None),
            ("driver", 201.0, None),
        )
        stats = _aggregate_by_club(rows)
        # median of [200, 201] = 200.5
        assert stats[0].median_distance == pytest.approx(200.5, abs=0.01)

    def test_stdev_rounded_to_1dp(self):
        # Verify stdev is stored at 1dp (no unrounded float noise)
        rows = make_rows(
            ("driver", 200.0, None),
            ("driver", 300.0, None),
        )
        stats = _aggregate_by_club(rows)
        sd = stats[0].stdev_distance
        assert sd is not None
        assert sd == round(sd, 1)


# ---------------------------------------------------------------------------
# Tie-breaking sort — alphabetical when avg_distance equal
# ---------------------------------------------------------------------------

class TestTieBreaking:
    def test_same_avg_sorted_alphabetically(self):
        rows = make_rows(
            ("sw", 90.0, None),
            ("pw", 90.0, None),
        )
        stats = _aggregate_by_club(rows)
        clubs = [s.club for s in stats]
        # Both avg=90 → alphabetical: pw < sw
        assert clubs == ["pw", "sw"]
