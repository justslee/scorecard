# Caddie Bench — extensive caddie evaluation/benchmark framework (builder's contract)

**Owner directive (verbatim, 2026-07-22):** "I need to build an extensive testing framework
for the caddie feature… generate about 1000+ unique possible messages a player might ask the
caddie from unique positions on the course… actually run it against our caddie. Then we
verify against a screenshot of the map + hole number + course + wind, yardage left etc…
when I sent a screenshot to ChatGPT 5.6 Sol and asked it to give me advice with my player
specs it seemed to do a better job so I want to mock my test flow. … run the test against a
select set of holes on the courses we have ingested. Write me a report of results and the
framework but continue to iterate the caddie until the results improve."

**This cycle's deliverables:** (1) the full framework as
`backend/tests/eval/caddie_bench/` — a superset of, and consistent with, the existing
two-tier harness in `backend/tests/eval/`; (2) a PILOT run: ~150 cases over 8-9 real holes,
real synth (`gpt-5.6-sol`) + real vision judge, producing
`specs/caddie-bench-report-2026-07-22.md`; (3) 3-5 iOS-simulator screenshots side-by-side
with generated map composites (screenshot-fidelity proof); (4) the iteration protocol
(designed, not necessarily run this cycle).

Northstar note: this is backend test infrastructure — no user-facing UI, so the
Northstar-design (`designer`) review is **N/A**. Shared-types note: no shape in
`backend/app/models.py` / `frontend/src/lib/types.ts` is touched — this is test-only
backend code; the sync rule is **N/A** (confirmed: every new type lives under
`backend/tests/eval/caddie_bench/schema.py`).

---

## 0. What exists and is REUSED (do not duplicate)

Verified seams (read during planning):

- **Live advice seam** — `backend/app/caddie/strategy_turn.py::run_strategy_turn(session,
  round_id, user_id, hole, *, distance_to_green_yards=None, hole_yards=None,
  yardage_basis=None) -> dict` returning
  `{available, hole_number, strategy, degraded, reason, numbers}`. Byte-identical to what
  both live mouths run. The bench calls this DIRECTLY.
- **Real synth** — `backend/app/caddie/strategy.py::synthesize_strategy(ground_truth, *,
  model)` (raw httpx → OpenAI Responses API, default `gpt-5.6-sol` via
  `CADDIE_STRATEGY_MODEL`, key `OPENAI_API_KEY`, 18s timeout, effort
  `CADDIE_STRATEGY_REASONING_EFFORT` default `none`, no retry).
  `format_strategy_ground_truth(payload)` is the deterministic ground truth AND cache-key
  basis — the bench must clear/bypass the module-level `_CACHE` between condition variants
  of the same hole (the ground-truth bytes differ per position/wind, so collisions are
  structurally impossible, but the runner still calls a fresh process or clears `_CACHE`
  per run for hygiene).
- **Routing** — `backend/app/caddie/routing.py::classify_intent(transcript) -> Intent`
  (`ADVICE/FACT/SCORE/OTHER`). The bench records the routed intent per case; the harness
  runs `run_strategy_turn` for ADVICE-class cases and includes a small FACT subset to
  exercise routing (FACT answers judged with a reduced rubric; the Claude tool loop is
  STUBBED in the pilot — live-FACT is a follow-up).
- **Correctness oracle** — `backend/app/caddie/aim_point.py::generate_recommendation(hole,
  distance_yards, club_distances, handicap=15.0, weather=None, player_stats=None,
  shot_bearing=0.0, competition_legal=False, yardage_basis=None) -> CaddieRecommendation`.
- **Offline geometry → intelligence** — proven pattern in
  `backend/tests/test_corner_tree_forward_bound.py::_hole_intel_from_geometry_fixture`:
  a committed `{_provenance, par, features}` JSON → `extract_hole_hazards` +
  `extract_hole_bend` + `extract_corridor_profile` → `HoleIntelligence`, zero DB. And in
  `backend/tests/test_bethpage_validation.py`: the committed
  `tests/fixtures/bethpage_overpass.json` + `osm_ingest.assemble_osm_course` assembles ALL
  Bethpage holes (Black verified 18/18 against the published card; Red assembled in
  `test_tee_club_expected_strokes.py`) — fully offline.
- **DB-seam stubs** — `backend/tests/eval/conversation_runner.py` already stubs exactly
  the seams `run_strategy_turn`'s payload chain touches:
  `sessions.set_recommendation` (called inside `tools.recommend_payload`) and
  `memory_mod.get_player_profile` (called inside `tools.player_profile_payload`). The
  bench harness reuses the same stub approach at the `app.caddie.tools` import site.
