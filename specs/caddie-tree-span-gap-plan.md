# Caddie tree-span gap-preserving formatter (Bethpage Red P0)

Branch: `integration/next`. Owner P0: Bethpage Red tree distances "wrong off the tee."

## 0. Proven diagnosis — build on, do not re-litigate

The measurement layer is **proven correct** (independent geodesic per-vertex ground truth matches engine carries within ±5y on Red 1, 5, 6, including 64-83y dogleg deviations). The defect is representational only:

- `_extract_tree_line_hazards` (`backend/app/caddie/hazards.py:844`) + `_gap_bounded_tree_chain` (`hazards.py:807`) correctly emit a chain of REAL per-vertex tree entries that preserves real gaps.
- `format_hazards_line` (`hazards.py:927`, rendering at 946-965) then groups by `(type, line_side)` and renders `min-max`, collapsing the preserved gaps. Red 1 left carries `[30,65, 265,285,310,355,390,430,475,480]` render as `trees L 30-480y`, hiding the ~200y open drive zone (65→265y); the full line `trees R 5-475y, trees L 30-480y` exceeds the hole's 467y chord and the model narrates it verbatim.

**DO NOT TOUCH** (reviewer will diff-check `hazards.py`): `_xy_m`, `_project_onto_polyline`, `_tree_observations`, `_gap_bounded_tree_chain`, `_extract_tree_line_hazards` (carry math), `_derive_tee_green`, and all bend/corridor code. The fix is confined to `format_hazards_line`, one new constant + one new pure helper, `guide_writer._carry_runs`'s trees bridge, one eval-harness parser, two log lines, and tests/fixtures.

## 1. Gap-preserving representation

### 1a. New constant

In `hazards.py`, next to `_TREE_SPAN_MAX_GAP_YDS` (line 141):

```python
TREE_RUN_SPLIT_GAP_YDS: int = 120
```

Public (no underscore) because `guide_writer` imports it (§2b). Semantics: within one `(trees, side)` group, sorted carries whose consecutive delta is `> TREE_RUN_SPLIT_GAP_YDS` belong to separate rendered runs; delta `<= 120` merges (95 merges, 120 merges, 125 splits — carries are round-to-5, so deltas are multiples of 5).

### 1b. Why 120 (justification comment goes on the constant)

- **Only real gaps can split.** Inside a bridged chain section, consecutive chain entries are ≤ `_TREE_SPAN_MAX_GAP_YDS` (40y) apart by construction (`_gap_bounded_tree_chain` jumps to the farthest observation within 40y). Any inter-entry delta > 40y is therefore a REAL preserved mapped gap. So any threshold > 40 splits only at real gaps — the formatter split is anchored to the chain's own gap semantics, never to interpolation.
- **Exactly 40 over-fragments** (measured on the real deployed chains): Red 6 right deltas are 95/60/55 → four runs (`40y and 135y and 195-255y and 310y`) on a genuinely continuous tree line; Red 5 right delta 50 → two runs. Rejected.
- **The ground-truth gap distribution is bimodal** across Red 1/5/6: intra-line gaps (sparse mapping / small clearings) span 45-95y; genuine open zones are 200y (hole 1 left) and 300y (hole 1 right). `120 = 3 × _TREE_SPAN_MAX_GAP_YDS` sits between the populations with margin both ways: +25y above the largest observed continuous gap (95) and −80y below the smallest genuine open zone (200). It also stays ≥ one safety-cap doubling (`_TREE_CHAIN_SAFETY_CAP` rebuild at gap 80), so a doubled-gap chain cannot spuriously split.
- **Product framing:** an open window is only worth narrating separately when it is a usable full-shot landing zone (~120y+).
- **Not single-fixture calibrated:** any value in (95, 200) produces identical output on hole 1; the choice is pinned by the hole 5/6 continuity population plus the doubling bound, and synthetic boundary tests (§4c) exercise 120/125 independently of Red data.

