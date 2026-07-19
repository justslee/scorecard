"""Multi-turn conversation & router eval — the sequence executor
(specs/eval-multiturn-conversation-router-plan.md §3, §4, §5).

Drives the REAL `POST /api/caddie/session/voice` route
(`app/routes/caddie.py::session_voice`) through a throwaway `FastAPI()` +
`TestClient`, exactly like `tests/eval/test_strategy_tool.py::_strategy_client`
— `classify_intent`, the ADVICE/SCORE/FACT-OTHER dispatch arms,
`run_strategy_turn` (payload assembly, cache, validator, degrade composer),
and `_build_session_voice_prompt` are all REAL code. Only the network/DB seams
the existing suite already stubs are replaced: `synthesize_strategy` (OpenAI),
`run_caddie_turn` (Anthropic tool loop), `sessions.append_message_pair` /
`set_current_hole` / `set_recommendation`, `get_owned_session`,
`personality_visible` / `load_personality` / `memory_mod.get_top_memories` /
`memory_mod.get_player_profile`.

`classify_intent` / `run_strategy_turn` / `caddie_tools.resolve_tool` are
SPIED, not replaced — recording wrappers that delegate to whatever is
CURRENTLY installed on `caddie_routes` at the moment `run_conversation` is
called. This is what lets `test_conversation_teeth.py`'s mutants work: a
teeth test monkeypatches `caddie_routes.classify_intent` (or `.run_strategy_
turn`) to a mutant BEFORE calling `run_conversation`, and the spy installed
here wraps that mutant instead of the pristine real function — no separate
override plumbing needed for most mutants (M1, M4, M5, M6). M7 (a ledger that
doesn't feed context) needs a different ledger implementation entirely, so
`run_conversation` accepts an optional `ledger_cls` override for that one case.

This module has no pytest imports — `run_conversation` takes a plain
`monkeypatch` (pytest's fixture object, untyped here to avoid a hard pytest
import) — and every sequence-check function (`check_turn_expectations`,
`check_no_dupes`, `check_club_consistency`, `check_history_renders_in_order`)
is PURE: no pytest, no I/O, so `test_conversation_teeth.py` can feed them
hand-built mutant records directly.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

from dataclasses import dataclass  # noqa: E402
from typing import Any, Callable, Optional  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.caddie import strategy as strategy_mod  # noqa: E402
from app.caddie.routing import Intent  # noqa: E402
from app.caddie.session import RoundSession, VoiceCaddieMessage  # noqa: E402
from app.caddie.types import CaddiePersonality  # noqa: E402
from app.routes import caddie as caddie_routes  # noqa: E402
from app.services.rate_limit import caddie_rate_limited_user  # noqa: E402

from tests.eval.checks import CheckResult  # noqa: E402
from tests.eval import substance as substance_mod  # noqa: E402

_VOICE_URL = "/api/caddie/session/voice"

_DEFAULT_FACT_ANSWER = "You've got 152 to the front, wind helping a touch."


def _classic_personality() -> CaddiePersonality:
    return CaddiePersonality(
        id="classic", name="Classic Caddie", description="A steady, experienced caddie.",
        avatar="⛳", system_prompt="You are a steady, experienced caddie.",
    )


# ── Scenario / expectation dataclasses (§3) ──────────────────────────────


@dataclass(frozen=True)
class SynthStep:
    """One scripted `synthesize_strategy` call: return `text`, or raise
    `raises`. Matches the real `synthesize_strategy(ground_truth, *, model) ->
    (text, usage_dict)` contract."""

    text: Optional[str] = None
    raises: Optional[BaseException] = None


@dataclass(frozen=True)
class TurnExpect:
    """Per-turn expectation — the P1 "correct tier" fingerprint (§5) plus the
    common exact-equality pins other property classes need. A typo'd field
    name is an import-time `TypeError` (frozen dataclass, no `**kwargs`
    catch-all) — the same closed-registry safety JSONL gets from pydantic's
    `extra='forbid'`, by a different mechanism (plan §3)."""

    intent: Intent
    # Expected delta in `_ScriptedSynth.calls` / `_FakeCaddieTurn.calls` this
    # turn. Every non-ADVICE turn must show synth_delta == 0; every non-FACT/
    # OTHER turn must show fact_delta == 0 — asserted unconditionally, not
    # just when explicitly interesting, so cross-contamination always trips.
    synth_delta: int = 0
    fact_delta: int = 0
    reply_equals_handoff: bool = False
    reply_equals_fact_answer: bool = False
    # 0-indexed position of an earlier turn in THIS scenario whose reply must
    # be byte-identical to this turn's reply (cache-hit / repeat-ask pin).
    same_reply_as_turn: Optional[int] = None
    # 0-indexed position of an earlier turn whose reply must differ from this
    # turn's reply (hole-swap / degrade-then-retry pin).
    different_reply_from_turn: Optional[int] = None


@dataclass(frozen=True)
class ConversationTurn:
    transcript: str
    # None = genuinely OMITTED from the wire request (never sent as a JSON
    # key at all) — the real-client-omission case
    # (caddie-hole-number-truthy-default-fallback-dead). Distinct from
    # sending an explicit falsy `0`, which some scenarios use to exercise the
    # `request.hole_number or session.current_hole` fallback logic under the
    # OLD truthy-default regime; None exercises it the way an actual client
    # that never sends the field would.
    hole_number: Optional[int]
    expect: TurnExpect
    distance_to_green_yards: Optional[int] = None
    hole_yards: Optional[int] = None
    yardage_basis: Optional[str] = None


@dataclass(frozen=True)
class ConversationScenario:
    id: str
    session_factory: Callable[[], RoundSession]
    turns: tuple[ConversationTurn, ...]
    synth_script: tuple[SynthStep, ...] = ()
    fact_answer: str = _DEFAULT_FACT_ANSWER


@dataclass(frozen=True)
class TurnRecord:
    """What actually happened on one turn — every field is an effect of REAL
    code (the classified `Intent`, the route's JSON reply, the resolved hole
    `run_strategy_turn` was called with), never a value the runner invented."""

    transcript: str
    hole_number_sent: Optional[int]
    intent: Intent
    reply: str
    synth_delta: int
    fact_delta: int
    strategy_turn_hole: Optional[int]
    captured_messages: Optional[list[dict]]
    captured_system: Optional[list[dict]]


@dataclass
class ConversationResult:
    scenario: ConversationScenario
    session: RoundSession
    turns: list[TurnRecord]
    synth: "_ScriptedSynth"
    fact_stub: "_FakeCaddieTurn"
    ledger: "_Ledger"
    resolve_tool_spy: "_ResolveToolSpy"
    strategy_spy: "_RunStrategyTurnSpy"
    classify_spy: "_ClassifyIntentSpy"
    hole_tracker: "_HoleTracker"


# ── Stub / spy installers (§4) ────────────────────────────────────────────


class _ScriptedSynth:
    """Counting async stand-in for `strategy_mod.synthesize_strategy` — a
    per-CALL script (return text | raise), records every ground-truth block
    it was called with in order (§4.1). A call beyond the scripted length is
    a hard `AssertionError` — an unscripted extra synth call (e.g. the M2
    re-derive-instead-of-reuse mutant) must fail LOUDLY, never silently reuse
    the last step."""

    def __init__(self, script: tuple[SynthStep, ...]):
        self.script = script
        self.calls = 0
        self.ground_truths: list[str] = []

    async def __call__(self, ground_truth: str, *, model: str) -> tuple[str, dict]:
        self.ground_truths.append(ground_truth)
        idx = self.calls
        self.calls += 1
        if idx >= len(self.script):
            raise AssertionError(
                f"unscripted synthesize_strategy call #{idx + 1} "
                f"(script has {len(self.script)} step(s)) — ground_truth={ground_truth!r}"
            )
        step = self.script[idx]
        if step.raises is not None:
            raise step.raises
        return step.text, {"input_tokens": 500, "output_tokens": 40}


@dataclass
class CapturedTurn:
    system: list[dict]
    messages: list[dict]
    ctx: Any


class _FakeCaddieTurn:
    """Async-generator stand-in for `run_caddie_turn` (§4.2) — matches the
    real `(client, model, system, messages, ctx, on_usage=None)` frame
    contract exactly: zero or more `("token", str)` then exactly one
    `("done", full_text)`. Captures `system`/`messages` per call — the REAL
    output of `_build_session_voice_prompt`, inspected at the exact point
    Claude would have received it (what makes the dim-3 context-flow
    assertions non-vacuous)."""

    def __init__(self, answer: str):
        self.answer = answer
        self.calls: list[CapturedTurn] = []

    async def __call__(self, client, model, system, messages, ctx, on_usage=None):
        self.calls.append(CapturedTurn(system=system, messages=list(messages), ctx=ctx))
        yield ("token", self.answer)
        yield ("done", self.answer)


@dataclass
class LedgerPair:
    round_id: str
    user_content: str
    assistant_content: str
    hole_number: Optional[int]


class _Ledger:
    """In-memory stand-in for `sessions.append_message_pair` (§4.3) — records
    AND feeds context forward: appends to the SAME shared `RoundSession.
    conversation_history` the runner's `get_owned_session` fake keeps
    returning every turn, so `_build_session_voice_prompt` on a later turn
    renders exactly what a real DB-persisted round would."""

    def __init__(self, session: RoundSession):
        self.session = session
        self.pairs: list[LedgerPair] = []

    async def append_message_pair(
        self, round_id: str, user_content: str, assistant_content: str, hole_number: Optional[int] = None,
    ) -> None:
        self.pairs.append(LedgerPair(round_id, user_content, assistant_content, hole_number))
        self.session.conversation_history = self.session.conversation_history + [
            VoiceCaddieMessage(role="user", content=user_content),
            VoiceCaddieMessage(role="assistant", content=assistant_content),
        ]


class _LedgerNoHistoryFeed(_Ledger):
    """M7 mutant (§8): records pairs but does NOT extend `conversation_
    history` — proves the dim-3 context-flow check depends on real context
    plumbing, not on the ledger's own bookkeeping."""

    async def append_message_pair(
        self, round_id: str, user_content: str, assistant_content: str, hole_number: Optional[int] = None,
    ) -> None:
        self.pairs.append(LedgerPair(round_id, user_content, assistant_content, hole_number))


