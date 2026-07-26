"""Unit tests for the approach-solve engine fix (specs/caddie-approach-solve-
plan.md) — pure, no DB/network. Proves DEFECT 1 (player-relative carry +
suppression), DEFECT 2 (miss-side evidence), and DEFECT 3 (wind binding),
plus the approach-frame gate itself (§0) and the `carries_payload` from-you
frame (§1.5).
"""

from __future__ import annotations

from app.caddie.aim_point import (
    APPROACH_FRAME_MIN_TEE_OFFSET_YDS,
    EN_ROUTE_CLEARED_SUPPRESS_YDS,
    EnRouteFromPlayer,
    compute_aim_point,
    compute_miss_side,
    en_route_from_player,
    generate_recommendation,
)
from app.caddie.guide_writer import _has_side_flip
from app.caddie.session import RoundSession
from app.caddie.tools import carries_payload, conditions_payload
from app.caddie.types import (
    Hazard,
    HoleIntelligence,
    WeatherConditions,
)


# ── helpers (mirrors test_aim_point.py's fixtures) ──────────────────────────


def _make_hole(
    hazards: list | None = None,
    par: int = 4,
    yards: int | None = 400,
) -> HoleIntelligence:
    return HoleIntelligence(hole_number=1, par=par, yards=yards, hazards=hazards or [])


def _carry_hazard(type_: str, line_side: str, carry: int, severity: str = "moderate", distance: float = 15.0) -> Hazard:
    return Hazard(type=type_, side="front" if line_side == "center" else line_side,
                  line_side=line_side, carry_yards=carry,
                  penalty_severity=severity, distance_from_green=distance)


_WIDE_BAG: dict[str, int] = {
    "driver": 300, "3wood": 260, "5iron": 190, "7iron": 160, "9iron": 140, "pw": 130, "sw": 100,
}


# ── §0 approach frame gate ───────────────────────────────────────────────


def test_approach_frame_min_tee_offset_constant():
    assert APPROACH_FRAME_MIN_TEE_OFFSET_YDS == 25


def test_en_route_cleared_suppress_constant():
    assert EN_ROUTE_CLEARED_SUPPRESS_YDS == 20


def test_hole_yards_none_never_approach_framed():
    hole = HoleIntelligence(hole_number=1, par=4, yards=None, hazards=[
        _carry_hazard("water", "center", 140, severity="severe"),
    ])
    erp = en_route_from_player(hole, 155)
    assert erp.approach_framed is False
    assert erp.tee_offset == 0

    aim = compute_aim_point(hole, None, distance_yards=155)
    assert aim.description == "Aim at the flag"


# ── DEFECT 1 — Black-4 repro (hole 517 / dist 182 / bunker carry 495) ─────


def test_black4_repro_aim_and_reasoning_speak_the_same_from_here_number():
    hole = _make_hole(par=5, yards=517, hazards=[
        _carry_hazard("bunker", "center", 495, severity="moderate", distance=22.0),
    ])
    aim = compute_aim_point(hole, None, distance_yards=182)
    assert aim.description == "Aim at the flag — carry the bunker about 160 from you"

    rec = generate_recommendation(hole, 182, _WIDE_BAG, handicap=15)
    assert rec.shot_kind == "approach"
    assert rec.aim_point.description == "Aim at the flag — carry the bunker about 160 from you"
    reasoning_text = " ".join(rec.reasoning)
    assert "Bunker about 160 out between you and the green — take enough club to carry it" in reasoning_text

    # RED-against-the-OLD-wiring proof: the raw tee-frame carry (495) must
    # NEVER surface in either the aim description or the reasoning line.
    assert "495" not in rec.aim_point.description
    assert "495" not in reasoning_text


# ── DEFECT 1 — Pebble-3 repro (hole 404 / dist 179 / carry 230 -> suppressed) ─


def test_pebble3_repro_suppressed_never_resurrects_green_light():
    hole = _make_hole(par=4, yards=404, hazards=[
        _carry_hazard("bunker", "center", 230, severity="moderate", distance=174.0),
    ])
    aim = compute_aim_point(hole, None, distance_yards=179)
    assert aim.description == "Aim at the flag"
    assert "no trouble" not in aim.description.lower()
    assert "green light" not in aim.description.lower()

    rec = generate_recommendation(hole, 179, _WIDE_BAG, handicap=15)
    assert rec.shot_kind == "approach"
    assert rec.aim_point.description == "Aim at the flag"
    assert "green light" not in rec.aim_point.description.lower()
    reasoning_text = " ".join(rec.reasoning)
    assert "230" not in reasoning_text
    assert "between you and the green" not in reasoning_text


