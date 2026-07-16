# Plan: `caddie-advice-stability-tee-shot` — anchor the CALL to the engine decision

Branch `integration/next`, HEAD `1730fd7`. Fixes the dim-5 consistency defect measured in the 2026-07-15 keyed on-box baseline (`CADDIE_EXPERIENCE.md` lines 136-167): on `followup-3wood-after-driver` asked 5×, grounded facts held (3-wood carry ~235 in 5/5, right bunker named 4/5) but the recommendation direction flipped — 3/5 "lay up with the 3-wood", 2/5 "stick with driver". Filed P2, judgment variance under sampling, not a grounding defect.

## 1. Defect + root cause (confirmed against the code)

- The probe is `followup-3wood-after-driver` (`backend/tests/eval/golden/consistency_probes.jsonl` line 3, n=5), sampling via `_build_candidate_messages` (`backend/tests/eval/run_tier2.py:132-148`) → `build_realtime_instructions(personality, session=build_round_session(scenario))`, then `client.messages.create(..., temperature=0.7)` (`backend/tests/eval/run_consistency.py:83-86`).
- **Confirmed root cause:** `build_round_session` (`backend/tests/eval/checks.py:89-139`) seeds only `conversation_history` — it never populates `session.last_recommendation`. So `_situation_block` (`backend/app/caddie/voice_prompts.py:288`) hits `if session.last_recommendation:` at line 325 with `None` and renders **no engine call, no `TeeShotNumbers`, no `rec.club`** for the current shot. `NUMBERS_COHERENCE_RULE` (`voice_prompts.py:109-124`) is vacuous here — it anchors to "the recommendation's tee-shot numbers block", and no such block is in the prompt. The model free-decides the call at temp 0.7; the decision flips sample to sample.
- **Production fidelity check (confirmed):** in production the follow-up turn's payload DOES carry the engine decision. `recommend_payload` (`backend/app/caddie/tools.py`, the `get_recommendation` tool body, called by both mouths and by `POST /session/recommend` at `routes/caddie.py:596`) runs `generate_recommendation` (`backend/app/caddie/aim_point.py:664`) and persists it via `sessions.set_recommendation` (`tools.py:321-324`, durable at `session.py:249`). The next turn's prompt then renders "Last recommendation: {club}. {format_tee_numbers_line(...)}" in BOTH mouths (`voice_prompts.py:325-339` realtime; `routes/caddie.py:780-795` text). **The eval today under-represents production** — the fix must seed the recommendation so the eval mirrors what production actually sends.
- **Temperature is not a lever here (confirmed):** `build_session_payload` (`backend/app/services/realtime_relay.py:78-140+`) sets no temperature — the GA Realtime session schema has no such param, so the realtime mouth's temp cannot be lowered. The text mouth's temp is `temperature=0.7` at `backend/app/caddie/tool_loop.py:87` (not routes/caddie.py — `_sse_reply` at routes/caddie.py:928 delegates to `run_caddie_turn`). Decisively: the acceptance instrument (`run_consistency.py:84`) hard-codes its own `temperature=0.7`, so a production temp change is **invisible to the probe** — it cannot be the fix.

## 2. Chosen mechanism: PAYLOAD-ANCHOR (option 1), no temperature change

Extend the "the caddie may only say what the engine can prove" doctrine from NUMBERS to the CALL, via a new shared prompt constant `DECISION_GROUNDING_RULE`, plus seeding the engine recommendation into the eval harness so the anchor has something to bite on.

Rationale: the flip is a free re-decision the model makes because the prompt carries no decision to anchor to. In production the decision IS in the payload on follow-up turns (traced above), so (a) the eval must seed it for fidelity, and (b) a rule that says "the engine's club is the call; explain, compare, don't re-decide" grounds the model at ANY temperature and works identically for both mouths — including the realtime mouth, where temperature is unavailable. Temperature (option 2) is rejected: unavailable on the realtime path, invisible to the probe (which samples at its own 0.7 by design), and risks deadening conversation for no measurable gain. Advice must be stable at temp 0.7; only the anchor achieves that.

