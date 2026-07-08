# Caddie Realtime — Slice E Implementation Plan: live-mode idle suspend/resume UX + telemetry

Parent contract: `specs/caddie-realtime-conversation-plan.md` (§6 Cost & idle policy, §6.5.3 telemetry, §10 Slice E).
Builds directly on `specs/caddie-realtime-slice-c1-plan.md` (never-dead contract) and `specs/caddie-realtime-slice-d-plan.md` (reconnect state machine). This document is the contract handed to the builder — it must be followed precisely and it must NOT break C1/D invariants.

Classification: **flag is already DEFAULT-ON** (`frontend/src/lib/voice/live-mode-pref.ts`, `getCaddieLiveMode()` returns `true` unless the key is `"0"`; owner-confirmed on TestFlight v1.0.850). **The "flag default flip" is DONE — this slice does NOT re-plan it.** Slice E is purely: turn the current dishonest idle dead-end into a visible **suspended** state with a user-triggered **resume**, plus two lightweight telemetry markers.

Primary file: `frontend/src/hooks/useCaddieLiveSession.ts`. Small consumer change: `frontend/src/components/CaddieSheet.tsx` (`LiveFooter` gains a paused/resume affordance; footer wiring). Tests grow in `frontend/src/components/CaddieSheet.realtime.test.tsx`. **Zero edits** to `realtime.ts` / `warm-session.ts` / `realtime-ordering.ts` / `transport.ts` / `idle-timer.ts`.

---

## 0. Facts established by reading the code (ground truth)