# ── Offset boundary: 24 (tee-frame, byte-identical) vs 25 (approach-framed) ──


def test_offset_24_tee_frame_byte_identical_offset_25_approach_framed():
    hole = _make_hole(par=4, yards=300, hazards=[
        _carry_hazard("bunker", "center", 250, severity="moderate", distance=50.0),
    ])
    below = compute_aim_point(hole, None, distance_yards=276)  # tee_offset 24
    at = compute_aim_point(hole, None, distance_yards=275)     # tee_offset 25

    assert below.description == "Aim at the flag — carry the bunker at 250"
    assert at.description == "Aim at the flag — carry the bunker about 225 from you"


# ── Lateral-only en-route trouble corrected to the from-here frame ─────────


def test_lateral_only_en_route_corrected_to_from_here():
    hole = _make_hole(par=4, yards=400, hazards=[
        Hazard(type="water", side="right", line_side="right", carry_yards=300,
               penalty_severity="severe", distance_from_green=20.0),
    ])
    aim = compute_aim_point(hole, None, distance_yards=150)
    assert aim.description == "Aim at the flag — water right about 50 from you, favor the left side"


# ── Behind-player exclusion: raw predicate already empty -> "no trouble" stands ──


def test_hazard_behind_player_on_approach_turn_keeps_no_trouble_honest():
    # hole 400y, dist 150 (offset 250) — lone hazard carry 200, already
    # behind the player per en_route_carry_hazards' OWN predicate (not the
    # new suppression band) -> "green light, no trouble" remains TRUE.
    hole = _make_hole(par=4, yards=400, hazards=[
        _carry_hazard("water", "center", 200, severity="severe", distance=200.0),
    ])
    aim = compute_aim_point(hole, None, distance_yards=150)
    assert aim.description == "Aim at the flag — green light, no trouble"

    erp = en_route_from_player(hole, 150)
    assert erp.en_route == []
    assert erp.suppressed is False  # nothing was suppressed — it was never en-route


def test_en_route_from_player_suppressed_flag_true_when_cleared_hazard_dropped():
    hole = _make_hole(par=4, yards=404, hazards=[
        _carry_hazard("bunker", "center", 230, severity="moderate", distance=174.0),
    ])
    erp = en_route_from_player(hole, 179)
    assert erp.approach_framed is True
    assert erp.en_route == []
    assert erp.suppressed is True


def test_from_here_verbatim_when_not_approach_framed():
    hazard = _carry_hazard("water", "center", 148, severity="severe")
    tee_framed = EnRouteFromPlayer(en_route=[hazard], tee_offset=0, approach_framed=False)
    assert tee_framed.from_here(hazard) == 148  # never rounded — byte-identical


# ── DEFECT 2 — miss-side evidence ───────────────────────────────────────


def test_miss_side_evidence_names_bunker_and_guarded_side_when_approach_framed():
    hole = _make_hole(par=4, yards=400, hazards=[
        Hazard(type="bunker", side="left", line_side="left", penalty_severity="severe", distance_from_green=15.0),
    ])
    miss = compute_miss_side(hole, None, distance_yards=150)  # offset 250
    assert miss.preferred == "right"
    assert "bunker" in miss.description.lower()
    assert "left" in miss.description.lower()


def test_miss_side_no_distance_yards_stays_byte_identical():
    hole = _make_hole(par=4, yards=400, hazards=[
        Hazard(type="bunker", side="left", line_side="left", penalty_severity="severe", distance_from_green=15.0),
    ])
    miss = compute_miss_side(hole, None)
    assert miss.description == "Miss right — safe side, easy recovery"


def test_miss_side_tee_framed_offset_below_threshold_stays_byte_identical():
    hole = _make_hole(par=4, yards=400, hazards=[
        Hazard(type="bunker", side="left", line_side="left", penalty_severity="severe", distance_from_green=15.0),
    ])
    miss = compute_miss_side(hole, None, distance_yards=380)  # offset 20 < 25
    assert miss.description == "Miss right — safe side, easy recovery"


