# Plan: Sign out from Profile + centralized sign-out residue teardown
## Closes backlog `multiuser-p0-signout-namespace-clear` (P0 hardening — app is now LIVE with APP_ACCESS_MODE=open, so this is overdue residue isolation)

Owner-visible change: a quiet, yardage-book "Sign out" on the Profile page (`/settings`,
which has the only existing SignOutButton, is unreachable in nav). Security change: a
genuinely centralized sign-out invariant that tears down ALL per-user device state so
nothing resolves to the prior account for the next user on the same device.

All paths below are under `frontend/` unless noted. Line numbers verified 2026-07-19 on
`integration/next`.

---

## 1. The centralized invariant — shape and ordering

### Decision: REACTIVE effect owns the teardown; the button only calls Clerk signOut

Two candidate shapes were weighed:

- (a) an explicit `signOutEverywhere()` helper the button awaits — explicit, but covers
  ONLY the button. Server-side revocation (the Svix webhook + revoked_users store from
  multiuser-p0-migrations-revocation), token expiry, and any future sign-out path would
  leave residue. Worse, it has a correctness hazard: `signOut({redirectUrl:'/'})`
  triggers a navigation, so code after the `await` races the document teardown.
- (b) extend the existing reactive `isSignedIn` true→false transition effect in
  `src/components/ClerkTokenBridge.tsx:39-51` (which already does the Keychain clear)
  to run the FULL teardown. This catches EVERY sign-out cause: the button, server
  revocation, session expiry, headless `clerk.signOut()` (auth-spike panel).

**Choose (b).** Supporting evidence already in the codebase:
`src/components/auth/useAuthFlow.ts:23` — "No `signOut()` calls — the sign-out
invariant stays centralized" — the reactive seam is already the declared architecture.

There is also a decisive TOCTOU reason the clear MUST run after Clerk clears its
session: `src/lib/identity-core.ts:33-41` — `getCurrentUserId()` *opportunistically
re-writes* `scorecard_last_user_id` whenever `window.Clerk.user.id` is still set. A
helper that clears the pointer before/while Clerk tears down would have the pointer
resurrected by the very next synchronous pref read. The reactive effect fires only
after `useAuth()` reports the signed-out state (Clerk client state already cleared),
so the clear cannot be resurrected.

### Implementation

**New module `src/lib/sign-out-teardown.ts`** exporting one function:

```
runSignOutTeardown(): Promise<void>
```

Extracted into its own module (not inline in ClerkTokenBridge) so it is unit-testable
in vitest without React, and so the ordering is documented in ONE place. It composes,
in this exact order:

1. **Stop the live caddie** — `stopActiveRealtimeClient()` (NEW export, see §1.1) then
   `warmSession.teardown()` (`src/lib/voice/warm-session.ts:171` — already idempotent,
   no-ops when dormant/consumed). First because it releases the mic/WebRTC (a live
   hot-mic surviving sign-out is the worst residue) and both are synchronous +
   idempotent — safe even though React unmount cleanups usually got there first (§2,
   row 6).
2. **Clear the namespace pointer** — `clearLastUserId()` (NEW, see §1.2): remove
   `scorecard_last_user_id`. After this, `getCurrentUserId()`
   (`src/lib/identity-core.ts:30-51`) returns `null` synchronously → every
   `storageKey()` read (`src/lib/storage-keys.ts:37-41`) resolves to the `anon`
   namespace → defaults, never the prior user's values. This closes the backlog TOCTOU.
3. **Reset in-memory identity module state** — `resetOnboardingOnSignOut()` (NEW, see
   §1.2): reset `onboardingSnapshot` (`src/lib/identity.ts:90-94`) to
   `{userId:null, step:'unknown', profile:null}` AND `hydratedForUserId = null`
   (`src/lib/identity.ts:101`). These MUST be reset together: resetting the snapshot
   but not `hydratedForUserId` would strand a same-user re-sign-in (no document reload
   is guaranteed) at `onboardingStep === 'unknown'` forever → permanent PaperLoading at
   `src/components/AuthGate.tsx:171-173`. The `profile:null` also drops the departing
   user's in-memory `GolferProfile` (name/handicap prefill residue,
   `getHydratedGolferProfile()` `src/lib/identity.ts:147-149`).
