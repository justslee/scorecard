# Onboarding Shell + Gate — Implementation Plan (Slice 4 of login+onboarding redesign)

**Backlog item:** `onboarding-shell-and-gate` · **Base:** `integration/next` @ `26072c2` · **Epic:** `specs/login-onboarding-redesign-plan.md` §4/§5/§6/§8-row-4. All paths below are relative to the repo root (`/Users/justinlee/projects/scorecard`).

**What ships:** the resumable first-run onboarding flow (Name → Handicap → Bag → Meet-your-caddie placeholder), server-persisted `onboarding_step` on `golfer_profiles` (new Alembic rev 016 with a one-time `'done'` backfill for every pre-existing row), the `AuthGate` fourth state, and the tri-state `onboardingStep` surfaced through `useMe`/`MeState`. Existing users — including the owner — must NEVER see onboarding; brand-new sign-ups always must. That invariant is the reviewer's blocking check and this plan's highest priority.

---

## 1. Approach / architecture

### 1.1 The end-to-end state machine

```
sign-up completes (Clerk headless flow, Slice 2 — unchanged)
  → isSignedIn=true → IdentityBridge/useMe hydrates onboardingStep (ONE GET /api/profile/golfer)
      GET 200 → publish row.onboardingStep ('done' | 'name' | 'handicap' | 'bag' | null)
      GET 204 → ensure row via PUT {} (existing behavior) → publish null   (row now exists, onboarding_step NULL)
      GET fails (offline/backend down) → publish cached last-known step, else fail-open 'done'
  → AuthGate (4th state): isSignedIn && step!=='done' && !isOnboardingRoute(pathname)
      step==='unknown' → PaperLoading (NEVER children, NEVER onboarding — zero-flash tri-state)
      step!=='done'    → router.replace('/onboarding') behind PaperLoading
  → /onboarding (single client-only route; internal sub-step initialized ONCE from the
      hydrated step — no route chain, no second fetch in the normal path)
      Name      → PUT {name, onboardingStep:'name'}          → advance on success only
      Handicap  → PUT {handicap:<n|null>, onboardingStep:'handicap'} → advance
      Bag       → saveGolferBagAsync(bag) → PUT {onboardingStep:'bag'} → advance   (or skip: PUT {onboardingStep:'bag'} only)
      Meet-your-caddie placeholder → PUT {onboardingStep:'done'} → publish('done') → router.replace('/')
  → Home ('/'): AuthGate sees 'done' → children. Done forever.
```

`onboarding_step` semantics (locked in epic §4.1): **the last COMPLETED step** — `NULL` = nothing completed (brand-new), `'name'`/`'handicap'`/`'bag'` = resume at the NEXT step, `'done'` = never gate again. Every step **awaits its server write before advancing**, so a force-quit at any point resumes exactly where the server says.

### 1.2 How the tri-state flows without flashing (the load-bearing design)

A small module-level store inside `frontend/src/lib/identity.ts` (same file as `useMe` — no new architectural seam), consumed via `useSyncExternalStore` so every `useMe()` instance (IdentityBridge AND AuthGate) sees one shared value:

```ts
export type OnboardingStepValue = "name" | "handicap" | "bag" | "done";
/** null = row exists/created but nothing completed (brand-new user). */
export type OnboardingStepState = OnboardingStepValue | null | "unknown";

// module scope in identity.ts:
let onboardingSnapshot: { userId: string | null; step: OnboardingStepState; profile: GolferProfile | null };
const onboardingListeners = new Set<() => void>();
let hydratedForUserId: string | null = null;   // module-level once-per-user guard —
                                               // replaces the per-instance ensuredForRef so a second
                                               // useMe() mount (AuthGate) can never double-fetch/double-ensure
```

- **Hydration** happens in `useMe`'s existing sign-in effect, folded into `ensureGolferProfile` (renamed `hydrateGolferProfile`): GET (via the existing `getGolferProfileAsync` from `./api`), publish the step + retain the fetched `GolferProfile` object in the snapshot (so the onboarding page needs **no second fetch**); if 204, keep the existing `updateGolferProfile({})` ensure, then publish `null`.
- **Zero-flash for done users AND no cold-open regression:** the store lazy-initializes **synchronously** from a namespaced localStorage cache — key `storageKey('onboarding_step')` (`frontend/src/lib/storage-keys.ts`, → `scorecard_<uid>_onboarding_step`; new key, no legacy-migration entry needed). Cache is written **only with server-confirmed values** (after a successful GET or a successful step PUT; `null` persisted as sentinel `'new'`). So: a done user's device renders children instantly from cache while the GET revalidates; a first-open-on-new-device shows PaperLoading for one GET; the "unknown" state can never show onboarding.
- **Fail-open on fetch failure** (REQUIRED — see §4 "offline" and note that Playwright CI runs with NO backend at `localhost:8000`): GET error → cached value if present, else `'done'` (published with `persist:false` so the next online launch re-gates correctly). Never brick the app behind PaperLoading.
- **Per-user correctness:** `useMe()` returns `onboardingStep: 'unknown'` whenever `onboardingSnapshot.userId !== user.id` (account switch can't leak another user's step). `MeState` gains the field:

