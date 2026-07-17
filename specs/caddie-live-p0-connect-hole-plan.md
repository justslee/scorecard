# Plan: Caddie Live P0s — connect UX (Bug A) + live-hole answers (Bug B)

> Fable-authored implementation plan (owner directive: Plan agents run on fable). Root-cause
> traced to exact seams and verified against the code. Builder implements this VERBATIM — no
> re-plan. Scope: frontend-only. No VAD changes. Preserve the shipped dedup (Part C),
> zombie/terminal-stop (Part A), one-mic singleton, ordering, priming-echo, and no-input-clarifier
> guards — Bug A lives in the hook/UI layer above `realtime.ts`; Bug B touches only the
> `setToolContext`/`dispatchTool` context plumbing (a typed, additive field), not the event machinery.

## 1. Root-cause verification (both traces confirmed)

### Bug A — one 3s timer covers the whole connect
- `frontend/src/hooks/useCaddieLiveSession.ts` L539-542 arms `mintDeadlineRef = setTimeout(fallBack, MINT_DEADLINE_MS)` (`MINT_DEADLINE_MS = 3000`, `frontend/src/lib/caddie/transport.ts` L26). Cleared only in `onStatus` `'connected'` branch (L397-401), which fires from `pc.onconnectionstatechange === 'connected'` → `setStatus('connected')` in `frontend/src/lib/voice/realtime.ts` L356-364. So mint HTTP + SDP POST to `REALTIME_CALLS_URL` (realtime.ts L443-451) + ICE/DTLS all share one 3s budget.
- The hook never consumes `onMinted` (emitted realtime.ts L353; consumed by `useVoiceCaddie` L206-209 and `warm-session.ts` L135 — the seam exists, unused here).
- No per-phase timeout inside realtime.ts (SDP fetch L443 has no AbortController; ICE no watchdog). We deliberately do NOT add one there — the hook-level budget + the client's terminal `stop()`/abort re-checks (L348, L423, L455) make an abandoned hung attempt safe to walk away from.
- Silent revert on timeout while the sheet is closed: `fallBack()` (L226-242) → `liveState "fallback"` → `fellBack` true → `useDetachedCaddieLive.ts` L132-136 auto-release (`setLiveOn(false)` when `!sheetOpen`) → inner hook `!active` reset (L322-348) → pill idle → label falls to `"Ask caddie"` (RoundPageClient.tsx L2556-2562). Golfer sees "Connecting…" ~3s then silent "Ask caddie" = the owner's "doesn't go from connecting to listening". (Sheet-OPEN path already renders the classic body + chip via CaddieSheet.tsx L279/282; the idle-tap pill path never opens the sheet, so always hits the silent case.)
- No auto-retry pre-connect: Slice D `startReconnect` (L453-487) only runs post-connected. Pre-connected `'closed'`/`'error'` → `fallBack()` immediately (L408-411, L442-445).
- Dead-warm handover: `takeWarm` hands out WARMING clients (warm-session.ts L155-156); a consumed dead/stopped client → hook warm branch (useCaddieLiveSession.ts L551-566) goes straight to `fallBack()`, no cold retry.
- Nuance: the 3s deadline also covers the warm-adopt branch; `startReconnect`/`doResume` reuse the same too-tight `MINT_DEADLINE_MS` for a full cold mint+ICE (L460-463, L512-515) — same false-timeout bug on the post-drop path. Widen those too (§2.2).

### Bug B — tool dispatch resolves the hole from model args, not the live hole
- `anchorHole()` (useCaddieLiveSession.ts L288-294) → `client.sendContext(buildHoleContextText(h))` (opening-turn.ts L60-79) is a role:`system` steer only (realtime.ts L503-516, no `response.create`) — instructs but cannot force `hole_number N`.
- `dispatchTool` (realtime.ts L96-188) resolves from model args: `get_recommendation` L111 `Number(args.hole_number)`; `record_shot` L123; `get_conditions` L133-134 / `get_bend` L155 / `get_shot_distance` L165 / `get_green_read` L177 pass the hole only if the model supplied it else `undefined`; `get_carries` L146 `Number(args.hole_number)`.
- Backend defaults an omitted hole to `session.current_hole`: `backend/app/routes/caddie.py` L416/429 (conditions), L462 (`hole_number or session.current_hole`, carries), L482 (bend), L517/546 (shot_distance/green_read). `session.current_hole` set at mint only (realtime.py L126-127, in-memory, not persisted) and bumped only by the TEXT path (caddie.py L722-724) — never on a swipe during a live voice session. Stale both ways.
- Precedent (the shipped "125" fix): `getToolContext` (useCaddieLiveSession.ts L199-202) returns `{ holeYards, yardageBasis }` read live off `holeContextRef`; read fresh per dispatch in `runTool` (L1130-1135). Extending with `currentHole` is structurally identical. `setToolContext(getToolContext)` is called on ALL four client sites the hook builds/adopts — cold L575, warm L556, reconnect L473, resume L522 — so the field rides along everywhere (the new retry site in §2 must call it too).
- Coherence: `ctx.holeYards` is ALWAYS the current hole's yardage. Today `hole_number=1` + `yards=<hole 2's yards>` is the incoherent pair; overriding the hole to `currentHole` makes the (hole, yards, basis) triple coherent — the same triple `buildHoleContextText` anchors. NOT overriding is the incoherent state.
- `useVoiceCaddie` never calls `setToolContext` (grep-verified) → with the additive optional field its dispatches keep today's args-passthrough — no regression.

## 2. Bug A — connect state machine

### 2.1 State shape (`useCaddieLiveSession.ts`)
```
export type CaddieLiveState =
  "connecting" | "retrying" | "live" | "suspended" | "fallback" | "connect-failed";
