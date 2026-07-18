# Progress log

The team writes here so work survives context resets and usage-limit pauses.
Format: date — done / in-progress / blocked.

## DONE — 2026-07-18 — auth-headless-spike (SILENT, dev-flag only; login-onboarding epic Slice 1) — verdict CONSTRAINED-GO
Landed on `integration/next` (bundle PR #150), all three CI gates SUCCESS on head **429dd9c**
(Frontend + Backend + E2E advisory). Silent rider — dev-flag-gated (`NEXT_PUBLIC_AUTH_SPIKE=1`),
zero user-visible change; NOT shipped/pinged (spike is silent proof code + a go/no-go).
Plan(fable) → specs/auth-headless-spike-plan.md. Verdict → specs/auth-headless-spike-verdict.md.
Commits: cb19a2d plan · b7401b7 spike impl · 429dd9c lockfile fix (+ progress checkpoints).

**What it proved (offline, all gates green — reviewer SHIP, qa PASS):** headless Clerk custom flows
work in our stack behind a dev flag. Email+password/code sign-in+up + headless signOut built &
typechecked against the pinned installed clerk-js/react types (the Future signal API — a confirmed
discovery, see below); Google web (`signIn.sso` + `/sso-callback`), Google native
(`authenticateWithGoogleOneTap`) and Apple native (`oauth_token_apple`) built + unit-tested against
mocked plugin contracts. Backend `clerk_auth.py` BYTE-UNCHANGED (only added a test). All 5 reviewer
security gates asserted as real offline tests (reviewer confirmed they have teeth): JWT parity (real
RS256, backend accepts baseline-shape + rejects wrong azp/sig/sub), central-observer sign-out clear
(no per-site clears added), credential no-log grep gate (0 violations), fallback-safety (no
custom-scheme OAuth path — Universal-Link precondition documented), auth-bypass integrity intact.

**Verdict CONSTRAINED-GO** — the ONE gap keeping it from clean GO: no live web-dev click-through was
run (offline session, no browser/dev Clerk key) and the live Google/Apple SSO round-trips are blocked
on owner ops item `auth-clerk-enable-social-connections`. Flip-time checklist in the verdict §6.

**Two discovered constraints for Slice 2 (login-screen-visual):**
1. `@clerk/react@6.11.1` uses the Future signal API (`useSignIn()`→`signIn.password/emailCode/sso`,
   `signIn.finalize()`), NOT the classic `{isLoaded,signIn,setActive}` the epic plan §2.2 assumed.
   `useAuthFlow.ts` must be built on Future-API-primary + classic `clerk.client.*` only for Apple's
   ID-token `create`. No `@clerk/clerk-js` bump needed (strategies already in 6.22.0; no Clerk patches).
2. Reviewer nitpicks DEFERRED to Slice 2 (non-blocking; both bite where the real credential UI lands):
   (a) tighten `@capgo/capacitor-social-login` pin from `^8.3.35` to exact/`~`; (b) broaden the
   credential no-log scanner beyond `console.*`/`setAuthDiag` (e.g. `append`).

**eng-lead decisions recorded:** (i) NO prebuild guard for `NEXT_PUBLIC_AUTH_SPIKE` — unlike
`AUTH_BYPASS` (must never be in any build), the spike flag MUST stay buildable (`NEXT_PUBLIC_AUTH_SPIKE=1
npm run build` is a required flip-time gate), so a hard guard would break legitimate on-device dev
testing; parity with the existing unguarded `AUTH_DIAG` is correct. (ii) LOCKFILE lesson recurred: the
builder's macOS `npm install` pruned `utf-8-validate` optional entries; macOS `npm ci` tolerated it but
Linux CI's strict `npm ci` failed ("Missing: utf-8-validate from lock file") — the verdict §7.6 claim
that "no platform bindings dropped" was wrong for Linux. Fixed by restoring the base lock + adding ONLY
the `@capgo` entry (429dd9c), never delete-and-regen. Reconfirms: macOS-local `npm ci` is
necessary-not-sufficient; Linux CI is authoritative.

## DONE — 2026-07-18 — P0 caddie-yardage-selector: club-alias fix + all-courses tee-selector audit + fix + log observability (item caddie-yardage-selector-p0, NOTICEABLE)
Plan(fable) → specs/caddie-yardage-selector-p0-plan.md. Implemented all 3 leads on
`integration/next` (commits ace9d8a Lead1, c97d0ed Lead3, 64b0f00 Lead2).

**Lead 1 (club-yardage seam, NOTICEABLE — heals hybrid-carrying golfers):** added `"hy":
"hybrid"` to `_CLUB_ALIASES` (backend/app/caddie/club_selection.py) — buildClubMap() emitted
`hybrid -> 'hy'` but the backend had no 'hy' alias (only '3h'), so `normalize_club_distances`
silently dropped the hybrid for every hybrid-carrying golfer. `_row_to_session` now heals
legacy short-code session rows through the same chokepoint on every load. Frontend
`buildClubMap()` now emits canonical keys directly (driver/3wood/5wood/hybrid/4iron..9iron/
pw/gw/sw/lw) — aliases stay additive-only forever for legacy rows/spoken shorthand. Tests:
backend/tests/test_club_hybrid_alias.py (5 tests, confirmed RED on unfixed code, GREEN after)
+ frontend/src/lib/caddie/clubs.test.ts.

**Lead 2 (all-courses tee-selector, NOTICEABLE — root fix, the owner's actual symptom):**
read-only audit (backend/scripts/audit_tee_selector.py) run against prod via SSM
(i-0826ae70df62d9fe8) — 168 par-4/5 holes, 12 mapped courses, owner+default bags. Convicted
the bend-cap `corner_trees` filter (aim_point.py): NO upper bound on `h.carry_yards`, so any
tree past `bend.distance_yards - 20`, even greenside ones 60-280y past the corner, counted as
"guarding" it. deviation_yards did NOT discriminate legit/bogus (every bogus hole had a real,
substantial dogleg). Fix: new `CORNER_TREE_FORWARD_YDS=40` bound at the evidence layer only.
BEFORE/AFTER tables: specs/caddie-tee-selector-audit-before.md / -after.md — 20→14 flagged, 9
rows changed (every one capped→driver, zero regressions the other way), all legit lay-ups
(real corner trees, real water pinches) byte-identical. AFTER re-run done from an isolated
/tmp copy on the box (never touched the deployed app/service — verified md5-identical before
and after). Protected tests (test_tee_club_expected_strokes.py, test_corridor_bend_cap.py all
6, test_corridor_width_selection.py 01-08, test_hazards.py, test_aim_point.py — 164 tests)
pass with ZERO assertion edits. New: backend/tests/test_corner_tree_forward_bound.py — 2 real
prod-geometry fixtures (Pine Valley 9, Pebble Beach 3) with before/after (monkeypatch-repro)
assertions + a synthetic boundary unit test.

**Lead 3 (log observability, SILENT):** folded key=value numbers into the log MESSAGE at the
3 sites the field report actually named (backend/app/routes/caddie.py's `_log_hole_hazards_
intel`/`_log_caddie_reco_context` + strategy.py:178's guide-drop warning, now includes
guide_favor/engine_verdict) — `logging.basicConfig`'s default formatter only renders
`record.getMessage()`, so numbers passed only via `extra=` vanished from journalctl in the
field. New: backend/tests/test_caddie_log_lines.py (5 tests, caplog).
**Resolved (eng-lead scope correction, 2026-07-18):** `_log_caddie_usage` was a 4th site the
plan initially added on top of the field report's 3 — not the yardage field-debug payload the
owner described, and its numbers were already asserted via `extra=` in the pre-existing
test_caddie_caching.py (3 tests there filter on the exact bare message). Reverted that one
site's message back to bare `"caddie_usage"` (extra= unchanged) and removed the now
out-of-scope speculative test for it — de-scoping the collision at the SOURCE rather than
editing the pre-existing test (which the harness correctly reserves for a human). All 3
previously-red test_caddie_caching.py tests now pass with ZERO edits to that file.

Gates (final, after the de-scope): backend `ruff check .` clean; full non-DB suite
`pytest tests/ --ignore=tests/integration` = **2977 passed, 0 failed**; required §7 list (287
tests incl. test_caddie_caching.py) all green. Frontend (unchanged by the de-scope, verified
green in the same session): `tsc --noEmit` clean, `npm run lint` clean (1 pre-existing
unrelated warning in RoundPageClient.tsx), voice-tests 278/278, clubs.test.ts 4/4. Pushed to
origin/integration/next @11d5fe9.

NOTICEABLE — the owner should notice fewer jarring mid-round club lay-ups on real courses
(the missing-upper-bound bug affected every mapped course, not just his home course) plus
hybrid bags now working correctly. Try it: any hybrid-carrying golfer's bag now keeps the
hybrid; any par-4/5 tee shot on a mapped course with a real dogleg should only cap when a tree
actually sits near the corner, not near the green.

## DONE — 2026-07-18 — deploy health-check startup race fix (item deploy-healthcheck-startup-race, SILENT)
Fixed the false-fail hit on both the v1.1.14 (#147) and v1.1.15 (#148) deploys: the SSM deploy
script's fixed `sleep 3` + single `curl localhost:8000/health` raced uvicorn's real ~3-4s bind
time, so a genuinely-successful deploy (git pull/uv sync/alembic/restart all fine) reported SSM
"failure" on the tail health check and needed a manual job re-run. `.github/workflows/deploy.yml`
(the GH Actions workflow itself, NOT `deploy/**` -- that dir is guard-blocked and untouched) now
runs a bounded retry: `for i in $(seq 1 15); do curl -fsS http://localhost:8000/health && exit 0;
sleep 2; done; echo health check timed out after 30s >&2; exit 1` -- up to 30s, exits the moment
the app answers, only fails if it's genuinely still down after 30s. Verified: `bash -n` syntax
check on the retry line under `set -eu` semantics (the `&&`-guarded curl failure doesn't trip
`set -e`, confirmed); `python3 -c "import yaml; yaml.safe_load(...)"` on the whole workflow ->
OK; rebased clean onto origin/integration/next @ec0ed33, diff scoped to exactly this one file,
does not touch backend/app/caddie/** (the parallel tee-club-expected-strokes lane stays
untouched). No product code changed -> no frontend/backend gates apply (workflow-syntax-only).
Backlog item filed + flipped done-on-bundle in the same commit. Rider on the open bundle PR,
SILENT (ops-only, not user-visible) -- no ship/ping needed for this alone.

## DONE — 2026-07-18 — P0 caddie tee-club over-conservatism (item caddie-tee-club-expected-strokes, NOTICEABLE)
COMPLETE on integration/next @b0eb319 (NOTICEABLE; on the open bundle PR, awaiting owner ship —
coordinator takes the ship ask with the Red before/after table). Plan(fable) →
specs/caddie-tee-club-expected-strokes-plan.md. Commits 321f333 (impl) + b0eb319 (fable-review
B1/B2 recklessness fix). REPLACED the hard corridor fit-wall with an expected-strokes selector:
E[club] = approach_expected_strokes(leave, hcp) + P_left*C(src) + P_right*C(src); per-side P =
1-Phi(clearance/sigma) from each side's OWN danger-edge offset, C = HANDICAP-SCALED trees0.7/
water1.4 (the B2 fix — flat costs let a 280y bag keep driver at 46% water; scaling makes penalty
commensurate with the hcp-scaled approach term), strict-min E, open/unknown corridor -> DRIVER.
v1 bend-cap kept verbatim as ceiling. BEFORE/AFTER (QA, executed): width-40 tree 467y par-4
7-Iron/300 -> Driver/185; width-28 water pinch now LAYS UP for BOTH default AND 280y bags (long-bag
driver E flipped 4.251-win -> 4.391-lose to 5i 4.366); all 14 Red par4/5 driver-majority; Red-1
driver, Red-6 bend-cap unchanged, par-3s never enter selector.
VERDICTS: Reviewer(FABLE) SHIP (round 1 caught the B1/B2 recklessness overshoot — the exact reason
it ran on fable; round 2 re-review SHIP by independent recompute: not overcorrected, driver still
wins tree/open at hcp 0-36, per-side-offset byte-identical on symmetric corridors, 102 tests). QA
PASS both rounds (ruff clean, 416/416 targeted offline; DB-integration on CI). No frontend sync.
FOLLOW-UP filed: caddie-tee-club-tree-severity-calibration (p3 — hcp-30 still gets driver on a 20y
tree chute ~72% trees; calibration, not a bug; + thin long-bag water-pinch margin note).
Process note: a stray `fork` agent was launched by an eng-lead dispatch typo (placeholder prompt);
aborted cleanly with zero changes (branch head verified unmoved). Builder continued via SendMessage.

--- (original AWAITING record, now resolved, below) ---

## RESOLVED — 2026-07-18 — P0 caddie tee-club over-conservatism (mechanism trace)
Owner P0 field report (live round today, v1.1.15): "The caddie is extremely conservative. Tells
me to hit 7 iron instead of driver." MECHANISM CONFIRMED by code trace (eng-lead, this cycle):
`_select_club_fitting_corridor` (backend/app/caddie/aim_point.py:695-764) is a HARD FIT
CONSTRAINT — it walks the bag descending and accepts the longest club whose ±1.5σ landing window
(`_club_fit_window_yds` = 0.75 × dispersion width_yards; 15-hcp: driver 56y / 3wood 49y / hybrid
45y / long-iron 42y / mid-iron 36y) is <= the corridor's danger-to-danger `width_yards` at that
club's landing distance. Since the tree-span fix enriched `extract_corridor_profile` danger edges
(tree/woods runs populate width_yards on most tree-lined holes, ~40-55y danger-to-danger),
driver's 56y window exceeds the corridor → rejected → cascades down to a mid-iron. NO
expected-strokes tradeoff: window⊄corridor is a hard wall regardless of distance sacrificed
(leave 120 vs 220 = ~0.62 strokes on _FAIRWAY_TABLE), true trouble PROBABILITY (a 56y window ~6y
wider than a 50y corridor = only the cone tails catch trees, not certain trouble), or hazard
SEVERITY (trees==water==generic wall). The v1 bend-cap (aim_point.py:870-901) is a separate,
narrower mechanism (flying a mapped dogleg corner into moderate+ trees) — likely legitimate, plan
to review it doesn't ALSO over-lay-back.

FIX DIRECTION (owner spec): replace the hard fit with expected-strokes club choice. Per club:
E[strokes] = P(safe)·E_approach(leave|fairway, _FAIRWAY_TABLE) + P(trouble)·penalty(severity);
P(trouble) from the Gaussian cone (σ=width/4) tail outside the danger edges; severity tiers
water/OB >> woods/trees > bunker > rough. Pick min E; open hole ⇒ driver. Simple, monotone,
one-sentence explainable. Ingredients in place: `strokes_gained._FAIRWAY_TABLE` (approach curve),
`dispersion.get_dispersion` (per-club width), `hazards.corridor_sample_at` (width + source at a
landing distance). Bar: Red par4/5 driver-or-3wood on the large majority; NO par4/5 shorter than
hybrid/long-iron unless corridor provably punitive; Red 1 driver-favor-right; par-3s unchanged;
8-bearing invariance + all caddie suites green.

PROCESS this cycle: Plan on **fable** → `specs/caddie-tee-club-expected-strokes-plan.md` (the
model design is the crux). Then builder (implements plan on integration/next), reviewer (fresh,
adversarial: does the recalibration overshoot into recklessness — water carries now recommended?
severity tiers honest? dispersion labeled?), qa (full gates + Red/Black before/after table).
NOTICEABLE — owner field report. Do NOT ship/ping this cycle (task directive).

**Base:** origin/integration/next @ 51a19ed. Work in worktree `agent-a9939cd5dc98a975f` (branch
`worktree-agent-a9939cd5dc98a975f`, tracks integration/next), land via fast-forward push.
**Status: Plan(fable) DONE @153815e; Builder DONE @321f333** (landed on integration/next).
Builder verified BEFORE/AFTER: 40y tree corridor 467y par-4 went 7-Iron(leave 300) → Driver(leave
185); Red-1 driver/leave-210 unchanged (unknown-width-never-rejects already saved it, now grounded
0%-risk note); Red-6 5-Iron via v1 bend-cap UNCHANGED. Ruff clean; 431 targeted + 2111 broader
offline tests green. TWO documented deviations: (1) KEPT the retired pinch `TeeShotNumbers` fields
present-but-None — plan's grep was WRONG, `voice_prompts.py::format_tee_numbers_line` really reads
them (feeds the realtime voice "Last recommendation" line); builder added a parallel clause so
voice grounding isn't lost. (2) Added `corridor_alt_total_yards` field (swap-note template needs a
payload-grounded number the plan didn't list). Files: strokes_gained.py, aim_point.py, types.py,
voice_prompts.py + 2 test files.
**QA @321f333: PASS** — ruff clean, 415/415 backend caddie tests, real-fixture before/after table
proves the fix (canonical 7-Iron/leave-300 → Driver/leave-185; Red-1/Red-5 driver; Red-6 bend-cap
unchanged).
**Reviewer(FABLE) @321f333: BLOCKING** — found a real recklessness overshoot (the exact reason it
ran on fable). B2 (root cause, aim_point.py:686): `_PENALTY_COST` is FLAT while `E_ap` terms are
handicap-multiplied (×1.22 hcp15 → ×1.55 hcp30), inflating distance value vs water cost → model
keeps DRIVER at 39-52% water-landing probability on the plan's canonical pinch for a longer 280y
bag (and default bag at width 32) — the plan's own definition of the wrong pick. B1 (test_tee_
club_expected_strokes.py:62): the water-pinch gate was NARROWED from spec width-28 to width-20 (the
only width its bag still lays up), masking B2. Eng-lead verified the fix arithmetically:
handicap-scaling `_PENALTY_COST` flips the pinch to lay up (driver E 4.43 > 5-iron 4.37) AND keeps
the tree-corridor driver pick (driver 4.28 < 6-iron 4.67) — fixes B2 without re-introducing P0.
Also folding in cheap reviewer non-blockers: NB1 asymmetric-corridor understatement (use each
side's OWN offset for P, not width/2 — byte-identical on symmetric, honest on asymmetric, removes
the unspoken midpoint-aim assumption), NB2 swap-note hazard-word mislabel (chosen club's word from
fit.sample, not alt's), NB3 repopulate corridor_width_yards, NB5 voice None-guard on the alt clause.

**Builder FIX DONE @b0eb319.** B2 root-caused: `_PENALTY_COST` now handicap-scaled at use (same
multiplier as approach strokes). Canonical width-28 water pinch lays up for BOTH default AND
driver-280 bags (driver E=4.591 @46% water vs 5i 4.366); width-40 tree corridor still picks driver
(ordering unchanged). B1: gate test restored to width-28 + new long-bag layup regression. NBs
folded: per-side P uses each side's own offset (asymmetric honest: 29.7% tight-water vs 1.6%
wide-trees, no averaging), swap-note % from chosen club's own sample, corridor width repopulated,
voice swap clause guards all 3 alt fields. Gates: ruff clean, 295+16 targeted, 2112 broader offline.
**Re-review(FABLE, focused) + re-QA DISPATCHED in parallel @b0eb319.** On resume: reviewer SHIP +
qa PASS → finalize (full Red par4/5 before/after table in report, bundle PR checklist NOTICEABLE,
backlog flip to done, progress), then STOP — coordinator takes the ship ask with the table; do NOT
ship/ping. BLOCKING → re-dispatch builder. Do NOT re-run finished children.

---

## 2026-07-18 — P0 caddie yardage+selector: DONE on integration/next (PR #150), NOT shipped

Reviewer **SHIP** (both directions) + QA **PASS**. Head `3c1eff0` (records at `510922f`+). Bundle
PR **#150** opened (NOTICEABLE). No ship/ping this pass — coordinator takes the ship ask.

- **Lead 1 (seam):** `hy`->hybrid alias + `buildClubMap` canonical keys + `_row_to_session`
  heal-on-load. Idempotent/lossless on a correct profile (reviewer-verified). Repro tests red->green.
- **Lead 2 (selector, owner's actual symptom):** bend-cap `corner_trees` filter had NO forward
  bound -> greenside trees falsely 'guarded' corners -> mid-iron off the tee (amplified by owner's
  no-hybrid 40y gap). Fix `CORNER_TREE_FORWARD_YDS=40`: **20->14 flags, 9 holes capped->driver,
  zero the other way.** Reviewer: +40 separates legit guards (<=+25y) from bogus (>=+45y), ~20y
  margin, no false-negative. Audit tables: specs/caddie-tee-selector-audit-{before,after}.md.
- **Lead 3 (logging):** 3 field-report-named sites folded to key=value message strings;
  `caddie_usage` kept bare (already extra=-asserted) to avoid a governance-blocked pre-existing
  test edit.
- **Gates:** ruff clean · backend non-DB 2977 passed/0 failed · targeted 271 passed · frontend
  tsc clean · lint 0 err · voice 278/278 · vitest 4/4.
- **Records:** backlog item `caddie-yardage-selector-corner-tree-bound` = done-on-bundle (targeted
  string insert, JSON validated); plan `specs/caddie-yardage-selector-p0-plan.md`.

Bundle #150 now carries ONE noticeable item (this) — ready for the coordinator's ship ask when chosen.

---

## 2026-07-18 — AWAITING: login/onboarding redesign PLAN (plan-first pass, no ship)

OWNER EPIC (verbatim): hates the login screen; wants full-screen Augusta-vibe animation,
first-time onboarding, modern/clean/exciting login (Google etc.); build our own SECURE auth
only if design freedom requires it. THIS PASS = the plan + backlog steps only (build later).

Dispatched IN PARALLEL (all read-only planning): product-manager (experience spec) +
designer (visual concept, BLOCKING input) + Plan-on-fable (auth decision + architecture +
security). Base origin/integration/next @ba04656. Current auth = Clerk with a substantial
headless native-token bridge already built (AuthProvider.tsx window.__internal_onBeforeRequest
FAPI hooks + Keychain token store + Svix webhook revocation + require_member authz) — but the
sign-in screen still renders Clerk's PREBUILT <SignIn> widget (the thing the owner hates).
Likely answer: Clerk HEADLESS/custom-flow (keep the security slices, full custom UI). Homegrown
= huge security surface for zero design gain — plan must present the tradeoff honestly. FLAG:
App Store REQUIRES Sign in with Apple when offering Google login (owner didn't mention it).

On resume: collect the 3 agent outputs -> synthesize specs/login-onboarding-redesign-plan.md
-> reviewer sanity pass on the auth recommendation -> append 5-8 backlog items (targeted edits,
validate JSON) -> commit SILENT on integration/next -> progress note. NEVER touch main. No ship.

---

## 2026-07-18 — LOGIN/ONBOARDING REDESIGN PLAN landed on integration/next (SILENT planning docs)

Owner epic (hates the login screen; wants Augusta-vibe full-screen animation + first-time
onboarding + modern login w/ Google etc.). PLAN-FIRST pass — no product code. Synthesized
`specs/login-onboarding-redesign-plan.md` from 3 parallel planning agents (PM experience spec,
designer visual concept, Fable architecture), landed SILENT on the bundle.

**AUTH DECISION: keep Clerk, go HEADLESS (custom flow). Do NOT build homegrown.** The thing the
owner hates is ONE component — Clerk's prebuilt `<SignIn>` widget. Headless custom-flow gives
byte-for-byte total UI freedom while keeping every shipped security slice (clerk_auth JWKS,
webhooks Svix revocation, require_member/APP_ACCESS_MODE, native-token/Keychain bridge). Fable
verified per-method coverage (email+pw/code, Google web + native ID-token, Apple native ID-token)
and **zero backend security delta**. Homegrown = enormous owned surface for ZERO design gain.
FLAGGED: App Store 4.8 REQUIRES Sign in with Apple once Google is offered (owner didn't mention it).

**LOOK:** designer reconciled "Augusta vibe" (= the feeling: pristine/verdant/reverent/serif —
NOT Masters/Augusta National imagery, zero licensing) with the Northstar via concept (B): a
signature hole that DRAWS ITSELF in ink (framer-motion pathLength over the existing
HoleIllustration.tsx + HOLES[] — no new deps, no asset pipeline), reduced-motion still-frame.

**ONBOARDING (PM):** additive `golfer_profiles.onboarding_step` column (last-completed-step enum,
backfill 'done' for existing rows), resumable server-driven flow name->handicap->bag->voice->home;
bag step wires straight into caddie grounding (the caddie is the product); the owner's named
two-user flip-time acceptance test. AuthGate gains a 4th (onboarding) state.

**Backlog:** 8 items appended (targeted text insert, JSON validated 116->124, 104 additions/0
deletions, no ids lost): `auth-clerk-enable-social-connections` (blocked-owner ops),
`auth-headless-spike` (READY, first-to-pick), `login-screen-visual`, `login-animation-moment`,
`onboarding-shell-and-gate`, `onboarding-bag-caddie-grounding`, `onboarding-voice-first-intro`,
`login-onboarding-epic-polish-review`. Dependency-ordered; spike gates everything.

AWAITING: reviewer security-lens sanity pass on the auth recommendation (agent a742098f) — fold
verdict into plan §7 + here. No ship, no owner ping (planning docs are SILENT).

**RESOLVED (reviewer):** security-lens verdict = SHIP-WITH-NOTES. Headless-Clerk-over-homegrown
is the correct security call; "zero backend delta" holds (FAPI hooks provider-level; azp derives
from Origin not the OAuth provider, so iss/azp/JWKS unchanged). Folded 3 refinements into plan §7 +
§5/§6 + the `auth-headless-spike` item: (1) sign-out clearing is CENTRALIZED in ClerkTokenBridge —
"audit every signOut() site" was the wrong invariant, spike asserts the observer still fires; (2)
native OAuth browser-redirect fallback MUST use a Universal Link, not a custom URL scheme; (3) five
hard spike gates (JWT parity, native bridge parity, sign-out Keychain clear, credential no-log grep
incl. plugin token + nonce binding, fallback safety). azp allowlist enumeration is a multi-user-epic
config item (unset today in owner-mode), not this epic. Planning pass COMPLETE — no ship, no ping.

---

## 2026-07-18 — `auth-headless-spike` BUILT (Slice 1, silent dev-flag) — CONSTRAINED-GO

Implemented `specs/auth-headless-spike-plan.md` end to end, behind `NEXT_PUBLIC_AUTH_SPIKE=1`
(zero user-visible change on the default build — proven by `auth-gate-routes.test.ts` +
byte-diff of the default `next build` output, which renders only a static "disabled" stub at
`/dev/auth-spike` and `/sso-callback`). Ugly throwaway panel
(`frontend/src/components/auth-spike/AuthSpikePanel.tsx`) exercises every flow named in the
plan against the pinned installed clerk-js/react Future-API types: email+password/code
sign-in+up, Google web (`signIn.sso`), Google native ID-token
(`clerk.authenticateWithGoogleOneTap`), Apple native ID-token (classic
`clerk.client.signIn.create({strategy:'oauth_token_apple'})` — no Future-API equivalent exists,
confirmed absent from the `.d.ts`), headless `signOut()`, JWT-parity capture/compare, and a
backend ping. Installed `@capgo/capacitor-social-login@8.3.35` (exact-pinned), ran `npx cap
sync ios` clean (`Package.swift` diff only).

**All 5 reviewer security gates implemented as concrete tests, all green:** Gate 1 —
`backend/tests/test_clerk_jwt_parity.py` (12 tests) mints REAL RS256-signed tokens with an
in-test RSA keypair and proves the UNCHANGED `clerk_auth._verified_user_id` accepts
baseline-shaped tokens from all four flow fixtures + `jwt-parity.test.ts` (7 tests) proves the
comparator. Gate 2 argued by construction (FAPI hooks are provider-level). Gate 3 —
`ClerkTokenBridge.test.tsx` (4 tests) proves the existing centralized sign-out observer still
fires correctly and no per-site `clearNativeToken()` calls were added. Gate 4 — new
`assert-no-credential-log.mjs` grep gate (mirrors `assert-no-auth-bypass.mjs`), 0 violations,
plus nonce-binding proof in `native-social.test.ts`. Gate 5 — confirmed `frontend/ios` has no
`.entitlements`/Associated Domains, so the browser-redirect fallback is correctly NOT built (ID-
token path only).

**All gate commands green:** `tsc`, `lint` (0 errors, 1 pre-existing unrelated warning), default
`next build` AND `NEXT_PUBLIC_AUTH_SPIKE=1 next build`, `vitest run` (147 files / 2753 tests),
voice-tests smoke (278/278), `assert-no-credential-log.mjs`, `test:native-crash` (no webview
crash with the new plugin installed), backend `ruff check` + the new pytest file (12 tests) +
existing `test_clerk_auth.py` (21 tests, unaffected — `clerk_auth.py` has zero diff).

**Discovered constraint (confirmed, not hypothetical):** `@clerk/react@6.11.1`'s
`useSignIn`/`useSignUp` are the signal-based Future API, NOT the classic API the epic plan
(§2.2) assumed — Slice 2's `useAuthFlow.ts` must be built on the Future API as primary with the
classic `clerk.client.*` surface only for the Apple ID-token step (no Future-API equivalent
exists). Manual `/security-review` pass (no interactive skill available in this session; did the
equivalent review by hand) found no blocking issues — one accepted residual risk flagged for the
eng-lead (same class as the pre-existing `NEXT_PUBLIC_AUTH_DIAG`, no prebuild guard added,
happy to add one if wanted).

**Verdict: CONSTRAINED-GO** (`specs/auth-headless-spike-verdict.md`) — not a clean GO because
this non-interactive builder session had no browser tool / dev Clerk credentials to actually
click through the live web-dev email flows the plan's step 8 asked for; everything offline-
provable is green and the code compiles against the pinned real types. Full FLIP-TIME
VERIFICATION CHECKLIST in the verdict file (live web-dev pass, Google/Apple live round-trips
pending `auth-clerk-enable-social-connections`, on-device Gate 2/3 matrix, native Swift source
read). SILENT work (dev-flag only) — no owner ping, no ship. Committed to `integration/next`,
not pushed (eng-lead pushes after review).

---

## AWAITING (eng-lead cycle, 2026-07-18) — login-screen-visual (Slice 2, NOTICEABLE)
Base synced to origin/integration/next @7b6dc0c (spike landed CONSTRAINED-GO, reviewer SHIP,
QA PASS, CI green #150). Building Slice 2: replace the ancient prebuilt-Clerk login with the
designed Augusta-vibe custom headless screen (STATIC hero; self-drawing animation is Slice 3).
FLIP DECISION (confirmed from plan §4.2/§5): the new screen REPLACES SignInClient's internals
outright — NOT gated behind NEXT_PUBLIC_AUTH_SPIKE (that flag only gates the throwaway
/dev/auth-spike + /sso-callback dev-reachability). New login is ON by default for the owner's
next build; only Google/Apple OAuth buttons render live-DISABLED ("coming online shortly")
behind the pending auth-clerk-enable-social-connections ops item. Email password+code flows are
fully live via the spike-proven Future API.

AWAITING: Plan(fable) on specs/login-screen-visual-plan.md. On plan return -> dispatch builder
to implement on integration/next; then designer(BLOCKING, live screenshots) + reviewer + qa;
iterate; update PR #150 checklist NOTICEABLE; records. Do NOT ship/ping this cycle.

## AWAITING update (2026-07-18) — builder dispatched
Plan landed @a0a088d (specs/login-screen-visual-plan.md, Fable). Builder dispatched to
implement on integration/next in the main checkout. On builder return -> designer(BLOCKING,
live screenshots) + reviewer + qa in parallel; iterate on BLOCKING; update PR #150 checklist
NOTICEABLE; backlog flip; progress. Do NOT ship/ping this cycle.
