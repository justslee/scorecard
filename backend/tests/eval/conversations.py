"""Multi-turn conversation & router eval — the scenario scripts
(specs/eval-multiturn-conversation-router-plan.md §6).

Python-defined, not JSONL (plan §3): per-turn expectations here are
code-shaped (`Intent` enum members, synth-call deltas, per-call stub
behavior) — none of which serialize honestly to JSONL. `ConversationTurn`/
`TurnExpect` are frozen dataclasses, so a typo'd expectation field is an
import-time error, same closed-registry guarantee the golden JSONL gets from
pydantic's `extra='forbid'`, by a different mechanism.

Shared fixture: hole 5 / hole 7 / hole 9 / hole 12 `HoleIntelligence`
builders (hole 9 added beyond the plan's named trio to give
`fact-then-advice-hole-pin` its own distinguishable target hole) — mirrors
`test_strategy_tool.py::_hole7_intel`. Every ADVICE-scripted narrative below
was verified (see the plan's build-order step 2/3) to pass the REAL
`validate_strategy_text` against its hole's REAL engine recommendation before
being written down here — an invalid canned text would go loudly red
(`degraded=True` reply != expected), never silently wrong (plan §4.1).
"""

from __future__ import annotations

from app.caddie.routing import Intent
from app.caddie.session import RoundSession
from app.caddie.types import GreenSlope, Hazard, HoleIntelligence, WeatherConditions

from tests.eval.conversation_runner import (
    ConversationScenario,
    ConversationTurn,
    SynthStep,
    TurnExpect,
)

# ── Shared session fixtures ─────────────────────────────────────────────

CLUB_DISTANCES: dict[str, int] = {"driver": 300, "7iron": 160, "3wood": 230}


def _hole5_intel() -> HoleIntelligence:
    return HoleIntelligence(
        hole_number=5, par=4, yards=410,
        hazards=[
            Hazard(type="bunker", side="left", line_side="left", carry_yards=230),
            Hazard(type="water", side="right", line_side="right", carry_yards=260),
        ],
        green_slope=GreenSlope(description="flat"),
    )


def _hole7_intel() -> HoleIntelligence:
    return HoleIntelligence(
        hole_number=7, par=4, yards=466,
        hazards=[
            Hazard(type="bunker", side="left", line_side="left", carry_yards=245),
            Hazard(type="water", side="right", line_side="right", carry_yards=300),
        ],
        green_slope=GreenSlope(description="back-to-front, moderate"),
    )


def _hole9_intel() -> HoleIntelligence:
    return HoleIntelligence(
        hole_number=9, par=3, yards=175,
        hazards=[Hazard(type="water", side="left", line_side="left", carry_yards=150)],
        green_slope=GreenSlope(description="flat"),
    )


def _hole12_intel() -> HoleIntelligence:
    # 300y (not the more typical 380y) — short enough that the engine calls
    # for a 3-wood tee shot instead of driver, so `hole-swap-advice`'s "each
    # reply names its own hole's engine club" check is non-vacuous against
    # hole 5's driver call, not two replies that both happen to say driver.
    return HoleIntelligence(
        hole_number=12, par=4, yards=300,
        hazards=[
            Hazard(type="trees", side="left", line_side="left", carry_yards=210),
            Hazard(type="bunker", side="right", line_side="right", carry_yards=250),
        ],
        green_slope=GreenSlope(description="flat"),
    )


def _build_session() -> RoundSession:
    return RoundSession(
        round_id="round-1", user_id="user-1", current_hole=7,
        hole_intel={
            5: _hole5_intel(), 7: _hole7_intel(), 9: _hole9_intel(), 12: _hole12_intel(),
        },
        club_distances=dict(CLUB_DISTANCES),
        weather=WeatherConditions(temperature_f=68, wind_speed_mph=6, wind_direction=210),
    )


# ── Canned narratives — verified against the REAL validator + REAL engine
# recommendation for each hole (plan §4.1, §6) ──────────────────────────