**Eval-fidelity decision (the highest-stakes call): seed an engine-computed recommendation, do NOT rely on conversation-history anchoring alone.** Anchoring only to the seeded prior turn ("Driver here...") would test a contract production doesn't rely on (production has the structured `Last recommendation:` line with the AUTHORITATIVE numbers block) and would give the model no numbers with which to compare the 3-wood — inviting either fabrication or a refusal. The seed must be computed by the REAL engine (`generate_recommendation`), never hand-authored JSONL, so the `to_green − drive_total = leave` closing invariant holds by construction and the eval can never drift from the engine. For the scenario (470y par 4, driver 250/3wood 235, hcp 14, no weather/stats): 470 ≥ 0.85×470 → tee shot; unreachable (max 250 < 470) → `shot_kind="positioning"`, `tee_shot_numbers` populated; `select_club` picks driver (longest club, no corridor data). Deterministic, pure, offline — safe for CI Tier 1.

## 3. Exact changes

### 3.1 `backend/app/caddie/voice_prompts.py` — the new rule constant
Add after `MISS_SIDE_GROUNDING_RULE` (after line 141), with an incident comment in the house style citing this baseline. Append it in `build_realtime_instructions`'s Behavior block as the LAST rule, after `MISS_SIDE_GROUNDING_RULE` (line 191): `+ "\n" + DECISION_GROUNDING_RULE`.

### 3.2 Exact prompt-contract wording (§4 deliverable)

```python
# Decision-grounding rule (consistency baseline 2026-07-15, probe
# followup-3wood-after-driver: 5 identical asks, 3/5 answers endorsed laying
# up with the 3-wood, 2/5 said stick with driver — same input, opposite
# advice). The grounding doctrine extends from NUMBERS to the CALL: the
# engine decides the club; the caddie explains it. Shared by BOTH mouths
# (build_realtime_instructions below and the two stable_text blocks in
# routes/caddie.py) so wording never drifts.
DECISION_GROUNDING_RULE = (
    "The club call is the engine's decision, not a fresh judgment each turn. "
    "When the context carries a recommendation ('Last recommendation'), that "
    "club IS the call for this shot: explain it, don't re-decide it. If the "
    "player floats a different club ('what about my 3-wood?'), compare it "
    "honestly against the call using only numbers you have — what it carries, "
    "what it leaves, what it takes out of play — then keep the recommended "
    "club as the call unless those numbers genuinely favor the alternative or "
    "the player gives NEW information the engine didn't have (a lie, a gust, "
    "something they can see, 'driver's not working today'). A preference "
    "alone is not new information — never flip the call just to agree, and "
    "the same question on the same facts always gets the same call. If the "
    "context carries no recommendation, fetch one with a tool before making a "
    "club call; when no tool data exists, advise from the CURRENT SITUATION "
    "and stay consistent with what you already told them this hole."
)
```

Calm-caddie note (NORTHSTAR): the rule governs WHICH club is the call, never the phrasing — the model still speaks like a caddie ("I'd stay with the driver — your 3-wood leaves 235 in"), not a determinism robot.

### 3.3 `backend/app/routes/caddie.py` — both text mouths
- Import `DECISION_GROUNDING_RULE` in the `from app.caddie.voice_prompts import (...)` block (lines 35-45).
- Interpolate `{DECISION_GROUNDING_RULE}` as a new line after `{MISS_SIDE_GROUNDING_RULE}` in BOTH `stable_text` blocks: line 844 (`_build_session_voice_prompt`) and line 1522 (`_build_voice_prompt`). Exactly 2 interpolations (the pin test counts them).

### 3.4 Eval harness — seed the engine recommendation
- `backend/tests/eval/schema.py`: add `seed_recommendation: bool = False` to `Situation` (line 164, `extra="forbid"` so the field must exist); add `"DECISION_GROUNDING_RULE"` to `_VALID_RULE_NAMES` (line 97).
- `backend/tests/eval/checks.py::build_round_session` (line 89): when `scenario.situation.seed_recommendation` is true, after building `intel`/`weather`, compute `rec = generate_recommendation(hole=intel, distance_yards=hole.yards, club_distances=dict(...club_distances), handicap=situation.player.handicap or 15.0, weather=weather)` and pass `last_recommendation=rec` to the `RoundSession`. Fail loudly (`ValueError`) if `seed_recommendation` is true but `hole.yards` is None (fail-closed, house convention). Import `generate_recommendation` from `app.caddie.aim_point`. Also add `"DECISION_GROUNDING_RULE": DECISION_GROUNDING_RULE` to `_RULE_TEXT` (line 197) and the import at line 41.
- `backend/tests/eval/golden/caddie_advice.jsonl` line 42 (`followup-3wood-after-driver`): add `"seed_recommendation": true` to `situation`; add to `tier1`: `{"check": "prompt_contains_rule", "rule": "DECISION_GROUNDING_RULE", "mouths": ["text", "realtime"]}` and `{"check": "prompt_contains_literal", "literal": "Last recommendation: driver", "mouths": ["text", "realtime"]}` (this literal is the CI pin that the engine's seeded call is driver and reaches BOTH mouths' prompts); add to `tier2_deterministic`: `{"check": "must_mention_any", "phrases": ["driver"]}` (an honest comparison must name the call). Keep the existing 3-wood `must_mention_any` and `uses_conversation_context` judge property unchanged.

