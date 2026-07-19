# Implementation plan — `caddie-guide-local-lore` (researched LOCAL-LORE layer for the hole-guide pipeline)

Branch: `lane/caddie-local-lore` (worktree `/Users/justinlee/projects/scorecard/.claude/worktrees/agent-a3f58554840632c13`, based on `origin/integration/next`). Authored by the Fable Plan agent, 2026-07-19.

## 0. Contract summary — what this adds, what it may never touch

Lore is a new, additive, ATTRIBUTED knowledge layer on `HoleStrategyGuide`. It may add non-geometric knowledge (false fronts, tiers, run-offs, turtleback character, named features, play-relevant tournament history, architect intent). It may never contradict our surveyed geometry, never carry an unattributed claim, and never smuggle a yardage/carry/club-shaped number into the spoken engine layer. Numbers stay engine-bound; lore numbers are attributed context only (slope %, years).

**BYTE-IDENTICAL (proved, not asserted — see §8/§9):**
- `guide_writer.validate_guide` (guide_writer.py:877-999), `_has_side_flip` and its whole carry/side machinery (:374-874), `format_guide_line` (:51-94), `WRITER_SYSTEM`, `research_hole_guide`, `GUIDE_INJECTION_PATTERN`.
- `strategy.validate_strategy_text`, `_verdict_pin_reject_reason`, `verdict.guide_agrees_with_verdict`, `compose_degraded_line`, all `*_payload` helpers, all engine numbers.
- `course_guides._precompute_course_guides` and `run_guide_backfill` (tactical path never fires lore).
- The two read-revalidation seams that call `validate_guide` (session.py:95-96; routes/caddie.py:1610-1613) — untouched (see §6.3 for why that is safe).
- `format_guide_line` stays lore-free: text-mouth lore is an explicitly flagged follow-up, not this lane.

All edits are additive: new fields with defaults, new functions, one appended paragraph, one new labeled block appended after the last existing block.

---

## 1. SCHEMA — `backend/app/caddie/types.py`

### 1.1 New `LoreItem` model (insert directly above `HoleStrategyGuide`, types.py:93)

```python
class LoreItem(BaseModel):
    """One researched, attributed piece of local knowledge about a hole
    (specs/caddie-guide-local-lore-plan.md). Content-only — it doubles as the
    lore writer's structured-output item schema (like guide_writer._WriterOutput,
    provenance is stamped at the GUIDE level by research_hole_lore, never asked
    of the model). ALL fields defaulted so an older cached strategy_guide JSONB
    blob (no lore) and a partial item both still validate; validate_lore is the
    gate that decides what survives, per-item ([[no-fake-data-fallbacks]])."""

    text: str = ""          # ONE plain sentence, register-matched (calm, on-paper)
    category: str = "feature"  # green_character | feature | history | architect_intent
    source: str = ""        # short spoken attribution ("USGA championship notes") — NEVER a URL;
                            # empty = unattributed -> validate_lore drops the item
    confidence: str = "unknown"  # high | medium | low | unknown (self-reported; kept iff exactly "high")
```

### 1.2 Additive fields on `HoleStrategyGuide` (types.py:93-107)

