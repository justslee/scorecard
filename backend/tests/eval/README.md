# Caddie advice-quality eval harness

Answers the gap the caddie-excellence-audit called out (area G, grade **D**, "unfalsifiable
quality"): nothing measured whether caddie ADVICE was good, so every caddie change was vibes.
This harness is a **golden set** of representative caddie situations — hole + player + question —
with **expected PROPERTIES** (never exact text), split into two tiers.

> "An eval that can't fail is worse than none." Every check here has a proof it can go RED —
> see `test_harness_has_teeth.py`, the harness's own #1 deliverable.

## Two tiers

- **Tier 1** (`test_golden_tier1.py`) — runs ALWAYS, in the normal `cd backend && uv run pytest`
  CI gate. Offline: no LLM call, no network, no API key, no Postgres, no docker. Asserts
  properties of the *assembled prompt/context* (both mouths: the Claude text session and the
  OpenAI Realtime instructions) and of the deterministic validators (`validate_guide`,
  `format_hazards_line`, `build_ground_truth_block`) — it proves the machinery that GROUNDS the
  model is intact, without ever calling a model.
- **Tier 2** (`run_tier2.py`) — on-demand / nightly ONLY, never in CI, never per-PR. Calls the
  real candidate model with the real prompt, runs deterministic post-checks on the answer
  (sentence count, markdown, club selection, forbidden/required phrases), then an LLM judge
  (a **different model** than the candidate) grades a handful of soft properties
  (`grounded_in_hole`, `respects_plays_like`, `defers_to_observed_reality`,
  `appropriately_concise_and_calm`, `asks_to_repeat_on_unintelligible`) as binary pass/fail
  with a reason.

## Running it

```bash
# Tier 1 — every PR, every local run, no setup needed
cd backend && uv run pytest tests/eval

# Tier 2 — on-demand, costs real money (~$0.40 for the full golden set)
cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_tier2 --budget-usd 2.00
# cheaper smoke run:
cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_tier2 --max-scenarios 8 --budget-usd 0.50
```

Tier 2 is **gated OFF by default** — it refuses to run unless BOTH `ANTHROPIC_API_KEY` and
`CADDIE_EVAL_LIVE=1` are set, and it is never invoked by `.github/workflows/ci.yml`. The
filename `run_tier2.py` does not match pytest's `test_*.py` glob, so pytest never collects it
either way — three independent guards (see the module docstring).

A `--budget-usd` cap (default $2.00) is enforced in code: before each scenario the runner
projects (running cost + a per-scenario cost estimate); if that would exceed the cap it stops,
writes partial results to `last_run.json` (gitignored), and exits 3. Exit codes: `0` = pass rate
met, `1` = pass rate missed, `2` = gate/config refusal, `3` = budget-cap abort.

## File layout

```
schema.py     — pydantic Scenario/Situation/Expected + the CLOSED check-name registry
checks.py     — TIER1_CHECKS / TIER2_DETERMINISTIC implementations (pure, no I/O)
golden/caddie_advice.jsonl — the golden set (one JSON object per line)
test_golden_tier1.py       — parametrized pytest loader, runs every tier1 check
test_harness_has_teeth.py  — mutant tests proving each check family can go RED
run_tier2.py                — on-demand live runner (NOT collected by pytest)

test_realtime_session_config.py — dim-4 voice-config pins (voice validity, speed 1.15)
substance.py                — pure club/yardage/hazard extractor for the consistency probe
test_substance_teeth.py     — extractor + variance-diff teeth (RED-proofs)
golden/consistency_probes.jsonl — which golden scenarios the consistency probe re-samples
run_consistency.py          — on-demand LIVE consistency probe (NOT collected by pytest)
run_latency.py               — on-demand LIVE ephemeral-mint latency probe (NOT collected by pytest)
test_gated_tools.py          — filename-glob pins + gate-refusal tests for both LIVE runners above

conversation_runner.py      — multi-turn sequence executor: stub/spy installers + pure sequence checks
conversations.py            — ~10 python-defined conversation scenario scripts + shared session fixtures
test_conversation_router.py — parametrized pytest module, runs every scenario through the runner
test_conversation_teeth.py  — M1-M7 mutant tests proving each conversation-level check can go RED
```

## Multi-turn context-retention (dims 2/3, added by the caddie-experience harness)

`Situation.history: list[HistoryTurn]` seeds prior conversation turns into the synthetic
`RoundSession.conversation_history` (`checks.build_round_session`) so the REAL
`_build_session_voice_prompt` (`routes/caddie.py`) renders them into `messages` exactly as a
real multi-turn round would. The `history_renders_in_order` tier1 check
(`checks.check_history_renders_in_order`) asserts every seeded turn appears in the assembled
`messages` list, in order, with exact role+content, strictly before the current transcript
(which must be last) — offline, no LLM call. **Text-mouth only**: the realtime mouth's
conversation history lives server-side in the OpenAI Realtime session itself, not assertable
from a pure prompt-string check — that surface is covered by the frontend ordering/lifecycle
suites (`realtime-ordering.test.ts`, `CaddieSheet.realtime.test.tsx`) and, for a live read, the
gated consistency probe below.

## Multi-turn conversation & router (dims 1/3/5 + routing)

The single-turn checks above assemble one prompt/answer in isolation — they can't catch what
only shows up ACROSS a sequence: duplicate replies to distinct asks (dim 1), a follow-up that
re-derives instead of reusing the same hole/payload (dim 3), advice→fact→advice contradicting
itself mid-round (dim 5), or a mid-conversation intent switch (advice → score → fact → advice)
cross-contaminating tiers. `conversation_runner.py` + `conversations.py` +
`test_conversation_router.py` answer this — always-on, in the same `uv run pytest tests/eval`
gate, fully offline.

**Fidelity bar**: every scenario drives the REAL `POST /api/caddie/session/voice` route
(`routes/caddie.py::session_voice`) through a throwaway `FastAPI()` + `TestClient`, exactly like
`test_strategy_tool.py::_strategy_client` — `classify_intent`, the ADVICE/SCORE/FACT-OTHER
dispatch arms, `run_strategy_turn` (payload assembly, cache, the fail-closed validator, the
degrade composer), and `_build_session_voice_prompt` are all REAL code. Only the network/DB
seams the existing suite already stubs are replaced (`synthesize_strategy`, `run_caddie_turn`,
`sessions.append_message_pair`/`set_current_hole`/`set_recommendation`, `get_owned_session`,
personality/memory reads). `classify_intent`, `run_strategy_turn`, and
`caddie_tools.resolve_tool` are SPIED (delegating wrappers), never replaced — every assertion
reads an effect produced by REAL code, never a stub call-count alone.

**Scenario format: python-defined, not JSONL.** Per-turn expectations here are code-shaped
(expected `Intent` enum members, synth-call deltas, per-call stub behavior: return vs. raise) —
none of which serialize honestly to JSONL. `ConversationTurn`/`TurnExpect` are frozen
dataclasses, so a typo'd expectation field is an import-time error — the same closed-registry
safety the golden JSONL gets from pydantic's `extra='forbid'`, by a different mechanism. The
JSONL stays the home of single-turn golden scenarios; conversations are scripts, and scripts
live in code (`conversations.py`).

`run_conversation(scenario, monkeypatch)` posts every turn in order against a SHARED
`RoundSession` (never a fresh one per turn — the fake `get_owned_session` always returns the
same object, modeling DB persistence) and returns a `ConversationResult` carrying, per turn: the
classified `Intent`, the reply text, the synth/fact-stub call deltas, and (for ADVICE turns) the
hole `run_strategy_turn` actually computed against. Pure sequence-check functions
(`check_turn_expectations`, `check_no_dupes`, `check_club_consistency`,
`check_history_renders_in_order`) then verify the properties — pure means `test_conversation_
teeth.py` can feed them hand-built mutant records directly, no route/monkeypatch machinery
needed for that half of the teeth.

## Consistency probe (dim 5) — pure extractor now, gated live sampler later

`substance.py` extracts an `AnswerSubstance` (club / yardages / hazard types — phrasing
stripped away) from a caddie answer, reusing the SAME club-mention regex family
`checks._parse_mentioned_club` already uses (one extraction path, not two that could drift).
`substance_variance` diffs N samples of the SAME scenario: clubs must be identical, hazard sets
identical, yardage spread within tolerance; a sample simply omitting a number others state is
*reported*, not failed (phrasing variance is expected — magnitude disagreement is the failure).

`golden/consistency_probes.jsonl` names which existing golden scenario ids to re-sample, how
many times (`n`), and the yardage tolerance. `run_consistency.py` is the gated live sampler —
same three independent CI guards as `run_tier2.py` (filename doesn't match `test_*.py`,
refuses without `ANTHROPIC_API_KEY` + `CADDIE_EVAL_LIVE=1`, no CI workflow step invokes it).
Zero judge calls (pure post-processing on live answers), so cost is candidate-call cost only:

```bash
cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_consistency --budget-usd 0.50
```

Writes `last_consistency_run.json` (gitignored, key-free — answers + substance + counts + $
only). Exit codes: `0` = every probe consistent, `1` = at least one probe inconsistent, `2` =
gate refusal, `3` = budget-cap abort.

## Latency (dim 7) — methodology + gated tool

Turn latency (question-end → answer-start) is already measured in production by
`caddie.eos_to_first_audio` (surfaces `caddie-turn`/`caddie-rt` telemetry events, immediate
flush — `frontend/src/lib/voice/caddie-turn-timing.ts`); read backend telemetry log lines
(`POST /api/voice/telemetry`) for p50/p95 per surface. Cold-vs-warm time-to-first-audio needs
an on-box TestFlight run (5 cold + 5 warm opens) bracketed by the existing `live_resume` /
`opening_shot` / `resolved_live` markers — see the root `CADDIE_EXPERIENCE.md` for the full
methodology and the (currently empty, honest) baseline table.

The ONE leg of cold-open latency this backend fully controls is the ephemeral-mint round-trip
(`mint_ephemeral_session`, POST to OpenAI's Realtime `client_secrets` endpoint) —
`run_latency.py` measures it directly, gated the same way as the other live tools:

```bash
cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_latency --n 5
```

Requires `OPENAI_API_KEY` + `CADDIE_EVAL_LIVE=1`. The response's ephemeral `client_secret` is
redacted before any print or JSON write — this tool reports latency numbers, never a usable
session credential. Writes `last_latency_run.json` (gitignored, key-free).

## Adding a scenario

Append one line to `golden/caddie_advice.jsonl` (see the existing lines for the shape). Rules:

- `id` is unique, kebab-case. `source` is `incident-<date>-<slug>` / `synthetic` / `audit`.
- Hazards are either a real GeoJSON `features` FeatureCollection (exercises the actual
  `extract_hole_hazards` polyline/chord/dogleg geometry) or a pre-built `hazards` list
  (`{"type", "line_side", "carry_yards"}`) when the geometry pipeline isn't the point.
- **Every new caddie incident MUST land as a scenario in the same PR as its fix** (this is how
  the golden set stays incident-driven instead of drifting toward vibes).
- Check names come from a CLOSED registry (`schema.py`'s `Tier1CheckName` /
  `Tier2DeterministicCheckName` / `Tier2JudgeProperty` enums) — a typo'd or unknown check name is
  a load-time `ValidationError`, not a silent no-op.
- Assertions about the RULES reference the imported constants (`HAZARD_GROUNDING_RULE`,
  `OBSERVED_REALITY_RULE`, `INPUT_GROUNDING_RULE`), never copied prompt strings, EXCEPT the handful of verbatim
  product-contract literals (`"2-3 short sentences"`, `"never use markdown"`,
  `"the COMPLETE list — there are NO others"`, `"NONE mapped"`) — these are checked with
  `prompt_contains_literal` / `ground_truth_block_complete` on purpose. This means: **when you
  edit a rule constant's wording, Tier 1 keeps passing automatically; when you DELETE a rule
  (or a literal), it goes red** — that's the point.

## The manual mutation drill (do this once per reviewer, ~5 minutes)

`test_harness_has_teeth.py` proves the checks can fail using INTERNAL mutants (stripped
strings, stubbed functions) — it never edits the real source. To prove the harness would also
catch a REAL regression in `routes/caddie.py`, do this once:

1. Open `backend/app/routes/caddie.py`, find `_build_session_voice_prompt`'s `stable_text`
   f-string (~line 792), and comment out (or delete) the `{OBSERVED_REALITY_RULE}` line.
2. `cd backend && uv run pytest tests/eval -x` — watch it go RED
   (`test_scenario_tier1_checks_pass[hole4-observed-reality-gaslight]` fails: `prompt_contains_rule:
   OBSERVED_REALITY_RULE missing from mouth(s): ['text']`).
3. Revert the change (`git checkout -- backend/app/routes/caddie.py`), confirm green again.
4. Paste the red output from step 2 into the PR description — this is the harness's proof of
   life, required alongside every change that touches this directory.

5. **Conversation-level step** (added by the multi-turn conversation & router eval): in
   `session_voice`'s `if intent is Intent.ADVICE:` arm (the FIRST occurrence, ~line 1006 — the
   non-streaming twin `test_conversation_router.py` drives), comment out the real
   `run_strategy_turn(...)` call.
6. `cd backend && uv run pytest "tests/eval/test_conversation_router.py::test_conversation[intent-switch-chain]" -q`
   — watch it go RED (the ADVICE arm never calls `run_strategy_turn`, so the spy records zero
   calls and the runner's own bookkeeping raises `IndexError: list index out of range` trying to
   read the never-recorded call — a real regression here is caught, just via a different failure
   shape than a clean `CheckResult`, which is still a legitimate red).
7. Revert, confirm green again, paste the red output into the PR alongside step 4's.

## Budget & judge design (Tier 2)

- **Judge ≠ candidate, enforced.** Default judge `claude-haiku-4-5` ($1/$5 per MTok), candidate
  defaults to the runtime caddie's model (`ANTHROPIC_MODEL`, default
  `claude-sonnet-4-5-20250929`, $3/$15 per MTok). The runner refuses to run if
  `--judge-model == --candidate-model`.