class _HoleTracker:
    """Stand-in for `sessions.set_current_hole` — records the call AND sets
    `session.current_hole` on the shared session (§4.4 deviation from the
    tier1 no-op idiom), preserving the conversation-level hole-pin semantics
    the scenarios assert."""

    def __init__(self, session: RoundSession):
        self.session = session
        self.calls: list[int] = []

    async def __call__(self, round_id: str, hole_number: int) -> None:
        self.calls.append(hole_number)
        self.session.current_hole = hole_number


class _ResolveToolSpy:
    """Delegating spy on `caddie_tools.resolve_tool` — must stay at 0 calls
    across every scenario here (the tool loop is stubbed out entirely via
    `_FakeCaddieTurn`), so any future change routing a tool/score write
    through the text path trips this tripwire (§4.2)."""

    def __init__(self, real: Callable):
        self._real = real
        self.calls = 0

    async def __call__(self, name: str, args: dict, ctx: Any) -> dict:
        self.calls += 1
        return await self._real(name, args, ctx)


class _ClassifyIntentSpy:
    """Delegating spy on `classify_intent` — records (transcript, Intent) per
    turn, delegates to whatever function is CURRENTLY installed at wrap time
    (real by default; a teeth mutant if pre-patched)."""

    def __init__(self, real: Callable[[str], Intent]):
        self._real = real
        self.calls: list[tuple[str, Intent]] = []

    def __call__(self, transcript: str) -> Intent:
        intent = self._real(transcript)
        self.calls.append((transcript, intent))
        return intent


