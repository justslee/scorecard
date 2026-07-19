"""Unit tests for the honesty/label fixes in
specs/onboarding-bag-caddie-grounding-plan.md §1b/§4 — pure, no DB/network.

Covers:
  1. TestCrossHazardLineClubLabel — cross_hazard_line's club wording is
     parameterized (no hardcoded "driver"), §1b.
  2. TestDriverDispersionGate — the PLAYER-block "Typical driver dispersion"
     line is skipped for a bag that provably has no driver, §1b (minor).
  3. TestStrategyGroundTruthClubDistancesHonesty — format_strategy_ground_truth
     labels an empty bag honestly instead of "player-entered {}"), §4.1.
  4. TestAimPointEmptyBagHonestyLine — generate_recommendation appends the
     "standard club distances" P4 note only when the normalized bag is
     empty, §4.2.
"""

from app.caddie.decade_advice import cross_hazard_line
from app.caddie.types import Hazard, HoleIntelligence
from app.caddie.strategy import format_strategy_ground_truth
from app.caddie.aim_point import generate_recommendation


# ── 1. cross_hazard_line club label (§1b) ─────────────────────────────────


def _center_hazard(carry_yards: int = 250, severity: str = "death") -> Hazard:
    return Hazard(
        type="water",
        side="center",
        penalty_severity=severity,
        carry_yards=carry_yards,
        line_side="center",
    )


class TestCrossHazardLineClubLabel:
    def test_default_still_says_driver_owner_path_unchanged(self):
        """No club_display passed — byte-identical to the owner's existing path."""
        line = cross_hazard_line([_center_hazard()], 250.0)
        assert line == "Water crosses at ~250 — driver brings it in play."

    def test_custom_club_display_replaces_hardcoded_driver(self):
        line = cross_hazard_line([_center_hazard()], 250.0, "3wood")
        assert line == "Water crosses at ~250 — 3wood brings it in play."
        assert "driver" not in line.lower()

    def test_no_driver_bag_club_never_says_driver(self):
        """A no-driver golfer's selected club (e.g. '7 Iron') must appear
        verbatim, never a hardcoded 'driver'."""
        line = cross_hazard_line([_center_hazard()], 250.0, club_display="7 Iron")
        assert line == "Water crosses at ~250 — 7 Iron brings it in play."
        assert "driver" not in line.lower()

    def test_no_candidates_returns_none_regardless_of_club_display(self):
        assert cross_hazard_line([], 250.0, "3wood") is None


# ── 2. driver-dispersion PLAYER-block gate (§1b minor) ────────────────────


class TestDriverDispersionGate:
    DISPERSION_PHRASE = "Typical driver dispersion for this handicap band"

    def test_no_driver_nonempty_bag_skips_dispersion_line(self):
        payload = {"player": {"handicap": 15, "club_distances": {"7 Iron": 150}}}
        out = format_strategy_ground_truth(payload)
        assert self.DISPERSION_PHRASE not in out, out

    def test_driver_in_bag_keeps_dispersion_line(self):
        payload = {
            "player": {"handicap": 15, "club_distances": {"7 Iron": 170, "Driver": 300}},
        }
        out = format_strategy_ground_truth(payload)
        assert self.DISPERSION_PHRASE in out, out

    def test_totally_empty_bag_keeps_dispersion_line(self):
        """No bag at all (not 'no driver specifically') still shows the
        handicap-based reference line — it's honestly labeled 'NOT measured
        for this player' either way."""
        payload = {"player": {"handicap": 15, "club_distances": {}}}
        out = format_strategy_ground_truth(payload)
        assert self.DISPERSION_PHRASE in out, out


# ── 3. format_strategy_ground_truth club-distances honesty (§4.1) ─────────


class TestStrategyGroundTruthClubDistancesHonesty:
    def test_empty_bag_prints_honest_defaults_note_not_player_entered(self):
        payload = {"player": {"handicap": 15, "club_distances": {}}}
        out = format_strategy_ground_truth(payload)
        assert (
            "Club distances: none on file — engine numbers below use "
            "standard-amateur defaults, not this player's measured bag."
        ) in out
        assert "player-entered" not in out
        # Never label an empty dict as the player's own data.
        assert "{}" not in out.split("PLAYER:")[1]

    def test_nonempty_bag_keeps_player_entered_label(self):
        payload = {
            "player": {"handicap": 15, "club_distances": {"7 Iron": 170}},
        }
        out = format_strategy_ground_truth(payload)
        assert 'Club distances (player-entered, still-air): {"7 Iron": 170}.' in out
        assert "none on file" not in out


# ── 4. generate_recommendation empty-bag P4 honesty line (§4.2) ───────────


def _hole() -> HoleIntelligence:
    return HoleIntelligence(hole_number=1, par=4, yards=430, effective_yards=430)


class TestAimPointEmptyBagHonestyLine:
    HONESTY_LINE = (
        "Using standard club distances — set up your bag in Profile for your own numbers"
    )

    def test_empty_bag_appends_honesty_line(self):
        rec = generate_recommendation(_hole(), distance_yards=430, club_distances={})
        assert self.HONESTY_LINE in rec.reasoning

    def test_nonempty_bag_does_not_append_honesty_line(self):
        bag = {"driver": 300, "3wood": 270, "7iron": 170}
        rec = generate_recommendation(_hole(), distance_yards=430, club_distances=bag)
        assert self.HONESTY_LINE not in rec.reasoning

    def test_honesty_line_is_p4_never_displaces_p0_club_line(self):
        """The club/distance-fit line (P0) must still be first even when the
        honesty line is present."""
        rec = generate_recommendation(_hole(), distance_yards=430, club_distances={})
        assert rec.reasoning[0].startswith("Driver ("), rec.reasoning
