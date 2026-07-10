# The omnipresent Caddie orb — one voice invocation, context-aware, everywhere

**Owner directive (2026-07-10, top priority — "the CRUX of this app"):** Remove the orb from the center of the nav island. One omnipresent orb, same location on every relevant page, showing a **caddie identity, not a mic**. It understands the task at hand per page: tee-time → parse and dispatch the search; round/tournament setup → voice-driven setup (wire the stranded tournament parse layer); My Card → stats coaching Q&A. The round page's floating pill stays as-is.

**Standing rules that survive:** one standardized voice invocation, never bespoke mic buttons (placement changes; the single-invocation principle does not). NORTHSTAR: quiet, voice-first, yardage-book. No fake data — the caddie cites real numbers or says it doesn't have them. Low-confidence parses get honest confirm UX, never silent wrong action.

## 0. What exists (build ON it — verified in-repo)

- **Center-nav orb (`LooperOrb`)** `frontend/src/components/nav/FloatingTabBar.tsx:79-154` — tap→sheet, hold 350ms→listening; serif italic "L" ink medallion; nav = Home · Courses · [orb] · Tee times · Profile; bar shows only on hub routes (`nav/shouldShowTabBar.ts`).
- **Event bus** `frontend/src/lib/looper-bus.ts` — `openLooper({context, listening})` CustomEvent; `looperContextForPath`. Unit-tested.
- **General sheet** `frontend/src/components/LooperSheet.tsx` — `LooperSheetShell` (shared surface) + default = general context to `/api/caddie/voice` (+ stream), mounted once in `app/layout.tsx`.
- **Tee-time context** `frontend/src/app/tee-time/page.tsx:388-505` — hosts its own `LooperSheetShell`; `parseTeeTimePrefs` (deterministic + LLM + repair, offline-testable) → `applyParsed` → windows/courses/party/price merge → honest ack → auto-dispatch after 1400ms. Phase machine prefs→searching→options→confirmed.
- **Round page pill (KEEP)** `frontend/src/app/round/[id]/RoundPageClient.tsx:2110-2162` — "Ask caddie" pill → `CaddieSheet` (realtime live via `useCaddieLiveSession`). No tab bar on round pages.
- **Round setup voice** `app/round/new/page.tsx` + `VoiceRoundSetup(.Realtime).tsx` + `lib/voice/round-setup-convo.ts` + `/api/voice/parse-round-setup` — mature conversational setup (warm realtime, follow-up loop, confidence).
- **Stranded tournament layer** `lib/voice/schemas.ts:51` (`ParsedTournamentConfigSchema`), `lib/voice/pipeline.ts:159-201,466-490`, `lib/voice-parser.ts` — full parse pipeline, ZERO UI callers. `app/tournament/new/page.tsx` tap-only.
- **My Card stats** `app/profile/page.tsx` + pure libs `lib/profile-stats.ts`, `personal-bests.ts`, `handicap.ts`, `shot-stats.ts` (per-club `ClubStat`), `round-insights.ts`. Owner-scoped, honest-empty conventions established.
- **Backend brains** `backend/app/routes/caddie.py` — stateless `/api/caddie/voice` (+ stream), `VoiceCaddieRequest` (`types.py:270`, memories+profile grounding injected).
- **Deterministic gate** `frontend/voice-tests/runner.ts --smoke` — offline lanes incl. tournament + tee-time. HARD CI gate.

**Key insight:** the looper-orb architecture is right; only its placement and its context system are incomplete. This epic (a) moves the invocation out of the nav into a fixed omnipresent orb, (b) replaces the hardcoded 3-context union with a page-context contract, (c) wires the two setup flows and stats coaching through it.

## 1. `CaddieOrb` — component + placement

One component, mounted once in `app/layout.tsx` (next to `FloatingTabBar`/`LooperSheet`). **Fixed bottom-right (thumb zone), identical corner on every page:** `position:fixed; right:16px; z-index:50`; `bottom: calc(12px + env(safe-area-inset-bottom) + island-clearance)` where island-clearance ≈74px when `shouldShowTabBar(pathname)` else 0. Bottom-right chosen: round pill is bottom-center (no collision), rightmost tab keeps width, right-thumb reach. Size ~54px, ink medallion. **Iconography — caddie, not mic:** keep the L-medallion base (identity continuity), evolve into the caddie mark (designer owns final; no mic glyph, no assistant blob; viewBox 24, strokeWidth 1.5).

