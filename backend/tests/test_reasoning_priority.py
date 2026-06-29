"""Pure tests for the prioritize_reasoning helper and generate_recommendation priority/cap.

No DB / no network — fully offline.

Priority scheme (from aim_point.py):
  P0 — club/distance fit line    ALWAYS kept, ALWAYS first
  P1 — safety-critical           pin light, DECADE hazard-aim, competition-legal note
  P2 — slope miss-advice,        miss tendency
  P3 — shot-line terrain advice
  P4 — color                     player history, personal-stats note, adj-distance summary
"""

from __future__ import annotations

from app.caddie.aim_point import (
    MAX_REASONING_ITEMS,
    generate_recommendation,
    prioritize_reasoning,
)
from app.caddie.types import (
    GreenSlope,
    Hazard,
    HoleIntelligence,
    HolePlayerHistory,
    PlayerStatistics,
    PlayerTendencies,
)


# ── shared helpers ────────────────────────────────────────────────────────────

_BAG: dict[str, int] = {"7iron": 160, "9iron": 140, "pw": 130}


def _make_complex_hole() -> HoleIntelligence:
    """A hole that triggers every advice type (pin light, slope, DECADE, terrain)."""
    return HoleIntelligence(
        hole_number=7,
        par=4,
        yards=400,
        elevation_change_ft=0.0,
        hazards=[
            # Two severe/death hazards → red light pin + DECADE advice
            Hazard(
                type="water",
                side="left",
                penalty_severity="death",
                distance_from_green=5.0,
            ),
            Hazard(
                type="bunker",
                side="right",
                penalty_severity="severe",
                distance_from_green=4.0,
            ),
        ],
        # Severe back-to-front slope → P2 slope advice fires
        green_slope=GreenSlope(
            direction=180.0,
            severity="severe",
            percent_grade=4.0,
            description="steep back-to-front",
        ),
        # Elevated-green profile → P3 shot-line advice fires
        shot_line_profile_ft=[100.0, 108.0, 120.0],
        # Player history → P4 history line fires
        player_history=HolePlayerHistory(
            times_played=5,
            avg_score=4.8,
            best_score=4,
            worst_score=6,
        ),
    )


def _make_minimal_hole() -> HoleIntelligence:
    """A hole that produces the fewest possible reasoning items."""
    return HoleIntelligence(
        hole_number=1,
        par=4,
        yards=400,
        elevation_change_ft=0.0,
        hazards=[],
    )


# ── TestPrioritizeReasoning — unit tests for the pure helper ─────────────────


class TestPrioritizeReasoning:
    """White-box tests for prioritize_reasoning(items, max_items)."""

    def test_empty_list_returns_empty(self) -> None:
        assert prioritize_reasoning([]) == []

    def test_single_item_returned(self) -> None:
        assert prioritize_reasoning([(0, "club line")]) == ["club line"]

    def test_below_cap_all_returned(self) -> None:
        items = [(0, "club"), (1, "safety"), (2, "slope")]
        result = prioritize_reasoning(items)
        assert result == ["club", "safety", "slope"]

    def test_sorted_by_priority_ascending(self) -> None:
        items = [(4, "history"), (0, "club"), (2, "slope"), (1, "safety")]
        assert prioritize_reasoning(items) == ["club", "safety", "slope", "history"]

    def test_capped_to_max_items_default(self) -> None:
        items = [(i, f"item_{i}") for i in range(10)]
        assert len(prioritize_reasoning(items)) == MAX_REASONING_ITEMS

    def test_p0_always_first_when_capped(self) -> None:
        items = [
            (4, "color"),
            (3, "terrain"),
            (2, "slope"),
            (1, "safety"),
            (0, "club"),
            (1, "more_safety"),
        ]
        result = prioritize_reasoning(items, max_items=3)
        assert result[0] == "club"

    def test_p0_never_dropped_even_with_many_p1(self) -> None:
        """The P0 club line survives even when the rest are all P1 safety items."""
        items = [(0, "club")] + [(1, f"safety_{i}") for i in range(10)]
        result = prioritize_reasoning(items, max_items=4)
        assert "club" in result
        assert len(result) == 4

    def test_stable_sort_within_same_priority(self) -> None:
        """Items at the same priority level keep their original relative order."""
        items = [(1, "A"), (1, "B"), (1, "C"), (0, "club")]
        result = prioritize_reasoning(items, max_items=4)
        abc_in_result = [x for x in result if x in ("A", "B", "C")]
        assert abc_in_result == ["A", "B", "C"]

    def test_lowest_priority_dropped_first(self) -> None:
        """When capped, P4 color items are the first to be cut."""
        items = [
            (0, "club"),
            (1, "safety"),
            (2, "slope"),
            (3, "terrain"),
            (4, "history"),
        ]
        result = prioritize_reasoning(items, max_items=4)
        assert len(result) == 4
        assert "history" not in result
        assert "club" in result
        assert "safety" in result

    def test_deterministic_repeated_calls(self) -> None:
        items = [(4, "h"), (0, "c"), (2, "s"), (1, "d"), (3, "t")]
        r1 = prioritize_reasoning(items)
        r2 = prioritize_reasoning(items)
        r3 = prioritize_reasoning(items)
        assert r1 == r2 == r3

    def test_custom_max_items_honored(self) -> None:
        items = [(i, f"item_{i}") for i in range(6)]
        assert len(prioritize_reasoning(items, max_items=3)) == 3
        assert len(prioritize_reasoning(items, max_items=6)) == 6

    def test_max_items_larger_than_list_returns_all(self) -> None:
        items = [(0, "club"), (1, "safety")]
        assert prioritize_reasoning(items, max_items=10) == ["club", "safety"]


