# Multi-turn conversation & router eval — offline conversation-runner (silent, tests-only)

**Status:** planned · **Rider on:** bundle PR #147 (silent — no owner-noticeable change)
**Scope:** `backend/tests/eval/` ONLY. No product/runtime code changes (contingency exception in §9).
**Offline:** no keyed LLM calls, no network, no Postgres, no docker. Collected by the normal
`cd backend && uv run pytest tests/eval` gate — no env guard, unlike `run_tier2.py`/`run_consistency.py`.

## 1. The gap

The existing caddie evals are single-turn: one ask → one assembled prompt or one answer, asserted
in isolation. The dimensions that regress silently are conversational and unmeasured:

- **dim 1** — no duplicate replies across a turn *sequence*
- **dim 3** — flowing context: "what about a 3-wood instead?" must reuse the same hole/payload,
  never re-derive from scratch
- **dim 5** — consistency: advice → fact → advice in one session must not contradict; the club
  from turn 1 must survive to turn 3
- **router** — mid-conversation intent switches (advice → score → fact → advice) must route each
  turn to the correct tier with zero cross-contamination: a SCORE turn never invokes the strategy
  synth; a FACT turn never writes a score
- **hole swaps** — answer-time hole resolution must be fresh per turn and pinned at conversation
  level (`request.hole_number or session.current_hole`), not stale from an earlier turn

## 2. Fidelity bar — drive the REAL route, stub only at the network/DB seams

The #1 design risk is **testing a mock of a mock**: a "conversation runner" that reimplements
dispatch would prove nothing about `session_voice`. We avoid it by driving the **real**
`POST /api/caddie/session/voice` (`backend/app/routes/caddie.py::session_voice`, ~line 989)
through a throwaway `FastAPI()` + `TestClient`, exactly like
`tests/eval/test_strategy_tool.py::_strategy_client`. Everything on the dispatch path is real:

REAL (exercised): `classify_intent` · the ADVICE/SCORE/FACT-OTHER dispatch arms ·
`run_strategy_turn` (payload assembly, `format_strategy_ground_truth`, `cache_key`/
`cache_lookup`/`cache_store`, `validate_strategy_text`, `compose_degraded_line`) ·
`_build_session_voice_prompt` (history rendering, volatile hole block) · `_SCORE_TEXT_HANDOFF_LINE`.

STUBBED (only the seams the existing suite already stubs — network egress + DB):
`strategy_mod.synthesize_strategy` (OpenAI) · `run_caddie_turn` (Anthropic tool loop) ·
`sessions.append_message_pair` / `set_current_hole` / `set_recommendation` ·
`get_owned_session` · `load_personality` / `personality_visible` / `memory_mod.get_top_memories` /
`memory_mod.get_player_profile`.

SPIED (recording wrappers that **delegate to the real function**, never replace behavior):
`classify_intent` (records the Intent per turn) · `run_strategy_turn` (records the resolved
`hole` arg + returned dict) · `caddie_tools.resolve_tool` (score-write / tool tripwire — must
stay at 0 calls, since the tool loop is stubbed out entirely).

Every assertion reads an effect produced by REAL code (reply text, ledger content, cache
behavior observed as synth-call deltas, validator accept/reject) — stub call-counts are only
ever asserted *alongside* a real-output assertion, never alone.

## 3. New files

