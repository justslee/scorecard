# Implementation Plan — `onboarding-bag-caddie-grounding` (Slice 5: the caddie-grounding slice)

> Plan produced by the `Plan` agent on the **fable** model (owner directive), 2026-07-19.
> This is the contract handed to the builder — the builder implements it, it does not re-plan.

**Epic:** login-onboarding redesign (`specs/login-onboarding-redesign-plan.md` §4.5) · **Branch:** `integration/next` · **Backlog why:** the bag step is the highest-value payload onboarding captures; acceptance is the owner's named FLIP-TIME TEST (two accounts, different 7-iron carries 150 vs 170, ~160y ask → club-selection **payloads** differ and each binds to that account's stored `clubDistances`).

**NORTHSTAR framing:** the caddie is the product and voice is the interface. Everything the caddie *speaks* about clubs must derive from the user's *stored* bag, per user, provably — never a hardcoded club, never fabricated confidence about default numbers.

---

## 0. Verdict on the eng-lead's pre-scan

**Confirmed, with one refinement.** The pre-scan is accurate:

- `normalize_club_distances` (`backend/app/caddie/club_selection.py:127-150`) is the one bag chokepoint; `_PROFILE_KEY_MAP` (lines 59-74) maps camelCase → canonical; unknown keys are dropped with `log.warning`.
- `select_club` (lines 330-367) iterates the **given** distances, falling back to `DEFAULT_CLUB_DISTANCES` only when empty; `compute_adjustments` (lines 237-241) same.
- **The core gap is exactly as stated:** `start_session` (`backend/app/routes/caddie.py:327-414`) sets `session.club_distances` **only** from `request.club_distances` (lines 366-372). There is no server-side read of `golfer_profiles.bag_clubs` anywhere in the caddie (the only profile hydration at lines 376-393 reads the *caddie* `PlayerProfile` table — handicap/tendencies — not the golfer profile bag). Grounding today depends entirely on `buildClubMap()` (`frontend/src/lib/caddie/clubs.ts`) reading **local-device** storage in `RoundPageClient.tsx:743-749`.
- **Option (b) server-side hydration is the right depth fix.** Two concrete failure modes it closes: (1) a second device with an empty local cache silently loses the user's bag (`saveGolferBagAsync` in `storage-api.ts:335-358` only merges into local cache *if a cached profile exists*, so a fresh-device onboarding round can start bagless even for a user with a stored bag); (2) there is no server seam the DB-backed acceptance test can assert against. Refinement to the precedence (below): the *persisted session bag* is a third state to handle — never clobber it with an **empty** profile bag.

---

## 1. Wiring-depth audit — surface by surface

### (a) `normalize_club_distances` → engine solve (`select_club`/`compute_adjustments`) — **GROUNDED** (engine-side), fed by the gap
- `aim_point.py::generate_recommendation` line 914 normalizes; line 924-930 passes `clubs` into `compute_adjustments` ("anchors the physics solve to the player's bag"); line 938 `select_club(adjusted_yards, clubs, bias)`.
- `tools.py::recommend_payload` line 376 `club_distances = session.club_distances or {}` → into `generate_recommendation`. Session rows are also healed on reload through the same chokepoint (`session.py::_row_to_session` line 131).
- **Verdict:** GROUNDED once `session.club_distances` is right. The GAP is upstream (session hydration, §2). No engine change needed.

