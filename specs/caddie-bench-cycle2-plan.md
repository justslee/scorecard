# Caddie Bench — Iteration Cycle 2 implementation contract

Base: `integration/next` @ `b1d42ba`. Builder implements EXACTLY this; deviations get a
commit-message note (cycle-1 precedent: the `EnRouteFromPlayer.suppressed` deviation).

Cycle-1 (approach-shot engine, landed @8f55f70/da1c25e+a8633f3) fixed most dimensions but
regressed three on the 136-case failing subset (run 20260722-145448 baseline vs
20260723-170704): numbers_coherence flat (27->30), wind flat (35->38), DEGRADED rate
8.1%->19.9% (11->27), wrong_numbers 66->71, vague 5->13, det numbers_close 87->78.

Two verified root causes; two scoped fixes. No judge changes. No physics-constant changes.

## 0. Invariants (non-negotiable)

- **Tee-parity pins**: every existing test stays green with BYTE-IDENTICAL default-path
  output — the 752 tee-parity pins from cycle 1 (offset < 25 / `from_distance_yards=None`
  paths) plus the full non-DB suite (`pytest tests/ -q --deselect
  tests/test_green_slope_ingest.py`, ~3178 passing at base; the green_slope_ingest flake is
  pre-existing and out of scope).
- **Judge untouched**: `backend/tests/eval/caddie_bench/judge.py` rubric text
  (WIND_AWARENESS at judge.py:59 is FAIR) is not edited. No rubric weakening anywhere.
- **Honest-empty discipline** ([[no-fake-data-fallbacks]]): every new line/field is omitted
  outright when its source is None/empty — never a placeholder, never a guessed bearing,
  never invented wind.
- **The from-you reframe is PURE GEOMETRY** (harness.py:222-235 comment): keyed off
  `tee_offset >= APPROACH_FRAME_MIN_TEE_OFFSET_YDS` (aim_point.py:561, = 25), NEVER off
  `shot_kind`. Positioning turns reframe too.
- **Gate discipline**: all work verified with the OFFLINE gates in §6. The live bench
  re-run (on-box, `CADDIE_EVAL_LIVE=1` + `OPENAI_API_KEY` + `GOOGLE_MAPS_KEY`, vs baseline
  `20260722-145448` / cycle-1 `20260723-170704`) is eng-lead/owner-gated — the builder never
  runs it (caddie-bench-plan.md gate rules; run_caddie_bench.py:339 refuses without env).

## 1. Fix A — `hazards_line` from-you reframe (deferred "nit 1", strategy.py:324-341)

The degrade-spike mechanism: on approach/positioning turns the ground truth shows the SAME
bunker at TWO numbers — tee-anchored `hazards_line` ("bunker C 495y", strategy.py:342) above
the from-you CARRIES section ("about 160y from you", strategy.py:356-368). The model
sometimes speaks the tee number; validation rejects; `run_strategy_turn`
(strategy_turn.py:207-218 at base; same shape at b1d42ba) falls back to
`compose_degraded_line`'s mechanical list. Fix: ONE frame.

### 1.1 `conditions_payload` — mirror `carries_payload`'s gate EXACTLY (tools.py:491)

New signature: `conditions_payload(session, hole_number=None, *, from_distance_yards:
Optional[int] = None)`. Default `None` -> byte-identical dict (same keys, same values) for
every existing caller. Gate, copied verbatim from `carries_payload` (tools.py:678-683):

    approach_framed = False
    offset = 0
    if from_distance_yards is not None and intel is not None and intel.yards is not None:
        offset = max(0, intel.yards - from_distance_yards)
        approach_framed = offset >= APPROACH_FRAME_MIN_TEE_OFFSET_YDS