def test_miss_side_preferred_avoid_selection_unchanged_by_distance_yards():
    """Mirrors TestComputeMissSide's matrix — SELECTION (preferred + avoid
    prefix) must be identical whether or not distance_yards/approach framing
    is supplied; only the description TEXT is enriched."""
    matrix = [
        (Hazard(type="water", side="right", penalty_severity="death", distance_from_green=5.0), "left"),
        (Hazard(type="water", side="left", penalty_severity="death", distance_from_green=5.0), "right"),
        (Hazard(type="water", side="front", penalty_severity="death", distance_from_green=5.0), "long"),
    ]
    avoid_map = {"left": "right", "right": "left", "short": "long", "long": "short"}
    for hazard, expected_preferred in matrix:
        hole = _make_hole(hazards=[hazard])
        miss_tee = compute_miss_side(hole, None)
        miss_approach = compute_miss_side(hole, None, distance_yards=150)  # offset 250
        assert miss_tee.preferred == expected_preferred
        assert miss_approach.preferred == expected_preferred
        assert miss_approach.avoid.startswith(f"Don't miss {avoid_map[expected_preferred]}")


def test_miss_side_no_hazard_text_byte_identical_with_distance_yards():
    hole = _make_hole(hazards=[])
    miss = compute_miss_side(hole, None, distance_yards=150)
    assert miss.description == "No major trouble — miss short for an easy chip"
    assert miss.avoid == "Avoid going long — harder to get up and down"


def test_miss_side_enriched_text_passes_side_flip_check():
    hole = _make_hole(par=4, yards=400, hazards=[
        Hazard(type="bunker", side="left", line_side="left", penalty_severity="severe", distance_from_green=15.0),
    ])
    miss = compute_miss_side(hole, None, distance_yards=150)
    hazards_by_type = {"bunker": [("left", 0)]}
    assert not _has_side_flip([miss.description], hazards_by_type)


# ── cycle-3 commit 4 (Target 2a) — honest front/back on approach-framed
#    both-open (no evidence-free "safe side" claim) ─────────────────────────
#
# A hazard mapped on the hole but OUTSIDE the <=20y greenside evidence
# window (e.g. bethpage h18's short trouble just past that window) makes
# BOTH sides look "open" to the evidence-scanning code — the OLD
# unconditional "safe side, easy recovery" claim there was evidence-free,
# and can be visibly wrong. This must degrade honestly ONLY on an
# approach-framed turn; a tee-framed/no-distance_yards call (every existing
# caller) stays byte-identical to today.

_FAR_HAZARD = Hazard(
    type="bunker", side="left", line_side="left", penalty_severity="severe", distance_from_green=150.0,
)


def test_miss_side_both_open_tee_framed_stays_byte_identical_pre_change_text():
    """(a) Pin FIRST, against CURRENT (pre- and post-commit-4) behavior: not
    approach-framed (no distance_yards at all) -> the old unconditional
    "safe side, easy recovery" text, untouched."""
    hole = _make_hole(par=4, yards=400, hazards=[_FAR_HAZARD])
    miss = compute_miss_side(hole, None)
    assert miss.description == "Miss short — safe side, easy recovery"
    assert miss.avoid == "Don't miss long — open"


def test_miss_side_both_open_offset_below_threshold_stays_byte_identical_pre_change_text():
    """(a) Pin: distance_yards given but offset < APPROACH_FRAME_MIN_TEE_
    OFFSET_YDS (tee-framed) -> same old text, untouched."""
    hole = _make_hole(par=4, yards=400, hazards=[_FAR_HAZARD])
    miss = compute_miss_side(hole, None, distance_yards=380)  # offset 20 < 25
    assert miss.description == "Miss short — safe side, easy recovery"
    assert miss.avoid == "Don't miss long — open"


def test_miss_side_avoid_side_evidence_branch_stays_byte_identical_when_approach_framed():
    """(b) Pin: approach-framed WITH avoid-side evidence (the pre-existing
    "X guards Y — miss Z" branch) is untouched by this commit — only the
    both-open sub-branch below is new."""
    hole = _make_hole(par=4, yards=400, hazards=[
        Hazard(type="bunker", side="left", line_side="left", penalty_severity="severe", distance_from_green=15.0),
    ])
    miss = compute_miss_side(hole, None, distance_yards=150)  # offset 250
    assert miss.description == "Bunker guards the left — miss right"
    assert miss.avoid == "Don't miss left — bunker"