4. **Native only** — `if (Capacitor.isNativePlatform()) await clearNativeToken()`
   (`src/lib/native-token-store.ts:80-86` — Keychain remove + plaintext Preferences
   belt-and-suspenders). Preserve the existing diag behavior verbatim:
   `.then(setAuthDiag({tokenRestored:false}))` / `.catch(setAuthDiag({lastError}))`
   from `ClerkTokenBridge.tsx:43-48`. Steps 1–3 run on ALL platforms (web no-op-safe);
   only the Keychain step is native-gated.

**Wire-up:** the transition effect body in `src/components/ClerkTokenBridge.tsx:40-51`
becomes a single `void runSignOutTeardown()` call (keep the `wasSignedIn` ref transition
guard at :39-42 EXACTLY as-is — it is what protects cold-start session restoration).
Every step inside the teardown must be individually try/caught so one failure (e.g.
Keychain error) never skips the pointer clear.

### Races considered

- **Clearing the pointer can't strand the NEXT sign-in:** the effect fires on the
  signed-in→signed-out transition only. The next sign-in re-writes the pointer via
  `useMe()`'s effect (`src/lib/identity.ts:249-257`, mounted app-wide by
  `IdentityBridge`, `src/components/AuthProvider.tsx:201`) and opportunistically via
  `identity-core.ts:36`. Between sign-out and next sign-in, reads resolve to the
  `anon` namespace — internally consistent by design (`storage-keys.ts:27`), and
  `migrateLegacyKeysIfNeeded` explicitly no-ops with no uid (`storage-keys.ts:95`).
- **Effect timing window:** the teardown runs in a post-commit effect, i.e. a few ms
  AFTER AuthGate has already swapped children for `SignInClient`
  (`AuthGate.tsx:161-163`). In that window nothing that reads namespaced prefs is
  mounted (SignInClient reads only the un-namespaced `looper.loginHeroDrawSeen`), so
  the window is not exploitable.
- **Double-teardown idempotency:** every step is idempotent — `stop()` is
  terminal-guarded (`realtime.ts:743-750`, singleton nulled at :758),
  `warmSession.teardown()` no-ops when dormant (`warm-session.ts:171-184`),
  `removeItem` on absent keys is a no-op, snapshot reset is assignment,
  `clearNativeToken` removes absent keys without error. StrictMode double-invoke and
  a future second sign-out path are both safe.

### 1.1 New export in `src/lib/voice/realtime.ts`

`activeRealtimeClient` (`realtime.ts:286`) is module-private. Add beside it:

```ts
export function stopActiveRealtimeClient(): void {
  activeRealtimeClient?.stop();
}
```

`stop()` (`realtime.ts:743`) already nulls the singleton via `cleanup()`
(`realtime.ts:758`), closes the data channel/peer connection, stops mic tracks
(`realtime.ts:761`), and removes the audio sink element. No other change to this file.

### 1.2 New exports in `src/lib/identity-core.ts` / `src/lib/identity.ts`

- `identity-core.ts`: `export function clearLastUserId(): void` — `try/catch`
  `window.localStorage.removeItem("scorecard_last_user_id")`. Lives here (not
  identity.ts) to stay framework-free/vitest-runnable per the file's design intent
  (`identity-core.ts:5-15`); re-export from `identity.ts` like `getCurrentUserId`.
- `identity.ts`: `export function resetOnboardingOnSignOut(): void` — resets
  `onboardingSnapshot` + `hydratedForUserId` per §1 step 3 and calls
  `notifyOnboardingListeners()`.

---

## 2. Exact clear-list the invariant guarantees

