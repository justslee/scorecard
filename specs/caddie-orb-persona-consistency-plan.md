# Implementation plan — `caddie-orb-persona-consistency` (caddie register unification)

Design contract: `/Users/justinlee/projects/scorecard/specs/caddie-orb-persona-consistency-persona.md` (authoritative on the voice, the banned/required strings, and the per-surface disposition). Scope is REGISTER ONLY: every grounding rule constant, validator, tool payload, number, and `compose_degraded_line` stays byte-identical.

## 0. Approach

One new module-level constant, `CADDIE_HOUSE_REGISTER`, in `backend/app/caddie/voice_prompts.py`, mirroring the existing shared-rule pattern (`OBSERVED_REALITY_RULE` et al.: single-paragraph string, "Shared by ALL mouths so wording never drifts", always imported, never copied). Each ADOPT surface swaps its restated register sentences for the constant at a fixed position inside its existing block, so the change is a wording consolidation, not a prefix reshuffle. Verification rides on the existing offline harness: the imported-constant Tier-1 pattern (`prompt_contains_rule`) plus one new thin standalone pytest that does the banned-literal static scan and pins the persona-doc linkage. No live model calls in CI.

## 1. The shared constant (exact text)

Add to `backend/app/caddie/voice_prompts.py`, ABOVE `_BASE_BEHAVIOR` (load-bearing: `_BASE_BEHAVIOR` becomes an f-string interpolating it at module import):

```python
# The house register (specs/caddie-orb-persona-consistency-persona.md §1,
# rules 1-5). Shared by ALL mouths so wording never drifts: the Realtime
# behavior block (_BASE_BEHAVIOR below), both text-mouth stable_text builders
# (routes/caddie.py), the strategy brain (strategy.py::_strategy_system), and
# the guide writer (guide_writer.WRITER_SYSTEM). Grounding ("never invent a
# number; say plainly what's unavailable") is rule 6 — it lives in the
# grounding constants below, NOT here. Personas layer flavor ON TOP of this;
# they never restate it. course_intel_writer.COURSE_WRITER_SYSTEM is the one
# intentionally distinct written-medium register (see its own comment).
# SINGLE PARAGRAPH, no newlines — the prompt-assembly line-set guard
# (tests/test_caddie_caching.py) and both mouths interpolate it as one line.
CADDIE_HOUSE_REGISTER = (
    "Your words are heard, never read: plain speech only — never use markdown, "
    "asterisks, bullet lists, headings, numbered steps, or emoji. Brief by "
    "default: 1 to 3 short sentences unless the player asks for more — one "
    "clear call beats a pep talk. No preamble and no meta-commentary: never "
    "announce what you are about to do or frame the answer — start with the "
    "answer itself. Calm and specific, like a good caddie talking, not a "
    "report: state numbers and calls plainly — never hedged, dressed up, or "
    "corporate. Never robotic and never break character: no AI self-reference, "
    "no disclaimers, no apologizing for being a model — stay the caddie."
)
```