def test_miss_side_approach_framed_both_open_gets_honest_no_strong_side_text():
    """(c) The new honest degrade: approach-framed + both sides open (no
    evidence anywhere near the green) -> no unsupported "safe" claim."""
    hole = _make_hole(par=4, yards=400, hazards=[_FAR_HAZARD])
    miss = compute_miss_side(hole, None, distance_yards=150)  # offset 250 -> approach_framed
    assert miss.description == "No strong miss side mapped — middle of the green, two-putt range"
    assert miss.avoid == "No mapped trouble tight to the green"
    assert "safe" not in miss.description.lower()
    assert "safe" not in miss.avoid.lower()


def test_miss_side_approach_framed_both_open_wording_is_hazard_and_side_word_free():
    """Wording constraints (spec): no hazard nouns (`_HAZARD_PATTERNS` would
    false-red a synth that echoes "no water"), no left/right side word next
    to a hazard noun (`_has_side_flip`'s proximity scan), never passes
    `_has_side_flip` as a false claim."""
    hole = _make_hole(par=4, yards=400, hazards=[_FAR_HAZARD])
    miss = compute_miss_side(hole, None, distance_yards=150)
    for forbidden in ("water", "bunker", "trees", "ob", "left", "right"):
        assert forbidden not in miss.description.lower()
        assert forbidden not in miss.avoid.lower()
    assert not _has_side_flip([miss.description, miss.avoid], {"bunker": [("left", 0)]})


def test_miss_side_approach_framed_both_open_preferred_avoid_fields_unchanged():
    """(d) `preferred`/`avoid` SELECTION fields are identical whether or not
    the turn is approach-framed — only the description/avoid TEXT changes."""
    hole = _make_hole(par=4, yards=400, hazards=[_FAR_HAZARD])
    miss_tee = compute_miss_side(hole, None)
    miss_approach = compute_miss_side(hole, None, distance_yards=150)
    assert miss_tee.preferred == miss_approach.preferred
    assert miss_tee.description != miss_approach.description  # text DID change (the fix)


def test_around_the_green_p2_line_present_on_approach_framed_reachable_turn():
    hole = _make_hole(par=4, yards=400, hazards=[
        Hazard(type="bunker", side="left", line_side="left", penalty_severity="severe", distance_from_green=15.0),
    ])
    rec = generate_recommendation(hole, 150, _WIDE_BAG, handicap=15)
    assert rec.shot_kind == "approach"
    assert any(r.startswith("Around the green:") for r in rec.reasoning)
    assert any("bunker" in r.lower() and "left" in r.lower() for r in rec.reasoning if r.startswith("Around the green:"))


def test_around_the_green_p2_line_absent_on_tee_framed_turn():
    hole = _make_hole(par=3, yards=155, hazards=[
        Hazard(type="bunker", side="left", line_side="left", penalty_severity="severe", distance_from_green=15.0),
    ])
    rec = generate_recommendation(hole, 155, _WIDE_BAG, handicap=15)
    assert not any(r.startswith("Around the green:") for r in rec.reasoning)


# ── DEFECT 3 — wind binding ──────────────────────────────────────────────


def test_wind_binding_p1_line_present_on_approach_framed_into_wind():
    hole = _make_hole(par=5, yards=517, hazards=[])
    weather = WeatherConditions(wind_speed_mph=20.0, wind_direction=0, temperature_f=70.0)
    rec = generate_recommendation(hole, 182, _WIDE_BAG, handicap=15, weather=weather, shot_bearing=0.0)

    assert rec.shot_kind == "approach"
    wind_lines = [r for r in rec.reasoning if r.startswith("Wind is real here")]
    assert len(wind_lines) == 1, rec.reasoning
    assert str(rec.target_yards) in wind_lines[0]
    assert str(rec.raw_yards) in wind_lines[0]


def test_wind_binding_absent_when_calm():
    hole = _make_hole(par=5, yards=517, hazards=[])
    rec = generate_recommendation(hole, 182, _WIDE_BAG, handicap=15)
    assert not any(r.startswith("Wind is real here") for r in rec.reasoning)


def test_wind_binding_absent_on_competition_legal():
    hole = _make_hole(par=5, yards=517, hazards=[])
    weather = WeatherConditions(wind_speed_mph=20.0, wind_direction=0)
    rec = generate_recommendation(
        hole, 182, _WIDE_BAG, handicap=15, weather=weather, shot_bearing=0.0, competition_legal=True,
    )
    assert not any(r.startswith("Wind is real here") for r in rec.reasoning)
    assert rec.adjustments == []


