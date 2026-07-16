# Caddie Experience Measurement Harness — Implementation Plan

Owner directive (verbatim): *"Most important to this app is improving the caddie experience, no dupes, smart caddy, nice flowing conversation, voice that doesn't sound robotic, consistency, reliability, minimal loading."*

Status: PLAN (fable). Classification: **SILENT** (tests/tooling/docs only — no user-visible surface; NORTHSTAR-compliant by construction: it protects the calm, voice-first feel rather than adding chrome).
Branch: `integration/next`. This is ONE pass: everything deterministic/offline lands now; everything needing API keys, Postgres, or a device ships as **gated, runnable-later tooling + documented methodology** (mirroring `backend/tests/eval/run_tier2.py`'s gating exactly). Verified: `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are both unset in this environment — **no live baseline can or will be captured this pass; no number is fabricated.**

> ENG-LEAD OVERRIDE (2026-07-15) folded into §2.4: `voice_id="fable"` (The Professor, `backend/app/caddie/personalities.py:123`) is an INVALID OpenAI Realtime voice (fable is a legacy TTS-only voice; Realtime rejects it with an enum error — it does NOT silently fall back). The dim-4 voice-config pin test must assert every personality `voice_id` is a VALID Realtime voice from the closed set {alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar}, and the builder repoints The Professor `fable → cedar` as the correctness fix (a teeth test that would have caught this). The audible DEFAULT-voice swap (Classic → cedar) and the speed 1.15→~1.0 nudge stay owner-gated (filed, not landed).

## 0. The eight dimensions → where each is measured

| # | Dimension | Measured by (existing) | Measured by (NEW, this plan) |
|---|---|---|---|
| 1 | no dupes | `realtime-noinput/attribution/ordering.test.ts`, `priming-echo.test.ts`, `CaddieSheet.realtime.test.tsx` | suite membership + glitch tests assert exactly-once bubbles (§4) |
| 2 | smart caddie | `backend/tests/eval` tier1 golden set + tier2 (gated) | multi-turn golden scenarios + `history_renders_in_order` check (§2) |
| 3 | flowing conversation | `realtime-ordering.test.ts`, `caddie-turn-timing.test.ts`, `CaddieSheet.realtime.test.tsx` transcript-order tests | multi-turn scenarios (follow-up, challenge-and-admit) (§2); glitch tests keep flow across drops (§4) |
| 4 | non-robotic voice | — (voice selection: `personalities.py` voice_ids; `realtime_relay.py` voice "sage", speed 1.15) | deterministic session-config pins in tier1 style (§2.4); soft quality stays a gated tier2-judge property, later |
| 5 | consistency | — | substance extractor (lands now) + gated `run_consistency.py` probe (§3) |
| 6 | reliability | `realtime-lifecycle/warm.test.ts`, `warm-session.test.ts`, Slice D/E reconnect+suspend tests in `CaddieSheet.realtime.test.tsx` | NEW `CaddieSheet.realtime-glitch.test.tsx`: reconnect mid-answer, hole-change mid-answer (§4) |
| 7 | minimal loading | `caddie-turn-timing.ts` telemetry (`caddie.eos_to_first_audio`, surfaces `caddie-turn`/`caddie-rt`, immediate flush) + `warm-session.ts` pool | latency methodology + gated `run_latency.py` (§5); baseline table left TBD (no keys) |
| 8 | well-integrated | `realtime-dispatch.test.ts`, `test_tool_parity.py` | suite membership + README mapping (§1) |

---

## 1. Deliverable A — the named "caddie-experience" suite/gate

Deterministic, offline command per side, runnable locally and as a CI-grade gate. No CI YAML change this pass (CI already runs supersets: `npm run test` and backend `pytest`); the named gate exists for focused regression runs and the bundle-review checklist.

**Mechanism (frontend):** a single-source-of-truth manifest + a dedicated vitest config + an npm script.

Files to CREATE:
- `frontend/src/lib/voice/caddie-experience-suite.ts` — exports `CADDIE_EXPERIENCE_SUITE: { file: string; dimensions: number[] }[]` listing, by explicit relative path, every suite member: realtime-attribution(1,6) · realtime-dispatch(8) · realtime-lifecycle(6) · realtime-noinput(1,3) · realtime-ordering(1,3) · realtime-warm(6,7) · warm-session(6,7) · priming-echo(1) · caddie-turn-timing(7) · telemetry(7) · idle-timer(6) · noinput-clarifier(3,6); components CaddieSheet.realtime(1,3,6) · CaddieOrbSheet(3,8) · CaddieSheet.handsfree(3,6) *(confirm exact filenames at build time)*; NEW CaddieSheet.realtime-glitch(1,6).
- `frontend/vitest.caddie-experience.config.ts` — `mergeConfig(baseConfig, { test: { include: CADDIE_EXPERIENCE_SUITE.map(e => e.file) } })`, importing base `vitest.config.ts` (keeps `@` alias + per-file env — zero drift).
- `frontend/src/lib/voice/caddie-experience-suite.test.ts` — **manifest guard** (runs in normal `npm run test`): (a) every manifest `file` exists (`fs.existsSync`); (b) every dimension 1–8 has ≥1 mapped file; (c) `package.json` `test:caddie-experience` references the config. **RED-proof:** rename/delete a suite file → (a) fails naming the path; remove all dim-5 entries → (b) fails.
- Root `CADDIE_EXPERIENCE.md` — the dimension table, gate commands, gated-tools commands, latency methodology (§5), and the (empty, honest) baseline table.

Files to MODIFY: `frontend/package.json` — add `"test:caddie-experience": "vitest run --config vitest.caddie-experience.config.ts"`.

Gate: `cd frontend && npm run test:caddie-experience`; `cd backend && uv run pytest tests/eval`.

**Not chosen:** a mega test file importing other test files (breaks per-file env docblocks); bare name-pattern args (silent no-match drift — the manifest guard is what makes membership falsifiable).

## 2. Deliverable C — multi-turn conversation-quality evals (dims 2/3), deterministic-first

All changes in `backend/tests/eval/` (zero overlap with the dedup lane). The text mouth (`_build_session_voice_prompt`) renders `session.conversation_history[-20:]` into `messages` (`backend/app/routes/caddie.py` ~810) and carries `"You have memory of the entire round conversation and prior rounds."` (~831). `RoundSession.conversation_history` is `list[VoiceCaddieMessage]` (`session.py:60`). Stable seam: **context-retention plumbing is fully assertable offline.**

### 2.1 Schema (MODIFY `schema.py`)
- `Situation` gains `history: list[HistoryTurn] = []` (`HistoryTurn`: `role: Literal["user","assistant"]`, `content: str`, `extra="forbid"`).
- `Tier1CheckName` gains `HISTORY_RENDERS_IN_ORDER = "history_renders_in_order"`.
- `Tier2JudgeProperty` gains `USES_CONVERSATION_CONTEXT = "uses_conversation_context"`.

### 2.2 Checks (MODIFY `checks.py`, `test_golden_tier1.py`)
- `build_round_session` seeds `conversation_history` from `scenario.situation.history`.
- `Tier1Context` gains `text_messages: list[dict]`; `_build_prompts` passes the real `messages` from `_build_session_voice_prompt`.
- `check_history_renders_in_order`: every seeded history turn appears in `ctx.text_messages` with exact role+content, same relative order, all strictly before the final user transcript (which must be last). Fails on dropped/reordered/after-transcript history, or empty `text_messages` when history non-empty (fail-closed).
- Register in `TIER1_CHECKS`; existing registry-closure tests enforce coverage.
- Doc note: text-mouth only; the realtime mouth's history lives server-side (covered by frontend ordering/lifecycle suites + the live consistency probe).

### 2.3 Golden scenarios (APPEND to `golden/caddie_advice.jsonl`)
1. `followup-3wood-after-driver` — history: driver reco naming right bunker @240; Q `"what about my 3-wood instead?"`. tier1: `history_renders_in_order`, `prompt_contains_literal("You have memory of the entire round conversation", mouths:["text"])`; tier2_det: `must_mention_any(["3 wood","3-wood","three wood"])`; tier2_judge: `uses_conversation_context`.
2. `context-retention-prior-club-result` — history: prior 7-iron came up short; Q `"same club as last time?"`. tier1: `history_renders_in_order`; tier2_judge: `uses_conversation_context`.
3. `challenge-and-admit-yardage` — history: assistant said "152 to the pin"; Q `"the sprinkler head says 138 — are you sure?"` (+ observation). tier1: `history_renders_in_order`, `prompt_contains_rule OBSERVED_REALITY_RULE`; tier2_judge: `defers_to_observed_reality` (reused).

### 2.4 Dim-4 voice-config pins — NEW `backend/tests/eval/test_realtime_session_config.py`
Pure pytest over `realtime_relay.build_session_payload` (no network): payload sets `audio.output.voice` = personality `voice_id` (fallback `OPENAI_REALTIME_DEFAULT_VOICE` "sage"), `speed == 1.15`. **ENG-LEAD OVERRIDE — voice validity:** assert every `PERSONALITIES` `voice_id` ∈ closed VALID Realtime set `{alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar}`. This FAILS on `fable` → builder repoints The Professor `voice_id="fable" → "cedar"` (personalities.py:123) so it passes — the teeth that catches the broken persona. **RED-proof:** membership/equality pins; reverting speed, dropping the voice key, or reintroducing an invalid voice all go red; companion asserts `build_session_payload(voice_id=None,...)` does NOT omit the voice key (fail-closed). Perceptual "sounds robotic" is out of deterministic scope (documented in CADDIE_EXPERIENCE.md as a gated-judge/on-device follow-up, never faked).

### 2.5 Teeth (MODIFY `test_harness_has_teeth.py`, append)
`history_renders_in_order` mutants: (a) drop a turn → RED; (b) swap two → RED; (c) move transcript before history → RED; (d) real messages PASS. Add to `TIER1_CHECKS_EXERCISED_BY_TEETH`.

## 3. Deliverable B — consistency probe (dim 5): pure extractor now, GATED runner later

Files to CREATE (all `backend/tests/eval/`):
- `substance.py` — **pure, no I/O, lands now.** `extract_substance(answer, club_distances) -> AnswerSubstance { club, yardages(sorted 2–3-digit), hazards(frozenset) }`. Club extraction **reuses** `checks._parse_mentioned_club`/`_build_club_mention_patterns` (import, don't duplicate). Hazards from a closed lexicon (bunker/water/creek/pond/trees/woods/OB/fescue) with plural+synonym folding. `substance_variance(samples) -> VarianceReport { distinct_clubs, club_agreement_rate, hazard_symmetric_diff_max, yardage_spread_max, consistent }` — thresholds: clubs identical; hazard sets identical; yardage spread ≤ tolerance; report (not fail) when a sample omits a number others state.
- `test_substance_teeth.py` — **runs in CI now.** "7 iron"/"carry 240"/"bunker right" extracted right; paraphrase pair w/ identical substance → `consistent=True` (phrasing-insensitivity proof); `["driver","driver","3-wood"]` → `distinct_clubs=2, consistent=False` (RED-proof: diff can go red); stubbed extractor returning `club=None` on club-bearing answer fails (RED-proof); filename pin `run_consistency.py` never matches `test_*`.
- `golden/consistency_probes.jsonl` — 2–3 lines `{scenario_id: <existing golden id>, n: 5, yardage_tolerance: 5}` (tiny pydantic in substance.py; unknown scenario_id fails at load).
- `run_consistency.py` — **GATED, runnable later.** Refuses (exit 2) unless `ANTHROPIC_API_KEY` AND `CADDIE_EVAL_LIVE=1`; never collected by pytest; import-safe. Reuses `run_tier2._build_candidate_messages`/`_cost_usd`/`_PRICING_PER_MTOK_USD` (import; no edits to run_tier2). N candidate calls (default 5×3=15, zero judge calls), `--budget-usd` 0.50 cap with projection/abort (exit 3), per-probe VarianceReport, exit 1 if any inconsistent. Writes `last_consistency_run.json` — **key-free** (answers+substance+counts+$ only). MODIFY `.gitignore` (append the file next to `last_run.json`).
- MODIFY `backend/tests/eval/README.md` — probe + multi-turn + latency sections.

## 4. Deliverable D — reliability consolidation + missing glitch classes (dim 6)

Consolidation = suite membership (§1): existing realtime harnesses join the suite **unmodified**. Missing coverage found: existing Slice D reconnect + hole-change tests fire **between** turns; nothing covers a drop or hole change **while an assistant answer is streaming**.

File to CREATE: `frontend/src/components/CaddieSheet.realtime-glitch.test.tsx` (jsdom) — copies the proven scaffolding of `CaddieSheet.realtime.test.tsx` (framer-motion passthrough, inert classic deps, hoisted `FakeRealtimeCaddieClient`, `vi.mock("@/lib/voice/realtime", ...)`, `warmSession.takeWarm` mock). `realtime.ts` is **mocked out entirely**; keys only off stable public seams (`RealtimeCaddieOptions`, `RealtimeCaddieEvents`, `RealtimeMessage { id, role, text, partial?, order }`, client `start/attachMic/sendText/sendContext/sendOpener/setEvents/stop/emitCurrentStatus`). Fabricated messages use **unique ids** (never assert double-emit semantics — that's the dedup lane's).

Tests (each with RED-proof):
1. **Reconnect mid-answer, success** — partial bubble → `closed` before `response.done` → reconnect client #2 (`connected`). Assert partial text renders exactly once; `sendOpener` never on #2 (no re-greet); `sendContext` once on #2 connect; post-reconnect turn renders after the preserved bubble.
2. **Reconnect mid-answer, FAIL → classic fallback** — #2 start rejects past deadline. Assert classic fallback (mic, no dead "Connecting…"), interrupted partial preserved exactly once, no re-greet.
3. **Hole-change mid-answer** — rerender `holeNumber+1` while partial streams. Assert exactly one new-hole `sendContext` (no double-send), in-flight bubble text unchanged and finalizes on `response.done`.
4. **Hole-change during reconnect window** — drop, change hole, then #2 connects. Assert #2's re-anchor `sendContext` reflects the NEW hole and fires once (no stale-hole re-anchor).

Header documents the manual mutation drill (comment out transcript-preservation merge → tests 1–2 red).

## 5. Deliverable E — latency methodology + gated tool (dim 7)

**Methodology (documented in CADDIE_EXPERIENCE.md; builds on existing seams):**
- Turn latency (question-end→answer-start): already shipped `caddie.eos_to_first_audio` (surfaces `caddie-turn`/`caddie-rt`, immediate flush) from `caddie-turn-timing.ts`. Capture = run real turns on device, read backend telemetry log lines (`POST /api/voice/telemetry`); report p50/p95 per surface.
- Cold vs warm time-to-first-audio: cold = mint+WebRTC connect+greeting; warm = warm-pool adoption (`takeWarm`→`attachMic`)→greeting. Existing markers (`live_resume`, `opening_shot`, `resolved_live`, mint/connect statuses) partially bracket; doc specifies on-box procedure (5 cold + 5 warm opens on TestFlight); if no clean open→greeting bracket, a one-line consumer-side marker (in `useCaddieLiveSession`/`CaddieSheet`, never `realtime.ts`) is FILED. **No baseline this pass** — table ships `TBD — requires keyed on-box run`.
- Backend-controllable: ephemeral mint latency (gated tool below).

File to CREATE: `backend/tests/eval/run_latency.py` — **GATED.** `OPENAI_API_KEY` AND `CADDIE_EVAL_LIVE=1` else exit 2; never collected by pytest; import-safe. Calls production `mint_ephemeral_session`/`build_session_payload` N times (default 5), measures round-trip ms, prints p50/p95 + spend as counts. **Key-free:** redact `client_secret` before any print/JSON; writes `last_latency_run.json` (.gitignore). Filename-glob pin + gate-refusal test (monkeypatch.delenv) in `test_substance_teeth.py` or `test_gated_tools.py`.

## 6. Gates (this pass — deterministic/offline only)
```
cd frontend && npm run test:caddie-experience
cd frontend && npm run test
cd frontend && npm run lint && npx tsc --noEmit
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd backend  && uv run pytest tests/eval
cd backend  && uv run pytest
cd backend  && ruff check .
```
Gated (later, keys required — refusal path itself tested offline):
```
cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_consistency --budget-usd 0.50
cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_latency --n 5
```

## 7. Edge cases & rebase-collision risks (dedup lane)
- `realtime.ts` and `realtime-ordering.ts` are never touched, imported-for-mutation, or asserted-on internally. No existing `realtime-*.test.ts` is modified (suite consumes by filename only).
- New frontend tests mock the client entirely + fabricate unique-id messages; nothing observes emit cadence or same-id re-emission → unaffected by the dedup rework.
- If the dedup lane renames/adds a `realtime-*.test.ts` → manifest guard goes red naming the path; fix is a one-line manifest edit (playbook in CADDIE_EXPERIENCE.md).
- We do NOT add a "same id twice renders once" test (that's the dedup lane's deliverable).
- Backend eval extensions are additive; `run_tier2.py` imported never edited.
- Vacuous-pass guards everywhere (fail-closed on empty messages / omitted voice key / blind extractor / zero-match globs).

## 8. Land now vs file-for-later
LAND NOW: (1) suite + config + manifest guard + package.json + CADDIE_EXPERIENCE.md; (2) multi-turn evals (schema/checks/test_golden_tier1 + 3 scenarios + teeth); (3) voice-config pins + fable→cedar fix; (4) substance extractor + teeth + probes jsonl; (5) glitch tests; (6) gated runner code (run_consistency, run_latency) + gate-refusal/filename tests + .gitignore + README.
FILE FOR LATER: live runs/baselines (keys/device); cold-open→greeting marker (only if log audit shows a gap); realtime-mouth consistency + LLM-judged voice-quality; audible default-voice swap (Classic→cedar) + speed nudge (owner-gated); optional CI YAML job.

## 9. Shared-type sync
No `types.ts` ↔ `models.py` shape touched. Telemetry rides existing free-form strings. Eval schema additions are test-only pydantic. No sync required.
