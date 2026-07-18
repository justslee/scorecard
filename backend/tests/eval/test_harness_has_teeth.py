"""The #1 deliverable (specs/caddie-advice-eval-plan.md §7): proves every
check FAMILY in `checks.py` can actually go RED. Audit warning this whole
harness is built around: "an eval that can't fail is worse than none."

Runs in Tier 1 (CI, offline) — every mutant here is internal (a stripped
string, a stubbed function, a fabricated line), never a source edit. The
one-time MANUAL mutation drill against the real `routes/caddie.py` source
(strip `{OBSERVED_REALITY_RULE}`, watch `pytest tests/eval -x` go red, revert)
is documented in `README.md` and was performed once by the builder — see the
PR description for the captured red output.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import dataclasses  # noqa: E402
import pathlib  # noqa: E402

from app.caddie.guide_writer import validate_guide  # noqa: E402
from app.caddie.hazards import HAZARD_GROUNDING_RULE  # noqa: E402
from app.caddie.types import Hazard, HoleStrategyGuide  # noqa: E402
from app.caddie.voice_prompts import INPUT_GROUNDING_RULE, OBSERVED_REALITY_RULE  # noqa: E402

from tests.eval import checks as checks_mod  # noqa: E402
from tests.eval.schema import (  # noqa: E402
    Tier1Check,
    Tier1CheckName,
    Tier2DeterministicCheckName,
)
from tests.eval.test_golden_tier1 import SCENARIOS, _build_prompts  # noqa: E402


def _scenario(scenario_id: str):
    return next(s for s in SCENARIOS if s.id == scenario_id)


# ── 1. Pre-fix prompt mutants (hole-4 regression, plan §7 item 1) ──────────


async def test_prompt_contains_rule_goes_red_on_observed_reality_mutant(monkeypatch):
    """`prompt = prompt.replace(OBSERVED_REALITY_RULE, "")` reproduces the
    exact pre-2026-07-06 prompt — the check must PASS on the real assembled
    prompt and FAIL on the mutant."""
    scenario = _scenario("hole4-observed-reality-gaslight")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.PROMPT_CONTAINS_RULE, rule="OBSERVED_REALITY_RULE", mouths=["text", "realtime"])

    real_result = checks_mod.TIER1_CHECKS[check.check.value](ctx, check)
    assert real_result.passed, "sanity: the real assembled prompt must contain OBSERVED_REALITY_RULE"

    mutant_ctx = dataclasses.replace(
        ctx,
        text_prompt=ctx.text_prompt.replace(OBSERVED_REALITY_RULE, ""),
        realtime_prompt=ctx.realtime_prompt.replace(OBSERVED_REALITY_RULE, ""),
    )
    mutant_result = checks_mod.TIER1_CHECKS[check.check.value](mutant_ctx, check)
    assert not mutant_result.passed, "check must go RED on the pre-fix (rule-stripped) prompt"


async def test_prompt_contains_rule_goes_red_on_hazard_grounding_mutant(monkeypatch):
    scenario = _scenario("hole4-no-left-bunker-hallucination")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.PROMPT_CONTAINS_RULE, rule="HAZARD_GROUNDING_RULE", mouths=["text", "realtime"])

    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed

    mutant_ctx = dataclasses.replace(
        ctx,
        text_prompt=ctx.text_prompt.replace(HAZARD_GROUNDING_RULE, ""),
        realtime_prompt=ctx.realtime_prompt.replace(HAZARD_GROUNDING_RULE, ""),
    )
    mutant_result = checks_mod.TIER1_CHECKS[check.check.value](mutant_ctx, check)
    assert not mutant_result.passed


async def test_prompt_contains_rule_goes_red_on_input_grounding_mutant(monkeypatch):
    """`prompt = prompt.replace(INPUT_GROUNDING_RULE, "")` reproduces the
    Scars-transcript incident prompt — the check must PASS on the real
    assembled prompt and FAIL on the mutant, in BOTH mouths."""
    scenario = _scenario("gibberish-transcript-asks-to-repeat")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.PROMPT_CONTAINS_RULE, rule="INPUT_GROUNDING_RULE", mouths=["text", "realtime"])
    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed  # sanity: real prompts contain it
    mutant_ctx = dataclasses.replace(
        ctx,
        text_prompt=ctx.text_prompt.replace(INPUT_GROUNDING_RULE, ""),
        realtime_prompt=ctx.realtime_prompt.replace(INPUT_GROUNDING_RULE, ""),
    )
    assert not checks_mod.TIER1_CHECKS[check.check.value](mutant_ctx, check).passed


async def test_prompt_contains_rule_goes_red_on_input_grounding_single_mouth_mutant(monkeypatch):
    """Single-mouth variant: strip INPUT_GROUNDING_RULE from realtime only —
    proves per-mouth attribution (the failure detail must name only
    ['realtime'], not both)."""
    scenario = _scenario("gibberish-transcript-asks-to-repeat")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.PROMPT_CONTAINS_RULE, rule="INPUT_GROUNDING_RULE", mouths=["text", "realtime"])
    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed

    mutant_ctx = dataclasses.replace(
        ctx, realtime_prompt=ctx.realtime_prompt.replace(INPUT_GROUNDING_RULE, ""),
    )
    result = checks_mod.TIER1_CHECKS[check.check.value](mutant_ctx, check)
    assert not result.passed
    assert "['realtime']" in result.detail


async def test_prompt_contains_rule_goes_red_when_constant_emptied(monkeypatch):
    """Toothlessness vector: if a grounding-rule constant shrank to '' , a naive
    `rule_text in prompt` would be trivially True. The guard must fail instead —
    a vanished rule is a regression, not a pass. (Mutant = the emptied constant,
    not a stripped prompt.)"""
    scenario = _scenario("hole4-observed-reality-gaslight")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.PROMPT_CONTAINS_RULE, rule="OBSERVED_REALITY_RULE", mouths=["text", "realtime"])

    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed
    monkeypatch.setitem(checks_mod._RULE_TEXT, "OBSERVED_REALITY_RULE", "   ")
    assert not checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed, (
        "check must go RED when the rule constant is empty/whitespace"
    )


async def test_prompt_contains_literal_goes_red_when_sentence_limit_stripped(monkeypatch):
    scenario = _scenario("chatty-question-stays-calm")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.PROMPT_CONTAINS_LITERAL, literal="2-3 short sentences", mouths=["text"])

    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed

    mutant_ctx = dataclasses.replace(ctx, text_prompt=ctx.text_prompt.replace("2-3 short sentences", ""))
    assert not checks_mod.TIER1_CHECKS[check.check.value](mutant_ctx, check).passed


async def test_prompt_contains_literal_goes_red_when_no_markdown_stripped(monkeypatch):
    scenario = _scenario("text-mouth-states-no-markdown-contract")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.PROMPT_CONTAINS_LITERAL, literal="never use markdown", mouths=["text"])

    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed

    mutant_ctx = dataclasses.replace(ctx, text_prompt=ctx.text_prompt.replace("never use markdown", ""))
    assert not checks_mod.TIER1_CHECKS[check.check.value](mutant_ctx, check).passed


# ── 2. Hallucinated-hazard-line mutant (plan §7 item 2) ─────────────────────


def test_hazards_line_only_from_input_goes_red_on_a_merged_stale_hazard():
    """Guards against a future formatter that 'helpfully' merges in a
    cached/stale hazard the input never had."""
    input_hazards = [Hazard(type="bunker", side="right", line_side="right", carry_yards=240)]
    honest_line = "Hole 4 hazards: bunker R 240y"
    assert checks_mod.hazards_line_only_from_input(input_hazards, honest_line).passed

    mutant_line = "Hole 4 hazards: bunker R 240y, water L 190y"
    mutant_result = checks_mod.hazards_line_only_from_input(input_hazards, mutant_line)
    assert not mutant_result.passed


# ── 2b. Trees-stripped-from-features mutant (caddie-surface-osm-trees) ──────


def test_context_hazards_match_goes_red_when_trees_stripped_from_features():
    """The machine-checked proof that the eval detects the exact regression
    this item fixes: build the `trees-carry-cited-from-geometry` scenario's
    Tier1 context twice from its real GeoJSON `features` — once verbatim
    (the check must PASS, citing the mapped tree-line carry), once with every
    `featureType in {"tree", "woods"}` feature removed before extraction (the
    check MUST fail) — reproducing re-adding the `"tree"`/`"woods"` exclusion
    (or any future gate that drops trees from the data path) as a red test."""
    scenario = _scenario("trees-carry-cited-from-geometry")
    check = Tier1Check(
        check=Tier1CheckName.CONTEXT_HAZARDS_MATCH,
        hazards=[{"type": "trees", "side": "R", "carry": 220}],
    )

    real_hazards = checks_mod.resolve_hazards(scenario.situation.hole)
    real_line = checks_mod.format_hazards_line(scenario.situation.hole.number, real_hazards)
    ctx = checks_mod.Tier1Context(
        hazards=real_hazards, hazards_line=real_line, ground_truth_block="",
        text_prompt="", text_situation_block="", realtime_prompt="",
    )
    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed, (
        "sanity: the real extraction must surface the tree-line carry"
    )

    stripped_features = [
        f for f in scenario.situation.hole.features["features"]
        if (f.get("properties") or {}).get("featureType") not in ("tree", "woods")
    ]
    stripped_fc = {"type": "FeatureCollection", "features": stripped_features}
    mutant_hazards = checks_mod.extract_hole_hazards(stripped_fc)
    mutant_line = checks_mod.format_hazards_line(scenario.situation.hole.number, mutant_hazards)
    mutant_ctx = dataclasses.replace(ctx, hazards=mutant_hazards, hazards_line=mutant_line)

    mutant_result = checks_mod.TIER1_CHECKS[check.check.value](mutant_ctx, check)
    assert not mutant_result.passed, "check must go RED when trees are stripped from the input features"


# ── 2c. `context_hazards_match` on a real multi-run split trees line ────────
# backlog `eval-hazards-match-split-line`: since TREE_RUN_SPLIT_GAP_YDS
# (specs/caddie-tree-span-gap-plan.md), a gap-preserving trees group renders
# as ONE `type SIDE` prefix followed by multiple `" and "`-joined runs
# (`trees L 30-65y and 265-480y`) — the prefix does not repeat per run. The
# pre-fix matcher only ever found the FIRST run and silently ignored the
# rest, so an expected carry covered only by a LATER run false-failed.
#
# The line below is the real Bethpage RED-1 per-side chain, ±5y
# geodesic-verified during planning (caddie-tree-span-gap-plan.md §1d "After
# (§1 only)" row) — the split-but-not-yet-near-tee-suppressed rendering that
# `_tree_runs` produces from Red 1's actual chain carries
# (`tests/fixtures/bethpage_red_trees.json`; see also
# `TestHole1SplitLine.test_hole_1_split_renders_both_gap_separated_runs` in
# `tests/test_tree_span_gap.py` for the post-suppression sibling of this
# exact data).


def test_context_hazards_match_covers_every_run_of_a_split_trees_line():
    real_red1_split_line = "Hole 1 hazards: trees R 5-85y and 385-475y, trees L 30-65y and 265-480y"

    # An expected carry covered ONLY by the SECOND run of each side must
    # still pass — the pre-fix matcher false-failed both of these.
    right_second_run = checks_mod.context_hazards_match(
        real_red1_split_line, [{"type": "trees", "side": "R", "carry": 470}]
    )
    assert right_second_run.passed, right_second_run.detail
    left_second_run = checks_mod.context_hazards_match(
        real_red1_split_line, [{"type": "trees", "side": "L", "carry": 275}]
    )
    assert left_second_run.passed, left_second_run.detail

    # And the FIRST run of each side must still pass too (no regression).
    right_first_run = checks_mod.context_hazards_match(
        real_red1_split_line, [{"type": "trees", "side": "R", "carry": 40}]
    )
    assert right_first_run.passed, right_first_run.detail

    # A carry that falls in neither run (the ~200-380y open drive zone the
    # split rendering exists to preserve) must still fail.
    open_zone = checks_mod.context_hazards_match(
        real_red1_split_line, [{"type": "trees", "side": "L", "carry": 150}]
    )
    assert not open_zone.passed, "carry inside the open drive zone must NOT match either run"


# ── 3. Hole-4 guide mutant: harness catches a fail-open validator (item 3) ─


def test_validate_guide_rejects_check_goes_red_if_the_validator_fail_opens(monkeypatch):
    hazards = [Hazard(type="bunker", side="left", line_side="left", carry_yards=265)]
    incident_guide_dict = {
        "play_line": "Favor the fairway.",
        "miss_side": "Carry the bunkers on the right at 265.",
    }

    # Sanity: the REAL validator rejects the actual incident-shaped guide.
    assert validate_guide(HoleStrategyGuide(**incident_guide_dict), hazards) is None

    check = Tier1Check(check=Tier1CheckName.VALIDATE_GUIDE_REJECTS, guide=incident_guide_dict)
    ctx = checks_mod.Tier1Context(
        hazards=hazards, hazards_line="", ground_truth_block="",
        text_prompt="", text_situation_block="", realtime_prompt="",
    )
    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed

    # Mutant: the validator has regressed to fail-OPEN (returns the guide
    # unchanged instead of rejecting it) -> the harness's own
    # validate_guide_rejects check MUST go red.
    monkeypatch.setattr(checks_mod, "validate_guide", lambda guide, hz: guide)
    mutant_result = checks_mod.TIER1_CHECKS[check.check.value](ctx, check)
    assert not mutant_result.passed


# ── 4. Empty-state mutant (plan §7 item 4) ──────────────────────────────────


def test_hazards_line_empty_when_no_hazards_goes_red_on_a_fabricated_line():
    assert checks_mod.hazards_line_empty_when_no_hazards([], "").passed

    mutant_result = checks_mod.hazards_line_empty_when_no_hazards([], "Hole 9 hazards: bunker C 200y")
    assert not mutant_result.passed


# ── 5. Tier-2 deterministic checks vs known-bad canned answers (item 5) ────

_INCIDENT_PHRASE = "There's a bunker at 260 on the left"


def test_max_sentences_fails_on_a_long_answer():
    long_answer = "Hit the 7 iron. Aim center. Take a smooth swing. Trust the number and commit."
    assert not checks_mod.max_sentences(long_answer, 3).passed
    assert checks_mod.max_sentences("Hit the 7 iron. Aim center.", 3).passed


def test_no_markdown_fails_on_markdown_formatted_answer():
    assert not checks_mod.no_markdown("**Club:** 7 iron\n- aim center").passed
    assert checks_mod.no_markdown("Hit the 7 iron, aim center.").passed


def test_club_within_one_fails_on_a_club_far_from_target():
    clubs = {"5iron": 185, "4iron": 195, "7iron": 160}
    assert not checks_mod.club_within_one("Hit your 7 iron here.", 187, clubs).passed
    assert checks_mod.club_within_one("Hit your 5 iron here.", 187, clubs).passed


def test_must_not_mention_fails_on_the_literal_incident_phrase():
    forbidden = ["left bunker", "bunker on the left", "260 on the left"]
    assert not checks_mod.must_not_mention(_INCIDENT_PHRASE, forbidden).passed
    assert checks_mod.must_not_mention("There's a bunker at 240 on the right.", forbidden).passed


def test_must_mention_any_fails_when_none_of_the_phrases_are_present():
    required = ["left bunker", "bunker left", "bunker on the left"]
    assert not checks_mod.must_mention_any("Aim down the middle.", required).passed
    assert checks_mod.must_mention_any("Watch the left bunker off the tee.", required).passed


# ── 5b. Carries-tool mutant (caddie-tool-loop-parity D8b) ───────────────────


async def test_carries_tool_matches_hazards_goes_red_on_an_invented_carry(monkeypatch):
    """Mutant: a carries_payload that 'helpfully' appends a hazard the hole
    never had (the exact fabricated-carry failure the tool exists to kill).
    The check must PASS against the real payload and FAIL on the mutant."""
    scenario = _scenario("carry-question-cites-true-along-path-carry")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.CARRIES_TOOL_MATCHES_HAZARDS)

    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed, (
        "sanity: the real carries_payload must match the mapped hazards"
    )

    real_carries_payload = checks_mod.carries_payload

    def _mutant(session, hole_number):
        payload = real_carries_payload(session, hole_number)
        if payload.get("available") and payload.get("carries") is not None:
            payload["carries"] = list(payload["carries"]) + [{
                "type": "bunker", "side": "right", "carry_yards": 260,
                "clubs_that_clear": None, "clubs_short_of_it": None,
            }]
        return payload

    monkeypatch.setattr(checks_mod, "carries_payload", _mutant)
    mutant_result = checks_mod.TIER1_CHECKS[check.check.value](ctx, check)
    assert not mutant_result.passed, "check must go RED on an invented carry"


async def test_carries_tool_matches_hazards_goes_red_on_a_dropped_carry(monkeypatch):
    """Mutant twin: a payload that silently DROPS a mapped carry (a lossy
    'simplification') must also fail — none dropped, none invented."""
    scenario = _scenario("carry-question-cites-true-along-path-carry")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.CARRIES_TOOL_MATCHES_HAZARDS)

    real_carries_payload = checks_mod.carries_payload

    def _mutant(session, hole_number):
        payload = real_carries_payload(session, hole_number)
        if payload.get("available") and payload.get("carries"):
            payload["carries"] = payload["carries"][:-1]
        return payload

    monkeypatch.setattr(checks_mod, "carries_payload", _mutant)
    assert not checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed


# ── 5c. Shot-distance mutant (caddie-shot-physics-engine plan step 11) ──────


async def test_shot_distance_in_band_goes_red_on_pre_physics_arithmetic(monkeypatch):
    """Mutant: the exact pre-wiring failure — the 2026-07-09 incident's
    'total around 390 / plays about 392', i.e. rule-of-thumb arithmetic
    applied to the PIN distance instead of the physics engine's flight of the
    player's DRIVE. The check must PASS against the real engine (total ~327,
    inside [315, 330]) and go RED on the incident numbers."""
    scenario = _scenario("drive-300-downwind-downhill-physics-total")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(
        check=Tier1CheckName.SHOT_DISTANCE_IN_BAND, club="driver", band=[315, 330],
    )

    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed, (
        "sanity: the real physics engine must land the incident drive in band"
    )

    def _mutant(session, hole_number=None, club=None, target_yards=None):
        # Pre-physics behavior: 390 pin + 4mph tail (~+2y 'help') applied as
        # scalar fudges — the number the caddie actually told the owner.
        return {
            "available": True, "mode": "club", "club": club,
            "carry_yards": 360, "roll_yards": 30, "total_yards": 390,
            "plays_like_yards": 392, "assumptions": [],
        }

    monkeypatch.setattr(checks_mod, "shot_distance_payload", _mutant)
    mutant_result = checks_mod.TIER1_CHECKS[check.check.value](ctx, check)
    assert not mutant_result.passed, "check must go RED on the incident's 390 total"
    assert "390" in mutant_result.detail


async def test_shot_distance_in_band_goes_red_when_engine_unavailable(monkeypatch):
    """A payload that degrades to available:false for a fully-specified
    scenario is a wiring regression, not a pass — the check must fail closed."""
    scenario = _scenario("drive-300-downwind-downhill-physics-total")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(
        check=Tier1CheckName.SHOT_DISTANCE_IN_BAND, club="driver", band=[315, 330],
    )

    monkeypatch.setattr(
        checks_mod, "shot_distance_payload",
        lambda session, hole_number=None, club=None, target_yards=None: {
            "available": False, "reason": "regressed",
        },
    )
    assert not checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed


# ── 5d. History-renders-in-order mutants (caddie-experience-harness §2.5) ──


async def test_history_renders_in_order_goes_red_on_a_dropped_turn(monkeypatch):
    """A history turn silently dropped from the assembled `messages` list —
    the check must PASS on the real messages and FAIL when the first seeded
    turn is removed."""
    scenario = _scenario("followup-3wood-after-driver")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.HISTORY_RENDERS_IN_ORDER)

    real_result = checks_mod.TIER1_CHECKS[check.check.value](ctx, check)
    assert real_result.passed, "sanity: the real assembled messages carry the full seeded history in order"

    mutant_ctx = dataclasses.replace(ctx, text_messages=ctx.text_messages[1:])  # drop the first history turn
    mutant_result = checks_mod.TIER1_CHECKS[check.check.value](mutant_ctx, check)
    assert not mutant_result.passed, "check must go RED when a history turn is dropped"


async def test_history_renders_in_order_goes_red_on_a_swapped_pair(monkeypatch):
    """Two adjacent history turns swapped — order must matter, not just
    membership."""
    scenario = _scenario("followup-3wood-after-driver")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.HISTORY_RENDERS_IN_ORDER)
    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed

    swapped = list(ctx.text_messages)
    swapped[0], swapped[1] = swapped[1], swapped[0]
    mutant_ctx = dataclasses.replace(ctx, text_messages=swapped)
    mutant_result = checks_mod.TIER1_CHECKS[check.check.value](mutant_ctx, check)
    assert not mutant_result.passed, "check must go RED when two history turns are swapped"


async def test_history_renders_in_order_goes_red_when_transcript_moves_before_history(monkeypatch):
    """The current transcript must be LAST — a mutant that moves it to the
    front (as if the model saw the question before the context that grounds
    it) must go RED."""
    scenario = _scenario("followup-3wood-after-driver")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.HISTORY_RENDERS_IN_ORDER)
    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed

    reordered = [ctx.text_messages[-1]] + ctx.text_messages[:-1]  # current transcript moved to the front
    mutant_ctx = dataclasses.replace(ctx, text_messages=reordered)
    mutant_result = checks_mod.TIER1_CHECKS[check.check.value](mutant_ctx, check)
    assert not mutant_result.passed, "check must go RED when the current transcript is no longer last"


async def test_history_renders_in_order_passes_on_the_real_assembled_messages(monkeypatch):
    """A second, independently-seeded scenario (4 history turns) — the real
    assembled messages must pass cleanly, not just the 2-turn scenario
    above."""
    scenario = _scenario("context-retention-prior-club-result")
    ctx = await _build_prompts(scenario, monkeypatch)
    check = Tier1Check(check=Tier1CheckName.HISTORY_RENDERS_IN_ORDER)
    assert checks_mod.TIER1_CHECKS[check.check.value](ctx, check).passed


# ── 6. Registry closure — no dead checks (plan §7 item 6) ──────────────────

# Tier-1 checks whose "goes red" behavior is proven by an internal mutant
# ABOVE, not (only) by golden-set usage — kept in sync with the tests above.
TIER1_CHECKS_EXERCISED_BY_TEETH = {
    Tier1CheckName.PROMPT_CONTAINS_RULE.value,
    Tier1CheckName.PROMPT_CONTAINS_LITERAL.value,
    Tier1CheckName.HAZARDS_LINE_ONLY_FROM_INPUT.value,
    Tier1CheckName.HAZARDS_LINE_EMPTY_WHEN_NO_HAZARDS.value,
    Tier1CheckName.VALIDATE_GUIDE_REJECTS.value,
    Tier1CheckName.CARRIES_TOOL_MATCHES_HAZARDS.value,
    Tier1CheckName.SHOT_DISTANCE_IN_BAND.value,
    Tier1CheckName.HISTORY_RENDERS_IN_ORDER.value,
}


def test_registry_closure_every_tier1_check_has_golden_or_teeth_coverage():
    used_in_golden = {c.check.value for s in SCENARIOS for c in s.expected.tier1}
    uncovered = set(checks_mod.TIER1_CHECKS.keys()) - used_in_golden - TIER1_CHECKS_EXERCISED_BY_TEETH
    assert not uncovered, f"tier1 check(s) with no golden-set usage AND no teeth mutant: {uncovered}"


def test_registry_closure_every_tier2_deterministic_check_is_teeth_tested():
    """All five are unit-tested against known-bad canned answers above."""
    covered = {
        Tier2DeterministicCheckName.MAX_SENTENCES.value,
        Tier2DeterministicCheckName.NO_MARKDOWN.value,
        Tier2DeterministicCheckName.CLUB_WITHIN_ONE.value,
        Tier2DeterministicCheckName.MUST_NOT_MENTION.value,
        Tier2DeterministicCheckName.MUST_MENTION_ANY.value,
    }
    assert covered == set(checks_mod.TIER2_DETERMINISTIC.keys())


def test_golden_check_names_are_a_subset_of_the_registries():
    used_tier1 = {c.check.value for s in SCENARIOS for c in s.expected.tier1}
    used_tier2_det = {c.check.value for s in SCENARIOS for c in s.expected.tier2_deterministic}
    assert used_tier1 <= set(checks_mod.TIER1_CHECKS.keys())
    assert used_tier2_det <= set(checks_mod.TIER2_DETERMINISTIC.keys())


# ── run_tier2.py is never collected by pytest (plan §8 risk table) ─────────


def test_run_tier2_filename_does_not_match_pytest_test_glob():
    import tests.eval.run_tier2 as run_tier2_mod

    filename = pathlib.Path(run_tier2_mod.__file__).name
    assert not filename.startswith("test_"), (
        "run_tier2.py must never match pytest's test_*.py collection glob — "
        "it is invoked explicitly via `uv run python -m tests.eval.run_tier2`"
    )
    assert not hasattr(run_tier2_mod, "test_main"), "no function named like a pytest test in run_tier2"