Deliberate wording choices (do not change):
- Keeps the literal `never use markdown` — golden scenario `text-mouth-states-no-markdown-contract` and the teeth test at `tests/eval/test_harness_has_teeth.py:141` pin that literal and stay green untouched.
- Uses `1 to 3 short sentences` (persona doc rule 2) — unifies realtime's old "1 to 3 sentences" and text's old "2-3 short sentences" (that literal's two pins get updated; see §5).
- Contains NO banned literal (notably it does NOT quote "Here's the plan"), so the static scan in §5 can be strict with no quoted-negative carve-out.
- No newline in the value — interpolates as exactly one line everywhere.

## 2. Adoption, surface by surface (exact insertion points + cache notes)

### 2.1 (1a) Realtime `_BASE_BEHAVIOR` — `voice_prompts.py:22-35`

Rewrite as an f-string. New value (exact):

```python
_BASE_BEHAVIOR = f"""You are caddying live for this golfer. You can hear them and they can hear you.
{CADDIE_HOUSE_REGISTER}
When the hole data shows an uphill/downhill change, factor it into the club call and say it
briefly ("plays more like 195 with the climb"). Any "Local knowledge" line is written for
golfers in general — filter it through THIS player's real club distances before repeating it:
never mention a hazard they can't reach on the shot at hand; focus on what's in play at THEIR
landing zone.
You may interrupt yourself to acknowledge the player if they cut in.
You have tools available — use them to fetch real numbers (recommendations, distances) before
giving strategic advice. Never state a yardage, club distance, or carry you did not get from a
tool. If a tool reports data as unavailable, say so plainly — never invent a number to fill in.
Reference prior shots and prior rounds when it sharpens the advice.
"""
```

Removed (now owned by the constant): "Default to brief, spoken-style answers — 1 to 3 sentences. Your words are heard, not read: never use markdown, asterisks, lists, headings, or emoji. One clear call beats a pep talk." and "Stay in character at all times." Kept verbatim: elevation clause, local-knowledge filter, interrupt clause, tool clause, memory clause.

`build_realtime_instructions` (line ~233) is NOT edited. Part ordering stays `[# Personality, persona block] → memory → situation → history → # Behavior(...)`; the Behavior block still opens with `_BASE_BEHAVIOR.strip()` followed by the unchanged rule stack, so `tests/eval/test_strategy_tool.py::test_strategy_tool_rule_present_in_realtime_instructions` (`# Behavior` < DECISION < STRATEGY_TOOL ordering) stays green untouched.

Cache note (realtime): instructions are minted per session; the only stable cross-session prefix is the persona block, which is byte-identical for DB-served personas and changes only for the pruned builtin fallbacks (expected). Assembly order unchanged → no prefix reshuffle.

### 2.2 (2) Strategy brain `_strategy_system()` — `strategy.py:384-406`

Two edits inside the f-string; everything else byte-identical:

1. Insert `{CADDIE_HOUSE_REGISTER}` on its own line directly ABOVE `{HAZARD_GROUNDING_RULE}` (register precedes the grounding stack — same relative position as the text mouths). Add the import to strategy.py's existing `voice_prompts` import.
2. Replace the Output-contract paragraph (lines 402-406) with:

```
Output contract: ONE paragraph, at most 80 words. Tee to green: the club call (the engine's
recommendation IS the call — explain it, never re-decide it), the aim/landing zone, the miss
side the data supports, what the shot leaves, and one green note when the read is available.
```

Pruned by edit 2 (now owned by the constant): "plain speech — no markdown, bullets, headings, or emoji; no preamble ("Here's the plan"), no meta-commentary" and the trailing "Calm and specific, like a good caddie talking, not a report." (this also removes the module's only embedded banned-literal quote, keeping the §5 scan strict). Kept: the 80-word/one-paragraph output contract and the whole GROUND TRUTH framing — FROZEN.

Test to update: `tests/eval/test_strategy_tool.py::test_strategy_system_states_the_output_contract` — replace `assert "no markdown" in system.lower()` with `assert CADDIE_HOUSE_REGISTER in system` (import it); keep `assert "80 words" in system`. `test_strategy_system_contains_the_grounding_rule_constants` stays green untouched.

### 2.3 (5b) Text-mouth `stable_text` — `routes/caddie.py:990-1019` and `:1803-1830` (BOTH builders)

Import `CADDIE_HOUSE_REGISTER` alongside the existing `voice_prompts` imports. In `_build_session_voice_prompt`, the `--- INSTRUCTIONS ---` section becomes (exact; the stateless `_build_voice_prompt` at :1803 is identical MINUS the "You have memory..." paragraph — preserve that existing single point of difference):

