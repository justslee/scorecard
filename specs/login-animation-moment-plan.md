# `login-animation-moment` — Slice 3 Implementation Plan (CONTRACT)

**Epic:** `specs/login-onboarding-redesign-plan.md` (§3.1 the draw concept, §3.3 orb sequencing, §3.4 animation tech + reduced-motion)
**Base:** `integration/next` @ `0db593e` (Slice 2 `login-screen-visual` is DONE — the static hero ships).
**Status:** PLAN — hand to builder. The builder implements this contract; no re-planning.
**Classification:** NOTICEABLE (owner's "full-screen Augusta-vibe animation" ask, reconciled to
the Northstar: one reverent, calm, ink-on-paper draw — never showy, never looping).

## 0. Scope in one sentence

On first cold arrival at the sign-in screen — once per install — the hero signature hole
(HOLES[3], the 548yd hcp-1 par-5 dogleg) draws itself in ink over ~2.4s and settles into the
exact existing static hero; every other visit, and every reduced-motion user, gets the
already-shipped static hero on first paint. Frontend-only; backend zero-delta.

## 1. Approach & the seam — extend `HoleIllustration`, do not fork

`frontend/src/components/yardage/HoleIllustration.tsx`'s own comment declares the hero element
set (rough texture, fairway ribbon, dashed centerline, hazards, green + flag, tee dot, TEE/GRN
labels) "the shared contract Slice 3 will animate — do not fork a second hero component."
Honor it: **one additive opt-in prop on `HoleIllustration`**.

### 1.1 Prop contract

```ts
/** Hero-only, opt-in: play the one-time ink-draw intro. Default undefined —
 *  every existing call site (HoleCard etc.) and the Slice-2 static hero are
 *  unchanged. Ignored unless variant === "hero". */
playIntro?: boolean;
```

Inside the component:
```ts
const drawIntro = isHero && playIntro === true && !reduceMotion; // reduceMotion already in scope
```
`reduceMotion` is re-checked here (defense in depth) even though SignInScreen also gates.

### 1.2 Orchestration structure (the one framer pattern)

- Import `motion` from `framer-motion` (the file already imports `useReducedMotion`).
- ONE shared module-scope `INTRO` timing-constants object (§2 beat table) and ONE shared
  `VARIANTS` object with two states: `"hidden"` and `"drawn"`. Every animated element declares
  `variants={VARIANTS.<name>}`; per-beat `delay`s live in each variant's `transition` (explicit
  storyboard beats, deterministic — this is the variants-object orchestration; a uniform
  `staggerChildren` can't express the differentiated beat table, so only the hazards use an
  index-computed delay `INTRO.hazards.delay + i * INTRO.hazards.stagger`).
- In the **hero variant only**, wrap the paint elements in a single orchestrator:
  `<motion.g initial={drawIntro ? "hidden" : false} animate="drawn">…</motion.g>`.
  `initial={false}` is the load-bearing static path: framer renders the `"drawn"` values
  immediately with zero animation — so `playIntro` off (or reduced motion, or replay-guard)
  renders the hero byte-for-byte at its final state on the first client frame. Variant
  propagation is React-context-based, so it flows through intermediate plain `<g>`s.
- The **interactive variant renders NO motion container and NO new wrappers** — its DOM stays
  byte-identical. Shared paint elements that become `motion.*` primitives (`motion.rect`,
  `motion.path`, `motion.circle`, `motion.text`) are inert without an animating parent and
  render the identical SVG tag + attributes (verified by the new unit test, §5).
  Wrappers that would ADD a DOM node (the tee/flag inner `<motion.g>`s, hazard groups) are
  rendered **only when `isHero`** — pattern:
  `{isHero ? <motion.g variants={…} style={…}>{inner}</motion.g> : inner}` — geometry stays
  single-sourced; only the wrapper is conditional. This is not a fork: one component, one
  element set, one geometry source (`pathD`/`ribbonD`/`hazards`/`HOLES`).

### 1.3 Element-by-element animation map (exact; final values MUST equal today's static attrs)