| File | Responsibility |
|---|---|
| `backend/tests/eval/conversation_runner.py` | The sequence executor: dataclasses (`ConversationTurn`, `TurnExpect`, `ConversationScenario`, `TurnRecord`, `ConversationResult`), the stub/spy installers, `run_conversation(scenario, monkeypatch) -> ConversationResult`, and the pure sequence-check functions (`check_no_dupes`, `check_club_consistency`, …). No pytest imports beyond monkeypatch typing — checks are pure so teeth can feed them hand-built mutant ledgers. |
| `backend/tests/eval/conversations.py` | The ~10 python-defined scenario scripts + the shared session fixtures (`hole5/hole7/hole12` intel builders mirroring `test_strategy_tool._hole7_intel`) + the canned narratives/fact answers. Exports `CONVERSATION_SCENARIOS: list[ConversationScenario]`. |
| `backend/tests/eval/test_conversation_router.py` | Pytest module collected by the normal offline sweep: env-stub header (same as `test_strategy_tool.py` lines 20-22), `_CACHE.clear()` fixture, parametrized `test_conversation[<id>]` running each scenario through the runner and asserting every per-turn expectation + sequence check. |
| `backend/tests/eval/test_conversation_teeth.py` | RED-proofs (§8) — mutant/stub-wrong tests proving every conversation-level assertion can fail. Separate file, following the `test_substance_teeth.py` precedent. |
| `backend/tests/eval/README.md` (edit) | New section "Multi-turn conversation & router (dims 1/3/5 + routing)" documenting the runner, the scenario format decision, and the manual-mutation drill addition. |

**Scenario format decision: python-defined, not JSONL.** Justification: per-turn expectations
here are *code-shaped* — expected `Intent` enum members, synth-call deltas, per-turn stub
behavior (raise vs. return), references to `compose_degraded_line` for exact-equality — none of
which serialize honestly to JSONL. The golden JSONL's closed-registry safety (typo = load-time
`ValidationError`) is preserved structurally: `ConversationTurn`/`TurnExpect` are frozen
dataclasses (or pydantic models with `extra="forbid"`), so a typo'd expectation field is an
import-time error, same guarantee by a different mechanism. The JSONL stays the home of
single-turn golden scenarios; conversations are scripts, and scripts live in code.

## 4. Stub contracts (precise)

### 4.1 `_ScriptedSynth` — counting stub for `strategy_mod.synthesize_strategy`
Extends the proven `_FakeSynth` shape (`test_strategy_tool.py` ~line 851):

```
class _ScriptedSynth:
    calls: int                      # total invocations
    ground_truths: list[str]        # the exact GT block per call (ordered)
    script: list[SynthStep]         # per-CALL behavior: return text | raise exc
    async def __call__(self, ground_truth: str, *, model: str) -> tuple[str, dict]
```

- Signature must match the real `synthesize_strategy(ground_truth, *, model)` returning
  `(text, usage_dict)`.
- **Keyed canned narratives:** each returned text is a hole-specific, validator-clean narrative
  (names the engine's recommended club with word boundaries, agrees with the engine's favor
  side, names only real hazards — modeled on `_CLEAN_NARRATIVE`). Because the narratives must
  pass the REAL `validate_strategy_text` + verdict pin to be returned undegraded, an invalid
  canned text goes loudly red (`degraded=True` reply ≠ expected) — built-in teeth.
- Distinct ground truths get distinct narratives (e.g. hole-5 vs hole-12 texts), so a
  re-derivation against a *contaminated* payload surfaces as a changed reply, not just a count.
- Patched at `strategy_mod.synthesize_strategy` (module attribute), same as today.

### 4.2 `_FakeCaddieTurn` — async-generator stub for `run_caddie_turn` (FACT/OTHER arm)
The real contract (`app/caddie/tool_loop.py::run_caddie_turn`): an **async generator** with
signature `(client, model, system, messages, ctx, on_usage=None)` yielding `(kind, payload)`
frames — zero or more `("token", str)`, optional `("status", str)`, and **exactly one
`("done", full_text)`** terminal frame. `session_voice` keeps only the `done` payload. The stub
must match exactly:

```
class _FakeCaddieTurn:
    calls: list[CapturedTurn]   # (system_blocks, messages, ctx) per invocation
    answer: str                 # canned fact answer, e.g. "You've got 152 to the front, wind helping a touch."
    async def __call__(self, client, model, system, messages, ctx, on_usage=None):
        self.calls.append(CapturedTurn(system, list(messages), ctx))
        yield ("token", self.answer)          # exercise the ignored-frame path
        yield ("done", self.answer)
```