def test_wind_binding_absent_when_tee_framed_despite_strong_wind():
    hole = _make_hole(par=3, yards=182, hazards=[])
    weather = WeatherConditions(wind_speed_mph=20.0, wind_direction=0)
    rec = generate_recommendation(hole, 182, _WIDE_BAG, handicap=15, weather=weather, shot_bearing=0.0)
    assert not any(r.startswith("Wind is real here") for r in rec.reasoning)


# ── §1.5 carries_payload(from_distance_yards=...) ───────────────────────


def _carries_session(hazards, club_distances=None) -> RoundSession:
    intel = _make_hole(par=5, yards=517, hazards=hazards)
    return RoundSession(
        round_id="r1", user_id="u1", current_hole=1,
        hole_intel={1: intel}, club_distances=club_distances or {},
    )


def test_carries_payload_default_arg_byte_identical():
    hazards = [_carry_hazard("bunker", "center", 495, severity="moderate", distance=22.0)]
    session = _carries_session(hazards)
    without = carries_payload(session, 1)
    with_none = carries_payload(session, 1, from_distance_yards=None)
    assert without == with_none
    assert "carry_from_you_yards" not in without["carries"][0]


def test_carries_payload_from_you_numbers_and_cleared_hazard_drop():
    hazards = [
        _carry_hazard("bunker", "center", 495, severity="moderate", distance=22.0),  # from-here 160
        _carry_hazard("water", "left", 340, severity="moderate", distance=177.0),    # from-here 5 -> dropped
    ]
    session = _carries_session(hazards, club_distances={"7iron": 160, "9iron": 140})
    payload = carries_payload(session, 1, from_distance_yards=182)  # offset 335

    types_and_carries = {(c["type"], c["carry_from_you_yards"]) for c in payload["carries"]}
    assert types_and_carries == {("bunker", 160)}
    bunker = next(c for c in payload["carries"] if c["type"] == "bunker")
    assert bunker["carry_yards"] == 495  # raw tee-frame carry preserved, never overwritten
    # clubs_that_clear/clubs_short_of_it computed against the FROM-YOU (160) number.
    assert bunker["clubs_that_clear"] == ["7 Iron"]
    assert bunker["clubs_short_of_it"] == ["9 Iron"]


def test_carries_payload_clubs_that_clear_uses_from_you_number():
    hazards = [_carry_hazard("bunker", "center", 495, severity="moderate", distance=22.0)]  # from-here 160
    session = _carries_session(hazards, club_distances={"7iron": 170, "9iron": 140})
    payload = carries_payload(session, 1, from_distance_yards=182)
    bunker = payload["carries"][0]
    assert bunker["carry_from_you_yards"] == 160
    assert bunker["clubs_that_clear"] == ["7 Iron"]
    assert bunker["clubs_short_of_it"] == ["9 Iron"]


def test_carries_payload_tee_framed_offset_below_threshold_omits_from_you_key():
    hazards = [_carry_hazard("bunker", "center", 250, severity="moderate", distance=50.0)]
    session = _carries_session(hazards)
    # hole yards=517, distance=495 -> offset 22 < APPROACH_FRAME_MIN_TEE_OFFSET_YDS (25).
    payload = carries_payload(session, 1, from_distance_yards=495)
    assert "carry_from_you_yards" not in payload["carries"][0]
    assert payload["carries"][0]["carry_yards"] == 250


# ── B1 fix (eng-lead/fable review) — positioning turns get from-you carries
# too, and the validator must not falsely RED a faithful one ──────────────