class _RunStrategyTurnSpy:
    """Delegating spy on `run_strategy_turn` — records the resolved `hole` +
    returned dict per call, delegates to whatever is CURRENTLY installed at
    wrap time. The recorded `hole` is read back from the RESULT's own
    `hole_number` field (the hole the computation actually ran against),
    never the raw calling argument — a stale-hole mutant that force-
    substitutes a different hole INSIDE the wrapped function (M4, §8) still
    reaches this spy with the caller's correct argument, so recording the
    argument would never catch it; recording what was actually computed
    does."""

    def __init__(self, real: Callable):
        self._real = real
        self.calls: list[dict] = []

    async def __call__(self, session, round_id, user_id, hole, **kwargs):
        result = await self._real(session, round_id, user_id, hole, **kwargs)
        observed_hole = result.get("hole_number", hole) if isinstance(result, dict) else hole
        self.calls.append({"hole": observed_hole, "result": result})
        return result


# ── The executor (§3) ────────────────────────────────────────────────────


async def run_conversation(
    scenario: ConversationScenario, monkeypatch, *, ledger_cls: type = _Ledger,
) -> ConversationResult:
    """Run every turn of `scenario` through the REAL `/api/caddie/session/
    voice` route via a throwaway `FastAPI()` + `TestClient`. `ledger_cls`
    defaults to the real-context-feeding `_Ledger`; teeth pass
    `_LedgerNoHistoryFeed` for M7."""
    strategy_mod._CACHE.clear()  # each conversation starts cold (plan §4.4)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")

    session = scenario.session_factory()

    synth = _ScriptedSynth(scenario.synth_script)
    monkeypatch.setattr(strategy_mod, "synthesize_strategy", synth)

    fact_stub = _FakeCaddieTurn(scenario.fact_answer)

    ledger = ledger_cls(session)
    hole_tracker = _HoleTracker(session)

    async def _fake_get_owned_session(round_id: str, user_id: str) -> RoundSession:
        return session

    async def _personality_visible_always(persona_id, user_id=None) -> bool:
        return True

    async def _load_personality_classic(persona_id, user_id=None) -> CaddiePersonality:
        return _classic_personality()

    async def _no_memories(user_id) -> list:
        return []

    async def _noop_set_recommendation(round_id, recommendation, current_hole) -> None:
        return None

    async def _no_profile(user_id):
        return None

    monkeypatch.setattr(caddie_routes, "get_owned_session", _fake_get_owned_session)
    monkeypatch.setattr(caddie_routes, "personality_visible", _personality_visible_always)
    monkeypatch.setattr(caddie_routes, "load_personality", _load_personality_classic)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _no_memories)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_player_profile", _no_profile)
    monkeypatch.setattr(caddie_routes.sessions, "set_recommendation", _noop_set_recommendation)
    monkeypatch.setattr(caddie_routes.sessions, "set_current_hole", hole_tracker)
    monkeypatch.setattr(caddie_routes.sessions, "append_message_pair", ledger.append_message_pair)
    monkeypatch.setattr(caddie_routes, "run_caddie_turn", fact_stub)

    real_resolve_tool = caddie_routes.caddie_tools.resolve_tool
    resolve_tool_spy = _ResolveToolSpy(real_resolve_tool)
    monkeypatch.setattr(caddie_routes.caddie_tools, "resolve_tool", resolve_tool_spy)

    real_classify_intent = caddie_routes.classify_intent
    classify_spy = _ClassifyIntentSpy(real_classify_intent)
    monkeypatch.setattr(caddie_routes, "classify_intent", classify_spy)

    real_run_strategy_turn = caddie_routes.run_strategy_turn
    strategy_spy = _RunStrategyTurnSpy(real_run_strategy_turn)
    monkeypatch.setattr(caddie_routes, "run_strategy_turn", strategy_spy)

    app = FastAPI()
    app.include_router(caddie_routes.router)
    app.dependency_overrides[caddie_rate_limited_user] = lambda: "user-1"
    client = TestClient(app)

    records: list[TurnRecord] = []
    prev_synth_calls = 0
    prev_fact_calls = 0

    for turn in scenario.turns:
        body: dict[str, Any] = {
            "round_id": session.round_id,
            "transcript": turn.transcript,
            "personality_id": "classic",
        }
        # None = genuinely omit the key (real-client-omission case); a
        # scenario that wants the falsy-but-present `0` still sends it.
        if turn.hole_number is not None:
            body["hole_number"] = turn.hole_number
        if turn.distance_to_green_yards is not None:
            body["distance_to_green_yards"] = turn.distance_to_green_yards
        if turn.hole_yards is not None:
            body["hole_yards"] = turn.hole_yards
        if turn.yardage_basis is not None:
            body["yardage_basis"] = turn.yardage_basis

        res = client.post(_VOICE_URL, json=body)
        assert res.status_code == 200, (
            f"scenario {scenario.id!r} turn {turn.transcript!r} -> "
            f"{res.status_code}: {res.text}"
        )
        reply = res.json()["response"]

        intent = classify_spy.calls[-1][1]
        synth_delta = synth.calls - prev_synth_calls
        fact_delta = len(fact_stub.calls) - prev_fact_calls
        prev_synth_calls = synth.calls
        prev_fact_calls = len(fact_stub.calls)

        strategy_turn_hole = strategy_spy.calls[-1]["hole"] if intent is Intent.ADVICE else None
        captured = fact_stub.calls[-1] if intent in (Intent.FACT, Intent.OTHER) else None

        records.append(TurnRecord(
            transcript=turn.transcript,
            hole_number_sent=turn.hole_number,
            intent=intent,
            reply=reply,
            synth_delta=synth_delta,
            fact_delta=fact_delta,
            strategy_turn_hole=strategy_turn_hole,
            captured_messages=captured.messages if captured else None,
            captured_system=captured.system if captured else None,
        ))

    return ConversationResult(
        scenario=scenario, session=session, turns=records, synth=synth, fact_stub=fact_stub,
        ledger=ledger, resolve_tool_spy=resolve_tool_spy, strategy_spy=strategy_spy,
        classify_spy=classify_spy, hole_tracker=hole_tracker,
    )