**Visibility `shouldShowCaddieOrb(pathname)` (new pure fn + test):** SHOW `/`, `/courses(/*)`, `/players(/*)`, `/profile`, `/tee-time`, `/round/new`, `/tournament/new`, `/tournament/[id]`, `/settings`. HIDE `/round/[id]` (the pill IS the orb there — one mic, zero doubling), `/map`, `/sign-in`, `/sign-up`. Interplay documented in both files.

**Interaction (migrated verbatim from `LooperOrb`):** tap→summon idle; hold ≥350ms (`ORB_HOLD_MS`, drift-cancel 12px)→summon listening + `haptic('medium')`. Extract the pointer state machine from `FloatingTabBar.tsx`. `aria-label="Talk to your caddie"`. **Orb states** (framer-motion, calm): idle / listening (ring breath) / thinking (pulse) / confirming (success beat + `haptic('success')`) — reflects the active sheet phase via the registry, no second source of truth.

## 2. Removing the center-nav orb

`FloatingTabBar.tsx`: delete `LooperOrb` + constants; render 4 tabs (Home · Courses · Tee times · Profile — tabs already `flex:1`, removing the fixed center makes 320px easier). Update `FloatingTabBar.test.tsx` (4-tab assertions replace orb-between-tabs). Tap/hold semantics move to `CaddieOrb` unchanged — same bus, same sheets, so **S1 is a pure placement migration**. Discoverability: first render after change plays a one-time gentle "Your caddie moved here" caption (localStorage flag, auto-fades, no modal).

## 3. The context system — the crux

### 3.1 Page-context contract — new `frontend/src/lib/caddie-context.ts` (pure + tested) + hook `useCaddiePageContext.ts` (register on mount, unregister on unmount, last-writer-wins). Orb + sheet host read the active context; unregistered routes fall back to `general`.

```ts
export type CaddiePageContext =
  | { id: "tee-time" | "tournament-setup"; kind: "task";
      copy: { title: string; hint: string };
      getKeyterms?: () => string[];
      parse: (transcript: string) => Promise<TaskParse>;   // wraps the page's deterministic parser
      apply: (parse: TaskParse) => TaskAck; }               // merges into page state, honest ack
  | { id: "round-setup" | "courses"; kind: "surface"; summon: (listening: boolean) => void }
  | { id: "my-card"; kind: "converse";
      copy: { title: string; hint: string };
      getGrounding: () => string | null; };                 // real stats block or null
// No registration → "general", converse, no grounding (today's LooperSheet brain).
```

### 3.2 The hybrid routing split — and why
- **Deterministic lane for dispatches** (tee-time, tournament, round setup): end in *actions* — must be reliable, correctable, offline-testable → the existing Zod + heuristics + LLM-repair parsers and the `voice-tests` harness. A realtime agent freewheeling a search would be untestable.
- **Realtime/streaming conversation for open-ended Q&A** (general, My Card): end in *understanding*, where liveness is the product → the stateless `/api/caddie/voice` (+ stream) with grounding.
- **Fall-through, not walls:** a task context with NO task signal falls through to conversation ("want me to set that search up?"). One orb feels omniscient without leakage because **the parser only ever receives the active page's schema** — cross-page intents are out of scope by construction.

### 3.3 Generic sheet host — new `frontend/src/components/CaddieOrbSheet.tsx` (mounted once with the orb) wraps `LooperSheetShell`: `task` (dictation→parse→confidence gate→apply→ack→confirming beat; low-confidence <0.6 → no auto-dispatch, "say it again to correct"); `converse` (today's flow + grounding); `surface` (no sheet — call `summon(listening)`). Current `LooperSheet` default becomes the `general` converse config; tee-time's private hosting deleted on migration.

## 4. Per-page task specs
- **Tee-time** `kind:"task"` registered in PrefsScreen (prefs phase only; searching/options → unregister → general). `parse`=existing `parseTeeTimePrefs` untouched; `apply`=existing `applyParsed`→`teeTimeAckLine`; 1400ms beat fires the same structured `asks` dispatch the tap flow uses. Search contract unchanged.
- **Start round** `kind:"surface"` — `summon=openVoiceSetup({autoStart:listening})` reusing `VoiceRoundSetup`. Zero new parse code.
- **Start tournament** `kind:"task"` — `parse`=`parseVoiceTranscript` (accept only `type==="tournament"`; game-typed → fall-through nudge to `/round/new`); `apply`=new pure `tournamentPrefillFromParse` (`lib/tournament-prefill.ts`, tested): name, numRounds clamped 1–4 (say so), playerNames fuzzy→selectedIds + unmatched→customPlayers, courses/groupings have no form surface → carried into ack as honest notes (never silently dropped). **Creation stays a human tap.** Add curated tournament voice-tests scenarios.
- **My Card** `kind:"converse"` — `getGrounding`=new pure `buildStatsGroundingBlock(rounds, clubStats, profile)` (`lib/stats-grounding.ts`, tested) serializing ONLY the profile page's real computed stats with sample sizes; thin data (<2 rounds) → says so; backend adds optional `stats_context` to `VoiceCaddieRequest` + a fenced "cite these numbers; if a stat isn't here, say you don't have it" prompt block (both `/voice` + `/voice/stream`). Optional+defaulted → backward-compatible.