def test_b1_positioning_carries_from_you_repro_matches_check_numbers_close():
    """Reviewer's repro: 600y hole, player 320y out -> green out of reach
    (shot_kind="positioning"), water carry_yards 400 (tee-frame) -> the
    ground-truth CARRIES section renders "about 120y from you to carry"
    (carries_payload re-frames on PURE GEOMETRY, any shot_kind). The
    det-check must PASS a faithful "120" answer — before the fix it falsely
    REDed here because `check_numbers_close` only learned from-here numbers
    when `shot_kind == "approach"`."""
    from tests.eval.caddie_bench import harness as bench_harness

    hazards = [_carry_hazard("water", "left", 400, severity="severe", distance=200.0)]
    hole = _make_hole(par=5, yards=600, hazards=hazards)
    bag = {"driver": 260, "3wood": 240, "5iron": 190}

    rec = generate_recommendation(hole, 320, bag, handicap=15)
    assert rec.shot_kind == "positioning", "sanity: this repro requires an out-of-reach turn"

    session = RoundSession(
        round_id="r1", user_id="u1", current_hole=1, hole_intel={1: hole}, club_distances=bag,
    )
    carries = carries_payload(session, 1, from_distance_yards=320)
    from_you = next(c["carry_from_you_yards"] for c in carries["carries"] if c["type"] == "water")
    assert from_you == 120  # 400 - (600 - 320) = 120, matches the reviewer's repro exactly

    good_answer = f"3 wood, lay up short — water about {from_you} from you to carry."
    hazards_payload = [h.model_dump() for h in hole.hazards]
    result = bench_harness.check_numbers_close(good_answer, hazards_payload, rec, bag, hole_yards=600)
    assert result.passed, f"a faithful from-you carry on a positioning turn must PASS ({result.detail})"


# ── §1.1 conditions_payload(from_distance_yards=...) — hazards_line reframe
# (caddie-bench-cycle2-plan.md §1, the degrade-spike root-cause fix) ───────


def _conditions_session(hazards, yards=517) -> RoundSession:
    intel = _make_hole(par=5, yards=yards, hazards=hazards)
    return RoundSession(round_id="r1", user_id="u1", current_hole=1, hole_intel={1: intel}, club_distances={})


def test_conditions_payload_default_arg_byte_identical():
    hazards = [_carry_hazard("bunker", "center", 495, severity="moderate", distance=22.0)]
    session = _conditions_session(hazards)
    without = conditions_payload(session, 1)
    with_none = conditions_payload(session, 1, from_distance_yards=None)
    assert without == with_none
    assert "hazards_line_frame" not in without
    assert without["hazards_line"] == "Hole 1 hazards: bunker C 495y"


def test_conditions_payload_no_intel_honest_empty():
    """Edge case 1: no hole_intel at all -> tee-frame output (empty), no
    crash, no frame key."""
    session = RoundSession(round_id="r1", user_id="u1", current_hole=1, hole_intel={}, club_distances={})
    out = conditions_payload(session, 1, from_distance_yards=180)
    assert "hazards_line_frame" not in out
    assert out["hazards_line"] is None


def test_conditions_payload_intel_yards_none_honest_empty():
    """Edge case 1b: intel present but yards unmapped -> tee-frame, no crash."""
    hazards = [_carry_hazard("bunker", "center", 250)]
    session = _conditions_session(hazards, yards=None)
    out = conditions_payload(session, 1, from_distance_yards=180)
    assert "hazards_line_frame" not in out
    assert out["hazards_line"] == "Hole 1 hazards: bunker C 250y"


def test_conditions_payload_zero_hazard_hole_stays_none_regardless_of_framing():
    session = _conditions_session([])
    out = conditions_payload(session, 1, from_distance_yards=182)  # offset 335, approach-framed
    assert out["hazards_line"] is None
    assert "hazards_line_frame" not in out  # `if intel.hazards:` gate never entered


def test_conditions_payload_offset_boundary_24_tee_25_framed():
    """Edge case 2: same APPROACH_FRAME_MIN_TEE_OFFSET_YDS boundary as
    carries_payload — offset 24 stays tee-framed (byte-identical), offset 25
    frames."""
    hazards = [_carry_hazard("bunker", "center", 250, distance=50.0)]
    session = _conditions_session(hazards)
    below = conditions_payload(session, 1, from_distance_yards=493)  # offset 24
    at = conditions_payload(session, 1, from_distance_yards=492)  # offset 25
    assert "hazards_line_frame" not in below
    assert below["hazards_line"] == "Hole 1 hazards: bunker C 250y"
    assert at.get("hazards_line_frame") == "from_you"


def test_conditions_payload_gps_beyond_the_card_clamps_to_tee_frame():
    """Edge case 3: from_distance_yards > intel.yards -> max(0, ...) clamps
    offset to 0 -> tee frame (mirrors carries_payload)."""
    hazards = [_carry_hazard("bunker", "center", 250, distance=50.0)]
    session = _conditions_session(hazards)
    out = conditions_payload(session, 1, from_distance_yards=600)  # beyond the 517y card
    assert "hazards_line_frame" not in out
    assert out["hazards_line"] == "Hole 1 hazards: bunker C 250y"


