# Fix: iOS voice telemetry flush-dropped (backlog: fix-ios-voicetel-flush-dropped)

Status: ready to build. Silent (telemetry-only, no app-visible change). Rides bundle PR #109.
Branch base: `integration/next`.

## Problem

Voice telemetry is near-blind on iOS (Capacitor WKWebView): ~1 event / 4 hours despite heavy
use. When the app backgrounds/suspends, queued telemetry events are dropped before the batch
flush fires, so downstream work (latency stage-timings, device verification) has no trustworthy
device telemetry.

Current flush triggers in `frontend/src/lib/voice/telemetry.ts`:
- `FLUSH_AT_COUNT = 12` events queued, OR
- an 8s (`FLUSH_AFTER_MS`) `setTimeout`, OR
- `document` `visibilitychange` → `hidden`.

There is **no `pagehide` listener**. Failure/important events only batch (they wait for the
timer/count), so on iOS they are exactly the events most likely to die on suspend. All flush
paths already swallow errors, and `flushVoiceEvents()` splices and POSTs the **entire** queue.

## Security decision (explicit) — RECOMMEND OPTION A

Two ways to make events survive WKWebView suspension:

- **Option A — no new unauthenticated surface.** Keep the authenticated
  `fetch(..., { keepalive: true })` transport everywhere (it already carries the Clerk Bearer via
  `authHeaders()`). The fix is two parts: (1) **extend the immediate-flush tier to failure
  events** so they flush the whole queue *while the app is still foregrounded and alive*, and
  (2) **add a `pagehide` listener** (in addition to `visibilitychange`) that flushes via the same
  authenticated keepalive fetch.
- **Option B — `navigator.sendBeacon`.** Survives suspension but **cannot set an `Authorization`
  header**, so it forces a token into the body/URL and a new non-header auth path on the endpoint:
  replayable beacon bodies, a new unauthenticated-ish surface needing strict validation +
  rate-limiting + no-PII guarantees.

**Recommendation: Option A.** The dominant loss today is failure events (`mic_error`,
`live_start_failed`, `live_unsupported`, `resolved_fallback`, `speak_failed`, `prime_failed`)
that happen **while the app is in active use (foregrounded)** but sit in the queue until an 8s
timer that never gets to fire before suspend. Flushing those immediately — and, because
`flushVoiceEvents()` drains the whole queue, dragging every batched ride-along event out with
them — captures the vast majority of currently-dropped telemetry with **zero new attack
surface and zero auth change**. `pagehide` + authenticated keepalive fetch closes most of the
remaining background-transition gap. Option B buys only the narrow "event generated purely while
already suspending, with no prior foreground flush" case, at the cost of real attack surface.
That trade is not worth it here.

Honest residual gap of Option A: a keepalive fetch on `pagehide` is best-effort; WKWebView may
still drop it on a hard suspend, and an event created for the very first time during backgrounding
with nothing already queued could be lost. This is acceptable and far better than today. **Do not
implement Option B in this task.** If a future task revisits Option B, it MUST fully specify the
strict body/URL-token validation, per-user rate-limiting, no-PII payload contract, and an argument
for why header auth is still preserved on the primary path — and be routed through
`/security-review`. This plan does none of that because it does not need to.

This plan makes **no backend change** and **no auth change**. `frontend/src/lib/types.ts` ↔
`backend/app/models.py` stay untouched (the telemetry payload shape lives only in `telemetry.ts`
and `backend/app/routes/voice.py`, and does not change — see "Payload shape" below).

## Invariant (non-negotiable)

Telemetry can NEVER throw into or slow dictation/audio. Every path swallows. The realtime
warm-path is untouchable. All new code lives inside existing `try {} catch {}` swallow blocks and
uses `void flushVoiceEvents()` (fire-and-forget, never awaited by a caller on the warm path).

---

## Changes

### 1. `frontend/src/lib/voice/telemetry.ts` (primary)