| # | Residue | Where cleared | Why leak-safe |
|---|---------|---------------|---------------|
| 1 | Clerk session | Clerk itself, via `signOut({redirectUrl:'/'})` in the shared button (pattern: `settings/page.tsx:194`) | Clerk owns its own storage; the invariant TRIGGERS off its completion (the `isSignedIn` transition), never races it. |
| 2 | iOS Keychain JWT (+ legacy plaintext Preferences entry) | Teardown step 4 → `clearNativeToken()` (`native-token-store.ts:80-86`) | Unchanged behavior, now part of the composed invariant. Web: skipped (store is native-only; nothing persisted to clear). |
| 3 | `scorecard_last_user_id` | Teardown step 2 (`clearLastUserId()`) | THE TOCTOU fix. With the pointer gone, `getCurrentUserId()` returns null (`identity-core.ts:46-50`) and every synchronous pref read (persona/favorites/map-view via `storage-keys.ts`/`storage.ts`) resolves to `anon` defaults — the prior user's namespace is unreachable by name for the next account. Cleared AFTER Clerk clears `window.Clerk.user` (reactive trigger) so `identity-core.ts:36` cannot resurrect it. |
| 4 | `scorecard_migrated_v1` | **Deliberately NOT cleared** | It is device-global bookkeeping ("legacy un-namespaced keys have been moved"), value `"1"`, content-free — it identifies no user and gates no read to any user's namespace. Clearing it would only re-arm the legacy migration (`storage-keys.ts:90-111`), which is pointless (legacy keys were removed at migration) and adds a needless write path on a fresh account's first reads. |
| 5 | Departing user's `scorecard_<uid>_*` namespace data | **Deliberately NOT cleared** — see §3 | Unreachable once the pointer is gone; keeping it preserves the returning user's offline cache per the documented multi-user design (`storage-keys.ts:113-121`). |
| 6 | `onboarding_step` cache (`scorecard_<uid>_onboarding_step`) | Not cleared on disk (it's inside #5); in-memory snapshot reset in step 3 | Per-user keyed via `storageKey()` (`identity.ts:51,65`), so a fresh sign-up's read misses it — see §4 for the full no-skip argument. |
| 7 | `activeRealtimeClient` (live mic/WebRTC + per-user caddie context) | Teardown step 1 (`stopActiveRealtimeClient()`) | Primary path is actually React unmount: AuthGate swaps ALL layout children — including `CaddieOrbSheet` (`app/layout.tsx:68`) — for SignInClient, and `useCaddieLiveSession`'s cleanup stops its client (`useCaddieLiveSession.ts:902-913`). The singleton stop is the React-ownership-INDEPENDENT guarantee (revocation while a client is mid-mint, or any future surface that forgets its cleanup). |
| 8 | `warmSession` (billed warm WebRTC, per-user persona/round intent) | Teardown step 1 (`warmSession.teardown()`) | Same belt-and-suspenders: `/round/new`'s unmount cleanup calls teardown (`app/round/new/page.tsx:195`) but the invariant guarantees it for every path. Idempotent (`warm-session.ts:168-184`). |
| 9 | Orb sheet open-state | React unmount (no code needed) | `open` is component-local state (`CaddieOrbSheet.tsx:48`); the sheet is a child of AuthProvider (`layout.tsx:64-70`) so AuthGate's `!isSignedIn` branch (`AuthGate.tsx:161-163`) unmounts it — a sheet open mid-sign-out closes structurally, and rows 7/8 kill any session it held. State this in a code comment; do NOT add a bus event. |
| 10 | In-memory `GolferProfile` + onboarding snapshot + hydrate guard | Teardown step 3 (`resetOnboardingOnSignOut()`) | Belt over the existing per-user gates (`identity.ts:275`, re-anchor at `identity.ts:170-172`); also makes same-user re-sign-in re-hydrate correctly (the `hydratedForUserId` trap, §1 step 3). |

Not touched, with reasons: `golfapi_*` course cache (device-global, non-personal by
design, `storage-keys.ts:6-10`); `looper.loginHeroDrawSeen` (per-install hero intro,
§7); orb intro-seen key (same class).

---

## 3. Resolved tension: clear the departing user's namespace, or only the pointer?

**Decision: pointer-only (plus in-memory resets). Do NOT wipe `scorecard_<uid>_*` on
sign-out.**

Adversarial argument that pointer-only is sufficient for the stated requirement ("no
residue RESOLVES to the prior user for the NEXT account"):

- Every namespaced read/write goes through `storageKey()` (`storage-keys.ts:37-41`),
  whose only inputs are the live Clerk id and the pointer. Next account signed in →
  their own uid → their own namespace. Next account not yet signed in → `anon` →
  defaults. There is no third path: no code reads `scorecard_*` keys by enumeration
  (verified: consumers all derive via `storageKey()`; the only enumeration-adjacent
  code is `clearCurrentUserStorage()` itself, which also derives via `storageKey()`).
- The residual data is only recoverable by someone with DevTools/filesystem access to
  the webview's localStorage — an attacker with that access reads the data whether or
  not we wipe it at sign-out (they could have read it before sign-out; localStorage is
  not encrypted at rest either way). Wiping on sign-out does not change that threat
  model; the Keychain JWT (the actual credential) IS wiped.
- Wiping WOULD destroy the legitimate returning user's offline cache — explicitly
  protected by the documented design decision at `storage-keys.ts:113-121` and by the
  Settings copy already shipped ("will be here when you return",
  `settings/page.tsx:738-740`). Destroying it silently changes shipped behavior and
  hurts the primary user (the owner, switching between accounts to test).
- The backlog item itself scopes the fix as "clear scorecard_last_user_id (and
  OPTIONALLY the current namespace)" — the optional half buys no isolation (above) and
  costs offline-cache UX. Users who want the wipe have the explicit Settings "Clear
  local cache" button (`settings/page.tsx:285-335`).

If the owner later wants device-forensic hygiene, that is a separate, explicit
"sign out and clear this device" affordance — flag to PM, out of scope here.

---

## 4. Onboarding-skip assessment (stale `onboarding_step` cache)

**No clearing needed for correctness; the in-memory reset (§1 step 3) is added as a
belt.** Trace for a fresh sign-up on a device where user A was `done`:

1. AuthGate gates on `useMe().onboardingStep` (`AuthGate.tsx:165-177`).
2. `useMe()` returns the snapshot's step ONLY when `onboarding.userId === userId`
   (`identity.ts:275`) — new user B ≠ stale snapshot userId → `'unknown'` → PaperLoading,
   never children.
3. Hydration for B re-anchors with `readCachedOnboardingStep()` — which reads
   `storageKey('onboarding_step')` = `scorecard_<B>_onboarding_step` (`identity.ts:65`)
   → miss → `'unknown'`; then the server GET resolves and a fresh row's
   `onboarding_step` is null → funneled into onboarding (`identity.ts:174-188`,
   `AuthGate.tsx:174-176`).

A stale cache can therefore never make a fresh sign-up skip onboarding: the persisted
cache is per-user-keyed and the in-memory snapshot is user-id-gated. The one residue
that step 3 of the teardown removes is the in-memory `profile` object and the
`hydratedForUserId` guard (§1 step 3 explains why the pair must reset together).
Fail-open caveat to preserve: `hydrateGolferProfile`'s catch path falls back to
`'done'` when nothing is cached (`identity.ts:189-194`) — that is offline-first by
design and only reachable for a user whose GET failed; do not "fix" it here.

---

## 5. The Profile "Sign out" button

**Extract, don't duplicate.** New shared component
`src/components/auth/SignOutButton.tsx` (the existing auth component directory —
SignInScreen/OAuthButtons/useAuthFlow live there):

- MOVE `SignOutIcon` (`settings/page.tsx:37-55`), `ConfirmRow` (`:114-176`), and
  `SignOutButton` (`:184-278`) into the new file, exporting `SignOutButton` (default)
  and `ConfirmRow` (named — Settings' `ClearCacheButton` at `:298-303` consumes it;
  keep one copy). Behavior byte-equivalent: neutral initial pill, two-step IN-PAGE
  confirm (not a modal), red only on the confirm action, `signing`/`signOutError`
  states, `await signOut({ redirectUrl: '/' })` with the existing catch
  (`settings/page.tsx:197-202`). No call to the teardown here — the reactive invariant
  owns it (§1); add a comment saying exactly that, citing `useAuthFlow.ts:23`.
- Add a self-guard: render `null` when `!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
  (the reason for Settings' page-level guard at `settings/page.tsx:612-616`:
  `useClerk()` throws outside ClerkProvider on keyless dev builds). Structure so the
  hook is inside a child the guard doesn't render (hooks rules).
- Update `settings/page.tsx` to import both from the new module; delete the local
  copies. The page-level `isClerkConfigured &&` wrap at `:723` may stay (harmless,
  keeps the whole Section from rendering empty).

**Profile placement** (`src/app/profile/page.tsx`): render an "Account" section
immediately above `<Footer />` (call site `:334`, after `<ShotAnalytics />` `:333`),
using the page's own `Section` shell (`profile/page.tsx:344`) so it matches the
existing kicker/serif-title rhythm. Kicker `"Account"`, title `"Your account"`, body
copy identical to `settings/page.tsx:728-740` ("Sign out of your Looper account on
this device. Your rounds and profile are saved on the server and will be here when
you return." — copy stays TRUE under the §3 decision), then `<SignOutButton />`.
Imports: only the new component (page already has `useRouter`; it needs no Clerk
import — the guard lives in the component). The outer scroll already reserves tab-bar
padding (`:297`), and Footer's `borderTop` (`:2645`) gives the section a natural
bottom rule. **The designer owns final placement/copy** — this section is quiet,
end-of-book, matching the yardage-book "colophon" position; flag any deviation.

---

## 6. Shared-types check

Pure frontend. Nothing touches `frontend/src/lib/types.ts` or
`backend/app/models.py`; zero backend files change. No API surface, no new
dependencies. (State kept in: localStorage, Keychain, module singletons — all client.)

---

## 7. Edge cases / risks

- **Web vs native:** Keychain step gated on `Capacitor.isNativePlatform()` inside the
  teardown; steps 1–3 are platform-neutral. Web e2e therefore exercises the pointer
  clear directly.
- **signOut error:** shared button keeps the existing catch → "Couldn't sign out — try
  again." (`settings/page.tsx:197-202`). If signOut fails, `isSignedIn` never flips,
  teardown never runs — correct (still signed in, nothing should clear).
- **Teardown partial failure:** each step individually try/caught (§1) — a Keychain
  error must never skip the pointer clear, and vice versa. Keychain failures surface
  via `setAuthDiag` exactly as today.
- **Draw animation will NOT replay** on sign-out→sign-in: `looper.loginHeroDrawSeen`
  is per-install by design (`src/components/auth/SignInScreen.tsx:30-44`, plus the
  module latch at `:31`). Intended — it is a cold-arrival hero intro, not a
  per-session flourish. Do not clear it; note it in the PR description so the owner
  isn't surprised (§9).
- **Orb sheet open during sign-out:** closes structurally by unmount (§2 row 9); live
  session killed by rows 7/8. No visual glitch expected — AuthGate swaps the whole
  tree in one commit.
- **Same-user immediate re-sign-in (owner testing):** covered by the
  `hydratedForUserId` reset (§1 step 3); their namespace data (kept, §3) reappears,
  onboarding re-hydrates to `done` from the server.
- **Cold-start stale-token clear (2nd clerk-jwt-keychain-swap LOW followup):**
  **LEAVE FILED.** It is NOT this seam: the transition guard at
  `ClerkTokenBridge.tsx:39-42` exists precisely because cold-start restoration injects
  the stored JWT before Clerk reports `isSignedIn`; clearing on `isLoaded && !isSignedIn`
  without a transition cannot distinguish "definitively signed out" from "restore still
  in flight / transient network failure" and would sign users out on a blip. It needs
  its own small design (e.g. clear only after a FAPI response definitively rejects the
  token). Folding it in here risks the exact regression the guard prevents. The
  sign-out TOCTOU followup, by contrast, IS this item — closed by §1/§2 row 3.
- **backlog.json bookkeeping:** close `multiuser-p0-signout-namespace-clear`
  (status → done + resolution note per repo convention) and amend the epic's
  `p0_status_note` (item (b) done; item (e) now "cold-start stale-token clear only").
  Use TARGETED edits — never json.load/dump (backlog has duplicate keys).

---

## 8. Tests (new/updated)

1. **`src/lib/sign-out-teardown.test.ts`** (NEW; `// @vitest-environment jsdom` +
   Map-backed `vi.stubGlobal('localStorage', …)` + `setClerkUser()` helper — copy the
   harness pattern from `src/lib/storage-keys.test.ts:1-45`). Mock
   `@/lib/voice/realtime`, `@/lib/voice/warm-session`, `@/lib/native-token-store`,
   `@capacitor/core` via `vi.mock`. Cases:
   - **THE TOCTOU regression test (backlog acceptance):** seed
     `scorecard_last_user_id = 'user_a'` and
     `scorecard_user_a_caddie_persona = 'saltbox'`, `window.Clerk` undefined (post-
     sign-out state); `await runSignOutTeardown()`; assert **synchronously**:
     `getCurrentUserId() === null`,
     `storageKey('caddie_persona') === 'scorecard_anon_caddie_persona'`, and
     `localStorage.getItem(storageKey('caddie_persona')) === null` — the default,
     never `'saltbox'`.
   - Departing user's data survives: `scorecard_user_a_caddie_persona` still present
     under its own key; `scorecard_migrated_v1` untouched.
   - Ordering/composition: realtime stop + warm teardown called; keychain clear called
     ONLY when the mocked `Capacitor.isNativePlatform()` returns true.
   - Idempotency: second call does not throw, state unchanged.
   - Fault isolation: keychain mock rejects → pointer still cleared, no throw.
   - In-memory reset: `getHydratedGolferProfile() === null` after teardown.