# ── Pure sequence-check functions (§5) — no pytest, feedable with mutants ──


def check_turn_expectations(result: ConversationResult) -> CheckResult:
    """P1 — per-turn fingerprint: classified Intent + the arm's synth/fact
    call-delta fingerprint + any exact-equality reply pins. Also the
    resolve_tool tripwire (§4.2b): must stay at 0 calls across the WHOLE
    scenario."""
    failures: list[str] = []
    for i, (turn, record) in enumerate(zip(result.scenario.turns, result.turns)):
        exp = turn.expect
        if record.intent is not exp.intent:
            failures.append(f"turn {i}: expected intent {exp.intent}, got {record.intent}")
        if record.synth_delta != exp.synth_delta:
            failures.append(
                f"turn {i}: expected synth_delta={exp.synth_delta}, got {record.synth_delta}"
            )
        if record.fact_delta != exp.fact_delta:
            failures.append(
                f"turn {i}: expected fact_delta={exp.fact_delta}, got {record.fact_delta}"
            )
        if exp.reply_equals_handoff and record.reply != caddie_routes._SCORE_TEXT_HANDOFF_LINE:
            failures.append(f"turn {i}: expected the SCORE handoff line, got {record.reply!r}")
        if exp.reply_equals_fact_answer and record.reply != result.scenario.fact_answer:
            failures.append(
                f"turn {i}: expected the canned fact answer, got {record.reply!r}"
            )
        if exp.same_reply_as_turn is not None:
            ref = result.turns[exp.same_reply_as_turn].reply
            if record.reply != ref:
                failures.append(
                    f"turn {i}: expected byte-equal reply to turn {exp.same_reply_as_turn}, "
                    f"got {record.reply!r} != {ref!r}"
                )
        if exp.different_reply_from_turn is not None:
            ref = result.turns[exp.different_reply_from_turn].reply
            if record.reply == ref:
                failures.append(
                    f"turn {i}: expected a DIFFERENT reply from turn "
                    f"{exp.different_reply_from_turn}, got byte-identical {record.reply!r}"
                )
    if result.resolve_tool_spy.calls != 0:
        failures.append(
            f"resolve_tool tripwire: expected 0 calls, got {result.resolve_tool_spy.calls}"
        )
    return CheckResult(not failures, "; ".join(failures) if failures else "ok")