```
--- INSTRUCTIONS ---
You are caddying for this golfer right now, on the course. Respond to their question or comment.
Your reply is SPOKEN ALOUD on the course.
{CADDIE_HOUSE_REGISTER}
If they ask about club selection, aim, or strategy, use the CURRENT SITUATION section to give
specific, actionable advice — and when the hole context shows an uphill/downhill change or a
plays-like distance, factor it in and SAY it briefly ("plays more like 195 with the climb").
Any "Local knowledge" line is written for golfers in general — filter it through THIS player's
real distances before repeating it: a hazard beyond their reach off the tee is irrelevant
(don't mention it); talk about what's in play at THEIR landing zone. A 300-yard driver doesn't
care about a bunker at 370. If they're just chatting, be personable but keep it golf-focused.
You have memory of the entire round conversation and prior rounds. Reference earlier holes/shots
or known tendencies when relevant.
```

Removed (owned by the constant): ": keep it to 2-3 short sentences max unless they ask for more detail. Plain speech only — never use markdown, asterisks, bullet lists, headings, or emoji. One clear recommendation beats a pep talk." and "Never break character." Kept verbatim: persona head, memory section, the CURRENT SITUATION/elevation/local-knowledge guidance, the memory paragraph (session builder only), and the ENTIRE rule stack `{output_language_rule()}…{DECISION_GROUNDING_RULE}` in its exact current order.

Cache-stability (Anthropic prompt cache — the critical constraint):
- The BLOCK 0 (stable, `cache_control: ephemeral`) / BLOCK 1 (volatile) split, and cache_control placement, are untouched — pinned by `tests/test_caddie_caching.py` tests 1/2/4/6, which must stay green UNEDITED.
- The house constant is a module constant interpolated at a FIXED position inside BLOCK 0 — nothing per-turn/per-hole enters the stable block, so per-round cache hits resume immediately after the one-time re-prime.
- BLOCK 1 (`volatile_text` / context assembly / `format_tee_numbers_line`) must be byte-identical — zero edits in that region.
- The golden literal `You have memory of the entire round conversation` (scenario `followup-3wood-after-driver`) is preserved verbatim.

### 2.4 (1b/5a) Personas — `personalities.py` (hardcoded seed dict ONLY; hype EXEMPT, untouched)

Prune ONLY clean restatements of brevity/calm/robotic (the register owns them); all persona flavor stays. Exact edits:
- `strategist.realtime_instructions`: delete the final sentence "Two or three short sentences per response unless the player asks you to go deeper."
- `strategist.system_prompt`: delete the bullet "- Keep responses concise — 2-3 sentences max for quick advice".
- `classic.realtime_instructions`: "Keep it conversational, never robotic. Read the player's mood." → "Read the player's mood." (drop the conversational/robotic restatement; keep the calm-warm-authority persona description — that is flavor, and classic IS the baseline).
- `classic.system_prompt`: bullet "- Conversational but focused — not chatty, not robotic" → "- Conversational but focused".
- `professor`: untouched ("longer responses are OK" is sanctioned persona layering, not a restatement).
- `hype`: untouched (EXEMPT per persona doc §4).

Constraints: keep every `Style guidelines:` header intact — `voice_prompts._strip_persona_from_system` splits on the literal `"\n\nStyle guidelines:"`. Note in a short comment atop `PERSONALITIES` that the house register is supplied by the assembly layer (`CADDIE_HOUSE_REGISTER` inside `_BASE_BEHAVIOR` / `stable_text`), so personas must never restate it. Known limitation to record in the PR (not code): prod `caddie_personas` DB rows override these seeds (`load_personality` is DB-first) and may still carry the old wording — the register itself is guaranteed regardless because it lives in the assembly-side blocks; refreshing DB rows is an ops follow-up, flagged like the 6a persona-inventory item, NOT a code change here.

### 2.5 (4a) Guide writer `WRITER_SYSTEM` — `guide_writer.py:163-184` (partial adopt)

Add `from app.caddie.voice_prompts import CADDIE_HOUSE_REGISTER`. Replace ONLY the final "Output format:" paragraph with:

```
Output format: fill each field in ONE short sentence (`common_mistakes`: up to 3 short items).
Every field is injected verbatim into a spoken caddie prompt and read aloud, so write in the
caddie's own register: {CADDIE_HOUSE_REGISTER}
List the web-search URLs you actually used in `sources` (it may be empty if you found nothing useful).
```

