# Caddie Bench Cycle 1 — verified diagnosis (approach-shot solve)

Source: prod-box run `20260722-145448` (150 cases, gpt-5.6-sol synth+judge).
Headline: **53.4% weighted correctness; owner-crux 51.8%.** Pareto dominated by
`wrong_numbers` on NON-TEE lies. This diagnosis is grounded in the actual `engine_ref`
oracle solves + judge reasons pulled from `results.jsonl` (not the report summary alone).

## The hypothesis was PARTLY right — refined by evidence
The task hypothesis was "mid-hole shots get a thin payload → the brain improvises numbers."
The evidence shows the payload is NOT thin — the engine DOES produce an approach solve
(`shot_kind="approach"`, club, target_yards, raw_yards, miss_side, reasoning). The
confabulation originates **inside the engine's approach path**; the brain faithfully parrots
the engine's own bad numbers. Three distinct engine defects, in priority order:

### DEFECT 1 (dominant, ~all `wrong_numbers`) — tee-frame hazard carry spoken as a from-here carry
`aim_point.py:1263` (green-light reachable approach branch) speaks:
`"{noun} at {governing.carry_yards} between you and the green — take enough club to carry it"`.
`governing.carry_yards` comes from `en_route_carry_hazards(hole.hazards, hole.yards, distance_yards)`
+ `_governing_center_carry` — and `carry_yards` is **tee-anchored** (distance from the TEE),
NOT from the player's current lie. Evidence (oracle reasoning verbatim):
- Black 4 approach, player **182y** from green (par-5 ~517y): oracle says *"Bunker at **495**
  between you and the green."* 495 is the bunker's tee-distance. Player tee_offset ~= 517-182 = 335,
  so the real from-here carry ~= 495-335 = **~160y**. Engine emitted 495 -> brain said "carry the
  center bunker at 495" on a 182y shot. Judge: numbers_coherence 0.
- Black 5 (166y out): oracle *"Bunker at **455** between you and the green"* -> from-here ~= 455-(hole-166).
- Pebble 3 (179y out, par-4 ~404y): oracle *"Bunker at **230** between you and the green"* -> tee_offset ~= 225,
  from-here carry ~= **5y** — the hazard is essentially at/behind the player; the line should not fire at all.

**Fix:** in the "between you and the green" line, speak the **player-relative** carry
(`carry_yards - tee_offset`, tee_offset = max(0, hole.yards - distance_yards)), and SUPPRESS
the line when the player-relative carry is trivially small (hazard already effectively cleared,
within GPS jitter). Aim/description text (`compute_aim_point` green-light arm ~478-505) must use
the same corrected number so aim line and reasoning agree. This is the single highest-value fix —
it moves numbers_coherence (30%), the numbers_close det-check (67%), and most of the `wrong_numbers`
Pareto.

### DEFECT 2 (miss_side_evidence 33%) — miss side has no per-side EVIDENCE in its mouth
`compute_miss_side` (aim_point.py:257) DOES read per-side greenside hazards
(`h.distance_from_green <= 20`, side classification) and picks the correct side — but its
`description` is generic ("Miss short — safe side, easy recovery"); it never NAMES the per-side
hazard that drove the pick. So the brain says "favor right" with no "because the bunker guards
the left," and the judge (correctly) fails miss_side_evidence.
**Fix:** enrich `MissSide.description`/reasoning with the per-side hazard evidence that drove the
pick (side + carry), mirroring the drive-zone per-side evidence discipline. Same evidence should
seed hazard_awareness (37%) for the approach.

### DEFECT 3 (wind_awareness 38%) — plays-like computed but not spoken; magnitude suspect
For genuine into-wind (Pebble 3: 20mph -> oracle "wind adds **+63y**", plays 242) the plays-like IS
in the payload but the brain spoke raw 154 (wind never reached the mouth). Separately, +63y on a
179y shot (~35%) looks over-modeled vs the ~1%/mph rule (~+36y). Wind lives in `physics.py`/adjustments,
SHARED with tee shots — treat magnitude as a flagged candidate to verify, do NOT casually retune (tee
parity risk). The safe in-scope fix: make the approach payload/narrative BIND to the existing
plays-like so wind visibly shapes the spoken number.

## MEASUREMENT CONFOUND — the judge conflates approach with positioning (do NOT ignore)
`judge.py:44` (SHOT_REACHABILITY rubric) + `judge.py:84` (`_format_engine_ref`) tie the dimension to
`shot_kind=positioning` and print "(positioning = out of reach; the flag is NOT the aim target)".
Our smoking-gun cases are `shot_kind="approach"` and went through the **reachable** aim branch
("Aim at the flag"), yet the judge repeatedly asserts *"under the reference's positioning designation,
improperly aims at the flag"* and scores shot_reachability=0 (33.8% overall) on correctly-reachable
approaches. The judge is HALLUCINATING a positioning designation the reference never made -> two
2x-weighted dims (shot_reachability, miss_side) are artificially depressed.
**Implication for the plan:** a judge-clarity fix (make the reference block state explicitly
"shot_kind=approach -> green IS reachable, aiming at the flag is CORRECT" vs positioning) is legitimate
MEASUREMENT correctness, distinct from caddie prompt-padding. BUT changing the judge changes the
baseline — if we touch the judge, the before/after must re-score the ORIGINAL answers under the new
judge (judge-only, cheap) to keep the delta apples-to-apples. Recommend: land the engine fixes first
and measure the pure engine delta under the UNCHANGED judge; treat the judge-clarity fix as a separate,
clearly-flagged correction with its own re-score. The planner decides sequencing and calls it out.

## Constraints (from the task)
- Byte-identical TEE-shot behavior; the shipped tee suites stay green unmodified.
- Heuristics (rough/bunker carry penalties, thresholds) must be labeled honest.
- Validators (bench det-checks) extended to the approach numbers: arithmetic closes, verdict-pins for
  approach miss-sides.
- Re-run the FAILING SUBSET on-box: `--only-failures 20260722-145448 --render-mode vector` (~$5 authorized).

## Key files
- `backend/app/caddie/aim_point.py` — approach solve; `en_route_carry_hazards` (130), `_governing_center_carry`
  (162), `compute_miss_side` (257), reachable branch (~1047), the bad line (1263), `compute_aim_point` (~478).
- `backend/app/caddie/hazards.py` — Hazard `carry_yards`/`side`/`distance_from_green`/`line_side` semantics.
- `backend/app/caddie/physics.py` — wind/plays-like (SHARED with tee — parity risk).
- `backend/tests/eval/caddie_bench/judge.py` — rubric + `_format_engine_ref` (measurement confound).
- `backend/tests/eval/caddie_bench/{run_caddie_bench.py,report.py}` — `--only-failures`, delta report.