- **Binary per-property verdicts**, not a 1-10 score — far less noisy, via structured output
  (`client.messages.parse(..., output_format=JudgeVerdicts)`) at `temperature=0`.
- **Verbosity is never judged by the LLM.** Length/format quality (sentence count, markdown) is
  a deterministic check — a long, charming answer can't talk its way past the judge. The judge
  prompt states this explicitly.
- **The candidate answer is DATA, never instructions.** The judge prompt wraps it in
  `<candidate_answer>...</candidate_answer>` with the same untrusted-data framing
  `guide_writer.WRITER_SYSTEM` already ships, plus a deterministic pre-scan
  (`_looks_like_injection`) that fails `grounded_in_hole` outright on instruction-shaped text
  without ever asking the judge.
- **Pricing table refuses unknown models** rather than silently costing $0 — add a new model to
  `_PRICING_PER_MTOK_USD` in `run_tier2.py` before using it here.
- **No order randomization needed in v1** — every property is judged against a fixed rubric for
  ONE answer, never a pairwise A/B comparison. If a compare-two-candidates mode is ever added,
  candidate position MUST be randomized per pair (SOTA de-biasing practice).
- **Spot-audit the judge periodically.** Read 5 judge `reason` strings per run from
  `last_run.json` — a lenient/hand-wavy judge is a real failure mode this harness cannot fully
  self-detect.

## Known limitations (honest, not aspirational)

- `club_within_one` is a deliberately generous ±10y tolerance around the target yardage, not a
  strict "adjacent club in the bag" computation — see `checks.py::club_within_one`.
- Tier 2's candidate call only exercises the Realtime-mouth builder
  (`build_realtime_instructions`), not the text-mouth's `_build_session_voice_prompt` (which
  needs a DB-backed session) — a documented, deferred follow-up is extracting
  `_build_session_voice_prompt`'s pure body into `app/caddie/prompt_compose.py` so BOTH mouths
  are drivable offline (plan §6 step 3's "optional follow-up", not required for this item).
- The golden set currently mixes synthetic and real-incident scenarios; keep the ratio honest —
  don't pad the count with near-duplicates just to hit a target number.