```ts
export interface MeState {
  userId: string | null;
  isLoaded: boolean;
  isSignedIn: boolean;
  /** Tri-state onboarding gate value — 'unknown' until the profile GET resolves. */
  onboardingStep: OnboardingStepState;
}
```

- **Writer API for the flow:** `export function publishOnboardingStep(userId: string, step: OnboardingStepValue | null): void` — updates snapshot + cache + notifies. The onboarding flow calls it after each successful PUT; calling it with `'done'` is what lets `router.replace('/')` land on children with no bounce-back.
- Also export `getHydratedGolferProfile(): GolferProfile | null` (module getter) for the onboarding flow's prefills.

### 1.3 How AuthGate decides (SSR/static-export safe)

`AuthGate` calls `useMe()` (it already renders only inside `<ClerkProvider>` — `AuthProvider.tsx` line ~224 — so Clerk hooks are safe; at static-export prerender AuthProvider returns bare children and AuthGate never mounts, unchanged). Order of checks in `AuthGate`:

1. hooks (`useAuth`, `useMe`, `usePathname`) — unconditional, top.
2. `NEXT_PUBLIC_AUTH_BYPASS === "1"` short-circuit → children. **FIRST, exactly as today (line 104)** — a bypass build never evaluates the onboarding state, so it can neither leak anything new nor funnel into onboarding (see §4).
3. `!isLoaded` → `PaperLoading` — untouched.
4. `isAuthRoute(pathname, SPIKE_AUTH_PREFIXES)` → children — untouched.
5. `!isSignedIn` → `<SignInClient/>` — untouched.
6. **NEW 4th state:** `if (!isOnboardingRoute(pathname)) { if (onboardingStep === 'unknown') return <PaperLoading/>; if (onboardingStep !== 'done') return <OnboardingRedirect/>; }`
7. children.

- `export function isOnboardingRoute(pathname: string): boolean` — same boundary rules as `isAuthRoute` (`/onboarding`, `/onboarding/…`, `/onboarding#…`); exported for unit tests.
- `OnboardingRedirect` (private component in AuthGate.tsx): `useRouter()` + `useEffect(() => router.replace('/onboarding'))`, renders `PaperLoading`. Redirect (not inline render) keeps the single `/onboarding` route the one source of the flow and keeps AuthGate dumb.
- When ON `/onboarding` signed-in, AuthGate passes children through regardless of step; the flow itself redirects `'done'` users to `/` (covers a done user deep-linking to `/onboarding`).
- The onboarding page itself is client-only via the proven `SignInClient` pattern: `dynamic(() => import(...), { ssr:false, loading: <paper shell> })` — no Clerk hooks at prerender, static-export safe.

---

## 2. Exact files to touch

### CREATE — migration (reviewer BLOCKING; match `0012_015_course_intel.py` style byte-for-byte in structure)

**`backend/migrations/versions/0013_016_golfer_profile_onboarding.py`**

```python
"""016_golfer_profile_onboarding: resumable first-run onboarding state.

Adds additive, NULLABLE ``golfer_profiles.onboarding_step text`` — the last
COMPLETED onboarding step (NULL | 'name' | 'handicap' | 'bag' | 'done', see
specs/login-onboarding-redesign-plan.md §4.1), then a ONE-TIME backfill of
'done' for every PRE-EXISTING row so no current user (incl. the owner) is
ever funneled into first-run onboarding.

CRITICAL: the column has NO DEFAULT on purpose. A DEFAULT of 'done' would
make brand-new sign-ups insert 'done' and skip onboarding entirely. New rows
must insert NULL (= needs onboarding); only rows that predate this migration
are backfilled to 'done'. Metadata-only ADD COLUMN + one small UPDATE — no
lock hazard at this table's scale.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers
revision: str = "016_golfer_profile_onboarding"
down_revision: Union[str, Sequence[str], None] = "015_course_intel"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE public.golfer_profiles "
        "ADD COLUMN IF NOT EXISTS onboarding_step text"
    )
    # One-time backfill: every row existing at migration time is a
    # pre-feature user — mark COMPLETED so they are never onboarded.
    op.execute(
        "UPDATE public.golfer_profiles "
        "SET onboarding_step = 'done' "
        "WHERE onboarding_step IS NULL"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE public.golfer_profiles DROP COLUMN IF EXISTS onboarding_step"
    )
```

Never touch `backend/supabase/migrations/**`. The migration auto-applies at merge via the deploy's `alembic upgrade`; eng-lead flags it in the PR + owner ship-it (builder just commits it).

### EDIT — the lockstep type sites (ALL in ONE commit, per CLAUDE.md types.ts↔models.py rule)