**a. Add an immediate-flush flag to `voiceEvent`.** Extend the `data` param with an optional
`flush?: boolean`. When set, the event is queued and then the whole queue is flushed immediately
(fire-and-forget). The flag is a control signal only — it is NOT part of the queued/POSTed event
object (the push already picks only `detail` and `ms`, so the payload shape is unchanged).

Replace the body of `voiceEvent` with (structure, not verbatim):

```ts
export function voiceEvent(
  surface: string,
  event: string,
  data?: { detail?: string; ms?: number; flush?: boolean },
): void {
  try {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ surface, event, detail: data?.detail, ms: data?.ms }); // flush NOT included
    if (data?.flush) {
      void flushVoiceEvents();            // drains the WHOLE queue now (ride-alongs included)
    } else if (queue.length >= FLUSH_AT_COUNT) {
      void flushVoiceEvents();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => void flushVoiceEvents(), FLUSH_AFTER_MS);
    }
  } catch {
    /* telemetry must never break the caller */
  }
}
```

Notes: keep `queue.push({ surface, event, detail: data?.detail, ms: data?.ms })` exactly so
`flush` cannot leak into the POST body. `flushVoiceEvents()` already clears `flushTimer`, so an
immediate flush also cancels any pending batch timer — correct.

**b. Add a `pagehide` listener** alongside the existing `visibilitychange` one. `pagehide` is the
event WKWebView actually fires on app background/suspend that `visibilitychange` can miss. Scope
it to `window` (per the test-scheduler lesson — keep stubs/listeners on `window.*`), guarded for
SSR:

```ts
// Existing visibilitychange listener stays as-is (document, → hidden).
if (typeof window !== "undefined") {
  // pagehide is the reliable iOS/WKWebView background/suspend signal.
  window.addEventListener("pagehide", () => void flushVoiceEvents());
}
```

Double-firing (`visibilitychange` then `pagehide`) is harmless: `flushVoiceEvents()` on an empty
queue returns early. The existing keepalive on the fetch is what lets the `pagehide` flush survive
navigation/close — keep it.

**c. Do NOT change** `flushVoiceEvents`, `FLUSH_*`, `MAX_QUEUE`, `authHeaders` usage, or the
`keepalive: true` fetch. Auth header stays on every POST.

### 2. `frontend/src/lib/voice/caddie-turn-timing.ts` — NO CHANGE

It already flushes immediately at `markFirstAudio()` via its injected `flush` (default
`flushVoiceEvents`). Its immediate-headline behavior and tests must keep passing untouched. Do not
refactor it to use the new `flush` flag — leave the existing caller-layer flush as-is.

### 3. Failure/important call sites — add `flush: true`

These events happen while the app is foregrounded and alive; flushing immediately drains them plus
every batched ride-along. Only add the flag — do not change control flow, ordering, or the
swallow behavior.

**`frontend/src/hooks/useLooperDictation.ts`** (4 sites):
- `live_start_failed` (currently `voiceEvent(surface, "live_start_failed")`) → add `{ flush: true }`.
- `live_unsupported` → add `{ flush: true }`.
- `mic_error` (currently `{ detail }`) → `{ detail, flush: true }`.
- `resolved_fallback` (currently `{ ms }`) → `{ ms, flush: true }` (fallback path = live failed;
  a high-signal reliability event worth immediate flush).

Leave `live_start_ok` and `resolved_live` batched (success path, low urgency) — do NOT add flush.

**`frontend/src/hooks/useSheetTTS.ts`** (3 sites):
- `speak_failed` in `playItem` (play() catch) → `{ detail, flush: true }`.
- `speak_failed` in `enqueueInternal` (synth catch) → `{ detail, flush: true }`.
- `prime_failed` (both catch sites in `unlock`) → `{ detail, flush: true }`.

All of these already pass a `{ detail }` object, so the change is adding one key. No new imports.

### 4. Backend — NO CHANGE

