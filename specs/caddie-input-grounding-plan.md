# Caddie Input-Grounding Plan (`INPUT_GROUNDING_RULE`)

**Spec path:** `/Users/justinlee/projects/scorecard/specs/caddie-input-grounding-plan.md`
**Grounding:** `/Users/justinlee/projects/scorecard/specs/voice-transcription-reliability-research.md` (owner incident 2026-07-09: caddie answered ASR-invented words "Scars.", "of God"). This is avenue #1 of that research — the prompt-level "never answer gibberish" rule. The cascaded-STT confidence gate (avenue #3) is a **separate, queued spike — explicitly NOT this cycle**.

## 0. Problem, one line

The caddie's FACTS are grounded (`HAZARD_/BEND_/PHYSICS_/GREEN_GROUNDING_RULE`, `OBSERVED_REALITY_RULE`) but its EARS are not: it confidently answers questions the transcription invented. This cycle extends the grounding doctrine from facts to INPUT: **don't answer what you didn't clearly hear.**

## 1. Verified map of every caddie "mouth" (where grounding rules are composed)

| Site | File / function | Status |
|---|---|---|
| Realtime (speech-to-speech) mouth | `backend/app/caddie/voice_prompts.py::build_realtime_instructions`, Behavior block lines 90–96, appends HAZARD → BEND → PHYSICS → GREEN → OBSERVED_REALITY | verified; sole production caller is `app/routes/realtime.py:140` |
| Text mouth #1 (session) | `backend/app/routes/caddie.py::_build_session_voice_prompt`, `stable_text` f-string lines 780–802 | verified — rules at lines 797–802 |
| Text mouth #2 (stateless) | `backend/app/routes/caddie.py::_build_voice_prompt`, `stable_text` f-string lines 1393–1413 | verified — rules at lines 1408–1413 |

**Exactly two `stable_text` sites** — confirmed by grep and pinned by an existing test (`tests/test_epistemic_humility_prompt.py:79` asserts `source.count("{OBSERVED_REALITY_RULE}") == 2`).

**Not a mouth (excluded, with reason):** `backend/app/caddie/guide_writer.py` embeds `HAZARD_GROUNDING_RULE` at line 168 inside `WRITER_SYSTEM` — that is the offline per-hole GUIDE writer generating course-strategy text from researched data. It never receives a live player utterance, so an "ask them to repeat" rule is meaningless there. **Do NOT add `INPUT_GROUNDING_RULE` to guide_writer.py.**

Also not mouths: `keyterms.py` builds the transcription *hint* prompt (a keyword list for gpt-4o-transcribe, not instructions) — orthogonal; see §5.

## 2. The rule: one constant, defined once