1. **`backend/app/db/models.py`** — `GolferProfile` ORM, after `caller_voice`:
   ```python
   # Added by migration 016 — last COMPLETED onboarding step
   # (NULL | 'name' | 'handicap' | 'bag' | 'done'); maps to
   # types.ts GolferProfile.onboardingStep. NULL (no default) on new rows.
   onboarding_step: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
   ```
2. **`backend/app/models.py`** — add to `GolferProfile`, `GolferProfileCreate`, AND `GolferProfileUpdate`:
   ```python
   # Last COMPLETED onboarding step (maps to golfer_profiles.onboarding_step).
   onboardingStep: Optional[str] = None
   ```
3. **`backend/app/routes/profile.py`** — the camelCase↔snake mapping is exactly `onboardingStep ↔ onboarding_step`. Changes:
   - Extend the module docstring mapping table with `onboarding_step → onboardingStep`.
   - Add `_ALLOWED_ONBOARDING_STEPS = {"name", "handicap", "bag", "done"}` and a tiny guard `_validate_onboarding_step(value: Optional[str])` → `HTTPException(422, "Invalid onboardingStep")` when a non-None value is outside the set. Call it in POST, and in PUT when `"onboardingStep" in data.model_fields_set` (cheap hygiene; keeps DB values a closed enum — worst case without it is self-inflicted, but /security-review rides this slice).
   - `_orm_to_pydantic`: add `onboardingStep=row.onboarding_step,`.
   - POST create: constructor gains `onboarding_step=data.onboardingStep,`.
   - PUT **create branch** (row missing — this is the wizard's first PUT for a user whose ensure failed): constructor gains `onboarding_step=data.onboardingStep,` (defaults `None` → NULL when omitted).
   - PUT **update branch** (present-only semantics, matching the existing fields):
     ```python
     if "onboardingStep" in data.model_fields_set:
         row.onboarding_step = data.onboardingStep
     ```
4. **`frontend/src/lib/types.ts`** — `GolferProfile` gains (required, per lockstep with the backend response model):
   ```ts
   /** Last COMPLETED onboarding step: null | 'name' | 'handicap' | 'bag' | 'done'.
    *  Kept in sync with backend/app/models.py GolferProfile.onboardingStep. */
   onboardingStep: string | null;
   ```
   **tsc fallout to fix in the same commit** (required field on existing literals — verified these are all of them; re-run `tsc --noEmit` and treat the compiler as ground truth for any others):
   - `frontend/src/app/profile/page.tsx` ~line 858: the `onBagSaved({ ...(profile ?? { id:"", name:null, handicap:null, homeCourse:null }) …` fallback literal gains `onboardingStep: null`.
   - Test fixtures: `frontend/src/lib/caddie/clubs.test.ts` (~48), `frontend/src/lib/stats-grounding.test.ts` (~68), `frontend/src/lib/storage.test.ts` (~123) — each gains `onboardingStep: null`.
5. **`frontend/src/lib/api.ts`** — `updateGolferProfile(data)` sends `JSON.stringify(data)` verbatim, so the ONLY change needed for body forwarding is the interface: add `onboardingStep?: string | null;` to BOTH `GolferProfileUpdate` (~line 468) and `GolferProfileCreate` (~line 454), with the omitted-vs-null doc note matching the existing comment ("omit = no change; onboarding only ever writes concrete steps").

### EDIT — identity / gate

6. **`frontend/src/lib/identity.ts`** — per §1.2: the store, `OnboardingStepValue`/`OnboardingStepState` types, `MeState.onboardingStep`, `useSyncExternalStore` subscription in `useMe`, module-level `hydratedForUserId` guard replacing `ensuredForRef` (preserve the existing ensure-PUT-{} behavior and its "never throw into render" discipline), `publishOnboardingStep`, `getHydratedGolferProfile`, synchronous cache init via `storageKey('onboarding_step')` with `'new'` ↔ `null` sentinel, fail-open `'done'` on fetch error (persist:false).
7. **`frontend/src/components/AuthGate.tsx`** — per §1.3: `isOnboardingRoute` export, 4th state, `OnboardingRedirect`, `useMe` import. States 1–3 and the bypass short-circuit stay byte-identical. Update the header comment to document four states.

### CREATE — onboarding route + components

8. **`frontend/src/app/onboarding/page.tsx`** — thin client page mirroring `SignInClient.tsx`: `"use client"`, `dynamic(() => import("@/components/onboarding/OnboardingFlow"), { ssr:false, loading: () => <paper shell> })` (copy the `PaperShell` masthead pattern; kicker `"Getting set up"`).
9. **`frontend/src/components/onboarding/steps.ts`** — pure, framework-free (unit-testable):
   ```ts
   export type SubStep = "name" | "handicap" | "bag" | "intro";
   export const SUB_STEP_ORDER: SubStep[] = ["name", "handicap", "bag", "intro"];
   /** Server's last-COMPLETED step → the sub-step to show. 'done' → null (leave). */
   export function initialSubStep(step: OnboardingStepState): SubStep | null {
     if (step === "done") return null;
     if (step === "name") return "handicap";
     if (step === "handicap") return "bag";
     if (step === "bag") return "intro";
     return "name"; // null / 'unknown'-shouldn't-reach / anything else → start
   }
   ```
10. **`frontend/src/components/onboarding/OnboardingFlow.tsx`** — the shell + state machine (see §3): waits on `useMe().onboardingStep !== 'unknown'` (renders the paper shell meanwhile), initializes sub-step once via `initialSubStep`, `'done'` → `router.replace('/')`, renders `ProgressTicks` + the current step, `AnimatePresence` cross-fade (opacity/8px translate, 200ms, `T.ease`; `useReducedMotion()` → no motion), and owns the write-then-advance handlers (each `await api.updateGolferProfile(...)`, then `publishOnboardingStep(...)`, then advance; on throw → calm inline error, stay).
11. **`frontend/src/components/onboarding/NameStep.tsx`**, **`HandicapStep.tsx`**, **`BagStep.tsx`**, **`MeetCaddieStep.tsx`** — presentational steps (§3), receiving values/prefills + `onContinue`-style callbacks; no fetch logic inside steps.
12. **`frontend/src/lib/caddie/clubs.ts`** — add the camel-keyed onboarding defaults (short→camel mapping table from `backend/app/caddie/club_selection.py` `DEFAULT_CLUB_DISTANCES`; no short→camel map exists anywhere in the frontend — only the camel→short `buildClubMap` in this file, so this is the one new mapping, placed beside its inverse):
    ```ts
    /** Mirror of backend DEFAULT_CLUB_DISTANCES (club_selection.py), re-keyed to the
     *  GolferProfile camelCase keys via buildClubMap's mapping run in reverse.
     *  KEEP IN SYNC. Backend short key → camel key → yards:
     *    driver→driver 250 · 3wood→threeWood 230 · 5wood→fiveWood 215 · hybrid→hybrid 200
     *    4iron→fourIron 190 · 5iron→fiveIron 180 · 6iron→sixIron 170 · 7iron→sevenIron 160
     *    8iron→eightIron 150 · 9iron→nineIron 140 · pw→pitchingWedge 130 · gw→gapWedge 115
     *    sw→sandWedge 100 · lw→lobWedge 85 · (no putter in backend defaults — putter stays unset)
     */
    export const DEFAULT_BAG_CAMEL: GolferProfile["clubDistances"] = {
      driver: 250, threeWood: 230, fiveWood: 215, hybrid: 200,
      fourIron: 190, fiveIron: 180, sixIron: 170, sevenIron: 160,
      eightIron: 150, nineIron: 140, pitchingWedge: 130, gapWedge: 115,
      sandWedge: 100, lobWedge: 85,
    };
    ```

### EDIT — nav/orb visibility (orb present on the onboarding route)

13. **`frontend/src/components/nav/shouldShowCaddieOrb.ts`** — add `'/onboarding'` to `SHOW_EXACT` (per epic §3.3 the orb appears small + idle from the Name step in its production position; this is also the Slice-6 seam — `CaddieOrbSheet` is mounted globally inside AuthGate's children, so `openLooper()` will Just Work later). Update `shouldShowCaddieOrb.test.ts`.
14. **`frontend/src/components/CaddieOrb.tsx`** — in BOTH one-time intro-chip effects (`INTRO_SEEN_KEY` ~line 172 and `INVERT_INTRO_SEEN_KEY` ~line 196), add an early `if (normalizePath(pathname) === '/onboarding') return;` BEFORE the localStorage burn — so "Your caddie moved here" is deferred (not consumed) during onboarding and fires naturally on the first Home render, exactly the epic §3.2 land-on-home handoff. Two guard lines, nothing else. (Verify the exact symbol names/lines; adapt if they differ.)
15. **`frontend/src/components/nav/shouldEnableBackSwipe.ts`** — add `if (p === '/onboarding') return false;` (a left-edge back-swipe would `router.back()` to `/` and bounce straight back through the gate — a pointless flash; onboarding has no "back"). Update/extend its test in the matching style.

`FloatingTabBar` already hides on `/onboarding` (not in `HUB_ROUTES`) — no change (verify).

### CREATE/EDIT — tests (see §6 for content)

16. `backend/tests/test_onboarding_migration.py` (new, pure), `backend/tests/integration/test_onboarding_step.py` (new, DB-backed), `frontend/src/components/AuthGate.test.tsx` (new, vitest), `frontend/src/components/onboarding/steps.test.ts` (new), `frontend/src/components/auth-gate-routes.test.ts` (extend with `isOnboardingRoute`), `frontend/src/lib/caddie/clubs.test.ts` (extend: defaults parity), `frontend/e2e/helpers.ts` (extract `signInWithEmailCode` from `auth.spec.ts`; auth.spec.ts imports it — zero behavior change), `frontend/e2e/onboarding.spec.ts` (new).

---

## 3. The 4 steps' UX (render target — designer reviews at 375px)

**Shared shell (`OnboardingFlow`):** full-height (`100dvh`) paper — `background: ${PAPER_NOISE}, ${T.paper}`, `backgroundBlendMode: "multiply"` — padding `max(24px, env(safe-area-inset-top)) 28px max(28px, env(safe-area-inset-bottom))`. NO card chrome, NO header bar, NO step numbers, NO "wizard" framing. Content column max-width 340, left-aligned.

**Progress indicator (scorecard-row hairline ticks):** top of content, a single row like a scorecard hole strip — four segments, each a 22×1px horizontal hairline with a tiny 3px vertical tick at its left end (evoking the scorecard column separators), 10px gaps. Completed = `T.ink` at full opacity; current = `T.accent` (cobalt, the one accent use per screen); upcoming = `T.hairline`. Above it a mono kicker line — `fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.8, textTransform: "uppercase", color: T.pencil` — step-specific (below). No "Step 2 of 4" text anywhere.

**Question type (all steps):** oversize serif-italic, `fontFamily: T.serif, fontStyle: "italic", fontSize: 34, letterSpacing: -0.8, lineHeight: 1.12, color: T.ink`, margin-top 18vh-ish (vertically upper-third, generous whitespace below) — the `VoiceSheet` empty-state / `SignInScreen` masthead language (SignInScreen uses 52px for the wordmark; questions sit one register below).

**Underline inputs:** no box — `border: none; borderBottom: 1px solid ${T.hairline}; background: transparent; borderRadius: 0`; focus → borderBottom color `T.ink` (no outline ring); `fontFamily: T.serif, fontSize: 24` (≥16px — no iOS auto-zoom, same rule as SignInScreen's 17px note), `color: T.ink`, placeholder `T.pencilSoft`, `padding: 6px 0`. Written "on the line", not a Material field.

**Buttons:** pill `borderRadius: 999` only (never 4px SaaS radius). Primary = ink-filled (`background: T.ink, color: T.paper`, height 52, full-width, `fontFamily: T.sans, fontSize: 15, fontWeight 500`) — identical language to SignInScreen's primary pill. Secondary/equal-weight = same geometry, `background: transparent, border: 1px solid ${T.hairline}, color: T.inkSoft`. Disabled = opacity 0.35 + `disabled`. While a write is in flight: both disabled, primary label unchanged (no spinners; quiet). Write failure: mono line under the buttons — `fontSize: 10, letterSpacing: 0.6, color: T.errorInk` (use the app's existing error token; fall back to a muted ink-red if none) — copy: `Couldn't save — check your connection and try again.` User stays on the step.

**Step transitions:** AnimatePresence, exit/enter opacity 0↔1 + y 8→0, 200ms `T.ease`; `useReducedMotion()` → instant swap.

### Step 1 — Name (required)
- Kicker: `INTRODUCTIONS`. Question: **"What should your caddie call you?"**
- One underline input, placeholder `Your name`, `autoComplete="given-name"`, prefilled from `getHydratedGolferProfile()?.name ?? ""` (resume-safe).
- Primary pill `Continue` — **disabled while `value.trim() === ""`** (whitespace blocks). No skip.
- On Continue: `await api.updateGolferProfile({ name: value.trim(), onboardingStep: "name" })` → `publishOnboardingStep(userId, "name")` → advance.

### Step 2 — Handicap (optional; equal-weight not-sure path)
- Kicker: `YOUR GAME`. Question: **"What's your handicap?"** Sub-line (sans 13, `T.inkSoft`): "Roughly is fine — we'll refine it as you play."
- Underline input, `inputMode="decimal"`, placeholder `12.4`, width ~120px, validation: parses to a number in `[0, 54]` (one decimal ok). Invalid/non-empty → Continue disabled.
- **Two full-width pills, stacked 10px apart, identical size (this equality is the spec):**
  - Primary (ink) `Continue` — enabled only with a valid number → `PUT { handicap: n, onboardingStep: "handicap" }`.
  - Hairline `I'm not sure — I don't have one` → `PUT { handicap: null, onboardingStep: "handicap" }` (explicit null clear; the backend `model_fields_set` path writes NULL).
- Either advances; only the value is optional. (The epic §3.2 ruler-tick picker is a later craft pass — NOT this slice; the underline input is the contract here.)

### Step 3 — Bag (defaults pre-filled, skippable)
- Kicker: `THE BAG`. Question: **"What's in the bag?"** Sub-line: "Carry yardages — so your caddie knows your game. Close is good enough."
- Reuse the exact `CLUB_CONFIG` from `frontend/src/app/profile/page.tsx` (line 25). **Export it from that file** (`export const CLUB_CONFIG …` — additive, no behavior change) and import it in `BagStep` — do NOT duplicate the list.
- 15 rows (incl. `Putter (optional)`), each ~40px tall, separated by `T.hairlineSoft` hairlines (scorecard rows): label left in mono 10px uppercase `T.pencil`; right-aligned underline numeric input (width 64, serif 17, `inputMode="numeric"`), **prefilled from `DEFAULT_BAG_CAMEL`** (putter prefilled empty — backend defaults have no putter). List scrolls inside the step; buttons pinned below with a top hairline.
- Validation identical to the profile Bag editor: blank = omit key; else `Math.round(parseFloat)`, reject `NaN`/`<=0`/`>500` with the calm error line naming the club.
- **Two pills:** primary ink `Use these` → build `clubDistances` from current inputs → `await saveGolferBagAsync(clubDistances)` (`frontend/src/lib/storage-api.ts` ~335 — write-through local cache, bag-only PUT, exactly the epic §4.2 call) → `await api.updateGolferProfile({ onboardingStep: "bag" })` → publish → advance. Hairline `Skip — set up later` → `PUT { onboardingStep: "bag" }` only; `clubDistances` stays `{}` (safe: caddie falls back to `DEFAULT_CLUB_DISTANCES`).
- Full caddie-grounding wiring/flip-test is Slice 5 — this step must not block it: it already feeds `golfer_profiles.bag_clubs` via the same `saveGolferBagAsync` the profile editor uses, which is all Slice 5 needs.

### Step 4 — Meet your caddie (PLACEHOLDER — the Slice 6 seam)
- The REAL production orb is on screen bottom-right (via the `shouldShowCaddieOrb` change; idle, no pulse, intro chips deferred per §2.14). Do NOT render a second orb or any bespoke mic UI.
- Kicker: `ONE LAST THING`. Question: **"Meet your caddie."** Body (sans 13.5, `T.inkSoft`, lineHeight 1.55, max 300px): "That quiet dot in the corner is your caddie. Tap it any time — reading a shot, picking a course, settling a bet. It's already looking after your book."
- One primary ink pill `Open your book` → `await api.updateGolferProfile({ onboardingStep: "done" })` → `publishOnboardingStep(userId, "done")` → `router.replace("/")`. (This IS the skip — the step is a single always-enabled action; on write failure, calm error + stay.)
- Code comment at the top of `MeetCaddieStep.tsx`, verbatim contract for Slice 6:
  `// SLICE-6 SEAM (onboarding-voice-first-intro): this static screen is replaced by the real voice moment — openLooper({ context: "general", listening: true, presentation: "full" }) from lib/looper-bus.ts — keeping this step's PUT {onboardingStep:'done'} → publish → replace('/') completion contract intact.`

---

## 4. Edge cases & risks (each with its resolution)

- **Pre-feature user (incl. the owner):** migration backfills `'done'` → gate never fires. Proven per §7. A pre-feature Clerk user with NO `golfer_profiles` row (ensure never succeeded for them) WILL be onboarded on next open — correct-by-design (they have no name/bag anywhere) and worth one sentence in the PR.
- **ensureGolferProfile timing (reconciling epic §4.4 "row created by wizard's first PUT"):** current reality (verified in `identity.ts`) is that `useMe` PUT-creates an empty row on first sign-in. That is FINE and the plan embraces it: both the PUT create-branch and POST leave `onboarding_step` NULL unless supplied, so **a freshly-ensured row has `onboarding_step = NULL` → funneled into onboarding.** The §4.4 sentence's real invariant (OAuth-cancel leaves no row; NULL rows onboard) holds. The wizard's first PUT hits the update branch of the upsert (row exists) — and if the ensure had failed (offline blip), the same PUT's create branch persists `{name, onboardingStep:'name'}` correctly. Both paths specified in §2.3.
- **Force-quit resume at each step:** every advance is server-write-first. Kill after Name-PUT lands → reopen → GET returns `'name'` → `initialSubStep` → Handicap, name never re-asked. Same for each step. Kill DURING a PUT → worst case the step re-shows (idempotent PUTs, prefilled values) — acceptable.
- **Returning user zero-flash:** tri-state — `'unknown'` renders PaperLoading, never children, never onboarding; synchronous cache init makes the common case instant (no cold-open regression for done users after their first hydrated open). Cache is server-confirmed-only, so it can never invent `'done'` persistently for a new user.
- **Offline / backend-down open (and the backendless Playwright CI environment):** GET fails → cached step, else fail-open `'done'` with `persist:false` — app never bricks; a genuinely-new user in this rare state (sign-in itself requires network) skips onboarding for that session and is re-gated on the next successful GET. This fail-open is also what keeps the EXISTING Tier-2 e2e core journeys green (they sign in with no backend at `localhost:8000`).
- **Skipped bag:** `clubDistances` stays `{}` — safe empty-bag state (caddie falls back to `DEFAULT_CLUB_DISTANCES`); editable later at `/profile` (unchanged).
- **Empty/whitespace name:** Continue disabled on `trim() === ""`; the PUT sends the trimmed value.
- **Camel/short key map:** frontend keys are camelCase (`CLUB_CONFIG`/types.ts), backend defaults are short-keyed; **no short→camel map exists in the frontend today**, so `DEFAULT_BAG_CAMEL` (§2.12) is the single new mapping, with `lw→lobWedge:85` present and `putter` deliberately absent, guarded by a parity unit test (§6).
- **AUTH_BYPASS interaction:** the bypass short-circuit stays FIRST and unchanged — a bypass build returns children before any onboarding logic, so it cannot be funneled into onboarding (in bypass there's no token; the GET would fail and even the fail-open path is never reached). It leaks exactly what it leaks today (by design, test builds only; backend still 401s). `scripts/assert-no-auth-bypass.mjs` prebuild guard untouched. Re-verified via the AuthGate vitest case (§6).
- **Static-export / dynamic-import safety:** onboarding page uses the exact `SignInClient` pattern (`dynamic`, `ssr:false`, paper-shell loading). `AuthGate`/`useMe` only ever mount inside `ClerkProvider` (unchanged AuthProvider branch). No new deps.
- **Account switch on one device:** store is userId-keyed; mismatched snapshot reads as `'unknown'` → PaperLoading until the new user's GET lands. Stale local-cache profile objects (pre-feature) lacking `onboardingStep` are irrelevant to the gate (it reads only the store/cache key, never `storage.ts`'s cached profile).
- **Concurrent devices:** last-write-wins on a per-step TEXT column — harmless (steps only move forward in practice; a regression writes at worst re-shows a step).
- **Risk — designer pass:** the handicap ruler-tick picker and richer bag checklist from epic §3.2 are intentionally NOT here (kept for polish slices); flag in the PR so the designer reviews against THIS plan's §3, not the epic's aspirational craft details.

---

## 5. Shared-type sync (one commit)

Commit 1 contains, atomically: migration file `0013_016_golfer_profile_onboarding.py` · ORM `onboarding_step` (`backend/app/db/models.py`) · Pydantic `onboardingStep` ×3 (`backend/app/models.py`) · route mapping + validation (`backend/app/routes/profile.py`) · `types.ts` `GolferProfile.onboardingStep: string | null` (+ the 4 literal/fixture fixes) · `api.ts` `GolferProfileCreate`/`GolferProfileUpdate.onboardingStep?` · backend tests for the field. Mapping contract, spelled once more: **wire/JSON `onboardingStep` (camelCase) ⇔ column `onboarding_step` (snake), values `null | 'name' | 'handicap' | 'bag' | 'done'`, mapped only in `routes/profile.py` (`_orm_to_pydantic` + the two create constructors + the `model_fields_set` update branch)** — no other file translates the name. Commit 2: identity store + AuthGate + nav/orb edits + their tests. Commit 3: onboarding route/components + e2e. (Commits 2–3 may merge if the builder prefers; commit 1's atomicity is the hard rule.)

## 6. Gates (all must pass; commands per CLAUDE.md)

- **Frontend:** `cd frontend && npm run lint` · `npx tsc --noEmit` · `npx tsx voice-tests/runner.ts --smoke` (expected UNAFFECTED — nothing under `lib/voice/*` or caddie prompts changes; run to confirm) · `npm test` (vitest) · `npm run build`.
- **Backend:** `cd backend && uv run ruff check .` · `uv run pytest` — integration tests self-skip without a reachable Postgres (verified: `tests/integration/conftest.py` TCP-probes and uses `Base.metadata.create_all`, so the NEW ORM COLUMN IS AUTOMATICALLY IN THE TEST SCHEMA — no local Alembic/DB required of the builder; CI's Postgres service runs them for real). DO NOT spin up a local Postgres container.
- **New backend tests:**
  - `backend/tests/test_onboarding_migration.py` (pure, no DB): reads `backend/migrations/versions/0013_016_golfer_profile_onboarding.py` as text/module and asserts (a) `revision == "016_golfer_profile_onboarding"`, `down_revision == "015_course_intel"`; (b) the ADD COLUMN statement contains **no `DEFAULT`**; (c) the backfill `UPDATE … SET onboarding_step = 'done' WHERE onboarding_step IS NULL` is present; (d) downgrade drops the column. This encodes the reviewer's blocking invariants as executable checks.
  - `backend/tests/integration/test_onboarding_step.py` (DB-backed, modeled on `test_routes.py::test_profile_get_put_get`): ① PUT `{}` (the sign-in ensure) creates a row → GET returns `onboardingStep: null` — **proves fresh sign-ups are gated**; ② PUT `{"name":"Jess","onboardingStep":"name"}` on a missing row (create branch) → GET `'name'`; ③ PUT `{"handicap": null, "onboardingStep":"handicap"}` → GET `handicap: null` + `'handicap'`; ④ PUT `{"handicap": 10.0}` (no onboardingStep) → step still `'handicap'` (present-only proven); ⑤ PUT `{"onboardingStep":"done"}` → GET `'done'`; ⑥ PUT `{"onboardingStep":"garbage"}` → 422.
- **New frontend unit tests (vitest):** `steps.test.ts` (`initialSubStep` table: null→name, name→handicap, handicap→bag, bag→intro, done→null) · extend `auth-gate-routes.test.ts` (`isOnboardingRoute` boundaries: `/onboarding`, `/onboarding/`, `/onboarding#x` pass; `/onboarding-x`, `/` fail) · `clubs.test.ts` parity test: set profile `clubDistances = DEFAULT_BAG_CAMEL` → `buildClubMap()` deep-equals `{driver:250, "3wood":230, "5wood":215, hybrid:200, "4iron":190, "5iron":180, "6iron":170, "7iron":160, "8iron":150, "9iron":140, pw:130, gw:115, sw:100, lw:85}` (guards the short↔camel table against drift) · `AuthGate.test.tsx` (mock `@clerk/react`, `next/navigation`, `@/lib/identity`): signed-in + `'unknown'` → PaperLoading (no children, no redirect); `null`/`'name'` → redirect to `/onboarding`; `'done'` → children; on `/onboarding` + non-done → children; `NEXT_PUBLIC_AUTH_BYPASS="1"` → children with zero onboarding evaluation; signed-out states unchanged.
- **Playwright (`frontend/e2e/onboarding.spec.ts`, Tier-2 pattern — `setupClerkTestingToken`, self-skips without `CLERK_SECRET_KEY`; profile API mocked with `page.route("**/api/profile/golfer", …)` over an in-test mutable `mockProfile` so no backend and no fresh Clerk user is needed):**
  1. **New-user end-to-end:** mock GET→`onboardingStep:null`; sign in via shared `signInWithEmailCode` helper; assert URL becomes `/onboarding` and "What should your caddie call you?" visible; Continue disabled on empty and on `"   "`; type name → Continue → assert captured PUT body `{name:"…", onboardingStep:"name"}`; on handicap, click "I'm not sure — I don't have one" → assert PUT `{handicap:null, onboardingStep:"handicap"}`; on bag, assert the 7-iron input value is `"160"` (defaults prefilled) → "Use these" → assert a PUT whose `clubDistances.sevenIron === 160` then a PUT `{onboardingStep:"bag"}`; "Open your book" → assert PUT `{onboardingStep:"done"}`, final URL `/`, "Recent rounds" visible.
  2. **Existing-user zero-onboarding:** mock GET→`onboardingStep:"done"`; sign in; assert Home renders; assert the collected navigation history (via `page.on("framenavigated")`) never contains `/onboarding` and the Name-question locator has count 0.
  3. **Mid-flow kill/resume:** mock state starts `onboardingStep:null`; sign in; complete Name (mock's PUT handler updates its state to `'name'`); `page.reload()` (the kill/relaunch analogue — cold re-hydration through the real gate); assert we land on `/onboarding` showing **"What's your handicap?"** — not the Name step, not Home.
- **/security-review** (per epic §6 this slice is a checkpoint: gate + new backend field) and **/code-review** before ready; **designer** reviews rendered 375px screenshots of all 4 steps against §3.

## 7. Existing-user safety proof plan (reviewer's BLOCKING check — both directions)

1. **Code-level (automated, in this PR):** migration unit test asserts no-DEFAULT + backfill (§6) · integration test ① proves an ensure-created row reads `onboardingStep:null` (new users ARE gated) · integration test ⑤ + Playwright case 2 prove `'done'` users see zero onboarding · AuthGate vitest proves `'unknown'` can never render onboarding.
2. **Migration-review reading (reviewer):** the ADD COLUMN carries no default; the backfill is a one-time UPDATE scoped `WHERE onboarding_step IS NULL`; the ORM column has no Python-side default; neither create path in `profile.py` writes `'done'`.
3. **Post-deploy verification (eng-lead/QA, staging then prod, immediately after `alembic upgrade`):** run read-only SQL — `SELECT count(*) FROM golfer_profiles WHERE onboarding_step IS DISTINCT FROM 'done';` must be **0** at migration time; and the owner's row (`SELECT onboarding_step FROM golfer_profiles WHERE user_id = '<owner clerk id>'`) must read `'done'`.
4. **Device proof for the ship-it bundle:** (a) owner/QA cold-opens the new build on the owner's account → lands directly on Home, zero onboarding frames (screen recording attached to the card); (b) a brand-new `+clerk_test` (or TestFlight sandbox) sign-up on the same build → lands on Name, completes to Home, force-quit-mid-flow resumes correctly. Both directions demonstrated, recorded, attached.

## 8. Explicit OUT OF SCOPE

- The **real voice-first moment** (orb grow-to-center, `openLooper` invocation, suggestions) — **Slice 6**; this slice ships only the placeholder + seam comment.
- **Caddie bag-grounding wiring & the two-account flip-time test** — **Slice 5** (this slice only writes `bag_clubs` via the existing `saveGolferBagAsync`).
- **Any auth-UI change** — `SignInScreen`/`useAuthFlow`/hero animation untouched (Slices 2–3, already landed).
- **Redesigning the `/profile` bag editor** (only the additive `export` of `CLUB_CONFIG` + the one fallback-literal fix).
- Handicap ruler-tick picker / bag-checklist craft upgrades (epic §3.2) — later polish; "replay onboarding" settings toggle; multi-user P1 flows.
