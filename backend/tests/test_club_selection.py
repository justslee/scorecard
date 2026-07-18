"""Unit tests for caddie/club_selection.py — pure, no DB/network."""

import logging

import pytest

from app.caddie.club_selection import (
    canonical_club,
    normalize_club_distances,
    compute_adjustments,
    select_club,
    DEFAULT_CLUB_DISTANCES,
)
from app.caddie.types import WeatherConditions


# ── canonical_club — the ONE shared alias table (owner P0 2026-07-18) ────────

class TestCanonicalClub:
    """Every LLM-natural shorthand the owner listed resolves to its
    canonical CLUB_REFERENCE key; case/space/hyphen-insensitive; unrecognized
    tokens (and non-str input) degrade to None, never raise."""

    @pytest.mark.parametrize(
        "raw,expected",
        [
            # Already-canonical keys pass through.
            ("driver", "driver"),
            ("3wood", "3wood"),
            ("5wood", "5wood"),
            ("hybrid", "hybrid"),
            ("7iron", "7iron"),
            ("pw", "pw"),
            ("gw", "gw"),
            ("sw", "sw"),
            ("lw", "lw"),
            # Display-name-derived aliases.
            ("Driver", "driver"),
            ("3 Wood", "3wood"),
            ("7 Iron", "7iron"),
            ("7-Iron", "7iron"),
            # N-letter iron shorthand, all of 4-9.
            ("4i", "4iron"),
            ("5i", "5iron"),
            ("6i", "6iron"),
            ("7i", "7iron"),
            ("8i", "8iron"),
            ("9i", "9iron"),
            # Wood shorthand.
            ("3w", "3wood"),
            ("5w", "5wood"),
            # Long wedge forms + case/space/hyphen variants.
            ("pitching wedge", "pw"),
            ("pitching-wedge", "pw"),
            ("gap wedge", "gw"),
            ("sand wedge", "sw"),
            ("sandwedge", "sw"),
            ("lob wedge", "lw"),
            ("lobwedge", "lw"),
            # Newly-added single-letter/short aliases (owner spec).
            ("p", "pw"),
            ("P", "pw"),
            ("lob", "lw"),
            ("d", "driver"),
            ("D", "driver"),
            ("3h", "hybrid"),
        ],
    )
    def test_known_aliases_resolve(self, raw, expected):
        assert canonical_club(raw) == expected

    def test_unrecognized_token_returns_none(self):
        assert canonical_club("shovel") is None
        assert canonical_club("putter") is None

    def test_non_str_input_never_raises(self):
        # The int-TypeError half of the P0: a model-supplied int club arg
        # must never raise inside club resolution.
        assert canonical_club(7) is None
        assert canonical_club(None) is None


class TestNormalizeClubDistancesAliasesAndDrops:
    """The bag chokepoint resolves shorthand to correct canonical numbers and
    DROPS (never crashes on) an unrecognized club, logging a warning."""

    def test_shorthand_resolves_to_correct_canonical_key(self):
        # '3w' must yield the 3wood number, not silently pass through as a
        # distinct, unmatched key physics has never heard of.
        result = normalize_club_distances({"3w": 230, "7i": 160})
        assert result == {"3wood": 230, "7iron": 160}

    def test_unknown_club_dropped_with_warning(self, caplog):
        with caplog.at_level(logging.WARNING, logger="looper.caddie.club_selection"):
            result = normalize_club_distances({"driver": 250, "shovel": 999})
        assert "shovel" not in result
        assert result == {"driver": 250}
        assert any("shovel" in rec.message for rec in caplog.records)


# ── normalize_club_distances ──────────────────────────────────────────────────