**File:** `backend/app/caddie/voice_prompts.py`, immediately after `OBSERVED_REALITY_RULE` (line ~50), with an incident-dated comment in the house style (see `OBSERVED_REALITY_RULE`'s comment at lines 37–41).

Draft (builder owns final wording; the **intent below is contractual**):

```python
# Input-grounding rule (Scars-transcript incident, 2026-07-09): on-course ASR
# invents words ("Scars.", "of God") and the caddie gamely answered them. The
# grounding doctrine extends from FACTS to INPUT: never answer what you didn't
# clearly hear. Shared by BOTH mouths — build_realtime_instructions below and
# the two stable_text blocks in routes/caddie.py — so wording never drifts.
# Realtime caveat: the speech-to-speech model hears raw AUDIO; this rule is a
# strong nudge, not a hard gate (the hard gate is the queued cascaded-STT spike).
INPUT_GROUNDING_RULE = (
    "Your ears follow the same rule as your facts: never answer a question you "
    "did not clearly hear. On-course audio garbles — if the player's words come "
    "through as gibberish, an off-topic non-sequitur, or a fragment with no "
    "plausible golf meaning, do NOT invent a golf answer for it. Ask them to "
    "repeat, briefly and once (\"Didn't catch that — say again?\"), then move on. "
    "This applies ONLY to unintelligible or clearly non-golf noise. Terse golf "
    "questions are normal out here — \"driver?\", \"what club\", \"how far\", "
    "\"read?\", \"wind?\" are real, clear questions: answer them directly and "
    "never ask the player to repeat something you understood."
)
```

Contractual intent, both directions (this is a **review criterion** — the reviewer will test it adversarially both ways):
1. **Refuse-and-repeat** on unintelligible / gibberish / non-golf fragments — never a confident golf answer to noise. Ask **once**, briefly (NORTHSTAR calm: one "say again?" IS the calm behavior; never chatty, never repeated hedging, never a lecture about audio quality).
2. **Must NOT over-refuse**: terse-but-clear golf input ("driver?", "what club", "how far", "read?", "wind?") gets a normal answer. The rule text must explicitly carve this out, as above.

## 3. The three injection sites (exact placement)

Insert `INPUT_GROUNDING_RULE` **immediately BEFORE `OBSERVED_REALITY_RULE`** at all three sites. This ordering is deliberate: two existing tests (`tests/test_voice_stream.py:582` and `:602`) pin that the text mouths' stable block `endswith(OBSERVED_REALITY_RULE)` — inserting before it keeps those pins untouched and keeps the mouths' rule order identical.

1. **`voice_prompts.py::build_realtime_instructions`** (lines 90–96): the Behavior block becomes `... + GREEN_GROUNDING_RULE + "\n" + INPUT_GROUNDING_RULE + "\n" + OBSERVED_REALITY_RULE`.
2. **`routes/caddie.py::_build_session_voice_prompt`** `stable_text` (line ~801): between `{TOOL_USE_RULE}` and `{OBSERVED_REALITY_RULE}` add a `{INPUT_GROUNDING_RULE}` line. Add `INPUT_GROUNDING_RULE` to the import at `routes/caddie.py:34` (`from app.caddie.voice_prompts import OBSERVED_REALITY_RULE, TOOL_USE_RULE`).
3. **`routes/caddie.py::_build_voice_prompt`** `stable_text` (line ~1412): same insertion between `{TOOL_USE_RULE}` and `{OBSERVED_REALITY_RULE}`.

Result: `source.count("{INPUT_GROUNDING_RULE}") == 2` in `routes/caddie.py` (pinned by a new test, §6).

## 4. Realtime honesty caveat (state plainly, everywhere)

The realtime path is speech-to-speech: the model responds to **raw audio**; the displayed transcript is a side-channel (`gpt-4o-transcribe`). A prompt rule therefore **strongly nudges** the model to say "say again?" when the audio itself is garbled, and meaningfully reduces "confidently answering noise" — but it **cannot eliminate it**. The hard gate (ASR confidence scoring / cascaded Deepgram STT) is a separate queued spike. **Do not** attempt confidence scoring, transcript gating, or any STT rebuild this cycle. This caveat goes in: the constant's code comment, the PR description, and this spec.

## 5. Plausibility-signal recommendation: **DEFER — ship a pure prompt rule**

Considered: injecting a situation-line ("note: the last transcript looks like a short non-golf fragment") when the transcript fails a cheap heuristic. **Recommendation: defer.** Reasons, verified against the code:
- The realtime mouth's instructions are minted per-session (`routes/realtime.py:140`); a per-turn signal would need mid-session `session.update` plumbing through `services/realtime_relay.py` — not trivial.
- It would embed user-derived text (or a judgment about it) into the prompt; the existing transcription-prompt design (`keyterms.py` docstring) deliberately composes prompts **only from closed-set constants** for injection safety. A "is this golf-plausible" vocabulary heuristic is a false-positive machine against exactly the terse inputs §2 protects.
- Any real signal is ASR confidence — which belongs to the queued cascaded-STT spike.

Interaction note: the cycle-50 realtime transcription vocab-bias work (`app/caddie/keyterms.py`, `specs/caddie-realtime-transcription-vocab-bias-plan.md`) operates on the transcription **hint** prompt; this rule is INSTRUCTIONS-level. Orthogonal; no conflict, no shared code paths touched.

## 6. Eval TEETH (mandatory, falsifiable both ways)

Harness: `backend/tests/eval/` (read `README.md` for conventions — "every new caddie incident MUST land as a scenario in the same PR as its fix").

### 6a. Wire the rule into the resolver (verified mechanics)

`check_prompt_contains_rule` (`tests/eval/checks.py:186`) resolves the rule **by name** via the module-level dict `_RULE_TEXT` (`checks.py:173–179`), then asserts the constant's text is a substring of each requested mouth's assembled prompt via `_mouth_text` (`text` → `ctx.text_prompt`, `realtime` → `ctx.realtime_prompt`; prompts are built by `test_golden_tier1.py::_build_prompts` using the **real** monkeypatched `_build_session_voice_prompt` + pure `build_realtime_instructions`). It fail-closes if the constant is empty/whitespace. Rule names are also validated at golden-set **load time** against `_VALID_RULE_NAMES` (`tests/eval/schema.py:87–90`). Therefore:

1. `checks.py`: add `INPUT_GROUNDING_RULE` to the import at line 41 (`from app.caddie.voice_prompts import INPUT_GROUNDING_RULE, OBSERVED_REALITY_RULE`) and add `"INPUT_GROUNDING_RULE": INPUT_GROUNDING_RULE` to `_RULE_TEXT`.
2. `schema.py`: add `"INPUT_GROUNDING_RULE"` to `_VALID_RULE_NAMES` (line 87). *(Both are required — miss either and the scenario fails at load or the check KeyErrors.)*
3. `schema.py`: add the new judge property to the closed enum `Tier2JudgeProperty` (line 53): `ASKS_TO_REPEAT_ON_UNINTELLIGIBLE = "asks_to_repeat_on_unintelligible"`. **That enum IS the registry** — `run_tier2.py` consumes properties generically via `p.property.value` + `description` in `_judge_prompt` (line 107); no other registration exists or is needed. Also add the property to the README's judge-property list (line ~24).

### 6b. Golden scenarios — append two lines to `tests/eval/golden/caddie_advice.jsonl`

**Negative (the incident):**
```json
{"id": "gibberish-transcript-asks-to-repeat", "source": "incident-2026-07-09-scars-transcript", "notes": "owner saw the caddie confidently answer ASR-invented words ('Scars.', 'of God'). INPUT_GROUNDING_RULE extends grounding from facts to input: never answer what you didn't clearly hear — ask to repeat, once, calmly.", "situation": {"hole": {"number": 6, "par": 4, "yards": 410, "hazards": []}, "player": {"handicap": 14.0, "club_distances": {"driver": 250, "7iron": 160}}, "question": "Scars."}, "expected": {"tier1": [{"check": "prompt_contains_rule", "rule": "INPUT_GROUNDING_RULE", "mouths": ["text", "realtime"]}], "tier2_deterministic": [{"check": "must_mention_any", "phrases": ["say again", "didn't catch", "come again", "one more time", "repeat"]}, {"check": "must_not_mention", "phrases": ["scars", "driver", "iron", "wedge"]}, {"check": "max_sentences", "n": 2}, {"check": "no_markdown"}], "tier2_judge": [{"property": "asks_to_repeat_on_unintelligible", "description": "The message is unintelligible noise, not a golf question. PASS = the caddie briefly asks the player to repeat and does NOT fabricate an on-topic golf answer (no club call, no strategy, no engaging with 'Scars' as if it meant something). One short ask is ideal; a lecture about audio quality is a FAIL."}]}}
```
(`must_not_mention` is the deterministic tier2 tripwire for a fabricated golf answer — a repeat-request contains no club name and doesn't echo the invented word. Builder may trim the phrase list if a live run shows a legitimate repeat-request phrasing colliding with it, but must keep at least `"scars"`.)

**Positive (the adversarial balance — terse REAL question still answered):**
```json
{"id": "terse-driver-question-still-answered", "source": "incident-2026-07-09-scars-transcript", "notes": "adversarial twin of gibberish-transcript-asks-to-repeat: INPUT_GROUNDING_RULE must NOT make the caddie over-refuse terse-but-clear golf input. 'Driver?' at 240y is a real question — club_within_one fails if the answer is 'say again' instead of a club call.", "situation": {"hole": {"number": 10, "par": 4, "yards": 240, "hazards": []}, "player": {"handicap": 12.0, "club_distances": {"driver": 250, "3wood": 230}}, "question": "Driver?"}, "expected": {"tier1": [{"check": "prompt_contains_rule", "rule": "INPUT_GROUNDING_RULE", "mouths": ["text", "realtime"]}], "tier2_deterministic": [{"check": "must_not_mention", "phrases": ["say again", "didn't catch", "come again", "repeat that"]}, {"check": "club_within_one", "target_yards": 240}, {"check": "max_sentences", "n": 3}, {"check": "no_markdown"}], "tier2_judge": [{"property": "appropriately_concise_and_calm", "description": "'Driver?' is a terse but perfectly clear question. PASS = a direct club answer. Asking the player to repeat, or hedging about not understanding, is a FAIL."}]}}
```
(Note `club_within_one` doubles as the falsifiable "it actually answered" check: a repeat-request names no club → red. `appropriately_concise_and_calm` is an **existing** enum member — no registration needed for the positive scenario.)

Both scenarios use the harness's existing shapes only — no schema shape changes beyond the two additions in §6a.

### 6c. Teeth proof — RED-then-green, exactly

**Automated mutant (add to `tests/eval/test_harness_has_teeth.py`, mirroring `test_prompt_contains_rule_goes_red_on_observed_reality_mutant` at line 42):**
```python
async def test_prompt_contains_rule_goes_red_on_input_grounding_mutant(monkeypatch):
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
```
plus a **single-mouth** variant stripping only `realtime_prompt` and asserting the failure `detail` names `['realtime']` (proves per-mouth attribution). Import `INPUT_GROUNDING_RULE` alongside `OBSERVED_REALITY_RULE` at line 24. The emptied-constant guard (`test_prompt_contains_rule_goes_red_when_constant_emptied`) already covers the new rule generically via `_RULE_TEXT` — no change needed. `TIER1_CHECKS_EXERCISED_BY_TEETH` already lists `PROMPT_CONTAINS_RULE` — no change.

**Manual mutation drill (README.md pattern, lines 80–93 — perform once, paste red output in the PR):**
1. In `routes/caddie.py::_build_session_voice_prompt`, delete the `{INPUT_GROUNDING_RULE}` line from `stable_text`.
2. `cd backend && uv run pytest tests/eval -x` → RED: `test_scenario_tier1_checks_pass[gibberish-transcript-asks-to-repeat]` fails with `prompt_contains_rule: INPUT_GROUNDING_RULE missing from mouth(s): ['text']`.
3. `git checkout -- backend/app/routes/caddie.py` → green again.
4. Repeat conceptually for the realtime mouth by deleting `+ "\n" + INPUT_GROUNDING_RULE` in `voice_prompts.py` → same scenario goes red with `['realtime']` (the automated single-mouth mutant pins this permanently).

### 6d. Tier 2 (live, non-CI, on-demand)

No runner changes needed. Verify with: `cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_tier2 --max-scenarios 34 --budget-usd 0.75` (34 scenarios after the two additions) — read both new scenarios' results in `last_run.json`. Honest caveat: Tier 2's candidate exercises the realtime **builder** but via a TEXT API call (README "Known limitations") — it validates the rule's behavioral effect on the instructions, not the raw-audio path; that's the best falsifiability available without the cascaded-STT spike.

## 7. Existing tests that WILL break without these updates (verified)

1. **`tests/test_caddie_caching.py`** (lines ~200–265): `_OLD_SESSION_TEMPLATE` / `_OLD_STATELESS_TEMPLATE` reconstruct the full stable_text line-set and compare to the live builders. Add a `{input_grounding_rule}` line to both templates (between `{tool_rule}` and `{observed_reality_rule}`) and pass `input_grounding_rule=INPUT_GROUNDING_RULE` in both `.format(...)` calls (import it at line 28). **Without this, two parity tests go red.**
2. **`tests/test_voice_stream.py`** (lines 582, 602): unaffected **only if** placement is before `OBSERVED_REALITY_RULE` (§3). Do not move the rule after it.
3. `tests/test_epistemic_humility_prompt.py`, `tests/test_realtime_grounding.py`, `tests/test_hazards.py`: assert containment/order of other rules — unaffected by an insertion.

## 8. New targeted unit test (parallel to the epistemic-humility precedent)

**New file `backend/tests/test_input_grounding_prompt.py`** mirroring `tests/test_epistemic_humility_prompt.py` (same DB-stub header: `DATABASE_URL` setdefault before imports):
- constant non-empty; contains the repeat-ask phrase (`"say again"`) AND the terse-carve-out marker (e.g. `"driver?"`) — pins the balance requirement in wording, both directions;
- `INPUT_GROUNDING_RULE in build_realtime_instructions(...)`;
- ordering pin: in the realtime instructions, `# Behavior` < `HAZARD_GROUNDING_RULE` < `INPUT_GROUNDING_RULE` < `OBSERVED_REALITY_RULE`;
- routes pin: `caddie_routes.INPUT_GROUNDING_RULE is INPUT_GROUNDING_RULE` and `inspect.getsource(caddie_routes).count("{INPUT_GROUNDING_RULE}") == 2`.

## 9. Shared-types / cross-file sync — confirmed none

Pure backend prompt-string + eval-data change. No `app/db/models.py` shape change, no `frontend/src/types.ts` (or any frontend) change, no API contract change. The frontend gate runs only to confirm no accidental coupling.

## 10. Exact file/function touch list

| File | Change |
|---|---|
| `backend/app/caddie/voice_prompts.py` | define `INPUT_GROUNDING_RULE` after `OBSERVED_REALITY_RULE`; append in `build_realtime_instructions` Behavior block before `OBSERVED_REALITY_RULE` |
| `backend/app/routes/caddie.py` | import the constant (line 34); add `{INPUT_GROUNDING_RULE}` before `{OBSERVED_REALITY_RULE}` in BOTH `stable_text` blocks (`_build_session_voice_prompt` ~801, `_build_voice_prompt` ~1412) |
| `backend/tests/eval/schema.py` | `_VALID_RULE_NAMES` += `"INPUT_GROUNDING_RULE"`; `Tier2JudgeProperty` += `ASKS_TO_REPEAT_ON_UNINTELLIGIBLE` |
| `backend/tests/eval/checks.py` | import + `_RULE_TEXT["INPUT_GROUNDING_RULE"]` |
| `backend/tests/eval/golden/caddie_advice.jsonl` | append the two scenarios (§6b) |
| `backend/tests/eval/test_harness_has_teeth.py` | two mutant tests (§6c) + import |
| `backend/tests/eval/README.md` | add the new judge property to the tier-2 list; mention `INPUT_GROUNDING_RULE` among rule constants |
| `backend/tests/test_caddie_caching.py` | add `{input_grounding_rule}` to both OLD templates + both `.format` calls |
| `backend/tests/test_input_grounding_prompt.py` | NEW (§8) |
| `specs/caddie-input-grounding-plan.md` | this document |

## 11. Gates (builder runs; QA re-runs strict)

```bash
cd backend && ruff check .
cd backend && uv run pytest tests/eval          # Tier1 + new teeth green; teeth prove RED-capability
cd backend && uv run pytest tests/test_input_grounding_prompt.py tests/test_epistemic_humility_prompt.py tests/test_caddie_caching.py tests/test_voice_stream.py tests/test_realtime_grounding.py
cd frontend && npm run lint && npx tsc --noEmit && npx tsx voice-tests/runner.ts --smoke   # unaffected — confirm
# Manual, once: the §6c mutation drill; red output pasted into the PR.
# Optional live read (never CI): cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_tier2 --budget-usd 0.75
```
**NO docker / NO local Postgres** — DB-backed backend tests run in CI only; everything listed above is in the DB-free stub pattern.

## 12. Review criteria (the reviewer will test both ways)

1. Rule present in all THREE injection sites, before `OBSERVED_REALITY_RULE`; absent from `guide_writer.py`.
2. **Balance**: rule wording targets unintelligible/non-golf input AND explicitly protects terse golf questions; the positive golden scenario (`terse-driver-question-still-answered`) makes over-refusal falsifiable; the negative one makes noise-answering falsifiable.
3. Teeth: the new `prompt_contains_rule` mutant goes red when the rule is stripped from either mouth; manual drill output in the PR.
4. Honesty: PR/spec state plainly that realtime is a nudge-not-gate and that the plausibility heuristic was considered and deferred (§5).
5. NORTHSTAR calm: the rule asks to repeat **once**, briefly — never chatty, never repetitive.