_HOLE5_NARRATIVE = (
    "Hit the driver here. Bunker left, water right — favor the left side off "
    "the tee and commit to the swing. That leaves a short iron in."
)
_HOLE7_NARRATIVE = (
    "Take the driver off this tee. Bunker left, water right — favor the left "
    "side and stay committed. That sets up a full wedge in for the next shot."
)
_HOLE12_NARRATIVE = (
    "Go with the 3 wood here. Trees left, bunker right — favor the left side "
    "and stay smooth. That sets up a short approach in."
)
_HOLE9_NARRATIVE = (
    "Hit the 7 iron here. Water left — favor the right side, commit to the "
    "number and take a confident strike."
)
# Real hole-7 geometry is bunker LEFT / water RIGHT — this claims the
# opposite of both, a Red-1 side-flip the REAL `validate_strategy_text`
# rejects, degrading to the deterministic engine-numbers line.
_HOLE7_SIDE_FLIPPED_NARRATIVE = (
    "Hit driver toward the bunker on the right. Water left. Commit to the "
    "shot and take a smooth two-putt read from mid green."
)

_FACT_ANSWER = "You've got 152 to the front, wind helping a touch."


# ── Scenarios (plan §6) ───────────────────────────────────────────────────

_intent_switch_chain = ConversationScenario(
    id="intent-switch-chain",
    session_factory=_build_session,
    synth_script=(SynthStep(text=_HOLE7_NARRATIVE),),
    turns=(
        ConversationTurn(
            "what's the play here?", hole_number=7,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=1),
        ),
        ConversationTurn(
            "put me down for a 5", hole_number=7,
            expect=TurnExpect(intent=Intent.SCORE, reply_equals_handoff=True),
        ),
        ConversationTurn(
            "how far to the front?", hole_number=7,
            expect=TurnExpect(intent=Intent.FACT, fact_delta=1, reply_equals_fact_answer=True),
        ),
        ConversationTurn(
            "should I go for it?", hole_number=7,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=0, same_reply_as_turn=0),
        ),
    ),
)

_followup_club_advice_same_hole = ConversationScenario(
    id="followup-club-advice-same-hole",
    session_factory=_build_session,
    synth_script=(SynthStep(text=_HOLE7_NARRATIVE),),
    turns=(
        ConversationTurn(
            "what should I hit here?", hole_number=7,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=1),
        ),
        ConversationTurn(
            "driver or 3-wood here?", hole_number=7,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=0, same_reply_as_turn=0),
        ),
    ),
)

_followup_other_context_flow = ConversationScenario(
    id="followup-other-context-flow",
    session_factory=_build_session,
    synth_script=(SynthStep(text=_HOLE7_NARRATIVE),),
    fact_answer=_FACT_ANSWER,
    turns=(
        ConversationTurn(
            "how do I play this one?", hole_number=7,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=1),
        ),
        # Verified against routing.py's real regexes: matches no ADVICE/FACT/
        # SCORE predicate -> OTHER (fast path to the Claude tool loop, which
        # `_FakeCaddieTurn` stands in for here).
        ConversationTurn(
            "what about a 3-wood instead?", hole_number=7,
            expect=TurnExpect(intent=Intent.OTHER, fact_delta=1),
        ),
    ),
)

_repeat_ask_consistency = ConversationScenario(
    id="repeat-ask-consistency",
    session_factory=_build_session,
    synth_script=(SynthStep(text=_HOLE7_NARRATIVE),),
    fact_answer=_FACT_ANSWER,
    turns=(
        ConversationTurn(
            "what's the play?", hole_number=7,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=1),
        ),
        ConversationTurn(
            "what's the wind?", hole_number=7,
            expect=TurnExpect(intent=Intent.FACT, fact_delta=1, reply_equals_fact_answer=True),
        ),
        ConversationTurn(
            "what's the play?", hole_number=7,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=0, same_reply_as_turn=0),
        ),
    ),
)

_hole_swap_advice = ConversationScenario(
    id="hole-swap-advice",
    session_factory=_build_session,
    synth_script=(SynthStep(text=_HOLE5_NARRATIVE), SynthStep(text=_HOLE12_NARRATIVE)),
    turns=(
        ConversationTurn(
            "what's the play here?", hole_number=5,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=1),
        ),
        ConversationTurn(
            "what's the play here?", hole_number=12,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=1, different_reply_from_turn=0),
        ),
    ),
)

