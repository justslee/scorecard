# Voice Reply Timeouts + Single Retry — Implementation Plan

Spec source: `specs/voice-agent-audit.md` (P2 item #7). Owner directive: "bulletproofing the
voice agent." This is a SILENT, contained robustness change — no new UI, no shape changes,
frontend-only.

## 1. Objective

The three caddie voice REPLY calls can currently hang forever on flaky on-course networks
because `fetchAPI` has no timeout. Add per-call-site client-side timeouts and (for the terminal
call only) a single retry on transient failures, so they always terminate in bounded time and
degrade with the existing CALM copy — never an infinite spinner, never a machine-looking error
string.

Contain the change to the voice reply path. Do NOT add a global timeout to `fetchAPI` (it also
backs multipart uploads, course search, rounds/tournaments CRUD, OCR — a global timeout would
break long-running uploads). Do NOT touch the realtime warm-path mic invariants
(`src/lib/voice/realtime.ts`) or the gpt-realtime orb transport — a different pipeline.

## 2. Files to touch

- `frontend/src/lib/caddie/api.ts` — add the internal `postWithTimeout` helper + timeout/retry
  constants + calm error string; route `talkToCaddie` and `sessionVoice` through it; add inline
  timeout composition to `speakCaddieReply`. (Only file with product changes.)
- `frontend/src/lib/caddie/api.timeout.test.ts` — NEW colocated unit test for the helper +
  `speakCaddieReply` timeout.

Files deliberately NOT touched: `frontend/src/lib/api.ts` (no global timeout), `CaddieSheet.tsx`,
`LooperSheet.tsx`, `useSheetTTS.ts` (their catch/fallback wiring already produces calm
degradation), `dictation.ts`, `types.ts`, `models.py`.

## 3. Per-call-site policy table

| Call | Endpoint | Timeout | Retry | Rationale |
|---|---|---|---|---|
| `talkToCaddie` | `/caddie/voice` | `VOICE_REPLY_TIMEOUT_MS` = 10000 | 1 (transient only), 500 ms backoff | Terminal call — no downstream fallback exists, so it absorbs one retry to survive a single flaky moment. |
| `sessionVoice` | `/caddie/session/voice` | `SESSION_VOICE_TIMEOUT_MS` = 8000 | 0 | Failure is EXPECTED (session expired/unreachable) and the component already falls back to `talkToCaddie` (CaddieSheet askCaddie catch). Fail fast; a retry here would just delay the fallback and double the on-course wait. |
| `speakCaddieReply` | `/api/voice/speak` (TTS) | `SPEAK_TIMEOUT_MS` = 10000 | 0 | Best-effort / non-fatal — useSheetTTS swallows all failures (telemetry only). No user surface, so no retry and no message normalization. Must COMPOSE the caller's abort signal (overlap/stop), not clobber it. |

## 4. Constants + rationale

Add near the top of the `// ── Voice Caddie ──` section (match the surrounding comment density):

```ts
// Voice REPLY calls can otherwise hang forever on flaky on-course networks
// (specs/voice-agent-audit.md #7). These budgets are generous because each hits
// an LLM (GPT reply generation is usually 1–4 s; long history / cold start can
// push higher), so they fire only on a genuine hang, never on a slow-but-live call.
const VOICE_REPLY_TIMEOUT_MS = 10_000;      // terminal /caddie/voice, per attempt
const VOICE_REPLY_RETRIES = 1;              // terminal call gets ONE transient retry
const VOICE_REPLY_RETRY_BACKOFF_MS = 500;   // brief pause so the retry doesn't hit the same dead air
const SESSION_VOICE_TIMEOUT_MS = 8_000;     // session-first call — fail fast into the stateless fallback
const SPEAK_TIMEOUT_MS = 10_000;            // best-effort TTS

// Calm, human degradation for an exhausted-transient voice reply. Deliberately
// short and free of machine markers so humanizeVoiceError() (dictation.ts) passes
// it through AS-IS, and it never leaks "AbortError"/"signal is aborted".
const CALM_REPLY_ERROR = "Couldn't reach your caddie — give that another try.";
```

Worst-case bounded latency, CaddieSheet session path (sessionVoice hang → fallback →
talkToCaddie hang → retry hang):
`8000 (sessionVoice) + 10000 (talk attempt 1) + 500 (backoff) + 10000 (talk retry) = 28_500 ms ≈ 28.5 s ceiling.`
Acceptable because: (a) it is BOUNDED vs. infinite today; (b) it only occurs under sustained
total connectivity loss, where the calm error is the correct outcome; (c) the common case is a
single-attempt hang where the retry then succeeds in ~1–4 s. Off-course LooperSheet worst case
is just the terminal budget: `10000 + 500 + 10000 = 20_500 ms`.

## 5. Error normalization decision (locked)

Chosen: on an exhausted transient failure (our timeout OR a network error), `postWithTimeout`
throws `new Error(CALM_REPLY_ERROR)` where
`CALM_REPLY_ERROR = "Couldn't reach your caddie — give that another try."`

This string passes `humanizeVoiceError` unchanged: length < 90, does not start with `{`/`[`,
contains no `"detail"`, and matches none of `index out of range|traceback|exception|typeerror|keyerror`.
It therefore renders as-is in CaddieSheet (askCaddie catch) and is harmlessly overridden by
LooperSheet's hardcoded copy. It never contains "AbortError" or "signal is aborted".

HTTP errors (4xx/5xx) are NOT normalized — they are rethrown verbatim so `humanizeVoiceError`
continues to map raw JSON bodies (e.g. `{"detail":"list index out of range"}`) to the
component's own calm fallback, exactly as today.

`speakCaddieReply` errors are NOT normalized (no user surface; useSheetTTS logs `err.name` to
telemetry — keeping the raw error preserves `AbortError`/`TimeoutError` diagnostics there).

## 6. Retryable classification (locked)

Retry ONLY transient failures:
- Our timeout firing — detected via a `timedOut` boolean captured in the attempt's closure
  (do NOT sniff `err.name === 'AbortError'`; the flag is unambiguous and immune to Safari's
  "signal is aborted without reason" message).
- Network error — `err instanceof TypeError` (browser `fetch` throws `TypeError: Failed to fetch`
  / Safari `Load failed` on a dropped connection).

Do NOT retry:
- HTTP errors — `fetchAPI` surfaces these as a plain `Error` (`bodyText || 'API error: <status>'`),
  which is neither `TypeError` nor our timeout. A returned response is likely deterministic and
  retrying risks double-generation (the LLM turn already ran server-side; a retry could produce a
  second charged/duplicated reply).
- Caller-initiated aborts (external signal) — propagate immediately, never retry or normalize.

## 7. Helper signature + pseudocode

Add to `frontend/src/lib/caddie/api.ts`. Export it (test-only consumer; annotate as such):

```ts
interface VoiceTimeoutOpts {
  timeoutMs: number;
  retries?: number;   // default 0
  backoffMs?: number; // default 0
  signal?: AbortSignal; // optional external signal to COMPOSE with the timeout
}

/** POST a voice reply with a per-attempt timeout and optional transient retry.
 *  Contained to the voice reply path — do NOT generalise this into fetchAPI.
 *  Exported for api.timeout.test.ts. */
export async function postWithTimeout<T>(
  path: string,
  body: unknown,
  { timeoutMs, retries = 0, backoffMs = 0, signal }: VoiceTimeoutOpts,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    // Compose an external caller signal WITHOUT clobbering our timeout controller.
    // (AbortSignal.any is avoided for older-WKWebView portability.)
    const onExternalAbort = () => controller.abort(signal!.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      return await fetchAPI<T>(`/api${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      lastErr = err;
      // Caller cancelled (external), not our timeout → propagate as-is, never retry/normalize.
      if (signal?.aborted && !timedOut) throw err;
      const transient = timedOut || err instanceof TypeError;
      if (transient && attempt < retries) {
        if (backoffMs) await new Promise((r) => setTimeout(r, backoffMs));
        continue; // retry
      }
      if (transient) throw new Error(CALM_REPLY_ERROR); // exhausted transient → calm
      throw err; // HTTP / other → let humanizeVoiceError judge the raw message
    } finally {
      clearTimeout(timer); // cleared on EVERY path: success, throw, retry-continue
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(CALM_REPLY_ERROR); // unreachable; satisfies TS
}
```

Timer hygiene: the `try/finally` runs `clearTimeout(timer)` on success, on throw, and before each
`continue` (retry) — no leaked timers. The external-signal listener is removed in the same
`finally`.

Rewire the call sites (keep bodies identical to today):

```ts
// talkToCaddie — replace `return post('/caddie/voice', {...})` with:
return postWithTimeout('/caddie/voice', { /* same body object */ }, {
  timeoutMs: VOICE_REPLY_TIMEOUT_MS,
  retries: VOICE_REPLY_RETRIES,
  backoffMs: VOICE_REPLY_RETRY_BACKOFF_MS,
});

// sessionVoice — replace `return post('/caddie/session/voice', params)` with:
return postWithTimeout('/caddie/session/voice', params, {
  timeoutMs: SESSION_VOICE_TIMEOUT_MS, // retries defaults to 0 → fail fast into the component's talkToCaddie fallback
});
```

`speakCaddieReply` — direct `fetch` returning a Blob, so it can't use `postWithTimeout` (that
path speaks JSON via fetchAPI). Add inline timeout that COMPOSES the incoming `signal`; do not
normalize (non-fatal):

```ts
export async function speakCaddieReply(text: string, personalityId: string, signal?: AbortSignal): Promise<Blob> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(signal!.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), SPEAK_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/voice/speak`, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, personality_id: personalityId }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Speak failed (${res.status}): ${await res.text()}`);
    return await res.blob();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}
