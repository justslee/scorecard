"""Multi-turn conversation & router eval — teeth (RED-proofs)
(specs/eval-multiturn-conversation-router-plan.md §8).

Per the harness's #1 rule ("an eval that can't fail is worse than none"),
every conversation-level assertion family gets a mutant proof here. Mutants
are INTERNAL monkeypatches — never edits to real source. Follows the
`test_substance_teeth.py` / `test_harness_has_teeth.py` precedent: a mutant
is installed, the scenario/check is run again, and the result is asserted to
have gone RED (a failed `CheckResult`, never `pytest.raises` for the pure
checks — they return, they don't raise).
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

from app.caddie import strategy as strategy_mod  # noqa: E402
from app.caddie.routing import Intent  # noqa: E402
from app.routes import caddie as caddie_routes  # noqa: E402

from tests.eval.conversation_runner import (  # noqa: E402
    _LedgerNoHistoryFeed,
    check_club_consistency,
    check_history_renders_in_order,
    check_turn_expectations,
    run_conversation,
)
from tests.eval.conversations import CLUB_DISTANCES, CONVERSATION_SCENARIOS  # noqa: E402


def _scenario(scenario_id: str):
    return next(s for s in CONVERSATION_SCENARIOS if s.id == scenario_id)


# ── M1 — intent-blind runner ──────────────────────────────────────────────


async def test_m1_intent_blind_classify_intent_goes_red(monkeypatch):
    """monkeypatch `classify_intent` to always return `Intent.OTHER` ->
    `intent-switch-chain`'s P1 fingerprint assertions must fail — every
    turn's real Intent (ADVICE/SCORE/FACT/ADVICE) is masked."""
    monkeypatch.setattr(caddie_routes, "classify_intent", lambda transcript: Intent.OTHER)

    result = await run_conversation(_scenario("intent-switch-chain"), monkeypatch)

    fingerprint = check_turn_expectations(result)
    assert not fingerprint.passed, "an intent-blind runner must not pass the P1 fingerprint check"
    assert all(t.intent is Intent.OTHER for t in result.turns)


# ── M2 — re-derive instead of reuse ───────────────────────────────────────


async def test_m2_cache_lookup_always_miss_goes_red(monkeypatch):
    """monkeypatch `strategy_mod.cache_lookup` to always return `None` ->
    `followup-club-advice-same-hole`'s `synth.calls == 1` pin goes red (a
    second, unscripted synth call is attempted on the cache-hit turn)."""
    monkeypatch.setattr(strategy_mod, "cache_lookup", lambda key: None)

    result = await run_conversation(_scenario("followup-club-advice-same-hole"), monkeypatch)

    assert result.synth.calls != 1, "a re-derive-instead-of-reuse mutant must NOT still hit cache once"
    fingerprint = check_turn_expectations(result)
    assert not fingerprint.passed


# ── M3 — contradiction detector always-passes + inconclusive-is-red ──────


def test_m3a_club_consistency_catches_a_real_mismatch():
    """A hand-built pair where the second reply endorses a DIFFERENT club
    than the first must fail — the detector must not always-pass."""
    replies = [
        "Hit the driver here. Bunker left, water right. Favor the left side off the tee.",
        "Go with the 3 wood here instead. Trees left, bunker right. Favor the left side.",
    ]
    result = check_club_consistency(replies, CLUB_DISTANCES)
    assert not result.passed, "a genuine club mismatch across replies must fail"


def test_m3b_club_consistency_never_vacuously_passes_on_no_signal():
    """A hand-built pair where the second reply names NO recognizable club
    must ALSO fail — inconclusive is red, never a vacuous pass."""
    replies = [
        "Hit the driver here. Bunker left, water right. Favor the left side off the tee.",
        "Trust your gut out there and commit to the shot.",
    ]
    result = check_club_consistency(replies, CLUB_DISTANCES)
    assert not result.passed, "a reply naming no recognizable club must never pass as 'consistent'"
    assert "no recognizable club" in result.detail


# ── M4 — stale hole ────────────────────────────────────────────────────────