### 3.5 Falsifiable direction measurement — `backend/tests/eval/substance.py`
The extractor does not capture recommendation direction (confirmed: `AnswerSubstance.club` is the FIRST-mentioned club — in these answers usually "3-wood" regardless of the advice direction, and the 3/2 flip surfaced only by eyeballing). Acceptance must be deterministic:
- Add `endorsed_club: Optional[str]` to `AnswerSubstance`, extracted by a closed endorsement-cue lexicon scanned per sentence: cues = `stick with, stay with, go with, take the, hit the, pull the, is the call, is the play, that's the call, that's the play, i'd take, i'd hit, safe play, smart play, your best bet`. In a cue-bearing sentence, the endorsed club is the club mention (reusing `_CLUB_MENTION_PATTERNS`) **nearest by character distance to the cue match** — this resolves both "stick with driver over the 3-wood" → driver and "the 3-wood is the call" → 3wood. First cue-bearing sentence wins; no cue → `None`.
- `substance_variance`: add `distinct_endorsements` (with `None` as its own distinct value only when at least one sample has a non-None endorsement — all-None stays consistent, preserving the two vacuous probes' current True verdicts) and fold `distinct_endorsements <= 1` into `consistent`. Report `endorsed_club` per sample in `run_consistency.py`'s JSON output (`substances` list) and `distinct_endorsements` in the `variance` dict.
- Hardening required for a non-artifact 5/5 read: extend `checks._build_club_mention_patterns` (checks.py:470) with spelled-number aliases ("three wood", "three-wood", etc. via a digit→word map for N-wood/N-iron) — the baseline's sample 0 spelled "Three-wood" and read as `club=None`; without this the AFTER run can go red on spelling, not substance (this also lands half of filed `caddie-consistency-probe-substance-coverage`).

### 3.6 Prompt-contract pin tests — new `backend/tests/test_decision_grounding_prompt.py`
Mirror `test_numbers_coherence_prompt.py` (DATABASE_URL stub before import):
1. `DECISION_GROUNDING_RULE.strip() != ""` and carries the contract phrases: `"explain it, don't re-decide it"`, `"never flip the call just to agree"`, `"new information"`, `"same question on the same facts"`.
2. Present in `build_realtime_instructions(personality)` output, ordered after `MISS_SIDE_GROUNDING_RULE` within the `# Behavior` block.
3. `caddie_routes.DECISION_GROUNDING_RULE is DECISION_GROUNDING_RULE` and `inspect.getsource(caddie_routes).count("{DECISION_GROUNDING_RULE}") == 2` (both mirrored stable_text blocks).
4. Engine-decision-is-echoed contract: load the golden set, `build_round_session(followup-3wood-after-driver)` → `session.last_recommendation.club == "driver"`, `tee_shot_numbers is not None`, and `_situation_block(session)` contains `"Last recommendation: driver"` and `format_tee_numbers_line(session.last_recommendation.tee_shot_numbers)`.

### 3.7 Extractor teeth — extend `backend/tests/eval/test_substance_teeth.py`
Fixtures shaped on the real baseline answers: three lay-up endorsements ("the 3-wood is the call", "safe play with the 3 wood", "lay up with the three-wood") and two driver ("I'd stick with driver here", "Stick with driver and favor left"). Assert: extractor classifies each correctly; `substance_variance` over the 3/2 split is `consistent=False` with `distinct_endorsements == 2` (this makes the BEFORE state a red the suite can reproduce); 5/5 driver is green; all-None endorsements stay consistent (vacuous probes unaffected).

### 3.8 Untouched (confirmed)
- `frontend/src/lib/types.ts` ↔ `backend/app/models.py`: no API shape changes (no `last_recommendation`/`TeeShotNumbers` in frontend types today; the rule and harness are backend-internal). No sync needed.
- `frontend/src/lib/voice/caddie-experience-suite.ts`: no required change (manifest guard only requires listed files to exist; `test_substance_teeth.py` is already listed under dim 5). Optional one-line nicety: add `backend/tests/test_decision_grounding_prompt.py` under dims [2, 5].
- `tool_loop.py:87` temperature stays 0.7. No VAD/mic/realtime-session changes.

## 5. Edge cases & risks
- **Rigidity / refusing comparison:** the rule explicitly mandates an honest comparison of the floated club and names the two legitimate flip conditions (numbers favor the alternative; new player information). Regression-gated by `must_mention_any` 3-wood + `uses_conversation_context`.
- **`context-retention-prior-club-result`** (player's 7-iron came up short; asks "same club?"): no seeded rec (default `seed_recommendation: false`) so the anchor clause is conditioned on a `Last recommendation` being present and doesn't bite; the short result is also "new information the engine didn't have". Judge property (adjusts for the miss) unaffected.
- **`challenge-and-admit-yardage` / OBSERVED_REALITY / YARDAGE_GROUNDING:** the rule governs the club decision only, never numbers or observed reality; the admit-and-correct paths in `NUMBERS_COHERENCE_RULE` and `OBSERVED_REALITY_RULE` are untouched, and "something they can see" is enumerated as legitimate new information.
- **Engine's own call is the lay-up** (corridor-capped driver→3wood): the rule anchors to "the recommended club", never to driver — it supports a legitimate engine lay-up; the corridor clause in `format_tee_numbers_line` (voice_prompts.py:264-274) supplies the comparison material.
- **POSITIONING/NUMBERS/MISS_SIDE interaction:** appended last, it completes the sequence numbers → miss side → decision; no wording overlap or contradiction (verified against all three texts).
- **Seeding changes the probe's input tokens:** acceptable and intended — the BEFORE payload was the low-fidelity one; the AFTER payload is what production sends. State this in the run notes.

## 6. Gates + before/after measurement (acceptance)
Offline/deterministic gates (all must pass; DB-backed backend tests run in CI, not locally):
1. `cd backend && uv run pytest tests/eval tests/test_decision_grounding_prompt.py tests/test_numbers_coherence_prompt.py tests/test_realtime_grounding.py tests/test_positioning_prompt.py`
2. `cd backend && ruff check .`
3. `cd frontend && npm run test:caddie-experience`

Live before/after (keyed, on-box, owner-run — never CI):
- BEFORE is already captured (2026-07-15 baseline: 3/5 lay-up vs 2/5 driver; `CADDIE_EXPERIENCE.md:145-167`).
- AFTER: `cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_consistency --budget-usd 0.50` (same probe id, n=5, temp 0.7, same model).
- **Acceptance bar (falsifiable, not eyeballed):** `followup-3wood-after-driver` reports `consistent=True` with `distinct_endorsements == 1` and `endorsed_club == "driver"` on 5/5 samples (the engine's seeded call), while facts stay grounded (hazard set stable, 3-wood carry within tolerance). Also re-run `run_tier2.py` on the three multi-turn goldens (`followup-3wood-after-driver`, `context-retention-prior-club-result`, `challenge-and-admit-yardage`) — all tier2_deterministic checks and the `uses_conversation_context` / `defers_to_observed_reality` judge properties must still pass (anchor does not make the caddie rigid). Update `CADDIE_EXPERIENCE.md`'s dim-5 section with the AFTER numbers, per the harness rule that fixes go through the eval loop.

### Critical Files for Implementation
- /Users/justinlee/projects/scorecard/backend/app/caddie/voice_prompts.py
- /Users/justinlee/projects/scorecard/backend/app/routes/caddie.py
- /Users/justinlee/projects/scorecard/backend/tests/eval/checks.py
- /Users/justinlee/projects/scorecard/backend/tests/eval/substance.py
- /Users/justinlee/projects/scorecard/backend/tests/eval/golden/caddie_advice.jsonl (plus schema.py for the two closed-registry additions)