Patched at `caddie_routes.run_caddie_turn` (the name `session_voice` calls). Capturing
`messages`/`system` is what makes the dim-3 context-flow assertions real: they are the REAL
output of `_build_session_voice_prompt`, inspected at the exact point Claude would have
received them.

**Score-write non-vacuity:** the text mouth has no server-side score write today —
`record_scores` is `REALTIME_ONLY_TOOLS` (dispatched via HTTP by the orb, never
`resolve_tool`), and the SCORE arm returns `_SCORE_TEXT_HANDOFF_LINE` before any tool runs. So
"a FACT turn must never write a score" is asserted from three observable effects, not a
tautology: (a) a spy wrapper on `caddie_tools.resolve_tool` (delegating to real; with the tool
loop stubbed it must record **zero** calls across every scenario — if any future change routes
a tool/score write through the text path, this trips); (b) the FACT turn's reply equals the
canned fact answer and is **not** `_SCORE_TEXT_HANDOFF_LINE`; (c) `_ScriptedSynth.calls` delta
is 0 for the turn. The teeth mutant in §8 proves (b) can go red. If a server-side text-mouth
score write ever lands, the tripwire seam moves to that write function — noted in the README.

### 4.3 In-memory ledger for `sessions.append_message_pair`
The real method writes two `caddie_messages` rows atomically. The fake must both **record** and
**feed context forward**, or dim-3 assertions become vacuous:

```
class _Ledger:
    pairs: list[LedgerPair]     # (user_content, assistant_content, hole_number), ordered
    async def append_message_pair(self, round_id, user_content, assistant_content, hole_number=None):
        self.pairs.append(...)
        session.conversation_history += [VoiceCaddieMessage(role="user", content=user_content),
                                         VoiceCaddieMessage(role="assistant", content=assistant_content)]
```

Patched at `caddie_routes.sessions.append_message_pair` (instance attribute — the
`test_golden_tier1._patch_session_builder_deps` idiom already patches this singleton's
`set_current_hole`). Because the runner's `get_owned_session` fake returns the **same shared
`RoundSession` object** every turn (never a copy — this models DB persistence), the appended
history is exactly what `_build_session_voice_prompt` renders into `messages` on the next turn.

### 4.4 Remaining seam patches (reuse existing idioms — do not invent new ones)
- `caddie_routes.get_owned_session` → returns the scenario's shared `RoundSession`
  (`test_strategy_tool._strategy_client` idiom).
- `app.dependency_overrides[caddie_rate_limited_user] = lambda: "user-1"` — `session_voice`
  depends on `caddie_rate_limited_user` (`app/services/rate_limit.py`), not bare
  `current_user_id`; override the outer dependency so the limiter never runs.
- `monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")` — `session_voice` 500s without
  it *before* dispatch (line ~1001); constructing `AsyncAnthropic` makes no network call.
- `_patch_session_builder_deps` family (`test_golden_tier1.py` lines 47-67) for
  `personality_visible`/`load_personality`/`get_top_memories`, with ONE deviation:
  `set_current_hole` is not a no-op here — it records the call **and** sets
  `session.current_hole = hole_number` on the shared session, preserving the conversation-level
  hole-pin semantics the scenarios assert.
- `_no_db_persist` family (`test_strategy_tool.py` lines 50-63) for
  `tools_mod.sessions.set_recommendation` + `tools_mod.memory_mod.get_player_profile`.
- `strategy_mod._CACHE.clear()` autouse fixture per test (existing `_clear_strategy_cache`
  idiom) — each conversation starts cold; *within* a conversation the cache is real and load-bearing.
- Env header before app imports: `DATABASE_URL` stub + `LOOPER_SECRETS_DISABLED=1`
  (`test_strategy_tool.py` lines 20-22).

## 5. How each property class is asserted (non-vacuously)

