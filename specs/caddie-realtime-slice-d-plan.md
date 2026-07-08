# Caddie Realtime — Slice D Implementation Plan (flag-default-OFF, SILENT rider)

Parent: `specs/caddie-realtime-slice-c1-plan.md`. Slice D closes the two reviewer-logged gaps in the flag-gated (`looper.caddieLiveMode`, default OFF) live caddie mode. Classification: SILENT — flag stays default-OFF, classic path byte-for-byte unchanged. **Zero edits** to `realtime.ts` / `warm-session.ts` / `realtime-ordering.ts`; **no change** to `useVoiceCaddie.ts` (verified below). Primary file: `frontend/src/hooks/useCaddieLiveSession.ts`; small consumer change in `CaddieSheet.tsx`; tests grow in `CaddieSheet.realtime.test.tsx`.

## 0. Facts established by reading the code

- **realtime.ts collapses idle-close and drop into one signal.** A network drop routes `onconnectionstatechange` (`failed`/`disconnected`/`closed`) → `setStatus('closed')`. The 90s idle auto-disconnect routes `IdleTimer.onExpire` → `this.stop()` → `cleanup()` → `setStatus('closed')`. **Both surface as `'closed'`; there is NO clean-vs-unexpected discriminator on the public event surface.** `'error'` is separate (getUserMedia/SDP/DC error) and is always unexpected. The internal `IdleTimer.isArmed()` is not reachable from the hook. This is the honest constraint driving §3.
- **fallBack() does NOT wipe `messages`** (hook lines 102–110). The only place `setMessages([])` runs is the `active`-goes-false reset (line 151) and the re-activation reset (line 163). On fallback, `active` stays true (`wantLive && navigator.onLine` both hold), so the hook preserves `messages`. **But** `CaddieSheet` renders classic `VoiceBody` (fed by `convHistory`, not `live.messages`) once `liveActive` goes false, so the preserved transcript is *invisible* after fallback — the real continuity gap (§4).
- **openedTurnRef persists** — never reset except on (re)activation. Reusing it across a reconnect gives the "don't re-greet mid-round" behavior for free.
- **Resurrection (Gap 2) is real in this hook** and only here (cold branch: `await start(); if(cancelled) return; await attachMic()`), because `cancelled` is set only by effect-cleanup, not by `fallBack()`.
- **useVoiceCaddie has no analogous two-step await→attachMic seam** (verified, §5) — no change needed there.

## 1. Scope

- **Gap 1** — post-connected unexpected drop → ONE quiet cold-mint reconnect; success resumes live (transcript preserved, no re-greet); failure/deadline → classic fallback in-place (transcript preserved & readable, mic usable). Clean 90s idle close is distinguished (best-effort) and does NOT reconnect/fall back.
- **Gap 2** — short-circuit on `fellBackRef.current` (not just `cancelled`) after every `await` in both warm and cold branches, killing the in-flight-`start()` resurrection.

Nothing else.

## 2. Reconnect state machine

### New refs (hook)
- `reconnectUsedRef: boolean` — **one reconnect per activation** guard (see policy note).
- `reconnectingRef: boolean` — true while a reconnect attempt is in flight (from `startReconnect()` until the new client reports `connected` or we fall back).
- `reconnectedRef: boolean` — true once a reconnect has begun this activation; gates the order-offset in `upsert` (see §2.3).
- `reconnectDeadlineRef: ReturnType<typeof setTimeout> | null` — reconnect connect budget (`MINT_DEADLINE_MS`, justified §2.4).
- `lastActivityAtRef: number` — `Date.now()` of last observed activity; idle-mirror clock (§3).
- `orderOffsetRef: number` and `maxOrderRef: number` — cross-client transcript-ordering fix (§2.3).
- `mutedRef: boolean` — mirror of `muted` so mute survives reconnect.