## 5. Interaction model
tap→summon idle (haptic light); hold≥350ms→summon listening (haptic medium, ring breath); listening→interim line + orb listening; pending→thinking pulse; task applied→honest ack + form/prefs updated behind sheet + 1400ms cancellable beat (haptic success, confirming); low-confidence→"here's what I got" + no auto-dispatch (haptic warning once); no-signal→fall through to conversation + gentle nudge. Reuse `lib/haptics.ts` + framer-motion `T.springSoft`; no new motion language.

## 6. Sequenced slices (smallest-valuable-first; each shippable + gated)
- **S1 — The orb moves (noticeable, designer-heavy):** `CaddieOrb` + `shouldShowCaddieOrb` + placement; nav→4 tabs; tap/hold migrated; existing contexts keep working over the unchanged bus; one-time intro; round-page hide. Tests: shouldShowCaddieOrb, orb pointer semantics, 4-tab bar.
- **S2 — Context contract + tee-time through it (the wow):** `caddie-context.ts` + `useCaddiePageContext` + `CaddieOrbSheet` host (task/converse/surface, confidence gate, fall-through); migrate general + tee-time (`parseTeeTimePrefs`/`applyParsed` untouched). Voice-tests green = hard gate.
- **S3 — Setup wiring:** tournament `tournament-prefill.ts` + `/tournament/new` registration + curated tournament scenarios; round `/round/new` surface registration.
- **S4 — My Card coaching:** `stats-grounding.ts` + profile registration + `stats_context` backend field + prompt block. `/security-review` (new user-data path into a prompt).
- **S5 — Polish:** orb motion/haptics tuning, telemetry (orb summon/dispatch/fall-through — measures discoverability), per-page bottom-inset audit, copy.

## 7. Risks
Nav-layout regression on 320px (snapshot designer approval; tests rewritten not deleted); voice-tests churn (S1–S2 touch zero parser code — smoke gate proves it; S3 only adds scenarios); context leakage (structurally prevented — active registration only, last-writer-wins, unmount cleanup); round pill/orb doubling (hide rule on `/round/[id]`); tee-time phase edge (prefs-scoped registration); tournament form can't hold groupings/courses (ack says what didn't land); stats fabrication (grounding carries sample sizes, prompt forbids uncited numbers, thin history answered honestly); discoverability (one-time intro + S5 telemetry); orb vs page CTAs/safe areas (S1 route audit + safe-area insets).

## 8. Shared-type sync
`VoiceCaddieRequest` (`backend/app/caddie/types.py:270`) ↔ request shape in `frontend/src/lib/caddie/api.ts` — S4 adds optional `stats_context` on both. Use the Zod-inferred `ParsedTournamentConfig` in the prefill mapper (don't duplicate a third time). `LooperContext` union grows to the registry ids.

## 9. Gates (every slice)
`cd frontend && npm run lint` · `npx tsc --noEmit` · `npx tsx voice-tests/runner.ts --smoke` (hard) · `npm run build` · `cd backend && ruff check .` (S4). Vitest for every new pure module; designer review S1/S2/S3; `/security-review` S4.

### Critical Files
- `frontend/src/components/nav/FloatingTabBar.tsx` (orb removal, 4-tab island; pointer state machine to extract)
- `frontend/src/components/LooperSheet.tsx` (`LooperSheetShell` the new host wraps)
- `frontend/src/lib/looper-bus.ts` (summon transport; grows with new `lib/caddie-context.ts`)
- `frontend/src/app/tee-time/page.tsx` (reference task migration ~388-580)
- `frontend/src/lib/voice/pipeline.ts` + `backend/app/caddie/types.py` (stranded tournament parse; `stats_context` sync point)