_fact_then_advice_hole_pin = ConversationScenario(
    id="fact-then-advice-hole-pin",
    session_factory=_build_session,
    synth_script=(SynthStep(text=_HOLE9_NARRATIVE),),
    fact_answer=_FACT_ANSWER,
    turns=(
        ConversationTurn(
            "how far to the front?", hole_number=9,
            expect=TurnExpect(intent=Intent.FACT, fact_delta=1, reply_equals_fact_answer=True),
        ),
        # hole_number=0 (falsy but explicitly SENT) exercises the route's
        # answer-time `request.hole_number or session.current_hole` fallback
        # the same way it always could, even under the old truthy `int = 1`
        # default (a caller can always send an explicit 0).
        ConversationTurn(
            "should I go for it?", hole_number=0,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=1),
        ),
        # hole_number=None means the field is genuinely OMITTED from the wire
        # request — the real-client-omission case
        # (caddie-hole-number-truthy-default-fallback-dead). Under the OLD
        # `int = 1` default this was indistinguishable from an explicit `1`
        # (truthy) and the fallback could never fire; now that the model
        # default is `Optional[int] = None`, an omitted field resolves to
        # `session.current_hole` (still 9, pinned by turn 0) exactly like the
        # explicit-`0` turn above — same ground truth, same cached
        # recommendation, byte-identical reply, zero new synth calls.
        ConversationTurn(
            "should I go for it, one more time?", hole_number=None,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=0, same_reply_as_turn=1),
        ),
    ),
)

_score_multi_player_then_fact = ConversationScenario(
    id="score-multi-player-then-fact",
    session_factory=_build_session,
    synth_script=(),
    fact_answer=_FACT_ANSWER,
    turns=(
        ConversationTurn(
            "par for me, birdie for Mike", hole_number=7,
            expect=TurnExpect(intent=Intent.SCORE, reply_equals_handoff=True),
        ),
        ConversationTurn(
            "put me down for a 5", hole_number=7,
            expect=TurnExpect(intent=Intent.SCORE, reply_equals_handoff=True),
        ),
        ConversationTurn(
            "where do I stand?", hole_number=7,
            expect=TurnExpect(intent=Intent.FACT, fact_delta=1, reply_equals_fact_answer=True),
        ),
    ),
)

_score_exclusion_stays_fact = ConversationScenario(
    id="score-exclusion-stays-fact",
    session_factory=_build_session,
    synth_script=(SynthStep(text=_HOLE7_NARRATIVE),),
    fact_answer=_FACT_ANSWER,
    turns=(
        ConversationTurn(
            "I made a 4", hole_number=7,
            expect=TurnExpect(intent=Intent.SCORE, reply_equals_handoff=True),
        ),
        # `_SCORE_EXCLUSION_PATTERN` row: score-shaped words ("shoot", "par",
        # a preceding SCORE turn) but this is a FACT question about a target,
        # never a strokes-taken statement — must NOT get the handoff line.
        ConversationTurn(
            "what do I need to shoot par on the back nine?", hole_number=7,
            expect=TurnExpect(intent=Intent.FACT, fact_delta=1, reply_equals_fact_answer=True),
        ),
        ConversationTurn(
            "what's the play?", hole_number=7,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=1),
        ),
    ),
)

_degraded_synth_then_retry = ConversationScenario(
    id="degraded-synth-then-retry",
    session_factory=_build_session,
    synth_script=(
        SynthStep(raises=RuntimeError("simulated timeout")),
        SynthStep(text=_HOLE7_NARRATIVE),
    ),
    turns=(
        ConversationTurn(
            "what's the play here?", hole_number=7,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=1),
        ),
        ConversationTurn(
            "what's the play here?", hole_number=7,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=1, different_reply_from_turn=0),
        ),
    ),
)

_validator_reject_then_retry = ConversationScenario(
    id="validator-reject-then-retry",
    session_factory=_build_session,
    synth_script=(
        SynthStep(text=_HOLE7_SIDE_FLIPPED_NARRATIVE),
        SynthStep(text=_HOLE7_NARRATIVE),
    ),
    turns=(
        ConversationTurn(
            "what's the play here?", hole_number=7,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=1),
        ),
        ConversationTurn(
            "what's the play here?", hole_number=7,
            expect=TurnExpect(intent=Intent.ADVICE, synth_delta=1, different_reply_from_turn=0),
        ),
    ),
)

CONVERSATION_SCENARIOS: list[ConversationScenario] = [
    _intent_switch_chain,
    _followup_club_advice_same_hole,
    _followup_other_context_flow,
    _repeat_ask_consistency,
    _hole_swap_advice,
    _fact_then_advice_hole_pin,
    _score_multi_player_then_fact,
    _score_exclusion_stays_fact,
    _degraded_synth_then_retry,
    _validator_reject_then_retry,
]