No new `liveState` value. During reconnect we **keep `liveState:'live'`** (so `liveActive` stays true, `LiveVoiceBody` keeps showing the preserved bubbles, and `LiveFooter` reflects the fresh client's `connecting → connected`). Reconnect is an internal sub-phase tracked by refs, not a render state. Reason: the calm yardage-book feel wants continuity, not a new "Reconnecting…" chrome. The only user-visible signal is the existing status label flickering back through "Connecting…" → "Ready — go ahead".

### 2.1 Transition table (post first-connect; `everConnectedRef=true`)

| From (refs) | Event | Guard | Action | To |
|---|---|---|---|---|
| live, `reconnecting=false` | `onStatus('closed')` | `Date.now()-lastActivity ≥ IDLE_THRESHOLD` (clean idle) | none — rest calmly (no reconnect, no fallback); leave `liveState:'live'`, status shows "Ended" | resting |
| live, `reconnecting=false` | `onStatus('closed')` | else (drop) AND `!reconnectUsedRef` | `reconnectUsedRef=true`; `startReconnect()` | reconnecting |
| live, `reconnecting=false` | `onStatus('error')` | `!reconnectUsedRef` (error is always a drop) | `reconnectUsedRef=true`; `startReconnect()` | reconnecting |
| live, `reconnecting=false` | `closed`/`error` | `reconnectUsedRef` already true | `fallBack()` | fallback |
| reconnecting | `onStatus('connected')` | — | clear `reconnectDeadline`; `reconnecting=false`; `setLiveState('live')`; re-apply `mutedRef`; `maybeFireOpeningTurn()` → **no-op** (openedTurnRef set) | live |
| reconnecting | `onStatus('closed'/'error')` from new client | — | `fallBack()` | fallback |
| reconnecting | `reconnectDeadline` fires before `connected` | — | `fallBack()` | fallback |
| any post-connect | `active→false` / unmount / `stop()` | — | reset all refs, clear timers, stop client, clear messages | idle |

Add, immediately after the existing `if (cancelled || !mountedRef.current) return;` at the top of `onStatus`: `if (fellBackRef.current) return;` — once fallen back we ignore all further statuses (including the `'closed'` that `fallBack()`'s own `stop()` emits), preventing re-entrancy.

### 2.2 `startReconnect()` (a closure defined inside the activation effect, reusing `events`, `roundId`, `personaId`, `cancelled`)

```
reconnectingRef.current = true;
reconnectedRef.current  = true;
orderOffsetRef.current  = maxOrderRef.current + 1;     // §2.3
// Detach the DEAD client's handlers BEFORE stopping it, so its stop()->'closed'
// does not re-enter onStatus and get misread as a reconnect failure.
const dead = clientRef.current;
dead?.setEvents({});          // public seam, already used elsewhere
dead?.stop();
reconnectDeadlineRef.current = setTimeout(() => {
  reconnectDeadlineRef.current = null;
  if (!cancelled && !fellBackRef.current) fallBack();
}, MINT_DEADLINE_MS);
const client = new RealtimeCaddieClient({ roundId, personalityId: personaId }, events); // cold; warm pool consumed
clientRef.current = client;
try {
  await client.start();
  if (cancelled || fellBackRef.current) return;        // Gap-2-style guard
  await client.attachMic();
  if (cancelled || fellBackRef.current) return;
  micReadyRef.current = true;                          // already true; kept uniform
  if (mutedRef.current) client.setMuted(true);
} catch {
  if (!cancelled && !fellBackRef.current) fallBack();
}
```

Do NOT reset `everConnectedRef`, `openedTurnRef`, `micReadyRef`, or `messages`. The new client's `connected` is handled by the reconnecting branch in the table (clears the deadline). We do NOT rely on `takeWarm` (pool already consumed mid-round) — always cold mint.

### 2.3 Cross-client transcript ordering (risk the requirement flags)
Each `RealtimeCaddieClient` owns a private `MessageOrderTracker` that resets on `cleanup()`. A fresh reconnect client hands out `order` values restarting near 0, which `sortByOrder` would place **before** the preserved pre-drop turns → scrambled transcript. Fix, entirely in the hook's `upsert` (no `realtime.ts` edit):
- Track `maxOrderRef = max(maxOrderRef, order)` on every upsert.
- At `startReconnect()` set `orderOffsetRef = maxOrderRef + 1`.
- In `upsert`, when `reconnectedRef.current`, apply the offset to the incoming message before merge/sort: `m = { ...m, order: m.order + orderOffsetRef.current }`. Pre-drop messages already in state keep their stored order; every post-reconnect message (including partial→final updates of the same id) gets the same constant offset, so intra-turn skew-fix is preserved and the whole new session sorts strictly after the old.

Because we cap at one reconnect per activation, a single fixed offset suffices.

### 2.4 Reconnect deadline = `MINT_DEADLINE_MS` (3s), reused
The reconnect is the identical cold-mint operation as the first connect, so the same 3s budget applies. A longer budget would let the sheet hang mid-round (reads as a dead sheet, violates never-dead); 3s honours the calm-fast-degrade contract and reuses the constant the tests already drive (`advanceTimersByTime(3000)`). No new magic number.

### One-reconnect policy (justification)
"One reconnect per activation," not "per drop," to bound the worst case: a flapping signal that connects-then-drops must not spawn an unbounded silent re-mint loop (billing + churn). First unexpected post-connect drop gets the single quiet reconnect; any subsequent drop (or the reconnect's own failure) falls to classic tap-to-talk, which is itself resilient. This is the calmest bounded behavior and matches "attempt ONE quiet reconnect."

## 3. Clean-idle vs unexpected drop (the subtle part) — honest best-effort

**realtime.ts exposes no discriminator** (§0). We therefore implement a **hook-local idle mirror**: `lastActivityAtRef = Date.now()` updated on every observed activity — each non-terminal `onStatus` (`connected`/`listening`/`speaking`), each `onMessage` (in `upsert`), the opening-turn `sendText`, and `toggleMute`-unmute — seeded on first `connected`. On a post-connect `'closed'`:
- `Date.now() - lastActivityAtRef ≥ REALTIME_IDLE_DISCONNECT_MS - IDLE_MARGIN_MS` (import the public `REALTIME_IDLE_DISCONNECT_MS` from `@/lib/voice/idle-timer`; `IDLE_MARGIN_MS ≈ 1500` to absorb same-tick skew) ⇒ **clean idle** ⇒ rest (no reconnect, no fallback).
- else ⇒ **unexpected drop** ⇒ reconnect path.
- `'error'` ⇒ always unexpected (idle never routes through `error`).

Why this is sound, not a guess: a genuine idle-disconnect can only occur after ≥90s during which the hook observed **no** messages and no status changes (the same silence realtime.ts's own `IdleTimer` measured — during true silence there is no data-channel traffic to `touch()` either), so both clocks advance together and the mirror reliably elapses. Documented imperfection (acceptable, SILENT, device-only): a real drop occurring after ~90s of genuine silence is classified as idle and left to rest — but at that point the golfer has disengaged, so ending is the benign outcome. Chosen over "reconnect on every close" precisely to avoid the idle→reconnect→idle→reconnect billing loop the requirement warns about. Timestamp comparison (not a second `setTimeout`) is used deliberately so classification is independent of callback-ordering races with realtime.ts's real idle timer; under vitest fake timers `Date.now` advances with `advanceTimersByTime`, so it stays scheduler-controlled and deterministic.

Resting-state note: on clean idle close we keep `liveState:'live'` with the preserved transcript and the existing calm "Ended" label. Improving idle-resting copy/affordance is explicitly out of Slice D scope.

## 4. `CaddieSheet.tsx` — fallback continuity + no re-greet (the C1 fallback fix)

Verified: the hook never wipes `messages` on fallback; the loss is purely a render gap — after `fellBack`, `liveActive` is false and the classic `VoiceBody` (fed by `convHistory`, empty in live mode) renders, hiding the preserved live transcript. Two coupled fixes, both behind `wantLive` (flag-off path untouched):

1. **Seed `convHistory` once on the post-connected fallback transition** so the classic `VoiceBody` renders the prior conversation as history and new tap-to-talk turns append into one coherent stream. New effect (guarded by a `seededFallbackRef`, fires once per activation) that runs when `showFallbackIndicator` flips true AND `live.messages.length > 0` AND `convHistory.length === 0`:
   `onUpdateConvHistory(live.messages.filter(m => !m.partial && m.text.trim()).map(m => ({ role: m.role, content: m.text })))` — maps `RealtimeMessage`→`VoiceCaddieMessage {role:'user'|'assistant', content}` (shapes confirmed in `lib/caddie/types.ts`). No duplication risk: the live hook never wrote to `convHistory`.
2. **Suppress the classic auto-opening turn after a live drop** so fallback never re-greets mid-round. Add a `liveTranscriptSeenRef` (set true whenever `live.messages.length > 0` this activation) and early-return from the existing classic auto-open effect (CaddieSheet ~line 738/743) when it is set. This is race-free even before the seed propagates (the seeded non-empty `convHistory` also independently suppresses it — belt and suspenders). Reset `seededFallbackRef`/`liveTranscriptSeenRef` when the sheet closes / `wantLive` goes false.

Result: mid-round drop → (reconnect succeeds → seamless live) OR (reconnect fails → classic tap-to-talk with the full prior conversation visible, "Tap-to-talk mode" label, working mic, no re-greet). Never a dead sheet; no toast.

The reconnect-success path needs no CaddieSheet change: `liveActive` stays true throughout, `LiveVoiceBody` keeps rendering `live.messages`, new offset-ordered turns append.

## 5. `useVoiceCaddie.ts` — assessed, NO change (shipped orb path stays frozen)

- `startBurst`: `client.start().catch(...)` has **no** `.then(attachMic)` continuation (the cold `start()` acquires the mic internally in `realtime.ts`). A degrade during a pending `start()` runs `teardownClient()` (stop); when `start()` later settles, nothing runs on success and `.catch` only (idempotently) degrades. No attachMic-after-stop ⇒ **no resurrection**.
- `adoptWarmClient`: `attachMic().then(() => setMuted(...))` — `setMuted` post-cleanup is inert (`localStream` null ⇒ no-op) and never rebuilds a peer connection; `attachMic` on a torn-down client throws (null `micTransceiver`) into the no-op `.catch`. **No resurrection.**

So the resurrection guard does not apply. Per the requirement's steer, we make **zero** changes to `useVoiceCaddie.ts`; its indirect pinning coverage (`transport.test.ts`, `warm-session.test.ts`, `realtime-warm.test.ts`, `realtime-dispatch.test.ts`) stays green untouched.

## 6. Shared-types check
N/A. All changes are frontend hook/component internals. No API surface, no new fields ⇒ `frontend/src/lib/types.ts` ↔ `backend/app/models.py` untouched; `StartRealtimeSessionResponse` untouched. Confirmed.

## 7. Consumed, do NOT modify
`realtime.ts` (`RealtimeCaddieClient`, `setEvents`, `attachMic`, `sendText`, `setMuted`, `stop`, `emitCurrentStatus`, types), `warm-session.ts`, `realtime-ordering.ts` (`sortByOrder`), `idle-timer.ts` (import `REALTIME_IDLE_DISCONNECT_MS` only), `transport.ts` (import `MINT_DEADLINE_MS` only). If any seam edit becomes unavoidable it is a HARD STOP requiring the matching pinning test to grow in the same commit — this slice is designed to need none.

## 8. Tests — extend `frontend/src/components/CaddieSheet.realtime.test.tsx`

Reuse the file's existing hoisted `FakeRealtimeCaddieClient` (drive `emitStatus`/`emitMessage`/`emitError`), `warmSessionMock`, fake timers, and the `flush()` microtask helper. `sortByOrder` stays real. New describes:

1. **drop → reconnect SUCCESS.** Cold-mint (instance[0]) → `emitStatus('connected')` → feed two ordered messages (order 1,2). `emitStatus('closed')` shortly after activity (real timers, tiny elapsed ⇒ classified drop). Assert a **second** `FakeRealtimeCaddieClient` is constructed (`instances.length===2`), `start`+`attachMic` called once on it. `emitStatus('connected')` on instance[1], feed new messages (fresh order 1,2). Assert: DOM bubble order = `[old1, old2, new1, new2]` (offset works); `sendText` NOT called again (no re-greet); no "Tap-to-talk mode".
2. **drop → reconnect FAIL → classic fallback.** As above through the second instance, then either advance fake timers past `MINT_DEADLINE_MS` before its `connected`, OR `emitStatus('closed')` on instance[1]. Assert `getByLabelText("Start recording")` present, `getByText("Tap-to-talk mode")` present, and the pre-drop transcript text still on screen (preserved via `convHistory` seed).
3. **fallback-during-pending-start (Gap 2).** Make instance[0].`start` return a manually-controlled deferred promise. Trigger fallback while pending (advance past `MINT_DEADLINE_MS`), then resolve `start`. Assert `attachMic` was **never** called on instance[0] (no resurrection), stays fallen-back (classic mic present), and no second instance is minted from the continuation.
4. **clean idle close does NOT reconnect/fall back.** Fake timers: cold-mint, `emitStatus('connected')`, `advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS)` (Date advances with it), then `emitStatus('closed')`. Assert `instances.length===1` (no reconnect mint), no "Tap-to-talk mode", transcript still shown, `sendText` not re-fired.

C1 invariants each change could threaten, and the pin:
- *Warm-path untouched:* reconnect uses cold `new RealtimeCaddieClient` only; existing adopt-warm test (§C1 test 1) unchanged and still asserts `attachMic` exactly once on the adopted warm client.
- *No double-mic / no resurrection:* Gap-2 guard + test 3; plus the fallback path stops the dead client (`setEvents({})`+`stop()`) before minting.
- *Never-dead:* tests 2 & 4 assert a working classic mic or a live transcript is always present; existing fallback trio (mint-timeout / connect-fail / mic-deny) unchanged.
- *Silent-rider:* flag-OFF test unchanged; all Slice D code sits behind `wantLive`. `CaddieSheet.handsfree.test.tsx` / `CaddieSheet.session.test.tsx` must pass unmodified.

## 9. Edge cases & risks
- **Double reconnect / flap loop** — bounded by `reconnectUsedRef` (one per activation); second drop → fallback.
- **Reconnect racing sheet-close/deactivation** — every reconnect `await` guarded by `cancelled || fellBackRef`; effect cleanup sets `cancelled`, clears `reconnectDeadlineRef`, stops the client.
- **Dead client's stop() re-entering onStatus** — `setEvents({})` before `stop()` in `startReconnect`, plus the `fellBackRef` early-return in `onStatus`.
- **Mute across reconnect** — `mutedRef` re-applied after the new `attachMic`.
- **Opening-turn re-fire** — `openedTurnRef` never reset across reconnect ⇒ `maybeFireOpeningTurn()` is a no-op on reconnect; classic re-greet suppressed by `liveTranscriptSeenRef` + seeded `convHistory`.
- **Message ordering across two clients** — §2.3 offset; pinned by test 1.
- **Idle misclassification** — documented best-effort (§3); worst case is a benign rest, never a dead sheet.
- **convHistory seed** — one-shot, guarded on empty `convHistory`; live hook never populated it, so no dup; persists across sheet close (desired continuity).

## 10. Gates (exact)
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
Before PR ready (authed transport path): `/code-review` and `/security-review`.

## 11. Files to touch (precise)
- `frontend/src/hooks/useCaddieLiveSession.ts` — reconnect state machine (new refs, `startReconnect`, idle-mirror classification, cross-client order offset, `fellBackRef` guards after each await in warm+cold branches, `mutedRef`).
- `frontend/src/components/CaddieSheet.tsx` — one-shot `convHistory` seed on post-connected fallback; `liveTranscriptSeenRef` gate on the classic auto-open effect; reset on close. (No change to the live render/footer for the success path.)
- `frontend/src/components/CaddieSheet.realtime.test.tsx` — 4 new deterministic describes (§8).
- **Not touched:** `useVoiceCaddie.ts` (§5), `realtime.ts`, `warm-session.ts`, `realtime-ordering.ts`, `idle-timer.ts`, `transport.ts`, types/backend.
