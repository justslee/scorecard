# Caddie Bench

Extensive caddie evaluation/benchmark framework (specs/caddie-bench-plan.md,
specs/caddie-bench-plan.md is the builder's contract this package implements).
A superset of, and consistent with, the existing two-tier harness in
`backend/tests/eval/` — reuses its schema/gating/anti-gaming discipline
(`tests/eval/schema.py`, `run_tier2.py`, `substance.py`,
`test_harness_has_teeth.py`) rather than forking a parallel one.

## What this is

The owner's directive: build ~1000+ unique player questions from real
positions on real holes, run them against the live caddie, verify against a
screenshot of the map (hole/course/wind/yardage), judge with a vision model
the way he judges ChatGPT-5.6-Sol screenshots himself, report the results,
and iterate the caddie until the numbers improve.

This package is that framework: geometry-derived positions on 8 real holes
(offline, from committed fixtures — zero DB at bench time), a hand-authored
phrasing bank, the real `run_strategy_turn` seam, deterministic pre-checks
that can never be gamed, a vision judge with a closed 10-dimension rubric,
and a markdown report generator.

## Module layout

```
caddie_bench/
├── schema.py            # case/result/judge pydantic models + ALL closed enums
├── geometry.py           # fixture loader + position sampler (pure, offline)
├── extract_fixtures.py  # ONE-TIME read-only fixture extractor (gated, not pytest)
├── questions.py          # question-bank loader + case expansion (pure)
├── harness.py             # RoundSession/HoleIntelligence assembly + the seam call
├── render.py              # map composite renderer (satellite + vector modes)
├── judge.py                # vision judge: prompt assembly + structured scoring + 2nd pass
├── report.py               # markdown report generator (pure: results JSONL -> md)
├── run_caddie_bench.py    # gated LIVE runner (NOT test_*.py; resumable; cost-capped)
├── sim_screenshots.md    # recipe for the simulator side-by-sides
├── fixtures/
│   ├── holes/            # committed per-hole geometry: {_provenance, par, yards, features}
│   ├── questions_v1.jsonl # hand-authored, versioned phrasing bank
│   ├── bags.json           # the 3 player bags
│   └── canned/            # canned synth answers + judge verdicts for offline CI
├── test_bench_offline.py # G1 — offline, stubbed CI suite
└── test_bench_teeth.py    # G2 — RED-proofs for every deterministic check + gating pins
```

## Gates

- **G1 (offline, CI)**: `cd backend && uv run pytest tests/eval/caddie_bench/test_bench_offline.py -q`
  — schema/bank load validation, fixture load, position containment
  re-verification, harness end-to-end with a stubbed synth + stubbed judge +
  vector renderer, report generation from canned results, runner
  gate-refusal, filename-glob pins. No network, no key, no DB, no Docker.
- **G2 (teeth)**: `cd backend && uv run pytest tests/eval/caddie_bench/test_bench_teeth.py -q`
  — every deterministic check proven RED with a mutant; sampler
  raises-on-bad-containment; judge-schema rejects an out-of-taxonomy value;
  canary-all-pass correctly flags the run.
- **G3 (pilot artifacts)**: after a LIVE run — `specs/caddie-bench-report-<date>.md`
  + committed worst-10 composites + 3-5 sim side-by-sides + gitignored
  `runs/<id>/{results,costs}.jsonl` present and key-free.
- **G4**: `cd backend && ruff check .` clean; `cd backend && uv run pytest tests/eval -q`
  (the existing eval suite) still green.

Run all of G1+G2+G4 in one shot:

```
cd backend && uv run pytest tests/eval/caddie_bench -q && uv run pytest tests/eval -q && ruff check .
```

## Fixture extraction (one-time, gated, offline)

```
cd backend && CADDIE_BENCH_EXTRACT=1 uv run python -m tests.eval.caddie_bench.extract_fixtures --from-overpass
```

Parses the already-committed `tests/fixtures/bethpage_overpass.json` — zero
network. Writes `fixtures/holes/bethpage_{black,red}_h<N>.json` for the 7
pilot Bethpage holes (Black 4/5/7/8/18, Red 6/16) + re-points the existing
`tests/fixtures/pebble_beach_hole3_geometry.json` into
`fixtures/holes/pebble_beach_h3.json`.

Muirfield Village 14 (the water-pinch hole, plan §2 item #9) is OPTIONAL and
was NOT extracted this cycle — it needs a one-time READ-ONLY prod extraction
(`--from-prod <hole_id>`, gated the same way, requires `DATABASE_URL` for a
live prod RDS on-box) which wasn't trivially available in this build
environment. The pilot runs fine on the committed 8 core holes; Muirfield 14
(or Pine Valley 9, already committed at `tests/fixtures/pine_valley_hole9
_geometry.json`, the plan's named fallback) is a follow-up.

## Live pilot run (NOT run by the builder — reviewer signs off on the judge
rubric first, per the builder's contract)

```
cd backend && CADDIE_EVAL_LIVE=1 OPENAI_API_KEY=... uv run python -m \
    tests.eval.caddie_bench.run_caddie_bench --budget-usd 8.00
```

Gated OFF by default (exit 2 without both `CADDIE_EVAL_LIVE=1` and
`OPENAI_API_KEY`). Flags: `--budget-usd` (pilot default 40.00, hard cap),
`--max-cases`, `--only-failures <run_id>`, `--holes <fixture_id> ...`,
`--resume <run_id>` (per-case JSONL is appended case-by-case — a case-level
resumable run). Writes `runs/<run_id>/{results.jsonl, costs.jsonl,
composites/, report.md}` — all gitignored except the worst-10 gallery images
+ the report itself, which `report.py`'s caller copies into
`specs/assets/caddie-bench/` before committing.

Cost estimate (plan §7, pin the `gpt-5.6-sol` prices in
`run_caddie_bench._PRICING_PER_MTOK_USD` against OpenAI's published page
before the first live run): pilot (150 cases) ~$3.10 + retry margin, budget
$8, hard cap `--budget-usd 40`. Tile cost ~$0.04 total (18 per-hole
composites, cached forever).

## Case math (pilot, §2)

8 core holes (7 par-4/5 x 6 position slots + 1 par-3 x 4 slots) x 3 bags
(OWNER hcp 3.0 / SHORT_HITTER hcp 20 / BOMBER hcp 8) = 138 ADVICE cases, + 8
FACT-class cases (one per hole) = 146, + 4 canary (poison-pill) cases = **150
judged cases, 146 synth calls** — verified by
`test_bench_offline.py::test_build_cases_produces_the_planned_case_count`.

## Known engine-taxonomy limitation surfaced while building this (not fixed
here — flag for the next caddie iteration)

The BOMBER bag (per the plan's literal numbers) includes a `"3iron"` entry.
`app.caddie.club_selection.normalize_club_distances` has NO 3-iron in its
canonical taxonomy (`CLUB_REFERENCE`/`CLUB_DISPLAY_NAMES` both start at
4-iron) — the entry is silently dropped, so the BOMBER bag effectively plays
with driver/3wood/5iron/7iron/9iron/pw/gw/sw/lw, missing its longest iron.
`bags.json` keeps the plan's literal club numbers (so the bag data matches
the spec exactly); this is an engine gap, not a fixture bug — worth a
backlog item.

## Deterministic pre-checks vs. judge dimensions

Deterministic checks (`harness.py`, never the judge — cannot flake, cannot
be charmed): `hazard_only_from_input`, `side_flip`, `injection`,
`club_matches_engine`, `numbers_close`, `positioning_no_pin_language`,
`length_caps`. All reuse the SAME production machinery
`app.caddie.strategy.validate_strategy_text` is itself built from
(`guide_writer._HAZARD_PATTERNS`, `_has_side_flip`, `GUIDE_INJECTION_PATTERN`,
`strategy._PIN_RELATIVE_PATTERN`) and the same club-extraction the golden-set
harness uses (`tests.eval.substance.extract_substance`) — never a second,
forked implementation.

Judge dimensions (`judge.py`, §5b) — 10 dimensions, 0/1/2 + confidence each,
correctness dimensions weighted 2x in the headline score: NUMBERS_COHERENCE,
SHOT_REACHABILITY, MISS_SIDE_EVIDENCE, CLUB_CORRIDOR, HAZARD_AWARENESS,
WIND_AWARENESS (correctness, drawn from owner caddie-failure memories) +
ANSWERS_THE_QUESTION, STRATEGIC_DEPTH, NATURAL_SPEECH, NON_REPETITIVE (the
owner's "8-dimension crux" language qualities). Verbosity is judged ONLY by
`harness.check_length_caps` — the judge rubric text explicitly rules length
out of scope, so a long hedgy answer can never outscore a concise correct
one.

## Anti-gaming (§5c — what a reviewer should probe)

- Verbosity never LLM-judged; rubric states concise-correct beats long-hedgy.
- `geometry.sample_position` HARD-VERIFIES containment (via the production
  `app.services.course_spatial._point_in_ring` math) and RAISES
  `GeometrySamplingError` on failure — proven with monkeypatched-false
  containment in `test_bench_teeth.py`.
- The phrasing bank is hand-authored, deduped at LOAD time (not just
  generation time), versioned (`questions_v1.jsonl`, never edited in place).
- 4 canary (poison-pill) cases with deliberately bad canned answers — the
  judge MUST score every one bad; `report.compute_headline().canary_all_pass`
  (and `judge.canary_all_pass_gate`) flip True — and the run exits 1 — if any
  canary scores GOOD, proven in `test_bench_teeth.py`.
- The candidate answer is always framed as UNTRUSTED DATA in the judge
  prompt (mirrors `run_tier2._judge_prompt`'s framing) plus a fail-closed
  injection pre-scan (`tests.eval.run_tier2._looks_like_injection`, reused
  verbatim — never a second pattern) that skips the model call entirely on
  injection-shaped text.
- The judge never sees the synth's own ground-truth PROMPT — only facts + the
  map composite + the engine reference — so it can never grade "did it copy
  the prompt".

## Iteration protocol (designed this cycle, run in the next — plan §8)

1. Pilot run -> `report.py`'s failure-class Pareto (class x lie x hole).
2. Each non-GOOD case: judge `failure_class` + det-check evidence.
   `engine_looks_wrong` cases triage FIRST (engine bugs beat prose bugs).
3. Fix the TOP failure class only, one change in `app/caddie/*` per
   iteration; every fix lands with a golden-set scenario
   (`tests/eval/golden/caddie_advice.jsonl`) per the existing eval README
   rule.
4. `run_caddie_bench.py --only-failures <run_id>` re-runs the failing subset.
5. `report.py`'s `delta_against` param appends a before/after delta section.
6. Repeat until the headline correctness score clears the bar (recommend:
   >=85% weighted-correctness, zero FABRICATED/WRONG_NUMBERS) — the exact bar
   is the owner's call after reading the first report.