| Element | Mechanism | hidden → drawn | Final (must match base) |
|---|---|---|---|
| Rough texture rect | `motion.rect`, **opacity fade** | 0 → 0.25 | opacity 0.25 (hero) |
| **Pen stroke (NEW, hero+`drawIntro` only)** — `<motion.path d={pathD}>`, solid, `stroke="#1a2a1a"`, `strokeWidth 0.35`, `strokeLinecap="round"`, NO `strokeDasharray` prop (framer owns dasharray for pathLength) | **framer `pathLength` stroke-draw** 0 → 1, then opacity → 0 (per-value transitions on the `drawn` variant) | pathLength 0→1; opacity 0.45 during draw → 0 at settle | opacity 0 (inert; stays mounted) |
| Dashed centerline (`strokeDasharray="1.5 1.8"` — UNTOUCHED) | `motion.path`, **opacity crossfade** (NOT pathLength — framer animates pathLength via inline `stroke-dasharray`/`dashoffset`, which would clobber the dash pattern; this is the load-bearing gotcha) | 0 → 0.3 | opacity 0.3, dashes intact |
| Fairway ribbon (filled shape — pathLength is a stroke technique, does not apply) | `motion.path`, **opacity fill-in** | 0 → 1 | opacity 1 |
| Hazards (bunker circle / water rect) | hero-only `motion.g` wrapper per hazard, **opacity fade ("stipple")** — no scale (avoids SVG transform-origin risk; element-level opacity like the water rect's 0.7 multiplies inside the group and is preserved) | group 0 → 1 | bunker 1 / water 0.7 |
| Green disc (`green-grad`) | `motion.circle`, **opacity ink-in** | 0 → 1 | opacity 1 |
| Tee dot | outer attribute-translate `<g>` unchanged; hero-only inner `motion.g`, **scale pop** 0 → 1 with `T.spring` (children are centered at local 0,0, so origin = dot center; precedent: the aim-reticle nested-`<g>` transform split in this same file; set framer origin `style={{ originX: "0px", originY: "0px" }}`; fallback if origin misbehaves on device: opacity + y-rise) | scale 0 → 1, opacity 0 → 1 | scale 1 |
| Flag group (pole + accent triangle) | outer translate `<g>` unchanged; hero-only inner `motion.g`, **plant + settle**: `y: 4 → 0` + opacity 0 → 1 with `T.spring` ({stiffness:380, damping:32}) — translate-only, zero origin risk; the flag rises out of the cup and springs settled | y 4 → 0, opacity 0 → 1 | y 0, opacity 1 |
| TEE / GRN labels | `motion.text`, opacity fade | 0 → 1 | opacity 1 |

Nothing else in the SVG animates. No `repeat`, no `Infinity`, no exit animations — a strict
one-shot that settles at exactly the Slice-2 static hero's values. Update the variant-prop
doc comment (the "Slice 3 will animate" paragraph) to describe `playIntro` as that animation.

## 2. Storyboard — the ordered beat list (the `INTRO` constants; seconds from hero mount)

Total motion at rest by **~2.4s** (< 2.5s budget). Ease = `T.ease` `[0.22,1,0.36,1]` unless spring.

| # | Beat | Element | t start | duration | Motion |
|---|---|---|---|---|---|
| 1 | Paper first | rough texture | 0.00 | 0.35 | opacity 0→0.25 — the ground the ink lands on |
| 2 | Page header | top-right mono annotation (SignInScreen) | 0.20 | 0.40 | opacity 0→1, y 6→0 |
| 3 | Round starts at the tee | tee dot | 0.15 | ~0.40 (spring) | scale 0→1, `T.spring` |
| 4 | **The pen draws tee→green** | pen stroke | 0.25 | 1.40 | `pathLength` 0→1, `T.ease` (natural deceleration; inside the 1.2–1.8s window) |
| 5 | Sheet composes in (cosmetic only — tappable from mount, §3.4) | sheet content (SignInScreen) | 0.35 | 0.45 | opacity 0→1, y 8→0 |
| 6 | Fairway fills behind the pen | ribbon | 0.90 | 0.80 | opacity 0→1 |
| 7 | Hazards stipple | each hazard group | 1.50 + i·0.12 | 0.40 | opacity 0→final |
| 8 | Green inks | green disc | 1.60 | 0.40 | opacity 0→1 |
| 9 | Pen lifts, dashes remain | dashed centerline / pen stroke | 1.65 | 0.30 | dashed 0→0.3 while pen opacity →0 (crossfade; final frame = base's dashed line) |
| 10 | The signature | wordmark `Looper.` + kicker (SignInScreen) | 1.70 | 0.50 | opacity 0→1, y 6→0 — the book signs itself after the hole is drawn |
| 11 | Labels annotate | TEE / GRN | 1.90 | 0.25 | opacity 0→1 |
| 12 | **Flag plants last, settles** | flag group | 2.00 | ~0.40 (spring) | y 4→0 + opacity 0→1, `T.spring` — settles ≈2.4s; then everything is still |

All twelve delays/durations live in the single `INTRO` constants object (hero beats in
`HoleIllustration.tsx`; SignInScreen beats 2/5/10 may mirror the three numbers locally with a
comment pinning them to this table).

## 3. "Play once, on cold arrival only" — SignInScreen owns the decision

### 3.1 Decision + burn (the CaddieOrb `INTRO_SEEN_KEY` pattern, split for StrictMode)

In `SignInScreen.tsx`:
```ts
const HERO_DRAW_SEEN_KEY = "looper.loginHeroDrawSeen";
let heroIntroPlayedThisSession = false; // module-scope latch
```
- **Read (render-time, pure — lazy `useState` initializer, runs once per mount):**
  `wantsIntro = !heroIntroPlayedThisSession && readSeen() === false`, where `readSeen()` is a
  try/catch `localStorage.getItem` — **any error → treated as seen → static** (skip-on-error,
  matching CaddieOrb's catch semantics: when we can't read the flag, defaulting to static is
  safest against replay annoyance; on a healthy first-ever install the read returns `null` →
  play). No writes during render.
- **Burn (effect, on mount):** `if (wantsIntro) { heroIntroPlayedThisSession = true; try { localStorage.setItem(HERO_DRAW_SEEN_KEY, "1") } catch {} }`.
  Burn regardless of reduced motion (keeps "once per install" literal — a reduced-motion user
  never gets a surprise animation later). Burn-at-mount (not at completion) is deliberate:
  same tradeoff CaddieOrb made — backgrounding mid-draw forfeits the replay; replay annoyance
  is the worse failure.
- **Why read/write are split (deviation from CaddieOrb's read+write-in-one-effect):** the
  decision must exist at render time to pick framer `initial` states, and Next dev runs React
  StrictMode (double-invoked initializers/effects). Read-in-initializer is pure and safe to
  double-run; write-in-effect is idempotent. Doing the burn inside the initializer would make
  the intro never play in dev (second invocation reads the just-burned flag).
- `const playIntro = wantsIntro && !reduceMotion;` (`useReducedMotion()` already called here).
  Pass `playIntro={playIntro}` to `<HoleIllustration variant="hero" …>` and gate the beat-2/5/10
  entrances (§3.3) on the same boolean.

### 3.2 Replay rules (a)–(d) — and the remount confirmation

- (a) Cold mount at sign-in (fresh install / cleared storage) → plays.
- (b) **Internal step nav never replays — CONFIRMED against the base source:** in
  `SignInScreen.tsx` the hero `<div>` (and `<HoleIllustration>`) is a static sibling; only the
  sheet's step content swaps via `<AnimatePresence mode="wait" initial={false}>`. The hero does
  not remount across method→email→code (or intent/emailMethod toggles), so a mount-time
  decision is naturally correct. Re-focus/app-resume doesn't remount either.
- (c) Once per install via `looper.loginHeroDrawSeen` (burned at first mount, §3.1) — any later
  remount (route bounce, AuthGate re-entry) reads seen → static.
- (d) Reduced motion → `playIntro` false → `initial={false}` → **the complete static hero on
  first paint**. This is the already-shipped Slice-2 surface — VERIFY, do not rebuild
  (Playwright/manual with `page.emulateMedia({ reducedMotion: "reduce" })` or macOS Reduce
  Motion: full hole visible immediately, wordmark/sheet static, zero motion).
- Same-session remount with broken localStorage (private mode write failure): the module latch
  (`heroIntroPlayedThisSession`) still blocks a replay within the session. Across cold opens in
  private mode the draw may replay — accepted (§6).

### 3.3 Wordmark + sheet entrance (SignInScreen-side, beats 2/5/10)

Wrap three existing static blocks in `motion.div` with
`initial={playIntro ? { opacity: 0, y: <6|8|6> } : false}`, `animate={{ opacity: 1, y: 0 }}`,
transitions per the beat table (`T.ease`): the top-right annotation (beat 2), the sheet's inner
content column (beat 5 — wrap INSIDE the sheet div, around the `AnimatePresence`; do not touch
the AnimatePresence or its `initial={false}`), and the wordmark+kicker block (beat 10).
When `playIntro` is false these render statically on first frame (`initial={false}`), exactly
today's behavior. The kicker keeps the literal source text `Your yardage book` (e2e contract).

## 4. Performance contract (acceptance conditions, reviewer-enforced)

- **Animated properties: `opacity`, `transform` (translate/scale on `<g>`s), and framer
  `pathLength` (implemented as inline stroke-dasharray/dashoffset on ONE path) — nothing else.**
  No animated `filter`/`box-shadow`/`backdrop-filter`, no layout/width/height/x/y attribute
  animation, no layout thrash (no reads-after-writes; the existing `heroSize` resize effect is
  untouched and fires only on real resizes). No React re-renders during the intro — all motion
  runs on framer MotionValues (the 500ms cooldown ticker only runs on the `code` step).
- 60fps on iPhone-12-class at 375px (~12 animated SVG nodes — verify via the designer capture
  and a spot-check with Safari Web Inspector timeline on simulator/device if available).
- **Animation never gates interactivity:** the hero container already has
  `pointerEvents: "none"` (unchanged); the sheet's buttons are mounted, enabled, and clickable
  from the first frame — the beat-5 entrance is opacity/translate only, starts at 0.35s, and
  never sets `pointerEvents` or `disabled`. Buttons tappable well under 1s by construction.
- **No looping/repeating at rest:** no `repeat` config anywhere; every variant reaches `drawn`
  and stops; the settled DOM is visually identical to `playIntro={false}`. One-shot: `animate`
  stays `"drawn"` forever; framer tears itself down on unmount (AuthGate swap after sign-in).

## 5. Files to touch + shared-types check

| File | Change |
|---|---|
| `frontend/src/components/yardage/HoleIllustration.tsx` | `playIntro` prop; `INTRO` + `VARIANTS` constants; hero-only `motion.g` orchestrator; motion conversions + hero-only wrappers per §1.3; the NEW pen-stroke path; update the variant doc comment. Interactive path untouched. |
| `frontend/src/components/auth/SignInScreen.tsx` | `HERO_DRAW_SEEN_KEY` + session latch + read/burn split (§3.1); pass `playIntro`; three `motion.div` entrances (§3.3). |
| `frontend/src/components/yardage/HoleIllustration.test.tsx` (NEW) | jsdom + mocked framer (passthrough factory covering `motion.g/path/rect/circle/text/svg-as-needed` rendering the correct SVG tags, stripping `variants/initial/animate/transition`). Assert: interactive default renders the reticle set and the centerline keeps `strokeDasharray="1.5 1.8"` with NO added wrapper `<g>`s vs a pinned element-count snapshot; `variant="hero"` without `playIntro` renders the full final element set and NO pen stroke unless `playIntro`; hero+`playIntro` includes the pen stroke. |
| `frontend/src/components/auth/SignInScreen.test.tsx` | Extend the existing framer-motion mock the same way (it currently only provides `motion.div`, and this file's module mock also serves the real `HoleIllustration` import — without `motion.path` etc. the suite crashes). `localStorage.clear()` in `beforeEach`; new tests: first mount writes `looper.loginHeroDrawSeen`; a mount with the flag pre-set (or with a throwing storage stub) still renders the full screen. Use `vi.resetModules()` + dynamic import where the module latch needs resetting. |
| `frontend/e2e/auth.spec.ts` | **No edits expected** — buttons are enabled from mount and the kicker appears ≤2.2s (timeouts are 15s). Run it as a gate; only touch it if a real flake is demonstrated. |

**Shared-types check: this slice is SVG/animation only — `frontend/src/lib/types.ts` and
`backend/app/models.py` are NOT touched; no shared shape changes. `git diff integration/next -- backend/`
must be empty.** Explicitly untouched: `useAuthFlow.ts`, `OAuthButtons.tsx`, `AuthGate.tsx`,
`SignInClient.tsx`/`SignUpClient.tsx` (the `dynamic(ssr:false)` + PaperShell wrapper stays
exactly as is), `HoleCard.tsx`, `tokens.ts`, all auth-spike guards.

## 6. Edge cases & risks

1. **framer `pathLength` clobbers dash patterns** (it drives inline `stroke-dasharray`): the
   dashed centerline therefore NEVER uses pathLength — the solid pen-stroke overlay draws
   (pathLength = the stroke-draw mechanism), then crossfades into the real dashed line (beat 9).
   pathLength = stroke-draw (pen only); opacity = fills/fades (ribbon, rough, hazards, green,
   centerline, labels); transform = pops/plants (tee scale, flag y). The ribbon is a filled
   shape → opacity fill, never pathLength.
2. **SSR/hydration:** `SignInScreen` mounts via `dynamic(ssr:false)` — there is no server HTML
   for it; the prerendered first paint is the existing `PaperShell` placeholder, so a variants
   hydration mismatch is structurally impossible. The draw starts when the component mounts
   post-hydration. Do NOT move it out of `dynamic(ssr:false)`. All storage access stays inside
   try/catch anyway (jsdom/defensive).
3. **localStorage unavailable (private mode / storage errors):** read error → static
   (skip-on-error, §3.1 — first-ever healthy install still plays because the read succeeds with
   `null`). Write failure → session latch prevents same-session replay; a replay on the NEXT
   cold private-mode open is accepted (ephemeral context, matches CaddieOrb's posture).
4. **React StrictMode (dev) double-invocation** would eat the intro if read+burn shared one
   code path — resolved by the §3.1 read-in-initializer / burn-in-effect split.
5. **Interactive byte-identity after motion conversion:** inert `motion.*` primitives render
   identical tags/attrs; DOM-adding wrappers are hero-conditional; pinned by the new
   `HoleIllustration.test.tsx` assertions. `HoleCard`'s drag/aim/wobble machinery untouched.
6. **SVG transform-origin (tee scale pop):** nested-`<g>` split per the file's own aim-reticle
   precedent + `originX/originY: "0px"`; documented fallback = opacity + y-rise (flag already
   uses translate-only for exactly this reason).
7. **Signed-in deep-link to `/sign-in`:** the existing bounce effect fires; the intro may burn
   on that mount — harmless (that user is past first-run) and it prevents a later replay.
8. **Hero final values drift:** every `drawn` value is pinned in §1.3 to today's static
   attributes; the designer final-frame comparison (§7 gate 7) catches any drift.

## 7. Gates (all must pass; this machine has NO local Postgres — no DB-backed local runs, none needed)

1. `cd frontend && npm run lint`
2. `cd frontend && npx tsc --noEmit`
3. `cd frontend && npm run build`
4. `cd frontend && npx tsx voice-tests/runner.ts --smoke`
5. `cd frontend && npx vitest run` (new HoleIllustration test + updated SignInScreen tests + all existing green)
6. `cd frontend && npx playwright test e2e/auth.spec.ts` — still green, unmodified (Tier 1 with pk; Tier 2 when `CLERK_SECRET_KEY` present)
7. **Designer keyframe capture (BLOCKING):** fresh browser context (empty storage) at 375×812 →
   sign-in screen → screenshots at ~0.2s / 0.9s / 1.7s / 2.6s after mount (≈0/30/60/100% of the
   sequence — beats 1–3 / mid-draw / green+signature / settled), PLUS a reduced-motion
   (`emulateMedia`) first-paint shot, PLUS settled-frame vs pre-slice static hero comparison
   (must match). Judge against the §2 storyboard + Northstar (calm, reverent, ink-on-paper).
8. **Reviewer perf-safety review (BLOCKING):** §4 contract — animated-property whitelist, no
   loops at rest, interactivity never gated, one-shot settle, interactive byte-identity.
9. `cd backend && ruff check .` — **no backend change expected; this passes trivially and
   `git diff integration/next -- backend/` must be empty.**

## 8. Out of scope

Onboarding (Slices 4–6), the orb (stays entirely off the cold-open hero per epic §3.3), OAuth
enablement, any richer hand-inked art upgrade (drops into this same variants structure later),
sound, and any replay affordance ("watch again") — none of it here.
