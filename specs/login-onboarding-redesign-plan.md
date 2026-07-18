# Login + First-Time Onboarding Redesign — Epic Plan

**Owner directive (verbatim, 2026-07-18):** "I truly hate the way our login screen looks.
Looks ancient, doesn't give us the flavor or a nice visual of our app whatsoever. This is
the first screen people see and there should be some nice onboarding flow for first time
sign up and users. Nice full screen animations that give off an Augusta vibe, onboarding
flow, and a modern, clean, exciting UI for logging in. If we have to build our own SECURE,
Authentication, and login system that allows google login, etc. then that is the route we
should go."

**Status:** PLAN (plan-first pass, 2026-07-18). Build starts in subsequent cycles from the
backlog items appended below. Synthesized by eng-lead from three parallel planning agents:
product-manager (experience spec), designer (visual concept), and a Fable architecture plan.
Reviewer ran a security-lens sanity pass on the auth recommendation (see §7).

**Classification:** NOTICEABLE — the first screen every user sees; ships behind the owner's
approval when the epic (or a noticeable slice of it) lands.

---

## 1. Headline decisions (the three questions the owner's directive poses)

1. **Auth provider — KEEP CLERK, go HEADLESS (custom flow). Do NOT build homegrown auth.**
   The owner will replace the auth system "if we have to" — we do not have to. The thing he
   hates is *one component*: Clerk's prebuilt `<SignIn>` widget in `SignInClient.tsx`.
   Clerk's headless custom-flow API gives us **byte-for-byte total UI freedom** (every pixel,
   animation, transition is ours) while keeping the entire shipped security posture. Homegrown
   buys ZERO additional design freedom for an enormous, perpetual security surface. See §2.
2. **The look — reconcile "Augusta vibe / full-screen animation / exciting" with the Northstar
   (calm, on-paper, yardage-book, never SaaS-flashy).** They are not opposites. "Augusta vibe"
   = the *feeling* (pristine, verdant, reverent, serif elegance) — **NOT** Masters/Augusta
   National trademarks, imagery, the green jacket, or Amen Corner. "Exciting" for a calm app =
   a slow, reverent, cinematic moment. The concept: **a signature hole that draws itself in ink**
   (reusing our existing `HoleIllustration.tsx` + `HOLES[]` data), zero new asset pipeline, zero
   licensing exposure. See §3.
3. **Onboarding — a resumable, mostly-skippable first-run flow whose highest-value step wires
   the player's bag directly into the caddie's grounding** (the caddie is the product). This is
   also the App Store front door for the multi-user launch. See §4.

---

## 2. Auth architecture — Clerk headless (custom flow)

### 2.1 What exists and is load-bearing (DO NOT rebuild)
- `backend/app/services/clerk_auth.py` — JWKS-verified Clerk JWT, azp fail-closed hardening,
  `require_member` + `APP_ACCESS_MODE` gate, revocation check. Provider-facing surface is
  exactly one thing: a verifiable RS256 session JWT in `Authorization: Bearer`.
- `backend/app/routes/webhooks.py` — Svix-signed Clerk webhook → revocation store
  (`user.deleted`/`user.banned`/`session.revoked`), constant-time compare, replay protection.
- `frontend/src/components/AuthProvider.tsx` — the hard-won headless native-token bridge:
  `window.__internal_onBeforeRequest`/`__internal_onAfterResponse` FAPI hooks, `credentials:
  "omit"`, `_is_native=1`, JWT echoed in the `authorization` response header, `x-mobile:1`.
- `frontend/src/lib/native-token-store.ts` — iOS Keychain persistence
  (`whenUnlockedThisDeviceOnly`, no iCloud sync).
- `frontend/src/components/ClerkTokenBridge.tsx` + `frontend/src/lib/identity.ts`
  (`IdentityBridge`/`useMe`) — token singleton + `scorecard_last_user_id` + golfer-profile ensure.
- `frontend/src/components/AuthGate.tsx` — client gate: `!isLoaded`→PaperLoading, auth routes
  pass through, `!isSignedIn`→`<SignInClient/>` inline.