`backend/app/routes/voice.py` `voice_telemetry` stays exactly as-is: auth required via
`current_user_id`, 40-event cap, field truncation, never throws. Option A introduces no
unauthenticated surface, so there is nothing to add. `ruff` gate only needs to run if you touch
backend — you do not, so it is not required for this task (kept in the gate list for completeness
in case a stray edit sneaks in).

### Payload shape (unchanged — do not touch types)

Frontend queued/POSTed object: `{ surface, event, detail?, ms? }`. Backend
`VoiceTelemetryEvent`: `surface, event, detail?, ms?`. The new `flush` flag never enters the
payload. Therefore `frontend/src/lib/types.ts` and `backend/app/models.py` require no edits and
must not be changed.

---

## Tests (deterministic — control the scheduler, never real `setTimeout`)

Create `frontend/src/lib/voice/telemetry.test.ts`. Because `telemetry.ts` registers
`document`/`window` listeners at import time, this file MUST run under jsdom:

```ts
// @vitest-environment jsdom
```

Setup:
- `vi.mock("@/lib/api", () => ({ API_BASE: "http://test.local", authHeaders: vi.fn(async () => ({ Authorization: "Bearer test-token" })) }))` — avoids Clerk entirely and lets us assert the header.
- `const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))`; assign `globalThis.fetch = fetchMock` in `beforeEach`; `fetchMock.mockReset()` per test (re-set default impl).
- Import the module **once** at top (`import { voiceEvent, flushVoiceEvents } from "./telemetry"`). Do NOT `resetModules()` per test — re-importing would re-register duplicate `visibilitychange`/`pagehide` listeners and make flush counts nondeterministic. The module queue is singleton state; reset it between tests by draining: in `afterEach`, set `fetchMock` to a resolver, `await flushVoiceEvents()` to empty the queue, then `vi.useRealTimers()`.
- Awaiting the fire-and-forget flush: `flushVoiceEvents` awaits `authHeaders()` then `fetch`, so use `await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(N))` under **real** timers for the trigger assertions. For the batch-timer test, use fake timers only to fast-forward the 8s wait, then switch back before waiting on the mock (pattern below). Never wait on a real 8s wall-clock.

Required cases:

1. **Batch timer flushes non-immediate events (deterministic, no real 8s wait).**
   `vi.useFakeTimers()`; `voiceEvent("dictation", "resolved_live", { ms: 10 })`; assert
   `fetchMock` NOT called; `vi.advanceTimersByTime(FLUSH_AFTER_MS)` (8000); `vi.useRealTimers()`;
   `await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))`. Assert POST body contains
   the one event.

2. **Count trigger.** Fire 12 non-immediate events; assert exactly one flush (fetch called once)
   without advancing any timer.

3. **Failure event flushes immediately.** `voiceEvent("dictation", "mic_error", { detail: "NotAllowedError", flush: true })`;
   `await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))` — no timer advance. Assert
   the POSTed event is `mic_error`.

4. **Immediate flush drains the whole queue (ride-alongs).** Fire two non-immediate events (assert
   fetch not yet called), then one `{ flush: true }` event; `await vi.waitFor` → fetch called
   once; parse `fetchMock.mock.calls[0][1].body` and assert `events.length === 3` in original
   order.

5. **`flush` flag never appears in the payload.** After a `{ detail, flush: true }` event flushes,
   parse the body and assert each event object has only keys within
   `{ surface, event, detail, ms }` and no `flush` key.

6. **`pagehide` triggers a flush.** Queue one non-immediate event; `window.dispatchEvent(new Event("pagehide"))`;
   `await vi.waitFor` → fetch called with that event.

7. **`visibilitychange` → hidden still triggers a flush (preserve existing behavior).** Queue one
   event; `Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })`;
   `document.dispatchEvent(new Event("visibilitychange"))`; `await vi.waitFor` → fetch called.

8. **Authenticated header preserved (security assertion for Option A).** After any flush, assert
   `fetchMock.mock.calls[0][1].headers.Authorization === "Bearer test-token"` and
   `...["Content-Type"] === "application/json"`, and the URL ends with `/api/voice/telemetry`, and
   `keepalive === true`.