```
- `"retrying"` — the one quiet auto-retry is in flight (fresh cold client).
- `"connect-failed"` — honest terminal tap-to-retry state. Distinct from `"fallback"`: `fellBack` stays `liveState === "fallback"` (L661), so `useDetachedCaddieLive`'s fallback-auto-release contract (keyed on `session.fellBack`) is untouched and `connect-failed` PERSISTS `liveOn` — the pill renders an honest state instead of silently reverting.
- `"fallback"` remains terminal ONLY for: mic-permission denial, and post-connected reconnect exhaustion (Slice D).
- New result member `retryConnect: () => void` on `UseCaddieLiveSessionResult` — user-triggered fresh attempt, valid only from `"connect-failed"` (no-op otherwise), implemented via an impl-ref like `resumeImplRef`/`doResume` (L176, L499-537). Like `doResume`, a human tap RESETS the one-retry budget.

Machine (pre-connected only; Slice D/E post-connected machinery untouched):
```
connecting --mint>4s | attempt>8s | pre-connected closed/error | start() reject | dead-warm--> retrying (auto, once)
retrying   --connected--> live
retrying   --same failure set--> connect-failed
connect-failed --retryConnect() (pill tap / sheet affordance)--> connecting (budget reset)
any pre-connected attachMic getUserMedia-denial--> fallback (never retried)
```

### 2.2 Phase timeouts — in the HOOK, not realtime.ts
New named exports in `transport.ts` (`MINT_DEADLINE_MS = 3000` left untouched for useVoiceCaddie/warm-session):
- `LIVE_MINT_BUDGET_MS = 4000` — attempt start → `onMinted`.
- `LIVE_CONNECT_BUDGET_MS = 8000` — attempt start → first `'connected'` (overall per-attempt deadline; ICE effectively gets 8s minus mint time). Worst case to honest failure: 8s + 8s = 16s, each phase visible.

realtime.ts is UNTOUCHED for Bug A (it's shared by three surfaces with three deadline policies and already exposes the phase boundaries `onMinted` L353 / `'connected'` L360). A hung SDP fetch on an abandoned attempt is safe: the retry detaches + `stop()`s the old client (terminal `aborted`), and `startInner`'s post-await abort re-checks (L348, L455) clean it up whenever the fetch resolves.

Hook changes:
1. Factor the connect attempt into one closure inside the activation effect: `startAttempt(kind: 'initial' | 'auto-retry' | 'user-retry')`. Per attempt: `attemptId += 1` (ref), `attemptHandled = false` (ref), arm `mintTimerRef` (4s) + `attemptTimerRef` (8s), record `t0 = Date.now()`. Every timer/failure callback captures its `attemptId` and no-ops if stale, `cancelled`, `fellBackRef.current`, or `everConnectedRef.current`.
2. Add `onMinted` to the `events` object: clear `mintTimerRef`, emit `voiceEvent('caddie', 'live_connect_minted', { detail: 'attempt=N path=cold|warm ms=…' })`.
3. Warm-adopt branch: an adopted warm client is already minted and never re-fires `onMinted` — on adoption clear the mint sub-timer and log `path=warm`. The 8s attempt timer keeps running until `'connected'` (this IS the dead-warm watchdog).
4. `'connected'` branch (L397-405): additionally clear both timers, log `live_connect_connected`. If arriving while `liveState === "retrying"`, transition to `"live"` (openedTurnRef still false on a pre-first-connect retry, so `maybeFireOpeningTurn()` fires the opener normally).
5. New `failPreConnect(reason)` (idempotent per attempt via `attemptHandled`): clear both timers, detach + stop the current client (`clientRef.current?.setEvents({}); clientRef.current?.stop(); clientRef.current = null` — the exact `startReconnect` belt L457-459), then:
   - if `retryUsedRef` false → `retryUsedRef = true`, `setLiveState("retrying")`, log `live_connect_retry { detail: 'reason=…' }`, `startAttempt('auto-retry')` — ALWAYS a fresh COLD `new RealtimeCaddieClient(...)` (never `takeWarm` on retry) with `currentHole: holeContextRef.current.holeNumber`, `setToolContext(getToolContext)`, then `start()`/`attachMic()` as the cold path does.
   - else → `setLiveState("connect-failed")`, log `live_connect_failed { detail: 'reason=…', flush: true }`. Do NOT call `fallBack()`.
6. Routing into `failPreConnect`: pre-connected `'closed'`/`'error'` onStatus branch (today L408-411); `onError` when `!everConnectedRef` (L442-445); the cold/warm IIFE `catch` — SPLIT the single try/catch so `client.start()` rejection → `failPreConnect('start_reject')`, while `client.attachMic()` rejection is classified: `err.name` in {`NotAllowedError`,`NotFoundError`,`SecurityError`} → `fallBack()` (mic-deny: retrying getUserMedia after an explicit deny is hostile and can never succeed); anything else (`'attachMic: client stopped'`, missing transceiver — a dead/half-built warm client) → `failPreConnect('warm_dead')`. Idempotency (`attemptHandled`) absorbs the double-fire (attachMic rejects AND pushes `'error'` through onStatus/onError).
7. `doRetryConnect()` (impl-ref, exposed as `retryConnect`): only from `"connect-failed"`; resets `retryUsedRef = false` + `attemptHandled`, sets `liveState "connecting"`, `setStatus("connecting")` (immediate honest feedback), logs `live_connect_user_retry`, `startAttempt('user-retry')` (cold).
8. Replace L539-542 single deadline with `startAttempt('initial')`; all resets (`!active` L322-348, activation L351-368, effect cleanup L593-603, `stop()` L639-657) additionally clear the two new timers and reset `retryUsedRef`/attempt refs.
9. Widen Slice D deadlines: `startReconnect` (L463) and `doResume` (L515) switch `MINT_DEADLINE_MS` → `LIVE_CONNECT_BUDGET_MS`.

Telemetry: all via existing `voiceEvent('caddie', …)` — event names + enum-valued `detail` (`attempt=`, `path=`, `reason=`, `phase=`, `ms=`) only. Never the client_secret, round content, or transcripts (matches `realtime_dc_error` posture).

### 2.3 UI surfacing
`live-copy.ts` (+ `live-copy.test.ts`): add placeholder copy the DESIGNER finalizes — e.g. `LIVE_CONNECT_RETRYING_LABEL` ("Still connecting…"-class) and `LIVE_CONNECT_FAILED_LABEL` ("Couldn't reach your caddie — tap to retry"-class, calm not alarming). Extend `liveEmptyStateHint` with a `retrying` branch so the open-sheet empty state agrees with the footer.

`RoundPageClient.tsx` (pill — sheet CLOSED):
- Derivations (L1559-1587): `pillRetrying = pillIsLive && session.liveState === "retrying"`, `pillConnectFailed = pillIsLive && session.liveState === "connect-failed"`; extend `pillConnecting` to include retrying; `pillPulsing` must EXCLUDE both (never pulse while not genuinely live — S5 invariant).
- Label span (L2556-2563): branches for retrying → `LIVE_CONNECT_RETRYING_LABEL`, connect-failed → `LIVE_CONNECT_FAILED_LABEL` (before the `pillIsLive → liveStatusLabel(...)` branch).
- `onClick` (L2411-2447): a new branch BEFORE the `pillIsLive` reopen branch — `if (pillConnectFailed) { haptic("light"); detachedCaddieLive.session.retryConnect(); return; }`. Tap while retrying keeps today's behavior (opens the sheet to view). Hold-to-end still works in both states (`pillIsLive` stays true) — the escape hatch back to the resting pill.
- aria-label (L2400-2410): add the two states.

`CaddieSheet.tsx` (sheet OPEN):
- `liveActive` (L279): `open && liveOn && !live.fellBack && live.liveState !== "connect-failed"` — while open, connect-failed swaps to the classic tap-to-talk body exactly like fallback (honest, visible, usable).
- `showFallbackIndicator` (L282): also true for connect-failed (designer may want distinct chip copy; the chip mechanism is reused).
- Retrying renders the normal live body (status `'connecting'` → footer "Connecting…"; empty-state hint gets the retrying branch).

`useDetachedCaddieLive.ts`:
- Auto-release effect (L132-136) UNCHANGED — keyed on `fellBack`; `connect-failed` deliberately does NOT release `liveOn` (that release IS the silent revert being fixed). Doc comment updated.
- Add `isRetrying` / `isConnectFailed` derivations (symmetry with `isSuspended`); `retryConnect` flows through `session`.
- RoundPageClient warm effect (L1377-1379) already keys on `!liveOn`, so no warm client mints under a failed/retrying live session — one-mic invariant holds for free.

### 2.4 Races (each gets a test — §4)
1. Retry vs teardown: every timer/failure callback checks `cancelled || fellBackRef || stale attemptId`; cleanup/`stop()`/`!active` clear both timers; old client detached (`setEvents({})`) then stopped (terminal) before the new is constructed. No zombie mint: at most one live client ref at any instant; abandoned ones are `aborted`.
2. Late `'connected'` from abandoned client: events detached before `stop()`; belt = stale-attemptId guard.
3. Timeout firing after connect: timers cleared in `'connected'` branch; same-tick stragglers no-op on `everConnectedRef`/attemptId.
4. Warm-dead detection: three routes (adoption paints `'closed'`/`'error'`; `attachMic` rejects non-permission; never reaches `'connected'` in 8s) converge on `failPreConnect` → one cold retry.
5. Genuine errors not masked: mint 5xx rejects `start()` fast → one quiet re-mint → second failure lands in visible `connect-failed` within seconds (never a spinner). Mic-deny → immediate `fallback`, no retry, no re-prompt. Offline at start already gated in `useDetachedCaddieLive.start()`.
6. Retry vs Slice D: `reconnectingRef` branch requires `everConnectedRef` true; the new machine requires it false — disjoint by construction.

## 3. Bug B — live-hole resolution
### 3.1 Changes
1. `useCaddieLiveSession.ts` L199-202 — `getToolContext` reads ONE snapshot: `const h = holeContextRef.current; return { holeYards: h.yards, yardageBasis: h.basis, currentHole: h.holeNumber };` (single read = the triple can never mix across a swipe landing between two reads).
2. `realtime.ts` — additive type widening, no logic elsewhere:
   - `setToolContext` param + `toolContextProvider` type (L263, L635): add `currentHole?: number | null`.
   - `runTool` (L1130-1135): pass `currentHole: toolCtx.currentHole` into the dispatch ctx.
   - `dispatchTool` ctx type (L99): add `currentHole?: number | null`. Resolution rule, ctx-first: `const liveHole = ctx.currentHole ?? undefined;`
     - `get_recommendation`: `hole_number: liveHole ?? Number(args.hole_number)`
     - `get_conditions`, `get_bend`, `get_shot_distance`, `get_green_read`: `liveHole ?? (args.hole_number != null ? Number(args.hole_number) : undefined)`
     - `get_carries`: `liveHole ?? Number(args.hole_number)`
     - `record_shot`: ARGS-first — `args.hole_number != null ? Number(args.hole_number) : liveHole` (today's NaN only if both absent, unchanged).
   - `get_session_status` / `get_player_profile` / `set_round_setup`: not hole-scoped — untouched.
3. No other call sites change. `useVoiceCaddie` sets no tool context → `ctx.currentHole` undefined → args passthrough, byte-identical.

### 3.2 Decisions
- Override (ctx-first) for the six hole-scoped tools — the client cannot distinguish a stale `hole_number` from a deliberate one, and the failure modes are asymmetric: a wrong answer about the hole the golfer stands on is the observed P0; a voice ask about a different hole is rare with a designed recourse (swipe to it → updates `currentHole` + re-anchors). Only choice coherent with the shipped yardage override. Matches the anchor text's contract.
- `record_shot` keeps model args, defaults to live hole when omitted — a shot is a statement about a just-played action whose hole the player often names, and the common flow (hole out → swipe to next → narrate previous hole's shots) would mis-file under override. The `?? liveHole` omission fallback kills only the stale backend default.
- No backend change. With the override every hole-scoped call carries an explicit `hole_number`, so `session.current_hole` staleness is structurally moot for these tools (the `or session.current_hole` defaults never trigger). No shared-types changes (`types.ts`/`models.py` untouched; api.ts signatures already carry `hole_number`).

### 3.3 Edge cases
- Rapid swipe mid-turn: `toolContextProvider()` read at dispatch time (runTool L1130) → answers the hole on screen when the answer lands. That is "the hole I'm looking at". Accepted.
- Other-hole questions: answered for the current hole (see §3.2) — owner-decision refinement in §5.
- Reconnect/resume/warm/retry clients: all call `setToolContext(getToolContext)` — field rides along.
- Coherence: hole, yards, basis all from the same snapshot per dispatch — engine solve, model anchor, spoken numbers can no longer disagree.

## 4. Gates
Existing (must stay green): `cd frontend && npx tsc --noEmit` · `npm run lint` · `npm run build` · `npx tsx voice-tests/runner.ts --smoke` · `npm run test` (esp. realtime-dedup, realtime-lifecycle, realtime-warm + warm-session, realtime-ordering, realtime-attribution, realtime-noinput + noinput-clarifier, realtime-dispatch, transport [MINT_DEADLINE_MS unchanged], opening-turn, CaddieSheet.realtime/.realtime-glitch/.handsfree/.session, useDetachedCaddieLive) · `npm run test:caddie-experience` · `cd backend && ruff check .`

Deliberate test updates (spec'd behavior change): `useDetachedCaddieLive.test.tsx` L256 ("fellBack while closed releases liveOn") and L281 ("fellBack while OPEN…") drive a pre-connected `'closed'` which now triggers the quiet retry first — update to fail the retry client too and assert the NEW terminal: `connect-failed` persists `liveOn`, while true `fallback` (mic-deny / post-connected exhaustion) still auto-releases per the unchanged contract.

New tests:
1. `frontend/src/hooks/useCaddieLiveSession.connect.test.tsx` (new; fake timers + FakeRealtimeCaddieClient from useDetachedCaddieLive.test.tsx / realtime-test-fakes.ts), register in `caddie-experience-suite.ts` (dimension 6): mint stall→retry→connect-failed (no third client, old detached before stop); minted-then-ICE-stall same path (timers cleared by connected → advancing past budgets inert); retry success→live (opener fires once, anchorHole sent); late connected/closed from abandoned attempt-1 client → no state change / no message delivery; dead-warm adoption → ONE cold retry, takeWarm not re-called; mic-deny (NotAllowedError) → fallback immediately, zero retries; retryConnect() from connect-failed → fresh attempt reset budget, no-op elsewhere; telemetry breadcrumbs fired with enum-only detail (voiceEvent mocked, assert no secret-shaped payloads); stop()/unmount mid-retry → timers cleared, client detached+stopped, no further construction.
2. `frontend/src/lib/voice/realtime-dispatch.test.ts` (extend — Bug B pin at dispatchTool): for each of the six tools, `ctx.currentHole=2` + `args.hole_number=1` → endpoint called with `hole_number 2`; `record_shot` with args hole → args win; `record_shot` without args hole → `ctx.currentHole`; `ctx.currentHole` absent → today's args/undefined behavior byte-identical.
3. `frontend/src/hooks/useDetachedCaddieLive.test.tsx` (extend): hole-swipe-mid-session — rerender `holeNumber` 1→2, then invoke the provider captured by the fake's `setToolContext` → returns `currentHole:2` with matching hole-2 yards/basis; existing "sheet close does NOT stop the session" (L162) + end/unmount detach tests unchanged and green.
4. `frontend/src/lib/caddie/live-copy.test.ts` (extend): new labels exist; empty-state hint agrees with the footer in the retrying state.

## 5. Risks / owner decisions
- Other-hole voice questions now answer the on-screen hole for the six hole-scoped tools (recourse: swipe). If the owner wants "carry on the next hole" by voice alone, a follow-up can let `args.hole_number > currentHole` pass through. Default here: unconditional override — FLAG for owner.
- `connect-failed` persistence: the pill holds tap-to-retry until tap (retry) or long-press (end) — no auto-decay to "Ask caddie". Chosen for honesty; designer/owner may prefer a timed decay. Copy is the designer's (placeholders shipped in live-copy.ts).
- Budgets 4s/8s tunable in transport.ts; worst case to honest failure 16s with a visible state change each phase. New telemetry exposes real-course distributions.
- Slice D reconnect/resume deadlines widened 3s→8s (same full-cold-connect composition) — deliberate; any test pinning the 3s reconnect deadline gets the same spec'd update.
- Mic-deny classification by `err.name` — unknown shapes default retry-eligible (safe: one bounded retry then honest failure).
- Guards intact by construction: no edits to VAD, dedup, terminal-`aborted`, one-mic singleton, ordering, no-input clarifier.