| # | Property | Assertion (real seam effects) | Vacuity guard |
|---|---|---|---|
| P1 | Correct tier per turn | Recorded `classify_intent` return == expected `Intent` **and** the arm's fingerprint: ADVICE → synth-calls delta per expectation + reply == validated narrative; SCORE → reply == `_SCORE_TEXT_HANDOFF_LINE`, synth delta 0, fact-stub delta 0; FACT/OTHER → fact-stub delta 1, reply == canned fact answer, synth delta 0, `resolve_tool` spy still 0 | Teeth M1/M5: intent-blind and SCORE→ADVICE mutants go red |
| P2 | No dupes across sequence | Pure `check_no_dupes(ledger)`: for adjacent turns with distinct normalized transcripts, assistant replies differ; `_SCORE_TEXT_HANDOFF_LINE` appears on exactly the SCORE-expected turns | Repeat-ask scenario (S4) proves the check does NOT fire on a legitimate identical reply to an identical ask (expectation `same_reply_as_turn=N` is explicit) |
| P3 | Same-payload reuse (dim 3) | ADVICE follow-up on same hole: `synth.calls` does NOT increment (real cache hit — `cache_key` over the real byte-identical ground truth) AND `ground_truths` recorded so far contain no new entry AND reply is byte-equal to turn 1's; OTHER follow-up: captured `messages` contain every prior ledger pair in order, current transcript last (same containment logic as `check_history_renders_in_order`), and the volatile `CURRENT SITUATION` block names the same hole | Teeth M2 (cache_lookup→None mutant) and M7 (ledger-doesn't-feed-history mutant) go red |
| P4 | Consistency / no contradiction (dim 5) | `substance.extract_substance` (the EXISTING extractor — no new one) over every ADVICE reply on the same hole: `club` and `endorsed_club` identical across turns; hazard sets identical. The check FAILS (never passes) if an ADVICE reply yields `club is None` — inconclusive is red, not green. Side consistency is enforced structurally by the real verdict pin (`validate_strategy_text` rejects a favor-side flip) + byte-equal cache replies; do NOT write a side extractor | Teeth M3: always-pass detector and None-club vacuity both proven red |
| P5 | Hole freshness on swap | `run_strategy_turn` spy's recorded `hole` args == expected sequence (e.g. `[5, 12]`); `ground_truths` differ between the two turns; replies differ and each names its own hole's engine club (via `extract_substance`); `set_current_hole` recording pins the conversation-level hole after FACT turns | Teeth M4: hole-pinning mutant goes red |
| P6 | Degrade doesn't poison (dim 5 + reliability) | Turn N (synth raises or returns a side-flipped narrative): reply exact-equals the REAL `compose_degraded_line` output computed via the `_expected_degraded_line` idiom (never a hand-written copy). Turn N+1 (same ask, synth now good): `synth.calls` incremented (cache was NOT poisoned — real `run_strategy_turn` only stores non-degraded) and reply == the good validated narrative, ≠ the degraded line | Teeth M6: degrade-caching mutant goes red |

## 6. The scenario scripts (`conversations.py`) — ~10, with expected per-turn tiers

Shared fixtures: hole 5 / hole 7 / hole 12 `HoleIntelligence` builders with distinct pars,
yardages, hazards, and therefore distinct engine recommendations and distinct canned
narratives; session `club_distances={"driver": 300, "7iron": 160, "3wood": 230}`, weather set.
Transcripts below are pre-verified against `routing.py`'s actual regexes — **never weaken a
transcript to force a classification** (§9).