- **Harness discipline** — `tests/eval/schema.py` (pydantic `extra='forbid'` + closed
  check registries, load-time validation), `run_tier2.py` (three-guard LIVE gating,
  `--budget-usd` hard cap, refuse-unknown-model pricing table, injection pre-scan,
  judge-answer-as-untrusted-data framing, gitignored `last_run.json`),
  `test_harness_has_teeth.py` ("an eval that can't fail is worse than none"),
  `substance.py` (club/yardage/hazard extraction from an answer — reuse for the
  numbers-coherence arithmetic check, never fork a second club-regex family).
- **Owner's real bag** — `tests/test_corner_tree_forward_bound.py::_OWNER_BAG`
  (matches the prod audit script's `OWNER_CLUB_DISTANCES`): driver 300, 3wood 270,
  4iron 230, 5iron 215, 6iron 195, 7iron 180, 8iron 170, 9iron 155, pw 140, gw 127,
  sw 115, lw 90 — no hybrid/5wood. Prod `golfer_profiles.handicap_index` has one populated
  row: **3.0** (the owner). Use handicap 3.0 with this bag.
- **Maps key** — `NEXT_PUBLIC_GOOGLE_MAPS_KEY` / secretsmanager `looper/client`
  `GOOGLE_MAPS_KEY` (see `ops/harness/oncourse-sim/README.md` §2.3), fetched at run time,
  in-process only, never logged.
- **Simulator harness** — `ops/harness/oncourse-sim/README.md`: Debug diag build
  self-seeds a Bethpage Red round on simulator UDID `D4DB2397-D23A-4D55-A049-8E7D4B738E8D`;
  `xcrun simctl location <udid> set <lat>,<lng>` + `xcrun simctl io <udid> screenshot`
  give the side-by-side screenshots.

**Infra constraints (hard):** no local Postgres on this Mac; NEVER a Docker Postgres;
prod DB access READ-ONLY only, one-time, for fixture extraction — **the bench itself runs
with zero DB at bench time**, entirely from committed geometry fixtures.

---

## 1. Module layout — `backend/tests/eval/caddie_bench/`

Each file is independently buildable against `schema.py`'s contracts.

```
backend/tests/eval/caddie_bench/
├── __init__.py
├── README.md                    # runbook: gates, commands, cost, iteration protocol
├── schema.py                    # case/result/judge pydantic models + ALL closed enums
├── geometry.py                  # fixture loader + position sampler (pure, offline)
├── extract_fixtures.py          # ONE-TIME read-only fixture extractor (gated, not pytest)
├── questions.py                 # question-bank loader + case expansion (pure)
├── harness.py                   # RoundSession/HoleIntelligence assembly + the seam call
├── render.py                    # map composite renderer (satellite + vector modes)
├── judge.py                     # vision judge: prompt assembly + structured scoring + 2nd pass
├── report.py                    # markdown report generator (pure: results JSONL -> md)
├── run_caddie_bench.py          # gated LIVE runner (NOT test_*.py; resumable; cost-capped)
├── sim_screenshots.md           # recipe for the 3-5 simulator side-by-sides (manual steps)
├── fixtures/
│   ├── holes/                   # committed per-hole geometry: {_provenance, par, features}
│   │   ├── bethpage_black_h4.json … (extracted ONCE from bethpage_overpass.json)
│   │   ├── bethpage_red_h6.json …
│   │   ├── pebble_beach_h3.json     # copy of ../../fixtures fixture or re-point
│   │   └── muirfield_village_h14.json  # optional, read-only prod extraction (water pinch)
│   ├── questions_v1.jsonl       # the versioned, deduped phrasing bank (committed)
│   ├── bags.json                # the 3 player bags (committed)
│   └── canned/                  # canned synth answers + judge verdicts for offline CI
├── test_bench_offline.py        # tier-1 CI suite (offline, stubbed synth/judge/tiles)
└── test_bench_teeth.py          # RED-proofs for every deterministic check + gating pins
```

Gitignored run artifacts (add to root `.gitignore`, same pattern as
`backend/tests/eval/last_run.json`):
`backend/tests/eval/caddie_bench/runs/` (per-case results JSONL, cost log, composites,
tile cache).

### Responsibilities + key signatures

**`schema.py`** — every shape, `extra='forbid'`, closed enums:
```python
class LieCategory(str, Enum): TEE, FAIRWAY, ROUGH, BUNKER, RECOVERY_TREES, GREENSIDE
class QuestionType(str, Enum):
    TEE_STRATEGY, CLUB_SELECTION, LAYUP_VS_GO, MISS_SIDE_BAIL, CARRY_QUESTION,
    WIND_ADJUST, APPROACH_GREEN, RECOVERY, CHALLENGE_WHY, FACT_DISTANCE  # FACT tier
class ConditionsId(str, Enum): CALM, CROSS_15, INTO_20   # 3 wind presets, deterministic
class BagId(str, Enum): OWNER, SHORT_HITTER, BOMBER
class FailureClass(str, Enum):  # CLOSED taxonomy — judge must pick exactly one
    WRONG_SIDE, BAD_CLUB, MISSED_HAZARD, IGNORED_WIND, WRONG_NUMBERS,
    VAGUE, FABRICATED, NOT_ANSWERED, GOOD
class JudgeDimension(str, Enum):  # §5 rubric
    NUMBERS_COHERENCE, SHOT_REACHABILITY, MISS_SIDE_EVIDENCE, CLUB_CORRIDOR,
    HAZARD_AWARENESS, WIND_AWARENESS, ANSWERS_THE_QUESTION, STRATEGIC_DEPTH,
    NATURAL_SPEECH, NON_REPETITIVE

class PositionSpec(BaseModel):  lie: LieCategory; along_pct: float | None; seed: int
class BenchCase(BaseModel):     # POSITION × HOLE × PLAYER × CONDITIONS × QTYPE × PHRASING
    id: str; hole_fixture: str; bag: BagId; conditions: ConditionsId
    position: PositionSpec; question_type: QuestionType; phrasing_id: str
    canary: bool = False        # poison-pill case: judge MUST score it bad (§5 anti-gaming)
class ResolvedPosition(BaseModel):  lat, lng, lie, distance_to_green_yards, shot_bearing_deg
class CaseResult(BaseModel):    # one JSONL line per case in runs/<run_id>/results.jsonl
    case_id, resolved: ResolvedPosition, intent: str, answer: str, degraded: bool,
    engine_ref: dict, det_checks: list[DetCheckResult], judge: JudgeScores | None,
    judge_second: JudgeScores | None, contested: bool, cost_usd: float, latency_ms: float
class JudgeScores(BaseModel):
    scores: dict[JudgeDimension, int]        # 0=fail 1=partial 2=pass
    confidence: dict[JudgeDimension, float]
    failure_class: FailureClass; engine_looks_wrong: bool; reason: str
```
Load-time validation mirrors `tests/eval/schema.py::load_golden_set` — a typo'd enum or
missing required field fails the WHOLE load. `questions_v1.jsonl` lines are
`{"phrasing_id", "question_type", "lie_constraint", "text"}` — `questions.py` refuses a
phrasing whose `question_type` doesn't exist and refuses duplicate texts (dedupe is
enforced at load, not just at generation).