- **The exact gap.** In `useCaddieLiveSession.ts` `onStatus`, a post-connected `'closed'` that the hook classifies as clean-idle (line ~287-290, `isCleanIdle` — computed as `s === "closed" && Date.now() - lastActivityAtRef.current >= REALTIME_IDLE_DISCONNECT_MS - IDLE_MARGIN_MS`) currently does `if (isCleanIdle) return;` (line 290). It does NOT change `liveState` (stays `"live"`) and leaves the last `setStatus(s)` value (`"closed"`, set at line 249 before the branch). So today the socket is DEAD (realtime.ts's `IdleTimer.onExpire` → `stop()` → `cleanup()` → `setStatus('closed')` already tore it down), yet `liveState` is still `"live"`, `liveActive` is still true, `LiveVoiceBody` still renders, and `LiveFooter` renders with `live.status === "closed"` → `LIVE_STATUS_LABEL["closed"]` = **"Ended"** plus a mute toggle that no-ops on the null/dead client. **There is NO resume path.** This is the honest-states / never-dead violation Slice E fixes. (Slice D §3 explicitly deferred the resting copy/affordance to "out of Slice D scope" — that is exactly here.)
- **realtime.ts collapses idle-close and drop into one `'closed'`** with no public discriminator (Slice D §0). Slice E does not change that; it reuses D's hook-local idle mirror (`lastActivityAtRef`) verbatim to distinguish clean-idle from drop.
- **`RealtimeStatus` is a fixed union in the untouchable `realtime.ts`** (`'idle'|'connecting'|'connected'|'speaking'|'listening'|'closed'|'error'`). "Suspended" therefore CANNOT be a `RealtimeStatus`; it must live on the hook's own `CaddieLiveState`.
- **`fallBack()` and idle-rest both preserve `messages`.** `setMessages([])` runs only on `active`→false and on re-activation. During suspend, `active` stays true (`wantLive && navigator.onLine`), so the transcript survives. `openedTurnRef` is never reset except on (re)activation — reusing it across a resume gives "no re-greet" for free (identical to D's reconnect).
- **Cross-client transcript ordering** (D §2.3) already exists: `maxOrderRef` tracks the max order seen, `orderOffsetRef` offsets a fresh client's near-zero `order` values, gated by `reconnectedRef` in `upsert`. Resume reuses this unchanged.
- **The Slice-D reconnect budget** is `reconnectUsedRef` ("one auto-reconnect per activation", D §2.1/"One-reconnect policy"). Resume must NOT consume it (constraint) — and additionally must RESET it, see §3.4.
- **Backend telemetry `event` is a free-form `str`** (`backend/app/routes/voice.py:208-235`, `VoiceTelemetryEvent.event: str`, truncated to 40 chars, logged; no enum). New event names need ZERO backend change.
- **CaddieSheet gating already survives suspend.** `liveActive = wantLive && navigator.onLine && !live.fellBack` (CaddieSheet.tsx:246) stays TRUE during suspend (`fellBack` false). The classic auto-open effect early-returns on `if (liveActive) return;` (line 778) AND `if (liveTranscriptSeenRef.current) return;` (line 782). So a suspended sheet never re-greets and never re-arms the classic loop (line 373). No CaddieSheet change is needed to keep those safe.

---

## 1. Scope

- **Suspend (idle):** on the clean-idle `'closed'`, transition to a NEW visible hook state `liveState:'suspended'` (socket already stopped by realtime.ts). Preserve `messages`/`openedTurnRef`. Detach the dead client. Emit a `live_suspend` telemetry marker.
- **Paused UX:** `LiveFooter` renders a calm "Paused — tap to resume" state; the mic button becomes a tappable **resume** control (yardage-book calm; designer will review). No new chrome, no toast, no alarm.
- **Resume (user tap):** cold-mint a fresh client, `attachMic`, CONTINUE the same conversation (no re-greet; cross-client order offset applied so resumed turns sort strictly after the suspended transcript). Emit `live_resume`. The backend grounds the fresh mint with the shared round ledger, so server-side context survives (epic §2 Slice A).
- **Barge-in during suspend = resume+listen** (see §3.5): because the socket is closed while suspended there is no server VAD; tapping the paused mic is the ONLY way to talk again, and it resumes AND lands in `listening`.
- **Resume failure** (mint-timeout / connect-fail / mic-deny) → classic fallback per C1/D (reuse `fallBack()`).
- **Telemetry:** two minimal markers on the existing `voiceEvent` bus.

Out of scope (do NOT touch): the flag default (done), the classic tap-to-talk path, sheet close/teardown (C1 already stops everything), Slice A grounding, any `realtime.ts` seam.

---

## 2. The reconciled hook state machine

### 2.1 States (`CaddieLiveState`)
Extend the union from `"connecting" | "live" | "fallback"` to:

```
"connecting" | "live" | "suspended" | "fallback"
```

- **connecting** — initial mint in flight (unchanged).
- **live** — connected, mic attached, server VAD running (unchanged). Also the state DURING a D auto-reconnect sub-phase and DURING a resume sub-phase (both keep `liveState:'live'` for continuity; status flickers `connecting→connected`).
- **suspended** — NEW. Socket stopped by the 90s idle cutoff; transcript preserved; awaiting a user resume tap. Honest, visible, calm.
- **fallback** — degraded to classic tap-to-talk (unchanged).

`fellBack` stays `liveState === "fallback"` (correct with the new value added).

### 2.2 New / reused refs (hook)
- **NEW `suspendedRef: boolean`** — mirror of `liveState==='suspended'` for use inside `onStatus`/callbacks; reset on (re)activation like the others.
- **NEW `resumeImplRef: (() => void) | null`** — the returned stable `resume()` calls `resumeImplRef.current?.()`; the activation effect assigns the real closure (it needs `events`/`cancelled`/`roundId`/`personaId`, exactly like `startReconnect`). Cleared in effect cleanup.
- **Reused unchanged:** `reconnectingRef`, `reconnectedRef`, `reconnectDeadlineRef`, `orderOffsetRef`, `maxOrderRef`, `mutedRef`, `lastActivityAtRef`, `reconnectUsedRef`, `openedTurnRef`, `everConnectedRef`, `micReadyRef`, `fellBackRef`.

No change to the returned shape except adding **`resume: () => void`**. `liveState` is already returned; CaddieSheet reads `live.liveState === "suspended"` for the paused affordance.

### 2.3 Transition table (post first-connect; `everConnectedRef=true`)

| From | Event | Guard | Action | To |
|---|---|---|---|---|
| live, `!reconnecting`, `!suspended` | `onStatus('closed')` | clean-idle (`Date.now()-lastActivity ≥ REALTIME_IDLE_DISCONNECT_MS - IDLE_MARGIN_MS`) | `suspend()` — detach dead client, `clientRef=null`, `setLiveState('suspended')`, emit `live_suspend` | **suspended** |
| live, `!reconnecting` | `onStatus('closed')` | drop (`else`) AND `!reconnectUsedRef` | `reconnectUsedRef=true`; `startReconnect()` (D, unchanged) | reconnecting (liveState stays `live`) |
| live, `!reconnecting` | `onStatus('error')` | `!reconnectUsedRef` | `reconnectUsedRef=true`; `startReconnect()` | reconnecting |
| live, `!reconnecting` | `closed`/`error` | `reconnectUsedRef` already true | `fallBack()` | fallback |
| **suspended** | **user `resume()` tap** | `suspendedRef && !reconnectingRef` | `doResume()` — see §3.3 | reconnecting (liveState set to `live`) |
| reconnecting (D reconnect OR resume) | `onStatus('connected')` | — | clear reconnect deadline; `reconnecting=false`; `setLiveState('live')`; re-apply `mutedRef`; `maybeFireOpeningTurn()` → **no-op** (`openedTurnRef` set) | live |
| reconnecting (D reconnect OR resume) | `onStatus('closed'/'error')` from fresh client, OR reconnect deadline fires | — | `fallBack()` | fallback |
| suspended | `active→false` / unmount / `stop()` | — | reset all refs (incl. `suspendedRef=false`), clear timers, `clientRef?.stop()` (null → no-op), clear messages | idle |

**Key composition guarantee:** suspend and the D auto-reconnect sub-phase are mutually exclusive by construction — clean-idle routes to `suspend()` and never enters `startReconnect()`; a drop routes to `startReconnect()` and never enters `suspend()`. Resume reuses the SAME reconnecting sub-phase (`reconnectingRef` + `reconnectDeadlineRef` + the existing `if (reconnectingRef.current)` branch in `onStatus`) as D's reconnect, so the "fresh client connected → live / fresh client closed → fallback" handling is shared and already pinned.

---

## 3. Implementation detail (hook)

### 3.1 The one-line behavioral change in `onStatus`
Replace the clean-idle early return:

```
if (isCleanIdle) return;            // TODAY — dishonest dead-end
```
with
```
if (isCleanIdle) { suspend(); return; }
```

Everything else in the post-connected close branch (drop → reconnect / fallback) is unchanged.

### 3.2 `suspend()` — a `useCallback` defined near `fallBack()` (stable; no `events`/`cancelled` needed)
```
const suspend = useCallback(() => {
  suspendedRef.current = true;
  reconnectingRef.current = false;      // defensive; clean-idle can't be mid-reconnect
  clearMintDeadline();
  clearReconnectDeadline();
  const dead = clientRef.current;
  dead?.setEvents({});                  // public seam — stop any late event re-entering onStatus
  clientRef.current = null;             // socket already stopped by realtime.ts's IdleTimer
  if (mountedRef.current) setLiveState("suspended");
  voiceEvent("caddie", "live_suspend", { flush: true }); // §4
}, [clearMintDeadline, clearReconnectDeadline]);
```
Notes: the client is ALREADY fully stopped (the `'closed'` we are handling came from its own `stop()`), so we do NOT call `stop()` again; `setEvents({})` is belt-and-suspenders. `messages`/`openedTurnRef`/`everConnectedRef`/`micReadyRef`/`maxOrderRef`/`reconnectedRef` are all left intact. `status` is left at `"closed"` — the paused footer overrides the label (§3.6), so the stale "Ended" is never shown.

### 3.3 `doResume()` — a closure INSIDE the activation effect (needs `events`, `cancelled`, `roundId`, `personaId`), assigned to `resumeImplRef.current`
Mirror `startReconnect()` (D §2.2) with three deliberate differences: it is user-triggered, it transitions FROM suspended, and it does NOT set `reconnectUsedRef` (it resets it — §3.4).
```
const doResume = () => {
  if (!suspendedRef.current) return;    // only from suspended
  if (reconnectingRef.current) return;  // guard double-tap / re-entrancy → NO double-mint / double-attach
  suspendedRef.current = false;
  reconnectUsedRef.current = false;     // §3.4 — resumed burst gets its OWN one-shot auto-reconnect budget
  reconnectingRef.current = true;
  reconnectedRef.current  = true;
  orderOffsetRef.current  = maxOrderRef.current + 1;   // resumed turns sort strictly after suspended transcript
  if (mountedRef.current) {
    setLiveState("live");               // continuity — status flickers connecting→ready (same as D reconnect)
    setStatus("connecting");            // immediate honest feedback on the tap (no "Ended" flash)
  }
  voiceEvent("caddie", "live_resume");  // §4 (foreground tap — no forced flush)
  reconnectDeadlineRef.current = setTimeout(() => {
    reconnectDeadlineRef.current = null;
    if (!cancelled && !fellBackRef.current) fallBack();
  }, MINT_DEADLINE_MS);
  const client = new RealtimeCaddieClient({ roundId, personalityId: personaId }, events); // cold; warm pool consumed mid-round
  clientRef.current = client;
  void (async () => {
    try {
      await client.start();
      if (cancelled || fellBackRef.current) return;    // Gap-2-style guard
      await client.attachMic();
      if (cancelled || fellBackRef.current) return;
      micReadyRef.current = true;
      if (mutedRef.current) client.setMuted(true);
    } catch {
      if (!cancelled && !fellBackRef.current) fallBack();
    }
  })();
};
resumeImplRef.current = doResume;       // set in the effect body; cleared to null in the effect cleanup
```
The fresh client's `connected`/`closed`/`error` are handled by the EXISTING `if (reconnectingRef.current)` sub-phase branch in `onStatus` — no new status handling. `maybeFireOpeningTurn()` there is a no-op because `openedTurnRef` is still set ⇒ **no re-greet**.

The returned resume is stable: `const resume = useCallback(() => { resumeImplRef.current?.(); }, []);`

### 3.4 Reconciling `reconnectUsedRef` (the budget) with resume — precise rule
- **Resume never CONSUMES the budget** (it does not set `reconnectUsedRef = true`). This directly satisfies the constraint "resume must NOT consume D's one-per-activation `reconnectUsedRef` budget."
- **Resume RESETS the budget to false.** Justification: `reconnectUsedRef` bounds a *silent flapping loop within one continuous automatic burst* (D's "one reconnect per activation" prevents an unbounded idle→reconnect→idle billing loop). A `resume()` is a **deliberate human tap** that delineates a NEW burst; there is no silent loop to bound across a human action. Resetting guarantees "a real network drop AFTER a resume must still get its own auto-reconnect (budget not stolen)" in ALL cases — including the sequence `drop→auto-reconnect (budget spent)→idle-suspend→resume→drop`, which without the reset would wrongly fall straight to classic. The flap bound is preserved *per burst*: within the resumed burst, exactly one auto-reconnect is still allowed, then `fallBack()`. And because resume is user-gated, no unbounded loop can form.
- **Consequence table (composition):** initial burst gets one auto-reconnect; each resume opens a fresh burst with its own one auto-reconnect. `reconnectedRef` stays `true` for the whole activation (once any cross-client transition happened), so `upsert` keeps applying `orderOffsetRef` — each new `startReconnect()`/`doResume()` recomputes `orderOffsetRef = maxOrderRef + 1`, so every successive client sorts strictly after all prior transcript. Cleanly composable.

### 3.5 Barge-in during suspend — exact semantics (constraint #6)
While `suspended`, the WebRTC socket is closed, so **there is no server VAD** and no way for speech to be detected. "Barge-in" therefore means: **the golfer taps the paused mic**, which invokes `resume()` → cold-mint → `start()` → `attachMic()`. A cold caddie client (no `withholdMic`) attaches the real mic and server VAD begins continuous listening the instant it reaches `connected`. Status then flows `connecting → connected ("Ready — go ahead") → listening ("Listening…")` as the golfer speaks. There is no opening-turn re-fire (`openedTurnRef` set). Net: **tap resume ⇒ resume AND land in listening**, one gesture, no separate barge-in path, no client-side VAD logic. This is the honest shape given a closed socket.

### 3.6 Resets
Add `suspendedRef.current = false;` to BOTH reset sites (the `!active` branch ~line 206-212 and the re-activation block ~line 229-235). `resumeImplRef.current = null;` in the effect cleanup (returned function). No other reset changes.

### 3.7 Returned interface
```
return {
  liveState,                       // now includes "suspended"
  fellBack: liveState === "fallback",
  messages, status, muted,
  toggleMute,
  resume,                          // NEW
  stop,
};
```

---

## 4. Telemetry (epic §6.5.3 / §6) — minimal, on the existing bus

Add exactly two markers via `voiceEvent(surface, event, data)` (`frontend/src/lib/voice/telemetry.ts`), emitted from the hook (import `voiceEvent`):
- `voiceEvent("caddie", "live_suspend", { flush: true })` in `suspend()`.
- `voiceEvent("caddie", "live_resume")` in `doResume()`.

Rationale and the iOS flush caveat: these are **not** the headline `eos_to_first_audio` latency event, so per the epic caveat they do not *require* immediate flush. BUT `live_suspend` fires exactly when the golfer has disengaged and is most likely to background/pocket the phone — the single moment a batched event is most likely to be dropped by the iOS "voicetel flush-drop". So `live_suspend` passes `{ flush: true }` (drains the queue immediately; `keepalive:true` is already set on the POST) as cheap insurance. `live_resume` is a foreground tap with the app in the foreground → the normal batch/`pagehide`/`visibilitychange` flush is sufficient; no forced flush. This keeps the addition minimal (two lines) while making the 90s idle-burst behavior visible on the owner's device (`journalctl -u scorecard-api | grep voicetel | grep live_`), which is the whole point of confirming the cost/idle policy end-to-end.

No `ms` field is needed (suspend/resume are discrete markers, not latency stages). No new event object fields ⇒ no telemetry-module change, no backend change.

---

## 5. `CaddieSheet.tsx` changes (consumer only)

1. **`LiveFooter` gains `paused: boolean` + `onResume: () => void`.** When `paused` (early branch), render a calm status line "Paused — tap to resume" (mono, `T.pencil` — NOT `T.warningInk`; suspend is not an error) and turn the mic button into the resume control: `onClick={onResume}`, `aria-label="Resume listening"`, calm styling (no blue "listening" accent, no alarm). The mute toggle is not shown while paused (mute is meaningless on a stopped socket). When not paused, render the EXISTING footer (status label + mute) byte-for-byte.
2. **Wire it at the footer call site** (CaddieSheet.tsx ~line 1598-1599):
   `<LiveFooter status={live.status} muted={live.muted} onToggleMute={live.toggleMute} paused={live.liveState === "suspended"} onResume={live.resume} />`
3. **No change to `liveActive`, the render swap, the classic-effect gates, or `LiveVoiceBody`.** `liveActive` already stays true during suspend (`fellBack` false), so `LiveVoiceBody` keeps rendering the preserved transcript and the classic auto-open effect stays gated off (§0). Sheet close (`onClose` → `live.stop()`, line ~1126) is unchanged and already tears down (C1) — no regression.
4. **`LIVE_STATUS_LABEL` is NOT extended** — "suspended" is a `CaddieLiveState`, not a `RealtimeStatus`, and is handled by the `paused` branch, so the map stays keyed exactly by `RealtimeStatus` (which the untouchable `realtime.ts` owns).

Edge (note for the builder, low priority / designer flag): if the sheet is suspended with an EMPTY transcript (opened, never spoke, no opening shot resolved, 90s elapsed), `LiveVoiceBody`'s empty-state still reads "Go ahead — {name} is listening." while the footer reads "Paused — tap to resume." Mildly inconsistent but benign. Optional polish: pass `paused` into `LiveVoiceBody` to swap the empty hint. Not required for Slice E; flag to designer.

---

## 6. CONSUMED — do NOT modify (and why zero edits are needed)

- `frontend/src/lib/voice/realtime.ts` — `RealtimeCaddieClient` ctor, `start`, `attachMic`, `setEvents`, `emitCurrentStatus`, `sendText`, `setMuted`, `stop`, `RealtimeStatus`/`RealtimeMessage`/`RealtimeCaddieEvents`. **Suspend uses only `setEvents({})`; resume uses only ctor + `start` + `attachMic` + `setMuted` — all existing public seams.** No new method, no gating/mic/warm code touched ⇒ **ZERO `realtime.ts` edits and ZERO pinning-test growth required.** (Explicit per constraint: if you find yourself wanting a realtime.ts "suspend-without-teardown / resume-same-socket" method — you don't need one: the IdleTimer already fully stops the socket, and resume cold-mints a fresh client that the backend re-grounds from the shared round ledger. A same-socket resume would REQUIRE a new public method + new `realtime-warm.test.ts` cases proving it no-ops before `attachMic`/`opened` and re-arms exactly once — a HARD STOP we deliberately avoid.)
- `frontend/src/lib/voice/warm-session.ts` — not used by resume (pool is consumed mid-round; always cold-mint, exactly as D).
- `frontend/src/lib/voice/realtime-ordering.ts` — `sortByOrder` consumed as-is.
- `frontend/src/lib/caddie/transport.ts` — import `MINT_DEADLINE_MS` only.
- `frontend/src/lib/voice/idle-timer.ts` — import `REALTIME_IDLE_DISCONNECT_MS` only.
- `frontend/src/hooks/useVoiceCaddie.ts` — no change (orb path frozen; D §5 established it has no analogous seam).

Guardrail (state twice): **touching `realtime.ts` warm/mic/gating code without growing `realtime-warm.test.ts` in the same commit is a HARD STOP. This slice is designed to require none.**

---

## 7. Shared-type sync check — `frontend/src/lib/types.ts` ↔ `backend/app/models.py`

**Expected NONE — confirmed.** All Slice E changes are frontend hook/component internals: a new `CaddieLiveState` string value (`"suspended"`), a new returned `resume` function, a paused/resume footer affordance, and two telemetry event STRINGS. The telemetry markers ride the existing `POST /api/voice/telemetry` bus whose `event` field is a free-form `str` with no enum (`backend/app/routes/voice.py:208-235`), so no model change. `StartRealtimeSessionResponse` (`routes/realtime.py`) is untouched — resume cold-mints through the same existing mint endpoint. No API surface, no new fields ⇒ `frontend/src/lib/types.ts` ↔ `backend/app/models.py` remain byte-identical. **Confirmed NONE.**

---

## 8. Edge cases & risks

- **Idle misclassification** (inherited from D §3, best-effort): a real drop after ~90s of genuine silence is classified as clean-idle and suspends instead of auto-reconnecting. Worst case is a benign paused state with a one-tap resume — never a dead sheet. Acceptable and documented.
- **Double-tap resume / re-entrancy** — guarded by `if (!suspendedRef.current) return;` + `if (reconnectingRef.current) return;` ⇒ exactly one cold-mint, exactly one `attachMic` ⇒ **no double-mic**. (DOM-side, the resume button unmounts the instant `liveState` leaves `"suspended"`, a second barrier.)
- **Resume racing sheet-close/deactivation** — every resume `await` is guarded by `cancelled || fellBackRef.current`; effect cleanup sets `cancelled`, clears `reconnectDeadlineRef`, nulls `resumeImplRef`, stops the client.
- **Suspend racing a real drop** — mutually exclusive: clean-idle → `suspend()`, drop → `startReconnect()`; both classified by the same single `isCleanIdle` test on one `'closed'` event.
- **Mute across suspend/resume** — `mutedRef` re-applied after the resume client's `attachMic` (same as D).
- **Order scramble across suspend/resume** — `orderOffsetRef = maxOrderRef + 1` recomputed at each `doResume()`; `reconnectedRef` keeps `upsert` applying it. Pinned by the ordering test.
- **Resume failure** (mint-timeout via `reconnectDeadlineRef`, or fresh client `closed`/`error`) → `fallBack()` → classic tap-to-talk with the preserved transcript (D's `convHistory` seed already fires on the post-connected fallback transition) and no re-greet. Never a dead sheet.
- **Budget composition** (§3.4) — resume resets `reconnectUsedRef`; each burst keeps its one-shot auto-reconnect; human-gated so no unbounded loop.
- **Telemetry never breaks dictation** — `voiceEvent` swallows all errors by contract; `live_suspend` forced flush is fire-and-forget with `keepalive`.
- **Close/teardown regression (C1)** — untouched: `stop()`/effect-cleanup null a possibly-already-null `clientRef` (no-op) and reset `suspendedRef`. Verified no new path leaves a live socket on close.
- **NORTHSTAR consistency** — suspended is an HONEST visible state (not a fake "Listening…"), calm yardage-book copy, no alarm/toast, one quiet resume affordance. Aligns with the no-fake-data lesson the epic cites.

---

## 9. Tests — extend `frontend/src/components/CaddieSheet.realtime.test.tsx`

Deterministic only, reusing the file's existing hoisted `FakeRealtimeCaddieClient` (`instances`, `pendingStartImpls`, `emitStatus`/`emitMessage`/`emitError`), `warmSessionMock`, the `flush()` microtask helper, and fake timers where noted. `sortByOrder` stays real. Add a hoisted `voiceEventSpy` to the existing `@/lib/voice/telemetry` mock (currently `voiceEvent: vi.fn()`) so suspend/resume markers are assertable. New `describe("CaddieSheet live mode — Slice E idle suspend/resume")`:

1. **idle → suspend sets the visible paused state and keeps messages.** Fake timers: cold-mint → `emitStatus('connected')` → feed two ordered messages → `advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS)` (Date advances with it) → `emitStatus('closed')`. Assert: `instances.length === 1` (no reconnect mint); `getByLabelText("Resume listening")` present; `getByText("Paused — tap to resume")` present; `queryByLabelText("Mute")` null; `queryByText("Tap-to-talk mode")` null; both transcript bubbles still on screen; `voiceEventSpy` called with `("caddie","live_suspend", { flush: true })`.
2. **suspend → resume → live, no re-greet, order offset applied.** From (1) suspended, `fireEvent.click(getByLabelText("Resume listening"))` → `await flush()`. Assert: a SECOND instance minted (`instances.length === 2`), `start`+`attachMic` each called once on it, `sendText` NOT called on it, `resolveOpeningShot` still called once total; `voiceEventSpy` saw `("caddie","live_resume")`. Then `emitStatus('connected')` on instance[1], feed fresh order-1,2 messages → assert DOM bubble order = `[old1, old2, new1, new2]`; footer back to live (`getByLabelText("Mute")` present, no "Paused" text).
3. **resume does NOT double-attach mic (double-tap guard).** From suspended, two synchronous `fireEvent.click` on the resume button inside one `act()`. Assert `instances.length === 2` (not 3) and `attachMic` called exactly once on the new instance.
4. **suspend → resume → suspend-again cycle.** (1)→(2) to live on instance[1], feed a message, then `advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS)` + `emitStatus('closed')` on instance[1]. Assert: back to suspended (`getByLabelText("Resume listening")` present), `instances.length === 2` (second suspend mints nothing), instance[1] `setEvents({})` called, transcript preserved, no "Tap-to-talk mode".
5. **resume FAILURE → classic fallback.** Use `renderControlledSheet`. From suspended, tap resume → instance[1], then `emitStatus('closed')` on instance[1] (or advance past `MINT_DEADLINE_MS` before its `connected`). Assert `getByLabelText("Start recording")` present, `getByText("Tap-to-talk mode")` present, preserved pre-suspend transcript still visible (via the D `convHistory` seed), `resolveOpeningShot` called once (no re-greet).
6. **real drop AFTER a resume still gets its own auto-reconnect (budget not stolen).** cold-mint instance[0] → connected → idle-suspend → resume → instance[1] connected → then `emitStatus('closed')` SHORTLY after activity (tiny elapsed ⇒ classified drop) on instance[1]. Assert a THIRD instance minted (`instances.length === 3`, the auto-reconnect), no "Tap-to-talk mode". **Definitive variant** proving the reset: instance[0] connected → real drop → auto-reconnect instance[1] (budget spent) → connected → idle-suspend → resume → instance[2] connected → real drop → auto-reconnect instance[3] (`instances.length === 4`).

Do NOT weaken existing suites. The Slice-D "clean idle close does NOT reconnect or fall back" test (current lines 625-656) stays GREEN — its assertions (no reconnect mint, no "Tap-to-talk mode", transcript shown, `sendText` not re-fired) all still hold; Slice E only ADDS the paused affordance it never asserted against. `CaddieSheet.handsfree.test.tsx` / `CaddieSheet.session.test.tsx` (classic path, flag world unchanged) must pass unmodified.

---

## 10. Files to touch (precise)

- `frontend/src/hooks/useCaddieLiveSession.ts` — add `"suspended"` to `CaddieLiveState`; new `suspendedRef` + `resumeImplRef`; `suspend()` useCallback; `doResume()` closure in the effect wired to `resumeImplRef`; the one-line `onStatus` clean-idle change (`isCleanIdle` → `suspend()`); reset `suspendedRef` at both reset sites and null `resumeImplRef` in cleanup; import + emit `voiceEvent`; return `resume`.
- `frontend/src/components/CaddieSheet.tsx` — `LiveFooter` gains `paused` + `onResume` (paused branch renders "Paused — tap to resume" + `aria-label="Resume listening"` calm mic button, no mute); wire `paused={live.liveState === "suspended"}` + `onResume={live.resume}` at the footer call site. No other change.
- `frontend/src/components/CaddieSheet.realtime.test.tsx` — hoisted `voiceEventSpy`; the six §9 describes.
- **Not touched:** `realtime.ts`, `warm-session.ts`, `realtime-ordering.ts`, `transport.ts`, `idle-timer.ts`, `useVoiceCaddie.ts`, `live-mode-pref.ts`, `frontend/src/lib/types.ts`, all backend, all shared types.

---

## 11. Gate commands (exact — from epic §7 / Slice D §10; frontend-only slice)

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && npx vitest run src/components/CaddieSheet.realtime.test.tsx
cd frontend && npx vitest run          # full: new + classic sheet + all voice
# Pinning tests must stay GREEN, unmodified:
cd frontend && npx vitest run src/lib/voice/realtime-warm.test.ts src/lib/voice/warm-session.test.ts src/lib/voice/realtime-dispatch.test.ts src/lib/caddie/transport.test.ts
cd frontend && npx vitest run src/components/CaddieSheet.handsfree.test.tsx src/components/CaddieSheet.session.test.tsx
cd backend && ruff check .             # no backend change this slice; expected clean/no-op
```
No backend `pytest` change is required (no backend code touched). Before PR ready (new user-facing capability on an authed transport path — CLAUDE.md): `/code-review` and `/security-review`. Final gate: owner on-device "ship it" (WebRTC/VAD/idle-burst are device-only verifiable; CI is deterministic-mock).