| id | Turns (transcript → expected Intent) | Sequence assertions |
|---|---|---|
| `intent-switch-chain` | 1 "what's the play here?" →ADVICE · 2 "put me down for a 5" →SCORE · 3 "how far to the front?" →FACT · 4 "should I go for it?" →ADVICE | P1 fingerprints per turn; T2 reply == handoff, synth delta 0; T3 fact stub fires, reply ≠ handoff, resolve_tool 0; T4 cache hit (synth.calls==1 total), reply byte-equal T1; P4 club identical T1/T4 |
| `followup-club-advice-same-hole` | 1 "what should I hit here?" →ADVICE · 2 "driver or 3-wood here?" →ADVICE | Same hole ⇒ same ground truth ⇒ real cache hit: synth.calls==1, replies byte-equal — pins the one-brain-answer-per-hole-state design (P3) |
| `followup-other-context-flow` | 1 "how do I play this one?" →ADVICE · 2 "what about a 3-wood instead?" →**OTHER** (verified: matches no ADVICE/FACT/SCORE regex — document this honestly in the scenario) | T2: fact-stub's captured `messages` contain T1's user+assistant pair in order, transcript last; volatile block names the same hole; synth delta 0 (no re-derivation) (P3-OTHER) |
| `repeat-ask-consistency` | 1 "what's the play?" →ADVICE · 2 "what's the wind?" →FACT · 3 "what's the play?" →ADVICE | T3 `same_reply_as_turn=1` (explicit expectation), synth.calls==1, `extract_substance` identical T1/T3 (P4); the intervening FACT turn must not perturb the ADVICE payload |
| `hole-swap-advice` | 1 "what's the play here?" (hole 5) →ADVICE · 2 "what's the play here?" (hole_number=12) →ADVICE | synth.calls==2; run_strategy_turn spy holes == [5,12]; ground truths differ; replies differ; each reply's club == that hole's engine club (P5) |
| `fact-then-advice-hole-pin` | 1 "how far to the front?" (hole_number=9) →FACT · 2 "should I go for it?" (hole_number=0) →ADVICE | T1: `set_current_hole` recorded with 9, shared session.current_hole==9; T2: `request.hole_number or session.current_hole` fallback resolves the spy's hole to **9** — exercises the answer-time conversation-level pin. NOTE for the builder: `SessionVoiceRequest.hole_number: int = 1` (truthy default) makes this fallback unreachable from a default-sending client — if that reads as a real wart, §9 applies (flag/file it; do not silently change the model) |
| `score-multi-player-then-fact` | 1 "par for me, birdie for Mike" →SCORE · 2 "put me down for a 5" →SCORE · 3 "where do I stand?" →FACT | Handoff line on exactly T1/T2; T3 fact stub fires, reply ≠ handoff; synth.calls==0 for the whole scenario; resolve_tool 0 (the fact-turn-never-writes-a-score pin) |
| `score-exclusion-stays-fact` | 1 "I made a 4" →SCORE · 2 "what do I need to shoot par on the back nine?" →**FACT** (`_SCORE_EXCLUSION_PATTERN` row) · 3 "what's the play?" →ADVICE | T2 must NOT get the handoff line despite score-shaped words and a preceding SCORE turn (proves per-turn purity holds at conversation level); T3 synth fires normally |
| `degraded-synth-then-retry` | 1 "what's the play here?" →ADVICE (synth script: **raise** `RuntimeError("simulated timeout")`) · 2 "what's the play here?" →ADVICE (script: return good narrative) | T1 reply exact-equals real `compose_degraded_line` (via `_expected_degraded_line` idiom); T2 synth.calls==2 (no poisoned cache) and reply == good narrative ≠ degraded line (P6, exception branch) |
| `validator-reject-then-retry` | 1 "what's the play here?" →ADVICE (script: return side-flipped narrative) · 2 same ask (script: clean narrative) | Same shape as above via the validator-reject branch — the real `validate_strategy_text` does the rejecting (P6, reject branch) |

