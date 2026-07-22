# Caddie Bench — cycle-1 report (framework built; live pilot blocked on key access)

**Date:** 2026-07-22 · **Epic:** `caddie-bench-eval-framework` (owner's #1 priority) ·
**Plan:** `specs/caddie-bench-plan.md` · **Framework:** `backend/tests/eval/caddie_bench/`

## TL;DR
The extensive caddie evaluation framework the owner asked for is **built, adversarially
reviewed (Fable), and green** — it generates ~150 (scalable to 1000+) unique player questions
from **real on-course positions**, runs them through the **real advice path** (`run_strategy_turn`
→ `gpt-5.6-sol`, byte-identical to the live app), builds a **map composite** per case, and scores
each answer with a **vision judge** (`gpt-5.6-sol` + the image, mirroring the owner's ChatGPT-5.6-Sol
screenshot flow) across a 10-dimension rubric anchored on the exact caddie failures the owner has
reported. The offline machinery, teeth, determinism, and anti-gaming are all verified.

**The live pilot did NOT run this pass** — not for any framework reason, but because the two API
keys it needs (`OPENAI_API_KEY` for the synth, `GOOGLE_MAPS_KEY` for satellite composites) are **not
present on the agent box through any sanctioned channel**: the box's only real `backend/.env` carries
`ANTHROPIC_API_KEY` only, and direct AWS Secrets Manager access was ruled out by a security
correction this cycle. So the report's **real caddie-quality numbers are pending** — see
"Pilot status" and "Unblock" below. Everything needed to produce them is one command away once a
key source is authorized.

---

## 1. What was built (framework as delivered)

New package `backend/tests/eval/caddie_bench/`, a superset of the existing two-tier eval harness
(`backend/tests/eval/`). Modules (all committed on `integration/next` this cycle):

| Module | Responsibility |
|---|---|
| `schema.py` | Closed pydantic enums (`extra='forbid'`) — `LieCategory`, `QuestionType`, `ConditionsId`, `BagId`, `JudgeDimension`, `FailureClass` — + case/result/judge models. A typo'd enum is a load-time error. |
| `geometry.py` | Pure, offline. Loads a hole geometry fixture → `HoleIntelligence` (hazards/bend/corridor/green + approach bearing); `sample_position` draws **real lat/lng** in each lie category from the polygons and **hard-verifies containment** (raises on a mislabel — no silently-wrong lies). |
| `extract_fixtures.py` | One-time, gated (`CADDIE_BENCH_EXTRACT=1`, never pytest-collected). `--from-overpass` (offline) assembles Bethpage holes from the committed `bethpage_overpass.json`; `--from-prod` is a READ-ONLY SELECT for holes not committed. |
| `questions.py` | Loads the versioned, deduped `questions_v1.jsonl` (127 hand-authored natural phrasings across 10 question types) and expands the case matrix deterministically (stable per-bag seeds, per-case stable-hash conditions). |
| `harness.py` | Builds a `RoundSession` (bag **normalized through the prod chokepoint**, handicap, wind) + `HoleIntelligence` offline and calls the **real** `run_strategy_turn`; computes the engine oracle (`generate_recommendation`); runs the deterministic pre-checks. |
| `render.py` | Map composite: a **georegistered** satellite base (Google Static Maps, per-hole `_fit_zoom`) + our overlays (player pin, green/target, hazard outlines, centerline, distance/wind annotations) drawn with the **same Web-Mercator projector** as the base; a pure-vector mode for offline/CI. |
| `judge.py` | Vision judge (`gpt-5.6-sol` + composite image + structured facts + engine reference), strict-JSON structured scores over 10 dimensions + a closed failure class + an `engine_looks_wrong` flag; confidence-gated second pass. |
| `report.py` | Renders `runs/<id>/results.jsonl` → this report shape: correctness dims AND owner-crux dims as separate headlines, failure-class Pareto, per-hole tables, worst-N gallery, cost summary, delta-vs-prior for the iteration loop. |
| `run_caddie_bench.py` | The gated LIVE runner (three guards, `--budget-usd` cap incl. the second-pass judge, `--resume`/`--only-failures`, per-call cost log). |
| `test_bench_offline.py` / `test_bench_teeth.py` | The always-on CI gates + RED-proofs. |

**Gates (independently re-verified by qa, and by the Fable reviewer):** `ruff` clean · `pytest
tests/eval/caddie_bench` = **47 passed** · `test_bench_teeth.py` = **18 passed** · `pytest
tests/eval` (existing suite) = **255 passed** · determinism byte-identical across two `PYTHONHASHSEED`
processes · no key-shaped strings in the package.

---

## 2. The judged rubric (operationalizing the owner's bar)

Each answer is scored 0/1/2 with a confidence on 10 dimensions, split into two headlines so a rosy
average can't hide a weak felt experience:

**Correctness (weighted 2×, drawn directly from the owner's reported caddie failures):**
- `NUMBERS_COHERENCE` — every spoken number binds to ONE per-turn engine solve and closes
  arithmetically; a challenged number is re-derived, never confabulated.
- `SHOT_REACHABILITY` — an out-of-reach tee shot reasons about the landing zone + leave-yardage,
  never aims relative to the flag.
- `MISS_SIDE_EVIDENCE` — a "safe miss" claim must be backed by per-side hazard evidence on the map.
- `CLUB_CORRIDOR` — the club respects dogleg/corridor geometry (not reflexive driver).
- `HAZARD_AWARENESS`, `WIND_AWARENESS`.

**Owner-crux (reported separately):** `ANSWERS_THE_QUESTION`, `STRATEGIC_DEPTH`, `NATURAL_SPEECH`,
`NON_REPETITIVE`.

Backed by **deterministic pre-checks** (never the LLM, cannot flake or be charmed): club-vs-engine,
numbers-close (±5y), positioning-no-pin-language, side-flip, length cap. **Verbosity is judged ONLY
by the deterministic length cap** — the LLM judge is told length is out of scope, so a long hedgy
answer can never outscore a concise correct one. Four **canary** poison-pill cases with known-bad
answers must be scored bad; if the judge passes any canary, the run fails. The Fable reviewer tried
to construct a gaming answer for each dimension and could not.

---

## 3. Pilot design (ready to execute)

~150 cases = **8 real holes** × positions × 3 bags + FACT + canaries:

- **Holes:** Bethpage Black 4 (par-5 risk/reward), 5 (long dogleg w/ real corner trees), 7 (biggest
  dogleg, corridor test), 8 (par-3), 18 (open control hole); Bethpage Red 6 (short-par-4 reachability
  boundary), 16 (dogleg-right par-5); Pebble Beach 3 (dogleg-left, committed prod fixture). Muirfield
  Village 14 (water pinch) is the +1 read-only-prod extraction (deferred — needs prod DB, not run).
- **Bags:** OWNER (real bag, hcp 3.0), SHORT_HITTER (hcp 20), BOMBER (hcp 8) — all normalized exactly
  as a prod session load would.
- **Conditions:** CALM / CROSS_15 / INTO_20 rotated by stable per-case hash.
- **Positions:** real lat/lng sampled from each hole's polygons (tee, fairway-prime,
  fairway-layup-decision, rough, bunker, recovery-trees/greenside), each verified inside its lie.

---

## 4. Cost model (measured design, verified before spend)

Pricing pinned in a refuse-unknown-model table (`run_caddie_bench.py`), mirroring the existing
`run_tier2` pattern:

| Leg | Per case | Notes |
|---|---|---|
| Synth (`gpt-5.6-sol`) | ~$0.005 | ~2.0k in + ~130 out |
| Vision judge (image + facts) | ~$0.013 | + ~$0.002 avg for the ~15% second passes (now counted in the budget) |
| Satellite tiles | ~$0.04 **total** | per-hole (not per-case), cached forever |

- **Pilot (150 cases): ≈ $3.10**, hard cap `--budget-usd 40`.
- **Full 1000-case run (follow-up op): ≈ $20–28**, propose cap $60; **zero** new tile cost (same holes).

Per-call cost log to `runs/<id>/costs.jsonl` (gitignored). This makes the "run it against 1000+"
step a bounded, cost-logged operation, not an open-ended spend.

---

## 5. Pilot status — BLOCKED on a sanctioned key source (not a framework issue)

The live pilot needs two keys the agent box does not expose through a sanctioned channel:
- `OPENAI_API_KEY` — the ADVICE synth (`synthesize_strategy`) calls OpenAI's Responses API
  (`gpt-5.6-sol`); this is the exact path the owner cares about. The Anthropic key present on the box
  cannot substitute (the synth is hardcoded to OpenAI; the Anthropic text-mouth is a different,
  non-representative path — using it would break fidelity).
- `GOOGLE_MAPS_KEY` — the satellite composite the judge grades against.

The box's only real `backend/.env` carries `ANTHROPIC_API_KEY` only; both required keys are absent.
Direct AWS Secrets Manager retrieval — where these keys do live — was ruled out by a security
correction this cycle (sanctioned pattern = on-box `.env` in-process only). No secret VALUES were
ever emitted to any output, log, or artifact during this cycle (verified). With no authorized on-box
key source, the real judged numbers cannot be produced this pass.

The **offline pipeline** (canned synth + canned judge + vector render) was exercised end-to-end and
produces a genuine report from real fixture positions — this proves the plumbing (positions resolve
to real lat/lng, det-checks fire, canaries are caught, the report renders), but its scores are on
**canned inputs and are NOT a caddie-quality result**. The caddie-quality result is exactly what the
live pilot produces.

### Unblock (one action → the pilot is one command)
Place `OPENAI_API_KEY` and `GOOGLE_MAPS_KEY` into `backend/.env` on the agent box (or otherwise export
them into the loop's environment through a sanctioned mechanism). Then, on the box:

```bash
cd backend
set -a; . .env; set +a                       # sanctioned in-process key load, no echo
export DATABASE_URL="postgresql+asyncpg://stub:stub@localhost/stub"   # bench never connects; import-only
# smoke first (2 cases, cheap) to validate the live synth + vision-judge round-trip:
CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.caddie_bench.run_caddie_bench --max-cases 2 --budget-usd 1
# then the full pilot:
CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.caddie_bench.run_caddie_bench --budget-usd 40
uv run python -m tests.eval.caddie_bench.report runs/<run_id>   # writes the results into this report
```

The runner is resumable per-case, so a mid-run stop loses nothing.

---

## 6. Screenshot-fidelity proof (method documented; deferred with the pilot)

The owner asked whether screenshotting the map is a viable eval substrate. The framework renders a
**georegistered** composite (satellite + our overlays via identical Web-Mercator math — the Fable
reviewer independently reimplemented the projector and matched it to <1e-6 px on every tee/green
across all 8 holes). The planned proof — 3–5 iOS-simulator screenshots of the same positions
side-by-side with the composites (recipe in `caddie_bench/sim_screenshots.md`, reusing the
`ops/harness/oncourse-sim` build) — is deferred with the pilot (it also needs the maps key for the
in-app satellite tiles, and a full Debug simulator build). Verdict-to-date: the composite is
geometrically faithful by construction; the visual side-by-side is the remaining confirmation.

---

## 7. Iteration protocol (designed; runs once real pilot data exists)

1. Pilot → failure-class Pareto (class × question-type × lie × hole); `engine_looks_wrong` cases
   triaged FIRST (engine bugs beat prose bugs).
2. Fix the single top failure class in `app/caddie/*` (each fix lands with a golden-set scenario).
3. `run_caddie_bench.py --only-failures <run_id>` re-runs the failing subset + a fixed 20-case
   no-regression sample.
4. `report.py --delta <old_run_id>` appends the before/after.
5. Repeat until the owner's bar is met (recommend ≥85% weighted correctness, zero
   `FABRICATED`/`WRONG_NUMBERS`).

The bench doubles as a **standing regression suite**: the offline fixture-pinned subset runs in CI
with a stubbed synth on every PR, so a caddie change that regresses a known failure class fails a
gate.

---

## 8. Known follow-ups the framework already surfaced (for the iteration loop)
- BOMBER's 3-iron was silently dropped by `normalize_club_distances` (taxonomy starts at 4-iron) —
  fixed in the bag, but flags a real engine-taxonomy gap worth revisiting.
- `compose_degraded_line`'s multi-bunker phrasing can trip `guide_writer._has_side_flip`'s
  nearest-side-word window — a genuine engine nuance to examine once the pilot quantifies its impact.
