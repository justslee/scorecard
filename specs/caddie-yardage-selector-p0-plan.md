# P0 Plan — Caddie club-yardage seam, all-courses tee-selector audit, and log observability

Spec target: `specs/caddie-yardage-selector-p0-plan.md` · Branch: `integration/next` · Builder implements exactly this; do not re-plan. (Authored by the Plan agent on the fable model, 2026-07-18.)

## 1. Root-cause summary

Three coupled findings, one field report ("recommending irons where it shouldn't… getting my yardages wrong"):

- **The owner's actual symptom is Lead 2, not Lead 1.** His 12 clubs all canonicalize and his spoken still-air yardages match stored values within ~5y — no per-club drop for him. What he feels as "wrong yardages / irons off the tee" is the tee-club selector: `_select_club_expected_strokes` (`backend/app/caddie/aim_point.py:784`) and the bend-cap block (`aim_point.py:980-1011`) compose as take-the-shorter. Any cap that lands between his 4iron (~232 total) and 3wood (~270 total) has no soft landing — he carries no hybrid/5wood, so a phantom or over-aggressive cap in the 235–265y band produces a jarring mid-iron pick that a default bag (hybrid 200, 5wood 215) would soften. The bug to root-fix is *systematic bogus caps* (phantom `bend.distance_yards` corners; corridor danger-edge artifacts from sparse/enriched tree geometry), which the all-courses audit will classify. His bag gap is an amplifier, not the bug.
- **Lead 1 is real but latent (does NOT affect the owner — he has no hybrid).** `frontend/src/lib/caddie/clubs.ts:16` emits `hybrid -> 'hy'`; `_CLUB_ALIASES` in `backend/app/caddie/club_selection.py:86-99` has no `'hy'` key (only `'3h'`), so `canonical_club('hy')` → `None` and `normalize_club_distances` silently DROPS the hybrid for every hybrid-carrying user — a regression from the v1.1.15 alias fix (commit 5a5d303), where `'hy'` at least passed through into `select_club`. Additionally, `_row_to_session` (`backend/app/caddie/session.py:120`) rehydrates `caddie_sessions.club_distances` verbatim without normalization, so legacy short-code rows persist un-healed for any consumer that reads `session.club_distances` outside the `generate_recommendation` chokepoint (e.g. the bag context line at `routes/caddie.py:907`).
- **Lead 3 blinded the field debugging.** `backend/app/main.py:17` uses `logging.basicConfig(level=INFO)` whose default formatter renders only `record.getMessage()` — every number in `extra=` at `_log_hole_hazards_intel` / `_log_caddie_reco_context` / `_log_caddie_usage` (`backend/app/routes/caddie.py:~91-151`) vanishes from journalctl; only the bare event label prints.

All three ride the same fix bundle: Lead 1 makes the bag trustworthy at every seam, Lead 2 makes the selector's caps honest on every course, Lead 3 makes the next field report debuggable in one grep.

---

## 2. Lead 1 — club-key normalization consistency at the seam

### 2.1 Alias audit (done during planning — builder re-verifies in the pinning test, not by hand)

Every code `buildClubMap()` emits, checked against `physics.CLUB_REFERENCE` (canonical keys, `backend/app/caddie/physics.py:302`) + `_CLUB_ALIASES`:

| emitted | resolution | status |
|---|---|---|
| `driver` | canonical | OK |
| `3w`, `5w` | alias → `3wood`/`5wood` | OK |
| `hy` | **no alias, not canonical → DROPPED** | **BUG** |
| `4i`…`9i` | alias comprehension → `4iron`…`9iron` | OK |
| `pw`, `gw`, `sw`, `lw` | canonical | OK |

`putter` exists in `GolferProfile.clubDistances` (`frontend/src/lib/types.ts:257-272`) but `buildClubMap` correctly never emits it (no backend putter club). `'hy'` is the ONLY hole.

### 2.2 Decision: fix BOTH sides — backend alias is the load-bearing fix, frontend canonicalization removes the seam going forward