2. **`e2e/auth.spec.ts`** (Tier 2, `CLERK_SECRET_KEY`-gated like the existing suite):
   extend the signed-in journey — navigate to `/profile`, tap "Sign out", tap
   "Yes, sign out", expect the sign-in screen; then
   `page.evaluate(() => localStorage.getItem('scorecard_last_user_id'))` → null.
   This is what's drivable on web preview. Full sign-out→fresh-sign-UP→onboarding is
   NOT CI-drivable (no fresh-user minting; `e2e/onboarding.spec.ts:1-16` deliberately
   mocks the profile API and reuses the one test user) — the fresh-account onboarding
   path is the owner's manual test (§9), and the onboarding funnel itself is already
   covered by `onboarding.spec.ts`.
3. Existing suites must stay green untouched — especially
   `storage-keys.test.ts` and the caddie hook tests (no behavior change to
   `stop()`/`teardown()` semantics, only a new export).

---

## 9. Gates (all must pass before done)

From `frontend/`:
1. `npm run lint`
2. `npx tsc --noEmit`
3. `npm run test` (vitest — includes the new §8.1 file)
4. `npm run build`
5. `npx tsx voice-tests/runner.ts --smoke`
6. `npm run test:e2e` locally with Clerk test keys if available (Tier 2 skips
   gracefully without `CLERK_SECRET_KEY`, per `e2e/auth.spec.ts` header).

