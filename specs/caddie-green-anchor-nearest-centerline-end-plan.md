# Caddie green anchor: nearest-centerline-end selection (p1, prod)

**One item.** Fix `backend/app/caddie/hazards.py::_derive_tee_green`'s green
resolution: it takes the FIRST `featureType == "green"` feature by file order
(hazards.py:386). On Bethpage Black 18 (the owner's home course) the stored
per-hole FeatureCollection carries TWO green polygons — its own (3.3y from the
hole centerline's last vertex) and a neighbour's (105.3y off the end; 9 and 18
both finish by the clubhouse, so the OSM spatial join associates both greens
with the hole). First-by-file-order picks the neighbour: to-green reads **508y
on a 411y hole, live**. Black 9 carries the same duplicate and is correct only
by file-order luck (one re-ingest from flipping). Everything anchored to that
green is corrupted on those holes: distance-to-green, `approach_bearing_deg`,
green depth/width, every hazard's `distance_from_green`, plays-like, club
selection, and the spoken numbers.

**Reference implementation (validated):** the caddie-bench loader already fixed
this — `backend/tests/eval/caddie_bench/geometry.py::_select_green_nearest_polyline_end`
+ `validate_tee_green_geometry` (commit 59baa50). Evidence from that lane: real
greens sit 0.2–5.1y from their centerline end; the mis-anchored one sat 105.4y.
h18 went 508.5y → 412.7y (card 411); all 9 other fixtures byte-identical.
Precedent inside the SAME function: the tee side already got the equivalent fix
("Finding A fix, 2026-07-16", docstring hazards.py:343-371).

**Diagnosis record:** commit 3d935f9 (`tasks/progress.md`). Critical trap
documented there: a symmetric `|card − geodesic| < band` assertion FALSE-FAILS
every real dogleg (Black 7: card 553, geodesic 478.6, −74.4y is CORRECT). The
only geometrically impossible direction is `geodesic > card + tol` — a straight
line can never be LONGER than the path along it. Nothing in this fix asserts
the symmetric band, anywhere.

---

## 0. MEASURED BLAST RADIUS — wider than the escalation said (eng-lead, 2026-07-25)

The escalation checked Black + Red only. Re-running the REAL ingestion path
(`osm._parse_course_geometry_response` → `osm_ingest.assemble_osm_course` →
`hazards._derive_tee_green`) over the committed `bethpage_overpass.json`, which
carries **all five** Bethpage courses (90 holes):

| course | hole | greens | centerline | OLD → green (off end) | NEW → green (off end) | delta |
|--------|------|--------|-----------|------------------------|------------------------|-------|
| Black  |  9 | 2 | 476.3y | 429.8y (2.8y)   | 429.8y (2.8y) | +0.0y  correct **BY LUCK** |
| Black  | 18 | 2 | 414.2y | 507.7y (105.3y) | 412.1y (3.3y) | **−95.6y WRONG** |
| Blue   | 14 | 2 | 381.7y | 392.0y (108.2y) | 367.5y (0.6y) | **−24.5y WRONG** |
| Green  | 18 | **3** | 400.5y | 346.8y (84.0y)  | 384.7y (1.3y) | **+37.8y WRONG** |
| Yellow |  9 | 2 | 380.2y | 432.2y (133.0y) | 346.1y (1.3y) | **−86.1y WRONG** |
| Red    |  — | 0 | — | — | — | clean (0/18) |

Consequences for this plan:
- **FOUR live-wrong holes, not one.** The audit must NOT expect "Black 9 and 18
  are the only multi-green holes" — that was the pre-measurement assumption.
- **Bethpage Green 18 carries THREE green polygons.** The predicate must handle
  `n > 2`, not a two-way choice. `min()` over all candidates does; any
  pairwise-comparison shortcut does not.
- **The separation is stark and is what makes the D4 threshold defensible:**
  correctly-anchored greens sit **0.6–3.3y** from their centerline end, every
  mis-anchored one **84–133y**. Nothing lands in between.
- Affected holes are 9s and 18s — holes finishing beside the clubhouse where
  greens of different courses crowd — consistent with the assembler's
  nearest-hole spatial join pulling in a neighbouring course's green.

Whether Blue/Green/Yellow are among the 12 *ingested prod* courses is TBD; the
prod audit (§3) settles it.

---

## 1. Design decisions

### D1 — Anchor priority: the hole polyline's own LAST VERTEX, first
Selection anchor, in priority order:

1. **The effective played line's last vertex** — the caller's `polyline=` when
   supplied (see D2), else the stored `_hole_polyline(features)`. This is the
   bench's validated rule. Rationale: the `golf=hole` way is attached to the
   hole BY REF in `assemble_osm_course` (osm_ingest.py:437-458) — it cannot be
   a neighbour's way, unlike the spatially-joined green polygons; its length is
   validated against the card at ingest (test_bethpage_validation); and the
   measured separation (0.6–3.3y real vs 84–133y bug, a ~30x gap) makes it a
   near-perfect discriminator.
2. **No polyline → a VALID `green=` arg as a SELECTOR** into curated geometry:
   pick the stored green whose `_feature_point` is nearest the arg. Exact
   mirror of the tee-side fix (the tee arg selects the nearest stored tee).
   "Valid" mirrors the tee-arg rule: `lat`/`lng` both present, non-None, not
   the `(0,0)` sentinel. In prod the arg comes from GolfAPI `holeCoordinates`
   (routes/caddie.py:1584) — an independent, coarser source, which is why it
   ranks BELOW our own card-validated centerline, not above it.
3. **No polyline, no valid arg, multiple greens → first stored green**
   (today's behavior, unchanged). There is no signal left to rank on; honest
   order-dependent fallback, exactly like the tee side's "no way to define
   'back' without a green" branch. This is deliberately the ONLY remaining
   order-dependent branch.

Corridor/containment (green inside the hole's own fairway corridor) was
considered and REJECTED as a predicate: fairway polygons are missing on real
holes (Black 7 has none), it adds point-in-polygon machinery, and nearest-end
already separates the cases by ~30x. Not needed; do not build it.

The existing LineString-endpoint fallback (green = polyline last vertex when
NO green feature exists, hazards.py:422-438) and the raw last-resort green arg
(hazards.py:442-443) are unchanged.

### D2 — Yes, thread the played line into `_derive_tee_green`
New signature (keyword-only, default `None` — zero call-site breakage):

```python
def _derive_tee_green(features, tee, green, *, path=None):
    # path: normalized [(lon, lat), ...] or None; None -> _hole_polyline(features)
```

Rationale: `extract_hole_hazards` / `extract_hole_bend` /
`extract_corridor_profile` all accept an explicit `polyline=` override — the
PLAYED line every number is measured along. If a caller overrides the line, the
green must anchor to the END of the line the numbers are measured along, or
carry/bend and the green anchor could disagree on the same call. Verified at
all three internal call sites (hazards.py:553, :724, :1361): each currently
resolves `path` (explicit arg else `_hole_polyline`) AFTER calling
`_derive_tee_green`; the fix hoists that resolution ABOVE the call and passes
it (`path=path`), then keeps using the same variable. All pure functions — a
no-op reorder. Verified external callers: routes/caddie.py:1581-1596,
course_guides.py:104/265, course_intel_writer.py:134 pass only `tee=`/`green=`
(never `polyline=`), and scripts/audit_tee_selector.py:139/206 calls
`_derive_tee_green(fl, None, None)` — the default-`None` -> internal
`_hole_polyline` fallback keeps every existing call byte-identical. NO
production caller passes `polyline=` today, so threading changes nothing live;
it makes the invariant structural.

Also use the threaded `path` for the endpoint fallback block
(hazards.py:422-438) instead of re-scanning for the first `"hole"` LineString —
identical behavior when `path` is `None`-derived, consistent when a caller
overrides.

### D3 — Ordering: green resolves BEFORE tee selection (a real regression surface)
Current code collects `green_pt` first-found INSIDE the feature loop
(hazards.py:379-387) and runs tee selection after the loop; the no-arg
multi-tee branch (hazards.py:412-418) picks the tee FARTHEST from `green_pt`
(= the back tee). New structure preserves the dependency explicitly:

```python
# 1. loop: collect tee_feature_points AND green_candidate_points (both lists)
# 2. green_pt = _select_green_nearest_path_end(green_candidates, path, green_arg)  # D1
# 3. tee selection block — UNCHANGED, reads the now-final green_pt
```

Regression surface, quantified: a changed green pick re-ranks the
farthest-from-green tee ordering. Exposed only on holes with >1 green AND >1
stored tee AND no `tee=` arg (the live path sends `tee=` from the frontend; the
no-arg exposure is course_guides / course_intel_writer / audit scripts — and
any live request whose GolfAPI data lacks a tee point). On Black 18
specifically, moving the anchor ~105y can legitimately change which tee ranks
farthest. The audit (§3) therefore reports, for every multi-green hole, the
no-arg tee pick BEFORE vs AFTER (coords + distance), so any back-tee movement
is enumerated, not discovered.

A new unit test pins the coupling: multi-tee no-arg + two greens → the back tee
must be measured against the CORRECT green (see §4).

### D4 — Honest failure mode: select nearest ALWAYS; key-free WARNING past 30y; never raise, never go mute
- **Selection is a ranking, not a validation.** With ≥1 candidate and an
  anchor, always select the nearest — no rejection threshold. Among stored
  candidates, nearest-the-end is strictly the best available estimate; the
  105y-off case is exactly the one nearest-selection FIXES, so a rejection
  branch could only fire when EVERY candidate is far off the end — zero
  evidence of that across the measured courses — and returning `green_pt=None`
  there would mute hazards/bend/green numbers for the whole hole (worse than an
  anchor a few yards off). Northstar balance: never confidently wrong (the
  wrong-green 508y IS the confidently-wrong case, and selection fixes it), but
  also never unnecessarily mute.
- **Key-free WARNING** (`logging.getLogger("looper.hazards")` — new; the module
  currently has no logger) when the SELECTED green sits
  `> _GREEN_ANCHOR_WARN_YARDS = 30.0` from the path end: log offset yards and
  candidate count only — no keys, no coords required. Threshold derivation:
  max real offset measured = 3.3y (bench measured up to 5.1y); the bug cases
  run 84–133y. 30y is ~6x the worst real case (so a huge double green or a
  multi-polygon green whose centroid drifts 15–25y off the end never spams) and
  ~2.8x under the smallest observed bug magnitude (so real mis-anchors still
  warn). The bench keeps its OWN hard 15y RAISE
  (`_GREEN_ANCHOR_TOLERANCE_YARDS`, geometry.py:184) — correct for a test
  instrument on curated fixtures; production warns and proceeds.
- **Zero candidates:** unchanged cascade — polyline last vertex → raw green arg
  → `None` → callers return `[]`/`None` (the module's documented "honest
  unknown, never a guessed bearing" discipline).

### D5 — Why the predicate cannot mis-select on long/dogleg holes
The anchor is the polyline's own END — not the tee, not the card yardage. Hole
length and dogleg severity never enter the predicate: a 650y triple-dogleg's
green still sits ~0–5y from its own centerline's last vertex. Known edges,
addressed explicitly:
- **Reversed-digitized way (green→tee):** the anchor becomes the tee end. On a
  single-green hole: no selection happens (single candidate) — unchanged. On a
  multi-green hole: both the OLD rule (file order) and the NEW rule are garbage
  under a reversed way — but the module already documents this exposure
  (hazards.py:335-340) and the ingest-time "GROSS REVERSED" yardage validation
  (test_bethpage_validation) is the standing guard. NO NEW exposure.
- **No polyline at all:** D1 priorities 2–3 (arg selector, else first-stored).
- **Green split into several polygons / true double green:** nearest-end picks
  the fragment or lobe closest to THIS hole's end — the correct lobe for this
  hole, strictly better than file order. A relation-shaped MultiPolygon green
  already collapses to its largest member via `_feature_point` (unchanged).
  Bethpage Green 18's THREE candidates are the live proof this must be a `min()`
  over all candidates, not a two-way pick.
- **Degenerate/short polyline:** `_hole_polyline` requires ≥2 vertices; the last
  vertex always exists when a path does.

---

## 2. Implementation (backend/app/caddie/hazards.py only)

1. Add module logger + `_GREEN_ANCHOR_WARN_YARDS = 30.0` (near the other module
   constants, with the derivation comment from D4).
2. Add `_select_green_nearest_path_end(green_candidates, path)` — mirrors bench
   `_select_green_nearest_polyline_end` but takes already-extracted `(lon, lat)`
   candidates and the normalized path; uses `_point_dist_sq_m` (the same helper
   tee selection uses), NOT a new distance idiom. Single candidate or no path →
   `candidates[0]` (structural byte-identity, §5).
3. Rework `_derive_tee_green` per D1–D3: signature `(features, tee, green, *,
   path=None)`; collect `green_candidate_points` in the loop (drop the
   `green_pt is None` first-match); resolve `path = path if path is not None
   else _hole_polyline(features)` once; green selection (D1 priority chain,
   including green-arg validation mirroring tee-arg's sentinel rule) BEFORE the
   untouched tee-selection block; warn per D4; endpoint fallback uses `path`.
   Update the docstring's "Green priority" section (it currently documents the
   bug as intended behavior) and note the Finding-A symmetry.
4. Hoist `path` resolution above the `_derive_tee_green` call in
   `extract_hole_hazards`, `extract_hole_bend`, `extract_corridor_profile`;
   pass `path=path`; delete the now-duplicate resolution below (keep the
   chord-fallback logic in `extract_hole_hazards` exactly as is).

No other module changes. The bench keeps its own loader/preconditions
(deduplicating bench geometry onto the prod helper is FILED as follow-up, not
done here — one item, prod-safe).

## 3. The audit (headline deliverable)

New read-only script `backend/scripts/audit_green_selector.py`, modeled EXACTLY
on `backend/scripts/audit_tee_selector.py`: same shebang/docstring contract,
`sys.path.insert(0, parent)`, argparse (`--course-id`), asyncio,
**`courses_mapped.list_courses()` / `get_course(id)` pure SELECTs only, NEVER
`build_hole_intelligence`** (elevation write-back, course_intel.py:169-181), no
weather/USGS/LLM, markdown to stdout, key-free (never print DATABASE_URL or any
env).

Per hole on ALL 12 mapped courses:
- `n_greens` = count of `featureType == "green"` features.
- For every hole with `n_greens > 1`: OLD pick (first-by-file-order
  `_feature_point`) vs NEW pick (`_select_green_nearest_path_end`), each with
  its offset-to-polyline-end (yards); OLD vs NEW tee→green yardage
  (`_derive_tee_green`-derived tee, no args) and the DELTA; whether the no-arg
  tee pick MOVED (D3 surface); FLAG when the NEW selected green still sits >30y
  off the end (the D4 warn case).

Table shape:
`| course | hole | par | n_greens | old→end y | new→end y | old tee→green y | new tee→green y | Δy | tee pick moved | FLAG |`
plus totals (holes audited, multi-green holes, deltas, flags).

**Expected result — do NOT assume Black-only.** §0 measured 5 multi-green holes
across the 5 Bethpage courses (4 of them wrong, one with 3 greens). The prod set
is 12 courses whose membership overlaps unknown-ly with those 5; treat any hole
with `n_greens > 1` as expected, and report the true count. Red measured 0/18.

Output is checked in as `specs/caddie-green-anchor-audit.md`.

### 3.1 Runbook (prod box via SSM, ISOLATED copy — deployed app untouched)
Modeled on specs/caddie-yardage-selector-p0-plan.md §3.3, with the tee-audit's
md5-isolation discipline.

> **GATE (2026-07-25):** running this against the prod DB requires the owner to
> sanction prod access for the session (the permission classifier blocks
> unsanctioned prod-host shell/DB commands). The script, its gates and the
> fixture-derived §0 table do NOT require prod. Land the code + tests first;
> execute this runbook when access is authorized and check in the output.

```
aws ssm start-session --target i-0826ae70df62d9fe8

# 1. Isolated working copy — NEVER run from /home/ubuntu/scorecard
sudo -u ubuntu git clone --depth 1 --branch <fix-branch> \
    https://github.com/justslee/scorecard.git /tmp/green-audit
cd /tmp/green-audit/backend && sudo -u ubuntu uv sync

# 2. Integrity baseline of the DEPLOYED tree (before)
sudo -u ubuntu find /home/ubuntu/scorecard/backend/app -type f -name '*.py' \
    -exec md5sum {} + | sort > /tmp/deployed.before.md5

# 3. Service DB URL (read-only use; NEVER echo it)
DATABASE_URL="$(sudo systemctl show scorecard-api.service -p Environment \
    | tr ' ' '\n' | grep '^DATABASE_URL=' | cut -d= -f2-)"

# 4. Run (pure SELECTs only)
sudo -u ubuntu env DATABASE_URL="$DATABASE_URL" \
    uv run python scripts/audit_green_selector.py > /tmp/green_audit.md

# 5. Verify the deployed tree is byte-identical (after)
sudo -u ubuntu find /home/ubuntu/scorecard/backend/app -type f -name '*.py' \
    -exec md5sum {} + | sort > /tmp/deployed.after.md5
diff /tmp/deployed.before.md5 /tmp/deployed.after.md5   # must be empty

# 6. Copy /tmp/green_audit.md back; check in as specs/caddie-green-anchor-audit.md
# 7. Clean up the isolated clone + temp artifacts under /tmp
#    (the green-audit clone dir, green_audit.md, and the two deployed.*.md5 files)
```
(Exact quoting is the builder's to get right on-box; the contract: service's own
DATABASE_URL, SELECTs only, isolated /tmp clone, md5-identical deployed tree
before/after, key-free output.)

### 3.2 Offline audit (no prod needed — do this one now)
The same old-vs-new comparison over the committed `bethpage_overpass.json` via
`assemble_osm_course` reproduces §0's table for 5 courses / 90 holes with no DB.
The script SHOULD support a `--fixture` mode that does exactly this, so the
audit is runnable and regression-testable offline and the prod run becomes a
superset rather than the only path to the evidence.

## 4. Regression pins (never edit existing tests to pass)

**New file `backend/tests/test_green_anchor_selection.py`** — shape follows
`test_corner_tree_forward_bound.py` (real prod-geometry repro + synthetic
boundary units), using the REAL ingestion path: `_parse_course_geometry_response`
+ `assemble_osm_course` over the committed
`backend/tests/fixtures/bethpage_overpass.json` (the exact harness
`test_bethpage_validation.py` already uses — reuse its helpers).

1. **Black 18 (the live defect):** assembled hole 18 carries ≥2 green features
   (repro precondition, asserted); `_derive_tee_green` selects a green within
   15y of the hole polyline's last vertex; tee→green geodesic in [405, 420]y
   (card 411, measured-correct 412.1). **Before-repro pin** (the
   monkeypatch-analogue — the old rule is data-driven, not a constant): the
   first-by-file-order green on the SAME assembled features yields >480y —
   proving the duplicate is still present and file order alone would still be
   wrong.
2. **Black 9 (correct today only by luck):** pin the GEOMETRIC property, not the
   file order (a re-ingest can flip order): selected green within 15y of its own
   polyline end AND the non-selected candidate >50y off the end (discrimination
   is real, in both file orders).
3. **Bethpage Green 18 — the THREE-green case** (from §0): assert 3 candidates
   and that the selected one is within 15y of the end while the other two are
   >50y off. This is the pin that a two-way comparison would fail.
4. **Synthetic two-green units** (a `TestGreenSelection` class here or in
   `test_hazards.py`, mirroring `TestTeeSelection`): adversarial file order →
   correct pick; reversed file order → same pick (order independence); D1-2
   arg-as-selector with no polyline; D1-3 no-polyline/no-arg → first stored
   (unchanged); **D3 ordering pin**: multi-tee no-arg + two greens → back-tee
   carry measured against the CORRECT green; single-green byte-identity.
5. **Honest failure:** no green features at all → hazards `[]` / `green_pt=None`
   cascade unchanged; caplog test: selected green >30y off the end emits ONE
   key-free warning and still returns the nearest pick.

## 5. Zero-regression argument + gates

**Structural byte-identity:** with exactly one green feature (every hole on the
other courses; Red 0/18 measured), `_select_green_nearest_path_end` returns
`candidates[0]` before any anchor math — the literal old value. With multiple
greens and NO anchor (no path, no valid arg), it returns `candidates[0]` — the
literal old value. Only multi-green + anchor changes, and the audit enumerates
every such hole. The bench already proved this shape: 9/10 fixtures
byte-identical under the same rule (59baa50).

**Existing suites, zero assertion edits:** test_hazards.py,
test_tee_shot_numbers.py, test_corridor_profile.py, test_corridor_bend_cap.py,
test_corridor_width_selection.py, test_tee_club_expected_strokes.py,
test_corner_tree_forward_bound.py, test_bend_cap_corner_sharpness.py,
test_tree_hazards.py, test_tree_span_gap.py, test_miss_side_grounding.py,
test_red1_acceptance.py, test_bethpage_validation.py, test_guide_writer.py,
test_guide_read_revalidation.py, test_course_guides.py,
test_course_intel_writer.py, tests/eval/caddie_bench/test_bench_offline.py,
tests/eval/test_harness_has_teeth.py.

**Gates:** `cd backend && ruff check .` clean; full offline pytest — baseline at
4ac6bbb is **3339 passed, 154 skipped, 0 failed**; expected after = **3339 +
(count of new tests, ~12–16) passed, 154 skipped, 0 failed** (exact number
stated in the PR from the run). No local Postgres on this machine — DB-backed
integration tests run in CI only, never locally, never via docker. **No frontend
files touched → no frontend gates.**

**Shared types:** confirmed pure-backend. `frontend/src/lib/types.ts` /
`backend/app/models.py` carry no green-selection shape; the frontend's green
`{lat,lng}` comes from GolfAPI `CourseCoordinates`, not from stored-feature file
order. Nothing crosses the boundary.

## 6. Same pattern elsewhere — fix nothing else here, FILED
The adversarial sweep ran and its findings are already FILED in `backlog.json`
(2026-07-25): `caddie-elevation-feature-center-geometric-selection` (p1 — the
writer that persists elevation/green_slope, first-by-file-order for BOTH green
and tee), `osm-ingest-duplicate-ref-centerline-last-wins` (p2),
`course-spatial-per-hole-feature-cardinality` (p2 — the root enabler),
`courses-mapped-feature-query-deterministic-order` (p3). The builder fixes ONLY
the hazards.py green anchor.

## 7. Constraints
Do NOT touch `main`, `.env*`, `deploy/**`, `backend/supabase/migrations/**`.
Never edit tests to make them pass. One item, prod-safe: the code change is
confined to `backend/app/caddie/hazards.py` + new tests + a new read-only audit
script + this spec.