**`geometry.py`** — pure, offline. Reuses `course_spatial._point_in_ring` /
`hazards._point_in_ring_xy` math (NO shapely — not a dependency and not needed):
```python
def load_hole_fixture(path: Path) -> HoleFixture          # {_provenance, par, yards, features}
def hole_intel_from_fixture(fx: HoleFixture) -> HoleIntelligence
    # extract_hole_hazards + extract_hole_bend + extract_corridor_profile +
    # green_geometry.approach_bearing_deg (so wind rotation has a bearing) +
    # green depth/width from the green polygon. Mirrors _hole_intel_from_geometry_fixture.
def sample_position(fx, spec: PositionSpec) -> ResolvedPosition
    # TEE: tee point/centroid. FAIRWAY: walk the 'hole' centerline LineString to
    # along_pct, project into the fairway polygon (nudge perpendicular until inside).
    # ROUGH: fairway-edge point offset outward 5-15y, verified NOT in fairway/bunker/
    # water/green. BUNKER: bunker-polygon centroid (nearest to along_pct).
    # RECOVERY_TREES: a point behind a tree-line/woods feature relative to the green.
    # GREENSIDE: ring 10-25y around the green polygon, verified not in it.
    # Deterministic: seeded from spec.seed. RAISES if containment can't be verified —
    # a position in the wrong lie is a hard error, never a silently mislabeled case.
def haversine_yards(a, b) -> float;  def bearing_deg(a, b) -> float
```