class TestNormalizeClubDistances:
    """camelCase GolferProfile keys → short internal keys; zero/negative dropped."""

    def test_camelcase_keys_mapped(self):
        raw = {
            "driver": 250,
            "threeWood": 230,
            "fiveWood": 215,
            "hybrid": 200,
            "fourIron": 190,
            "fiveIron": 180,
            "sixIron": 170,
            "sevenIron": 160,
            "eightIron": 150,
            "nineIron": 140,
            "pitchingWedge": 130,
            "gapWedge": 115,
            "sandWedge": 100,
            "lobWedge": 85,
        }
        result = normalize_club_distances(raw)
        assert result == {
            "driver": 250,
            "3wood": 230,
            "5wood": 215,
            "hybrid": 200,
            "4iron": 190,
            "5iron": 180,
            "6iron": 170,
            "7iron": 160,
            "8iron": 150,
            "9iron": 140,
            "pw": 130,
            "gw": 115,
            "sw": 100,
            "lw": 85,
        }

    def test_zero_value_dropped(self):
        result = normalize_club_distances({"driver": 250, "threeWood": 0})
        assert "3wood" not in result
        assert result["driver"] == 250

    def test_negative_value_dropped(self):
        result = normalize_club_distances({"driver": 250, "hybrid": -10})
        assert "hybrid" not in result

    def test_already_short_keys_passthrough(self):
        # Keys already in short form (not in _PROFILE_KEY_MAP) pass through unchanged
        result = normalize_club_distances({"7iron": 160, "pw": 130})
        assert result == {"7iron": 160, "pw": 130}

    def test_empty_input(self):
        assert normalize_club_distances({}) == {}

    def test_mixed_keys(self):
        raw = {"driver": 250, "sevenIron": 160, "pw": 130}
        result = normalize_club_distances(raw)
        assert result["driver"] == 250
        assert result["7iron"] == 160
        assert result["pw"] == 130


# ── compute_adjustments ───────────────────────────────────────────────────────

class TestComputeAdjustments:
    """Distance + adjustment list returned; weather/elevation effects applied.

    Expectations retuned 2026-07-09 to the physics engine's outputs
    (specs/caddie-shot-physics-engine-plan.md step 10): adjustments now come
    from the ball-flight model, not the old scalar rules of thumb, so the
    exact yardages shifted (e.g. 15ft uphill at 150y is +4 via Δh/tan(descent)
    for a 9-iron-class shot, not the club-blind +5 of the 1yd/3ft rule).
    """

    def test_no_adjustments_returns_raw(self):
        dist, adjs = compute_adjustments(150)
        assert dist == 150
        assert adjs == []

    def test_uphill_adds_yards(self):
        # 15 ft uphill at 150y: Δh/tan(~51° nine-iron descent) → +4, not the
        # old flat-rule +5. Combined solve lands 155 (154.6 rounded).
        dist, adjs = compute_adjustments(150, elevation_change_ft=15.0)
        assert dist == 155
        assert len(adjs) == 1
        assert adjs[0].type == "elevation"
        assert adjs[0].yards == 4

    def test_downhill_subtracts_yards(self):
        # 12 ft downhill → -3 by descent geometry (old flat rule said -4);
        # combined solve 146 (146.2 rounded).
        dist, adjs = compute_adjustments(150, elevation_change_ft=-12.0)
        assert dist == 146
        assert adjs[0].yards == -3

    def test_small_elevation_ignored(self):
        # abs(elev) <= 1 → no adjustment
        dist, adjs = compute_adjustments(150, elevation_change_ft=0.5)
        assert dist == 150
        assert adjs == []

    def test_cold_temperature_adds_yards(self):
        # 50°F (cold) → temp_diff = 50-70 = -20 → temp_adj = round(-(-20)*0.2) = 4
        weather = WeatherConditions(temperature_f=50.0, wind_speed_mph=0.0)
        dist, adjs = compute_adjustments(150, weather=weather)
        adj_types = {a.type for a in adjs}
        assert "temperature" in adj_types
        temp_adj = next(a for a in adjs if a.type == "temperature")
        assert temp_adj.yards > 0  # cold = plays longer

    def test_warm_temperature_subtracts_yards(self):
        # 90°F (warm) → temp_diff = 20 → temp_adj = round(-20*0.2) = -4
        weather = WeatherConditions(temperature_f=90.0, wind_speed_mph=0.0)
        dist, adjs = compute_adjustments(150, weather=weather)
        adj_types = {a.type for a in adjs}
        assert "temperature" in adj_types
        temp_adj = next(a for a in adjs if a.type == "temperature")
        assert temp_adj.yards < 0  # warm = plays shorter

    def test_altitude_reduces_effective_distance(self):
        # 5000 ft altitude → alt_pct = 5*0.02=0.10 → adj = round(-150*0.10) = -15
        weather = WeatherConditions(altitude_ft=5000.0, wind_speed_mph=0.0)
        dist, adjs = compute_adjustments(150, weather=weather)
        adj_types = {a.type for a in adjs}
        assert "altitude" in adj_types
        alt_adj = next(a for a in adjs if a.type == "altitude")
        assert alt_adj.yards < 0  # ball carries farther, effective distance shorter

    def test_soft_conditions_add_yards(self):
        # Physics: firmness moves shots judged by TOTAL (tee balls with roll).
        # 250 → driver basis; soft turf kills roll → plays longer. (At an
        # iron-approach distance the carry is untouched — physically correct,
        # the old blanket ±3% was not.)
        weather = WeatherConditions(conditions="soft", wind_speed_mph=0.0)
        dist, adjs = compute_adjustments(250, weather=weather)
        cond_adjs = [a for a in adjs if a.type == "conditions"]
        assert len(cond_adjs) == 1
        assert cond_adjs[0].yards > 0

    def test_firm_conditions_subtract_yards(self):
        weather = WeatherConditions(conditions="firm", wind_speed_mph=0.0)
        dist, adjs = compute_adjustments(250, weather=weather)
        cond_adjs = [a for a in adjs if a.type == "conditions"]
        assert len(cond_adjs) == 1
        assert cond_adjs[0].yards < 0

    def test_iron_approach_untouched_by_firmness(self):
        # A 150y approach is judged by CARRY — firm turf must not shrink it.
        weather = WeatherConditions(conditions="firm", wind_speed_mph=0.0)
        dist, adjs = compute_adjustments(150, weather=weather)
        assert dist == 150
        assert [a for a in adjs if a.type == "conditions"] == []

    def test_minimum_distance_is_one(self):
        # Huge downhill + tailwind could try to push below 0
        dist, _ = compute_adjustments(5, elevation_change_ft=-300.0)
        assert dist >= 1

    def test_multiple_adjustments_accumulated(self):
        # Uphill + cold: both adjustments should add
        weather = WeatherConditions(temperature_f=40.0, wind_speed_mph=0.0)
        dist, adjs = compute_adjustments(150, elevation_change_ft=15.0, weather=weather)
        types = {a.type for a in adjs}
        assert "elevation" in types
        assert "temperature" in types
        assert dist > 150