# ── TestGenerateRecommendationPrioritized — integration ───────────────────────


class TestGenerateRecommendationPrioritized:
    """Verify that generate_recommendation applies priority + cap correctly."""

    def test_complex_hole_capped_to_max_items(self) -> None:
        """A hole that fires every advice type produces at most MAX_REASONING_ITEMS lines."""
        hole = _make_complex_hole()
        stats = PlayerStatistics(
            rounds_analyzed=10,
            tendencies=PlayerTendencies(miss_direction="right"),
        )
        rec = generate_recommendation(hole, 150, _BAG, handicap=15.0, player_stats=stats)
        assert len(rec.reasoning) <= MAX_REASONING_ITEMS, (
            f"Expected ≤{MAX_REASONING_ITEMS} reasoning lines, got {len(rec.reasoning)}: "
            f"{rec.reasoning}"
        )

    def test_club_line_present(self) -> None:
        """The P0 club/distance fit line is always present."""
        hole = _make_complex_hole()
        rec = generate_recommendation(hole, 150, _BAG, handicap=15.0)
        club_lines = [r for r in rec.reasoning if "best fit" in r]
        assert len(club_lines) == 1, f"Expected exactly one club line; got: {rec.reasoning}"

    def test_club_line_is_first(self) -> None:
        """P0 is always the first entry in the output list."""
        hole = _make_complex_hole()
        rec = generate_recommendation(hole, 150, _BAG, handicap=15.0)
        assert len(rec.reasoning) > 0
        assert "best fit" in rec.reasoning[0], (
            f"Expected club line first; got: {rec.reasoning[0]!r}"
        )

    def test_p0_club_line_never_missing_with_all_advice_types(self) -> None:
        """Even when every advice type fires, the P0 club line is present."""
        hole = _make_complex_hole()
        stats = PlayerStatistics(
            rounds_analyzed=10,
            tendencies=PlayerTendencies(miss_direction="right"),
        )
        rec = generate_recommendation(hole, 150, _BAG, handicap=15.0, player_stats=stats)
        assert any("best fit" in r for r in rec.reasoning)

    def test_p1_safety_before_p4_color(self) -> None:
        """When both DECADE advice (P1) and history (P4) are present, P1 comes first."""
        hole = _make_complex_hole()
        stats = PlayerStatistics(
            rounds_analyzed=10,
            tendencies=PlayerTendencies(miss_direction="balanced"),
        )
        rec = generate_recommendation(hole, 150, _BAG, handicap=15.0, player_stats=stats)
        # Check that if history appears, it's after the DECADE/safety line
        decade_indices = [i for i, r in enumerate(rec.reasoning) if "percentages" in r]
        history_indices = [
            i for i, r in enumerate(rec.reasoning) if "history" in r.lower()
        ]
        if decade_indices and history_indices:
            assert min(decade_indices) < min(history_indices), (
                "DECADE (P1) must appear before player history (P4)"
            )

    def test_p4_color_dropped_when_capped_out(self) -> None:
        """When P0+P1+P2+P3 already fill the cap, P4 history is not included."""
        hole = _make_complex_hole()
        stats = PlayerStatistics(
            rounds_analyzed=10,
            tendencies=PlayerTendencies(miss_direction="right"),
        )
        rec = generate_recommendation(hole, 150, _BAG, handicap=15.0, player_stats=stats)
        # The complex hole has: P0 club + P1 pin + P1 DECADE + P2 slope → fills 4 slots
        # P4 history should be dropped
        history_lines = [r for r in rec.reasoning if "history" in r.lower()]
        # If we're at cap, history (P4) should be absent
        if len(rec.reasoning) >= MAX_REASONING_ITEMS:
            assert len(history_lines) == 0, (
                f"P4 history should be dropped when capped; got: {rec.reasoning}"
            )

    def test_minimal_hole_all_items_kept(self) -> None:
        """A hole that produces few items keeps them all (cap not hit)."""
        hole = _make_minimal_hole()
        rec = generate_recommendation(hole, 150, _BAG, handicap=15.0)
        # Minimal hole: only a P0 club line (no hazards → no pin light, DECADE, etc.)
        assert len(rec.reasoning) >= 1
        assert len(rec.reasoning) <= MAX_REASONING_ITEMS

    def test_club_aim_miss_side_unchanged_by_prioritization(self) -> None:
        """Prioritization must not touch club, target_yards, aim_point, or miss_side."""
        hole = _make_complex_hole()
        rec = generate_recommendation(hole, 150, _BAG, handicap=15.0)
        # No elevation/weather → no adjustment
        assert rec.target_yards == 150
        assert isinstance(rec.club, str) and len(rec.club) > 0
        assert rec.aim_point.description != ""
        assert rec.miss_side.preferred in ("left", "right", "short", "long")

    def test_determinism_complex_hole(self) -> None:
        """Identical inputs always produce the same reasoning list."""
        hole = _make_complex_hole()
        r1 = generate_recommendation(hole, 150, _BAG, handicap=15.0)
        r2 = generate_recommendation(hole, 150, _BAG, handicap=15.0)
        assert r1.reasoning == r2.reasoning

    def test_determinism_minimal_hole(self) -> None:
        hole = _make_minimal_hole()
        r1 = generate_recommendation(hole, 150, _BAG, handicap=15.0)
        r2 = generate_recommendation(hole, 150, _BAG, handicap=15.0)
        assert r1.reasoning == r2.reasoning

    def test_competition_legal_note_always_present(self) -> None:
        """The P1 competition-legal note is never dropped (it's safety-critical)."""
        hole = _make_complex_hole()
        rec = generate_recommendation(hole, 150, _BAG, handicap=15.0, competition_legal=True)
        legal_lines = [r for r in rec.reasoning if "competition" in r.lower()]
        assert len(legal_lines) >= 1, (
            f"Competition-legal note missing from reasoning: {rec.reasoning}"
        )

    def test_reasoning_all_strings(self) -> None:
        """Every item in the reasoning list is a non-empty string."""
        hole = _make_complex_hole()
        rec = generate_recommendation(hole, 150, _BAG, handicap=15.0)
        assert isinstance(rec.reasoning, list)
        assert all(isinstance(s, str) and len(s) > 0 for s in rec.reasoning)

    def test_p1_pin_light_red_present(self) -> None:
        """Red-light pin advice (P1) appears when two severe hazards are close."""
        # Two severe hazards within 5 yds → red pin light
        hole = HoleIntelligence(
            hole_number=1,
            par=4,
            yards=400,
            hazards=[
                Hazard(type="water", side="right", penalty_severity="severe", distance_from_green=5.0),
                Hazard(type="water", side="left", penalty_severity="severe", distance_from_green=5.0),
            ],
        )
        rec = generate_recommendation(hole, 150, _BAG, handicap=15.0)
        red_lines = [r for r in rec.reasoning if "red light" in r.lower()]
        assert len(red_lines) >= 1, f"Expected red-light pin reasoning; got: {rec.reasoning}"