**`extract_fixtures.py`** — one-time, gated like a LIVE runner (refuses without
`CADDIE_BENCH_EXTRACT=1`), never collected by pytest, two modes:
(a) `--from-overpass` (default, zero network): `bethpage_overpass.json` →
`_parse_course_geometry_response` → `assemble_osm_course` per course variant → write
per-hole `{_provenance, par, yards, features}` files (yardages injected from the published
cards already pinned in `test_bethpage_validation.py::CARD` for Black; Red uses the
audit's derived yardages, provenance-labeled). (b) `--from-prod` (READ-ONLY): a single
`SELECT … ST_AsGeoJSON(geom) FROM public.hole_features WHERE hole_id = …` against prod
RDS (same query shape as `courses_mapped.get_course`), run on-box with the prod
`DATABASE_URL` in-process only; writes the same fixture shape. Used once for
Muirfield Village 14 (water pinch) if included. Every fixture carries `_provenance`
(source, date, query/course id) like the existing pebble/pine fixtures.

**`questions.py`** — loads `questions_v1.jsonl`, expands the case matrix:
```python
def load_question_bank(path) -> list[Phrasing]     # validated, deduped, versioned
def build_cases(holes, bags, conditions, bank, *, per_hole_positions, seed) -> list[BenchCase]
```
The bank itself is generated ONCE (a separate, gated `--generate` mode: one LLM batch call
producing ~1,200 phrasings across the 10 question types, deduped by normalized text,
committed as `questions_v1.jsonl`) — after that the bench is fully deterministic. The
pilot uses ~150 of them; the full-1000 run uses the whole bank. Regenerating bumps the
version (`questions_v2.jsonl`), never edits v1 in place.

**`harness.py`** — the seam driver:
```python
def build_session(intel: HoleIntelligence, bag: dict, handicap: float,
                  weather: WeatherConditions) -> RoundSession
    # RoundSession(round_id="bench", user_id="bench-user", hole_intel={n: intel},
    #              club_distances=bag, handicap=..., weather=..., current_hole=n)
async def run_case(case, fx, *, synth=None) -> CaseResult
    # 1. resolve position (geometry.sample_position); intent = classify_intent(text)
    # 2. stub DB seams (tools-module attrs: sessions.set_recommendation -> noop,
    #    memory_mod.get_player_profile -> None) — same seams conversation_runner stubs
    # 3. ADVICE: await run_strategy_turn(session, "bench", "bench-user", hole,
    #       distance_to_green_yards=round(resolved.distance_to_green_yards),
    #       yardage_basis=None)   # gps basis is implied by distance_to_green_yards
    #    FACT (pilot): record routing only + stubbed tool-loop answer
    # 4. engine_ref = generate_recommendation(intel, distance, bag, handicap, weather,
    #       shot_bearing=resolved.shot_bearing_deg)  — the correctness oracle
    # 5. det_checks (§5a), cost/latency bookkeeping
```
`synth=None` means the REAL `synthesize_strategy` (LIVE runs); CI passes a canned-answer
stub. Note `run_strategy_turn`'s in-module cache is keyed on ground-truth bytes — distinct
positions/winds produce distinct keys, so cases never cross-contaminate; the runner clears
`strategy._CACHE` at start anyway.

**`render.py`** — the context-pack composite:
```python
def fetch_base_tile(hole_bbox, *, mode: Literal["satellite","vector"], cache_dir) -> Image
def compose(base, fx, resolved, annotations) -> Image   # pure given the base
def render_case(case, fx, resolved, *, mode, cache_dir) -> Path  # PNG per case
```
- **Decision: satellite base for the LIVE pilot judge; vector for CI.** The owner's flow
  is a screenshot of the app map (Google satellite + overlays) — the judge must see
  essentially that, so the pilot uses Google Static Maps (`maptype=satellite`,
  `size=640x640&scale=2`, centered on the hole bbox) with our overlays drawn on top:
  player-position pin, green/target, hazard polygon outlines from OUR geometry, the
  centerline, and distance annotations (yardage-to-green, wind arrow + speed, hole/par
  header — the "map + hole number + course + wind + yardage left" the owner listed).
  A pure-vector render (same overlays on a neutral background) is the offline/CI
  substrate and the diffable artifact; it is NOT judge-equivalent (no tree/texture
  context) and is not used for the pilot's judged scores.
- **Tile cost:** Static Maps ≈ **$2 per 1,000 requests**. Tiles are per-HOLE, not
  per-case: ~2 framings per hole (full-hole + approach zoom) × 9 holes ≈ 18 requests ≈
  **$0.04**, cached forever in `runs/tile_cache/` keyed by (hole, center, zoom, mode).
  Even the full-1000 run adds zero tile cost (same holes). Composites are drawn with
  **Pillow** — add to backend dev-dependency group only (flag in PR; test-only).
- Key handling: `GOOGLE_MAPS_KEY` read from env at call time, never logged, never in the
  cache filenames or PNG metadata.

**`judge.py`** — mirrors the owner's ChatGPT-5.6-Sol flow exactly:
```python
def judge_prompt(case, resolved, engine_ref, answer, det_summary) -> tuple[str, list[content]]
async def judge_case(...) -> JudgeScores        # Responses API, image + text, strict json_schema
async def second_pass_if_needed(first: JudgeScores, ...) -> tuple[JudgeScores|None, bool]
```
Model: `gpt-5.6-sol` WITH the satellite composite image + a structured facts block
(course, hole, par, card yards, wind preset, lie + exact yardage left, the player's bag +
handicap, and the ENGINE REFERENCE solve: club, target/raw yards, reachability/shot_kind,
miss side + per-side hazard evidence, carries list). The judge is instructed: the engine
numbers are REFERENCE, judge the ANSWER's quality/coherence against the map and facts;
set `engine_looks_wrong=true` (with reason) when the reference itself contradicts the
map — this is how the bench catches ENGINE bugs, not just prose. Structured output
(strict JSON schema), one `failure_class` from the CLOSED taxonomy. Reasoning effort
`medium` for the judge (it is NOT latency-bound like the synth). Full rubric in §5.
**Second pass:** triggered when (a) any dimension confidence < 0.6, (b) the judge PASSES
a case a deterministic check FAILED (or vice-versa on overlapping dimensions), or (c) a
canary case scores GOOD. Re-judged once with the facts-first/answer-last ordering swapped
(cheap position de-bias); persistent disagreement marks `contested=true` — reported
separately, never averaged away.

**`report.py`** — pure: `runs/<id>/results.jsonl` → markdown. Sections: run header
(models, effort, case counts, $ total, wall time); headline table (per-dimension pass
rates, weighted correctness score, degraded-rate, contested-rate, canary outcome);
failure-class Pareto (count × question_type × lie × hole); per-hole table; worst-10 case
gallery (downsized composites copied into `specs/assets/caddie-bench/` — only these ~10
images are committed, the rest stay gitignored); engine-flagged cases
(`engine_looks_wrong`) listed verbatim; cost log summary; delta section (vs a prior run
id, for the iteration loop).

**`run_caddie_bench.py`** — the LIVE runner, same three guards as `run_tier2.py`:
filename doesn't match `test_*.py` (pinned in `test_bench_teeth.py`), refuses without
`CADDIE_EVAL_LIVE=1` **and** `OPENAI_API_KEY`, no CI workflow invokes it. Plus:
`--budget-usd` (pilot default **40.00**) enforced before every synth/judge call with a
refuse-unknown-model pricing table (add `gpt-5.6-sol` pricing from OpenAI's published
page at build time — the table raises rather than guessing $0, same as
`run_tier2._PRICING_PER_MTOK_USD`); `--max-cases`, `--only-failures <run_id>`,
`--holes`, `--resume <run_id>` (per-case JSONL is appended case-by-case; resume skips
completed case ids — case-level resumability); writes
`runs/<run_id>/{results.jsonl, costs.jsonl, composites/}` — all gitignored, all key-free.
Cost log line per call: `{case_id, call: synth|judge|judge2, model, input_tokens,
output_tokens, usd}`. Exit codes mirror run_tier2: 0 pass-bar met / 1 missed / 2 gate
refusal / 3 budget abort.

---

## 2. Pilot hole list (reconciled to geometry that actually exists) + case math

All Bethpage geometry assembles OFFLINE from the committed
`tests/fixtures/bethpage_overpass.json` (Black validated 18/18 pars vs the published card
in `test_bethpage_validation.py`; Red already assembled in
`test_tee_club_expected_strokes.py`). Pebble 3 / Pine Valley 9 are committed prod-geometry
fixtures. One optional read-only prod extraction adds a true water-pinch hole.

| # | Hole | Par/Yards | Why it's in the set |
|---|------|-----------|---------------------|
| 1 | Bethpage Black 4 | 5 / 517 | Classic risk-reward par 5, cross-bunker carry |
| 2 | Bethpage Black 5 | 4 / 478 | Long dogleg with REAL corner trees (audit: legit bend-cap) |
| 3 | Bethpage Black 7 | 5 / 553 | Biggest real dogleg in the audit (110y dev) — corridor/club selection |
| 4 | Bethpage Black 8 | 3 / 210 | Par-3 coverage (no tee-shot positioning path) |
| 5 | Bethpage Black 18 | 4 / 411 | Open/straight control hole — should be a plain driver call |
| 6 | Bethpage Red 6 | 4 / 287 | Short par-4 reachability boundary + legit bend-cap for default bag |
| 7 | Bethpage Red 16 | 5 / 499 | Dogleg-right par 5 w/ corner-tree evidence (audit q=Y) |
| 8 | Pebble Beach 3 | 4 / 381 | Committed prod fixture; dogleg-left; the audit's cleared bogus-cap hole |
| 9 (opt) | Muirfield Village 14 | 4 / ~363 | Water pinch (3y gap at ~306y, audit-verified) — ONE read-only prod extraction |

(Pine Valley 9 — par 5 / 554, committed fixture — is the first bench-expansion hole if
#9 can't be extracted this cycle; it covers the extreme-layup class instead of water.)

**Case-count math (~150):**
- 8 core holes: 7 par-4/5 holes × 6 positions (TEE, FAIRWAY-prime, FAIRWAY-layup-decision,
  ROUGH, BUNKER, RECOVERY_TREES or GREENSIDE) + par-3 Black 8 × 4 positions
  (TEE, GREENSIDE, BUNKER, ROUGH) = **46 position-holes**
- × 3 bags (OWNER hcp 3.0 / SHORT_HITTER hcp 20 / BOMBER hcp 8) = **138 ADVICE cases**
  (question type matched to position; phrasing drawn deterministically from the bank;
  wind preset assigned round-robin CALM/CROSS_15/INTO_20 — conditions rotate rather than
  multiply)
- + 8 FACT-class cases (one per hole; routing + reduced rubric) = 146
- + 4 canary (poison-pill) cases with deliberately bad canned answers the judge MUST
  fail = **150 judged cases, 146 synth calls**

**Player bags** (`fixtures/bags.json`):
- `OWNER` — the verified real bag from `test_corner_tree_forward_bound.py::_OWNER_BAG`
  (driver 300 … lw 90, no hybrid/5wood), handicap 3.0 (the one populated prod
  `golfer_profiles.handicap_index`). *Owner: please confirm this is still current.*
- `SHORT_HITTER` — driver 210, 3wood 195, 5wood 180, 4h 170, 6i 145, 7i 135, 8i 125,
  9i 115, pw 105, sw 80, lw 60; handicap 20.
- `BOMBER` — driver 320, 3wood 285, 3i 240, 5i 220, 7i 190, 9i 165, pw 150, gw 135,
  sw 118, lw 95; handicap 8.

---

## 3. Offline construction (the no-DB contract)

Per case: fixture JSON → `hole_intel_from_fixture` (hazards/bend/corridor/green
geometry/approach bearing, par + card yards from the fixture) → `build_session` (bag,
handicap, wind preset as `WeatherConditions`) → `run_strategy_turn(session, "bench",
"bench-user", n, distance_to_green_yards=<haversine position→green>)`. The two DB writes
in the payload chain (`sessions.set_recommendation`, `memory_mod.get_player_profile`) are
stubbed exactly as `conversation_runner.py` does. This gives: determinism (seeded
positions, versioned phrasings, byte-stable ground truth), CI-friendliness (the whole
pipeline minus synth/judge/tiles runs in `uv run pytest`), and case-level resumability.
Confirmed workable — this is the same construction three existing test files already use.

---

## 4. Renderer decision & cost (summary of §1 `render.py`)

Satellite composite (Google Static Maps + Pillow overlays) for the judged pilot — it is
what the owner literally photographs; vector render for CI/diffing. Tile cost ≈ $0.04
total (18 cached per-hole tiles); Pillow added as a dev-only dependency.
**Screenshot-fidelity proof:** 3-5 pilot positions on Bethpage Red (the diag build's
course) — `xcrun simctl location … set lat,lng`, screenshot, montage side-by-side with the
composite for the same case; committed to `specs/assets/caddie-bench/sim-vs-render-<n>.png`
and embedded in the report. Steps scripted in `sim_screenshots.md` (reuses
`ops/harness/oncourse-sim/README.md` verbatim for build/launch; use `/tmp/simspm`, never
`/tmp/looper-spm`).

---

## 5. Judge rubric, deterministic checks, anti-gaming

### 5a. Deterministic pre-checks (code, never the judge — cannot flake, cannot be charmed)
Run on every answer before judging; reuse existing machinery, never fork:
- `hazard_only_from_input` / `side_flip` / injection — `validate_strategy_text` components
- `club_matches_engine` — named club (via `substance.py`'s extractor — the ONE club-regex
  family) vs `engine_ref.club`
- `numbers_close` — every yardage extracted from the answer must bind to the engine solve
  and close arithmetically (carry + leave ≈ distance, ±5y) — the numbers-coherence memory
- `positioning_no_pin_language` — `_PIN_RELATIVE_PATTERN` on `shot_kind == "positioning"`
  (the 2026-07-06 owner incident class)
- `length_caps` — sentence count / char cap. **Verbosity is judged ONLY here** — the LLM
  judge is explicitly told length is out of scope, so a long hedgy answer can never
  outscore a concise correct one (run_tier2's proven rule).
- `degraded_flag` recorded (a degraded engine-line answer is scored, but reported in its
  own column — reliability is a metric, not a judge dimension).

### 5b. Judge dimensions (0/1/2 + confidence each) — owner's 8 crux + failure memories
Correctness axes (drawn from known caddie failure memories, weighted 2× in the headline
score): **NUMBERS_COHERENCE** (every spoken number binds to ONE per-turn solve; distances
close; a challenged number is re-derived, never confabulated), **SHOT_REACHABILITY**
(out-of-reach tee shot ⇒ landing-zone + leave-yardage reasoning, NEVER flag-relative aim),
**MISS_SIDE_EVIDENCE** ("left is safe" must be backed by per-side hazard evidence visible
on the map — no safe-side claims into trees), **CLUB_CORRIDOR** (club respects dogleg
bend/corridor geometry — not reflexive driver), **HAZARD_AWARENESS** (in-play hazards on
the line acknowledged), **WIND_AWARENESS** (non-calm presets must shape the answer).
Owner's crux dimensions: **ANSWERS_THE_QUESTION** (integrated/relevant),
**STRATEGIC_DEPTH** ("smart" — a reason, not a readout), **NATURAL_SPEECH**
(flowing/non-robotic), **NON_REPETITIVE** (no dupes within the answer).
(Owner cruxes "consistent" → the existing `run_consistency.py` probe re-pointed at bench
cases; "reliable" → degraded-rate metric; "minimal loading" → latency p50/p95 metric —
all reported, none LLM-judged.)
Plus one `failure_class` from the CLOSED taxonomy (`wrong-side / bad-club / missed-hazard /
ignored-wind / wrong-numbers / vague / fabricated / not-answered / good`) and
`engine_looks_wrong: bool` (the engine-bug catcher).

### 5c. Anti-gaming (reviewer probe targets)
- Verbosity never LLM-judged (5a); rubric text states concise-correct > long-hedgy.
- Positions hard-verified inside their claimed lie polygon at sample time (raise, never
  mislabel) — and `test_bench_offline.py` re-verifies every pilot case's containment.
- Phrasing bank generated once, deduped, committed, versioned — deterministic thereafter.
- 4 canary cases with known-bad answers: a judge that passes ANY canary fails the RUN
  (exit 1) — the judge itself has teeth.
- Answer wrapped as untrusted data + `_looks_like_injection` pre-scan (reuse run_tier2's).
- Judge ≠ synth conversation: separate calls, judge never sees the ground-truth PROMPT
  (only facts + map + engine reference), so it can't grade "did it copy the prompt".

---

## 6. Gates (what proves the framework before/without spending)

1. **G1 — offline tier-1 in CI** (`uv run pytest tests/eval/caddie_bench`): schema +
   question-bank load-time validation; fixture load for all pilot holes; position
   containment for every pilot case; full harness end-to-end with a stubbed synth (canned
   answers) + stubbed judge + vector renderer; report generated from canned results;
   runner gate-refusal (no env ⇒ exit 2) and filename-glob pins. No network, no key,
   no DB, no Docker.
2. **G2 — teeth** (`test_bench_teeth.py`): every 5a check proven RED with a mutant answer
   (flag-aim on positioning ⇒ reachability RED; off-by-40 leave ⇒ numbers_close RED;
   hazard-not-in-list ⇒ RED; wrong club ⇒ RED; side-flip ⇒ RED); sampler teeth (a point
   nudged outside its polygon ⇒ raise); judge-schema teeth (an out-of-taxonomy
   failure_class ⇒ ValidationError); canary logic teeth (all-pass judge stub ⇒ run fails).
3. **G3 — pilot artifacts complete**: `specs/caddie-bench-report-2026-07-22.md` +
   committed worst-10 composites + 3-5 sim side-by-sides + gitignored
   `runs/<id>/{results,costs}.jsonl` present and key-free (grep for `sk-`/`AIza` in
   artifacts = must be empty).
4. **G4 — `cd backend && ruff check .` clean**; existing `tests/eval` suite still green.

---

## 7. Cost discipline

Assumption to pin at build time (pricing table refuses unknown models): `gpt-5.6-sol`
priced near the GPT-5-line (~$1.75/M input, ~$14/M output — VERIFY against OpenAI's
pricing page and hard-code before first live run).
- Synth: ~2.0k in (system + ground truth) + ~130 out ≈ **$0.005/case**
- Vision judge: image ~1.5k tok + facts/rubric ~2.0k + ~350 structured out ≈
  **$0.013/case**; second pass on ~15% ≈ +$0.002/case avg
- Tiles: ~$0.04 total (cached per hole)
- **Pilot (150 cases): ≈ $3.10 + retries margin → budget $8, hard cap `--budget-usd 40`**
- **Full-1000 (follow-up op): ≈ $20-28 → propose cap $60**; zero new tile cost.
Per-call cost log (`runs/<id>/costs.jsonl`, gitignored). Keys (`OPENAI_API_KEY`,
`GOOGLE_MAPS_KEY`, prod `DATABASE_URL`) read from env/secretsmanager in-process only,
never echoed, never written to any artifact.

---

## 8. Iteration protocol (designed this cycle; run in the next)

1. Pilot run → report's failure-class Pareto (class × question_type × lie × hole).
2. Taxonomize: each non-GOOD case gets its judge failure_class + det-check evidence;
   `engine_looks_wrong` cases triaged FIRST (engine bugs beat prose bugs).
3. Fix the TOP failure class only (one change in `app/caddie/*` per iteration; every fix
   lands with a golden-set scenario per the existing eval README rule).
4. `run_caddie_bench.py --only-failures <run_id>` re-runs the failing subset + a fixed
   20-case no-regression sample (seeded, stable across iterations).
5. `report.py --delta <old_run_id>` appends a delta section (per-class before/after).
6. Repeat until the headline correctness score clears the bar the owner sets from the
   first report (recommend: ≥85% weighted-correctness, zero FABRICATED/WRONG_NUMBERS).

---

## 9. Edge cases & risks

- **Judge nondeterminism** — structured output + closed taxonomy + confidence-gated
  second pass + contested-never-averaged + 4 canaries; spot-audit 5 judge reasons per run
  (run_tier2's standing rule).
- **Geometry gaps** — OSM-derived Bethpage lacks per-hole card yardage in geometry
  (yardages injected from published cards, provenance-labeled); some holes have sparse
  bunker mapping — the ground truth says "NONE mapped" honestly and the judge facts block
  says the same, so the answer is judged against what the app can know, not against
  reality the app was never given.
- **Position-in-wrong-lie bugs** — sampler raises on unverifiable containment; CI
  re-verifies all pilot positions (G1); the composite makes mislabels visually obvious.
- **Cost overrun** — hard `--budget-usd` pre-call projection (exit 3 + partial results);
  per-case resumability means an abort loses nothing.
- **Prod-DB discipline** — only `extract_fixtures.py --from-prod` may touch prod, SELECT
  only, gated by `CADDIE_BENCH_EXTRACT=1`, run once, output committed; the bench itself
  never opens a DB connection (no local Postgres exists; Docker Postgres is banned).
- **Key leakage** — keys in-process only; artifact key-grep in G3; tile cache filenames
  key-free; `synthesize_strategy` already logs key-free.
- **`gpt-5.6-sol` drift/availability** — model id is env-overridable
  (`CADDIE_STRATEGY_MODEL` for synth; `CADDIE_BENCH_JUDGE_MODEL` for judge); pricing
  table refuses unknown ids.
- **In-module strategy cache** — cleared at run start; distinct cases have distinct
  ground-truth bytes by construction.

---

## 10. Build sequencing (one builder, with parallelizable seams)

1. **First (foundation, serial):** `schema.py` → `geometry.py` + fixture extraction
   (`extract_fixtures.py --from-overpass`, commit `fixtures/holes/*`) → `bags.json` →
   offline containment tests. *Reviewer gate #1: the case schema + closed registries +
   sampler containment contract.*
2. **Parallelizable after schema lands:** (a) `questions.py` + one gated generation run →
   commit `questions_v1.jsonl`; (b) `harness.py` + stubs + offline harness tests;
   (c) `render.py` vector mode → satellite mode; (d) `report.py` from canned results.
3. **Integration:** `judge.py` → `run_caddie_bench.py` (gating, budget, resume, cost log)
   → `test_bench_teeth.py` completed → G1/G2/G4 green. *Reviewer gate #2: judge rubric
   anti-gaming probe (try to write an answer that games each dimension; canaries must
   catch it).*
4. **Pilot op:** optional `--from-prod` extraction of Muirfield 14 → LIVE pilot run
   (~$8, cap $40) → report → sim side-by-sides → G3. *QA gate: all four gates + report
   sanity read.*
5. Follow-up ops (not this cycle): full-1000 run; live-FACT tier; consistency-probe
   re-pointing; the iteration loop (§8).