P2 (`check_no_dupes`) runs over every scenario's ledger. Roughly 10 scenarios; do not pad with
near-duplicates (README's honesty rule).

## 7. Wiring into the offline sweep

`test_conversation_router.py` matches the `test_*.py` glob → collected by
`cd backend && uv run pytest tests/eval` and the normal backend CI gate automatically. Fully
offline and deterministic: no gate env vars, no budget, no network (`synthesize_strategy` and
`run_caddie_turn` never reach httpx/anthropic). Keep per-test runtime small — the payload
assembly (`build_strategy_payload`) is pure-compute; the whole module should run in seconds.

## 8. Teeth — RED-proofs (`test_conversation_teeth.py`)

Per the harness's #1 rule ("an eval that can't fail is worse than none"), every conversation
assertion family gets a mutant proof. Mutants are INTERNAL (monkeypatched stand-ins) — never
edits to real source:

- **M1 intent-blind runner:** monkeypatch `caddie_routes.classify_intent` to always return
  `Intent.OTHER` → run `intent-switch-chain` → the P1 fingerprint assertions must fail
  (with `pytest.raises(AssertionError)` / a failed `CheckResult`, the `test_substance_teeth` style).
- **M2 re-derive instead of reuse:** monkeypatch `strategy_mod.cache_lookup` to always return
  `None` → `followup-club-advice-same-hole`'s `synth.calls==1` goes red.
- **M3 contradiction detector always-passes + inconclusive-is-red:** (a) feed
  `check_club_consistency` a hand-built ledger whose turn-3 advice endorses a different club →
  must fail; (b) a ledger whose advice reply contains no recognizable club → must ALSO fail
  (never a vacuous pass on extraction failure).
- **M4 stale hole:** monkeypatch the route-level `run_strategy_turn` name with a wrapper that
  forces `hole=5` regardless of argument → `hole-swap-advice` goes red (spy holes ≠ [5,12] and
  replies collapse to one narrative).
- **M5 SCORE cross-contamination:** monkeypatch `classify_intent` to map SCORE→ADVICE →
  `score-multi-player-then-fact` goes red (synth delta ≠ 0, reply ≠ handoff line).
- **M6 degrade poisoning:** monkeypatch so the degraded result IS cached (e.g. wrap
  `run_strategy_turn` to `cache_store` its degraded output) → `degraded-synth-then-retry` goes
  red (T2 returns the calcified degraded line, synth.calls stays 1).
- **M7 ledger that doesn't feed context:** install an `append_message_pair` fake that records
  pairs but does NOT extend `session.conversation_history` →
  `followup-other-context-flow`'s message-containment assertion goes red — proves the dim-3
  check depends on real context plumbing, not on the ledger's own bookkeeping.

README addition: extend the manual mutation drill with one conversation-level step (comment out
the `intent is Intent.ADVICE` arm's `run_strategy_turn` call in `routes/caddie.py`, watch
`test_conversation[intent-switch-chain]` go red, revert, paste the red output in the PR).

## 9. Contingency — if a scenario exposes a real router/route bug

Scenarios are written against intended behavior. If one fails against real code:
- **Small, obvious fix** (a regex row, a dispatch guard): fix in-pass in this PR, with the
  failing scenario as the regression test and the delta called out for the reviewer.
- **Anything bigger** (e.g. the `hole_number: int = 1` truthy-default making the
  `session.current_hole` fallback dead from real clients, if judged product-relevant): file to
  backlog with the failing/xfail scenario as the repro.
- **Never** weaken, re-phrase, or delete a scenario to make it pass — that is the
  "don't edit tests to make them pass" rule applied to evals.

## 10. Build order

1. `conversation_runner.py` — dataclasses, stub/spy installers, `run_conversation`, pure checks.
2. `conversations.py` — fixtures + the first three scenarios (`intent-switch-chain`,
   `followup-club-advice-same-hole`, `hole-swap-advice`); get them green against real code.
3. Remaining scenarios (degrade pair last — they need the per-call synth script).
4. `test_conversation_teeth.py` — M1-M7.
5. README section + mutation-drill step.
6. Gates.

## 11. Gates (run by the builder; all offline)

```bash
cd backend && ruff check .
cd backend && uv run pytest tests/eval          # the eval sweep incl. the new module + teeth
cd backend && uv run pytest                     # full offline backend sweep (the normal CI gate)
```

No `run_tier2`/`run_consistency` involvement — nothing here is gated or costs money. Lands as a
silent rider on bundle PR #147; board note only, no owner ping (silent-work rule).