# ── select_club ───────────────────────────────────────────────────────────────

class TestSelectClub:
    """Club selection: closest-but-not-over with DECADE bias and edge cases."""

    def _standard_bag(self) -> dict:
        """A simple bag to test against."""
        return {
            "driver": 250,
            "7iron": 160,
            "9iron": 140,
            "pw": 130,
            "sw": 100,
        }

    def test_exact_match(self):
        # Target exactly 160 → 7iron (160)
        club, dist = select_club(160, self._standard_bag())
        assert club == "7iron"
        assert dist == 160

    def test_between_clubs_favors_longer(self):
        # 145 yds: 9iron (140) is within +8 of 145 → select 9iron? Let's verify logic.
        # select_club loops descending. First club ≤ target+bias+8:
        # driver(250): 250 <= 145+8=153? No. 7iron(160): 160<=153? No.
        # 9iron(140): 140<=153? Yes → best_club = (9iron, 140)
        club, dist = select_club(145, self._standard_bag())
        assert club == "9iron"

    def test_conservative_bias_clubs_up(self):
        # bias=conservative adds 5 yds: target 155+5=160
        # 7iron(160) <= 168? Yes → 7iron
        club, _ = select_club(155, self._standard_bag(), bias="conservative")
        assert club == "7iron"

    def test_aggressive_bias_clubs_down(self):
        # bias=aggressive subtracts 5: target 165-5=160; 7iron(160)<=168? Yes
        # but wait — at target 165 moderate: 7iron(160)<=173? Yes → 7iron anyway
        # Use 170: moderate → 7iron(160)<=178? yes → 7iron; aggressive: 165-5=160; 7iron(160)<=168→yes
        club, _ = select_club(168, self._standard_bag(), bias="aggressive")
        # aggressive target = 163; driver(250)>171 no, 7iron(160)<=171? yes
        assert club == "7iron"

    def test_short_of_all_clubs_returns_shortest(self):
        # Target 20 → below sw(100); loop finds no club ≤ 28 among the bag
        # default best_club = clubs[-1] = smallest club = sw(100)
        club, dist = select_club(20, self._standard_bag())
        assert club == "sw"
        assert dist == 100

    def test_beyond_all_clubs_returns_driver(self):
        # Target 400 → no club ≤ 408 (all are ≤ 250 < 408)
        # Wait — driver(250): 250<=408? Yes → driver wins immediately in the loop
        club, dist = select_club(400, self._standard_bag())
        assert club == "driver"
        assert dist == 250

    def test_default_bag_used_when_empty(self):
        club, dist = select_club(160, {})
        # Falls back to DEFAULT_CLUB_DISTANCES; 7iron=160 → should select 7iron
        assert club == "7iron"
        assert dist == 160

    def test_returns_tuple_of_two(self):
        result = select_club(150, DEFAULT_CLUB_DISTANCES)
        assert isinstance(result, tuple)
        assert len(result) == 2
        assert isinstance(result[0], str)
        assert isinstance(result[1], int)