Backend: `ruff check .` — N/A, zero backend files touched (state this in the PR).

Process gates (CLAUDE.md): this is an auth/user-facing change → run
`/security-review` and `/code-review` on the diff; designer review of the Profile
section against NORTHSTAR (quiet, end-of-book placement; designer owns final
placement/copy per §5).

### Owner's manual TestFlight path (he runs this himself)
1. Open the app signed in as the existing account → Profile tab → scroll to the
   bottom → "Sign out" → "Yes, sign out".
2. Land on the sign-in screen. NOTE: the hole-draw animation will NOT replay — it is
   a per-install intro, correct behavior (§7).
3. Sign UP with a fresh email → onboarding plays in full (name → handicap → bag →
   meet-caddie) → lands Home.
4. Verify isolation: no rounds, empty profile, default caddie persona/favorites —
   nothing from the first account. Sign out, sign back into the ORIGINAL account →
   its data is all still there (server + kept device cache, §3).

---

## 10. Ordered build checklist

1. `src/lib/voice/realtime.ts` — add `stopActiveRealtimeClient()` export beside the
   singleton (`:286`). No other change.
2. `src/lib/identity-core.ts` — add `clearLastUserId()`.
   `src/lib/identity.ts` — add `resetOnboardingOnSignOut()` (snapshot +
   `hydratedForUserId` together, notify listeners); re-export `clearLastUserId`.