def check_no_dupes(result: ConversationResult) -> CheckResult:
    """P2 (dim 1) — for adjacent turns with distinct normalized transcripts,
    assistant replies differ; the SCORE handoff line appears on exactly the
    SCORE-expected turns. Three SANCTIONED exceptions to the adjacency rule,
    each requiring an EXPLICIT expectation (never an unexplained pass):
    identical transcripts (`repeat-ask-consistency` — a legitimate identical
    reply to an identical ask); a real cache hit on a DIFFERENT transcript
    within the same hole/session state (`followup-club-advice-same-hole` —
    P3's one-brain-answer-per-hole-state design, e.g. "what should I hit
    here?" / "driver or 3-wood here?" resolving to the same ground truth),
    both pinned via `same_reply_as_turn`; and two SCORE turns both hitting
    the CONSTANT handoff line (`score-multi-player-then-fact` — the handoff
    line is deliberately the same string for every SCORE turn, never a sign
    the caddie parroted a stuck substantive answer), pinned via `expect.
    reply_equals_handoff` on both turns. Anything else with identical
    adjacent replies is a genuine duplicate-reply bug."""
    failures: list[str] = []

    def norm(t: str) -> str:
        return " ".join(t.lower().split())

    records = result.turns
    scenario_turns = result.scenario.turns
    for i in range(len(records) - 1):
        if norm(records[i].transcript) != norm(records[i + 1].transcript):
            if records[i].reply == records[i + 1].reply:
                sanctioned = (
                    scenario_turns[i + 1].expect.same_reply_as_turn == i
                    or (
                        scenario_turns[i].expect.reply_equals_handoff
                        and scenario_turns[i + 1].expect.reply_equals_handoff
                    )
                )
                if not sanctioned:
                    failures.append(
                        f"turns {i} and {i + 1} have distinct transcripts but identical "
                        "replies, with no explicit sanction"
                    )

    for i, (turn, record) in enumerate(zip(result.scenario.turns, records)):
        is_handoff = record.reply == caddie_routes._SCORE_TEXT_HANDOFF_LINE
        expects_handoff = turn.expect.reply_equals_handoff
        if is_handoff != expects_handoff:
            failures.append(
                f"turn {i}: handoff-line presence {is_handoff} != expected {expects_handoff}"
            )

    return CheckResult(not failures, "; ".join(failures) if failures else "ok")