async def test_m4_stale_hole_run_strategy_turn_goes_red(monkeypatch):
    """monkeypatch the ROUTE-level `run_strategy_turn` name with a wrapper
    that forces `hole=5` regardless of the argument -> `hole-swap-advice`
    goes red: the spy's recorded (ACTUALLY-COMPUTED) hole sequence collapses
    to [5, 5] instead of [5, 12], and both replies collapse to the SAME
    (hole-5) narrative via a real cache hit."""
    real_run_strategy_turn = caddie_routes.run_strategy_turn

    async def _stale_hole_run_strategy_turn(session, round_id, user_id, hole, **kwargs):
        return await real_run_strategy_turn(session, round_id, user_id, 5, **kwargs)

    monkeypatch.setattr(caddie_routes, "run_strategy_turn", _stale_hole_run_strategy_turn)

    result = await run_conversation(_scenario("hole-swap-advice"), monkeypatch)

    observed_holes = [c["hole"] for c in result.strategy_spy.calls]
    assert observed_holes != [5, 12], f"stale-hole mutant must collapse the hole sequence, got {observed_holes}"
    assert result.turns[0].reply == result.turns[1].reply, "stale hole must collapse both replies to one narrative"
    fingerprint = check_turn_expectations(result)
    assert not fingerprint.passed


# ── M5 — SCORE cross-contamination ────────────────────────────────────────


async def test_m5_score_mapped_to_advice_goes_red(monkeypatch):
    """monkeypatch `classify_intent` to map SCORE -> ADVICE ->
    `score-multi-player-then-fact` goes red: the brain gets invoked
    (synth delta != 0) and the SCORE turns no longer return the handoff
    line."""
    from app.caddie.routing import classify_intent as real_classify_intent

    def _score_to_advice(transcript: str) -> Intent:
        intent = real_classify_intent(transcript)
        return Intent.ADVICE if intent is Intent.SCORE else intent

    monkeypatch.setattr(caddie_routes, "classify_intent", _score_to_advice)

    result = await run_conversation(_scenario("score-multi-player-then-fact"), monkeypatch)

    assert result.synth.calls != 0, "SCORE->ADVICE cross-contamination must invoke the strategy brain"
    assert result.turns[0].reply != caddie_routes._SCORE_TEXT_HANDOFF_LINE
    fingerprint = check_turn_expectations(result)
    assert not fingerprint.passed


# ── M6 — degrade poisoning ─────────────────────────────────────────────────


async def test_m6_degrade_poisoning_goes_red(monkeypatch):
    """monkeypatch `run_strategy_turn` so a degraded result IS cache_store'd
    (mirroring a real bug where the degrade guard is dropped) ->
    `degraded-synth-then-retry` goes red: turn 1 returns the calcified
    degraded line instead of re-synthesizing, and `synth.calls` stays 1."""
    real_run_strategy_turn = caddie_routes.run_strategy_turn

    async def _poison_degrade_run_strategy_turn(session, round_id, user_id, hole, **kwargs):
        result = await real_run_strategy_turn(session, round_id, user_id, hole, **kwargs)
        if result.get("available") and result.get("degraded"):
            payload = await strategy_mod.build_strategy_payload(
                session, round_id, user_id, hole,
                distance_to_green_yards=kwargs.get("distance_to_green_yards"),
                hole_yards=kwargs.get("hole_yards"),
                yardage_basis=kwargs.get("yardage_basis"),
            )
            ground_truth = strategy_mod.format_strategy_ground_truth(payload)
            key = strategy_mod.cache_key(ground_truth, strategy_mod._strategy_model())
            strategy_mod.cache_store(key, {"strategy": result["strategy"], "degraded": True})
        return result

    monkeypatch.setattr(caddie_routes, "run_strategy_turn", _poison_degrade_run_strategy_turn)

    result = await run_conversation(_scenario("degraded-synth-then-retry"), monkeypatch)

    assert result.synth.calls != 2, "a poisoned degrade cache must short-circuit the retry's synth call"
    assert result.turns[1].reply == result.turns[0].reply, "the retry must serve the calcified degraded line"


# ── M7 — ledger that doesn't feed context ─────────────────────────────────


async def test_m7_ledger_without_history_feed_goes_red(monkeypatch):
    """`_LedgerNoHistoryFeed` records pairs but does NOT extend `session.
    conversation_history` -> `followup-other-context-flow`'s message-
    containment assertion goes red — proves the dim-3 check depends on real
    context plumbing, not on the ledger's own bookkeeping."""
    result = await run_conversation(
        _scenario("followup-other-context-flow"), monkeypatch, ledger_cls=_LedgerNoHistoryFeed,
    )

    scenario = _scenario("followup-other-context-flow")
    turn0, turn1 = scenario.turns[0], scenario.turns[1]
    containment = check_history_renders_in_order(
        result.turns[1].captured_messages,
        [(turn0.transcript, result.turns[0].reply)],
        turn1.transcript,
    )
    assert not containment.passed, "a ledger that doesn't feed conversation_history must fail containment"