### 1c. Formatter change (inside `format_hazards_line`, plus one helper)

Add a small module-level helper (mirrors `guide_writer._carry_runs` with a finite bridge):

```python
def _tree_runs(yards: list[int]) -> list[tuple[int, int]]:
    """Split SORTED carries into maximal runs; a new run starts where the
    delta to the previous carry exceeds TREE_RUN_SPLIT_GAP_YDS."""
```

In the render loop (current lines 958-965):
- **Non-trees groups: byte-for-byte unchanged** (single → `bunker L 245y`, multi → `water R 190-230y`). Bunker/water are single-centroid observations with no chain structure; Red 8/9 bunker groups also contain 135-185y gaps between *distinct* bunkers, but that is explicitly out of scope for this P0.
- **Trees groups:** compute `runs = _tree_runs(sorted(yards))`, apply §3 suppression, then render each run as `loy` (single) or `lo-hiy`, joined with `" and "` → `trees L 30-65y and 265-480y`.
- **Fallback:** if more than 3 runs survive, render today's full `min-max` span instead (honest superset — worst case degrades to exactly the current behavior, never a fragmented line). With threshold 120 no real Red hole exceeds 2 runs.
- **Group semantics unchanged:** grouping key stays `(type, line_side)`; `_FORMAT_GROUP_CAP` (6) still counts a split trees group ONCE; `_TYPE_ORDER` unchanged. Sort key stays `(type order, min carry)` but uses the min of the carries that actually render (post-suppression) so spoken order matches spoken numbers; identical to today whenever nothing is suppressed.

### 1d. Expected output on the proven data (deployed chains, verified in planning)

| Hole | Today | After (§1 only) | After (§1 + §3) |
|---|---|---|---|
| Red 1 | `trees R 5-475y, trees L 30-480y` | `trees R 5-85y and 385-475y, trees L 30-65y and 265-480y` | `trees L 265-480y, trees R 385-475y` |
| Red 5 | `trees R 105-170y` | unchanged | unchanged |
| Red 6 | `trees R 40-310y` | unchanged | unchanged |

## 2. Consumers stay consistent

**2a. The three caddie call-sites need zero changes** — `backend/app/caddie/tools.py:432` (`conditions_payload`), `backend/app/caddie/voice_prompts.py:370` (`_situation_block`), `backend/app/routes/caddie.py:764` (`_build_session_voice_prompt`) all render via the one shared `format_hazards_line`. No shape/type change (string only) → no frontend/shared-type change.

**2b. `guide_writer.py` — one real change.** `build_ground_truth_block` (lines 141-145) lists every chain entry's carry individually, so the writer's ground truth is already gap-faithful — no change. But the **validator** is stale: `_carry_runs` (line 444-472, used by `_side_and_carry_supported` line 508) bridges trees **unconditionally** (`bridge=None`), on the outdated comment (449-452) that trees emit "at most a near/far PAIR". Since the chain change that is false, and it makes the validator ACCEPT a guide claiming e.g. "trees at 150y left" on Red 1 — inside the proven open zone. Change: trees bridge becomes `TREE_RUN_SPLIT_GAP_YDS` (imported from `app.caddie.hazards`) instead of `None`; delete the `bridge=None` unconditional branch; update the stale docstrings (444-458, 481-501). Effect: fail-closed tightening — a tree-carry claim now needs to land within `_CARRY_TOLERANCE_YARDS` (25) of a real run. Read-time revalidation (`routes/caddie.py:1341-1342`) automatically drops previously persisted guides with open-zone tree carries — desired.