3. `src/lib/sign-out-teardown.ts` (NEW) — `runSignOutTeardown()` composing §1 steps
   1→4, each step try/caught, keychain native-gated, diag behavior preserved.
4. `src/components/ClerkTokenBridge.tsx` — replace the `:43-48` body with
   `void runSignOutTeardown()`; keep the `:39-42` transition guard verbatim; update
   the comment to name this the centralized sign-out invariant.
5. `src/components/auth/SignOutButton.tsx` (NEW) — move `SignOutIcon`/`ConfirmRow`/
   `SignOutButton` from `settings/page.tsx:37-278`; add the publishable-key
   self-guard; export `ConfirmRow`.
6. `src/app/settings/page.tsx` — import from the new module; delete moved locals.
7. `src/app/profile/page.tsx` — add the "Account" `Section` + `<SignOutButton />`
   between `:333` and `<Footer />` `:334` with the §5 copy.
8. `src/lib/sign-out-teardown.test.ts` (NEW) — §8.1 cases, TOCTOU test first.
9. `e2e/auth.spec.ts` — add the Tier-2 sign-out journey (§8.2).
10. Run gates §9 (lint, tsc, vitest, build, voice smoke; e2e if keys). Fix until green.
11. Update `backlog.json`: close `multiuser-p0-signout-namespace-clear` with a
    resolution note; amend `multiuser-epic.p0_status_note` (§7 last bullet). Note the
    cold-start stale-token followup stays FILED (§7).
12. `/security-review` + `/code-review` + designer review; fold in findings. PR note:
    draw animation intentionally does not replay; namespace kept by design (§3).
