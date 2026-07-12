# Caddie numbers coherence + miss-side grounding (fix plan)

> Owner incidents (both TOP-PRIORITY, screenshots):
> **A — 2026-07 Bethpage BLACK hole 1, par 4, 466y, black tees.** Caddie: "positioning shot… we'll leave
> about 125 in"; challenged, it claims driver ≈ 300 (466−300=166≠125), then confabulates "wind adding
> effective yards it plays longer, that's why we leave about 125" (backwards — longer leaves MORE), then
> quotes a third driver number "280 total, 266 carry" (466−280=186≠125). Separately: "left is the better
> miss" on a hole with trees on BOTH sides (and its own line said "keep it out of those trees on the right").
> **B — 2026-07-12 scope extension, Bethpage RED hole 3, black tees.** Header "PAR 3 · 355 YDS", plays-like 372.
> The app's own map draws a dogleg-left, corner at 226 from tee / 159 to green, trees tight both sides. Caddie:
> "You're gonna need your driver here… favor the left side to stay clear of that bunker right." Driver (~280)
> flies through the corner into trees; "bunker right" is fabricated for the driving zone (bunkers are greenside);
> the dominant hazard (trees) is never named; and a 355y "par 3" implies the stored par is wrong.
>
> This plan is the build contract. Reproduction was done server-side (see §1) with a throwaway script against
> `generate_recommendation` — a faithful synthetic Bethpage-1 `HoleIntelligence` (466y par 4, trees both sides
> at carries 260–305, 300y-driver bag); real DB intel was not reachable from the planning environment.

---

## 1. Traced root cause of each number (reproduced)

### 1.1 The "125" — the engine solved the WRONG DISTANCE: the `/session/recommend` fake `yards=400` default

The realtime orb's `get_recommendation` dispatch (`frontend/src/lib/voice/realtime.ts:96-107`) sends only
`{round_id, hole_number, distance_yards?}` to `POST /caddie/session/recommend`
(`frontend/src/lib/caddie/api.ts:220-226` → `backend/app/routes/caddie.py:579-596`).
`SessionRecommendRequest` (`backend/app/caddie/types.py:186-196`) declares **`yards: int = 400`**, and
`recommend_payload` (`backend/app/caddie/tools.py:257-298`) computes `distance = distance_yards or yards`
— **`session.hole_intel[hole].yards` is never consulted on this HTTP path.** The
no-fake-400 fix from `specs/caddie-yardage-gps-selected-tee-plan.md` §2.4 was applied ONLY to the text
tool loop (`tools.py::resolve_tool:856-888`, via `ctx.current_yardage`/`intel.yards`), NOT to the HTTP
endpoint the orb dispatches through. So when the realtime model calls `get_recommendation` without an
explicit `distance_yards` (the normal tee-shot call), the whole solve runs on **400**, while the model's
hole-context anchor (`buildHoleContextText`, `frontend/src/lib/caddie/opening-turn.ts`) told it the hole
is **466 from the black tees**.

Reproduced (`generate_recommendation`, 300y-driver bag):