**2c. Eval harness parser.** `tests/eval/checks.py::context_hazards_match` (line 309) regex-matches only the FIRST `trees SIDE lo-hi` token, so a split line would false-fail an expected far-run carry. Change to `finditer` and accept if ANY matched range covers the expected carry ±15y. Current golden scenarios (`tests/eval/golden/caddie_advice.jsonl`) have per-side tree deltas ≤ 60y (no split), so behavior is unchanged today — this is future-proofing. `_HAZARD_TOKEN_RE` / `hazards_line_only_from_input` (line 266) is unaffected: the `" and 265-480y"` tail has no side letter, matched tokens remain a subset of input pairs.

## 3. Near-tee suppression (bounded product flag)

Even split correctly, `trees R 5-85y` (trees flanking/behind the tee box) reads as an absurd tee-shot hazard. Add:

```python
_TREE_NEAR_TEE_SUPPRESS_YDS: int = 100
```

Rule (inside the trees branch, after run-split, before rendering): drop the FIRST run iff **(a)** the side has ≥ 2 runs AND **(b)** that run's far end ≤ 100y. Guard (a) means no side ever silently loses all its tree information — suppression only fires when a farther, real tree section on the same side is still spoken (Red 6's single `40-310y` run is untouched). The entries themselves remain in `intel.hazards` and the `conditions_payload` hazards JSON — only the *spoken line* drops them.

**Recommendation: suppress, don't label.** A label ("trees at the tee") adds prompt surface the LLM parrots unpredictably; the falsehood is already fixed by §1, §3 only removes an absurd-but-true clause. **Product-judgment flags:** the exact 100y value and drop-vs-label are judgment calls — implement as specified, and if product later wants visibility, flip the drop to a label at this one site.

## 4. Regression fixtures pinned to ground truth

### 4a. Committed fixture — `backend/tests/fixtures/bethpage_red_trees.json`

Copy from the scratchpad dumps (`red_fc_dump.json` + `red_lines.json` in `/private/tmp/claude-501/-Users-justinlee-projects-scorecard/0ca2062e-4a3c-4950-9d68-177b486e17ce/scratchpad/`) — holes **1, 5, 6** (the tree-bearing holes; ~15KB total). Per hole:

- `tees`: list of tee Polygon geometries (`red_lines.json[hole]["tees"]`)
- `green_geom`: green Polygon (`red_lines.json[hole]["green_geom"]`)
- `hole_line`: played polyline coordinates (`red_lines.json[hole]["hole_line"]`)
- `tree_features`: `[{"ft": "tree"|"woods", "geom": {...}}, ...]` (`red_fc_dump.json[hole]["raw_trees"]`)
- `deployed`: `{"engine_line": ..., "tree_carries_by_side": {...}}` from `red_fc_dump.json[hole]["engine_hazards"]`/`engine_line`
- top-level `_provenance` string: stored Bethpage Red course data + deployed-engine output, 2026-07, geodesic ground-truth verified ±5y.

**Reconstruction recipe (verified during planning to reproduce the deployed engine bit-for-bit):** build a FeatureCollection with each tee geometry as `featureType: "tee"`, `green_geom` as `"green"`, `hole_line` as a `"hole"` LineString, each tree feature with `featureType` = its `ft`; call `extract_hole_hazards(fc)`. Verified reproduction: hole 1 R `[5,35,65,85,385,420,450,475]`, L `[30,65,265,285,310,355,390,430,475,480]`; hole 5 R `[105,155,170]`; hole 6 R `[40,135,195,225,255,310]` — identical to the deployed output. Do NOT reference the scratchpad at test time.

### 4b. New test file — `backend/tests/test_tree_span_gap.py`