def test_conditions_payload_suppression_and_rounding_parity_with_carries():
    """Edge cases 4+5: the SAME raw-comparison suppression boundary and the
    SAME round(raw/5)*5 expression as carries_payload — a hazard rendered in
    both sections renders the SAME number."""
    hazards = [
        _carry_hazard("bunker", "center", 354, distance=22.0),  # from-here 19 -> dropped (raw < 20)
        _carry_hazard("water", "left", 355, distance=180.0),  # from-here 20 -> kept, rounds to 20
        _carry_hazard("trees", "right", 495, distance=15.0),  # from-here 160 -> rounds to 160
    ]
    session = _conditions_session(hazards)
    offset = 335
    conditions = conditions_payload(session, 1, from_distance_yards=517 - offset)
    carries = carries_payload(session, 1, from_distance_yards=517 - offset)

    assert conditions["hazards_line_frame"] == "from_you"
    assert "bunker" not in conditions["hazards_line"]  # the 19y hazard suppressed
    assert "water L 20y" in conditions["hazards_line"]
    assert "trees R 160y" in conditions["hazards_line"]

    carry_by_type = {c["type"]: c["carry_from_you_yards"] for c in carries["carries"]}
    assert carry_by_type == {"water": 20, "trees": 160}  # bunker also dropped from carries — parity


def test_conditions_payload_all_hazards_suppressed_true_statement():
    """Edge case 6: every mapped hazard suppressed -> hazards_line "" + frame
    key -> the honest "every mapped hazard is behind you" render (via
    format_strategy_ground_truth), never the false "NONE mapped"."""
    hazards = [_carry_hazard("bunker", "center", 340, distance=20.0)]  # from-here 5 -> dropped
    session = _conditions_session(hazards)
    out = conditions_payload(session, 1, from_distance_yards=182)  # offset 335
    assert out["hazards_line_frame"] == "from_you"
    assert out["hazards_line"] == ""

    from app.caddie.strategy import format_strategy_ground_truth

    payload = {
        "recommendation": {"error": "n/a"},
        "wind_relative": None,
        "conditions": out,
        "carries": {},
        "bend": {},
        "green_read": {},
        "player": {},
        "local_knowledge": "",
        "local_lore": [],
    }
    block = format_strategy_ground_truth(payload)
    assert "every mapped hazard is behind you — nothing between you and the green" in block
    assert "NONE mapped" not in block


def test_conditions_payload_raw_hazards_list_stays_tee_anchored_always():
    """The raw `hazards` list (Hazard.model_dump()s) is NEVER transformed —
    only `hazards_line` reframes. Validators/the bench derive frames from
    raw carries + offset themselves (§1.1)."""
    hazards = [_carry_hazard("bunker", "center", 495, distance=22.0)]
    session = _conditions_session(hazards)
    out = conditions_payload(session, 1, from_distance_yards=182)
    assert out["hazards"][0]["carry_yards"] == 495  # raw, unchanged


def test_ground_truth_tee_turn_hazards_line_byte_identical_no_frame():
    """Tee-turn sibling of the CARRIES byte-identity pin — no
    `hazards_line_frame` key -> today's exact bytes, both branches."""
    from app.caddie.strategy import format_strategy_ground_truth

    hazards = [_carry_hazard("bunker", "center", 250, distance=50.0)]
    session = _conditions_session(hazards)
    tee_conditions = conditions_payload(session, 1)  # no from_distance_yards -> tee turn
    payload = {
        "recommendation": {"error": "n/a"},
        "wind_relative": None,
        "conditions": tee_conditions,
        "carries": {},
        "bend": {},
        "green_read": {},
        "player": {},
        "local_knowledge": "",
        "local_lore": [],
    }
    block = format_strategy_ground_truth(payload)
    assert "Hole 1 hazards: bunker C 250y — the COMPLETE list — there are NO others." in block

    empty_session = _conditions_session([])
    empty_payload = {**payload, "conditions": conditions_payload(empty_session, 1)}
    empty_block = format_strategy_ground_truth(empty_payload)
    assert "Hazards: NONE mapped. Do not name any specific hazard." in empty_block