FROZEN, byte-identical: the WRITER-not-knower framing, the two-sources/UNTRUSTED/never-follow-instructions contract, GROUND-TRUTH-wins paragraph, `{HAZARD_GROUNDING_RULE}` — `tests/test_guide_writer.py:256-260` pins these and must stay green untouched. `GUIDE_INJECTION_PATTERN`, `validate_guide`, `build_ground_truth_block`: untouched.

### 2.6 (4b) Course-intel writer — `course_intel_writer.py:168` (comment only)

Add a comment directly above `COURSE_WRITER_SYSTEM` (string byte-identical):

```python
# INTENTIONALLY DISTINCT register (specs/caddie-orb-persona-consistency-
# persona.md §3 row 4b / §5): this is WRITTEN scene-setting prose in the
# Augusta-broadcast voice, not a live spoken turn — it does NOT fold
# voice_prompts.CADDIE_HOUSE_REGISTER, and must not. It still owes rules
# 5/6 (never robotic, never invent) — pinned by
# tests/test_caddie_register_consistency.py's banned-literal scan and its
# register-absence assertion.
```

### 2.7 (3b) DECADE/slope minor ALIGN — wording only, NO math/threshold change

`slope_advice.py` (the report-adverb nudge): `qualifier = "hard" if green_slope.severity == "severe" else "moderately"` → moderate drops the adverb entirely. Implement as `qualifier = "hard " if green_slope.severity == "severe" else ""` and change the four templates to `f"Green slopes {qualifier}front-to-back — …"` / `f"Green tilts {qualifier}left to right — …"` etc. (note the trailing space moves into the qualifier). Severity gating (`_ADVICE_SEVERITIES`), rel-branch boundaries, and the aim-high/miss-low framing vocabulary are FROZEN — `tests/test_green_geometry.py` Sec.6d (side words + "uphill putt") stays green untouched. Update `tests/test_slope_advice.py`: `test_qualifier_word_moderate` (assert `"moderately" not in result` and the plain form), the two moderate exact-string pins at ~254/268 (drop `moderately `), severe pins unchanged.