| input distance | conditions | adjusted (plays-like) | leave_yards spoken |
|---|---|---|---|
| 400 (the fake default) | still air | 400 | 100 |
| 400 | ~5–6 mph headwind | ~425–434 | **125–135** |
| 425 (e.g. another tee's card #) | still air | 425 | **exactly 125** |
| 466 (the truth) | still air | 466 | 165 |
| 466 | 6 mph headwind | 506 | 205 |

`leave_yards = round(max(0, adjusted_yards - club_dist)/5)*5` (`aim_point.py:411`) with `club_dist` = the
stored driver (300). The leave math itself is internally coherent — **the input distance is the corruption**:
125 = an adjusted ≈425 solve, i.e. the fake 400 plus ~25y of real wind/elevation plays-like (primary,
structural, reproduced), or a model-passed stale/different-tee ~425 (secondary candidate; Bethpage cards list
hole 1 in the 420s–430 from other tees). Either way the number spoken beside "466" was solved from a
distance that was not 466.

### 1.2 The "300" — the raw bag number narrated from the prompt

`voice_prompts.py::_situation_block:170-177` injects `Player clubs: Driver: 300y` (the stored bag number,
still-air). The model narrates it as "your driver goes about 300" with no binding to the engine's leave.

### 1.3 The "280 total / 266 carry" — a real physics answer under the day's wind

`get_shot_distance` (`tools.py::shot_distance_payload:649-798` → `physics.shot_distance_for_club`)
reproduces exactly this shape: a 300-stored driver under a ~5–6 mph headwind returns **carry ≈263–266,
total ≈276–280** (measured: 6 mph head → carry 263 / total 276). So the third number was honest physics —
but in a third frame (conditions-adjusted total) never reconciled with the bag's 300 or the leave's implied 300.

**Conclusion:** three truthful-in-isolation sources — leave from a wrong-input engine solve, driver-300 from
the prompt bag line, 280/266 from the physics tool — with no shared payload and no rule requiring the
arithmetic to close. The confabulated "wind makes it play longer, that's why we leave LESS" is the LLM
papering over the gap; nothing in the prompt forbids that today.

### 1.4 The miss-side "left is better" — a tie breaks to left, confidently

`aim_point.py::compute_positioning_miss_side:316`: `if left_score <= right_score: preferred="left"`.
Reproduced: trees both sides in the drive zone, equal severity → `preferred='left'`, description
**"Favor the left side off the tee — right has trouble in the driving zone"**. A dead tie (trees both
sides — exactly Bethpage 1) is spoken as a confident one-sided preference. (`decade_landing_advice`
returns `None` on the symmetric case — center is optimal — so `aim` says "middle of the fairway", which
then contradicts the miss line.) With one-sided tree *detection* (e.g. one side's OSM observations below
`_TREE_MIN_OBS=3`, `hazards.py:113`), `decade_landing_advice` produces the incident's "favor the left
half of the fairway — trees … on the right" while the left tree wall exists but is invisible to the engine.

### 1.5 Scope-extension traces (Bethpage RED 3)

- **"Driver by default":** on the positioning path `select_club(adjusted_yards, clubs, bias="moderate")`
  (`aim_point.py:398-400`) picks the best fit for a 372-plays-like target = the longest club = driver,
  with zero corridor awareness. The bend IS known (`HoleIntelligence.bend`, extracted by
  `hazards.py::extract_hole_bend` — the same data the map renders as corner@226) but nothing consults it
  for CLUB, only for a P2 color line (`aim_point.py:478-489`).
- **Fabricated "bunker right":** greenside bunkers appear in the hole-wide hazards line
  (`format_hazards_line`, carries ~350) and in `compute_miss_side`-style green-frame data; on a
  positioning shot the drive-zone payload correctly EXCLUDES them (`drive_zone_hazards` window
  advance−50..advance+30), but no rule forbids the model from re-locating a hole-anywhere hazard into
  the driving zone. Trees: **verified** — tree/woods OSM polygons DO become `Hazard(type="trees",
  line_side, carry_yards)` entries (`hazards.py` tree-observation model, `_tree_hazard:630`) and DO pass
  `drive_zone_hazards` (reproduced). If RED 3's stored features lack woods polygons, the honest-empty
  discipline applies (verify during build; do not fabricate).
- **Strategy guide ("the research of the hole"):** **already wired, both mouths** — realtime
  `_situation_block` (`voice_prompts.py:193-195` via `format_guide_line`) and session-text context
  (`routes/caddie.py:731-733`), populated by course-intel with read-time re-validation
  (`routes/caddie.py:1274-1275`). It reaches the model ONLY when `intel.strategy_guide` is cached; guides
  exist for Bethpage Black + Pebble only. **Bethpage RED has no guides — coverage gap, flagged as
  follow-up (no mass generation this cycle; API spend).** Add the missing regression test (§7 T-G) so the
  wiring can't silently break.
- **Par 3 · 355:** the par shown/injected comes from `round.holes[i].par` (frontend round setup — GolfAPI
  scorecard via `backend/app/routes/golf.py` / `frontend/src/lib/golf-api.ts`, or mapped-course data via
  `osm_ingest`) and rides into `HoleIntelligence.par` through the course-intel request
  (`RoundPageClient.tsx:795`). The DB value could not be verified from the read-only planning environment
  — **builder must verify** (§5.3) and fix at the source; a data-independent sanity guard ships regardless.

---

## 2. DEFECT A fix — ONE authoritative tee-shot numbers payload

### 2.1 Kill the wrong input first (root cause of 125)

1. `backend/app/caddie/types.py:186-196` — `SessionRecommendRequest.yards: int = 400` →
   `yards: Optional[int] = None` (and `par: int = 4` stays; it only defaults intel-less holes).
2. `backend/app/caddie/tools.py::recommend_payload` — resolve distance with the SAME ladder as
   `resolve_tool` (`tools.py:867-888`): `distance = distance_yards or yards or (intel.yards if intel else None)`;
   when all are `None`, return the same honest error dict `{"error": "No distance known for this hole yet — ask
   the player how far they have, or call get_conditions first."}` instead of solving 400. (The
   `/session/recommend` route returns it verbatim; the orb model already knows how to handle tool errors.)
   `hole_intel.yards` is trustworthy here because course-intel now receives the selected-tee snapshot
   (`RoundPageClient.tsx:797-801`, spec §2.4 wiring — verified present).
3. Frontend: `realtime.ts::dispatchTool` ctx gains the resolved yardage the live session already knows —
   `ctx: { roundId, holeYards?: number|null, yardageBasis?: string|null }` (supplied by
   `useCaddieLiveSession`, the same values it feeds `buildHoleContextText`); `get_recommendation` passes
   `yards: ctx.holeYards ?? undefined`. `sessionRecommend` (`api.ts:220`) already accepts `yards`.
   Now the orb's engine solve and the orb's narration anchor are the same number by construction.

### 2.2 The one-solve payload — `TeeShotNumbers`

New pydantic model in `backend/app/caddie/types.py` (beside `CaddieRecommendation`), plus a new defaulted
field `CaddieRecommendation.tee_shot_numbers: Optional[TeeShotNumbers] = None` (additive-field convention —
older cached `last_recommendation` JSONB still validates):

```python
class TeeShotNumbers(BaseModel):
    """ONE authoritative numbers block for a positioning/tee-shot turn.
    Invariant (tested): to_green_yards - drive_total_yards == leave_exact_yards, EXACTLY."""
    hole_number: int
    to_green_yards: int            # the raw distance the engine solved (466) — rec.raw_yards
    yardage_basis: Optional[str] = None   # 'gps' | 'tee-card' | 'tee-geom' | 'card' | None (provenance label)
    plays_like_yards: int          # rec.target_yards (physics plays-like of to_green_yards)
    club: str                      # selected club key ("driver")
    club_stored_yards: int         # the bag number (300) — still-air stored distance
    drive_carry_yards: Optional[int]  # physics carry under today's conditions (266)
    drive_total_yards: int         # physics total under today's conditions (276); == stored in competition_legal
    leave_exact_yards: int         # to_green_yards - drive_total_yards, floored at 0 — closes EXACTLY
    leave_yards: int               # round-to-5 of leave_exact (the calm spoken number)
    leave_plays_like_yards: Optional[int] = None  # what that approach plays like (labeled extra, never the primary leave)
```

**Computed in ONE place:** a new pure helper `compute_tee_shot_numbers(...)` in
`backend/app/caddie/aim_point.py`, called from `generate_recommendation` on the **positioning path only**
(reachable/approach turns keep today's behavior; `tee_shot_numbers=None`):

- `to_green_yards = distance_yards` (raw), `plays_like_yards = adjusted_yards` — the numbers already in scope.
- Drive physics — **same source as `get_shot_distance`, by construction**:
  `cond, _ = physics.conditions_from_weather(weather, shot_bearing, elevation_delta_ft=hole.elevation_change_ft,
  carry_hint_yards=float(club_dist))`, then `r = physics.shot_distance_for_club(club, float(club_dist), cond)`
  → `drive_carry_yards=round(r.carry_yards)`, `drive_total_yards=round(r.total_yards)`. In
  `competition_legal` mode: **no environmental physics** — `drive_total_yards = club_stored_yards`,
  `drive_carry_yards = None` (USGA-conforming: raw numbers only).
- `leave_exact_yards = max(0, to_green_yards - drive_total_yards)`; `leave_yards = round(leave_exact/5)*5`;
  `leave_plays_like_yards = round(max(0, adjusted_yards - club_dist)/5)*5` (today's number, now a labeled extra).
- **`CaddieRecommendation.leave_yards` (existing field) and the aim description now speak the payload's
  `leave_yards`** (raw-closing frame) instead of the plays-like frame. These agree within ±5 in ordinary
  conditions (plays-like identity, see `specs/caddie-shot-context-reachability-plan.md` §1), but the raw
  frame is the one the golfer's own arithmetic uses ("466 with a 280 drive leaves 186") — that is the frame
  the challenge happens in, so it is the frame we speak. `test_positioning_shot.py`'s pinned leave values
  (T1 `==150` etc.) remain valid in still air (physics neutral round-trip is ±1–2y, then round-to-5); if a
  pinned value legitimately shifts by one 5y step under this documented redefinition, update the expectation
  IN THE SAME COMMIT with a comment citing this spec — that is a spec-driven semantic change, not
  test-fudging.
- `yardage_basis`: plumb through — `SessionRecommendRequest` gains `yardage_basis: Optional[str] = None`;
  frontend dispatch passes `ctx.yardageBasis`; text loop passes the request's basis via `ToolContext`
  (add `current_yardage_basis: Optional[str] = None` beside `current_yardage`).

### 2.3 One formatter, both mouths

New pure renderer in `voice_prompts.py` (exported; single wording source):

```python
def format_tee_numbers_line(n: TeeShotNumbers) -> str:
    # e.g. "Tee-shot numbers for hole 1 (AUTHORITATIVE — they close: 466 − 276 = 190):
    # 466 to the green (black-tee yardage); plays like 506 today; driver — 300 stored,
    # carries 266 and totals 276 in these conditions; leaves about 190 (plays like ~206).
    # Speak ONLY these numbers for this tee shot."
```

- Realtime: `_situation_block` (`voice_prompts.py:198-203`) — when
  `session.last_recommendation.tee_shot_numbers` is present, REPLACE today's bare
  `Last recommendation: {club} to {target_yards}y, …` line with
  `Last recommendation: {club}. {format_tee_numbers_line(...)} aim: {…}, miss: {…}` — the incoherent
  juxtaposition ("Driver: 300y" bag line vs "to 425y" solve) is gone because the block carries every frame,
  labeled, closing.
- Text mouth: same substitution at the twin site `routes/caddie.py:756-760` (the
  `_build_session_voice_prompt` context) — import the formatter, never restate the wording.
- The payload also reaches both mouths raw via `recommend_payload → rec.model_dump()` (tool result), so the
  model sees identical numbers in the tool result and in the situation block.

### 2.4 The prompt contract — `NUMBERS_COHERENCE_RULE`

New constant in `backend/app/caddie/voice_prompts.py`, directly below `POSITIONING_SHOT_RULE`, same register:

```python
# Numbers-coherence rule (owner incident 2026-07, Bethpage Black hole 1,
# 466y par 4: the caddie said "leaves about 125" beside a 300y driver and a
# 466y hole — three numbers from three sources that don't close — then
# invented wind physics to defend them. Shared by BOTH mouths so wording
# never drifts.
NUMBERS_COHERENCE_RULE = (
    "For a tee shot or positioning shot there is ONE set of true numbers: the "
    "recommendation's tee-shot numbers block (hole yardage, plays-like, the "
    "club's expected carry and total in today's conditions, and the leave). "
    "Speak those numbers verbatim and no others — never quote a driver "
    "distance, hole yardage, or leave that is not in that block, and never "
    "derive your own. The leave you say MUST be the block's leave: hole "
    "yardage minus the drive's expected total, the same numbers, closing "
    "exactly. If the player challenges the arithmetic, re-derive it out loud "
    "from the block and correct yourself ('466, driver totals about 276 "
    "today, so 190 left — I misspoke earlier'). Admitting a wrong number and "
    "restating the right one ALWAYS beats explaining the wrong one — never "
    "invent wind, roll, or 'effective yards' to make mismatched numbers work. "
    "And keep the direction of physics honest: a hole playing longer leaves "
    "MORE after the drive, never less."
)
```

Wired exactly like `POSITIONING_SHOT_RULE`: appended in `build_realtime_instructions`
(`voice_prompts.py:141-150`) AND both `stable_text` blocks (`routes/caddie.py:783-808`, `1434-1457`) +
imports (`routes/caddie.py:33-39`); registered in `backend/tests/eval/schema.py:88-92`
(`_VALID_RULE_NAMES`) and `backend/tests/eval/checks.py:178-187` (`_RULE_TEXT`).

---

## 3. DEFECT B fix — miss-side grounded in per-side drive-zone evidence

### 3.1 Engine: honest degradation in `compute_positioning_miss_side` (`aim_point.py:291-329`)

Replace the bare `left_score <= right_score` tie-break:

- **Both-sides / tie case** (`left_score > 0 and right_score > 0 and left_score == right_score`):
  return `MissSide(preferred="center",
  description="Trouble both sides in the driving zone — {types} left and right. No good miss; commit to the fairway.",
  avoid="Don't favor either side — the fairway is the only safe ground")` — Bethpage 1's honest line.
  (`preferred="center"` is already the model default in `types.py:212`; frontend consumers render the
  string, no UI change.)
- **Clear winner** (scores differ): keep today's preference, but when the preferred side ALSO has hazards,
  the description must say so: `"Favor the {preferred} side — {worst_side} is worse ({types}), but {types}
  {preferred} are in play too."` Never a clean "favor X" when X has mapped trouble.
- **One side empty**: unchanged preference, unchanged honest wording (it names the trouble side's evidence,
  never claims the other side is "safe" — an empty side may simply be unmapped).
- **Coherence bind:** on the both-sides/center case, `compute_positioning_aim`'s side clause must be
  "middle of the fairway" (already the `landing_advice=None` outcome for symmetric hazards; add an explicit
  guard: if `miss.preferred == "center"`, ignore any lateral `landing_advice` clause so aim and miss can
  never point different ways).

### 3.2 The prompt contract — `MISS_SIDE_GROUNDING_RULE`

New constant beside `NUMBERS_COHERENCE_RULE`, same wiring (both mouths + eval registry):

```python
# Miss-side grounding rule (owner incidents: Bethpage Black 1 — "left is the
# better miss" on a hole with trees BOTH sides; Bethpage Red 3 — "that bunker
# right" fabricated in a driving zone whose real hazard was trees). Shared by
# BOTH mouths so wording never drifts.
MISS_SIDE_GROUNDING_RULE = (
    "Never declare a better miss side the hazard data doesn't support. The "
    "miss side you speak must be the recommendation's miss side, backed by "
    "the hazards listed for THIS shot's landing distance — never your own "
    "read of the hole. If the data shows trouble on both sides, say exactly "
    "that ('trees both sides — no good miss, commit to the fairway'); never "
    "pick a side to sound decisive. If one side has no mapped data, do not "
    "call it safe — data absence is not safety. When you name a hazard on a "
    "tee shot, it must be one whose distance puts it in play for THAT swing: "
    "never relocate a greenside bunker into the driving zone, and never name "
    "a hazard type the data doesn't list."
)
```

### 3.3 Bethpage-1 hazard data per side

Not directly readable from the planning environment (live DB intel unavailable). Code-verified: OSM
woods/tree polygons DO reach the drive zone as per-side `trees` hazards when stored features exist
(§1.5). The reproduced engine behavior on a faithful trees-both-sides fixture is the §1.4 tie→left bug.
**Builder verification step:** hit `/caddie/course-intel` (staging) for Bethpage Black and log
`extract_hole_hazards` output for hole 1 — confirm `trees` entries on BOTH `line_side`s with carries in
the 240–320 window; if one side is missing (observation count < `_TREE_MIN_OBS=3`), record it in the PR —
that is the §1.4 "one-sided detection" variant and the center/no-good-miss degradation plus the rule's
"absence ≠ safety" clause is the designed mitigation (widening tree extraction is NOT in scope).

---

## 4. Scope extension (eng-lead 2026-07-12) — what ships THIS cycle vs follow-up

**Explicit scoping call:** THIS cycle ships §2 (numbers), §3 (miss-side + trees grounding), §4.1
(corridor v1 = bend-cap), §4.2 (guide test), §4.3 (par sanity). The FULL corridor-width club selection is
a fully-specified follow-up (§4.4) — the polygon-sampling geometry deserves its own cycle; the bend-cap
covers the reported failure (driver through a mapped corner into trees) with data we already trust.

### 4.1 Corridor v1 — bend-aware club cap (THIS cycle)

In `generate_recommendation`, positioning path, after `select_club` and the drive-physics solve (§2.2):

```
cap when: hole.bend is not None and not bend.straight and bend.distance_yards
          and bend.distance_yards >= 120
          and drive_total_yards > bend.distance_yards + CORNER_OVERSHOOT_TOLERANCE_YDS (10)
          and any tree/woods hazard with carry_yards >= bend.distance_yards - 20 (either side, severity >= moderate)
then:     re-select club = longest club whose CONDITIONS TOTAL lands <= bend.distance_yards - 5
          (walk the bag descending, re-running shot_distance_for_club per candidate; competition_legal
          walks stored numbers), recompute zone/landing_advice/miss/TeeShotNumbers with the capped club,
          and append P1 reasoning: f"{old_club_display} runs through the corner at ~{bend.distance_yards}
          into the trees — {new_club_display} keeps you short of it, leaves about {leave_yards}."
```

- Red-3 shape: corner@226, trees both sides, driver total ~280 → caps to the ~200–220 club, leave ~150–160
  — exactly the owner's read. Honest degradation: `bend is None` (centerline unmapped) or no corner-zone
  trees → no cap, no fabricated corridor claim. The tree-evidence gate keeps normal cut-the-corner doglegs
  (no tree wall) on today's behavior.
- "Driver by default" dies structurally for mapped corners; unmapped holes still get driver + the
  MISS/HAZARD rules' honesty.

### 4.2 Strategy-guide consumption (THIS cycle: test only)

Wiring verified present (§1.5). Add regression test T-G (§7). Bethpage RED guide generation = follow-up
(coverage gap; costs API spend; NOT this cycle).

### 4.3 Par-data sanity (THIS cycle: guard + verification; data fix where the trace lands)

- **Guard (data-independent):** in the shared yardage/context formatters (`_format_yardage_line`,
  `routes/caddie.py:602`, and `buildHoleContextText`'s backend twin `_situation_block` hole line): when
  `par == 3 and yards > 280` → append `"— the card says par 3 but at {yards} yards this is a two-shot
  hole; treat the par as suspect and never lean on it"`. Threshold 280: no real par 3 plays 280+ from any
  normal tee; longest famous ~250s stay clear.
- **Verification + source fix (builder):** query the stored course data for Bethpage Red hole 3
  (read-only: golfapi cache tables / mapped course rows via `backend/app/routes/golf.py` paths, on
  staging) — report actual par+yardage in the PR. Trace origin (GolfAPI scorecard import vs OSM `par`
  tag in `osm_ingest.py`); if wrong at ingest, fix the ingest/mapping; if wrong upstream (GolfAPI), add
  the correction path and file it. Scope clearly: the guard ships regardless; the data fix goes wherever
  the trace lands and may ride a follow-up if it's upstream-vendor data.

### 4.4 FOLLOW-UP (fully specified, next cycle): corridor-width-aware club selection

Pure helper `corridor_profile(hole, candidate_totals: list[int]) -> list[CorridorSample]` in
`hazards.py`-adjacent module: for each candidate landing distance d, effective corridor half-width =
min lateral offset of tree/woods/water observations within ±20y of d per side (the tree-observation
lateral offsets already computed in `hazards.py::_tree_hazard` inputs), defaulting to honest `None` when
a side has no observations. Club choice: longest club whose landing window (±1.5·`dispersion_for_handicap`
lateral sigma at that distance) fits inside the corridor with both sides mapped; corridor unmapped →
today's behavior. Extend `TeeShotNumbers` with `corridor_width_yards: Optional[int]` +
`corner_distance_yards: Optional[int]`. Tests: narrowing-corridor fixture flips driver→iron as width
shrinks; unmapped corridor unchanged. Owner acceptance: Red-3 replay recommends the corner club with
width evidence spoken. This section is the contract — no re-plan needed.

---

## 5. Shared-shape sync

- `backend/app/caddie/types.py`: `TeeShotNumbers` (new), `CaddieRecommendation.tee_shot_numbers`
  (defaulted), `SessionRecommendRequest.yards → Optional[int]=None`, `+ yardage_basis`.
- `CaddieRecommendation` does NOT live in `backend/app/models.py` / `frontend/src/lib/types.ts`
  (grep-verified; same verdict as the reachability plan §4). Mirror is
  `frontend/src/lib/caddie/types.ts:22` — add:
  `tee_shot_numbers?: { hole_number: number; to_green_yards: number; yardage_basis?: string|null;
  plays_like_yards: number; club: string; club_stored_yards: number; drive_carry_yards?: number|null;
  drive_total_yards: number; leave_exact_yards: number; leave_yards: number;
  leave_plays_like_yards?: number|null } | null;` (optional — no UI change required; CaddiePanel renders
  `aim_point.description` as today. If the designer wants the closing equation on the card later, that's
  additive.)
- `frontend/src/lib/voice/realtime.ts` dispatch ctx (+ `useCaddieLiveSession` supplying
  `holeYards`/`yardageBasis`), `frontend/src/lib/caddie/api.ts` (params already accept `yards`).
- `get_recommendation` tool description (`tools.py:137-155`): append *"The result's tee_shot_numbers block
  is the only source of yardages for a tee shot — its numbers close exactly; speak them verbatim."*
  (module-level constant — update any pinned description strings in `test_caddie_tools.py` /
  `test_realtime_payload.py` in the same commit).

---

## 6. Exact gates

1. **Arithmetic closes:** for every generated `TeeShotNumbers`,
   `to_green_yards - drive_total_yards == leave_exact_yards` EXACTLY (integers), across the §7 T-N matrix;
   `|leave_yards - leave_exact_yards| <= 2`; `plays_like_yards == rec.target_yards`;
   `club_stored_yards == clubs[club]`; competition_legal → `drive_total_yards == club_stored_yards` and
   `plays_like_yards == to_green_yards`.
2. **Prompt contains the rules:** `NUMBERS_COHERENCE_RULE` and `MISS_SIDE_GROUNDING_RULE` present in
   `build_realtime_instructions(...)` output AND both `stable_text` builders (source-level assertion,
   `test_positioning_prompt.py` pattern), and non-empty (the eval harness's emptiness guard applies once
   registered).
3. **Miss-side never contradicts the hazard payload:** trees-both-sides fixture → `preferred == "center"`,
   description contains "both sides", never "Favor the left"; trees-left-only → `preferred == "right"`
   and NEVER "left"; no drive-zone hazards → today's generic (unchanged).
4. **Challenge path:** eval fixture turn "300 plus 125 is not 466" → tier1 `prompt_contains_rule:
   NUMBERS_COHERENCE_RULE`; tier2 `must_not_mention: ["effective yards", "plays longer, that's why",
   "wind adding"]`, `must_mention_any: ["misspoke", "correct", "let me re-", "190"]` (fixture numbers);
   plus unit assertion the rule text contains "re-derive", "misspoke", "never invent".
5. Repo gates: `cd backend && ruff check . && pytest -q` (new + existing suites — `test_positioning_shot.py`,
   `test_aim_point.py`, `test_caddie_tools.py`, `test_realtime_grounding.py`, eval tier-1 all green);
   `cd frontend && npx tsc --noEmit && npm run lint`; voice-tests smoke.

## 7. Regression tests the builder must write

**`backend/tests/test_tee_shot_numbers.py`** (pure, no DB; bag/fixture style of `test_positioning_shot.py`):
- **T-N1 closure matrix:** distances {320, 400, 425, 466, 560} × bags {driver 230, 280, 300, 320,
  empty→defaults} × conditions {still, 6/12mph head, 8mph tail, +40ft up, competition_legal} → gate (1)
  invariants on every cell; reachable cells (e.g. 320 vs 320 driver) → `tee_shot_numbers is None`.
- **T-N2 Bethpage-1 incident pin:** 466y, driver 300, still air → `leave_exact == 466 - drive_total`
  (≈167, exact per physics), spoken leave 165±5, and **125 is unconstructible**: assert
  `generate_recommendation(intel, 466, bag).tee_shot_numbers.leave_yards != 125` and the aim description's
  leave equals the payload's.
- **T-N3 fake-default dead:** `recommend_payload` with `distance_yards=None, yards=None` and
  `intel.yards=466` solves 466 (not 400); with no intel and no yards → the honest error dict, no solve.
- **T-N4 physics parity:** payload `drive_carry/total` == `shot_distance_payload(session, club="driver")`'s
  carry/total for identical session conditions (same-turn no-disagreement, by construction).
- **T-N5 wind direction sanity:** headwind case → `leave_exact` strictly ≥ still-air `leave_exact` (playing
  longer leaves MORE — the confabulation's exact inversion, pinned).

**`backend/tests/test_miss_side_grounding.py`:** gate (3) cases + tie-with-different-types (water L death vs
trees R moderate → preferred right, description names both) + aim/miss coherence (preferred center →
aim clause "middle of the fairway").

**`backend/tests/test_numbers_coherence_prompt.py`** (mirror `test_positioning_prompt.py`, DATABASE_URL
stub-before-import): gate (2) + `format_tee_numbers_line` renders the equation ("466", "276", "190" for the
fixture) + `_situation_block` with a numbers-carrying `last_recommendation` contains the formatter output
and NOT the old bare "to 425y" form + both routes interpolate the two new rules.

**Corridor v1 (`test_corridor_bend_cap.py`):** corner@226 + trees both sides past corner + driver-280 bag →
recommended club total ≤ 221, reasoning names the corner and trees, `TeeShotNumbers` closes for the capped
club; same hole `bend=None` → no cap; corner without trees → no cap.

**T-G guide consumption:** `intel.strategy_guide` set → `format_guide_line` output present in
`_situation_block` AND `_build_session_voice_prompt` context; guide `None` → absent (honest omission).

**Par sanity (`test_par_sanity_guard.py`):** par 3 + 355y → context contains "two-shot hole"/"suspect";
par 3 + 240y → no flag; par 4 + 466y → no flag.

**Eval fixtures** (`backend/tests/eval/caddie_advice.jsonl` + schema/checks registration): (a) the challenge
turn (gate 4); (b) trees-both-sides tee shot → tier2 `must_not_mention: ["left is the better miss",
"favor the left"]`, `must_mention_any: ["both sides", "no good miss", "commit to the fairway"]`; (c) Red-3
shape (dogleg corner + greenside-only bunkers) → `must_not_mention: ["bunker"]` on the tee-shot turn.

## 8. Edge cases + residual risk

- **Reachable/approach turns:** `tee_shot_numbers=None`; NUMBERS_COHERENCE_RULE is scoped to "tee shot or
  positioning shot"; approaches keep plays-like language + `YARDAGE_GROUNDING_RULE`/`PHYSICS_GROUNDING_RULE`.
  The "leave" concept doesn't exist there — no regression of `specs/caddie-shot-context-reachability-plan.md`
  behavior (the flag path stays byte-identical; only the positioning leave's frame and its spoken binding change).
- **competition_legal:** no environmental numbers anywhere in the block (drive_total = stored; plays_like =
  raw) — still closes exactly; the existing P1 competition line already explains why.
- **Unknown driver / empty bag:** `DEFAULT_CLUB_DISTANCES` (same fallback as `select_club`), and the
  formatter labels it ("standard distances — no bag on file") so the caddie never claims "your driver".
- **No mapped hazards:** honest empties everywhere (miss-side generic, no corridor cap, no hazard names) —
  the [[no-fake-data-fallbacks]] discipline unchanged.
- **Stale/selected-tee yardage:** the §2.1 ladder inherits the caddie-yardage-gps-selected-tee resolution
  (GPS > model-explicit > request-resolved > intel selected-tee snapshot; never 400/mock) and
  `caddie-stale-hole-live`'s re-anchor already refreshes the hole context the numbers sit beside;
  `TeeShotNumbers.hole_number` + basis label keep a stale block identifiable.
- **Prompt-cache:** both new rules live in the STABLE blocks (cache-friendly, per-round constant); the
  numbers line lives in the VOLATILE situation block — same split as today.
- **Residual risk (what the LLM can still get wrong):** the realtime speech model can still paraphrase a
  payload number ("about 190" → "call it 200"), still answer before calling `get_recommendation` (mitigated
  by `_BASE_BEHAVIOR`'s never-state-ungrounded-yardage + the tool description, not eliminated), and can
  still mis-hear a challenge; grounding rules are strong nudges on the speech-to-speech path, hard gates
  only on the text path's eval fixtures. GPS mid-hole re-asks reuse the last TEE block until a new
  recommendation is pulled — the rule's per-shot scoping plus the re-anchor bound this, but a fast-moving
  player can hear one-turn-old numbers. These are accepted, documented residuals; telemetry
  (`caddie-realtime-telemetry`) is the watch.
- **NORTHSTAR:** every new spoken string is one calm sentence; the honest lines ("no good miss — commit to
  the fairway", "I misspoke — 190") are exactly the quiet-competent register; nothing visual changes, so no
  designer flag.

## 9. Build order

1. `types.py` (`TeeShotNumbers`, rec field, request fields) + `frontend/src/lib/caddie/types.ts` mirror.
2. §2.1 input fix (`recommend_payload` ladder + honest error; request default; frontend dispatch ctx).
3. `aim_point.py`: `compute_tee_shot_numbers` + positioning-path wiring + leave-frame switch; §3.1 miss-side
   degradation; §4.1 bend cap.
4. `voice_prompts.py`: `format_tee_numbers_line`, `NUMBERS_COHERENCE_RULE`, `MISS_SIDE_GROUNDING_RULE`,
   `_situation_block` substitution; `routes/caddie.py` twin substitution + rule interpolation; tool
   description; eval schema/checks registration + fixtures.
5. §4.3 par guard; §4.2 guide test.
6. Tests per §7; gates per §6. Land on `integration/next`. Builder verification steps (§3.3 Bethpage-1
   hazard log, §4.3 Red-3 par query) reported in the PR body.

### Critical Files for Implementation
- backend/app/caddie/aim_point.py
- backend/app/caddie/tools.py
- backend/app/caddie/voice_prompts.py (+ the two stable_text blocks in backend/app/routes/caddie.py)
- backend/app/caddie/types.py (+ mirror frontend/src/lib/caddie/types.ts)
- frontend/src/lib/voice/realtime.ts (+ frontend/src/lib/caddie/api.ts)
