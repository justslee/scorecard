"""Multi-turn conversation & router eval — pytest module collected by the
normal offline sweep (specs/eval-multiturn-conversation-router-plan.md §7).
No env guard (unlike `run_tier2.py`/`run_consistency.py`) — fully offline, no
keyed LLM calls, no network, no Postgres, no docker.

Same env-stub header as `test_strategy_tool.py` (DATABASE_URL +
LOOPER_SECRETS_DISABLED before any `app.*` import).
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from app.caddie import strategy as strategy_mod  # noqa: E402
from app.caddie.routing import Intent  # noqa: E402
from app.caddie.strategy_turn import compose_degraded_line  # noqa: E402
from app.routes import caddie as caddie_routes  # noqa: E402

from tests.eval import substance as substance_mod  # noqa: E402
from tests.eval.conversation_runner import (  # noqa: E402
    check_club_consistency,
    check_history_renders_in_order,
    check_no_dupes,
    check_turn_expectations,
    run_conversation,
)
from tests.eval.conversations import CLUB_DISTANCES, CONVERSATION_SCENARIOS  # noqa: E402


@pytest.fixture(autouse=True)
def _clear_strategy_cache():
    """`run_conversation` also clears the cache at the start of every run
    (each conversation starts cold — plan §4.4); this belt-and-suspenders
    fixture is the same `_clear_strategy_cache` idiom `test_strategy_tool.py`
    uses, so a scenario never sees a stale entry from a PRIOR test module."""
    strategy_mod._CACHE.clear()
    yield
    strategy_mod._CACHE.clear()


async def _expected_degraded_line(session, hole: int) -> str:
    """Delegates to the REAL `compose_degraded_line` built from the REAL
    payload for `session`/`hole` — one source of truth, never a hand-
    reconstructed duplicate (same idiom as `test_strategy_tool.py::_expected_
    degraded_line`)."""
    payload = await strategy_mod.build_strategy_payload(session, "round-1", "user-1", hole)
    return compose_degraded_line(payload["recommendation"], payload["green_read"], payload["carries"])


# ── The core parametrized sweep — P1 (fingerprint) + P2 (no dupes) on every
# scenario, run through the pure check functions against the REAL route ────


@pytest.mark.parametrize("scenario", CONVERSATION_SCENARIOS, ids=[s.id for s in CONVERSATION_SCENARIOS])
async def test_conversation(scenario, monkeypatch):
    result = await run_conversation(scenario, monkeypatch)

    fingerprint = check_turn_expectations(result)
    assert fingerprint.passed, f"{scenario.id}: {fingerprint.detail}"

    dupes = check_no_dupes(result)
    assert dupes.passed, f"{scenario.id}: {dupes.detail}"


# ── Scenario-specific property assertions (P3/P4/P5/P6) — the parts that
# need scenario-level knowledge (which turns are ADVICE on the same hole,
# which turn is the OTHER follow-up, etc.) beyond the shared per-turn/
# per-sequence checks above ─────────────────────────────────────────────


async def test_intent_switch_chain_club_consistent_across_advice_turns(monkeypatch):
    """P4: turn 0 and turn 3 are both ADVICE on hole 7, byte-equal replies
    (cache hit) — `extract_substance` must agree, never inconclusive."""
    scenario = next(s for s in CONVERSATION_SCENARIOS if s.id == "intent-switch-chain")
    result = await run_conversation(scenario, monkeypatch)

    consistency = check_club_consistency(
        [result.turns[0].reply, result.turns[3].reply], CLUB_DISTANCES,
    )
    assert consistency.passed, consistency.detail
    assert result.turns[3].reply == result.turns[0].reply


async def test_repeat_ask_consistency_intervening_fact_turn_does_not_perturb_advice(monkeypatch):
    """P4: the intervening FACT turn (wind) must not change the ADVICE
    payload — turn 0 and turn 2 stay byte-equal and club-consistent."""
    scenario = next(s for s in CONVERSATION_SCENARIOS if s.id == "repeat-ask-consistency")
    result = await run_conversation(scenario, monkeypatch)

    assert result.synth.calls == 1, "the repeated ADVICE ask must hit cache, not re-synthesize"
    consistency = check_club_consistency(
        [result.turns[0].reply, result.turns[2].reply], CLUB_DISTANCES,
    )
    assert consistency.passed, consistency.detail


async def test_followup_club_advice_same_hole_reuses_the_one_brain_answer(monkeypatch):
    """P3: same hole, same session state -> the SAME ground truth -> a real
    cache hit. Pins the one-brain-answer-per-hole-state design."""
    scenario = next(s for s in CONVERSATION_SCENARIOS if s.id == "followup-club-advice-same-hole")
    result = await run_conversation(scenario, monkeypatch)

    assert result.synth.calls == 1
    assert len(result.synth.ground_truths) == 1
    assert result.turns[1].reply == result.turns[0].reply


async def test_followup_other_context_flow_sees_prior_turn_in_order(monkeypatch):
    """P3-OTHER: the OTHER follow-up's captured `messages` (the REAL output
    of `_build_session_voice_prompt`) contain turn 0's (user, assistant) pair
    in order, current transcript last — never a re-derivation (synth stays at
    1 total call for the whole scenario)."""
    scenario = next(s for s in CONVERSATION_SCENARIOS if s.id == "followup-other-context-flow")
    result = await run_conversation(scenario, monkeypatch)

    assert result.synth.calls == 1, "the OTHER follow-up must not re-derive strategy"
    turn0, turn1 = scenario.turns[0], scenario.turns[1]
    containment = check_history_renders_in_order(
        result.turns[1].captured_messages,
        [(turn0.transcript, result.turns[0].reply)],
        turn1.transcript,
    )
    assert containment.passed, containment.detail

    # The volatile CURRENT SITUATION block passed to the fact stub must name
    # the same hole both turns are on (7) — never a stale/other hole.
    system_blocks = result.turns[1].captured_system
    volatile_text = system_blocks[1]["text"]
    assert "Hole 7" in volatile_text


async def test_hole_swap_advice_resolves_fresh_hole_and_engine_club_each_turn(monkeypatch):
    """P5: hole 5 then hole 12 -> `run_strategy_turn` spy sees holes [5, 12]
    (never stale), distinct ground truths, distinct replies, and each reply
    names ITS hole's real engine club (driver on 5, 3-wood on 12 — a genuine
    distinctness check, not two replies that both happen to say driver)."""
    scenario = next(s for s in CONVERSATION_SCENARIOS if s.id == "hole-swap-advice")
    result = await run_conversation(scenario, monkeypatch)

    assert [c["hole"] for c in result.strategy_spy.calls] == [5, 12]
    assert result.synth.ground_truths[0] != result.synth.ground_truths[1]
    assert result.turns[0].reply != result.turns[1].reply

    sub5 = substance_mod.extract_substance(result.turns[0].reply, CLUB_DISTANCES)
    sub12 = substance_mod.extract_substance(result.turns[1].reply, CLUB_DISTANCES)
    assert sub5.club == "driver", sub5
    assert sub12.club == "3wood", sub12


async def test_fact_then_advice_hole_pin_answer_time_fallback_resolves_prior_hole(monkeypatch):
    """P5 (conversation-level pin): turn 0 (FACT, hole 9) pins `session.
    current_hole` via `set_current_hole`; turn 1 sends `hole_number=0`
    (falsy) so the route's `request.hole_number or session.current_hole`
    fallback must resolve the SAME turn's `run_strategy_turn` call to hole 9,
    not a stale/default hole.

    NOTE (plan §9 contingency, filed for the eng-lead / backlog rather than
    silently changed): `SessionVoiceRequest.hole_number: int = 1` is a
    TRUTHY default. A real client that omits `hole_number` (rather than this
    scenario's deliberate `hole_number=0`) would send `1`, which is also
    truthy, so the `or session.current_hole` fallback is DEAD from any
    default-sending client in production — it only fires when a caller
    explicitly sends `0`. This scenario proves the fallback logic itself is
    correct when reached; whether real clients ever reach it is a separate,
    real question this eval surfaced but does not fix (out of scope — no
    product/runtime code changed here)."""
    scenario = next(s for s in CONVERSATION_SCENARIOS if s.id == "fact-then-advice-hole-pin")
    result = await run_conversation(scenario, monkeypatch)

    assert result.hole_tracker.calls == [9]
    assert result.session.current_hole == 9
    assert result.turns[1].strategy_turn_hole == 9


async def test_score_multi_player_then_fact_never_touches_the_brain(monkeypatch):
    """P1 fingerprint, scenario-level: zero synth calls across the WHOLE
    scenario (no ADVICE turn exists) — the fact-turn-never-writes-a-score /
    never-invokes-strategy pin, non-vacuously (an unscripted call would raise
    inside `_ScriptedSynth` since the script is empty)."""
    scenario = next(s for s in CONVERSATION_SCENARIOS if s.id == "score-multi-player-then-fact")
    result = await run_conversation(scenario, monkeypatch)

    assert result.synth.calls == 0
    assert result.resolve_tool_spy.calls == 0
    assert result.turns[2].reply != caddie_routes._SCORE_TEXT_HANDOFF_LINE


async def test_score_exclusion_stays_fact_never_gets_the_handoff_line(monkeypatch):
    """Per-turn purity holds at conversation level: despite score-shaped
    words AND a preceding real SCORE turn, the exclusion-pattern row still
    routes to FACT, not SCORE — the handoff line appears on exactly turn 0."""
    scenario = next(s for s in CONVERSATION_SCENARIOS if s.id == "score-exclusion-stays-fact")
    result = await run_conversation(scenario, monkeypatch)

    assert result.turns[0].reply == caddie_routes._SCORE_TEXT_HANDOFF_LINE
    assert result.turns[1].reply != caddie_routes._SCORE_TEXT_HANDOFF_LINE
    assert result.turns[2].intent is Intent.ADVICE


async def test_degraded_synth_then_retry_does_not_poison_the_cache(monkeypatch):
    """P6 (exception branch): turn 0's synth raises -> reply exact-equals the
    REAL `compose_degraded_line` output (never a hand-written copy). Turn 1
    (same ask, synth now healthy) -> a FRESH synth call (cache was NOT
    poisoned by the degraded result) and the reply is the good, validated
    narrative — never the calcified degraded line."""
    scenario = next(s for s in CONVERSATION_SCENARIOS if s.id == "degraded-synth-then-retry")
    result = await run_conversation(scenario, monkeypatch)

    expected_degraded = await _expected_degraded_line(result.session, 7)
    assert result.turns[0].reply == expected_degraded
    assert result.turns[1].reply != expected_degraded
    assert result.synth.calls == 2, "turn 1 must re-synthesize, not serve a poisoned cache entry"


async def test_validator_reject_then_retry_does_not_poison_the_cache(monkeypatch):
    """P6 (validator-reject branch): same shape as the exception-branch test
    above, but the REAL `validate_strategy_text` does the rejecting (a
    side-flipped narrative), not an exception."""
    scenario = next(s for s in CONVERSATION_SCENARIOS if s.id == "validator-reject-then-retry")
    result = await run_conversation(scenario, monkeypatch)

    expected_degraded = await _expected_degraded_line(result.session, 7)
    assert result.turns[0].reply == expected_degraded
    assert result.turns[1].reply != expected_degraded
    assert result.synth.calls == 2


# ── Scenario roster honesty (README's "do not pad" rule) ────────────────


def test_roughly_ten_scenarios_no_near_duplicate_padding():
    assert 8 <= len(CONVERSATION_SCENARIOS) <= 12
    assert len({s.id for s in CONVERSATION_SCENARIOS}) == len(CONVERSATION_SCENARIOS)