When `approach_framed` (and `intel.hazards` non-empty):
- Build a transformed hazard list IN tools.py (keeps all gate/suppression/rounding logic
  side-by-side with carries_payload in one file): for each `hz` in `intel.hazards`,
  `raw_from_you = hz.carry_yards - offset`; DROP if `raw_from_you <
  EN_ROUTE_CLEARED_SUPPRESS_YDS` (raw comparison BEFORE rounding — carries_payload:687
  parity, NOT aim_point's `from_here()` rounded-then-compared variant; see §4 note); else
  `hz.model_copy(update={"carry_yards": round(raw_from_you / 5) * 5})` — the EXACT
  expression at carries_payload:689 so the same hazard renders the same number in both
  ground-truth sections.
- `hazards_line = format_hazards_line(hn, transformed, from_you=True)` ("" when all
  suppressed).
- Add key `"hazards_line_frame": "from_you"` to the returned dict ONLY in this branch
  (key-presence signaling, mirroring `carry_from_you_yards` — the default-path dict shape
  is untouched, so `/session/conditions` and `resolve_tool("get_conditions")` responses
  stay byte-identical).
- The `"hazards"` list (raw `Hazard.model_dump()`s) stays TEE-ANCHORED always — the
  validators (`validate_strategy_text`, `check_numbers_close`, `_has_side_flip`) and the
  bench derive frames from raw carries + offset themselves.

### 1.2 `format_hazards_line` — prefix-only keyword (hazards.py:994)

New signature: `format_hazards_line(hole_number, hazards, *, from_you: bool = False)`.
`from_you=False` -> byte-for-byte today's output (no code path change). `from_you=True`
changes ONLY the prefix: `f"Hole {hole_number} hazards from you: ..."`. All
grouping/min-max spans/tree-run splitting/`_TREE_NEAR_TEE_SUPPRESS_YDS`/`_FORMAT_GROUP_CAP`
logic runs unchanged on the (already-transformed) list — near-tee suppression becomes
near-player suppression in the new frame, which is the desired semantics. No import of
aim_point constants into hazards.py (avoids an import cycle — the offset math lives in
tools.py per §1.1).

### 1.3 Opt-in + single-frame render (strategy.py)

- `build_strategy_payload` (strategy.py:203): `conditions_payload(session, hole_number,
  from_distance_yards=resolved_yards)` — the SAME `resolved_yards` already fed to
  `carries_payload` at strategy.py:209, so conditions and carries can never disagree about
  the frame (identical gate + identical input by construction).
- `format_strategy_ground_truth` (strategy.py:323-342): delete the KNOWN-LIMITATION comment
  block; render three-way:
  - no `hazards_line_frame` key (tee turn): today's bytes exactly —
    `f"  {hazards_line} — the COMPLETE list — there are NO others."` /
    `"  Hazards: NONE mapped. Do not name any specific hazard."` (pinned by
    `check_ground_truth_block_complete`, checks.py:368-373, and test_strategy_tool.py:111/119).
  - `frame == "from_you"` and line non-empty:
    `f"  {hazards_line} — the COMPLETE list between you and the green — there are NO others."`
  - `frame == "from_you"` and line == "" (all mapped hazards suppressed/behind):
    `"  Hazards: every mapped hazard is behind you — nothing between you and the green."`
    (a TRUE statement — never the false "NONE mapped").
- **Dual-rendering decision (KEEP BOTH sections, do not drop hazards_line)**: once both are
  from-you framed they state the SAME rounded numbers, so parroting either passes; the
  hazards_line contributes the sides/types/complete-list pin (the anti-hallucination
  contract `check_ground_truth_block_complete` and HAZARD_GROUNDING_RULE lean on), CARRIES
  contributes per-club clearance. Dropping hazards_line would orphan the COMPLETE-list pin
  and change the hazard-grounding contract for zero benefit now that frames agree. The
  mechanical-readout problem is the DEGRADED line's, fixed in §1.5 — not the ground truth's.
  Capping is already handled by `_FORMAT_GROUP_CAP` (6) + tree-run collapse.

### 1.4 Consumer audit — every `format_hazards_line`/`conditions_payload` caller, pinned

| Caller | Change | Why byte-identical |
|---|---|---|
| `tools.resolve_tool` "get_conditions" (tools.py:1044-1045) | none | never passes `from_distance_yards` (realtime tool has no live player distance — same by-design rationale as `get_carries`, tools.py:655-657) |
| `routes/caddie.py:513-523` `/session/conditions` | none | positional call unchanged |
| `routes/caddie.py:127,136-139` intel logging | none | direct `format_hazards_line(...)`, no new kwarg |
| `routes/caddie.py:727-730` reco logging (`_log_caddie_reco_context`) | none | ditto — logs stay tee-framed deliberately (log-grep continuity) |
| `tests/eval/checks.py:209-212` `build_tier1_context` | none | direct call, default `from_you=False`; all golden tier-1 scenarios are tee turns |
| `checks.py` `check_hazards_line_only_from_input` / `_empty_when_no_hazards` / `context_hazards_match` / `check_carries_tool_matches_hazards` (:270-347, :390-417) | none | operate on the tee-framed ctx line / `carries_payload(session, n)` default path |
| `strategy_turn.run_strategy_turn` numbers echo (:170) | value change only on framed turns | `numbers["hazards_line"]` becomes the from-you line — truthful; shape (`dict`) unchanged; frontend `SessionStrategy.numbers` is `Record<string, unknown>` (caddie/api.ts:258) |
| `test_hazards.py` / `test_tree_hazards.py` / `test_tree_span_gap.py` / `test_bethpage_validation.py` / `test_red1_acceptance.py` / `test_harness_has_teeth.py` pins | none | all call the default path |

### 1.5 `compose_degraded_line` quality (strategy_turn.py, hazard clause at :95-110 @b1d42ba)

The "bunker right about 115 from you, bunker right about 130 from you, ..." readout in every
new-degrade transcript. Two bounded changes, both composed from fields (never prose):
- **Cap at the 3 NEAREST entries** (list is already sorted ascending by raw carry from
  `carries_payload`): `hz = hz[:3]`. <=3 hazards -> byte-identical.
- **Dedupe (type, side) pairs** before the cap (keep the nearest of each pair) so the clause
  never repeats "bunker right ... bunker right ...".
Existing phrasing per entry is kept (`about {carry_from_you_yards} from you` /
`at {carry_yards}`). Update the two full-string pins
`test_compose_degraded_line_red_6_...`/`test_compose_degraded_line_augusta_12_...`
(test_strategy_tool.py:749/781) only if their fixtures exceed the cap/dedupe (audit first);
add a new >3-hazards cap test and a dedupe test.

## 2. Fix B — wind relative to the shot

`plays_like` (elevation-only, `intel.effective_yards`) is zero-signal for crosswind, and the
CONDITIONS render (strategy.py:310-314) hands the model raw compass ("wind 15mph from 210
degrees") to do trig against a bearing it is never shown. Additionally — discovered during
planning, flag for eng-lead — the live strategy path's OWN solve never sees the shot
bearing: `build_strategy_payload` (strategy.py:162-169) calls `recommend_payload` WITHOUT
`shot_bearing`, so `compute_adjustments`/physics decompose wind against bearing 0.0 (due
north), while the bench's `engine_ref` (harness.py run_case) solves with the TRUE
`resolved.shot_bearing_deg`. On a windy non-north hole the live solve and the det-check
oracle structurally disagree (club/target mismatch -> wrong_numbers). Fix both with one
threading.

### 2.1 Pure helper — `physics.relative_wind` (backend/app/caddie/physics.py, next to `conditions_from_weather` :613)

Reuses the EXISTING convention (physics.py:652-654), never a fork:

    class RelativeWind(NamedTuple):
        speed_mph: float
        head_mph: float    # +into / -helping  (speed*cos(rel))
        cross_mph: float   # +from the RIGHT of the shot line (speed*sin(rel))
        bucket: str        # "head" | "tail" | "cross_right" | "cross_left"
        spoken: str        # one phrase, composed here so ground truth + degraded line share it

    def relative_wind(weather, shot_bearing_deg: float) -> Optional[RelativeWind]:

- `None` when `weather is None` or `wind_speed_mph < 3` (mirrors
  `compute_adjustments`'s `has_weather_effect` gate, club_selection.py:227) — calm says
  NOTHING new.
- `rel = ((wind_direction - shot_bearing_deg) % 360)`, normalized to (-180, 180].
  Buckets on 45° boundaries: `|rel| < 45` -> head; `|rel| > 135` -> tail; else
  `cross_right` when `rel > 0` (wind FROM the right, pushes ball LEFT), `cross_left`
  otherwise. Pin the convention with the bench presets: CROSS_15
  (`wind_direction = shot_bearing + 90`, harness.py:63) MUST bucket `cross_right`;
  INTO_20 MUST bucket `head`.
- `spoken` (exact strings, pinned in tests; the number is ALWAYS immediately followed by
  "mph" — load-bearing for §3.2):
  - head: `f"{mph:.0f} mph headwind — into you"`
  - tail: `f"{mph:.0f} mph tailwind — helping"`
  - cross_right: `f"{mph:.0f} mph crosswind off the right — pushes it left"`
  - cross_left: `f"{mph:.0f} mph crosswind off the left — pushes it right"`

### 2.2 Bearing threading (the payload gap)

- `run_strategy_turn(..., *, shot_bearing_deg: Optional[float] = None)`
  (strategy_turn.py:117) — pass through to `build_strategy_payload`.
- `build_strategy_payload(..., *, shot_bearing_deg: Optional[float] = None)`: resolve
  `bearing_used = shot_bearing_deg if shot_bearing_deg is not None else
  intel.approach_bearing_deg if intel is not None else None` (types.py:208 — the tee->green
  compass bearing computed at intel time; honest None on unmapped holes).
  - When `bearing_used is not None`: pass `shot_bearing=bearing_used` to
    `recommend_payload` (tools.py:339 already accepts it). When None: OMIT the kwarg —
    byte-identical solves for every existing fixture (none set `approach_bearing_deg`, so
    all current tests keep the 0.0 default).
  - Add top-level payload key `"wind_relative": relative_wind(session.weather,
    bearing_used)._asdict() if both present else None` — computed once here; the shared
    `conditions_payload` is NOT touched for wind.
- Bench harness `run_case` (harness.py:~430): pass
  `shot_bearing_deg=resolved.shot_bearing_deg` into `run_strategy_turn` — the live-path
  solve and `engine_ref` (generate_recommendation with the same bearing, harness.py:409)
  now agree BY CONSTRUCTION; `club_matches_engine`/`check_numbers_close` stop comparing
  two different physics solves on windy cases.
- Routes: NO request-shape change this cycle. `/session/strategy` and the ADVICE
  interception (routes/caddie.py:777, 1063, 1261) rely on the `intel.approach_bearing_deg`
  fallback — correct for tee turns, approximate (tee->green vs player->green) mid-hole;
  acceptable and honest (a live GPS bearing doesn't reach the server today). Note this in a
  code comment at the `run_strategy_turn` kwarg.

### 2.3 Ground-truth render (strategy.py CONDITIONS block, :308-321)

- Keep the existing Weather line byte-identical (ADD, never replace).
- After it, when `payload["wind_relative"]` is non-None, append:
  `f"  Wind for this shot: {spoken}. State how it shapes the club, target, or aim."`
  (embedded-directive pattern, same as "SPEAK THIS NUMBER" / "the COMPLETE list").
- Omit entirely when None (calm / no weather / no bearing) — the judge's WIND_AWARENESS
  trivially passes CALM, and we never fabricate a frame we can't compute.
- Cache note: ground-truth bytes change on windy/framed turns -> `cache_key` naturally
  invalidates; no cache code changes.

### 2.4 Degraded line (strategy_turn.py `compose_degraded_line`)

New optional param `wind_relative: Optional[dict] = None` (default -> byte-identical; both
call sites in `run_strategy_turn` pass `payload.get("wind_relative")`). When present,
append clause `f" Wind: {spoken}."` after the hazard clause. Degraded answers currently
auto-fail WIND_AWARENESS with zero wind language; this is a fields-only, honest clause.

## 3. Validators / teeth (extend, never weaken)

### 3.1 `check_numbers_close` (harness.py:215-292) — no semantic change needed; verify

The cycle-1 frame machinery already does the right thing once the ground truth is
single-frame: from-you numbers are learned via `known.add(from_here)` +
`known.add(round(from_here/5)*5)` (harness.py:250-253 — matches §1.1's rounding exactly),
en-route-cleared (<20 raw) numbers are never learned (nit-3 block), and `strict_removal`
REDs tee-frame parroting on approach turns while positioning turns keep both frames
(pinned: test_bench_teeth.py:125-186 — decade_advice still legitimately speaks tee-frame
carries on positioning turns; untouched). Add one new teeth pair:
- from-you HAZARDS-LINE number parroting passes: an answer speaking the §1.1
  rounded from-you span numbers on an approach turn is GREEN;
- and an end-to-end pin in `test_approach_frame.py`: for an approach-framed
  `build_strategy_payload`, the hazards_line number for hazard X == the CARRIES
  `carry_from_you_yards` for hazard X (rounding parity across the two sections).

### 3.2 `_YARDAGE_RE` mph guard (tests/eval/substance.py:72-77)

`\b(\d{2,3})\b(?!%)` extracts "15 mph" as yardage 15 -> a wind-aware answer (the whole
point of Fix B) can false-RED `check_numbers_close` (tolerance 5; presets 15/20 mph rarely
near an engine number). Extend the lookahead: `(?!%)(?!\s*mph\b)`. Shared surface with the
golden consistency probes — audit `test_substance_teeth.py` for pins on mph-bearing text
(none expected) and add a teeth test: "needs 160, wind is 15 mph" extracts `(160,)` only.
This is exactly the "3-digit wind heading" false-positive class the README already flags.

### 3.3 Runtime `validate_strategy_text` (strategy.py:666) — scoped tee-frame reject (OPTIONAL, flag to eng-lead)

Root-cause removal (§1) means the model no longer SEES a tee-frame number to parrot, so the
live reject rate should collapse without new validator surface. If eng-lead wants the live
path teeth-symmetric with the bench: add, inside the existing
`recommendation is not None and not recommendation.get("error")` block, an approach-only
check mirroring `strict_removal` — reject when `recommendation["shot_kind"] == "approach"`,
the turn is approach-framed (derive offset from `recommendation` raw_yards + a new optional
`hole_yards` kwarg, default None = today's bytes), and the flattened text contains a raw
`carry_yards` (word-boundary) of a reframed en-route hazard. Default-off signature keeps
every existing `validate_strategy_text` test byte-identical. RECOMMENDATION: defer unless
cycle-2 measurement still shows live tee-frame parroting — a new reject class is a new
degrade source, the exact regression this cycle fixes.

### 3.4 Bench fixtures

- `fixtures/canned/synth_answers.json`: audit every ADVICE canned answer used by
  `test_harness_end_to_end_offline_produces_a_sample_report` and the teeth suite; any
  approach-positioned canned answer speaking tee-frame hazard carries must be updated to
  the from-you number (they are meant to represent a HEALTHY synth; det-check expectations
  in the offline report assertions updated coherently). `judge_verdicts.json`: unchanged
  (canned scores, frame-agnostic). `questions_v1.jsonl`, hole fixtures, `bags.json`:
  untouched.
- Golden set (`tests/eval/golden/caddie_advice.jsonl`): untouched — all tier-1 scenarios
  are tee turns; `check_hazards_line_*` / `check_context_hazards_match` /
  `check_carries_tool_matches_hazards` semantics unchanged (§1.4).

## 4. Edge cases (must be covered by tests)

1. **No intel / honest-empty**: `conditions_payload(..., from_distance_yards=180)` on a
   hole with `intel is None` or `intel.yards is None` -> tee-frame output, no crash, no
   frame key. Zero-hazard hole -> `hazards_line=None` regardless of framing (existing
   honest-empty), never the "behind you" line.
2. **Offset boundary**: offset 24 -> byte-identical tee line (no frame key); offset 25 ->
   framed. Same boundary as carries (APPROACH_FRAME_MIN_TEE_OFFSET_YDS pins in
   test_approach_frame.py).
3. **GPS beyond the card** (`from_distance_yards > intel.yards`): `max(0, ...)` clamps to
   offset 0 -> tee frame (mirrors carries_payload:681).
4. **Suppression parity**: hazard with `raw_from_you = 19` dropped from BOTH hazards_line
   and carries; `raw_from_you = 20` kept in both, rendered `20y`/`carry_from_you_yards=20`.
   NOTE the known divergence: `EnRouteFromPlayer.from_here` (aim_point.py:200-207) compares
   the ROUNDED value (raw 18 -> rounds to 20 -> kept) while carries_payload compares RAW.
   Mirror carries_payload (raw). Do NOT touch aim_point this cycle (pinned tests); leave a
   one-line comment noting the 17.5-19.9y boundary divergence as a known nit.
5. **Rounding parity**: `round(raw/5)*5` exactly (banker's rounding included) in both
   sections — one expression, pinned by the §3.1 end-to-end parity test.
6. **All hazards suppressed**: hazards_line "" + frame key -> the "every mapped hazard is
   behind you" render — and carries may simultaneously be empty (`approach_framed_carries`
   False at strategy.py:352); the conditions frame key is the render signal, not carries.
7. **Positioning vs approach**: reframe fires on positioning turns too (pure geometry);
   `check_numbers_close` keeps accepting BOTH frames there
   (test_bench_teeth.py:174-186 stays green); residual: decade landing/cross-hazard
   RECOMMENDATION lines still speak tee-frame numbers on positioning turns — known,
   accepted, validator-covered.
8. **Wind honest-empty**: weather None / wind < 3 mph / bearing None -> no
   "Wind for this shot" line, no degraded wind clause, `wind_relative is None`, ground
   truth byte-identical to today for those turns.
9. **Bucket boundaries**: rel = 45 / -45 / 135 / -135 assigned deterministically (spec:
   45 -> cross, 135 -> tail; pin exact choices in test_physics.py) and the two preset pins
   (INTO_20 -> head, CROSS_15 -> cross_right).
10. **Degraded list quality**: >3 carries -> nearest 3; duplicate (type, side) deduped;
    <=3 unique -> byte-identical.

## 5. Test plan (new/updated, by file)

- `backend/tests/test_hazards.py`: `from_you=True` prefix; default byte-identical
  (re-assert one existing pinned line with the kwarg omitted vs `from_you=False`).
- `backend/tests/test_approach_frame.py` (cycle-1 file): conditions_payload gate matrix
  (edge cases 1-6), hazards_line<->carries number parity, all-suppressed render,
  tee-turn byte-identity of the full ground truth (extend
  `test_ground_truth_tee_turn_byte_identical_no_carries_from_you_frame`'s sibling).
- `backend/tests/test_physics.py`: `relative_wind` buckets/boundaries/None-gates/spoken
  strings + preset pins.
- `backend/tests/eval/test_strategy_tool.py`: single-frame approach render; "Wind for this
  shot" line present iff wind_relative; Weather line unchanged; degraded-line cap/dedupe/
  wind-clause tests; existing compose pins updated only if fixture-affected.
- `backend/tests/eval/caddie_bench/test_bench_teeth.py`: §3.1 new pair; mph-guard tooth.
- `backend/tests/eval/test_substance_teeth.py`: mph lookahead tooth.
- `backend/tests/eval/caddie_bench/test_bench_offline.py`: end-to-end offline report still
  builds; add a pin that `run_case` threads `resolved.shot_bearing_deg` into the live-path
  solve (e.g. monkeypatch-spy on `run_strategy_turn` kwargs, or assert ground truth of an
  INTO_20 case contains "headwind — into you").

## 6. Gates + sequencing

Commit order (one feature per commit, gates after each):
1. `physics.relative_wind` + tests (pure, zero consumers).
2. Bearing threading + wind render + degraded wind clause + harness bearing pass-through
   + substance mph guard (+ teeth).
3. hazards_line reframe (tools.py / hazards.py / strategy.py / strategy_turn.py) + tests.
4. Bench fixtures audit + degraded-line cap/dedupe + any teeth additions.

Gates (ALL must pass before handoff; show output):
- `cd backend && ruff check .`
- `cd backend && python -m pytest tests/ -q --deselect tests/test_green_slope_ingest.py`
  (includes: tests/eval/caddie_bench/test_bench_offline.py, test_bench_teeth.py,
  test_render_projection.py; tests/eval/test_golden_tier1.py, test_harness_has_teeth.py,
  test_tool_parity.py, test_strategy_tool.py, test_substance_teeth.py;
  tests/test_hazards.py, test_approach_frame.py, test_tree_*.py, test_bethpage_validation.py)
- `cd frontend && npx tsc --noEmit` and `npx tsx voice-tests/runner.ts --smoke`
  (no frontend source change expected — confirm unaffected).
- NO live bench run. The on-box re-run vs `20260722-145448` / `20260723-170704` is
  eng-lead's, owner-gated.

## 7. Shared-shape sync (`frontend/src/lib/types.ts` <-> `backend/app/models.py`)

NO shared shape changes. `SessionStrategyResponse.numbers` is an untyped `dict`
(routes/caddie.py:754 / `Record<string, unknown>` in caddie/api.ts:263) — value-only
changes. `/session/conditions` never opts into the frame key, so `SessionConditions`
(caddie/api.ts:277+) is byte-compatible. No `models.py` edits. State this in the PR body.

## 8. Judgment calls / risks (eng-lead sign-off)

1. **§2.2 recommend_payload bearing threading** changes live engine solves (club/plays-like)
   on windy mapped holes — a correctness fix (the 0.0-bearing decomposition is wrong), but
   it moves numbers the owner may notice; calm turns and every existing fixture are
   byte-identical by the omit-when-None rule. ENG-LEAD DECISION: IN SCOPE — the bench oracle
   already uses the true bearing, so this is required for live/bench parity and is a genuine
   correctness fix. Builder MUST keep the omit-when-None rule so every existing fixture is
   byte-identical.
2. **§1.3 keep-both-frames decision** (vs dropping hazards_line on framed turns) — chosen
   to preserve the COMPLETE-list anti-hallucination pin. APPROVED.
3. **§3.3 runtime tee-frame reject** — DEFERRED per recommendation (a new reject class is a
   new degrade source; do NOT add it this cycle).
4. **§3.2 mph lookahead** touches the golden consistency extractor (shared surface) — keep
   the change to the lookahead only; add the teeth test.
5. **Mid-hole bearing approximation** (tee->green fallback vs true player->green) can
   mis-bucket wind near 45°/135° on sharp doglegs in PROD only (bench passes the true
   bearing); honest and bounded — acceptable.