```

## 8. Caller signal interaction (confirmed)

- `talkToCaddie` / `sessionVoice`: no caller passes a signal today (CaddieSheet, LooperSheet);
  callers cancel via the `openGenRef` generation guard, not an AbortSignal. The `postWithTimeout`
  internal `AbortController` therefore stands alone and cannot conflict. The optional `signal`
  param is included for correctness/future use and, if ever supplied, is composed (not clobbered).
- `speakCaddieReply`: its one caller (useSheetTTS.ts) DOES pass `controller.signal` to cancel on
  overlap/stop. Composition preserves that: an external abort aborts our controller with the
  caller's reason; useSheetTTS's own `controller.signal.aborted` check still returns `true`, so it
  silently ignores that rejection (as today). When OUR timeout fires instead, the caller's signal
  stays un-aborted, so useSheetTTS logs `speak_failed` with `err.name` — the desired telemetry.
  No double-voice: still one `AbortController` per speak on the caller side, one audio element.

## 9. Tests

New file: `frontend/src/lib/caddie/api.timeout.test.ts` (vitest, fake timers). Mock the
module-level `fetchAPI` so the helper's timeout wiring is the unit under test; the fake respects
the passed `signal` to simulate a real hang.

Required cases:
- (a) resolves normally: `fetchAPI` resolves `{response:'hi'}` → resolves; `vi.getTimerCount()` is 0 afterward.
- (b) times out → calm: `fetchAPI` hangs until signal aborts; advance timers 10000; rejects with `CALM_REPLY_ERROR`; assert no `AbortError`/`signal is aborted` in the message.
- (c) retries once then succeeds: `fetchAPI` rejects `TypeError('Failed to fetch')` on call 1, resolves on call 2; with `retries:1, backoffMs:500`; advance 500; resolves; `fetchAPI` called twice.
- (d) does NOT retry on HTTP error: `fetchAPI` rejects `Error('API error: 500')`; with `retries:1` → rejects with `'API error: 500'` verbatim (not CALM); `fetchAPI` called once.
- (e) clears its timer (no open handles): after (a) and (d) settle, `vi.getTimerCount()` is 0.
- (f) external caller abort propagates (composition): pass a signal, abort it, rejection is the original abort error (not CALM), `fetchAPI` called once (no retry).
- (g) invariant guard: `expect(humanizeVoiceError(CALM, 'fallback')).toBe(CALM)` — locks the calm string survives humanization.
- (h) `speakCaddieReply` timeout: stub `global.fetch` to hang; advance 10000; rejects and timer cleared; and composing an already-aborted external signal aborts immediately.

Existing tests that must stay green (unchanged): `frontend/src/components/CaddieSheet.session.test.tsx`
(mocks the api module → helper never exercised; the `mockRejectedValueOnce` fallback assertions
still hold) and `frontend/src/lib/caddie/dictation.test.ts` (dictation.ts untouched).

## 10. Gate commands (run from `frontend/`)

```
npm run lint
npx tsc --noEmit
npm run build
npx tsx voice-tests/runner.ts --smoke
npx vitest run src/lib/caddie/api.timeout.test.ts src/components/CaddieSheet.session.test.tsx src/lib/caddie/dictation.test.ts
```
(Frontend-only; no backend/Postgres needed.)

## 11. Risks / watch-items

- Do not let `SESSION_VOICE_TIMEOUT_MS` exceed the terminal budget, or the fail-fast-into-fallback
  intent inverts.
- Keep `postWithTimeout` internal to the voice reply calls — resist reusing it for
  `sessionRecommend`/`fetchRecommendation` in this change (out of scope; those already fall back).
- If a future caller starts passing a signal into `talkToCaddie`, the composition path is already
  covered by test (f).