**Critical insight:** the FAPI hooks are *provider-level* (registered on `window`, consumed by
clerk-js's FAPI client at request time). A custom UI calling `useSignIn`/`signIn.create(...)`
goes through the exact same clerk-js FAPI client, so **the native-token / Keychain path is
unchanged by construction.** The prior v1.0.365 white-screen bug existed *only because* the
prebuilt `<SignIn>` demands UI-components-loaded clerk-js — a headless custom UI removes that
entire failure class.

### 2.2 Headless coverage — verified per method (Fable, from Clerk docs + web)
| Requirement | Headless support | Verdict |
|---|---|---|
| Email + password / email code | `useSignIn`→`signIn.create`/`prepareFirstFactor`/`attemptFirstFactor`→`setActive`; sign-up mirror via `useSignUp`. 100% our UI. | Yes, unconditional |
| Google OAuth — web | `signIn.authenticateWithRedirect({strategy:'oauth_google',...})` + an `/sso-callback` route calling `handleRedirectCallback`. | Yes |
| Google OAuth — Capacitor iOS native | In-WebView redirect is blocked by Google (`disallowed_useragent`) **for the prebuilt widget too** — headless *fixes* it: native plugin (e.g. `@capgo/capacitor-social-login`) → Google ID token → `clerk.authenticateWithGoogleOneTap({token})` (the same pattern `@clerk/clerk-expo` ships, built on clerk-js). Fallback: system browser (`@capacitor/browser`/SFSafariViewController) + redirect + deep-link + transfer. | Yes — spike de-risks |
| Sign in with Apple — native iOS | Clerk `oauth_token_apple` ID-token strategy (`SignInWithApple` capacitor plugin → identity token → clerk-js). May need a `@clerk/clerk-js` bump (native Apple for Expo landed Nov 2025). | Yes — exact API pinned in the spike |
| Backend gets a verifiable session JWT | Session JWT is a property of the Clerk *session*, not the UI. `clerk_auth.py` untouched. | Yes — zero backend change |

**No headless constraint blocks any required method.** Nothing here justifies homegrown.

### 2.3 Tradeoff: Clerk headless vs homegrown
| Dimension | Clerk headless | Homegrown |
|---|---|---|
| Design freedom | Total (custom flows are pure API calls) | Total — **identical; homegrown buys ZERO extra** |
| Engineering cost | 1 spike + 1–2 UI slices | Password service, OAuth server flows, session issue/refresh/rotate, verification rewrite, revocation rebuild, account linking, email delivery — months |
| Security surface owned | Credentials → Clerk FAPI over HTTPS; Clerk owns hashing, breach/stuffing detection, rate limiting, PKCE, refresh rotation, revocation, SOC 2 | **We own ALL of it** — enormous perpetual liability for a ~1-person org, for zero design gain |
| Shipped slices preserved | clerk_auth, webhooks, require_member, revocation, native-token/Keychain, azp hardening — **all unchanged** | All thrown away/rewritten |
| Time to first usable | Days (spike), one cycle (screen) | No usable login until the whole IdP core exists |
| App Store compliance | Apple sign-in via Clerk's supported native flow | We implement Apple server-side validation ourselves |

**RECOMMENDATION: Clerk headless, without reservation.** (This supersedes the PM spec's
conservative "re-skin the prebuilt widget via the appearance prop" default — the PM explicitly
deferred the auth-UI depth to this architecture pass. Re-skinning the widget would leave the
owner fighting Clerk's DOM for the "modern, clean, exciting" surface he asked for; headless
gives full control at no security cost.)

### 2.4 HARD REQUIREMENT the owner didn't mention — Sign in with Apple
**App Store Review Guideline 4.8:** an app offering third-party/social login (Google) **must**
offer Sign in with Apple. This is a launch blocker, treated as P0 inside the spike and the login
screen. Button follows Apple HIG badge rules.

### 2.5 Ops precondition (owner/ops, not app code)
Enable **Google + Apple social connections** on the production Clerk instance (Dashboard →
Configure → SSO connections) and **Native Applications** (already referenced by the native-token
bridge). Tracked as `auth-clerk-enable-social-connections` (blocked-on-owner). Email stays as
the third option.

---

## 3. Visual concept (designer — the BLOCKING input, reconciled with the Northstar)

**Trademark boundary (explicit, non-negotiable):** "Augusta vibe" = pristine/verdant/reverent/
hushed/serif-elegant/cathedral-of-golf gravitas as a *feeling*. Nothing touches Masters or
Augusta National branding, colors-as-trademark, the green jacket, the logo, or Amen Corner
imagery. Every visual is our own ink-on-paper hole geometry, our own `T.*` palette, our own
Instrument Serif type. **Zero licensing exposure.**

### 3.1 The animation moment — RECOMMENDED: a signature hole draws itself in ink
Reuse `frontend/src/components/yardage/HoleIllustration.tsx` + the real `HOLES[]` data (pick the
dramatic 548yd hcp-1 par-5 dogleg). On first launch: tee dot pops (`T.spring`), the fairway
centerline path draws itself via `stroke-dashoffset` (framer-motion `pathLength`/`pathOffset` —
a near-zero-new-code extension of the existing `strokeDasharray` render), the fairway ribbon
fills in behind it, hazards pop one by one, the flag plants with a tiny flutter (~3.5–4.5s,
unhurried, plays **once per install** via a localStorage flag like `INTRO_SEEN_KEY`). Then the
sign-in sheet rises over its lower third.
- **Why this beats the alternatives** (slow dolly over painterly course; desaturated satellite
  render): it is the only concept that is simultaneously (1) genuinely cinematic in the reverent
  sense the owner wants, (2) **zero new design language** — literally the existing component with
  one animated attribute, (3) buildable with **no new dependency / no asset pipeline** (framer-
  motion@12 already installed; ships as a few KB of inline SVG, critical for cold first-launch
  load), and (4) dramatizes the product's actual premise (a hole you can trust, drawn by hand)
  rather than a generic golf splash.
- A richer hand-inked signature-hole illustration is a **later art upgrade** that drops into the
  same animated-path structure — nice-to-have, not a v1 blocker.

### 3.2 Screen-by-screen look
- **Hero / sign-in:** full-bleed. The hole illustration IS the top ~62%, on paper + `PAPER_NOISE`,
  no card chrome. `Looper.` in Instrument Serif italic ~52px bottom-left + mono `YOUR YARDAGE BOOK`.
  Bottom third = a hairline-bordered paper sheet (echoing `VoiceSheet`), NOT the raw Clerk widget:
  one primary ink-filled "Continue with Apple" pill (matching the 64px VoiceSheet mic button
  language), a hairline "Continue with email" pill, a mono "or" divider. Pill radius 999px (the
  app's existing orb/mic radius), never the 4px SaaS-card radius.
- **Onboarding steps go quiet by contrast** (generous whitespace after the loud hero): oversize
  serif-italic question lines (like `VoiceSheet`'s empty state), underline-only inputs (written
  "on the line," not boxed Material fields), a scorecard-row hairline-tick progress indicator
  (not a numbered SaaS stepper).
- **Handicap step:** a hairline-tick ruler picker (like a yardage-book page edge) with the number
  large in serif above — the one place to spend a little extra craft; cobalt `T.accent` only on the
  selected tick. Explicit "Don't know yet? Skip, we'll learn as you play."
- **Bag step:** a short checklist (ink checkbox-dots like the tee-dot glyph), not a 12-tap form;
  staggered fade-in. Framed "So your caddie knows your game." `OrbChip` first appears here:
  "You can just tell me instead."
- **Voice-first "ask your caddie" moment (the hinge):** form chrome clears, the orb grows to
  center (54→~96px, `T.spring`), serif prompt "Try asking me something," mono `VoiceSheet`-style
  suggestions. User holds the orb (the real production gesture) → real `Waveform` +
  `ConversationTurn`/`Medallion` — the first caddie reply is **pixel-identical to production**, not
  a mocked preview. A quiet "Skip — I'll talk to my caddie later" always present (voice-first, tap
  fallback true even in onboarding).
- **Land-on-home:** no "You're all set!" checkmark screen. The orb animates from center to its
  permanent bottom-right resting position while Home fades up underneath — reuse `CaddieOrb.tsx`'s
  real `INTRO_SEEN_KEY` "Your caddie moved here" chip; onboarding hands off into the live app's
  own first-run state machine.

### 3.3 Orb introduction sequencing
Not on the cold-open hero (don't compete with the draw animation). First appears small + idle
(no pulse — a breathing idle glow reads as a SaaS "AI thinking" indicator the Northstar rules out,
per `CaddieOrb.tsx`'s own comment) at the Name step, in its exact production position, so spatial
memory forms early. Interactive at the bag step's caption chip. Whole-screen at the voice moment.
Resolves permanently into production position on the Home handoff.

### 3.4 Animation tech + reduced-motion
- **Framer Motion (already installed) is the primary vehicle** — `transform`/`opacity` only
  (GPU-composited), staged reveals via `variants` + `staggerChildren`. **No Lottie** (new runtime
  dep, main-thread jank, violates "no new deps without real need"). **No video needed** for the
  recommended SVG concept; if a future art direction wants a filmic layer, budget ≤2.5MB, short
  loop, poster ≤150KB.
- **Guardrails (bake into slice acceptance):** ≤2.5MB total animation assets, poster ≤150KB;
  60fps on iPhone-12-class; only transform/opacity animate (no animated filter/box-shadow/layout,
  no backdrop-filter over video); first paint = static poster/complete hole; motion begins after
  hydration and never blocks the sign-in buttons becoming interactive (<1s); animation unmounts
  (not just hides) when the flow advances (battery).
- **`prefers-reduced-motion`:** the fully-drawn hole renders complete + static on first paint
  (this is just `HoleIllustration`'s normal steady state — already tested), sign-in sheet fades in
  ≤150ms, the orb appears at rest size/position with no grow beat, chips fade. A still, composed,
  complete yardage-book page — arguably *closer* to the literal Northstar than the animated version,
  never a downgrade. `HoleIllustration.tsx`/`CaddieOrb.tsx` already gate on `useReducedMotion()`.

---

## 4. Experience / flow (PM — grounded in the actual data model)

### 4.1 Data model — ONE additive column (extends `golfer_profiles`, no new store)
New Alembic revision `016_golfer_profile_onboarding` (`down_revision = "015_course_intel"`):
```
onboarding_step TEXT NULL   -- NULL | 'name' | 'handicap' | 'bag' | 'done'  (last COMPLETED step)
```
Semantics collapse "resume" and "returning user" into one lookup and remove the ambiguity a
boolean can't (e.g. `handicap=null` means both "never asked" and "asked, user said not sure";
empty bag means "never asked" vs "explicitly skipped"). Mirror the field in:
`backend/app/db/models.py` (ORM column), `backend/app/models.py`
(`GolferProfile`/`Create`/`Update` → `onboardingStep: Optional[str]`), `frontend/src/lib/types.ts`
(`GolferProfile.onboardingStep: string | null`), and the `_orm_to_pydantic` mapping +
partial-update upsert in `backend/app/routes/profile.py` (the PUT already writes only present
fields — `onboardingStep` is just one more optional field it already handles).
- **Backfill for pre-existing users:** the migration sets `onboarding_step='done'` for any
  profile row that predates the feature — never onboard the owner (or any current user) again.
  (Note: this reconciles the two agents' proposals — PM's step-enum for resumability is the
  primary; Fable's simpler `onboarding_completed` boolean is subsumed by the `'done'` value. If
  resumability is descoped for v1, `'done'` vs not-`'done'` degrades cleanly to a boolean.)

### 4.2 Flow — NEW user
1. **Welcome hero** (signed-out; `WelcomeHero`, mounted from `AuthGate`'s `!isSignedIn` branch,
   replacing the bare `<SignInClient/>` fallback) — the §3 draw-animation + wordmark + one calm
   tagline + "Begin". Always instantly skippable (tap anywhere), never a forced unskippable video.
2. **Sign in** (`SignInClient` restyled to the headless custom UI) — Apple / Google / email.
3. **Onboarding wizard** (`frontend/src/app/onboarding/page.tsx`, single route, internal step state
   initialized from the server's `onboardingStep` so resume is one profile fetch, not a route chain).
   Each step writes its result to the server **before** advancing (app-kill never loses a prior step):
   - **(a) Name — required.** "What should your caddie call you?" Blocks Continue on empty/whitespace.
     `PUT {name, onboardingStep:'name'}`.
   - **(b) Handicap — optional.** Number input + an equal-weight "I'm not sure / I don't have one"
     (explicit path, not a faint skip link). Either advances; the *write* is what's optional.
     `PUT {handicap:<n|null>, onboardingStep:'handicap'}`.
   - **(c) Bag — optional, defaults pre-filled — THE HIGH-VALUE STEP.** Reuse the exact 14-club
     `CLUB_CONFIG` list/keys from `frontend/src/app/profile/page.tsx` (do not invent a second list);
     pre-fill every field from `DEFAULT_CLUB_DISTANCES` (`backend/app/caddie/club_selection.py`,
     short-key→camelCase). "Use these" accepts defaults; "Skip — set up later" leaves `clubDistances`
     `{}` (already a safe empty-bag state — the caddie falls back to `DEFAULT_CLUB_DISTANCES`).
     `saveGolferBagAsync(clubDistances)` then `PUT {onboardingStep:'bag'}`. Later-editable at the
     existing `/profile` bag editor (unchanged).
   - **(d) Meet your caddie — optional voice teaching moment.** Must summon the **existing** orb via
     `openLooper({context:"general", listening:true, presentation:"full"})` from `looper-bus.ts` —
     NO bespoke mic button (the one standardized invocation, per product rule). "Continue" always
     enabled (never a dead end if voice fails). `PUT {onboardingStep:'done'}`.
4. **Home** (`/`, unchanged) — the single convergence point for all users.

### 4.3 Returning user & resume — one branch
On `isSignedIn`→true, fetch `GET /api/profile/golfer`. `onboardingStep==='done'` → straight to
`/`, **zero onboarding screens render** (not even a flash — gate on a tri-state so "unknown" shows
PaperLoading, never onboarding). Anything else (`null`/`'name'`/`'handicap'`/`'bag'`/204) →
`/onboarding`, self-resuming at the right sub-step. Because every step writes the server, force-quit
mid-flow relaunches at exactly the right step — no local-only progress flag that can desync.

### 4.4 Edge cases (resolutions locked)
Account already onboarded on another device → server-side `'done'` → straight to Home. OAuth popup
cancel → Clerk's native cancel state, no orphaned `golfer_profiles` row (the row is created by the
wizard's first PUT, not by sign-in). Offline first launch → `WelcomeHero` is a static local asset,
renders fine; sign-in needs network → reuse the existing `navigator.onLine` pattern for a calm "no
connection" state. Skipped bag → `{}`, caddie uses defaults, fixable later at `/profile`. Pre-feature
user with `onboarding_step` NULL → backfilled to `'done'` by the migration (§4.1), so not re-onboarded.

### 4.5 Acceptance criteria (QA-verifiable, the load-bearing ones)
- Signed-out open → hero → sign-in showing Apple + Google + email (once Dashboard connections on).
- Brand-new sign-up lands on `/onboarding` at Name, never skips to Home.
- "I'm not sure" on handicap writes `handicap:null` and advances (verify via GET).
- Bag step's 14 fields pre-filled with mapped `DEFAULT_CLUB_DISTANCES` before any edit.
- **FLIP-TIME TEST (owner asked for it by name):** two accounts complete bag setup with different
  7-iron carries (e.g. 150 vs 170), both ask the caddie for a ~160y club → the two accounts' caddie
  **club-selection payloads differ** and each is consistent with that account's stored `clubDistances`
  (verify the tool-call payload, not just the spoken answer).
- Skipped bag → caddie club-reco still succeeds via `DEFAULT_CLUB_DISTANCES`, no crash.
- Force-quit after Name → relaunch resumes at Handicap, doesn't re-ask name, doesn't reset to hero.
- Second device on a `'done'` account → straight to Home, zero onboarding screens.
- Voice step opens the same `CaddieOrbSheet` via `openLooper` (no second mic UI anywhere).
- Full flow completable <60s accepting all defaults; every optional step has a working skip/default.
- `tsc --noEmit`, `npm run lint`, `voice-tests --smoke` all green.

---

## 5. Frontend structure (static-export safe)
- Keep routes `/sign-in`, `/sign-up` (already in `AUTH_PREFIXES`); replace their internals.
- New family `frontend/src/components/auth/`: `SignInScreen.tsx` (the new visual login),
  `useAuthFlow.ts` (headless state machine over `useSignIn`/`useSignUp`: idle→method→email/code/
  password→verifying→done|error; UI stays dumb), `OAuthButtons.tsx` (platform-branched: native
  ID-token plugin path vs web `authenticateWithRedirect`). `frontend/src/app/sso-callback/page.tsx`
  (web OAuth landing, client-only).
- **Static-export constraint (same as today):** no `ClerkProvider` at prerender → every Clerk-hook
  component loads via `dynamic(() => import(...), {ssr:false})` (the proven `SignInClient.tsx`/
  `NativeAuthDiag` pattern). Headless is *easier* here — hooks-only code has no `mountSignIn`/
  `assertComponentsReady` hazard, so the v1.0.365 white-screen class disappears. Static shell
  (paper, masthead, poster) prerenders for instant first paint; the interactive flow hydrates in.
- Onboarding under `frontend/src/app/onboarding/page.tsx` + `frontend/src/components/onboarding/`.
- Gate: add a fourth `AuthGate` state — `isSignedIn && onboardingStep!=='done' && !isOnboardingRoute`
  → render onboarding. Hydrate onboarding state through `IdentityBridge`/`useMe` (`MeState` gains the
  tri-state), cache last-known in namespaced localStorage so offline open doesn't re-gate.
- **Native-token compatibility CONFIRMED:** custom UI → same clerk-js FAPI client → same `window`
  hooks → same Keychain persistence. No change. Spike asserts `authdiag` shows `native-sent:true` +
  token persisted + cold-start restore after a custom-flow sign-in. Sign-out must call
  `clearNativeToken()` (audit every `signOut()` site).

---

## 6. Security plan
- **Backend delta if headless: ZERO.** `clerk_auth.py`, `webhooks.py`, `require_member`/
  `APP_ACCESS_MODE`, azp pinning — byte-identical. The only backend change in the epic is the
  additive `onboarding_step` column (not an auth change, but it touches `golfer_profiles`, so it
  rides review). This zero-delta is the decisive argument for headless.
- **New surface = the custom UI now handles raw credentials.** Mitigations, baked into slice specs:
  never log/telemeter credentials (no password/code in `console.*`, `auth-diag.ts` [paths only —
  keep it], error reporters, URL params — lint-greppable check); credentials go ONLY to Clerk FAPI
  over HTTPS via clerk-js, never our backend/any third party; enumeration hygiene (map Clerk error
  codes to uniform copy, don't leak account existence); rate-limiting/stuffing/bot protection stay
  Clerk's (surface `too_many_requests` gracefully, no client retry loops); OAuth nonce/state handled
  inside clerk-js/native ID-token strategies (do not hand-roll — spike uses only supported
  strategies); native-token Keychain posture unchanged, sign-out clears it; keep the
  `assert-no-auth-bypass.mjs` prebuild guard + `NEXT_PUBLIC_AUTH_BYPASS` semantics identical; any
  Capacitor social-login plugin is a new native auth dependency → supply-chain + `/security-review`.
- **`/security-review` checkpoints:** Slice 1 (spike — new flows + plugin), Slice 2 (credential UI),
  Slice 4 (onboarding gate + new backend field), Slice 7 (epic-wide). Slice 5 rides the Slice-7 pass
  (touches caddie payloads).

---

## 7. Reviewer security-lens sanity pass on the auth recommendation
_(Filled in from the reviewer dispatch this cycle — see the progress note / backlog for the verdict.)_

---

## 8. Implementation slices (backlog items, dependency-ordered; #1 ready-to-pick)
| # | id | Scope | Size | Gates |
|---|---|---|---|---|
| 0 | `auth-clerk-enable-social-connections` | OPS/owner: enable Google + Apple SSO connections + Native Applications on the prod Clerk instance | XS (owner action) | n/a (Dashboard) |
| 1 | `auth-headless-spike` | **READY.** Prove ALL headless flows on a branch: email+password/code sign-in+sign-up; Google web (redirect + `/sso-callback`); Google native (ID-token exchange, fallback documented); Apple native (ID-token, bump `@clerk/clerk-js` if needed); backend JWT verification unchanged; native-token Keychain fires (`native-sent:true`, persisted, cold-start restore). Ugly UI on purpose. Output = written GO/NO-GO with exact API calls. | M–L | tsc, lint, build, native-crash test, on-device matrix, /security-review |
| 2 | `login-screen-visual` | Full new sign-in/sign-up screens (final layout/type/method buttons/email states/error copy), static — no hero animation; delete prebuilt `<SignIn>`/`<SignUp>`; keep `NativeAuthDiag`; update `e2e/auth.spec.ts` for the custom flow | M | lint, tsc, build, Playwright, designer, /security-review |
| 3 | `login-animation-moment` | The self-drawing signature-hole hero (framer-motion `pathLength` over `HoleIllustration`), reduced-motion still-frame, asset/60fps guardrails per §3.4 | M | lint, tsc, build, on-device fps, designer |
| 4 | `onboarding-shell-and-gate` | `onboarding_step` column (new Alembic rev + backfill `'done'` for existing rows), `models.py`+`types.ts` lockstep, `MeState` extension, `AuthGate` fourth state, onboarding route with name/handicap/bag steps (reuse profile editors), completion via existing profile PUT | M–L | lint, tsc, build, ruff, backend tests, Playwright new-user path, /security-review |
| 5 | `onboarding-bag-caddie-grounding` | Wire onboarding bag → `golfer_profiles` → `buildClubMap()` → caddie payload; the two-user flip-time acceptance test (§4.5) | S–M | lint, tsc, voice-tests, caddie tests, flip e2e |
| 6 | `onboarding-voice-first-intro` | The voice-first "ask your caddie" moment via the existing orb (`openLooper`), tap fallback; Northstar "design the voice path first" applied to onboarding | M | voice-tests, lint, tsc, designer |
| 7 | `login-onboarding-epic-polish-review` | Transition polish, remove dead widget code/appearance config, edge sweep (offline, expired code, OAuth cancel), full Playwright auth+onboarding e2e, epic-wide /security-review + /code-review, TestFlight validation bundle for the owner | M | ALL gates + /security-review |

**Dependencies:** 0 (ops, parallel) · 1 → 2 → 3 · 1 → 4 → {5,6} · 7 last. Slices 2+3 (visual) can
run parallel to 4 (onboarding) after the spike lands. **The spike is first on purpose:** it converts
the epic's only real unknown (native OAuth token exchange in a Capacitor WebView) into confidence or
a precise named constraint before any pixel is polished.

**Consistency rule:** `frontend/src/lib/types.ts` `GolferProfile` and `backend/app/models.py`
`GolferProfile`/`Create`/`Update` change in the SAME commit (add `onboardingStep`), with the ORM
mapping in `profile.py` and the DB column in a new (unguarded) Alembic revision.

**Top risks:** (1) Google native ID-token audience config (iOS vs web client ID Clerk expects) —
spike item, fallback = system-browser redirect + transfer; (2) `@clerk/clerk-js`/`@clerk/react`
version-bump ripple (check `frontend/patches/` for existing Clerk patch-package patches before
bumping); (3) Northstar "calm" vs owner "exciting" — designer reconciles (§3 resolves it), escalate
per Northstar if ever irreconcilable.

## 9. Out of scope (v1)
Homegrown auth; redesigning the existing `/profile` bag editor; changing the caddie's empty-bag
fallback; multi-user P1 phone/email "connect with a friend" flows; a "replay onboarding" settings
toggle. All deferred/unchanged.
