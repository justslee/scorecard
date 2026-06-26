# Spec — B-Phase: native-ready frontend (route relocation → static export → Capacitor)

**Goal:** turn the Next.js web app into a **static client** wrapped natively
(Capacitor → iOS → TestFlight), talking only to the owner-gated FastAPI backend at
`https://api.looperapp.org`. **Portable** — runnable on any Mac with the repo + Node/uv +
(for the native step) Xcode 26.

**Already done (merged):** OCR moved server-side (#25), caddie client authenticated (#26),
dead browser `apiKey` removed (#27). This spec covers what's LEFT. Drive it **supervised**
— it's verification-heavy (response-shape parity against the live backend), unlike the
cleaner backlog items the autonomous loop handles. Land it as small PRs, each passing the
gates; majors run `/security-review`. Always follow `NORTHSTAR.md`.

## B1 — Relocate the remaining Next.js API routes to the backend
A static build can't run server routes, and secrets must stay server-side. For each
`frontend/src/app/api/*` route: repoint the caller to the backend through the authed
`fetchAPI` (`frontend/src/lib/api.ts`, absolute base `NEXT_PUBLIC_API_URL` + Clerk Bearer),
**verify the response shape matches what the UI expects**, then delete the Next route.

| Next.js route | Target | Notes |
|---|---|---|
| `parse-voice`, `parse-voice-scores`, `parse-round-setup` | backend `voice_advanced.py` / `voice.py` (exist) | `voice-parser.ts` sends its own `systemPrompt`, so the backend returns the same shape — repoint `voice-parser.ts`, `VoiceRoundSetup.tsx`, `ScoreGrid.tsx` to `${NEXT_PUBLIC_API_URL}/api/voice/...` via `fetchAPI`. Verify a parse round-trips. |
| `courses/search`, `courses/search-osm`, `courses/nearby` | backend `course_search.py` (exist, ~1:1) | repoint `golf-api.ts` (drop relative `/api/...`, route through `fetchAPI`), delete Next routes. |
| `courses`, `courses/[id]` (Supabase) | **new** backend `/api/courses/mapped` over **RDS** | port `frontend/src/lib/courses/storage.ts` into a backend service using the RDS session (`backend/app/db/`); delete `frontend/src/lib/supabase.ts` + all `NEXT_PUBLIC_SUPABASE_*`. |
| `tee-times` (mock) | backend stub (or client lib) | port the seeded generator; the real version is `specs/tee-time-finder.md`. |

## B3 — Static export
- `frontend/next.config.ts`: add `output: 'export'` + `images: { unoptimized: true }`,
  **remove** the now-dead `rewrites()` block.
- Add `generateStaticParams()` shims to `round/[id]` + `tournament/[id]` (return a
  placeholder id — they already render client-side from localStorage/backend).
- Delete the `frontend/src/app/api/**` route files.
- **Verify:** `cd frontend && npm run build` → produces `out/` with no server-route errors;
  `npm run lint && npx tsc --noEmit && npx tsx voice-tests/runner.ts --smoke` all pass.

## C — Capacitor wrap  *(needs a Mac with Xcode 26)*
- `cd frontend && npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/camera @capacitor/geolocation`
- `frontend/capacitor.config.ts`: `appId: "com.looperapp.app"`, `appName: "Looper"`,
  `webDir: "out"`, `server: { iosScheme: "capacitor" }` (WebView origin `capacitor://localhost`
  — already in the backend CORS allow-list).
- `npm run build && npx cap add ios && npx cap sync ios` → generates `frontend/ios/App/App.xcworkspace`.
- Info.plist usage strings: `NSCameraUsageDescription` (OCR), `NSMicrophoneUsageDescription`
  (voice), `NSLocationWhenInUseUsageDescription` (caddie).
- Generate 1024² PNG app icons (only `icon-192.svg` exists today).
- Then the **owner** does Xcode signing + the Xcode Cloud workflow → TestFlight (steps 5–9).

## Verify against the LIVE backend
- `curl https://api.looperapp.org/health` → `{"status":"ok"}` (after the secret + schema are live on the EC2).
- Serve `out/` (or the TestFlight build): with an owner Clerk token, voice setup / scoring /
  caddie / course search all work; without a token → **403**.
- Bundle secret-scan: `grep -rE 'sk-ant|sk-proj|DEEPGRAM|GOLF_API|service_role' frontend/out` → empty.

## PR sequence
1. Relocate voice + golf-api callers (delete those Next routes).
2. Course CRUD over RDS (`/api/courses/mapped`) + drop Supabase from the client.
3. Static export (`output: 'export'`, shims, delete remaining `api/**`).
4. Capacitor wrap.