9. **Never throws when `fetch` rejects.** `fetchMock.mockRejectedValue(new Error("network"))`;
   `expect(() => voiceEvent("s", "e", { flush: true })).not.toThrow()`; flush a microtask and
   assert no unhandled rejection (the flush swallows). Then a subsequent event with a healthy fetch
   still flushes — the queue is not wedged.

10. **Never throws when `authHeaders` rejects.** Make the `authHeaders` mock reject once;
    `expect(() => voiceEvent("s", "e", { flush: true })).not.toThrow()`; assert swallowed (no
    fetch, no throw), and the module still works afterwards.

Scheduler-leak guard (known lesson): any fake-timer use is paired with `vi.useRealTimers()` in the
same test/`afterEach`; all event listeners are on `window`/`document` only; do not stub global
`setTimeout`/`requestAnimationFrame` in a way that outlives the file.

### Existing tests that MUST still pass unchanged

- `frontend/src/lib/voice/caddie-turn-timing.test.ts` — immediate-headline flush behavior is
  untouched.
- `frontend/src/components/CaddieSheet.handsfree.test.tsx` — mocks
  `@/lib/voice/telemetry` (`voiceEvent`, `flushVoiceEvents`); the added optional `flush` param is
  backward-compatible (extra optional key), so its assertions (e.g. `flushVoiceEvents` not called
  until `markFirstAudio`, `voiceEvent` called 4x with the caddie legs) still hold.
- `frontend/src/hooks/useSheetTTS.test.ts` — asserts
  `voiceEvent("sheet-tts", "speak_failed", expect.any(Object))` and `"prime_failed", { detail: ... }`.
  Adding `flush: true` to those payloads: the `expect.any(Object)` assertions stay green; the
  `prime_failed` assertion at line ~317 uses an exact object `{ detail: ... }` — **update that
  test's expectation to include `flush: true`** (this is the one existing test edit required, and
  it is a test-only change reflecting the new payload). Verify by reading the exact matcher before
  editing; if it is `expect.objectContaining({ detail })` no change is needed.

---

## Verification gates (run from `frontend/` unless noted)

1. `cd frontend && npm run lint`
2. `cd frontend && npx tsc --noEmit`
3. `cd frontend && npm run build`
4. `cd frontend && npx tsx voice-tests/runner.ts --smoke`
5. `cd frontend && npx vitest run src/lib/voice/telemetry.test.ts src/lib/voice/caddie-turn-timing.test.ts src/hooks/useSheetTTS.test.ts src/components/CaddieSheet.handsfree.test.tsx`
6. Backend: no change → `cd backend && ruff check .` only if any backend file was touched
   (it should not be). DB-backed backend tests run in CI, not locally (no local Postgres) — do not
   attempt them locally.

All green ⇒ done. This is invisible plumbing: no app-visible surface, no new dependency, no auth
change, consistent with NORTHSTAR (quiet, voice-first).

## Build order

1. Edit `telemetry.ts` (flag + `pagehide`).
2. Add `flush: true` at the 4 `useLooperDictation.ts` sites and 3 `useSheetTTS.ts` sites.
3. Adjust the one exact-object `useSheetTTS.test.ts` expectation if needed.
4. Write `telemetry.test.ts`.
5. Run the gates.

## Files touched (summary)

- `frontend/src/lib/voice/telemetry.ts` — add `flush?` flag path + `pagehide` window listener.
- `frontend/src/hooks/useLooperDictation.ts` — `flush: true` on `mic_error`, `live_start_failed`,
  `live_unsupported`, `resolved_fallback`.
- `frontend/src/hooks/useSheetTTS.ts` — `flush: true` on both `speak_failed` and `prime_failed`.
- `frontend/src/lib/voice/telemetry.test.ts` — NEW deterministic test file.
- `frontend/src/hooks/useSheetTTS.test.ts` — only if an exact-object matcher needs `flush: true`.
- NO backend change. NO `types.ts` / `models.py` change. NO `caddie-turn-timing.ts` change.