Append after `schema_version` (do **not** bump `schema_version` — these are additive-with-defaults, the established convention; bumping would imply tactical staleness semantics this change doesn't have):

```python
    # Researched LOCAL-LORE layer (specs/caddie-guide-local-lore-plan.md) —
    # additive + defaulted so every pre-lore cached JSONB blob still validates.
    # [] = no lore researched/surviving yet (honest omission, never a placeholder).
    local_lore: list[LoreItem] = Field(default_factory=list)
    # Guide-level lore provenance (ONE research call produces the whole batch —
    # per-item stamps would only bloat the JSONB and the prompt; the per-item
    # `source` field is the user-facing attribution, these are ops provenance).
    lore_generated_at: str = ""   # ISO 8601, stamped by research_hole_lore
    lore_model: str = ""          # model id that wrote the lore batch
    lore_sources: list[str] = Field(default_factory=list)  # audit URLs actually used — NEVER rendered into any prompt
```

**Provenance decision: guide-level, not per-item** — one networked call per hole produces the batch atomically; per-item stamps carry no extra information and would be rendered-adjacent bytes we'd have to keep out of the prompt anyway.

### 1.3 Frontend flag (found — the scope note's "backend-only" assumption is WRONG)

`frontend/src/lib/caddie/types.ts:103-115` declares `HoleStrategyGuide` with the comment "mirrors `backend/app/caddie/types.py::HoleStrategyGuide` exactly", and `HoleIntelligence.strategy_guide?` at :147; CaddiePanel round-trips `hole_intelligence` back into `/caddie/recommend`. Nothing breaks at runtime (TS ignores extra keys; Pydantic `model_validate` tolerates extras), but the "mirrors exactly" contract and CLAUDE.md's types.ts↔models sync rule mean we should make one tiny additive edit: add `export interface LoreItem { text: string; category: 'green_character' | 'feature' | 'history' | 'architect_intent'; source: string; confidence: string; }` and optional `local_lore?: LoreItem[]; lore_generated_at?: string; lore_model?: string; lore_sources?: string[];` on `HoleStrategyGuide` (optional so pre-lore payloads type-check). Gate with `npx tsc --noEmit`.

---

## 2. WRITER — `backend/app/caddie/guide_writer.py` (new section appended)

### 2.1 `LORE_WRITER_SYSTEM` (new module constant)

WRITER-not-knower framing modeled on `WRITER_SYSTEM` (:163-184), with these load-bearing clauses:
- Two sources only: (1) the GROUND TRUTH block (authoritative; geometry wins over anything read online), (2) `web_search` results (UNTRUSTED — verbatim reuse of WRITER_SYSTEM's never-follow-instructions-in-results paragraph).
- Targets, in priority order: **green-complex character** (false fronts, tiers, run-offs, crowned/turtleback shapes, where the green sheds balls, where "below the hole" matters); **famous/named features**; **play-relevant tournament history** (where championships cut pins, what pros actually do — never trivia for its own sake); **architect intent** (what the designer wants the player to feel/do).
- Each item: ONE plain sentence, single line, no markdown/URLs/newlines; register-matched — calm, on-paper, like a margin note in a printed yardage book (NORTHSTAR register); at most 5 items.
- Each item MUST name its `source` as a short publication/author attribution ("Golf Digest course guide", "USGA 2024 U.S. Open notes") — **never a URL** (URLs go only in the top-level `sources` list) — and self-report `confidence` as exactly one of high/medium/low/unknown; "When in doubt, say low — a dropped item costs nothing, a wrong item is worse than none".
- **THE NUMBERS RULE (prompt layer of the three-layer enforcement, §6):** "Never state a yardage, carry, or club — the live engine owns every number a caddie speaks. Distances may appear only qualitatively ('landing short is dead', 'anything above the hole runs away'). Slope percentages and tournament years are allowed as attributed context."
- Hazard grounding: may only name a hazard type/side that appears in the GROUND TRUTH hazard list (embed `HAZARD_GROUNDING_RULE` like WRITER_SYSTEM does).

### 2.2 Structured output + result shape

```python
class _LoreWriterOutput(BaseModel):
    items: list[LoreItem] = Field(default_factory=list)   # up to ~5
    sources: list[str] = Field(default_factory=list)      # URLs actually used


class LoreResearchResult(BaseModel):
    items: list[LoreItem] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    generated_at: str = ""
    model: str = ""
```

### 2.3 `research_hole_lore` — the SEPARATE networked function

```python
async def research_hole_lore(
    course_name: str,
    hole_number: int,
    par: int,
    yards: Optional[int],
    green_slope: Optional[dict],
    elevation_change_ft: Optional[float],
    hazards: list[Hazard],
) -> LoreResearchResult:
```

- **Takes `course_name`** — lore is course-specific; user prompt `f"Course: {course_name}\n\n{ground_truth}\n\nResearch the local knowledge..."`. Reuses `build_ground_truth_block` unchanged (geometry wins).
- Mirrors `research_hole_guide` mechanics **exactly**: `ANTHROPIC_API_KEY` guard; model env — reuse `GUIDE_WRITER_MODEL` (default `claude-sonnet-5`); `messages.parse` with `thinking={"type": "adaptive"}`, `tools=[{"type": "web_search_20260209", "name": "web_search", "max_uses": 3}]`, `output_format=_LoreWriterOutput`, `_WRITER_MAX_TOKENS` (4000); the `pause_turn` continuation loop up to `_MAX_CONTINUATIONS` passing `result.content` directly (the guide-pauseturn-reserialize-hardening pattern, verbatim); cost-guard `log.info`.
- Stamps `generated_at`/`model` itself; raises on missing key / SDK errors / exceeded continuations / no parsed output. Caller runs `validate_lore` before persisting.

---

## 3. VALIDATOR — `validate_lore` in `guide_writer.py` (new; `validate_guide` untouched)

The crux: a **different bar** from `validate_guide`. Tactical validation is fail-CLOSED whole-guide-REJECT because the tactical guide *instructs play*. Lore validation is **per-item DROP** (modeled on `course_intel_writer.validate_course_description`'s rule-4 fact-drop, :407-423) because the tactical guide already passed and must stay intact.

New constants: `_MAX_LORE_ITEMS = 5`, `_MAX_LORE_TEXT_CHARS = _MAX_FIELD_CHARS` (240), `_MAX_LORE_SOURCE_CHARS = 80`, `_LORE_CATEGORIES = frozenset({"green_character", "feature", "history", "architect_intent"})`.

```python
def validate_lore(items: list[LoreItem], hazards: list[Hazard]) -> list[LoreItem]:
```

Rule list, IN ORDER, applied **per item — every failure DROPS that item only, never the batch, never the guide**:

1. **Structural** — empty `text` after strip; `\n`/`\r` in `text`, `source`, or `category`; `len(text) > 240`; markdown markers (same test as `course_intel_writer._has_markdown_markers`) → DROP.
2. **Category** — `category not in _LORE_CATEGORIES` → DROP.
3. **Injection scan** — `GUIDE_INJECTION_PATTERN` over `text` AND `source` → DROP. This also enforces **no URLs in `source`** (the pattern matches `https?://`/`www.`).
4. **Attribution REQUIRED** — `source` empty after strip, or `len(source) > 80` → DROP.
5. **Confidence gate** — `confidence != "high"` (exact string) → DROP.
6. **Geometry contradiction, type** — `allowed_types = {hz.type for hz in hazards}`; any `_HAZARD_PATTERNS` keyword in lowered `text` whose canonical type is NOT in `allowed_types` → DROP.
7. **Geometry contradiction, side/carry** — `_has_side_flip([item.text], hazards_by_type)` → DROP (reuses the full carry-aware machinery unchanged).
8. **Engine-number ban (THE HARD SAFETY RULE, validator layer)** — any `_CARRY_NUMBER_PATTERN` match with value in `[_MIN_PLAUSIBLE_CARRY, _MAX_PLAUSIBLE_CARRY]` (100–650) anywhere in `text` → DROP, **even when geometry-true**. Rationale: `_has_side_flip` only checks a number when a side word co-occurs (keep-if-true is leaky); a true distance drifts on remap; honest omission beats attributed yardage. Slope percentages (single digits) and tournament years (4-digit, blocked by `\b`+`(?!\d)`) can never match — "2024 U.S. Open pins on 2-4% slopes" survives, "lay back to 230" dies.
9. **Batch cap** — return the first `_MAX_LORE_ITEMS` (5) survivors, in writer order.

Log each drop at `log.info` with a reason token (`structural|category|injection|attribution|confidence|geometry-type|geometry-side|number-ban`).

---

## 4. PAYLOAD + BRAIN — `backend/app/caddie/strategy.py`

### 4.1 `build_strategy_payload` (:112-216)

After the read-time verdict gate (:176-184), inside the same `try`:

```python
        lore_items: list[LoreItem] = []
        if guide is not None and guide.local_lore:
            lore_items = validate_lore(
                guide.local_lore, intel.hazards if intel is not None else []
            )
```

Returned dict gets `"local_lore": [item.model_dump() for item in lore_items],` (and `"local_lore": []` in the `except` honest-empty branch). Imports extend the `guide_writer` import block with `validate_lore` and add `LoreItem` to the `types` import.

A guide dropped at :177-184 yields `local_knowledge == ""` **and** `local_lore == []` — lore never outlives its guide on a turn.

### 4.2 `format_lore_lines` (new, pure)

```python
def format_lore_lines(local_lore: list[dict]) -> list[str]:
    """One indented line per item, attribution always spoken: '  - {text} (per
    {source})'. [] in -> [] out."""
```

Takes payload-shaped dicts; whitespace-flattens each `text`/`source` defensively.

### 4.3 `format_strategy_ground_truth` (:219-377)

Append a new block AFTER the `PRIOR NOTES` block (end of the function):

```python
    local_lore = payload.get("local_lore") or []
    if local_lore:
        lines.append("")
        lines.append(
            "RESEARCHED LOCAL KNOWLEDGE (attributed, non-geometric — how this hole "
            "is known to play; NOT this shot's numbers. The engine data above always "
            "wins on any disagreement):"
        )
        lines.extend(format_lore_lines(local_lore))
```

### 4.4 `_strategy_system()` (:384-406) — ONE appended paragraph

Append after the "Output contract" paragraph (END of the f-string — preserves the entire existing prompt as a byte-identical prefix):

> RESEARCHED LOCAL KNOWLEDGE is attributed reference color — green character, named features, playing history, architect intent. When the golfer asks how the hole or green plays, you may weave in ONE such item, keeping its attribution natural ("the book says...", "per the Open notes..."). It never changes the club, the target, or any number: every yardage, carry, and club you speak still comes only from the engine data above. A number inside those notes (a slope percentage, a year) may be repeated as attributed context, never converted into a yardage, carry, or club call.

**Coordination note for the persona lane:** their adoption-pin test asserts `CADDIE_HOUSE_REGISTER in strategy._strategy_system()`; their insertion is ABOVE `{HAZARD_GROUNDING_RULE}`, mine is appended after the output contract — clean textual merge. `LORE_WRITER_SYSTEM` is new and NOT in their scan list; flag in the PR that it should adopt `CADDIE_HOUSE_REGISTER` + join `BANNED_REGISTER_LITERALS` scanning in whichever lane lands second.

`format_guide_line` untouched; **text-mouth lore is an explicit follow-up**.

---

## 5. BACKFILL — `backend/app/services/course_guides.py`

### 5.1 `_precompute_course_lore(course_id: str) -> None` (new)

Per course: `course_name = (course.get("name") or "").strip()`; no name → log + return. Per hole:
1. `green_props = _green_properties(h)`; `None` → skip.
2. `existing_guide = green_props.get("strategy_guide")`; `None` → skip (lore only appends to a hole that HAS a tactical guide).
3. `existing_guide.get("local_lore")` non-empty → skip (idempotent).
4. `green_props.get("lore_attempted_at") is not None` → skip — the NEW negative-cache marker, **distinct from `strategy_guide_attempted_at`**.
5. Write `{"lore_attempted_at": iso-now}` FIRST; on failure `continue`.
6. `result = await research_hole_lore(course_name, ...)`; exceptions → `log.warning` + `continue`.
7. `survivors = validate_lore(result.items, hazards)`; empty → `log.info` + `continue`.
8. **READ-MODIFY-WRITE (load-bearing):** `update_green_feature_properties` does a SHALLOW top-level JSONB `||` merge (courses_mapped.py:507), so `{"strategy_guide": {...}}` **REPLACES the entire guide object**. Therefore:

```python
merged = {
    **existing_guide,   # every tactical byte, verbatim
    "local_lore": [i.model_dump() for i in survivors],
    "lore_generated_at": result.generated_at,
    "lore_model": result.model,
    "lore_sources": list(result.sources),
}
await courses_mapped.update_green_feature_properties(
    course_id, hole_number, {"strategy_guide": merged}
)
```

Wrap the course loop in the same best-effort `try/except` as the tactical precompute.

### 5.2 `run_lore_backfill()` + env gates

Mirror `run_guide_backfill` (:183-201) with `_lore_backfill_course_ids()` reading **`LORE_BACKFILL_COURSES`** capped by **`LORE_BACKFILL_MAX_COURSES`** (default `1`). One course at a time. Docstring must state: **do not run concurrently with `run_guide_backfill` or `scripts/regen_rejected_guides.py`** — both write the whole `strategy_guide` object, so a concurrent tactical rewrite races the read-modify-write.

**Do NOT wire lore into `_precompute_course_guides` or any route/scheduler.** Prod execution is a separate owner-sanctioned op; lore fires only via the manual `run_lore_backfill()` runner. Optional `backend/scripts/backfill_lore.py` wrapper in the `regen_rejected_guides.py` style.

### 5.3 Cost estimate — all 12 mapped courses (216 holes)

Per hole (≤3 searches @ $10/1k; input ~15k-30k @ $3/1M; output ~1.5k-3k @ $15/1M): **~$0.10–$0.17/hole**. Per 18-hole course ≈ **$1.80–$2.60**. Full catalog 216 holes ≈ **$22–$31** (≤648 searches = $6.48). Default `LORE_BACKFILL_MAX_COURSES=1` → 12 deliberate invocations.

---

## 6. THE HARD SAFETY RULE — "no ungrounded numbers in the spoken layer"

Three deterministic layers plus one prompt layer:
1. **Writer prompt** (`LORE_WRITER_SYSTEM`): "never state a yardage, carry, or club" (soft layer, never relied on).
2. **`validate_lore` rules 7+8** (write-time in backfill AND read-time in `build_strategy_payload`): side-bound carry contradicting real runs drops (rule 7); no 100–650 distance-shaped number reaches the prompt at all (rule 8).
3. **`validate_strategy_text` backstop (unchanged)**: the SPOKEN reply is still scanned by `_HAZARD_PATTERNS` + carry-aware `_has_side_flip` + injection + verdict pin. A number-smuggling reply rejects → degrade to engine-only line.
4. **Honest residual gap**: a spoken bare number bound to NO hazard keyword ("land it 230") is not validator-checked today — pre-existing bar; lore does not widen it (no such number can enter the prompt from lore). Out of scope to close globally.

### 6.3 Why the session-reload / route read seams need no edit

`session.py:95-96` and `routes/caddie.py:1610-1613` re-run `validate_guide`, which returns the guide unchanged on pass, so `local_lore` rides through untouched (validate_guide never scans it). The **only surface that renders lore is `build_strategy_payload`**, which re-runs `validate_lore` per-item on every read. If text-mouth lore ships later, that seam must add its own read-time `validate_lore`.

---

## 7. Sequencing
1. types.py (`LoreItem` + guide fields).
2. guide_writer.py: `LORE_WRITER_SYSTEM`, `_LoreWriterOutput`/`LoreResearchResult`, `research_hole_lore`, `validate_lore` (+ constants).
3. strategy.py: payload gate + `format_lore_lines` + ground-truth block + `_strategy_system` paragraph.
4. course_guides.py: `_precompute_course_lore`, `run_lore_backfill`, env helpers.
5. frontend types.ts mirror (optional-field additive).
6. Tests, gates, offline acceptance run.

---

## 8. TESTS — exact new files (all offline; no network, no DB)

**A. `backend/tests/test_lore_writer.py`** — schema + validator + writer mechanics: back-compat (pre-lore blob validates with `local_lore == []`); `validate_lore` per rule with a surviving sibling proving per-item drop; false-front/turtleback/below-the-hole PASS on a zero-hazard hole; "2024 U.S. Open pins on 2-4% slopes" PASS; "carry the bunker at 240" DROP under rule 8; cap at 5; `research_hole_lore` with mocked `anthropic.AsyncAnthropic` (parses, stamps, pause_turn continuation, raises past `_MAX_CONTINUATIONS`, prompt contains course name + ground truth).

**B. `backend/tests/test_lore_backfill.py`** — mirrors `test_course_guides.py`'s `DATABASE_URL`-placeholder + `AsyncMock` pattern: marker written BEFORE research; research called with course NAME; write patch `{"strategy_guide": merged}` with `{k: merged[k] for k in original_guide} == original_guide` (tactical bytes byte-identical) plus lore fields; skips (no guide / existing lore / lore_attempted_at set / marker fails / no name); failure honesty; env gates (paths fully independent of guide backfill).

**C. `backend/tests/test_lore_consumption.py`** — payload/prompt/byte-identity: verdict-agreeing guide+lore → payload carries survivors; verdict-DISAGREEING → `local_lore == []` and `local_knowledge == ""`; session guide whose lore now contradicts hazards → dropped at read time while tactical survives; ground-truth labeled block after PRIOR NOTES with `(per {source})`; empty lore → no block, prior bytes unchanged; `format_guide_line(guide_with_lore) == format_guide_line(guide_without_lore)`; `validate_guide` never scans lore; `_strategy_system()` contains the lore paragraph + grounding constants + "80 words".

**D. `backend/tests/test_lore_acceptance_pinehurst.py`** — the offline acceptance (Pinehurst No. 2 hole 1 shaped): tactical guide + lore (turtleback/false-front high, "2024 U.S. Open pins on 2-4% slopes — safest play center below the hole" history high, "landing short is dead" high); geometry greenside bunker RIGHT. `validate_lore` keeps all three; "bunker left" dropped; medium-confidence dropped; unattributed dropped. Ground truth contains false-front/turtleback/below-the-hole under the attributed label. Synth-stub reply weaving lore + engine numbers → `validate_strategy_text` PASSES; a stub converting lore into an ungrounded hazard-bound number → REJECTED. Live tail `@pytest.mark.skipif(not ANTHROPIC_API_KEY)` real research shape smoke.

---

## 9. Gates (in order; all must pass)
1. `cd backend && ruff check .`
2. Existing suites green (byte-identity teeth): `pytest tests/test_guide_writer.py tests/test_course_guides.py tests/test_guide_consumption.py tests/test_guide_read_revalidation.py tests/test_guide_verdict_gate.py tests/test_regen_rejected_guides.py tests/eval/test_strategy_tool.py` (+ bethpage/red1 acceptance if present).
3. New suites: the four `test_lore_*.py`.
4. Full offline `pytest backend/tests`.
5. If types.ts touched: `cd frontend && npx tsc --noEmit && npm run lint`, plus `npx tsx voice-tests/runner.ts --smoke`.
6. Diff-level proof: `git diff` shows ZERO hunks inside `validate_guide`, `_has_side_flip`, `format_guide_line`, `WRITER_SYSTEM`, `research_hole_guide`, `validate_strategy_text`, `compose_degraded_line`, `_precompute_course_guides`, `run_guide_backfill`, session.py, routes/caddie.py — additions only. New-capability change → `/security-review` + `/code-review` before PR-ready.

## 10. Edge cases / risks (flagged)
- Frontend mirror is real (types.ts:103-147) — handled §1.3.
- Shallow JSONB merge replaces the whole guide — read-modify-write §5.1 mandatory; pinned by test B.
- Concurrent-writer race between lore backfill and tactical regen — ops sequencing rule in docstring; all writers manual.
- Pinehurst irony: "sandy waste areas" maps to `waste area` → `bunker` keyword; on a hole with no mapped bunker the item drops (rule 6) — honest fail-closed.
- Verdict-gate coupling: rec-error turn → lore silent that turn (accepted per spec).
- `GUIDE_INJECTION_PATTERN` breadth: lore containing literal "instructions"/"you are" drops — acceptable fail-closed.
- Persona-lane merge point: `_strategy_system` edited by both lanes at different positions — clean textual merge.
- Cache-key churn: first lore-bearing turn per hole misses the strategy cache — one extra synthesis per hole shape, by design.