def check_club_consistency(replies: list[str], club_distances: dict[str, int]) -> CheckResult:
    """P4 (dim 5) — `substance.extract_substance` (the EXISTING extractor)
    over every given ADVICE reply: `club` and `endorsed_club` must be
    identical across replies. FAILS (never a vacuous pass) if any reply
    yields no recognizable club — inconclusive is red."""
    if not replies:
        return CheckResult(False, "no replies given — cannot check club consistency")

    substances = [substance_mod.extract_substance(r, club_distances) for r in replies]
    for i, s in enumerate(substances):
        if s.club is None:
            return CheckResult(
                False,
                f"reply {i} named no recognizable club — inconclusive, not a pass: {replies[i]!r}",
            )

    clubs = {s.club for s in substances}
    if len(clubs) > 1:
        return CheckResult(False, f"club mismatch across replies: {clubs}")

    endorsed = {s.endorsed_club for s in substances if s.endorsed_club is not None}
    if len(endorsed) > 1:
        return CheckResult(False, f"endorsed-club mismatch across replies: {endorsed}")

    return CheckResult(True, f"consistent club={clubs!r}")


def check_history_renders_in_order(
    messages: list[dict], expected_pairs: list[tuple[str, str]], current_transcript: str,
) -> CheckResult:
    """P3-OTHER (dim 3) — every prior ledger (user, assistant) pair must
    appear in `messages` (the REAL output of `_build_session_voice_prompt`),
    in order, exact role+content, strictly before the current transcript
    (which must be last). Mirrors `checks.check_history_renders_in_order`'s
    containment logic. Fail-closed: pairs non-empty but messages empty is a
    failure, not a vacuous pass."""
    if not expected_pairs:
        return CheckResult(True, "no prior pairs to check — trivially in order")
    if not messages:
        return CheckResult(False, "expected prior pairs but messages is empty (fail-closed)")

    cursor = 0
    for user_content, assistant_content in expected_pairs:
        found_user: Optional[int] = None
        for i in range(cursor, len(messages)):
            m = messages[i]
            if m.get("role") == "user" and m.get("content") == user_content:
                found_user = i
                break
        if found_user is None:
            return CheckResult(False, f"user turn {user_content!r} missing or out of order")
        cursor = found_user + 1

        found_assistant: Optional[int] = None
        for i in range(cursor, len(messages)):
            m = messages[i]
            if m.get("role") == "assistant" and m.get("content") == assistant_content:
                found_assistant = i
                break
        if found_assistant is None:
            return CheckResult(
                False, f"assistant turn {assistant_content!r} missing or out of order"
            )
        cursor = found_assistant + 1

    last = messages[-1]
    if last.get("role") != "user" or last.get("content") != current_transcript:
        return CheckResult(
            False, f"final message must be the CURRENT user transcript unchanged, got {last!r}"
        )
    return CheckResult(True, "all prior pairs render in order, current transcript last")