1. **Carry invariance (chain untouched):** per hole, extracted tree `carry_yards` by side == fixture `deployed.tree_carries_by_side`, exactly.
2. **Hole 1 split:** `format_hazards_line(1, hazards) == "Hole 1 hazards: trees L 265-480y, trees R 385-475y"`; plus `"5-475" not in line` and `"30-480" not in line`.
3. **Hole 1 drive zone clear (the owner's complaint, asserted structurally):** parse every rendered tree range (regex over `" and "`-joined segments); assert no LEFT range intersects `[70, 260]` and no RIGHT range intersects `[90, 380]` — the proven open zones with 5y rounding margin. This is the "model-facing line no longer implies trees across the 65-265y drive zone" gate.
4. **Hole 6 continuity (anti-overfit anchor):** exact `"Hole 6 hazards: trees R 40-310y"` — 95/60/55y gaps merge; only-run never suppressed despite starting at 40y.
5. **Hole 5:** exact `"Hole 5 hazards: trees R 105-170y"` (50y gap merges).

### 4c. Synthetic unit tests (extend `TestFormatHazardsLine` in `test_hazards.py` + `test_tree_hazards.py`, NOT derived from Red)

- Boundary: consecutive deltas of exactly 120 merge; 125 splits.
- Non-trees never split: bunker group with a 150y internal gap still renders `min-max`.
- Group cap: a split trees group counts once toward `_FORMAT_GROUP_CAP` (extend the existing 7-group tests at `test_hazards.py:751` / `test_tree_hazards.py` T9).
- >3-runs fallback renders the full `min-max` span.
- Suppression: two runs with near far-end ≤100 → dropped; only-run ≤100 → kept; near far-end 105 → kept.
- **8-bearing invariant:** sweep `_BEARINGS` (`[0,45,...,315]`, existing idiom in both test files) with a two-stand fixture (stands at ~30-60y and ~280-320y left) asserting the identical split-and-suppressed string at every bearing.
- `guide_writer`: trees claim inside a >120y gap → guide rejected; claim within ±25y of a run end → accepted. Update the stale-comment test near `test_guide_writer.py:653`.

Existing tests verified compatible during planning (max per-side deltas ≤ 40y): `test_tree_hazards.py:372` (`trees C 180-220y`), `:407` (`trees R 200-260y`), `test_bethpage_validation.py:430` (bunkers only), `test_realtime_tools.py:114` (parity, self-consistent).

## 5. Payload observability

Two INFO log lines, `looper.caddie` logger, structured `extra` like `_log_caddie_usage` (`routes/caddie.py:89`), each wrapped in the same never-raise try/except. Numbers and course geometry only — no user GPS, no PII, no keys; greppable from journalctl by event name.

- **Site A — intel build (the session-start path):** in `/course-intel`'s hole loop, immediately after `intel.hazards = extract_hole_hazards(...)` (`routes/caddie.py:1311-1315`):
  `log.info("hole_hazards_intel", extra={"hole": intel.hole_number, "hazards_line": format_hazards_line(intel.hole_number, intel.hazards), "n_hazards": len(intel.hazards), "tee_lat": ..., "tee_lng": ...})` — tee anchor = the same `hc.get("tee")` point passed to the extractor.
- **Site B — recommendation:** in `session_recommend` (`routes/caddie.py:611` path), once the recommendation exists:
  `log.info("caddie_reco_context", extra={"hole": ..., "hazards_line": ..., "to_green_yards": tsn.to_green_yards, "drive_total_yards": tsn.drive_total_yards})` (`tsn = rec.tee_shot_numbers`, fields `None` when absent).

That covers hole / hazards line / tee anchor / drive advance; the next field report is diagnosable without a repro rig. Do not add logging inside the pure modules (`hazards.py`, `voice_prompts.py`).

## 6. Gates

```
cd backend && ruff check .
cd backend && python -m pytest tests/test_hazards.py tests/test_tree_hazards.py tests/test_tree_span_gap.py tests/test_guide_writer.py tests/eval/test_harness_has_teeth.py tests/eval/test_golden_tier1.py -q
```

DB-backed tests (`tests/integration/`) and the full suite run in CI. Must-stay-green invariants: the 8-bearing sweeps in `test_hazards.py`/`test_tree_hazards.py`, all existing tree gate tests (T1-T12 + Finding B), and the §0 do-not-touch diff check on `hazards.py`.