- **Backend (required, heals stored data):** add `"hy": "hybrid"` to `_CLUB_ALIASES` in `backend/app/caddie/club_selection.py` (keep `"3h"`). Justification: v1.1.16 clients live in the field keep sending `'hy'` for weeks regardless of any frontend fix, and prod `caddie_sessions.club_distances` already contains legacy short-code rows (`3w`, `4i`, …, and `hy` for hybrid users). Because `generate_recommendation` (`aim_point.py:898`) and `/session/start` (`routes/caddie.py:354`) both funnel through `normalize_club_distances`, the alias table is the one place that retroactively heals every stored shape on read — no data migration needed.
- **Backend (heal-on-load):** in `_row_to_session` (`backend/app/caddie/session.py:120`) run the rehydrated dict through `normalize_club_distances` instead of the verbatim `{k: int(v) …}` copy. This is the robustness requirement made structural: legacy short-code session rows become canonical the moment a session is loaded, covering consumers that bypass the recommendation chokepoint (bag context line `routes/caddie.py:907`, tools reading `session.club_distances`). `normalize_club_distances` is idempotent on canonical keys and already logs+drops unknowns (`[[no-fake-data-fallbacks]]` — drop-and-log, never fabricate).
- **Frontend (seam removal):** change `buildClubMap()` (`frontend/src/lib/caddie/clubs.ts`) to emit canonical keys directly: `driver, 3wood, 5wood, hybrid, 4iron…9iron, pw, gw, sw, lw`. All 14 are identity-resolved by `canonical_club` (canonical keys short-circuit at `CLUB_REFERENCE`), so this is backward-compatible with the current backend and forward-ends the dual vocabulary. Update the file's header comment ("short club codes" → canonical keys).

### 2.3 Tests — failing repro FIRST

New file `backend/tests/test_club_hybrid_alias.py` (style of `test_club_alias_p0.py`: pure, no DB, `DATABASE_URL` stub env). Write these before touching code and watch them fail:

1. **`test_hy_shorthand_is_not_dropped`** — `normalize_club_distances({"hy": 200}) == {"hybrid": 200}` (fails today: empty dict + warning).
2. **`test_owner_prod_shapes_all_yield_the_same_12_club_bag`** — three inputs shaped exactly like the prod probes, all asserted to normalize to the SAME canonical 12-club dict with the owner's real numbers (driver 300 … lobWedge 90):
   - camelCase `golfer_profiles.bag_clubs` shape (`threeWood: 270, fourIron: 230, …`);
   - legacy short-code session shape (`3w: 270, 4i: 230, … lw: 90`);
   - normalized session shape (`3wood: 270, …`) — idempotency.
3. **`test_hybrid_user_recommendation_parity`** — `generate_recommendation` with `{"driver": 250, "hy": 200, "7i": 160}` equals the `{"driver": 250, "hybrid": 200, "7iron": 160}` run (club, target_yards, raw_yards) — mirrors `test_generate_recommendation_3w_shorthand_matches_3wood_numbers`.
4. **`test_every_buildclubmap_code_resolves`** — parametrized over the FULL emitted-code list (`driver, 3w, 5w, hy, 4i, 5i, 6i, 7i, 8i, 9i, pw, gw, sw, lw` — the legacy vocabulary, kept pinned forever for stored-row compat) asserting `canonical_club(code) is not None` and that a full 14-club bag normalizes to 14 entries — no silent drop, ever again.
5. **`test_row_to_session_heals_legacy_bag`** — `_row_to_session` on a row stub with short-code `club_distances` yields canonical keys.

Frontend: extend/add a small vitest (`frontend/src/lib/caddie/clubs.test.ts`) pinning that `buildClubMap` output keys ⊆ the canonical set (guards against a future re-divergence).

---

## 3. Lead 2 — all-courses tee-selector audit + mechanism-level root fix

### 3.1 In-process pattern (verified)

The live path assembles per-hole geometry in `routes/caddie.py:1525-1559`: `build_hole_intelligence(...)` then, for stored courses, `intel.hazards = extract_hole_hazards(features, tee, green)`, `intel.bend = extract_hole_bend(...)`, `intel.corridor = extract_corridor_profile(...)` (all in `backend/app/caddie/hazards.py`; `_derive_tee_green` at `hazards.py:313` resolves tee/green from stored features when args are absent — the audit needs no request coordinates). `test_tee_club_expected_strokes.py::test_14_assemble_red_all_par4_par5_holes_driver` is the existing offline template for exactly this assemble→`generate_recommendation` sweep; `scripts/diag_bethpage.py` / `scripts/audit_course_coverage.py` are the script-shape templates (`sys.path.insert`, asyncio, table print).

**Critical read-only constraint:** the audit must NOT call `build_hole_intelligence` — it has an elevation write-back (`course_intel.py:169-181`). Construct `HoleIntelligence(...)` directly from the stored green feature's persisted properties. The audit script performs ONLY `courses_mapped.list_courses()` / `courses_mapped.get_course(id)` (pure SELECTs, `backend/app/services/courses_mapped.py:66,190`) plus pure engine calls. No weather fetch, no USGS, no LLM.

