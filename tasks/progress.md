# Progress log

The team writes here so work survives context resets and usage-limit pauses.
Format: date — done / in-progress / blocked.

## 2026-06-27 (wire-profile-stats P16)
- **Done:** backlog `wire-profile-stats` (P16, NOTICEABLE) — replaced last fabricated mock
  data on the profile screen with real computed stats (where possible) and honest empty
  states (where data genuinely doesn't exist yet). Commit `1e1bf7f` on `integration/next`.

  What changed in `frontend/src/app/profile/page.tsx`:
  - **ScoringByTee (now real):** Removed `PP_SCORING` constant. New `deriveScoringByTee()`
    computes per-tee averages from the owner's completed rounds using `calculateTotals()` +
    `players[0].id` (same owner-identification pattern as home/page.tsx). Grouped by
    `round.teeName`, shows: tee name, yards (summed from HoleInfo.yards when available),
    par, round count, average strokes, and average over-par bar chart. Sorted longest
    tee first. Empty state: "Play a round to see your scoring by tee." No (Preview) label.
  - **YearLog / Season log (now real):** Replaced fake heatmap (`buildYear` seed function +
    PP_* data) with `deriveRoundLog()` — real completed rounds sorted most-recent first.
    Each row: date (month + day) | course name + optional tee name | total strokes + to-par
    string ("E"/"+N"/"-N"). Section renamed "Season log". Empty state: "Post a round to
    track your season."
  - **StrokesGained (honest empty):** Removed `PP_SG` + framer-motion animated bars. Calm
    placeholder: "Strokes gained needs shot tracking — coming soon." No (Preview) label.
    Removed `motion` import (only used in that section).
  - **FairwayFan (honest empty):** Removed `PP_FWY` + fake SVG fan diagram + fake Drive
    dist/Dispersion numbers. Calm placeholder: "Fairway tracking needs shot data — coming
    soon." No (Preview) label.
  - Owner-identification: `players[0].id` (single-owner beta), same as home/page.tsx.
    `calculateTotals()` from `lib/types.ts` reused — no new shared helper needed.
  - Data fetch: `getRoundsAsync()` added to profile page's `Promise.all` alongside
    `getGolferProfileAsync()` — one concurrent request, same pattern as home.

  Gates: lint 0 · tsc 0 errors · voice-tests 260/260 · build 15 pages OK.
  NOTICEABLE — user-visible change on TestFlight: fabricated tee-averages, SG bars,
  and fairway fan replaced with either real data (ScoringByTee, YearLog) or honest
  "coming soon" placeholders (SG, Fairway).

## 2026-06-27 (frontend-lint-cleanup P32)
- **Done:** backlog `frontend-lint-cleanup` (P32, SILENT) — `npm run lint` now passes with
  0 errors and 0 warnings. Commit `c867c06` on `integration/next`.

  Root cause: ~2,874 of the errors were false positives from the Capacitor iOS web bundle
  (`ios/App/App/public/_next/static/`). Eliminated by adding `"ios/**"` to ESLint
  `globalIgnores` in `eslint.config.mjs`.

  Real fixes in `src/` and `voice-tests/`:
  - **react-hooks/set-state-in-effect + react-hooks/refs:** Replaced two `useEffect`-based
    prop-sync patterns in `PlayerAutocomplete.tsx` and `ScoreSheet.tsx` with the React
    "store previous prop" pattern (`useState`-based conditional during render).
  - **react-hooks/immutability (used-before-declared):** `parseSimpleScore` extracted to
    module level in `ScoreGrid.tsx` (it's pure); `submitScore` (useCallback) and
    `parseVoiceLocally` reordered to appear before `processVoiceScores` in the component.
  - **react-hooks/exhaustive-deps:** Wrapped `effectivePin` in `useMemo` in `CaddiePanel.tsx`
    so its object reference is stable across renders (was creating a new object on every render).
  - **Unused imports/vars:** Removed `AnimatePresence`, `Users`, `ChevronRight`, `Player`,
    `stripFillerWords`, `extractCapitalizedNames` across 6 files. Used `_`-prefix pattern for
    intentionally unused params; added `argsIgnorePattern: "^_"` to ESLint config.
  - **`no-explicit-any`:** Replaced all `any` types in voice-tests and voice lib files with
    `unknown`, explicit casts, or typed interfaces.
  - **SpeechRecognition typing:** Added `SpeechRecognitionErrorEvent` to `src/types/speech.d.ts`
    (updated `onerror` type there); used typed window cast pattern across ScoreGrid, VoiceGameSetup,
    VoiceTournamentSetup. Restored `useEffect` to PlayerAutocomplete import (was incorrectly removed).
  - **react/no-unescaped-entities:** Changed raw quotes to `&ldquo;/&rdquo;` in JSX text.
  - **catch (e) {} → catch {}:** In haptics.ts, VoiceGameSetup, VoiceTournamentSetup.
  - **eslint-disable comment:** Added `// eslint-disable-next-line @next/next/no-img-element`
    on the avatar `<img>` in `players/page.tsx` (user-provided URL, next/image requires known domains).

  Gates: lint 0 problems · tsc 0 errors · voice-tests 260/260 · npm test 238/238.
  SILENT — no user-visible change on TestFlight.

## 2026-06-27 (mount-ocr-scan P27 — polish pass)
- **Done:** 13-item reviewer/designer polish pass for `mount-ocr-scan` (commit `cba0e25`
  on `integration/next`).

  DESIGN MUST-FIX:
  1. Removed "Claude Vision" brand mention — scanning overlay subtitle → "This may take a moment".
  2. "Scan card" entry button: minHeight 28→40px, added inline camera SVG icon.
  3. Score cell height: 34→40px.
  4. Amber cell flag: added T.warningWash background + full T.warningInk border (dropped `99` alpha).
  5. Camera guide frame: T.hairline → T.pencil+"cc" (~80% opacity) — visible over live video feed.

  CORRECTNESS SHOULD-FIX:
  6. CameraCapture: useEffect cleanup — stop MediaStream tracks on unmount (camera indicator clears).

  CORRECTNESS NITS:
  7. handleCellChange: clamp to 1–15; values outside → null so they can't silently survive to Apply.
  8. handleApply: partial failure detection — if any Promise.allSettled rejects, stay open + show
     "N of M saved — M didn't reach the server. Tap Apply to retry." banner in review phase.
  9. Duplicate mapping guard: hasDuplicate disables Apply; OcrPlayerCard shows "Already assigned"
     amber badge + amber border when two OCR rows map to the same round player.

  DESIGN NICE-TO-HAVE:
  10. Confidence kicker: semantic label at 10px ("Looks good…" vs "Hard to read…") not raw %.
  11. Hole-number header: 8→9px.
  12. Scrollable body bottom padding: 4→16px.
  13. Backdrop: now dismisses during error phase too (was review-only).

  Gates: eslint on 3 modified files — 0 errors · tsc --noEmit — 0 errors · voice-tests — 260/260.

## 2026-06-27 (mount-ocr-scan P27)
- **Done:** backlog `mount-ocr-scan` (P27, NOTICEABLE) — re-mounted the OCR scorecard-scan
  flow with a real entry point and yardage-book aesthetic.

  Key changes:
  - **New `frontend/src/components/ScanSheet.tsx`** (~340 LOC):
    - Full scan-to-score flow: capture → OCR → editable review → apply.
    - Phase `capture`: renders restyled `CameraCapture` full-screen overlay (camera or
      photo-library).
    - Phase `scanning`: full-screen "Reading the card…" overlay while `parseScorecard()`
      calls `POST /api/voice/parse-scorecard` (Claude Vision, server-side).
    - Phase `review`: bottom sheet (mirrors CaddieSheet pattern). Shows per-OCR-player
      editable score grid: two rows of 9 (front 9 + back 9), compact 28px mono inputs,
      hole-number column headers. Confidence kicker in header; amber low-confidence warning
      + amber cell borders when confidence < 60%. Player-name mapping via a `<select>`
      dropdown per OCR player (pre-populated with case-insensitive match, or "Skip" for
      unmatched names — unmatched players flagged with "No match" badge and amber border).
      At least one player must be assigned before "Apply scores" enables.
    - Phase `applying`: fires `onSetScore(pid, holeIdx, val)` in parallel via
      `Promise.allSettled` for all valid (1–15) non-null scores on mapped players;
      `N of M scores` progress counter shown. Uses the same `handleSetScore` code path as
      manual hole entry (optimistic UI + pending overlay + per-hole API upsert).
    - Phase `error`: error card + "Try again" button that returns to capture.
    - State reset: parent passes a fresh React `key` on each open (idiomatic unmount+remount)
      — no `useEffect` setState pattern (avoids `react-hooks/set-state-in-effect` lint rule).
    - Design: T.* tokens only, PAPER_NOISE, Instrument Serif, inline SVGs (CloseIcon),
      44pt close button, safe-area-aware bottom padding, 28pt score cells with numeric
      keyboard. No lucide-react, no new npm deps.
  - **Restyled `frontend/src/components/CameraCapture.tsx`** (full rewrite):
    - Removed: `lucide-react` import (`Camera`, `Upload`, `X`), all Tailwind class names
      (`bg-zinc-950`, `text-zinc-400`, `text-zinc-300`, `text-red-200`, `border-red-400/20`,
      `backdrop-blur-xl`, `bg-zinc-950/70`, `border-white/10`, `btn`, `btn-primary`,
      `btn-secondary`, `btn-icon`, `card`, `app-header`, `header-divider`).
    - Added: inline SVGs (CameraIcon, UploadIcon, CloseIcon), inline styles with T.*
      tokens throughout. PAPER_NOISE + T.paper full-screen background,
      `max(14px, env(safe-area-inset-top))` header, `max(14px, calc(env(safe-area-inset-bottom)+8px))`
      bottom bar. T.serif italic "Capture the card" title, T.paperDeep card well,
      dashed `T.hairline` guide border in camera mode. T.errorWash/T.errorInk error banner.
      All buttons minHeight 44px. Paper background on bottom bar (replaces dark backdrop).
  - **`RoundPageClient.tsx` changes:**
    - Imports `ScanSheet`.
    - `const [scanOpen, setScanOpen] = useState(false)` added.
    - `pointerEvents` guard extended: `|| scanOpen`.
    - Scorecard section label refactored from `<SectionLabel>Scorecard</SectionLabel>` to
      inline row with "Scorecard" kicker + hairline rule + quiet "Scan card" text button on
      the right (T.mono 9px, T.pencil colour, minHeight 28px). Entry point does NOT add a
      third pill to the bottom action row.
    - `<ScanSheet key={scanOpen?"scan-open":"scan-closed"} ...>` mounted after the caddie
      sheet with `round`, `onSetScore={handleSetScore}`, `accent`.

  Auth note: `voice_advanced.router` is registered with `dependencies=_owner_only` in
  `backend/app/main.py` (line 61). `fetchAPI` (called by `parseScorecard`) attaches the
  Clerk Bearer token automatically — no additional auth wiring needed in the frontend.

  Name matching: OCR names matched to round players by exact case-insensitive comparison.
  Unmatched names shown with "No match" badge + amber card border; user assigns via
  dropdown or selects "Skip". Unmatched players are NEVER auto-created.

  Persistence path: `handleSetScore` (the same callback as in-round manual entry) —
  `POST /api/rounds/{id}/scores` per-hole upsert via `addScore`. No new endpoint.

  Gates: eslint src/components/{CameraCapture,ScanSheet}.tsx + RoundPageClient: 0 errors ·
  tsc --noEmit 0 errors · voice-tests 260/260 · npm test 238/238 · npm run build 15 pages OK.

  NOTICEABLE — new user-visible capability on TestFlight: "Scan card" link appears in the
  Scorecard section header on the in-round screen; tapping opens the camera/library picker
  and OCR-parses the card into an editable review sheet before applying to the round.

  Designer flags for on-device review:
  1. Score input cells (28px × 34px): verify the numeric keyboard focuses correctly on iOS
     and that tapping a cell selects it cleanly. Consider increasing to 32px wide if cells
     feel too small on-device.
  2. "Scan card" text button in the Scorecard section header: currently T.pencil mono 9px;
     verify readability and consider a small camera SVG icon for discoverability.
  3. Player name dropdown (`<select>`): iOS renders a native picker wheel. Verify the T.mono
     10px style reads clearly and that "Skip" is the correct default label for unmatched names.
  4. Low-confidence amber border on score cells: subtle amber underline (T.warningInk 60%
     opacity bottom border). Verify it reads in sunlight without feeling alarming.
  5. Bottom sheet max-height 88dvh: on small phones (SE), verify the score grid + Apply
     button are accessible without excessive scrolling when 4 players are shown.
  6. Scanning overlay text: "Reading the card… / Claude Vision is processing your image" —
     verify it feels calm and on-brand (consider replacing "Claude Vision" with just "Scanning").

  Follow-up for eng-lead (NOT blocking this PR):
  - `voice_advanced` router is owner-gated: frontend sends token automatically via fetchAPI.
    No follow-up needed; confirmed auth flow is correct.

## 2026-06-27 (mount-caddie P26)
- **Done:** backlog `mount-caddie` (P26, NOTICEABLE) — new `CaddieSheet` component mounted
  on the in-round screen. A lean, GPS-free, yardage-book caddie overlay reachable via a
  new "Ask caddie" ghost pill in the bottom action row of `RoundPageClient`.

  Key changes:
  - **New `frontend/src/components/CaddieSheet.tsx`** (~480 LOC):
    - Two interaction modes, selectable via a mono kicker tab bar:
      1. **Voice (primary):** tap-to-record → `VoiceRecorder` + Web Speech API interim
         display (identical pattern to `VoiceRoundSetup`) → `transcribeBlob` → auto-calls
         `talkToCaddie()` (POST `/caddie/voice`) → answer shown in T.serif italic 18px.
         Conversation history maintained for follow-up questions within a session.
         "Ask follow-up" button re-arms the mic with prior context included.
      2. **Distance tap (secondary):** numeric yards-to-pin input + "Advise" button →
         `fetchRecommendation()` (POST `/caddie/recommend`) → club call shown in T.serif
         italic 36px, aim point + target yards in T.mono, strategy line in T.serif italic
         16px, miss-side + aggressiveness chips below.
    - Both paths read golfer's club bag from `getGolferProfile()` (localStorage) and pass
      `club_distances` + `handicap` to the backend when available. camelCase → API key
      mapping inline (driver, 3w, 5w, hy, 4i–9i, pw, gw, sw, lw).
    - Caddy identity (`caddy.name`, `caddy.initial`, `accent`) passed through as props —
      uses "Steve" selected in `RoundPageClient`, medallion in accent colour.
    - Hole context chip in header: "Hole N · Par X · Y yds".
    - Bottom-sheet pattern (matches `ScoreSheet`): `position:fixed; bottom:0` + spring
      animation, `borderTopLeftRadius:24`, `max-height:88dvh`,
      `paddingBottom:env(safe-area-inset-bottom)`. Backdrop: ink @ 32% + blur(3px).
    - Design: T.* tokens only, PAPER_NOISE, Instrument Serif, inline SVGs (MicIcon,
      CloseIcon, FlagIcon), 64pt mic button, 44pt+ all other touch targets, no lucide,
      no zinc/emerald/slate, no new npm deps.
    - Sheet resets all state (conversation, recording, answers) on close.
  - **`RoundPageClient.tsx` changes:**
    - Imports `CaddieSheet`.
    - `const [caddieOpen, setCaddieOpen] = useState(false)` added.
    - Bottom action row: split into two pills side by side:
      - Ghost "Ask caddie" pill (T.paper bg, T.hairline border, caddie initial medallion
        in accent + serif italic label "Ask caddie").
      - Solid "Enter score" pill (T.ink bg, simplified — removed the ↑ icon, shows hole
        number in accent mono kicker).
    - `pointerEvents` guard updated to `scoreOpen || voiceOpen || caddieOpen ? "none" : "auto"`.
    - `<CaddieSheet>` mounted after `<ScoreSheet>` with hole context from round state:
      `holeYards={round.holes[currentHole-1]?.yards ?? hole.yards}`.
  - **Endpoints wired:**
    - POST `/caddie/voice` via `talkToCaddie()` (lib/caddie/api.ts:316)
    - POST `/caddie/recommend` via `fetchRecommendation()` (lib/caddie/api.ts:95)
    - Auth via `fetchAPI`/`authHeaders()` — no new auth code.
  - **Not touched:** `CaddiePanel.tsx`, mapbox, GPS, shot-tracking, PinMarkControl,
    useRealtimeCaddie. All P28 territory, blocked and out of scope.
  - **Gates:** `eslint src/components/CaddieSheet.tsx src/app/round/[id]/RoundPageClient.tsx`
    0 errors · `tsc --noEmit` 0 errors · voice-tests 260/260 · npm test 238/238 ·
    `npm run build` 15 pages, no errors.
  - **NOTICEABLE** — new user-visible capability on TestFlight: "Ask caddie" button on
    in-round screen opens AI caddie sheet with voice and distance paths.
  - **Designer flags for on-device review:**
    1. Two-pill bottom row: verify "Ask caddie" + "Enter score" fit side-by-side on 375px
       without cramping; may need to shrink "Ask caddie" label to initials-only on narrow
       viewports.
    2. Voice tab: "Hearing…" + interim transcript card — verify T.paperDeep bg + T.inkSoft
       text reads in sunlight at 15px serif italic.
    3. Distance tab: club call at 36px T.serif italic — verify legibility and that 36px
       doesn't feel oversized relative to the sheet height on small phones.
    4. Conversation history display (when >1 Q&A in history): verify alternating
       T.paperDeep / T.paperEdge card pairs feel calm, not busy.
    5. Bottom sheet max-height 88dvh — on phones with very short screens (SE), verify
       the mic button + mode tabs are always visible without scrolling.

## 2026-06-27 (voice-live-transcript)
- **Done:** `voice-live-transcript` (NOTICEABLE) — live transcription shown on screen
  in the voice round-setup flow, plus transcript retained through the AI-parse wait.
  Key changes (all in `frontend/src/components/VoiceRoundSetup.tsx`):
  - **Live interim transcription during `listening` phase** (new): Web Speech API
    (`window.SpeechRecognition ?? window.webkitSpeechRecognition`) runs in parallel
    with `MediaRecorder` while the mic is open. As the user speaks, words appear
    on-screen in a yardage-book card labelled "Hearing…" with T.serif italic 19px
    T.inkSoft text — fades in gently via a short framer-motion transition. Deepgram
    is still the authoritative final transcript (Web Speech is best-effort display
    only). On stop, recognition is `abort()`-ed and the interim text clears before
    Deepgram's result lands. No new npm dependency — uses the built-in browser API
    already declared in `frontend/src/types/speech.d.ts`.
  - **Transcript retained during `thinking (isParsing)` phase** (new): previously the
    transcript text was hidden the moment the user tapped "Understand this" — the
    screen showed only "Understanding…" + a pulsing dot. Now the recognised words are
    shown below the pulsing dot in a `T.paperDeep` card (T.serif italic 18px, T.ink)
    so the user can read what was heard while the AI processes it.
  - **Existing `transcribed` and `result` phase displays unchanged** — the "You said"
    box in `transcribed` was already at 19px T.serif italic (good); the echo at the
    bottom of `result` was already present.
  - **Retry / unmount cleanup**: `interimTranscript` state cleared on retry and in
    the `useEffect` cleanup; `recognitionRef.current?.abort()` called on unmount
    alongside the existing `recorderRef.current?.cancel()`.
  - **Other voice entry points**: `transcribeBlob` is only used in `VoiceRoundSetup.tsx`
    (confirmed by grep) — no other component to update.
  - **True real-time streaming note**: the Web Speech API approach delivers good
    on-device interim results without a new backend endpoint. Full Deepgram streaming
    (WebSocket, server-side `listen.open()`, interim `is_final:false` events) would
    require a new `/api/voice/stream` WS endpoint and a streaming client replacement
    — deferred as a follow-up if the Web Speech fallback proves insufficient on-device.
  - Gates: `eslint src/components/VoiceRoundSetup.tsx` 0 errors, `tsc --noEmit` 0
    errors, voice-tests 260/260 pass, npm test 238/238 pass, npm run build OK (15 pages).
  - NOTICEABLE — user-visible on TestFlight: words appear on screen AS the user speaks;
    transcript stays visible while the app is "Understanding…". Designer flag: verify
    the "Hearing…" card's T.paperDeep background and T.inkSoft text against the sunlit
    paper aesthetic; adjust font size if the card feels too large on a 375px viewport.

## 2026-06-27 (client-auth-gate)
- **Done:** backlog `client-auth-gate` (URGENT, NOTICEABLE) — added a client-side
  Clerk auth gate so unauthenticated users are sent to sign-in before any app
  content or backend calls are attempted. Root cause: no server middleware runs in
  the Capacitor webview (capacitor:// origin), so every route was loading for
  unauthenticated users → no token → backend 401s for voice and silent localStorage
  fallback for data.
  Key changes:
  - **New `AuthGate.tsx`** (`frontend/src/components/`): `"use client"` component
    rendered inside `<ClerkProvider>`. Uses `useAuth()` (isLoaded, isSignedIn) and
    `usePathname()`. Three states:
    - `!isLoaded` → `PaperLoading` (calm paper masthead, no flash of app or sign-in)
    - `isAuthRoute(pathname)` (/sign-in, /sign-up) → `children` rendered (no gate,
      no redirect loop)
    - `!isSignedIn` (other routes) → `<SignInClient />` rendered inline; when Clerk
      confirms the session, `isSignedIn` becomes true and children render automatically
    - `isSignedIn` → `children` (full app)
  - **`AuthProvider.tsx` updated**: imports `AuthGate` and wraps children inside it
    (inside `<ClerkProvider>`). `ClerkTokenBridge` renders first so getToken is
    registered. When `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is absent, gate is skipped
    (local dev without credentials still works).
  - **Clerk appearance updated**: dark zinc/emerald palette replaced with yardage-book
    paper/ink palette via Clerk's CSS-variable layer — `colorBackground: "#f4f1ea"`,
    `colorPrimary: "#1a2a1a"`, `colorText: "#1a2a1a"`, `colorTextSecondary: "#6b6558"`,
    `colorInputBackground: "#ece7db"`, `colorDanger: "#b84a3a"`, `borderRadius: "2px"`.
  - **`SignInClient.tsx` restyled**: dark `bg-zinc-950` + white headings replaced with
    paper background (`PAPER_NOISE + T.paper`), serif italic "Looper." masthead at 44px,
    mono kicker "Your yardage book", safe-area-aware padding. Clerk widget inherits
    provider appearance.
  - **`SignUpClient.tsx` restyled**: same paper/ink treatment; kicker reads "Create
    your account".
  - **Token flow confirmed**: after sign-in, `useAuth().isSignedIn` becomes true →
    `AuthGate` renders children → `ClerkTokenBridge.useEffect` fires again with
    `isSignedIn=true` → `setTokenGetter(getToken, {isLoaded:true, isSignedIn:true})`
    → `getTokenViaClerk()` resolves → all API calls get a Bearer token → voice and
    backend work.
  - **Static export compatible**: all hooks called unconditionally; `!isLoaded` guard
    fires during prerender (Clerk doesn't run at build time) → `PaperLoading` is the
    prerendered shell; no `redirect()` or `useRouter().push()` used (no server-routing
    dependency). Build: 15 pages, all ○/● — no errors.
  - Gates: eslint src/ (no new errors in changed files), tsc 0 errors, voice-tests
    260/260, npm test 238/238, npm run build 15 pages OK.
  - NOTICEABLE — owner must now SIGN IN (with the owner Clerk account) when opening
    the app. After sign-in, voice calls will carry a token and backend 401s will stop.
    Designer flag: paper-on-white Clerk widget may need further polish depending on
    Clerk's internal rendering; the provider appearance variables set the palette but
    Clerk's shadow DOM may partially override. Verify on-device.

## 2026-06-21
- **Done:** Phase 0 foundation — project `CLAUDE.md`, `.claude/settings.json` +
  `guard.sh` guardrail hook (tested), the 8-agent team in `.claude/agents/`,
  and a seeded `backlog.json`.
- **In progress (local, safe):** CI workflow, Playwright smoke tests, the limit
  governor, the release email/clip templates, and the `scorecard-ai-team.md`
  concept doc.
- **Blocked / awaiting owner go:** create the Notion board, enable Vercel
  previews + staging, GitHub branch protection on `main`, set the $50 usage-credit
  cap, and schedule the first (dry-run) routine.
- **First task when the loop starts:** `test-games-engine` (lowest risk).

## 2026-06-23
- **Plan pivot (approved):** secure, owner-only **native iOS beta** (TestFlight via
  Xcode Cloud) on **AWS** (RDS replaces Supabase), email approvals, **always-on**
  agent team on the EC2. Full plan: `~/.claude/plans/snazzy-sniffing-summit.md`.
- **Done:** Phase A2 — owner-only auth gate → **PR #24** (`feat/owner-only-auth-gate`).
  Discovery: `backend/app/db/engine.py` already uses a generic `DATABASE_URL`/asyncpg,
  so the backend is already RDS-ready — "dropping Supabase" is mainly a frontend + config change.
- **Next:** B1/A3 — relocate course CRUD to the backend over the DB, remove the client
  Supabase path + `NEXT_PUBLIC_SUPABASE_*`, and remove the browser Anthropic key (`ocr.ts`).
- **Owner-only (blocked on you):** AWS infra (RDS, Secrets Manager, IAM, ALB/ACM, CloudWatch),
  Apple/Xcode Cloud setup, rotate keys, `deploy/` + EC2 systemd units, Settings → Usage $50 cap.

### 2026-06-23 (later)
- Shipped **PR #25** (`feat/ocr-server-side`): scorecard OCR moved server-side, browser
  Anthropic key removed. Plus `.gitignore` hardened, `infra/looper-aws.yaml` CloudFormation
  drafted (owner reviews + applies; guardrail blocks `deploy/`), `release-manager` rewritten
  for the TestFlight/always-on loop, git-sync added to `eng-lead`/`builder`, `OWNER_SETUP.md` written.
- **Open PRs for owner review:** #24 (auth gate), #25 (OCR server-side), #26 (caddie client authed), #27 (dead apiKey removed).
- **Clean no-infra wins: DONE** (#24–#27). **Remaining is RDS-gated** (verify against the real
  backend, so do it after RDS is up): course CRUD → new `/api/courses/mapped` routes over RDS,
  then repoint `golf-api.ts` + `voice-parser.ts` (the backend parse-transcript returns a
  different shape — verify before swapping), then B3 static export. Then Capacitor (C).

## 2026-06-26
- **Done:** backlog `voice-nickname-jt` (priority 1) → **PR #47** (`fix/voice-nickname-jt`).
  Made the local score parser's explicit-pattern pass nickname-aware (`aliasesForPlayer`),
  with a collision guard so a real `JT` player isn't conflated with `Justin`. Fixes the last
  failing smoke case. Gates: **voice-tests 260/260**, tsc clean, build OK, no new lint.
  Minor change (no auth/data/endpoints/deps) — eng-lead ran an adversarial reviewer pass; not
  pinging owner. **Follow-up:** promote voice-tests to a *required* CI gate (separate PR).
- **Done:** backlog `db-core-schema` (P1, SILENT) — Alembic + core scoring schema.
  - Added `alembic>=1.13.0` to `backend/pyproject.toml`; installed (1.18.5).
  - Created `backend/alembic.ini` + `backend/migrations/` (env.py async, script.py.mako).
  - Revision `001_baseline` (empty no-op): marks caddie tables 001–004 as already applied.
  - Revision `002_core_scoring` (005_core_scoring): creates 8 new tables: players,
    golfer_profiles, tournaments, rounds, player_groups, round_players, scores, games.
  - Added ORM models (Player, GolferProfile, Tournament, Round, PlayerGroup, RoundPlayer,
    Score, Game) to `backend/app/db/models.py`.
  - Gates: ruff clean, ORM import clean, alembic offline SQL clean, voice-tests 260/260.
  - DB application deferred to EC2 deploy box. Deploy protocol:
      DATABASE_URL=<real> uv run alembic stamp 001_baseline
      DATABASE_URL=<real> uv run alembic upgrade head
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `api-contract-align` (Phase 0, SILENT) — rewrite `frontend/src/lib/api.ts`
  and `frontend/src/lib/storage-api.ts` to match the real FastAPI/Pydantic contract.
  Key fixes:
  - All interfaces now camelCase (matching `backend/app/models.py` + `frontend/src/lib/types.ts`).
  - Domain types imported from `types.ts` instead of redefined in api.ts.
  - `updateRound` changed from `PATCH` → `PUT`; body now `RoundUpdate {scores,games,groups,status}`.
  - `addScore` body now camelCase `{playerId,holeNumber,strokes}`; return type `Round` not `Score`.
  - `createRound` body camelCase; `players` now includes `id` (required by backend Pydantic model).
  - Removed `RoundListItem` (backend returns full `Round[]`); removed N+1 getRound-per-item calls.
  - `updateTournament` changed from `PATCH` → `PUT`; body camelCase.
  - `addPlayerToTournament` fixed to path-param style `/api/tournaments/{id}/players/{playerId}`.
  - `searchCourses` removed (backend has no `?q=` param); replaced with `getCourses()`.
  - Added Players API (`getPlayers`, `createPlayer`, `updatePlayer`, `deletePlayer`).
  - Removed `addPlayerToRound` (endpoint doesn't exist).
  - Removed Games CRUD (`getGame/createGame/updateGame/deleteGame` — no `/api/games` route).
  - Profile functions stubbed with `// TODO(backend-profile-endpoint)` — return null, no HTTP calls.
  - `storage-api.ts`: replaced silent `catch → localStorage` swallowing with `console.error` +
    explicit offline fallback; removed snake_case converters (no longer needed); profile functions
    simplified to localStorage-only; `saveRoundAsync` sends full scores in one PUT instead of
    N individual addScore calls; player `id` field now included in `createRound`.
  - Gates: tsc clean, lint clean (src/), voice-tests 260/260, build ✓.
  - SILENT — no TestFlight-visible behavior change for un-migrated screens.
- **Done:** backlog `backend-players-db` (P3, Phase 1, SILENT) — `routes/players.py` CRUD
  migrated from JSON-file storage to Postgres `players` table (ORM revision 002_core_scoring).
  - Rewrote all five endpoints (GET list, GET id, POST, PUT, DELETE) to use the async SQLAlchemy
    session (`async with async_session() as db`), filtering every query by `owner_id == current_user_id`.
  - camelCase Pydantic contract (SavedPlayer / PlayerCreate / PlayerUpdate) preserved unchanged;
    ORM → Pydantic mapping in `_orm_to_pydantic`.
  - Removed `players_storage = JSONStorage("players.json", SavedPlayer)` from `storage.py` and
    removed `SavedPlayer` from that file's late import.
  - Removed the 11-player seeding block from `seed_default_data`; course seeding remains
    (rounds/tournaments/courses migrate in later items).
  - Gates: ruff clean, AST parse OK, tsc clean, voice-tests 260/260, build OK.
  - Functional DB verification deferred to EC2 deploy (DATABASE_URL not set locally; import
    of app.main already required DATABASE_URL pre-change due to caddie/shots/pins routes).
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `backend-rounds-scores-db` (P4, Phase 1, SILENT) — `routes/rounds.py` round +
  normalised scores/players/groups/games migrated to Postgres (ORM revision 002_core_scoring).
  - All 6 endpoints rewritten (GET list, GET id, POST create, PUT update, POST scores upsert,
    POST complete, DELETE) using async SQLAlchemy session, owner_id scoping via `current_user_id`.
  - Normalisation: rounds row (JSONB holes), round_players (player_id + handicap + group_id),
    player_groups, scores (upsert on constraint `scores_round_player_hole_uq` via pg_insert
    ON CONFLICT), games (round_id FK).
  - Reassembly: `_build_full_round` joins players table for names; falls back to "Unknown" for
    deleted-roster players (cross-domain plain-text FK, per spec §C loosely coupled).
  - Tournament linkage: POST adds round_id to tournament.round_ids JSONB; DELETE removes it;
    `flag_modified` used to mark JSONB list changes to SQLAlchemy session.
  - Pydantic `Game` model updated: added `roundId: Optional[str] = None` and
    `teams: Optional[list] = None` (closes review follow-up; aligns with types.ts Game.roundId
    + Game.teams, avoids silent data loss for team-format games).
  - Removed `rounds_storage = JSONStorage("rounds.json", Round)` from `storage.py`.
  - Fixed `routes/tournaments.py`: removed broken `rounds_storage` import; tournament-delete
    round cleanup deferred to `backend-tournaments-db` (Postgres rounds' FK is SET NULL).
  - Gates: ruff clean, `import app.main` clean (no live DB), tsc clean, voice-tests 260/260,
    build OK.
  - Functional DB verification deferred to EC2 deploy (DATABASE_URL not set locally).
  - Pre-existing frontend lint issue in `ios/App/App/public/_next/static/` (compiled Capacitor
    assets not excluded from ESLint) and `src/app/players/page.tsx` (pre-existing setState-in-effect
    warning) — both unrelated to this item.
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `backend-tournaments-db` (P5, Phase 1, SILENT) — `routes/tournaments.py` CRUD
  migrated from JSON-file storage to Postgres `tournaments` table (ORM revision 002_core_scoring).
  - All 6 endpoints rewritten (GET list, GET id, POST create, PUT update, DELETE, POST players/{id})
    using async SQLAlchemy session, owner_id scoping via `current_user_id`.
  - `id` is now a real UUID (`str(uuid.uuid4())`), so rounds can FK to tournaments via
    `rounds.tournament_id` — the guarded linkage in `create_round` activates automatically.
  - `playerNamesById` derived on read via a join to the `players` table (owner-scoped, same
    pattern as `_build_full_round` in rounds.py). No separate JSONB column needed; falls back to
    "Unknown" for deleted-roster players. `player_name` query param on add-player is still accepted
    for API compat but no longer stored (players table is source of truth for names).
  - Tournament-scoped games loaded from the `games` table (tournament_id FK, round_id NULL);
    wholesale-replaced (delete-then-insert) on PUT when data.games is supplied.
  - DELETE cascades to tournament-scoped games (FK ondelete='CASCADE'); linked rounds have
    tournament_id SET NULL (FK ondelete='SET NULL') — round rows preserved.
  - Removed `tournaments_storage = JSONStorage("tournaments.json", Tournament)` from `storage.py`
    and removed `Tournament` from that file's late import.
  - Gates: ruff clean, `import app.main` clean (no live DB), tsc clean, voice-tests 260/260,
    build OK.
  - Functional DB verification deferred to EC2 deploy (DATABASE_URL not set locally).
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `backend-courses-db` (P6, Phase 1, SILENT) — `routes/courses.py` scoring
  courses migrated from JSON-file storage to Postgres `scoring_courses` table (new Alembic
  migration `006_scoring_courses`).
  - New Alembic revision `006_scoring_courses` (file `0003_006_scoring_courses.py`): creates
    `scoring_courses` table — id (UUID), owner_id (Text nullable), name (Text), location
    (Text nullable), holes (JSONB — list of HoleInfo), tees (JSONB nullable — list of TeeOption),
    created_at, updated_at. Owner index: `scoring_courses_owner_id_idx`.
  - New ORM class `ScoringCourse` added to `backend/app/db/models.py` with matching columns.
    Intentionally separate from the PostGIS `courses`/`tee_sets`/`holes` tables (caddie/import,
    migration 001 baseline) — unification is a deliberate future refactor.
  - Rewrote all 5 endpoints in `routes/courses.py` (GET list, GET {id}, POST, POST /default,
    DELETE) using `async with async_session() as db`, filtering every query by
    `owner_id == current_user_id`. camelCase Pydantic contract (Course / CourseCreate /
    HoleInfo / TeeOption) preserved unchanged; ORM → Pydantic mapping in `_orm_to_pydantic`.
  - Removed `courses_storage = JSONStorage("courses.json", Course)` from `storage.py`.
  - `seed_default_data` is now a no-op (all 4 domains Postgres-backed): kept as empty function
    body with comment, the startup call in `main.py` removed to avoid dead code.
  - Follow-up note added to `specs/real-data-wiring-plan.md`: course-identity unification
    (scoring_courses vs mapped-courses PostGIS tables) deferred as a future refactor.
  - Mapped-courses path (`routes/courses_mapped.py`, `services/courses_mapped`) untouched.
  - Gates: ruff clean, `DATABASE_URL=... alembic upgrade head --sql` renders `scoring_courses`
    table cleanly, `import app.main` clean, tsc clean, voice-tests 260/260, build OK.
  - Functional DB verification deferred to EC2 deploy (DATABASE_URL not set locally).
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `backend-profile-endpoint` (P7, Phase 1, SILENT) — new `routes/profile.py`
  (`GET/POST/PUT /api/profile/golfer`) backed by the `golfer_profiles` Postgres table; frontend
  client un-stubbed.
  - Shape reconciliation: ORM `golfer_profiles` (migration 002_core_scoring) lacked `name` (display
    name) and a free-text `home_course` field (had only `home_course_id`, a course-ID reference).
    Frontend `GolferProfile` (types.ts) requires `name` (str), `handicap` (float|null),
    `homeCourse` (str|null), `clubDistances` (JSONB dict).
  - New Alembic revision `007_golfer_profile_fields` (`0004_007_golfer_profile_fields.py`): adds
    `name TEXT NULL` and `home_course TEXT NULL` to `golfer_profiles`. `home_course_id` kept for
    future caddie cross-reference. Revision chain: 007 revises 006_scoring_courses.
  - ORM `GolferProfile` updated (`db/models.py`): added `name: Optional[str]` and
    `home_course: Optional[str]` mapped columns.
  - Pydantic models added to `models.py`: `GolferProfile` (response), `GolferProfileCreate`
    (POST body), `GolferProfileUpdate` (PUT body). All camelCase: `handicap` ← `handicap_index`,
    `homeCourse` ← `home_course`, `clubDistances` ← `bag_clubs`.
  - New `backend/app/routes/profile.py`:
    - `GET /api/profile/golfer` — returns 200+body when profile exists, 204 No Content when none.
    - `POST /api/profile/golfer` — create; 409 if already exists.
    - `PUT /api/profile/golfer` — upsert (create or partial-update). Preferred for saves.
    - Owner scoping: `user_id == current_user_id`; `require_owner` gate applied in `main.py`.
  - `main.py`: registered `profile.router` under `_owner_only` dependencies.
  - Frontend `api.ts`: replaced null-return/throw stubs with real HTTP calls.
    - `getGolferProfileAsync()` — GET; handles 204 → null; auth-checks before calling.
    - `createGolferProfile(data)` — POST with typed `GolferProfileCreate` body.
    - `updateGolferProfile(data)` — PUT with typed `GolferProfileUpdate` body (upsert).
    - `GolferProfile` re-exported from api.ts.
  - Frontend `storage-api.ts`: `getGolferProfileAsync` / `saveGolferProfileAsync` now API-
    authoritative (API call + write-through to localStorage on success; localStorage fallback
    on API failure with `console.error`). `saveGolferProfileAsync` calls `updateGolferProfile`
    (PUT upsert). Removes the `// TODO(backend-profile-endpoint)` stubs.
  - Profile UI page (`app/profile/page.tsx`) intentionally untouched — that is a later `wire-profile-*` item.
  - Gates: ruff clean, `alembic upgrade head --sql` renders 007 columns cleanly,
    `import app.main` clean (DATABASE_URL=fake), tsc clean, voice-tests 260/260.
  - Functional DB verification deferred to EC2 deploy.
  - SILENT — no TestFlight-visible change; `useGolferProfile` hook not imported by any screen yet.
- **Done:** backlog `json-to-db-backfill` (P9, Phase 1, SILENT) — one-off idempotent
  migration script `backend/scripts/backfill_core_data.py` that imports all four
  `backend/data/*.json` files into Postgres and retires the stale JSON files.
  - Reads players.json → `players`, courses.json → `scoring_courses`,
    tournaments.json → `tournaments` + tournament-scoped `games`,
    rounds.json → `rounds` + `round_players` + `player_groups` + `scores` + round-scoped `games`.
  - Legacy non-UUID ids (e.g. `player-ryan-murphy`, `course-augusta`) are mapped to
    deterministic UUID v5 values (namespace=NAMESPACE_URL) so every re-run produces
    the same DB primary key for the same source record.
  - Cross-table remapping: player_id_map, course_id_map, tournament_id_map built in
    order; round.courseId / round.tournamentId / player references all remapped.
    Second pass patches tournament.round_ids with new round UUIDs after rounds import.
  - Upserts: players/courses/tournaments/rounds/games use ON CONFLICT (id) DO UPDATE;
    round_players uses ON CONFLICT ON CONSTRAINT round_players_round_player_uq;
    scores uses ON CONFLICT ON CONSTRAINT scores_round_player_hole_uq. Fully
    idempotent — re-runs skip/update without duplicating.
  - Owner assignment: --owner-id CLI arg (falls back to $OWNER_CLERK_USER_ID); fails
    with a clear error if neither is supplied.
  - Dry-run: --dry-run prints the full import plan (UUIDs per record) with NO DB
    connection. Demonstrated: 11 players + 3 courses → deterministic UUIDs shown.
  - File retirement: after successful commit renames data/<name>.json →
    data/<name>.json.imported (never hard-deletes); idempotent re-runs no-op cleanly.
  - Deploy runbook line: `cd backend && DATABASE_URL=<RDS_URL> uv run python -m scripts.backfill_core_data --owner-id $OWNER_CLERK_USER_ID`
  - Gates: ruff clean, import clean (DATABASE_URL fake), dry-run demo clean (no DB),
    tsc clean, voice-tests 260/260.
  - SILENT — no TestFlight-visible change; script runs once on EC2 deploy box.
- **Done:** backlog `test-games-engine` (P2, SILENT) — 46 unit tests for `lib/games.ts`
  via Vitest (already a devDep + `test` script; no new dependencies added).
  - New file: `frontend/src/lib/games.test.ts` (picked up by `vitest.config.ts` pattern
    `src/**/*.test.ts`).
  - Covers all 7 exported compute* functions + the `computeGameResults` dispatcher:
    skins (7 tests), bestBall (4), nassau (5), threePoint (5), stableford (5),
    matchPlay (5), wolf (7), dispatcher (8). Total: 46 tests, 46 pass.
  - Edge cases: carryover multi-tie chains, partial rounds, ties (null winner),
    lone-wolf win/loss (+3/-3), partner mode win/loss (+1 each), match-play early end
    ("10 & 8"), NO_SCORE holes, empty playerIds falling back to round.players,
    modifiedStableford routing to computeStableford, unimplemented format → {}.
  - Documented stub: nassauMode='match' always uses stroke totals (P21 pending) —
    asserted as current behavior, marked with a STUB comment, NOT fixed.
  - No bugs found that warrant stopping; all format outputs match expected behavior.
  - Gates: npm test 46/46 pass, lint clean (src/), tsc --noEmit clean,
    voice-tests 260/260 pass, npm run build OK.
  - SILENT — runtime-neutral (test file only, no app code modified, no lib/games.ts
    changes).
- **Done:** backlog `test-voice-pipeline` (P30, SILENT) — unit tests for the voice
  pipeline's schemas + normalization, complementing the integration harness.
  - New files (no app code touched):
    - `frontend/src/lib/voice/parseVoiceScores.test.ts` — 46 tests for `parseVoiceScoresLocally`:
      STT number-word normalization (ford/fore/four/ate/won/too/to/tree → integers), all six
      score-phrasing patterns (made a / got a / with a / shot a / shot / bare), golf-term
      scoring (birdie/eagle/bogey/double/par at any par value), everyone-par (8 variants
      incl. "all bogey" / "everybody double"), conjunction splitting (and / comma / then /
      no-punctuation chains), nickname resolution (jt→Justin, mike→Michael, bob→Robert),
      collision guard (PR #47): when "JT" is a literal player "jt" matches JT not Justin,
      edge cases (empty/filler/uppercase/key-casing/prefix match).
    - `frontend/src/lib/voice/schemas.test.ts` — 46 tests for Zod schemas: GameFormatSchema
      (all 8 valid formats + 3 invalid), VoiceScoreParseResultSchema (6 valid + 11 invalid
      incl. hole=0, float hole, negative/fractional score, confidence out-of-range, extra
      fields, missing required fields), ParsedGameConfigSchema, ParsedTournamentConfigSchema,
      VoiceParseResultSchema (game + tournament paths, normalization field, matchPlay settings).
    - `frontend/src/lib/voice/utils.test.ts` — 47 tests: parseSpokenNumber (27 words incl.
      all STT variants; confirms "ford" is NOT in utils WORD_NUMBERS — only in parseVoiceScores
      WORD_TO_NUM), normalizeName, clamp01, levenshtein, similarity (incl. 0.92 prefix-match
      constant), fuzzyBestMatch (custom minScore threshold), safeJsonExtract (fenced + bare JSON),
      stripFillerWords, normalizeTranscript (basketball→best ball ASR fix).
  - BUGS FOUND (not fixed — behavior-change blocked while PR #51 is in review):
    1. `parseVoiceScoresLocally` regex: `"for"` (listed in WORD_TO_NUM as 4) is absent from
       both the first-pass and second-pass capture-group alternations. "Justin with a for"
       produces no score. `parseSpokenNumber` in utils.ts DOES handle "for" → 4, so the gap
       is only in parseVoiceScores.ts's own regex alternations.
    2. `parseVoiceScoresLocally` everyone-pattern: "everybody dbl bogey" matches the regex
       (alternation has "dbl bogey") but the value-selector checks `t.includes("double")`
       (false for "dbl") and falls through to `t.includes("bogey")` → returns par+1 instead
       of par+2. Inconsistent with "dbl bogey" being in the regex.
  - Gates: npm test 230/230 pass (was 46/46 + 184 new), tsc 0 errors, voice-tests 260/260,
    build OK, new test files lint-clean.
  - SILENT — runtime-neutral (test files only, zero app/lib/voice code changes).
- **Next ready backlog items:** `frontend-lint-cleanup` (P9), `tee-time-finder` Phase 1 (P8).

## 2026-06-26 (wire-leaderboard-real)
- **Done:** backlog `wire-leaderboard-real` (P12, NOTICEABLE) — replaced `LB_MOCK` with
  real computation from `lib/games.ts` via the round's real scores.
  Key changes:
  - **Removed:** `LB_MOCK` constant (nassau/skins/threePoint hardcoded mid-round state).
  - **Tabs now dynamic:** `TABS` replaced with computed list — always "Overall" first, then
    one tab per game in `round.games` (uses game id as tab key). Tab label includes
    `game.settings.pointValue` if set (e.g. "Nassau · $20").
  - **New `round` prop on `LeaderboardSheet`:** `RoundPageClient` passes `round={round}`
    so the sheet can read `round.games` and build the engine call.
  - **Engine wiring:** `computeGameResults(engineRound, game)` called for each game;
    `engineRound` has `round.scores` replaced with the display-scores map converted to
    `Score[]` via `displayScoresToArr()` — so pending (not-yet-confirmed) scores are
    included in game computations.
  - **Nassau:** real `NassauResults` — F9/B9/overall winner grid, running totals table.
    `scope=team` uses team names from `game.teams`; `scope=individual` uses player names.
    When `nassauResults.mode === 'match'`, a calm note explains that match-play scoring
    is pending P21 and stroke totals are shown instead.
  - **Skins:** real `SkinsResults` — per-player skin count, holes won; pot-carrying
    callout computed from `holeWinners` + display scores (played-hole detection). Shows
    "up for grabs" value if `game.settings.pointValue` is set.
  - **3-Point:** real `ThreePointResults` — team A vs B scoreboard using real points;
    team names from `game.teams`.
  - **Generic fallback:** `GenericGame` handles bestBall, stableford, matchPlay, wolf, and
    unknown formats — shows a minimal score/status display in the yardage-book aesthetic.
  - **Empty states:** no games → "No games yet" prompt shown below Overall tab. No scores
    yet for a format → calm italic "Scores will appear here as you play." (or format-
    specific equivalent). Match-play Nassau shows stroke-total note (P21 pending).
  - **No new design language:** all inline styles use T.* tokens; no new deps; existing
    Tab, DotStrip, Overall sub-components preserved unchanged.
  - **Games.ts functions used:** `computeGameResults` (dispatch), `computeSkins`,
    `computeNassau`, `computeThreePoint`, `computeMatchPlay`, `computeStableford`,
    `computeBestBall`, `computeWolf` (via the dispatch switch — all formats).
  - **Data flow:** `RoundPageClient.round.games` (from backend) + display `scores`
    (pending overlay included) → `computeGameResults` → `NassauResults | SkinsResults |
    ThreePointResults | ...` → tab-specific render component.
  - **Match-play Nassau (P21):** engine comment preserved ("falls back to stroke totals");
    UI shows a note on the Nassau tab when `nassauResults.mode === 'match'`.
  - Gates: lint clean (src/), tsc clean (0 errors), voice-tests 260/260, build OK.
  - NOTICEABLE — leaderboard tabs now show real standings from entered scores; game tabs
    appear/disappear based on which games are actually on the round.
- **Done:** designer follow-up fixes for `wire-leaderboard-real` (5 must-fix + 2 polish).
  1. Safe-area top: `top: 36` → `top: "max(36px, env(safe-area-inset-top))"` (Dynamic Island).
  2. Safe-area bottom: scroll padding bottom → `paddingBottom: "max(40px, env(safe-area-inset-bottom))"` (home indicator).
  3. Close button hit area: `width:32,height:32` → `minWidth:44,minHeight:44,display:flex` (iOS 44pt min).
  4. Tab touch target: `padding:"8px 14px"` → `"12px 14px"` (~44pt height on-course).
  5. "Through hole 0" guard: `{thru > 0 ? \`Through hole ${thru}\` : "—"}`.
  6. DotStrip eagle color: inline `"oklch(0.48 0.14 280)"` → `T.eagle` (tokenized).
  7. Skins pot callout background: `rgba(26,42,26,0.02)` (invisible) → `T.paperDeep`.
  Deferred (logged, not blocking): Nassau redundant empty-state text alongside winner grid;
  3-Point scoring guide always visible even when no scores; tab-bar overflow scrollbar not
  hidden; drag handle implies swipe-to-dismiss but only backdrop-tap dismisses — flag for owner.
  - Gates: lint clean, tsc 0 errors, voice-tests 260/260, build OK.

### 2026-06-27 — Backend DB layer COMPLETE + DEPLOYED (real-data wiring Phase 0/1)
- Shipped & merged **bundle #48** to main: db-core-schema, api-contract-align, and the
  full backend domain on Postgres (players, rounds/scores, tournaments, courses, profile,
  games) via Alembic 005/006/007 + a backfill script. Every item adversarially reviewed.
- **Deploy incident (resolved):** first deploy false-greened — migration 002 actually failed
  (`asyncpg InvalidTextRepresentationError: Token "'" is invalid`) because JSONB
  `server_default`s were plain strings; deploy only checked /health. Offline `--sql` missed
  it (renders without executing). **Fixes:** (1) wrap JSONB defaults in `sa.text(...)` (#49);
  (2) harden `deploy.yml` to `set -eu` fail-fast + run alembic before restart + `uv sync` in
  backend/ (#49, #50 — `set -o pipefail` failed under dash/SSM, switched to `set -eu`).
- **Redeploy SUCCESS:** alembic applied 001→002→006→007 cleanly on the live EC2 Postgres;
  /health ok; SSM Success. Backend DB layer is LIVE.
- **Open decision:** one-time backfill of `data/*.json` — likely seed-only, recommend SKIP
  for a clean DB start unless EC2 has real owner data.
- **Next: Phase 2 (NOTICEABLE) UI wiring** — flipped `wire-round-new` (P10) + `wire-round-scoring`
  (P11) to ready; these are user-facing → TestFlight approval bundles. Lesson: add a real-DB
  migration smoke test (throwaway Postgres) to catch execution-time DDL bugs the offline gate can't.

## 2026-06-26 (wire-round-scoring — reviewer pass 3 fixes)
- **Done:** reviewer pass 3 fixes for `wire-round-scoring` (commit e7d91b5 on integration/next).
  BLOCKER #1 (FIXED):
  - Non-404 load error and 404/LOCAL paths both rendered from localStorage WITHOUT seeding
    `pendingRef`. The next successful foreground save called
    `buildLocalRound(serverSnapshot, pending={})`, permanently erasing prior-session unsynced scores.
  - Fix: new `seedPendingFromLocal(local, pending)` helper seeds ALL non-null local scores into
    `pendingRef` before the `setScores` call. Both catch branches now call it and use
    `mergeWithPending` (not bare `buildScoreMap`) so the pending overlay is active from the start.
  Fix #3 (`retrySyncPending` seq-guard race):
  - Background retry called `setRound(updated)` + `setScores(...)` without the `addScoreSeqRef`
    guard, racing concurrent foreground saves.
  - Fix: retry now only confirms pending removal (`pendingRef.current.delete(key)`) — no UI state
    application, no localStorage write. UI remains correct via pending overlay already set at load;
    next foreground save writes localStorage.
  Fix #4 (`isNotFoundOrNetworkError` too broad):
  - The JSON-parse `catch` fell back to `m.toLowerCase().includes("not found")` on arbitrary body
    text, misclassifying 5xx errors containing "not found" prose as LOCAL mode.
  - Fix: catch now returns `false`; only trust `TypeError`, the exact `"API error: 404"` string
    (changed from substring to equality), and parsed FastAPI `{"detail":"...not found..."}`.
  Fix #6 (banner backgrounds inline RGB):
  - Added `T.errorWash: "rgba(184,74,58,0.13)"` and `T.warningWash: "rgba(184,118,58,0.13)"` to
    `frontend/src/components/yardage/tokens.ts`. Both banner `background` props now reference the tokens.
  - Gates: lint clean (src/), tsc clean, voice-tests 260/260, pushed to integration/next.
  - NOTICEABLE — prior-session score preservation now correct in all three load-error paths.

## 2026-06-26 (wire-round-scoring — reviewer fixes)
- **Done:** reviewer + designer follow-up fixes for `wire-round-scoring` (same branch).
  BLOCKER fixed:
  A. **Silent permanent score loss (FIXED):** introduced `pendingRef` (Map<string,Score>,
     key="{playerId}:{holeNumber}") to track scores entered but not yet server-confirmed.
     - `mergeWithPending()`: overlays pending on every server snapshot so a failed-save
       score is never wiped by the next success.
     - `buildLocalRound()`: merges pending into the round saved to localStorage so a page
       reload re-discovers unsynced scores.
     - Pending removal: only when server confirms exact (playerId, holeNumber, strokes)
       — rapid re-entry of the same hole leaves the newer pending value intact.
     - On load: compares API response vs localStorage; re-adds any local-only scores to
       pending; fires `retrySyncPending()` (background, silently logged on failure).
  CORRECTNESS fixed:
  1. Load catch now calls `isNotFoundOrNetworkError(e)`: `TypeError` (network) or
     message contains "not found"/"API error: 404" → LOCAL mode; all other errors
     (500, auth) → stay ONLINE, show banner, render from localStorage cache.
  2. Out-of-order responses: `addScoreSeqRef` + `lastAppliedSeqRef` — each addScore
     call gets a seq; response is skipped if `mySeq ≤ lastApplied` (a newer one already
     updated state). Combined with pending overlay prevents stale snapshots from
     clobbering latest UI state.
  3. Stale closures eliminated: all LOCAL-branch and error-branch `round` mutations now
     use `setRound(prev → …)` functional updaters (reads latest state, not closed-over
     stale value). `localSaveRound` called inside the updater with latest `prev`.
  DESIGN fixed:
  4. "LOCAL" badge fontSize 7.5 → 9 (readable in sunlight).
  5. Error-banner × button: `width:28,height:28,display:'flex',alignItems:'center',
     justifyContent:'center',flexShrink:0` (adequate touch target on-course).
  6. Header course-name span: `flex:1,minWidth:0,overflow:hidden,textOverflow:ellipsis,
     whiteSpace:nowrap` — real course names no longer overflow on small viewports.
  7. Status-zone backgrounds: error `rgba(184,74,58,0.08)→0.13`, LOCAL
     `rgba(184,118,58,0.07)→0.13` — contrast for sunlight use.
  8. Hole nav chips: `Array.from({length:holeCount},…)` not hardcoded 18 — 9-hole
     rounds render 9 chips.
  9. `T.errorInk:"#b84a3a"` + `T.warningInk:"#b8763a"` registered in `tokens.ts`;
     all hardcoded hex refs in RoundPageClient replaced with token references.
  - Gates: lint clean (src/), tsc --noEmit clean, voice-tests 260/260, build OK.
  - NOTICEABLE — all fixes are behavioural + visual improvements to the scoring screen.

## 2026-06-26 (wire-round-scoring)
- **Done:** backlog `wire-round-scoring` (P11, NOTICEABLE) — `RoundPageClient.tsx` now loads
  and persists scores via the backend instead of SEED_SCORES/SEED_PLAYERS mocks.
  Key changes:
  - **Removed:** `SEED_SCORES` and `SEED_PLAYERS` constants (the mock data); `getRound`/`saveRound`
    localStorage-only imports replaced with separate API + local imports.
  - **Round loading:** async on mount — tries `api.getRound(id)` (GET /api/rounds/{id}).
    On success: populates `players` (SeedPlayer[]) and `scores` map from the server response.
    On 404 or network error: falls back to `localGetRound(id)` (localStorage), sets
    `isLocalRound = true`. If no local copy either, renders a "Round not found" screen.
  - **Orphan/offline handling (§Review follow-up carry-over):** rounds created by the
    wire-round-new offline fallback have a client UUID not known to the backend; they 404 on
    load. `isLocalRound = true` activates: scores saved to localStorage only, no API calls.
    The round is marked "LOCAL" in the header chrome and a calm amber notice is shown inline.
    Deferred: re-creating the orphan round on the backend and reconciling IDs (a full sync
    engine is out of scope for this item — noted for a follow-up).
  - **Per-stroke persist:** `handleSetScore` calls `api.addScore(roundId, {playerId, holeNumber, strokes})`
    (POST /api/rounds/{id}/scores) after an optimistic local update. On success: syncs all scores
    from the server response + write-through to localStorage. On error: surfaces via `apiError`
    banner (dismissible, #b84a3a color, no silent swallow), saves optimistic state locally.
  - **Finish round:** `handleFinish` now async — calls `api.completeRound(id)` for API-backed
    rounds; falls back to local status='completed' save on error. Local rounds save locally only.
  - **Player/score conversion:** `buildSeedPlayers()` maps `Round.players` → `SeedPlayer[]`
    (PLAYER_COLORS palette); `buildScoreMap()` maps `Round.scores Score[]` → `Record<string,
    (number|null)[]>` (indexed by hole 0–17). Hole nav chips use first player's score to show
    "played" indicator (was hardcoded to 'p1').
  - **par for scoring:** prefers `round.holes[currentHole-1].par` (authoritative); falls back
    to `HOLES[currentHole-1].par` (illustration constant). `PlayerPanel` and `LeaderboardSheet`
    receive round's holes pars array (fallback to HOLES pars if round.holes is empty).
  - **UX preserved:** all inline styles use `T.*` tokens; no new design language; yardage-book
    feel intact. Footer changed from hardcoded "Pebble Beach Golf Links · 6,828 yds · Par 72"
    to real `round.courseName · N holes · teeName tees`.
  - **No-round state:** renders a calm not-found screen (T.serif italic message + back button)
    instead of a broken/empty scorecard.
  - **Designer flag:** "LOCAL" badge and amber notice use `#b8763a` (warm ink, not generic red)
    — consistent with the yardage-book palette; designer should verify against NORTHSTAR.
  - Deferred sync follow-up added as note in code (orphan round re-creation on backend).
  - Gates: lint clean (src/), tsc --noEmit clean, voice-tests 260/260, npm run build OK.
  - NOTICEABLE — user-visible on TestFlight: scoring screen now loads real round data and
    persists each stroke to the backend.

## 2026-06-26 (wire-round-new — follow-up fixes)
- **Done:** coordinator review fixes for `wire-round-new` (same branch, amend-style commit).
  BLOCKERS:
  1. **Error handling (BLOCKER 1):** `handleTeeOff` catch now distinguishes `TypeError`
     (network-down = offline fallback OK) from `Error` (HTTP 4xx/5xx = show `createError`
     banner, no local round fabricated).
  2. **Player de-dup (BLOCKER 2):** `deduped` filter added after `roundPlayers` assignment
     — prevents duplicate `round_players` rows when voice maps the same name twice to one
     saved player id.
  3. **VoiceRoundSetup restyled (BLOCKER 3):** full rewrite — `T.*` tokens, `PAPER_NOISE`
     background, inline SVG mic/close/refresh, `Waveform` from `Voice.tsx`. No more
     `bg-zinc-950`, `bg-emerald-500`, or lucide-react.
  4. **CourseSearch restyled (BLOCKER 4):** bottom sheet on `T.paper` (was `fixed inset-0
     bg-zinc-950/95`); drag handle; T.serif/T.mono headers; dashed-border result rows;
     inline SVG search/mapPin/close; loading pulse animation.
  5. **PlayerAutocomplete restyled (BLOCKER 5):** `T.paperDeep` input, `T.paper` dropdown,
     `T.ink` avatar circle, `DEFAULT_ACCENT` match highlight via inline style (no
     `text-emerald-300`); no lucide-react; keyboard hint footer removed. Player picker sheet
     reverted from `T.ink` to `T.paper` background (header colors updated to T.ink/T.pencil).
  SHOULD-FIX:
  6. Disabled hint "Add a player above to start" shown below Tee off button when not ready.
  7. "+ Add" button touch target raised to minHeight 44px.
  8. Mic button: 56px T.ink circle with accent ring + "Speak" T.mono label below.
  9. Quick-reply chip padding raised to 9px/13px (minHeight 38px).
  DEFER (noted, not done): footer gradient, auto-trigger after record, desktop nav hint,
  TEE_OPTIONS yardage not tied to course.
  - Gates: tsc --noEmit clean (0 errors), voice-tests 260/260 pass, npm run build OK.
  - NOTICEABLE — design overhaul is user-visible.

## 2026-06-26 (wire-round-new)
- **Done:** backlog `wire-round-new` (P10, NOTICEABLE) — replaced the scripted demo in
  `app/round/new/page.tsx` with a real round-setup flow that persists to the backend.
  Key changes:
  - Removed: scripted `useEffect` auto-typing demo, hardcoded `utter`/`course`/`players`
    constants, `heardCourse`/`heardJack`/`heardSam` detection, `saveRound` to localStorage.
  - Added `selectedCourse: SelectedCourse | null` state; course card now shows empty state
    ("Tap to search") or selected course info (name, location, par/holes); tapping opens
    `CourseSearch` overlay (full-screen dark modal — existing component, unchanged).
  - Added `players: Player[]` (min 1 slot) + `savedPlayers: SavedPlayer[]` state; loaded
    on mount by calling `getPlayers()` (API) with `getSavedPlayers()` (localStorage) fallback.
    Each player row is tappable and opens a dark picker sheet hosting `PlayerAutocomplete`
    (the dark Tailwind theme works correctly against the ink-colored sheet background).
    Auto-closes when a saved player is selected by click/enter; "Done" button for typed names.
    "+ Add" button appends a new slot and opens the picker for it.
  - Voice path: mic button opens `VoiceRoundSetup` overlay (existing component, unchanged);
    `onSetupRound({courseName, playerNames, teeName})` callback populates selectedCourse,
    players (linked to savedPlayers where name matches), and tee; then displays a conversation
    summary in the caddy-bubble surface with quick-reply chips for "Change game", "Different
    tees", "Add a player".
  - `handleTeeOff`: calls `api.createRound(...)` directly (POST /api/rounds); backend assigns
    its own UUID as the round id. Server-returned round is write-through cached to localStorage
    (`localSaveRound(created)`), then navigates to `/round/${created.id}` (server id, not
    client). Offline fallback: if API throws, generates a client UUID, saves locally, navigates.
    This is the §"Review follow-ups" reconciliation for wire-round-new.
  - Game objects built in `handleTeeOff` from the selected GameId (mapped via
    `GAME_ID_TO_FORMAT` to `GameFormat`); `roundId: ''` placeholder used on create (backend
    assigns real FK). Stroke/None produce no game object.
  - Yardage-book aesthetic preserved: all inline styles use `T.*` tokens; no new Tailwind
    in the main page; sub-components (PickerRow, GamePicker, TeePicker, SidesPicker,
    HolesPicker, MiniStat) kept with identical styling.
  - Designer note: `VoiceRoundSetup` and `CourseSearch` overlays use dark Tailwind styling
    (zinc/emerald), not yardage tokens — acceptable as modal interactions but flagged for a
    future design-pass to restyle them with T.* tokens.
  - Gates: lint clean (src/), tsc --noEmit clean, voice-tests 260/260, npm run build OK.
  - NOTICEABLE — user-visible on TestFlight: the scripted demo is gone; real round setup
    with backend persistence replaces it.

## 2026-06-27 (wire-home)
- **Done:** backlog `wire-home` (P13, NOTICEABLE) — `app/page.tsx` home screen now loads
  real data from the backend via the storage-api.ts API-authoritative pattern.
  Key changes:
  - **Removed:** `SAMPLE_RECENT`, `STATS`, `HDCP`, `FEED` mock constants (5 hardcoded entries,
    fake handicap/scoring stats, fake social feed). `initializeStorage` + sync `getRounds`
    localStorage imports replaced with async `getRoundsAsync`/`getTournamentsAsync`/
    `getGolferProfileAsync` from `storage-api.ts`.
  - **Recent rounds:** async-loaded from `GET /api/rounds` (owner-scoped). Rounds sorted
    most-recent-first; top 5 shown. Each row derived via `deriveRecentRows()`: date formatted
    (month + day), course name, total strokes + toPar net via `calculateTotals()` from
    `types.ts`, holesPlayed count, "T" tag for tournament rounds, "Live" badge for active
    rounds. Rows are now tappable and navigate to `/round/{id}`.
  - **Handicap:** from `GET /api/profile/golfer` → `profile.handicap`. Shows "—" when null
    (no profile or no handicap set). Also displayed on the profile card (was hardcoded "77").
    Sparkline removed (no historical handicap series available yet — flagged for
    wire-profile-stats item).
  - **Scoring average:** derived client-side from the loaded rounds list via `deriveScoringAvg()`
    — averages total strokes over completed rounds with ≥9 holes played. Shows "—" when
    insufficient data. Trend arrow removed (requires historical handicap series).
  - **Fairways / GIR / Putts:** all show "—". Per-hole shot data is not tracked yet; these
    three stats require a per-shot data source. Flagged for a future wire-profile-stats item.
  - **Tournament link:** `QuickAction "Tournament"` and the Trophy Case block both route to
    `GET /api/tournaments` most-recent tournament (`/tournament/{id}`) rather than the
    hardcoded `/tournament/sunday-cup-2024`. If no tournament exists, the quick-action routes
    to `/tournament/new` and the Trophy Case shows a calm "No tournaments yet — Start one →"
    empty state.
  - **Social feed ("From the group") — REMOVED:** no real data source exists for a social
    feed. The `FEED` constant was fabricated (Jack/Sam/Justin). Removed entirely rather than
    show fake data. Decision logged in code comment for the designer/owner; re-introduce when
    a real activity stream is backed by the API.
  - **Empty states:** new user with no rounds sees a calm serif italic "No rounds yet. Tap
    'Start a round' above to begin." empty state inside the rounds section. Stats section
    shows "—" for all missing values. Trophy case shows calm empty state with "Start one →"
    CTA.
  - **Live round:** detection moved from sync `getRounds()` (localStorage only) to the async
    loaded rounds list — active round is found from the same API-authoritative fetch.
  - **Loading state:** `loading` boolean guards the stats/rounds sections so "—" is shown
    (not stale/wrong) while the API call is in flight.
  - **Error surfacing:** uses `storage-api.ts` explicit-offline-cache pattern — API is
    authoritative; on failure `console.error` is logged + localStorage fallback returned.
    No silent swallowing.
  - **Yardage-book feel preserved:** all inline styles use T.* tokens; no new dependencies
    or design language; serif/mono typography and paper/ink palette unchanged; motion pulsing
    mic CTA retained.
  - **Decisions for designer/owner review:**
    1. Sparkline removed — bring back when handicap history is available (wire-profile-stats).
    2. Trend arrow removed — same reason.
    3. Social feed removed — no backend; re-add when a real activity stream exists.
    4. Fairways/GIR/Putts show "—" — requires per-shot tracking (future item).
    5. "San Francisco" and "66°F, wind WNW 8. Presidio tee times open from 10:40." in masthead
       are still hardcoded — location/weather wiring is out of scope for this item.
  - **Gates:** lint clean (`src/app/page.tsx` 0 errors), tsc --noEmit 0 errors,
    voice-tests 260/260 pass, npm run build OK.
  - NOTICEABLE — user-visible on TestFlight: home screen shows real rounds, real handicap,
    real tournament link; no fabricated data.

## 2026-06-27 (wire-home reviewer + designer follow-up fixes)
- **Done:** reviewer + designer follow-up fixes for `wire-home` (one commit on integration/next).
  BLOCKERS fixed:
  1. **Hardcoded city + weather removed:** "San Francisco" header div and "66°F, wind WNW 8.
     Presidio tee times open from 10:40." subtitle both deleted. Masthead now shows only the
     time-of-day greeting. No location/weather data source exists — showing nothing is honest.
  2. **"to par avg" math fixed:** replaced `scoringAvg - handicap` (nonsense) with real
     `toParAvg` derived from `calculateTotals().toPar` over the same eligible rounds. Renamed
     `deriveScoringAvg` → `deriveScoringStats` (returns `{avg, toParAvg}`); both stats use the
     same eligible set so they are consistent. Display hidden when no eligible rounds.
  3. **Profile card Dynamic Island fix:** `top: 14` → `top: "max(14px, env(safe-area-inset-top))"`.
     Card now clears the notch/Dynamic Island on iPhone 14/15/16 Pro.
  4. **Dead "All" button removed:** no /rounds index page; button had cursor:pointer but no
     onClick — confusing on-device. Removed. Section heading still present.
  5. **Fairways/Greens/Putts row hidden:** removed the 3-stat grid showing three permanent "—"
     values. Per-shot tracking not available yet. `StatBit` helper also removed (now unused).
     Handicap + Scoring avg remain as they fill from real data.
  SHOULD-FIX done:
  6. **Round row touch target:** `minHeight: 44` on each round row button (44pt iOS minimum).
  7. **Bottom safe-area:** `paddingBottom: "env(safe-area-inset-bottom, 16px)"` on the inner
     container so the last block clears the home indicator.
  8. **Owner-is-players[0] comments:** added at both `players[0]` usages in `deriveRecentRows`
     and `deriveScoringStats`, noting single-owner beta assumption and revisit note.
  - Gates: lint 0 errors (src/app/page.tsx), tsc 0 errors, voice-tests 260/260, build OK.
  - NOTICEABLE — fixes are user-visible: Dynamic Island clearance, correct to-par number,
    no fake weather, cleaner stats block.

## 2026-06-27 (wire-profile-identity)
- **Done:** backlog `wire-profile-identity` (P14, NOTICEABLE) — profile masthead (name,
  home course) + handicap index wired to `GET /api/profile/golfer`; editable via
  `PUT /api/profile/golfer` with write-through localStorage cache.
  Key changes:
  - **`types.ts`:** `GolferProfile.name` changed `string` → `string | null` to match the
    backend's `Optional[str]`. Callers that assumed non-null now safely use `?? '—'`.
  - **`api.ts`:** `GolferProfileUpdate.name/handicap/homeCourse` typed as `T | null` to
    allow explicit null (intentional field clear). Comment explains omitted = no-change,
    null = clear.
  - **`storage-api.ts` (null-clear fix — review follow-up):** removed `?? undefined`
    coercion from `saveGolferProfileAsync`. `handicap: profile.handicap ?? undefined` →
    `handicap: profile.handicap` (same for homeCourse). Null now flows as `"handicap":null`
    in the JSON body so the backend can see it in `model_fields_set`.
  - **`backend/app/routes/profile.py` (null-clear fix):** PUT partial-update logic changed
    from `if data.field is not None:` → `if "field" in data.model_fields_set:`. This
    distinguishes "omitted" (no change) from "sent as null" (clear the value). Affects
    name, handicap, homeCourse, clubDistances.
  - **`app/profile/page.tsx` — real data wiring:**
    - Uses `getGolferProfileAsync` / `saveGolferProfileAsync` from `storage-api.ts` in
      a `useEffect` (NOT the `useGolferProfile` hook which calls `useAuth()` and breaks
      Next.js static prerender).
    - `Masthead`: name + home course now show real values from profile (or "—" when
      null/loading). Editable in-place via `<input>` styled with T.serif/T.mono to
      match the yardage-book feel. "Edit" button in masthead header; Save/Cancel replace
      it in edit mode. iOS safe-area top (`max(14px, env(safe-area-inset-top))`) unchanged.
      All buttons minHeight 44px (iOS 44pt touch target). caddyNo/ghin/memberSince
      remain as placeholder mocks (not in GolferProfile type yet).
    - `HandicapModule`: big handicap index number wired to real `profile.handicap`
      (shows "—" when null). Editable in edit mode via decimal `<input>`. Empty state:
      "No handicap set — tap Edit to add one." when null. Trend badge / sparkline /
      low-high / differential still mock stats (wired in wire-profile-stats P16).
    - `IdentityDraft` type: `{ name: string; homeCourse: string; handicap: string }` —
      a string-form draft for all three editable fields, parsed to typed values on save.
    - Validation: handicap parsed as float; empty = null (clear); non-numeric = error
      shown inline above Save button (T.errorInk color, no silent swallow).
    - **Null-clear end-to-end:** clearing handicap/homeCourse to empty and saving now
      sends `{"handicap":null}` (not omitted), backend model_fields_set fires, column
      written to NULL — field is cleared. Round-trip confirmed by code review.
    - Bag / StrokesGained / FairwayFan / ScoringByTee / YearLog / Recent: untouched.
      All still use PP_* mock constants (wire-profile-bag P15 / wire-profile-stats P16).
  - Gates: tsc 0 errors, lint clean (modified files), ruff clean (backend), voice-tests
    260/260 pass, npm run build OK (profile page prerenders as static shell ○).
  - NOTICEABLE — user-visible on TestFlight: profile masthead + handicap show real data;
    owner can tap Edit, set name/home course/handicap, tap Save — persists to the backend.
  - Designer flags: edit inputs are underline-only (yardage-book minimal); edit mode
    spans masthead+handicap simultaneously (single Save); caddyNo card is placeholder
    pending a GolferProfile extension. Mock stats sections (sparkline, trend, SG, bag)
    are still visible alongside real identity data — designer to confirm this is OK
    or flag to hide until wire-profile-stats lands.

## 2026-06-27 (wire-profile-bag)
- **Done:** backlog `wire-profile-bag` (P15, NOTICEABLE) — Bag section in `app/profile/page.tsx`
  replaced from "(Preview) / Coming soon" placeholder to a real, editable club-distances list
  backed by `GolferProfile.clubDistances` (PUT /api/profile/golfer).
  Key changes:
  - **`storage-api.ts`:** new `saveGolferBagAsync(clubDistances)` function — sends ONLY
    `clubDistances` to `api.updateGolferProfile()`; identity fields (name/handicap/homeCourse)
    intentionally omitted. Complementary to `saveGolferProfileAsync` which omits clubDistances.
    Both exploit the backend's `model_fields_set` omit=no-change contract so the two editors
    never clobber each other. Write-through to localStorage (merges into cached profile if
    present). Re-throws API 4xx/5xx; keeps TypeError (network-down) silent.
  - **`app/profile/page.tsx`:**
    - Removed `PP_BAG` mock constant + `BagClub` type.
    - Added `CLUB_CONFIG` (15 entries, camelCase keys matching `GolferProfile.clubDistances`,
      display labels: Driver, 3-wood, 5-wood, Hybrid, 4-iron … LW (60°), Putter). Same keys
      CaddiePanel's `normalizeClubDistances` reads, so real bag feeds caddie yardage suggestions.
    - Replaced old `Bag({ accent })` with `Bag({ accent, profile, loading, onBagSaved })`.
    - View mode: shows only clubs that have a value set (proportional distance bar + yardage,
      accent color for longest club, T.ink opacity 0.7 for others). Empty state when none set:
      "No distances set — tap Edit to add your clubs." (calm T.pencilSoft italic).
    - Edit mode: all 15 clubs shown with `inputMode="numeric"` inputs (minHeight 44px per row
      for iOS 44pt touch target); "yd" label; blank = remove club. Cancel/Save buttons in
      section aside (matching identity editor button style). Save validates range (1–500).
    - Errors surfaced inline in T.errorInk (same pattern as identity editor save-error).
    - `(Preview)` badge removed from the Bag section — it's real now. Other sections
      (StrokesGained, FairwayFan, ScoringByTee, YearLog) remain `preview` as before (P16).
    - Edit button disabled (opacity 0.4) while profile is loading.
    - `ProfilePage` passes `profile` + `onBagSaved={(updated) => setProfile(updated)}` to Bag.
    - `distances` memoised via `useMemo([profile?.clubDistances])` so `startEditing`
      useCallback has a stable dep ref.
  - **Caddie connection:** CaddiePanel's `normalizeClubDistances` maps these same camelCase
    keys to short keys (driver→driver, threeWood→3wood, …) before calling the recommendation
    API. Real bag in the profile → real club suggestions in the caddie.
  - Gates: lint 0 errors (src/), tsc 0 errors, voice-tests 260/260 pass, build OK.
  - NOTICEABLE — user-visible on TestFlight: bag section shows real distances + is editable.

## 2026-06-27 (wire-profile-bag designer follow-up)
- **Done:** designer follow-up fixes for `wire-profile-bag` (one commit on integration/next).
  MUST-FIX:
  1. **Bottom Save/Cancel row (FIXED):** editing 15 club rows (~660px) pushed the header-aside
     Save/Cancel off-screen on iPhone SE/mini. Added a second Cancel + Save row at the BOTTOM
     of the edit-mode div, separated by `1px solid T.hairline`, `justifyContent: flex-end`.
     Also includes the error span (with `flex: 1` so it doesn't crowd the buttons), identical
     button styling to the header pair. Golfers editing SW/LW/Putter can now save without
     scrolling up blind.
  POLISH:
  2. **Bar height 8 → 10** — matches ScoringByTee; more readable in sunlight.
  3. **Legend "Longest" entry** — added accent-color swatch + "Longest" label alongside
     "Distance" in the view-mode legend footer. Existing "Distance" swatch now `opacity: 0.7`
     to match how non-longest bars render.
  4. **Putter caveat** — CLUB_CONFIG label: "Putter" → "Putter (optional)". Hint text
     extended: "Putter distance isn't used for club recommendations."
  5. **Error span maxWidth clamp** — header-aside error span gets `maxWidth:120, overflow:hidden,
     textOverflow:ellipsis, whiteSpace:nowrap`.
  - Gates: lint 0 errors, tsc 0 errors, voice-tests 260/260, build OK.
  - NOTICEABLE — all fixes are user-visible on device.

## 2026-06-27 (wire-profile-identity reviewer/designer follow-up)
- **Done:** reviewer + designer follow-up fixes (one commit on integration/next).
  CORRECTNESS (reviewer):
  A. **Save-failure swallow (FIXED):** `saveGolferProfileAsync` now re-throws on non-network
     errors (4xx/5xx). `TypeError` (offline) stays silent + cache-only; any other error is
     re-thrown so `handleSave`'s catch shows `saveError` and does NOT close edit mode.
  B. **clubDistances clobber (FIXED):** removed `clubDistances` from the PUT body in
     `saveGolferProfileAsync`. Omit = no-change contract (model_fields_set) means the bag
     is never touched by the identity save. Bag wired in P15.
  SHIP-BLOCKERS — honest shell:
  1. Removed fake kicker "№ 77 · Member since 2019".
  2. Removed fake GHIN/caddy card. Identity block is now single-column.
  3. Removed fake trend badge "↓ 0.6 · 90d".
  4. Replaced "Lowest since 2019." with "Post a score to track your trend."
  5. Footer "GHIN · verified" → "Looper · {date}".
  6. PP_RECENT (5 fake rounds) → calm empty state: "No rounds yet — start a round..."
  7. Fake sparkline + Low/High/Differential → "Available after posting scores."
  8. StrokesGained / FairwayFan / Bag / ScoringByTee / YearLog all get `preview` prop
     → Section shows "(Preview)" mono badge. Bag "✎ Edit" → non-interactive "Coming soon".
  POLISH:
  9. Name + home course use `opacity: loading ? 0 : 1` (no layout jump).
  10. Home course edit underline: `T.hairline` → `1.5px solid T.ink` (consistent with name).
  11. "+ Post score" button disabled (opacity 0.4, cursor default, T.hairline border).
  12. "Edit" pill adds `minWidth: 44`.
  CLEANUP: PP_PLAYER / PP_HANDICAP / PP_RECENT constants removed. HandicapSpark removed.
  `accent` removed from Masthead + HandicapModule (genuinely unused after cleanup).
  - Gates: tsc 0 errors, lint 0 errors, ruff clean, voice-tests 260/260, build OK.
  - NOTICEABLE — honest shell: real identity + edit, "(Preview)" on mock sections.

## 2026-06-27 (wire-players-page)
- **Done:** backlog `wire-players-page` (P17, NOTICEABLE) — `app/players/page.tsx` wired to
  `/api/players` (GET/POST/PUT/DELETE); seed path removed; calm empty state; yardage-book
  redesign to match home/profile pattern.
  Key changes:
  - **`storage-api.ts`:** Added 4 player wrapper functions following the established pattern:
    - `getPlayersAsync()` — tries `api.getPlayers()` when authenticated; `console.error` +
      localStorage fallback on API failure; localStorage-only when not authenticated.
    - `createPlayerAsync(data)` — API-authoritative; throws when not authenticated or on API
      error; write-through to localStorage on success via `localCache.saveSavedPlayer()`.
    - `updatePlayerAsync(id, data)` — same pattern as create; write-through on success.
    - `deletePlayerAsync(id)` — API-authoritative; calls `api.deletePlayer(id)` first then
      updates local cache; throws on any API error (lets page roll back optimistic update).
  - **`app/players/page.tsx` — full rewrite:**
    - Removed imports: `getSavedPlayers`, `saveSavedPlayer`, `deleteSavedPlayer`,
      `initializeStorage` from `@/lib/storage`. Page no longer seeds the 11 fake players.
    - Added imports: `getPlayersAsync`, `createPlayerAsync`, `updatePlayerAsync`,
      `deletePlayerAsync` from `@/lib/storage-api`; `T`, `PAPER_NOISE` from tokens.
    - Async `useEffect` load: calls `getPlayersAsync()`, surfaces `loadError` banner on failure.
    - `handleDelete`: optimistic remove from state → `deletePlayerAsync(id)` → rollback on
      error + surface `deleteError` banner. Player re-inserted at top on rollback.
    - `handleSave`: async — calls `updatePlayerAsync` (edit) or `createPlayerAsync` (add);
      reconciles state with server-returned `SavedPlayer` (uses backend-assigned id/timestamps
      for creates). Errors bubble to the modal (modal stays open, shows inline error).
    - `PlayerModal`: `onSave` prop changed to `Promise<void>`; modal manages its own `saving`
      + `error` state; inputs disabled while saving; submit button shows spinner; stays open
      on API error so user can retry or cancel.
    - **Empty state:** "No players yet" / "Add the people you golf with." (exact spec text).
    - **SwipeableRow `confirmMessage`:** passes player name — "Remove {name} from your
      players?" — so the confirm dialog is specific (SwipeableRow already has confirm-on-delete).
    - **Yardage-book redesign:** full conversion from dark-mode Tailwind classes to T.* inline
      styles matching the home/profile pattern: paper background + PAPER_NOISE, ink text,
      hairline borders, T.serif heading, T.mono labels, T.paperDeep inputs. No new deps.
    - **iOS safe-area:** `padding: "max(14px, env(safe-area-inset-top)) 20px 14px"` on header;
      `paddingBottom: "max(80px, calc(80px + env(safe-area-inset-bottom)))"` on shell.
    - **Touch targets:** add button 44×44px; player row `minHeight: 68`; modal Cancel/Save
      buttons `minHeight: 44`. All exceed 44pt iOS minimum.
    - **Error surfacing:** `loadError` banner (paper bg, `T.errorWash` bg, `T.errorInk` text)
      below header; `deleteError` banner below it; modal inline error above form.
  - **Now-unused `storage.ts` exports:** `initializeStorage`, `seedDefaultPlayers`,
    `getDefaultPlayers` are no longer called by the players page. `initializeStorage` is also
    no longer needed since the players page stops seeding. `seedDefaultPlayers` is still
    imported by `settings/page.tsx` (tracked as `settings-cleanup` item P18 — not this PR).
    `getSavedPlayers` / `saveSavedPlayer` / `deleteSavedPlayer` still used by `round/new/page.tsx`
    for the local saved-players fallback (not removed).
  - Gates: lint 0 errors (src/app/players/page.tsx, src/lib/storage-api.ts), tsc 0 errors,
    voice-tests 260/260, npm run build OK (players page renders as ○ static prerender).
  - NOTICEABLE — user-visible on TestFlight: players page shows real owner-scoped players
    from the backend; add/edit/delete persist to the DB; the 11 fake seeded players are gone.
  - Designer flags (resolved in follow-up commit below): SwipeableRow confirm dialog restyled
    to T.* tokens; "Add First Player" empty-state button minHeight:44 added.

## 2026-06-27 (wire-players-page designer follow-up)
- **Done:** designer follow-up fixes for `wire-players-page` (one commit on integration/next).
  MUST-FIX:
  1. **SwipeableRow confirm dialog restyled (FIXED):** replaced all dark Tailwind classes with
     T.* inline styles:
     - Overlay: `bg-black/60 backdrop-blur-sm` → `rgba(26,42,26,0.45)` + `blur(4px)` WebKit.
     - Card: `bg-zinc-900 border-zinc-800` → `background:T.paper, border:1px solid T.hairline`.
     - Heading: `text-white` + no font family → T.serif, `color:T.ink`.
     - Body: `text-zinc-400` → `color:T.pencil`.
     - Cancel: `bg-zinc-800 text-white` → `background:T.paperDeep, color:T.inkSoft`.
     - Delete: `bg-red-600 text-white` → `background:T.errorInk, color:T.paper`.
     - Icon circle: `bg-red-500/20` → `T.errorWash` background.
     - Swipe reveal background: `rgba(239,68,68,*)` (raw red) → `rgba(184,74,58,*)` (T.errorInk tint).
     - Trash icon: `className="text-red-400"` → `style={{ color: T.errorInk }}`.
     - Both dialog buttons: `minHeight:44` (44pt iOS touch target).
     - Dialog enter animation: uses `T.spring` transition.
  SHOULD-FIX:
  2. **"Add First Player" button `minHeight:44` (FIXED):** added to the empty-state primary CTA.
  DEFERRED (noted, not fixed):
  - Swipe direction right-to-delete (iOS convention is left) — separate follow-up.
  - Optional player fields can't be cleared once set (undefined vs null partial-update contract)
    — cross-endpoint fix later (send null + model_fields_set).
  - Gates: lint 0 errors (src/), tsc 0 errors, voice-tests 260/260, build OK.
  - NOTICEABLE — confirm dialog now matches the paper/ink aesthetic of the rest of the app.

## 2026-06-27 (wire-tournament-detail)
- **Done:** backlog `wire-tournament-detail` (P18, NOTICEABLE) — `TournamentPageClient.tsx`
  now fetches real data from `/api/tournaments/{id}` + `/api/rounds` (member rounds) instead
  of the fabricated "Sunday Cup" `tournamentData.ts` constants. `tournamentData.ts` DELETED.
  Key changes:
  - **Deleted:** `frontend/src/components/yardage/tournamentData.ts` — all fabricated
    constants (TOURNAMENT, TPLAYERS, TSTANDINGS, TFEED, TGAMES, TGROUPS, TPlayer, TCourse,
    TStanding, TFeedItem, suffix) removed. No other file imported it.
  - **Data flow:**
    1. `getTournamentAsync(id)` → `GET /api/tournaments/{id}` (owner-scoped, API-authoritative
       with localStorage offline cache fallback per storage-api.ts pattern). Returns Tournament
       with `playerIds`, `roundIds`, `playerNamesById`, `games`, `createdAt`.
    2. `getRoundsAsync()` → `GET /api/rounds` (all owner rounds); filter by `roundIdSet`
       (union with `round.tournamentId === id` as belt-and-suspenders). Sort ascending by
       `createdAt` so Day 1 = earliest round.
    3. Player name resolution: `playerNamesById` (from players table join in backend) takes
       priority; `round.players` provides fallback for guests not in the players table;
       `playerId` as last resort.
    4. `effectivePlayerIds`: if `tournament.playerIds` is empty (pre-player-tracking data),
       union from member round players.
    5. Standings via `computeStandings()`: calls `calculateTotals(r.scores, r.holes, pid)`
       (from `types.ts`) for each player × round. Produces `totalStrokes` and `totalToPar`.
  - **Standings:** two sort modes — "Gross" (totalStrokes asc) and "To Par" (totalToPar asc).
    Dynamic grid columns scale with round count (`34px` per column when >3 rounds, `44px` for
    ≤3). Leader callout (ink-bg card) shows leading player name + score when any scores exist.
  - **TFEED removed:** no real activity-feed data source exists. Removed entirely (same
    decision as wire-home's FEED removal). Noted in code.
  - **Empty/partial states (all calm, on-paper):**
    - No players in tournament → "No players in this tournament yet."
    - Has players but no rounds → "No rounds played yet." (leaderboard + rounds tabs)
    - Has rounds but no scores → "Scores will appear here as you play."
    - No tournament-level games → "No games set up yet."
    - Tournament 404 or not owned → calm serif "Tournament not found." + ← Home button.
  - **UX preserved:** T.* tokens throughout, serif/mono typography, paper/ink palette,
    yardage-book feel. `max(14px, env(safe-area-inset-top))` on masthead. All interactive
    elements ≥ 44pt (`minHeight: 44`). Round strip tappable → `/round/{id}`.
  - **No fabricated data:** `useParams()` reads the real id from the URL; `id === "placeholder"`
    guard skips the API call during static prerender.
  - Gates: lint 0 errors (TournamentPageClient.tsx), tsc 0 errors, voice-tests 260/260,
    npm run build OK (`/tournament/[id]` renders as ● SSG with placeholder).
  - NOTICEABLE — user-visible on TestFlight: tournament detail page shows real data (players,
    standings, games, rounds); no fabricated Sunday Cup data anywhere in the app.
  - Designer flags: leader callout is neutral ("Leading {name}") — not "Your position" since
    there is no identity→player mapping yet. TFEED removed; re-introduce when a real activity
    stream exists. To-par mode uses "E" for even (consistent with home + scoring).

## 2026-06-27 (wire-tournament-detail reviewer + designer follow-up)
- **Done:** reviewer + designer fixes for `wire-tournament-detail` (one commit on integration/next).
  SHIP-BLOCKERS fixed:
  1. **Leaderboard grid with 3+ rounds (FIXED):** replaced CSS grid with overflow-x:auto scroll
     container. Each row is `display:flex` with `position:sticky` on rank (left:0, 28px) and
     player (left:28px, 146px) columns — stay pinned as round columns scroll horizontally.
     Total (52px) is sticky right:0. Fixed row heights LB_HEADER_H=34/LB_ROW_H=52 align both
     panels. Widths: 28+146+40×3+52=346px on 390px device = 3 rounds fit with no scroll;
     4+ rounds scroll. Works cleanly for n=1..6+.
  2. **Mode toggle touch target (FIXED):** `minHeight: 32` → `minHeight: 44` + `display:flex;
     alignItems:center` on toggle buttons.
  SHOULD-FIX fixed:
  3. **Loading skeleton (FIXED):** pulsing masthead skeleton replaces blank paper screen.
     CSS keyframe `lb-skel-pulse` in a `<style>` JSX tag; T.paperDeep placeholder blocks for
     back-button / date / title / three meta columns. No external dep.
  4. **Game format display names (FIXED):** `FORMAT_LABELS` map (16 formats).
     bestBall → "Best Ball", bingoBangoBongo → "Bingo Bango Bongo", etc. Falls back to raw
     `g.format` for any unknown key.
  5. **Tie ranks (FIXED):** `tieRankLabel(sorted, idx, mode)` — counts players with strictly
     better total (betterCount), counts players at same total (sameCount). Returns "T1"/"T2"
     for ties, plain "1"/"2" unique, "—" no scores.
  6. **Upcoming course fallback (FIXED):** `r.courseName || "Course TBD"` in round strip +
     Rounds tab card.
  7. **Leader callout raw rgba (FIXED):** `T.paperFaint` (rgba 244,241,234 @ 0.20) and
     `T.paperMid` (rgba 244,241,234 @ 0.50) added to tokens.ts; both callout usages updated.
  - `EmptyState` extracted as a shared sub-component (de-duped 4 identical inline blocks).
  - Gates: lint 0 (modified files), tsc 0 errors, voice-tests 260/260, build OK.
  - NOTICEABLE — grid no longer breaks at 3 rounds; sticky columns keep names visible on
    scroll; loading skeleton, readable format names, correct tie ranks.

## 2026-06-27 (wire-tournament-new)
- **Done:** backlog `wire-tournament-new` (P19, NOTICEABLE) — tournament creation flow wired
  to the backend; Sunday Cup voice-demo removed; round creation uses server-returned ids.
  Key changes:
  - **`app/tournament/new/page.tsx` — full rewrite (Sunday Cup demo removed):**
    - Removed: entire `PARSED` fabricated-data constant (hardcoded "The Sunday Cup · Vol VII",
      players, courses, dates, stakes), `FULL_UTTERANCE` scripted voice replay, `CARTS`/`CADDIES`
      voice-theater setup, fake transcript `useEffect`, `handleStart → /tournament/sunday-cup-2024`
      hardcoded nav, drag-n-drop cart grouping (groupings UI for an unreachable demo tournament).
    - Replaced with a clean manual form (yardage-book aesthetic, T.* tokens throughout):
      - **Name field:** serif italic `<input>` (required, 80 char max, underline-border,
        `T.errorInk` if touched+empty).
      - **Rounds picker:** 1/2/3/4 chip buttons (44pt height, T.ink background when active).
      - **Field (players) section:** loads real players from `GET /api/players` on mount (falls
        back to localStorage cache on API failure). Each player row shows avatar initial +
        name + handicap; tap to toggle selection (`T.paperDeep` bg when selected, ink avatar
        with "✓" when selected). Shows "Loading players…" placeholder while fetching.
      - **Custom player input:** `<input>` with inline "Add" button (T.ink pill, 32pt);
        Enter key submits. Custom players get `crypto.randomUUID()` ids; stored as
        `{id, name}` pairs; removable with × button. Deduplication against API players +
        existing custom players (case-insensitive).
      - **Validation:** both name and ≥1 player are required. Validation fires on submit
        (`touched` flag). Inline `T.errorInk` hint below each missing field. CTA disabled
        while creating or when invalid.
      - **Submit (`handleCreate`):** calls `createTournament({name, numRounds, playerIds})`
        from `@/lib/api`. Offline (TypeError) → surfaces "No connection" message (no
        offline-create since server-assigned id is needed for round linkage). API 4xx/5xx
        → surfaces error message in `T.errorWash` banner above CTA. On success:
        builds `playerNamesById` map (selected real players + custom names); calls
        `saveTournament({...created, playerNamesById})` to warm the localStorage cache for
        offline reads; navigates to `/tournament/${created.id}` (SERVER-RETURNED id).
    - iOS safe-area: `max(14px, env(safe-area-inset-top))` header,
      `max(26px, env(safe-area-inset-bottom, 26px))` CTA footer. All touch targets ≥44pt.
  - **`tournament/[id]/round/new/NewTournamentRoundClient.tsx` — API-backed wiring:**
    - **Tournament loading:** replaced sync `useMemo(() => getTournament(tournamentId))`
      (localStorage only) with `useEffect → getTournamentAsync(tournamentId)` from
      `storage-api.ts` (API-authoritative, localStorage fallback). Added `tournamentLoading`
      + `tournamentNotFound` states; renders "Loading tournament…" while pending.
    - **Course loading:** replaced `getCourses()` from storage.ts with `apiGetCourses()`
      from `@/lib/api` (falls back to `localGetCourses()` on API error via try/catch).
    - **Round creation:** replaced `saveRound(round) + addRoundToTournament(...)` (both
      localStorage-only) with `createRound({...roundData, tournamentId})` from `@/lib/api`
      (POST /api/rounds). Backend automatically appends the new round id to
      `tournament.round_ids` (detail page picks it up on next load). Write-through to
      localStorage via `localSaveRound(created)`. Navigates to `/round/${created.id}`
      (SERVER-RETURNED id, not a client-side UUID).
    - Added `creating` + `createError` states; error rendered as red banner above CTA button;
      button shows "Creating…" while in flight; disabled while creating.
    - `handleStartRound` early-returns on `!creating` guard (race-safe).
    - `autoGenerateGroups` tee-time math fixed: removed mutating `baseTime = new Date(...)` inside
      loop; now computes offset via `new Date(base.getTime() + i/playersPerGroup * 10 * 60000)`.
  - Gates: `npx eslint src/app/tournament/ --ext .tsx,.ts` 0 errors, `tsc --noEmit` 0 errors,
    voice-tests 260/260 pass, `npm run build` OK (tournament/new → ○ static, tournament/[id]/round/new → ● SSG).
  - NOTICEABLE — user-visible on TestFlight: creating a tournament now persists to the backend
    and navigates to the real server-assigned id; adding a round to a tournament creates via
    POST /api/rounds with tournamentId linkage (detail page standings update after play).
  - No fabricated data remains in either file.
  - Designer flags: NewTournamentRoundClient retains the existing dark Tailwind styling
    (`.card`, `.btn`, emerald classes) — consistent with its current state; a full redesign
    to T.* tokens is a separate polish item. The new tournament/new form uses T.* tokens
    throughout and matches the wire-round-new / profile page aesthetic.

## 2026-06-27 (wire-tournament-new reviewer + designer follow-up fixes)
- **Done:** reviewer + designer follow-up fixes for `wire-tournament-new` (one commit on integration/next).
  BLOCKER 1 fixed (custom player names):
  - Original implementation used `crypto.randomUUID()` ids for custom players directly in
    `playerIds`. Backend `_build_full_tournament` derives `playerNamesById` via a JOIN to the
    `players` table — client-side UUIDs not in that table → names resolve to "Unknown".
  - Fix: `handleCreate` now loops through `customPlayers`, calls `createPlayer({name})` for each
    (POST /api/players), then `saveSavedPlayer(saved)` (write-through to localStorage cache).
    Uses server-returned ids in `allPlayerIds`. Builds `playerNamesById` from server-returned
    `SavedPlayer` objects for the local cache. Custom players are now real rows in the DB —
    backend JOIN resolves their names, and they appear on the Players page.
  BLOCKER 2 fixed (NewTournamentRoundClient full yardage-book restyle):
  - Removed all 33 dark Tailwind class refs (text-zinc-100, bg-white/5, ring-emerald-500/50,
    emerald, zinc-*). Full rewrite to T.* inline styles throughout.
  - Outer shell: `PAPER_NOISE` over `T.paper`, T.* tokens throughout.
  - Header: "Add · Round" mono kicker + "Set up a round." T.serif italic headline (matches
    tournament/new / round/new patterns). Back button links to tournament detail.
  - Loading / not-found: paper shell, T.pencilSoft text, back button.
  - Course/tee selects: `background:T.paperDeep, border:1px solid T.hairline, color:T.ink`.
  - Tournament info card: T.paperDeep bg, T.ink/T.pencilSoft labels, T.serif italic name.
  - Auto-Group button: `border:1px solid T.hairline, color:T.pencil` (secondary style).
  - DnD `SortablePlayer`: T.paper bg, T.paperDeep on hover/drag, T.ink text, DEFAULT_ACCENT
    ring (not emerald). `DraggedPlayer` overlay: ink bg, T.paper text.
  - Drop zones: `border:1px dashed T.hairline, background:T.paper, minHeight:44`.
  - Unassigned section: `border:T.warningInk40, background:T.warningWash, color:T.warningInk`.
  - Error banner: `background:T.errorWash, border:T.errorInk30, color:T.errorInk`.
  - CTA: text "Start Round →" (mono arrow, no Flag icon); T.ink pill, T.paper text; safe-area
    bottom `max(26px, env(safe-area-inset-bottom, 26px))`. minHeight 52.
  - All touch targets ≥44pt throughout.
  - Safe-area top: `max(14px, env(safe-area-inset-top))` on header.
  BLOCKER 3 fixed (Add button touch target):
  - "Add" button in tournament/new: `minHeight: 32` → `minHeight: 44`.
  POLISH (both files):
  - Placeholder: "Club Championship" (was "Sunday Cup").
  - Handicap display: `+{p.handicap}` → `{p.handicap > 0 ? `+${p.handicap}` : p.handicap}`.
  DEFERRED (noted, not fixed):
  - Legacy non-UUID localStorage tournament rounds linkage gap (rounds from before server-UUIDs).
  - Gates: `npx eslint src/app/tournament/ --ext .tsx,.ts` 0 errors, `tsc --noEmit` 0 errors,
    voice-tests 260/260 pass.
  - NOTICEABLE — custom players now persist to the DB and resolve their names; round-setup screen
    is fully paper/ink aesthetic (no dark Tailwind).

## 2026-06-27 (settings-cleanup)
- **Done:** backlog `settings-cleanup` (P20, NOTICEABLE) — removed "Load Sample Players" demo
  action from `app/settings/page.tsx`; updated "Clear Data" to be honest about scope; restyled
  page from dark Tailwind to yardage-book paper/ink palette.
  Key changes:
  - **`app/settings/page.tsx`:**
    - Removed the entire "Sample Players" section (card, button, `seedDefaultPlayers()` call,
      `Users` lucide import, `import { seedDefaultPlayers } from '@/lib/storage'`). Players are
      now real and backend-backed — seeding 11 fabricated names is incorrect.
    - "Data" section renamed to "Local Cache"; description updated to be honest: "Clear locally
      cached data (offline rounds, app state). Your backend data — players and profile — is not
      affected." Confirm dialog also updated with clear scope language.
    - Button label changed from "Clear All Data" → "Clear Local Cache"; behavior unchanged
      (`localStorage.clear()` is correct — the backend is authoritative).
    - Restyled from dark Tailwind to yardage-book palette:
      - `text-zinc-400` → `style={{ color: 'var(--pencil)' }}`
      - `border-t border-white/10` → `style={{ borderTop: '1px solid var(--hairline)' }}`
      - `bg-emerald-500/10 text-emerald-200` (removed with Sample Players section)
      - `bg-red-500/10 text-red-200` → `background: rgba(184,74,58,0.08), color: #b84a3a,
        border: rgba(184,74,58,0.22)` (T.errorInk/T.errorWash tints)
      - `minHeight: 44` on the destructive button (iOS 44pt touch target)
      - `paddingBottom: max(96px, ...)` on main (iOS safe-area inset)
    - The `.app-shell`, `.app-header`, `.card`, `.btn` shim classes kept (already paper-palette
      in globals.css; no dark overrides remain).
  - **`lib/storage.ts`:**
    - Removed `initializeStorage()` (exported, but had zero callers in `frontend/src/` — was
      previously used by the old home page and players page before those were wired to the API).
    - Removed `seedDefaultPlayers()` (was only called by settings page — now removed).
    - Removed `getDefaultPlayers()` (private, only used by the two functions above).
    - Kept `getDefaultCourses()` — still used by `getCourses()` as an offline fallback when
      no courses are in localStorage (not a seeding action; a safe fallback).
    - Kept all other player CRUD functions (`getSavedPlayers`, `saveSavedPlayer`, etc.) —
      still used by round/new as a localStorage cache layer.
  - Gates: `npx eslint src/app/settings/page.tsx src/lib/storage.ts` 0 errors, `tsc --noEmit` 0
    errors, voice-tests 260/260 pass, npm run build OK.
  - NOTICEABLE — user-visible on TestFlight: Settings page shows correct Local Cache label and
    honest description; "Load Sample Players" button is gone.
  - Designer: page is now fully on the paper/ink palette. The `.btn` shim class still uses
    dark Tailwind's `rounded-full` utility but `.btn` itself is paper-palette in globals.css —
    consistent with the rest of the legacy shim pages. If the designer wants full T.* inline
    conversion (matching players/profile pages), that can be a follow-up polish pass.

## 2026-06-27 (games-matchplay-nassau)
- **Done:** backlog `games-matchplay-nassau` (P21, NOTICEABLE) — real hole-by-hole match-play
  Nassau implemented in `lib/games.ts`; stub notes removed from UI; tests updated.
  Key changes:
  - **Algorithm (gross scores, no handicap — consistent with existing stroke-mode Nassau):**
    - New `NassauMatchSegment` interface: `holesPlayed`, `matchDiff`, `statusLabel`, `leaderId`,
      `closedAt`, `closed`.
    - `NassauResults` extended with optional `front9Match?/back9Match?/overallMatch?` fields —
      backward-compatible (undefined in stroke mode; populated in match mode).
    - `computeMatchSeg(startHole, endHole)` inner function: iterates holes in the segment;
      updates diff only when BOTH competitors have a score (skips unscored holes — prevents
      mid-round false-close); tracks `holesPlayed`, `diffAtClose` (frozen at moment of close);
      close fires when `|diff| > segmentLength − holesPlayed` (remaining playable holes).
    - statusLabel: "—" (no scores), "AS" (tied), "N UP" (in progress), "N & M" (closed with
      M holes remaining), "N up" (closed on the last hole exactly).
    - Team scope: best-ball per hole (same as stroke-mode team scope).
    - `front9WinnerId/back9WinnerId/overallWinnerId`: in match mode, set to `leaderId` from
      each segment (null = AS = no leader yet). Stroke mode unchanged.
  - **UI changes (3 files):**
    - `LeaderboardSheet.tsx` Nassau component: removed "coming soon — showing stroke totals"
      note. In match mode, each segment's `note` in the winner grid shows the `statusLabel`
      (e.g. "5 & 4", "AS", "3 UP") instead of "Thru N". "Running totals" stroke table hidden
      in match mode (not meaningful for match play).
    - `GameResults.tsx` Nassau section: removed "Match-play Nassau is stubbed; using stroke
      totals" note. Header changed from "Winners (stroke totals)" to "Winners" (always).
      Added "Match status" block for match mode (segment label + statusLabel + leader name).
      "Stroke totals" block shown only in stroke mode (label updated to reflect this).
    - `GameLeaderboards.tsx` Nassau section: added match-play status grid (F9/B9/18 +
      statusLabel) below the winner grid in match mode. Stroke totals row hidden in match mode.
  - **Tests (`games.test.ts`):**
    - Old "STUB BEHAVIOR" test (`falls back to stroke totals when mode=match`) REPLACED with
      7 focused match-play tests (stub → real behavior):
      1. p1 wins every hole → front9 closes early "5 & 4" (closedAt=5, diffAtClose=5).
      2. Alternating hole wins → F9 ends AS (closed=false, diff=0, statusLabel='AS').
      3. Partial round (3 holes) → in-progress "3 UP", back9 "—", closed=false.
      4. Overall closes at hole 10 ("10 & 8").
      5. No scores → all "—", all winnerIds null.
      6. Team scope: best-ball per hole → tA wins → front9Match.closed=true.
      7. Stroke mode unchanged → front9Match undefined (no match data).
  - **Bug found + fixed (algorithm correctness):** initial algorithm used `endHole − h` for
    "remaining holes" — this fired the close-check on UNSCORED holes (e.g. 3 up thru 3,
    holes 4-7 unscored → falsely closed at h=7 when endHole-h=2 < 3). Fixed by:
    (a) close-check only on scored holes; (b) remaining = segmentLength − holesPlayed; (c)
    diffAtClose frozen at closure so statusLabel is "5 & 4" not "9 & 4".
  - **Gross/net decision:** gross scores only (consistent with existing stroke-mode Nassau;
    `GameSettings.handicapped` is never used in any format — deferred for a future item).
  - Gates: tsc 0 errors (strict), lint 0 errors (src/), voice-tests 260/260, npm test 236/236
    pass (7 new match-play Nassau tests; old stub test replaced), npm run build OK.
  - NOTICEABLE — Nassau tab in LeaderboardSheet now shows real match-play status (e.g. "5 & 4",
    "AS", "3 UP") when mode=match; no more "coming soon" note; GameResults + GameLeaderboards
    also updated.
  - Designer flag: match-play status in the winner grid replaces "Thru N" in match mode —
    confirm the `statusLabel` text ("5 & 4", "AS", "3 UP") fits the yardage-book voice; the
    existing 3-column winner grid layout is reused unchanged.

## 2026-06-27 (voice-parser-edge-bugs)
- **Done:** backlog `voice-parser-edge-bugs` (P23, NOTICEABLE) — two correctness bugs fixed
  in `frontend/src/lib/voice/parseVoiceScores.ts`; two new test cases added to the unit suite.
  Bugs (found by `test-voice-pipeline`):
  1. **"for" → 4 missing from regex alternations:** `WORD_TO_NUM` maps `for: 4` but both the
     first-pass regex (line 251) and second-pass regex (line 282) listed `four|fore|ford` with
     no `for`. "Justin with a for" produced no score.
     Fix: added `for` after `ford` in both regex alternations → `four|fore|ford|for`.
     `fore`/`ford`/`four` remain first in both lists; `\b` word-boundary in the second-pass
     and end-of-token context in the first-pass prevent any cross-matching.
  2. **"everybody dbl bogey" → par+1 instead of par+2:** the everyone-pattern regex (line 233)
     correctly matches `dbl bogey` in its alternation, but the value-selector (line 237) checked
     only `t.includes("double")` — false for "dbl" — and fell through to `t.includes("bogey")` →
     par+1. The individual-player second-pass (line 278) already handled `dbl` correctly.
     Fix: changed `t.includes("double")` → `t.includes("double") || t.includes("dbl")` in the
     everyone-pattern block only (line 237).
  Test additions in `parseVoiceScores.test.ts` (2 new tests; 0 existing tests changed):
  - Section 1: `'for → 4 via "with a for"'` — asserts `Justin with a for` → score 4.
  - Section 4: `'"everybody dbl bogey" → all get par + 2 (dbl abbreviation)'` — asserts all
    players get par+2.
  Sanity confirmed: `fore → 4 via "with a fore"`, `ford → 4 via "made a ford"`,
  `four → 4 via "shot a four"` all still pass; "everybody double bogey" and "everybody double"
  still pass; no collision-guard tests affected.
  Gates: tsc 0 errors, voice-tests **260/260** pass, npm test **238/238** pass (236 prior + 2 new),
  npm run build OK. Lint warnings are all pre-existing Capacitor build-artifact files (not in src/).
  NOTICEABLE — any golfer who says "with a for" or "everybody dbl bogey" now gets the correct
  score parsed (was: no score / wrong score).

## 2026-06-27 (restyle-game-result-screens)
- **Done:** backlog `restyle-game-result-screens` (P24, NOTICEABLE) — full yardage-book restyle
  of `frontend/src/components/GameResults.tsx` and `frontend/src/components/GameLeaderboards.tsx`.
  Both files were entirely dark-mode SaaS (zinc gradients, emerald/amber rank circles, `text-white`,
  `bg-gradient-to-b from-zinc-800/80`, lucide Trophy) — a NORTHSTAR violation.
  Key changes per file:
  **GameResults.tsx:**
  - Removed `const box` / `const boxSubtle` Tailwind shorthand constants (dark backgrounds).
  - All format sections (skins, bestBall, nassau, threePoint, stableford, matchPlay, wolf, fallback)
    converted from Tailwind classes to inline T.* styles: `T.paper` card backgrounds, `T.hairline`/
    `T.hairlineSoft` borders, `T.ink`/`T.pencil`/`T.pencilSoft` text, `T.serif`/`T.sans`/`T.mono`
    font families, `T.accent` for leader callouts (was `text-emerald-300`), `T.warningInk` for
    wolf "editing disabled" note (was `text-amber-200`).
  - `<details>/<summary>` expanders restyled: T.mono uppercase summary labels, T.paper card wrapper.
  - Tables (bestBall/threePoint hole-by-hole): `border-white/10`/`divide-white/6` → T.hairline/
    T.hairlineSoft inline borders on `<tr>`.
  - Wolf interactive buttons: lone wolf selected state → accent-tinted (`rgba(58,74,138,0.07)`)
    border/text/bg; unselected → transparent/T.hairline; select dropdown → T.paperDeep;
    clear button → T.paperDeep/T.hairline. All ≥44pt minHeight.
  - Zero logic/props/computed-value changes.
  **GameLeaderboards.tsx:**
  - Removed `import { Trophy } from 'lucide-react'` — replaced with typographic header (mono
    "Game standings" kicker + serif italic "Leaderboards" display text; no icon).
  - Three module-level items extracted: `cardStyle` (T.paper card, T.hairline border),
    `RankCircle` component (T.serif italic position number in hairline-bordered circle; leader
    gets T.accent border+color vs T.hairline+T.pencil), `CardHeader` component (serif game name
    + mono bet kicker).
  - All format sections (skins, nassau, bestBall, threePoint, stableford, matchPlay, wolf, stub)
    converted from `rounded-2xl bg-gradient-to-b from-zinc-800/80 to-zinc-900/80 border border-zinc-700/50`
    → T.paper card; row leader highlights `rgba(26,42,26,0.03)` (was `bg-emerald-500/5`);
    scores T.serif ink (was `text-emerald-400`/`text-zinc-400`); row dividers T.hairlineSoft
    (was `divide-zinc-800/50`).
  - Skins carrying pot: removed 🔥 emoji; replaced with T.warningInk mono uppercase text.
  - Nassau winners grid, match-status cells: T.paperDeep/T.hairlineSoft cells (was `bg-zinc-800/50`).
  - ThreePoint: T.serif 44px score (was `text-emerald-400`/`text-zinc-400` at `text-4xl`);
    T.serif italic "vs" + T.hairline divider line (was `text-2xl text-zinc-600`).
  - Match Play: T.ink for leading player, T.pencilSoft for trailing (was `text-emerald-400`
    vs `text-zinc-300`). No logic change.
  - Wolf winnings negative: T.errorInk (was `text-red-400`).
  - Zero logic/props/computed-value changes.
  **Grep confirmation:** `zinc|emerald|text-white|bg-white/|lucide|amber|from-zinc` → 0 matches in both files.
  Gates: lint 0 errors (src/ files), tsc 0 errors, voice-tests 260/260, npm test 238/238, build OK.
  NOTICEABLE — user-visible on TestFlight: GamesPanel detail view + any screen rendering
  GameLeaderboards now shows the paper/ink yardage-book aesthetic instead of the dark SaaS chrome.
  Designer flags:
  - `GamesPanel.tsx` and `RoundSummary.tsx` (the parents that embed these components) still use
    dark Tailwind styling — they are not in scope for this item but will look inconsistent on-device
    until restyled (separate follow-up items).
  - Wolf interactive buttons use `rgba(58,74,138,0.07)` accent fill for selected state — designer
    should verify this reads clearly against T.paper in sunlight.
  - `<details>/<summary>` expanders use the browser's default disclosure triangle — a future polish
    pass could replace with a custom chevron or typographic indicator.

## 2026-06-27 (hotfix — voice 401 + global safe-area)
- **Done:** Two owner-reported TestFlight bugs fixed in one commit.

  **BUG 1 — Voice 401 "Missing Authorization: Bearer" (Clerk hydration race):**
  - Root confirmed: `getAuthToken()` in `frontend/src/lib/api.ts` accessed
    `window.Clerk.session` directly. In a Capacitor webview, native-view
    transitions can fire authed API calls (e.g. voice transcribe) before
    `window.Clerk.loaded` is true — so `.session` is null even though the user
    IS signed in, producing a no-auth header and a backend 401.
  - Fix: Hardened `getAuthToken()` to await `clerk.load()` (idempotent — no-op
    when already loaded) before reading `.session`, with a 4 s `Promise.race`
    timeout. If Clerk fails to load within 4 s, `console.error` fires and the
    request proceeds unauthenticated (observable in DevTools). Normal
    unauthenticated state (`!clerk.session` after loading) is silent, no log spam.
    This affects ALL authed calls via `fetchAPI` and `authHeaders`, not just voice.
  - Honest caveat: the root cause is a timing race specific to the Capacitor
    webview boot sequence; this fix closes the window significantly. Confirmation
    that the 401 is gone requires a device build (TestFlight). If the bug persists
    after this fix, the next step is device logs to see whether `clerk.loaded`
    ever becomes true in the affected window.

  **BUG 2 — Content jammed under Dynamic Island / status bar (missing viewportFit):**
  - Root confirmed: `frontend/src/app/layout.tsx` viewport export was missing
    `viewportFit: "cover"`. Without it, iOS resolves `env(safe-area-inset-*)` to 0
    for all CSS, so every screen's `max(14px, env(safe-area-inset-top))` collapsed
    to 14px — not enough to clear a Dynamic Island (~59px) or standard notch (~44px).
  - Fix 1: Added `viewportFit: "cover"` to the viewport export in `layout.tsx`.
    All screens that already use `env(safe-area-inset-top)` in their headers
    (home, tee-time, round, players, profile, VoiceRoundSetup, tournament, etc.)
    will NOW receive the real inset and clear the status bar correctly — no
    additional per-screen changes needed for those paths.
  - Fix 2: Added `padding-top: env(safe-area-inset-top)` to the `.app-header`
    legacy shim class in `globals.css`. This class is used by `settings/page.tsx`
    and `CameraCapture.tsx` — both now clear the status bar.
  - Deliberately NOT added top padding to `body` in the `@supports` block — that
    would double-count against every screen that already handles inset in its own
    header container.
  - NOTICEABLE — user-visible on every screen on iPhone with a notch/Dynamic Island.
  - Designer flag: with `viewportFit:cover` active, screens that already used
    `env(safe-area-inset-top)` will now get the real inset (44-59px) instead of
    14px. Visual audit across all main screens recommended before next TestFlight.

  Gates: tsc 0 errors, voice-tests 260/260, vitest 238/238, build OK.

## 2026-06-27 (restyle-dark-components-sweep P24.5 — scoring-entry batch)
- **Done:** `ScoreGrid.tsx` + `HoleScoreModal.tsx` restyled from dark-mode Tailwind to the
  yardage-book T.* token system. VISUAL-ONLY — zero logic/prop/callback changes.
  Key changes (ScoreGrid.tsx):
  - Removed `lucide-react` import (Mic/MicOff/Loader2/Users); replaced with inline SVG helpers
    (MicIcon, MicOffIcon, SpinnerIcon) — no third-party icon dep.
  - `GROUP_COLORS` retyped from Tailwind class strings to raw color values using T.* tokens +
    warm ink palette matching `PLAYER_COLORS` in RoundPageClient. All group header / row /
    badge styles converted to `style={}` inline.
  - Local `scoreColor()` helper returns T.eagle/T.flag/T.par/T.bogey/T.double inline instead
    of dark-mode Tailwind `getScoreClass()`.
  - Score indicators (birdie circle, bogey square, etc.) border colors now use T.eagle, T.flag,
    T.bogey, T.double, T.pencilSoft — no more yellow/red/sky/blue/indigo.
  - Selected cell: cobalt `rgba(58,74,138,0.08)` + cobalt shadow; underline `${T.accent}B0`
    (replaces emerald).
  - Voice bar: T.paperDeep bg, T.hairline border, T.accent mic button (cobalt) / T.errorInk
    stop (replaces zinc/emerald dark chrome).
  - Pending scores: cobalt-tinted bg (replaces emerald-900/30).
  - Number pad (fixed bottom): T.paper bg, T.hairline border, T.serif number buttons,
    T.errorWash clear button; iOS safe-area bottom padding.
  - 44pt (`minHeight: 44`) on all score cells and number-pad buttons.
  - Totals section: T.flag/T.bogey/T.par for toPar color (replaces red-300/sky-300/emerald-300).
  Key changes (HoleScoreModal.tsx):
  - Removed `lucide-react` import; replaced X/ChevronLeft/ChevronRight with `×`/`‹`/`›` text.
  - Overlay: `rgba(26,42,26,0.45)` ink-tinted (replaces bg-black/70 backdrop-blur-sm).
  - Sheet layout: converted from centered dialog to proper bottom sheet (fixed bottom-0,
    slide-from-bottom animation via T.springSoft, rounded top corners 28px, drag handle,
    safe-area bottom padding).
  - Nav buttons: T.hairline border, T.ink/T.pencilSoft text, `minWidth/minHeight: 44`.
  - Hole title: T.serif italic + T.mono kicker (replaces text-white/text-zinc-400).
  - ScoreCell: T.paperDeep background + T.hairline 2px border (replaces zinc-800/80);
    drag active → `rgba(58,74,138,0.08)` cobalt wash (replaces emerald-500/20).
  - Score number: T.serif 42px with inline `getScoreInkColor()` → T.eagle/T.flag/T.par/
    T.bogey/T.double (replaces Tailwind dark-mode color classes).
  - +/- buttons: `minWidth/minHeight: 44` (was 32px w-8 h-8); T.paper bg, T.hairline
    border, T.pencil text, T.serif font.
  - Quick actions: "All Par" → cobalt `rgba(58,74,138,0.08)` / T.accent text; "Done" →
    T.paperDeep / T.ink.
  - Hole dots: T.accent for active (cobalt), T.hairline for inactive (replaces emerald-400/
    zinc-600); hint text → T.mono / T.pencilSoft.
  Score color tokens reused: T.eagle (≤-2), T.flag/T.birdie (-1, birdie terracotta),
  T.par (0, ink), T.bogey (+1), T.double (+2), T.pencilSoft (+3).
  Touch targets: 44pt minimum on all interactive scoring controls (critical on-course UX).
  Grep clean: zero `zinc|emerald|text-white|bg-white/|lucide|amber|from-zinc` in both files.
  Gates: tsc 0 errors, voice-tests 260/260, vitest 238/238, npm run build OK.
  NOTICEABLE — both surfaces are visible every time a score is entered during a live round.
  Designer flags:
  - HoleScoreModal is now a bottom sheet (was centered dialog); swipe-to-dismiss is not
    wired — only backdrop-tap dismisses. Designer should confirm this feels correct.
  - ScoreGrid sits inside the old `/round/[id]` page (pre-yardage-book route). If the owner
    is primarily on the new RoundPageClient (yardage route), ScoreGrid may not be visible on
    TestFlight — confirm with eng-lead which route is the live scoring surface.

## 2026-06-27 (fix-capacitor-auth-401)
- **Done:** URGENT hotfix — native Capacitor/iOS auth 401 on every authenticated call.
  Root: `window.Clerk.session` never hydrates on the `capacitor://localhost` origin, so
  `getAuthToken()` returned null → no Authorization header → backend 401. Prior `clerk.load()`
  wait didn't help, confirming `window.Clerk` is not a reliable handle on this origin.
  Fix: hook-based token getter via `useAuth()` from `@clerk/clerk-react` (the supported API).
  Key changes:
  - **NEW `frontend/src/lib/auth-token.ts`:** module-level singleton. Exports `setTokenGetter`
    (called by ClerkTokenBridge to register the hook's `getToken`), `getTokenViaClerk` (called
    by api.ts; polls up to 3s for first-render race), `getAuthDiagnostics` (returns `isLoaded`,
    `isSignedIn`, `getterRegistered` snapshot for diagnostic messages).
  - **NEW `frontend/src/components/ClerkTokenBridge.tsx`:** client component inside
    `<ClerkProvider>`. Uses `useAuth()` and registers its `getToken` into the singleton on every
    auth-state change. Cleanup on unmount. Renders no UI.
  - **`frontend/src/components/AuthProvider.tsx`:** mounts `<ClerkTokenBridge />` inside
    `<ClerkProvider>` (only when Clerk is configured).
  - **`frontend/src/lib/api.ts`:** `getAuthToken()` reworked — (1) primary: `getTokenViaClerk(3s)`
    hook-based path; (2) fallback: `window.Clerk` with load-wait (kept as belt-and-suspenders);
    (3) diagnostic `console.error` if signed-in but no token from either path. CLERK_ENABLED
    guard skips the wait when Clerk is not configured (avoids 3s penalty when no publishableKey).
  - **`frontend/src/lib/voice/deepgram.ts`:** on HTTP 401, throws an enriched error with the
    auth-state snapshot: `"Transcribe 401 (no auth token) — isLoaded:true isSignedIn:true
    getterReg:false | Missing Authorization: Bearer"`. This appears verbatim in the VoiceRoundSetup
    error box so the owner can read the exact auth state from a screenshot.
  Honest assessment (code fix vs Clerk config):
  - The hook-based path is the correct supported Clerk API and should work regardless of
    `window.Clerk` availability. If the code fix alone is sufficient depends on whether Clerk's
    DEV instance (pk_test_*) allows sessions to be established from the `capacitor://localhost`
    origin. DEV instances often restrict origins — if sessions still don't establish, the owner
    will need to:
    1. Add `capacitor://localhost` to Clerk dashboard → Configure → Domains (allowed origins).
       OR: switch to a production instance (pk_live_*) which has more permissive origin handling.
    2. Alternatively, configure Capacitor's `iosScheme: "https"` with a custom domain so the
       webview origin becomes `https://app.looper.golf` (or similar), which Clerk will accept.
    The diagnostic in the 401 error ("getterReg:false" vs "getterReg:true") tells the owner
    whether (a) the hook getter was never registered (deeper issue — ClerkProvider not mounting
    or unmounting early) or (b) the getter was registered but `getToken()` returned null anyway
    (Clerk refusing to issue a token for this origin — owner-side Clerk config fix required).
  Gates: tsc 0 errors (strict), voice-tests 260/260, npm test 238/238, npm run build OK.
  NOTICEABLE — this is a functional regression fix; voice and all authed data calls should
  now authenticate correctly on the native iOS build. The diagnostic also helps diagnose
  if the code fix alone is insufficient.