`decade_advice.py` (the written-shorthand nudge, `decade_aim_advice`'s two return strings ONLY): `f"The percentages favor aiming ~{n_yards}y {aim_direction} of the flag…"` → `f"The percentages favor aiming about {n_yards} yards {aim_direction} of the flag…"` (both the hazard-named and danger-side variants). Keep "The percentages favor aiming" verbatim — it is genuine DECADE golf-speak, and `tests/test_positioning_shot.py:274` (`"percentages favor aiming" not in joined`) keeps its teeth, as does `test_decade_advice.py:310`'s `startswith`. Deliberately NOT changed: `decade_landing_advice` / `cross_hazard_line`'s `~{carry}` notation — it matches the FROZEN numbers-block notation in `format_tee_numbers_line` ("plays like ~X"), and changing it would touch `tests/test_bag_caddie_grounding_unit.py`'s exact pins for zero register gain; record this judgment in a one-line comment. Update `tests/test_decade_advice.py`: the `_extract` regex at :37-38 (`r"~(\d+)y"` → `r"about (\d+) yards"`) and the unit-form test at ~313. All thresholds/breakpoints/windows (`AIM_THRESHOLD_YDS`, sigmas, drive-zone constants) byte-identical.

### 2.8 Explicitly untouched

`strategy_turn.py::compose_degraded_line` (KEEP AS IS — its terse output already serves rule 4; existing guards at `tests/eval/test_strategy_tool.py:620-745` stay green untouched). All grounding constants, `output_language_rule`, `STRATEGY_TOOL_RULE` (its "Let me look at this one." bridge is a designer-owned sanctioned acknowledgment, not preamble), `TOOL_USE_RULE`, `format_tee_numbers_line`, `format_par_sanity_note`, `_situation_block`, all validators, all tool payloads, `frontend/**` (6b/6c KEEP-AS-IS; 6a flagged as a separate backlog item, no code), `types.ts`/`models.py` (no shared shape changes — confirm diff touches neither).

## 3. Eval design (CI-safe, offline, thin)

### 3.1 Tier-1: register-as-rule (imported-constant pattern — no new check KIND)

The cleanest home is the EXISTING `prompt_contains_rule` machinery, which already implements "assert the imported constant is in the assembled prompt" and already has teeth coverage — adding a new check kind would also trip the registry-closure tests for no benefit.
- `tests/eval/checks.py`: import `CADDIE_HOUSE_REGISTER`; add `"CADDIE_HOUSE_REGISTER": CADDIE_HOUSE_REGISTER` to `_RULE_TEXT` (:223). The existing empty-rule toothlessness guard applies automatically.
- `tests/eval/schema.py`: add `"CADDIE_HOUSE_REGISTER"` to `_VALID_RULE_NAMES` (:103).
- `tests/eval/golden/caddie_advice.jsonl`:
  - `chatty-question-stays-calm`: replace `{"check": "prompt_contains_literal", "literal": "2-3 short sentences", "mouths": ["text"]}` with `{"check": "prompt_contains_rule", "rule": "CADDIE_HOUSE_REGISTER", "mouths": ["text", "realtime"]}` — this is the check that asserts the constant in BOTH assembled ADOPT mouths that Tier-1 covers.
  - `text-mouth-states-no-markdown-contract`: keep the `never use markdown` literal check; widen `"mouths"` to `["text", "realtime"]` (the literal now exists in both via the constant).
- `tests/eval/test_harness_has_teeth.py`: update :130's literal `"2-3 short sentences"` → `"1 to 3 short sentences"` (still a real literal in the real prompt; mutant half unchanged). :141 (`never use markdown`) unchanged. Add one register mutant test mirroring the OBSERVED_REALITY one: `prompt_contains_rule` with `rule="CADDIE_HOUSE_REGISTER"` passes on the real ctx and goes RED on `ctx.text_prompt/realtime_prompt.replace(CADDIE_HOUSE_REGISTER, "")`.

### 3.2 New standalone pytest — `backend/tests/test_caddie_register_consistency.py`

Offline, no network/DB (standard header: `os.environ.setdefault("DATABASE_URL", …stub…)` + `LOOPER_SECRETS_DISABLED` before app imports, same as `test_golden_tier1.py`). Contents:

1. **Adoption pins for the non-Tier-1 mouths** (imported constant, never re-typed): `CADDIE_HOUSE_REGISTER in voice_prompts._BASE_BEHAVIOR`; `in strategy._strategy_system()`; `in guide_writer.WRITER_SYSTEM`; and `not in course_intel_writer.COURSE_WRITER_SYSTEM` (pins 4b's intentional distinctness). Plus a shape guard: constant is non-empty and contains no `"\n"` (protects the line-set comparison and one-line interpolation).
2. **Banned-literal static scan** — persona doc §2's list as a module-level `BANNED_REGISTER_LITERALS` tuple (lowercase substrings: the AI-tells, meta-preamble, SaaS-speak, and the two degraded regression strings `no trouble` / `the none`). Scan (case-insensitive substring) over exactly: `CADDIE_HOUSE_REGISTER`, `_BASE_BEHAVIOR`, `_strategy_system()`, `WRITER_SYSTEM`, `COURSE_WRITER_SYSTEM`, each builtin persona's `realtime_instructions` + `system_prompt` (`PERSONALITIES`), all four `slope_miss_advice` branch outputs × both severities, sample outputs of `decade_aim_advice`/`decade_landing_advice`/`cross_hazard_line`, and one `compose_degraded_line` sample (read-only invocation). Substring-literals ONLY — do NOT apply the markdown/emoji structural checks here (persona system_prompts legitimately contain `- ` style-guideline bullets; markdown/emoji checks stay Tier-2 on live ANSWERS via the existing `no_markdown`).
3. **Persona-doc banned-list pin** (reference, not re-type): `test_banned_list_matches_persona_doc` reads `Path(__file__).resolve().parents[2] / "specs" / "caddie-orb-persona-consistency-persona.md"` and asserts every entry of `BANNED_REGISTER_LITERALS` appears verbatim in the doc's §2. Direction of truth: the doc is the source; a doc edit that renames/removes a literal makes this test fail loudly, so the code list can never silently drift from the contract. (Full markdown-backtick parsing is deliberately avoided as brittle — this containment pin is the documented "reference it" mechanism.)
4. **Cheap required-marker spot checks** (static, per doc §2 "where cheap"): `hype`'s prompts contain `"!"`; `professor`'s contain `"why"` (case-insensitive); `strategist`'s contain a digit; `classic` asserts nothing (baseline). Live-answer banned/required checks are explicitly OUT of CI — they may later ride `run_tier2.py`/`run_consistency.py` behind `CADDIE_EVAL_LIVE=1` (note this in the module docstring; do not implement).

### 3.3 Proving the change is register-only (the assembled-prompt guard)

`tests/test_caddie_caching.py` is the test that will go red and whose expected strings MUST be updated — and it is also the proof mechanism. Update `_OLD_SESSION_TEMPLATE` (:182) and `_OLD_STATELESS_TEMPLATE` (:217): mirror §2.3's new INSTRUCTIONS text exactly, with the register as a `{house_register}` placeholder, and pass `house_register=CADDIE_HOUSE_REGISTER` (imported) in both `.format(...)` calls — extending the file's existing convention where every deliberate addition is referenced via its imported constant. Extend the comment block at :161-179 with one line citing this spec. Because the guard compares normalized LINE SETS of the full assembled prompt against the template, a green run proves: persona head, memory section, every grounding rule, the context/volatile block, and the block/breakpoint structure are all unchanged — the ONLY delta is the swapped register lines, which arrive via the same imported constant production uses. Tests 1/2 (two-block list, breakpoint on block 0 only, stable-before-volatile) are NOT edited and pin the cache structure.

## 4. File-by-file change list

Production (7 files):
1. `backend/app/caddie/voice_prompts.py` — add `CADDIE_HOUSE_REGISTER` (above `_BASE_BEHAVIOR`); rewrite `_BASE_BEHAVIOR` per §2.1. Nothing else in the module changes.
2. `backend/app/routes/caddie.py` — import the constant; rewrite the `--- INSTRUCTIONS ---` section of BOTH `stable_text` f-strings per §2.3 (rule stack and BLOCK 1 untouched).
3. `backend/app/caddie/strategy.py` — import the constant; two edits in `_strategy_system()` per §2.2.
4. `backend/app/caddie/guide_writer.py` — import the constant; Output-format paragraph per §2.5.
5. `backend/app/caddie/personalities.py` — four seed prunes per §2.4 + comment.
6. `backend/app/caddie/course_intel_writer.py` — comment only per §2.6.
7. `backend/app/caddie/slope_advice.py` + `backend/app/caddie/decade_advice.py` — wording per §2.7.

Tests/eval (7 files):
8. `backend/tests/eval/checks.py` — `_RULE_TEXT` entry + import.
9. `backend/tests/eval/schema.py` — `_VALID_RULE_NAMES` entry.
10. `backend/tests/eval/golden/caddie_advice.jsonl` — two scenario check edits (§3.1).
11. `backend/tests/eval/test_harness_has_teeth.py` — one literal update + one new register mutant.
12. `backend/tests/test_caddie_caching.py` — template mirror per §3.3.
13. `backend/tests/eval/test_strategy_tool.py` — `test_strategy_system_states_the_output_contract` per §2.2 only.
14. `backend/tests/test_slope_advice.py`, `backend/tests/test_decade_advice.py` — pins per §2.7.

New: 15. `backend/tests/test_caddie_register_consistency.py` (§3.2).

## 5. Edge cases / risks

- **Constant-definition order**: `_BASE_BEHAVIOR` and `WRITER_SYSTEM` interpolate at import time — `CADDIE_HOUSE_REGISTER` must be defined above `_BASE_BEHAVIOR`; strategy/guide_writer import it, no cycle (`voice_prompts` imports neither).
- **guide_writer → voice_prompts import**: pulls `app.db.models`/`app.caddie.session` transitively at import. Every existing test file that imports guide_writer stubs `DATABASE_URL` first; builder must run `uv run pytest tests/test_guide_writer.py tests/eval -x` early to confirm clean import.
- **DB personas override seeds** (prod): register is assembly-side so it always lands; the prune de-duplicates seeds only. State the DB-row-refresh ops follow-up in the PR, alongside the 6a persona-inventory backlog flag.
- **`_strip_persona_from_system` seam**: persona prunes must not remove/alter the `"\n\nStyle guidelines:"` separator.
- **Banned-scan false positives**: verified none in current strings (Professor's "Here's the situation:" is not "here's the plan"; the two route-model DOCSTRINGS containing "leverages" at `routes/caddie.py:268,292` are OpenAPI descriptions, not prompt text — out of scan scope; do not "fix" them).
- **Which assembled strings change bytes (expected)**: realtime instructions (behavior block + pruned builtin persona blocks), both `stable_text` BLOCK 0s (one-time Anthropic cache re-prime per round shape, then normal hits), `_strategy_system()`, `WRITER_SYSTEM`, moderate-severity slope strings, `decade_aim_advice` strings. **Must stay byte-identical**: every grounding/tool/language rule constant, BLOCK 1 / situation blocks / `messages`, `format_tee_numbers_line` + corridor clauses, `compose_degraded_line`, `COURSE_WRITER_SYSTEM`, `GUIDE_INJECTION_PATTERN`, all validators/payloads.
- **Ruff**: keep the constant as parenthesized concatenation (source lines within limit; value single-line).

## 6. Gates (exact commands)

Backend, from `/Users/justinlee/projects/scorecard/backend`:
- `uv run ruff check .`
- `uv run python ci_scripts/scoping_lint.py` (must stay green untouched)
- `uv run pytest` — full CI parity. Within it, the contract split:
  - Updated-then-green (prompt assembly + register): `tests/test_caddie_caching.py`, `tests/eval/test_golden_tier1.py`, `tests/eval/test_harness_has_teeth.py`, `tests/eval/test_strategy_tool.py`, `tests/test_slope_advice.py`, `tests/test_decade_advice.py`, new `tests/test_caddie_register_consistency.py`.
  - Green UNTOUCHED (frozen numbers/verdict/grounding contracts — proof of intended-only change): `tests/eval/test_strategy_tool.py` degraded-line + ground-truth tests, `tests/test_numbers_coherence_prompt.py`, `tests/test_decision_grounding_prompt.py`, `tests/test_positioning_prompt.py`, `tests/test_positioning_shot.py`, `tests/test_epistemic_humility_prompt.py`, `tests/test_input_grounding_prompt.py`, `tests/test_output_language_prompt.py`, `tests/test_realtime_grounding.py`, `tests/test_situation_block_strip.py`, `tests/test_green_geometry.py`, `tests/test_guide_writer.py`, `tests/test_bag_caddie_grounding_unit.py`, `tests/eval/test_realtime_session_config.py` (voice-config pins over the pruned `PERSONALITIES` — voice_ids untouched), `tests/test_caddie_log_lines.py`, `tests/test_caddie_tools.py`, `tests/test_realtime_tools.py`.

Frontend, from `/Users/justinlee/projects/scorecard/frontend` (backend-only change — these must pass trivially; confirm the diff contains zero frontend files): `npm run lint` · `npx tsc --noEmit` · `npx tsx voice-tests/runner.ts --smoke` · `npm test` · `npm run build`.

Shared source-of-truth pins: `frontend/src/lib/types.ts` ↔ `backend/app/models.py` untouched (no shared shapes change — verify in diff); the persona-doc banned-list is pinned by `test_banned_list_matches_persona_doc` (§3.2 item 3), never re-typed without a drift alarm.