### 3.2 The audit script — new `backend/scripts/audit_tee_selector.py`

Shape (plan-level pseudocode; builder writes it):

- Args: `--bag {owner|default}` or both in one run; optional `--course-id` filter.
- For each course from `list_courses()` → `get_course(id)`; for each hole with `par in (4, 5)`:
  - `yards` = the longest tee-set yardage in `hole["yardages"]` (card convention, matches `_derive_tee_green`'s back-tee rule); if none, fall back to derived tee→green distance and LABEL the row `yardage=derived` (honest, never fabricated).
  - `features = hole["features"]`; build `intel = HoleIntelligence(hole_number, par, yards, effective_yards=<elevation-adjusted from persisted green props via elevation_only_plays_like, else yards>, elevation_change_ft=<persisted delta_ft or 0.0>, hazards=extract_hole_hazards(features), bend=extract_hole_bend(features), corridor=extract_corridor_profile(features))`.
  - Run `generate_recommendation(hole=intel, distance_yards=yards, club_distances=BAG, handicap=HCP, weather=None, shot_bearing=0.0)` **three times per bag** for mechanism attribution:
    - **(C) uncapped baseline:** deep-copy intel with `bend=None, corridor=None`;
    - **(B) bend-cap only:** copy with `corridor=None`;
    - **(A) full:** as assembled.
  - Attribution: `pick(C) != pick(B)` → bend-cap fired; `pick(B) != pick(A)` → corridor E-selector fired; else no cap.
  - Bags: owner's REAL bag (constant in the script: driver 300, 3wood 270, 4iron 230, 5iron 215, 6iron 195, 7iron 180, 8iron 170, 9iron 155, pw 140, gw 127, sw 115, lw 90; handicap = his prod `golfer_profiles.handicap`, probed read-only — fallback 15.0 with the row labeled) and `DEFAULT_CLUB_DISTANCES`.
  - Emit one markdown row: `course | hole | par | yards | pick(owner bag) | pick(default bag) | mechanism (bend-cap @Ny / corridor-cost / none) | bend dist+deviation | corridor sample at uncapped club's total (left/right yds + sources + obs sparsity) | corridor_note | FLAG`.
  - **FLAG** = final pick is 4iron or shorter (any iron/wedge) off a par-4/5 tee — sub-hybrid-class.

### 3.3 Running it (read-only prod)

Via SSM on `i-0826ae70df62d9fe8`, app venv, service env:

```
DATABASE_URL="$(sudo systemctl show scorecard-api.service -p Environment | tr ' ' '\n' | grep '^DATABASE_URL=' | cut -d= -f2-)"
cd /home/ubuntu/scorecard/backend
sudo -u ubuntu env DATABASE_URL="$DATABASE_URL" uv run python scripts/audit_tee_selector.py > /tmp/tee_audit.md
```

(Exact env-extraction quoting is the builder's to get right on-box; the contract is: service's own `DATABASE_URL`, read-only calls only, output copied back for the spec/QA record.) Alternatively run locally pointed at the prod DB read-only if the eng-lead supplies a tunnel; on-box is the default since psql/SSM access is already established.

### 3.4 Judging each FLAG: legit vs bogus

- **Legit bend-cap:** real mapped dogleg — `bend.deviation_yards` substantial (rule of thumb ≥ ~30y), `bend.distance_yards` plausible for the hole length, corner trees (`severity ≥ moderate`, within the 20y lookback) sitting on the through-line past the corner. The cap saves a drive through trees; a hybrid-less bag landing on 4iron here is *correct if jarring*.
- **Legit corridor lay-up:** danger edges sourced `"water"` (polygon-ring vertices — real pond edge, min-obs 1 by design) forming a true pinch at the longer club's landing distance; or dense two-sided tree evidence.
- **Bogus bend-cap:** `deviation_yards` barely over the 15y straight threshold (a gentle curve, not a corner); `bend.distance_yards` implausibly short; "corner trees" that are enriched/stray tree points off the playing line; a fairway that is actually open past the "corner".
- **Bogus corridor cost:** a danger edge whose `min(|lateral|)` comes from a *single stray feature* — `_side_edge_at` (`hazards.py:1259`) takes the min over a ±20y window with `_TREE_MIN_OBS = 3`, but 3 vertices of ONE tree/woods polygon ring qualify a side, so one mis-mapped copse near the centerline manufactures a tight edge; likewise sparse enriched-tree courses with no real corridor mapping.

The two tables plus per-FLAG one-sentence why are a QA deliverable checked into the spec (and the fixture JSONs below).

### 3.5 Root fix — at the mechanism the audit convicts

Design one (or both, if both classes appear) of these mechanism-level fixes; never per-hole patches, never touching the E-formula's water costs:

- **Class A — phantom corners (fix in the bend-cap gate + extractor):** introduce a *cap-eligibility* deviation threshold in the `aim_point.py:980-1011` gate (e.g. `bend.deviation_yards >= CORNER_CAP_MIN_DEVIATION_YDS`, a new constant beside `CORNER_MIN_DISTANCE_YDS`) distinct from `extract_hole_bend`'s 15y "straight" speech threshold — a 16y drift may be *spoken* as a bend but must not *cap a club*. Optionally require the qualifying corner trees to lie on the outside of the turn (the side `bend.direction` turns away from), using the hazards' existing `line_side` — trees on the inside of a corner are not what a through-drive flies into. Calibrate the constant from the audit's legit-vs-bogus deviation distribution, and prove it: every legit-flag hole still caps, every bogus-flag hole stops capping.
- **Class B — single-feature corridor edges (fix in the evidence layer, `hazards.py`):** strengthen `_side_edge_at`/`extract_corridor_profile` tree-evidence qualification — e.g. require the ≥3 in-window tree observations to come from more than one source feature, or require a minimum along-path spread so one polygon's adjacent ring vertices can't self-qualify a side. Water stays min-obs 1 (a pond ring vertex IS real evidence — preserve the docstring's contract). This fixes the bogus class at the geometry layer so `_select_club_expected_strokes` never sees the fabricated edge, leaving the E-model untouched.
- **Class C — courses with no real corridor data:** if the audit shows junk-width profiles on sparse courses passing the all-or-nothing gate (`extract_corridor_profile`'s `any_width_known`), tighten that gate (e.g. require N samples with known width, not 1). Honest absence → `hole.corridor = None` → byte-identical v1 behavior, already pinned by `test_03_corridor_none_byte_identical_to_v1`.

**Adversarial guardrail (both directions):** the fix must keep every legit lay-up. These existing tests are the protection and MUST pass unchanged: `test_tee_club_expected_strokes.py` `test_05_water_pinch_lays_up_note_numbers_match_payload`, `test_05b_…long_driver_bag_too`, `test_06_water_pinch_competition_legal…`, `test_07_guardrail_uniform_tree_widths_never_layback_more_than_40`, `test_08_floor_excludes…`, `test_13_red6_5iron_via_bend_cap_unchanged`; `test_corridor_bend_cap.py` (all six — `test_corridor_caps_club_short_of_the_corner` is the reckless-driver-through-trees guard); `test_corridor_width_selection.py` tests 01–08. New tests pin the fixed bogus class: capture 1–2 convicted holes' real prod geometry as fixtures (`backend/tests/fixtures/<course>_<hole>_geometry.json`, pattern of `bethpage_red_trees.json` + `test_14`'s assemble path) with paired assertions — *before-fix pick was sub-hybrid, after-fix pick is the uncapped club* — plus a matching synthetic unit test on the changed constant/gate so the mechanism (not just the fixture) is pinned.

**NORTHSTAR conformance:** every cap that survives must remain narrated with its own real numbers (`corridor_note` — unchanged), and no fix may invent a cap or a yardage; loosening only removes fabricated evidence ([[no-fake-data-fallbacks]] cuts both ways).

---

## 4. Lead 3 — logging observability (small, in-pass)

**Decision: fold the values into the printf-style message at the four call sites. Do NOT add a formatter.** A custom `logging.Formatter` that serializes non-standard `LogRecord` attrs would be a global change to `main.py`'s root config, interacts with uvicorn's own handlers, and risks reformatting every line in the app for four sites' benefit; the message-level change is local, greppable, and zero-risk. Keep the `extra=` dicts as-is (future structured sink), but make the message self-sufficient.

Files/sites (`backend/app/routes/caddie.py`):
- `_log_caddie_usage` (~line 91): `"caddie_usage context=%s persona=%s call=%d cache_read=%d cache_creation=%d input=%d output=%d"`.
- `_log_hole_hazards_intel` (~line 112): `"hole_hazards_intel hole=%s n_hazards=%d tee=%.5f,%.5f hazards=%s"` — tee here is the COURSE tee-box anchor (stored geometry), not user GPS; keep it, exclude anything user-positional. No keys/secrets.
- `_log_caddie_reco_context` (~line 135): `"caddie_reco_context hole=%s to_green=%s drive_total=%s hazards=%s"`.
- `backend/app/caddie/strategy.py:178`: extend the existing warning to include the guide's favor/miss claim and the engine verdict side (the disagreement's actual numbers/sides), e.g. `"strategy guide dropped at read time: hole=%s guide_favor=%s engine_verdict=%s"`.

Test: one small unit (`backend/tests/test_caddie_log_lines.py` or folded into an existing route test) using `caplog`, asserting `record.getMessage()` contains the key=value payload for each helper — pinning that the numbers live in the MESSAGE, not only `extra`.

---

## 5. Edge cases & risks

- **Regression risk #1 (Lead 2, the adversarial one):** loosening caps must not reintroduce driver-through-water/trees. Mitigation: fix only convicted mechanisms at the evidence/gate layer; the §3.5 protected-test list is the contract; the after-fix audit re-run (same script) is the systemic proof — diff the two tables, assert no previously-legit lay-up flipped long.
- **Heal-on-load drops:** `normalize_club_distances` in `_row_to_session` drops `value <= 0` and unknown keys that a verbatim copy previously kept. That is the intended contract (physics must never see non-canonical keys) — but builder must confirm no test pins verbatim rehydration (`test_caddie_profile_session.py` integration file is the place to check).
- **Owner's amplifier is not "fixed":** on a *legit* corner at ~250y his bag genuinely lands on 4iron. The fix removes bogus caps; the spoken note already explains legit ones. Don't paper over the gap with a fabricated intermediate yardage.
- **Audit script hygiene:** no `build_hole_intelligence` (write-back), no weather/USGS/LLM calls, `weather=None`+`shot_bearing=0` for determinism; label derived yardages; par-3s excluded (tee-shot selector semantics differ — `test_15` pins par-3 behavior).
- **Aliases are additive-only:** never remove `'3h'`, `'hy'`, or the short codes from `_CLUB_ALIASES` even after the frontend goes canonical — stored rows and old clients depend on them (pinned by test §2.3.4).
- **Frontend `buildClubMap` change ripples:** several CaddieSheet tests mock it (`vi.mock`), so behavior tests are unaffected; the realtime/voice paths send the same map — keys change shape on the wire, which the backend accepts both before and after (canonical keys are identity). Ship backend alias in the same bundle or before the frontend change is deployed (same PR = safe).

## 6. Shared-type sync notes

- `frontend/src/lib/types.ts` `GolferProfile.clubDistances` (camelCase) is UNCHANGED — only the wire map's keys change inside `buildClubMap`.
- Backend request models (`club_distances: dict[str, int]`) are shape-free dicts — no `models.py` change. Keep `_PROFILE_KEY_MAP` (camelCase) as-is; it remains the `bag_clubs` ingress.
- Update the comment headers in `clubs.ts` and `_CLUB_ALIASES` to name each other as the two ends of the seam and state the "canonical keys on the wire; aliases immortal for stored data" contract.

## 7. Gates / verification (in order)

1. **Failing repro first:** `backend/tests/test_club_hybrid_alias.py` (§2.3, tests 1–3 red), then implement Lead 1, all green.
2. `cd backend && ruff check .`
3. `cd backend && uv run pytest tests/test_club_hybrid_alias.py tests/test_club_alias_p0.py tests/test_club_selection.py tests/test_tee_club_expected_strokes.py tests/test_corridor_width_selection.py tests/test_corridor_bend_cap.py tests/test_hazards.py tests/test_aim_point.py` (+ the new log-line test) — the four selector files must pass with zero assertion edits except new tests.
4. Frontend: `npx tsc --noEmit`, `npm run lint`, the new `clubs.test.ts`, `npx tsx voice-tests/runner.ts --smoke`.
5. **QA deliverables:** (a) BEFORE audit tables — owner bag + default bag, every par-4/5 on every mapped course, with mechanism attribution and FLAG judgments; (b) AFTER re-run of the same script post-fix showing every bogus FLAG cleared and every legit lay-up intact. Both tables attached to the spec/PR.
6. New fixture-pinned tests for the convicted holes (§3.5) green.

## 8. Owner decisions needed

1. **Flag adjudication:** a short list of course/hole rows from the audit where legit-vs-bogus is ambiguous — he knows the holes he played; one sentence each ("Hole 7 at X: cap says lay up 240 for the right-side trees — real?").
2. **Cap-eligibility threshold feel:** the chosen `CORNER_CAP_MIN_DEVIATION_YDS` (or evidence-density rule) changes when the caddie stops suggesting lay-ups on gentle curves — confirm the calibrated value against his home course.
3. **No data migration proposed** for legacy short-code session rows (heal-on-read covers them; sessions are per-round and short-lived) — confirm, or request a one-shot backfill.