### (b) Tee-shot club selector — **GROUNDED structurally, one cosmetic hardcoded "driver" GAP**
- `select_club` walks the bag descending — a no-driver bag can never yield driver (its keys aren't in the dict). `_select_club_capped_at` (aim_point.py:641-669) and the bend-cap block (lines 996-1029) walk `clubs or DEFAULT_CLUB_DISTANCES`. `is_green_reachable` (lines 383-402) and `max_reach` (line 966) same fallback. All iterate the USER'S clubs when a bag exists.
- **GAP (minimal fix):** `decade_advice.py::cross_hazard_line` (lines 583-602) ends with the literal string `"— driver brings it in play."` even though its caller (`aim_point.py:1195`) passes the *selected club's* distance. A no-driver golfer can be told "driver brings it in play." **Fix:** add a `club_display: str` parameter, render `f"— {club_display} brings it in play."`, and pass `CLUB_DISPLAY_NAMES.get(club, club)` at the call site. No test pins the old string (verified by grep).
- **Minor (recommended):** `strategy.py:345-353` always prints "Typical **driver** dispersion for this handicap band" into the PLAYER block. It is honestly labeled ("NOT measured for this player"), but for a bag that provably lacks a driver, skip the line when the player's `club_distances` payload is non-empty and contains no `Driver` key (one `if` around lines 346-353).

### (c) Expected-strokes selector — **GROUNDED**
- `_select_club_expected_strokes` (aim_point.py:800-890) walks `bag = clubs or DEFAULT_CLUB_DISTANCES` descending — the user's clubs only when a bag exists; ceiling/floor logic never introduces a club outside `bag`. No change needed; the flip-time test exercises it via the 430y tee reco.

### (d) Strategy brain PLAYER block — **GROUNDED (engine-side), fed by the gap; one honesty tweak**
- `strategy.py::build_strategy_payload` line 193 → `tools.py::player_profile_payload` (lines 594-620), which renders `session.club_distances` display-named (line 615-617); `format_strategy_ground_truth` prints them at lines 319-321 as "Club distances (player-entered, still-air): {...}".
- **Verdict:** reflects the user's actual carries once the session is hydrated. **Honesty tweak in §4** for the empty-bag case (it currently prints `{}` with the "player-entered" label).

### (e) Spoken yardage answers ("what club from 160") — **GROUNDED (engine-side), fed by the gap**
- `tools.py::shot_distance_payload` target mode (lines 865-885) solves plays-like against `session.club_distances` only (filtered to canonical keys), returns `suggested_club`; club mode (lines 806, 840-849) refuses honestly ("No stored distance for X — ask the player") rather than substituting a tour average. The prompt's "Player's clubs" context lines (routes/caddie.py:925-932 session mouth; 1734-1741 stateless mouth) render the same bag.
- **Verdict:** the number binds to the user's bag *when the session has it* — hydration (§2) is the fix. **Recommended small extension:** the stateless `_build_voice_prompt` (routes/caddie.py:1675+) already does a defensive profile fetch for handicap (lines 1697-1706); inside that same try-block, when `request.club_distances` is falsy, fetch the stored bag via the new helper and use it for the "Player's clubs" line — so the off-course orb's answers bind to the stored bag too. Small, separable; keep it fail-open exactly like the existing profile fetch.

### (f) Shot-recording club vocabulary — **GROUNDED-after-hydration (transcription); by-design open (recording)**
- Transcription vocab bias: `keyterms.py::build_transcription_prompt` (lines 72-97) builds the closed club vocabulary **from `session.club_distances` keys** — hydration makes this per-user automatically (a no-driver user's transcriber won't be biased toward "Driver").
- `record_shot_payload` (tools.py:396-469) canonicalizes via the ONE shared `canonical_club` and deliberately records an unrecognized club **as given** ("never drop a shot the golfer actually took"). The tool schema's `club` arg is free-text **on purpose** — `CADDIE_TOOLS` is a module-level constant that must never vary per request (prompt-cache guard D7, tools.py:23-26). Do **not** add a per-user enum. **Verdict: no change**; state this explicitly in the PR description so the builder doesn't "fix" it.

---

## 2. The server-side hydration seam (the depth fix)

### 2.1 New helper — `backend/app/caddie/memory.py`
Alongside `get_player_profile` (line 41), the module that already owns per-user hydration reads:

```python
async def get_golfer_bag_clubs(user_id: str) -> dict:
    """The user's stored bag (golfer_profiles.bag_clubs — camelCase GolferProfile
    keys, written by onboarding Slice 4 / the /profile editor). {} when no row
    or no bag. Raw keys — callers normalize through the ONE chokepoint
    (club_selection.normalize_club_distances)."""
    async with async_session() as db:
        row = (
            await db.execute(
                select(GolferProfile.bag_clubs).where(GolferProfile.user_id == user_id)
            )
        ).scalar_one_or_none()
    return dict(row or {})
```
(Import `GolferProfile` from `app.db.models` next to the existing `PlayerProfile` import at line 17.)

### 2.2 Wire into `start_session` — `backend/app/routes/caddie.py`, replacing lines 366-372
Precedence: **explicit request bag > stored `golfer_profiles.bag_clubs` (non-empty after normalization) > keep existing persisted session bag > empty (engine defaults downstream)**.

```python
bag_source = "none"
if request.club_distances:
    # (unchanged owner path — byte-identical first branch)
    session.club_distances = normalize_club_distances(request.club_distances)
    bag_source = "request"
else:
    # Server-side grounding (specs §4.5): the STORED bag is the source of
    # truth when the client sent none (fresh device, empty local cache).
    stored = await memory_mod.get_golfer_bag_clubs(user_id)
    normalized = normalize_club_distances(stored) if stored else {}
    if normalized:
        session.club_distances = normalized
        bag_source = "profile"
    elif session.club_distances:
        bag_source = "session"   # keep prior bag; NEVER clear it with an empty profile
log.info("session/start: club_distances source=%s clubs=%d",
         bag_source, len(session.club_distances))
```

Key properties:
- **Owner path unchanged:** when the client sends a bag (it always does when a local profile exists — `RoundPageClient.tsx:743-749`, `CaddieSheet.tsx:657/676/1138`), behavior is byte-identical.
- **Never destructive:** an empty/missing profile bag can't wipe a session bag; an empty everything leaves `{}` → the existing `DEFAULT_CLUB_DISTANCES` fallbacks (no crash — §4.4 of the epic spec).
- **camelCase resolves:** `bag_clubs` stores GolferProfile camelCase (`sevenIron`); it flows through `normalize_club_distances`, whose `_PROFILE_KEY_MAP` covers exactly those keys; malformed keys drop-with-warning (existing contract, `test_club_selection.py::TestNormalizeClubDistances`).
- The already-persisted `session.update(session)` at line 395 persists the hydrated bag; `_row_to_session` heal-on-load (session.py:131) keeps it canonical on reload.
- Add `"bag_source": bag_source` to the start response dict (lines 397-414) for observability and test assertability; mirror as an **optional** field on `SessionStatus` in `frontend/src/lib/caddie/api.ts` (~line 180): `bag_source?: 'request' | 'profile' | 'session' | 'none';` (additive — no client behavior change).

Downstream, every surface in §1 is fed by `session.club_distances`, so this ONE seam grounds: the engine solve, tee selector, expected-strokes selector, PLAYER block, `get_shot_distance`/spoken yardages, the "Player's clubs" prompt line, `carries_payload` clubs-that-clear, and the transcription vocabulary.

---

## 3. THE OWNER'S ACCEPTANCE TEST — the multi-user FLIP-TIME gate (§4.5, verbatim)

**New file:** `backend/tests/integration/test_bag_caddie_grounding.py` — module docstring must name it: *"MULTI-USER FLIP-TIME GATE — the owner's named acceptance test, specs/login-onboarding-redesign-plan.md §4.5."* Runs in CI's Postgres job (`.github/workflows/ci.yml` `required-backend`, `DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/scorecard_test`); skips gracefully on this Mac via the existing `_postgres_reachable()` guard in `backend/tests/integration/conftest.py` (no local DB needed — verify with `--collect-only`).

**Harness:** exactly the `test_caddie_profile_session.py` pattern — `client` fixture (ASGI, no network), `set_auth(user_id)` for identity, direct DB/function access for the seam.

**Fixtures (module constants):**
```python
USER_A = TEST_OWNER_ID      # bomber
USER_B = OTHER_OWNER_ID     # short bag, NO driver (the harder §4.5 variant)
ROUND_A, ROUND_B = "flip-round-a", "flip-round-b"

BAG_A_CAMEL = {  # 7-iron 170 (the spec's number)
  "driver": 300, "threeWood": 270, "hybrid": 240, "fourIron": 220,
  "fiveIron": 205, "sixIron": 190, "sevenIron": 170, "eightIron": 158,
  "nineIron": 145, "pitchingWedge": 132, "gapWedge": 118, "sandWedge": 105, "lobWedge": 90,
}
BAG_B_CAMEL = {  # 7-iron 150, NO DRIVER — must not crash, must never hear "driver"
  "threeWood": 200, "fiveWood": 190, "hybrid": 180, "fiveIron": 165,
  "sixIron": 158, "sevenIron": 150, "eightIron": 140, "nineIron": 130,
  "pitchingWedge": 120, "gapWedge": 110, "sandWedge": 95, "lobWedge": 80,
}
# Bethpage Black hole 1, black tees — card-verified in test_bethpage_validation.py CARD[1]
BETHPAGE_1 = HoleIntelligence(hole_number=1, par=4, yards=430, effective_yards=430)
```

**Seeding path (exercises the REAL write path, same as onboarding Slice 4):**
1. `set_auth(USER_X)` → `PUT /api/profile/golfer {"clubDistances": BAG_X_CAMEL}` (routes/profile.py:124-175 writes `bag_clubs` JSONB).
2. `POST /api/caddie/session/start {"round_id": ROUND_X}` — **deliberately WITHOUT `club_distances`** (this is what proves server-side hydration; today this leaves the bag empty, so the key assertions are RED pre-fix — prove them red first, per repo convention).
3. `await sessions.set_hole_intel(ROUND_X, {1: BETHPAGE_1})` (session.py:295) — no weather cached → still air, elevation 0 → fully deterministic engine numbers.

**The assembly seam (functions, not HTTP):** `session = await sessions.get(ROUND_X)` then call the single-source-of-truth payload helpers directly — `caddie_tools.recommend_payload(session, ROUND_X, 1, yards=430)`, `caddie_tools.shot_distance_payload(session, hole_number=1, target_yards=160)`, `caddie_tools.player_profile_payload(session, USER_X)`. These are *the* payloads behind both mouths (tools.py:18-21 "parity by construction"), so asserting here asserts the tool-call payload the spec demands, not the spoken words.

**Tests + KEY assertions (concrete):**

1. `test_session_start_hydrates_stored_bag_per_user` — start response `bag_source == "profile"`; `sessions.get(ROUND_A).club_distances == {"driver": 300, "3wood": 270, ..., "7iron": 170, ...}` (canonical keys — proves camelCase resolved through `normalize_club_distances`); same for B with **no `"driver"` key**.
2. `test_160_yard_ask_payloads_differ_and_bind_to_own_bag` — **the spec's verbatim scenario.** For each user: `p = shot_distance_payload(session, hole_number=1, target_yards=160)`; assert `p["available"] is True`; `p["suggested_club"] in session.club_distances` (binds to OWN bag only); `p_a["suggested_club"] != p_b["suggested_club"]` (with these bags the still-air solve is deterministic — builder pins the exact two clubs after one local run and asserts them literally, e.g. A's near-160 club from the 158/170 pair vs B's from the 158/165 pair). Also assert `player_profile_payload` for A contains `{"7 Iron": 170}` and for B `{"7 Iron": 150}`, and A's dict has `"Driver": 300` while B's has no `"Driver"` key.
3. `test_tee_reco_differs_and_no_driver_bag_never_hears_driver` — `ra = recommend_payload(session_a, ROUND_A, 1, yards=430)`: `ra["club"] == "driver"`, `ra["tee_shot_numbers"]["club_stored_yards"] == 300`, `leave_exact_yards == 430 - ra["tee_shot_numbers"]["drive_total_yards"]` (numbers close). `rb`: **no crash**, `"error" not in rb`, `rb["club"] == "3wood"` (B's longest), `rb["club"] != "driver"`, `club_stored_yards == 200`, and `"driver" not in json.dumps(rb).lower()`. `ra["club"] != rb["club"]`.
4. `test_bags_never_cross_leak` (**the multi-user isolation dimension**) — after BOTH sessions are started and both payloads assembled (interleaved: seed A, seed B, then assemble A first), re-read `sessions.get(ROUND_A)` and assert its bag is still exactly A's normalized bag; assert `"300" not in json.dumps(rb)`; assert `player_profile_payload(session_b, USER_B)` contains none of A's distinctive values (300, 270, 170-as-7-iron) and vice versa for B's 150-as-7-iron in A's profile payload.
5. `test_explicit_request_bag_still_wins` (owner's-path regression guard) — user A starts a NEW round sending `club_distances={"7i": 172}` in the request; assert session bag is `{"7iron": 172}` (request beat the stored 170) and `bag_source == "request"`.
6. `TestSkippedBagDefaults` — user C: `PUT` profile with `clubDistances: {}`, start session bagless: `bag_source == "none"`, `session.club_distances == {}`; `recommend_payload(..., yards=430)` **succeeds** (engine defaults, no crash — epic §4.5 "skipped bag" criterion) with `club` from `DEFAULT_CLUB_DISTANCES`; `shot_distance_payload(target_yards=160)` returns `available: False, reason: "No club distances on file — plays-like needs at least one."` (honest, not defaults-in-disguise — that asymmetry is the intended contract, see §4).

---

## 4. Defaults honesty (skipped-bag path)

Where honesty is **already enforced** (verify, no change):
- Prompt "Player's clubs" lines are **omitted** when the bag is empty (routes/caddie.py:925 / 1734 — truthiness gate). Nothing fabricates a bag into the prompt.
- `get_player_profile` returns `club_distances: {}` (tools.py:615-617) — honest empty.
- `get_shot_distance` refuses per-club and target-mode without a stored bag (tools.py:841-849, 870-875) — never a default stand-in for "the PLAYER's number".
- `carries_payload` sets `clubs_that_clear/short_of_it` to `None` with no bag (tools.py:657-662).
- Tendencies are already labeled "learned from N logged rounds (0 rounds = handicap-based heuristics…)" (`strategy.py:323-343`) — no change.

Two **small changes needed** (both spoken-surface honesty, no fabricated confidence):
1. `strategy.py::format_strategy_ground_truth` lines 319-321: when `player.get("club_distances")` is empty, print `"Club distances: none on file — engine numbers below use standard-amateur defaults, not this player's measured bag."` instead of labeling `{}` as "player-entered". (Deterministic string — it participates in the strategy cache key; that is fine, it only changes for bagless users.)
2. `aim_point.py::generate_recommendation`: when the normalized bag was empty (line 914 produced `{}`), append one P4 reasoning line: `(4, "Using standard club distances — set up your bag in Profile for your own numbers")`. P4 is the color tier, so it never displaces safety lines.

Both get unit tests (in `test_club_selection.py`-adjacent style, no DB), proven red first.

---

## 5. Shared-types / cross-file sync (keep in lockstep)

| Frontend | Backend | Contract |
|---|---|---|
| `types.ts` `GolferProfile.clubDistances` camelCase keys (line 251-274) | `models.py` `GolferProfile.clubDistances` (line 25) + `club_selection._PROFILE_KEY_MAP` | The 14 camelCase keys are the wire format for `bag_clubs`; hydration relies on `_PROFILE_KEY_MAP` covering all of them (it does — no change) |
| `clubs.ts` `DEFAULT_BAG_CAMEL` + `buildClubMap` mapping | `club_selection.DEFAULT_CLUB_DISTANCES` | Already sync-annotated ("KEEP IN SYNC") — untouched by this slice |
| `api.ts` `SessionStatus` | `start_session` response dict | Add optional `bag_source?: 'request' \| 'profile' \| 'session' \| 'none'` mirroring the new response key (additive, optional — older clients unaffected) |
| `api.ts` `startSession` params | `StartSessionRequest` (routes/caddie.py:249-256) | Unchanged — request shape identical |

**No DB schema change, no migration** — `bag_clubs` (db/models.py:243) already exists (Slice 4). Do not touch `backend/supabase/migrations/**` or `backend/migrations/versions/**` (guarded).

---

## 6. Edge cases & risks

- **No-driver bag:** engine iterates bag keys only → never recommends driver (§1b); `cross_hazard_line` wording fix removes the last hardcoded "driver" utterance; flip-time test 3 pins it.
- **Empty bag `{}`:** hydration leaves `{}`; every consumer has an explicit `or DEFAULT_CLUB_DISTANCES` / honest-refusal path (§4). Test 6 pins no-crash.
- **Partial bag:** `normalize_club_distances` keeps only valid positive entries; selectors work over any subset (`select_club` defaults to shortest club when the target outranges every entry — existing behavior).
- **Malformed stored keys (hand-edited/legacy JSONB):** dropped with `log.warning` at the chokepoint — never crash, never fabricate (`test_club_alias_p0.py::test_build_strategy_payload_all_unknown_bag_degrades_not_crashes` already covers the downstream).
- **Owner's existing path:** request-bag branch is byte-identical; test 5 pins request-over-stored precedence. Existing integration `_start_session` helpers (no profile row, no request bag) hit `bag_source="none"` with unchanged behavior.
- **Request-vs-stored precedence:** request wins (freshest local edit); stored profile refreshes a stale persisted session bag when the client sends none; empty profile can never clear a persisted session bag.
- **Isolation:** sessions are keyed by `round_id` with ownership enforced in `get_or_create` (session.py:187-188); hydration reads only `user_id`-scoped rows; test 4 asserts no cross-leak at payload level.
- **Prompt-cache:** `CADDIE_TOOLS` untouched (D7); context lines already vary per session; the two honesty strings only change output for bagless users.
- **Latency:** +1 indexed single-column DB read on `session/start`, only when the client sent no bag.
- **Do not** add per-user club enums to tool schemas; do not touch `record_shot`'s record-as-given contract (§1f).

## 7. Build order

1. `memory.py::get_golfer_bag_clubs` helper.
2. `start_session` hydration + `bag_source` response key + log line.
3. `cross_hazard_line` club-label fix (+ caller) and the driver-dispersion-line gate; the two defaults-honesty strings.
4. `api.ts` `SessionStatus.bag_source` optional field.
5. (Recommended, separable) stateless `_build_voice_prompt` bag fallback inside the existing defensive fetch.
6. New unit tests (honesty strings, cross-hazard label) — proven RED pre-fix where applicable.
7. `test_bag_caddie_grounding.py` — flip-time gate; key hydration assertions proven RED against pre-fix code, then green.

## 8. Exact gates

- `cd frontend && npm run lint` · `npx tsc --noEmit` · `npx tsx voice-tests/runner.ts --smoke` · `npm run test:caddie-experience`
- `cd backend && ruff check .`
- `cd backend && uv run pytest` — new suite must **collect** locally (it will skip without Postgres: `uv run pytest tests/integration/test_bag_caddie_grounding.py --collect-only -q`) and **run green in CI's Postgres job** (`required-backend`).
- Existing suites stay green untouched: `test_club_selection.py`, `test_club_hybrid_alias.py`, `test_club_alias_p0.py`, `test_caddie_tools.py`, `test_caddie_profile_session.py`, and the caddie-experience manifest suite. No test edits to make anything pass.

### Critical Files for Implementation
- `backend/app/routes/caddie.py` (start_session hydration seam, lines 327-414)
- `backend/app/caddie/memory.py` (new `get_golfer_bag_clubs` helper)
- `backend/app/caddie/club_selection.py` (the normalize chokepoint everything flows through)
- `backend/tests/integration/test_bag_caddie_grounding.py` (new — the flip-time gate; pattern from test_caddie_profile_session.py + conftest.py)
- `backend/app/caddie/tools.py` (recommend/shot_distance/player_profile payload seams the test asserts)
