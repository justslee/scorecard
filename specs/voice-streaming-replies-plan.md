# Voice-agent-audit P2 #5 — Stream the caddie's TEXT reply into the sheets

Source: `specs/voice-agent-audit.md` lines 51–53. Goal: the golfer sees the caddie's
text reply **begin rendering in <1s** by streaming tokens progressively into the sheet,
instead of waiting for the full Claude turn. This is the audit's biggest perceived-latency
win. NOTICEABLE: owner watches text stream in on TestFlight.

**This plan streams TEXT only. It does not touch TTS, the realtime orb, the JSON contract,
the auth/persona gates, or the deterministic voice-tests corpus.**

---

## 0. Scope guardrails (read first)

- **TTS is unchanged.** `speakCaddieReply()` and `useSheetTTS` stay exactly as they are.
  The caddie speaks **once**, after the FULL text has landed (`done` event). No streaming
  or chunked TTS. The only change on the TTS side is *when* `tts.speak(fullText, persona)`
  is invoked — it now fires on stream completion rather than on a resolved Promise. Same
  call, same arguments.
- **The realtime orb warm-path is out of scope.** `frontend/src/lib/voice/realtime.ts`
  (gpt-realtime WebRTC, server VAD) already streams speech-to-speech. Do **not** touch it.
  This item is the SHEET TEXT path only.
- **The JSON endpoints stay.** `/api/caddie/session/voice` and `/api/caddie/voice`
  (`VoiceCaddieResponse`) remain byte-for-byte as they are. They are the final
  non-streaming fallback and the contract the voice-tests + any other callers depend on.
  Streaming is delivered on **new** endpoints, out-of-band (`text/event-stream`).

---

## 1. Transport decision

**Server:** FastAPI `StreamingResponse(generator, media_type="text/event-stream")` emitting
SSE frames.

**Client:** `fetch()` + `response.body.getReader()` + `TextDecoder`, parsing SSE frames
manually. **NOT `EventSource`.**

**One-line rationale:** our endpoints are authenticated `POST` calls (Clerk Bearer +
JSON body) — `EventSource` cannot send a request body or an `Authorization` header, so it
is disqualified; `fetch` + `ReadableStream.getReader()` is supported in the Capacitor
WKWebView (WebKit ≥ iOS 14.5, well below our floor) and lets us keep the exact auth path
`speakCaddieReply()` already uses (`fetch(${API_BASE}...)` + `authHeaders()`).

**WKWebView safety net:** feature-detect `res.body && typeof res.body.getReader === 'function'`.
If absent (or if the platform buffers the whole body), read the full body and treat it as a
single completed reply — correct, just non-progressive. No jitter, degraded gracefully.

**SSE framing (internal contract — not a shared Pydantic/TS model):**

```
event: token\ndata: <delta text, JSON-encoded string>\n\n     # zero or more
event: done\ndata: {}\n\n                                       # exactly one on success
event: error\ndata: "<calm in-character copy>"\n\n              # exactly one on failure
```

- `token.data` is a **JSON-encoded string** (`json.dumps(delta)`) so newlines/quotes inside
  a delta never corrupt the SSE line framing. Client does `JSON.parse` per token.
- `done` needs no payload (the client already accumulated the full text). We deliberately do
  **not** re-send the whole text on `done` — the accumulated buffer is authoritative.
- `error.data` is the calm `_CADDIE_ERROR_DETAIL` line only. **Never `str(e)`, never a
  traceback** — same discipline as today, now expressed as an SSE event instead of a 500.

---

## 2. Backend changes — `backend/app/routes/caddie.py`

### 2.1 New endpoints (additive; existing JSON endpoints untouched)

- `POST /api/caddie/session/voice/stream` — session-aware streaming twin of `session_voice`.
- `POST /api/caddie/voice/stream` — stateless streaming twin of `voice_caddie`.

Both return `StreamingResponse(..., media_type="text/event-stream")` and reuse the SAME
request models (`SessionVoiceRequest` / `VoiceCaddieRequest`).

### 2.2 Do ALL gate + context work BEFORE returning the stream

This is the load-bearing structural rule that preserves the auth contract and the
"no `str(e)` over a 200" invariant:

```
@router.post("/session/voice/stream")
async def session_voice_stream(request, user_id = Depends(current_user_id)):
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")   # normal JSON error
    session = await get_owned_session(request.round_id, user_id)        # 403/404 as JSON
    persona_id = request.personality_id if await personality_visible(...) else "classic"
    ...build system_prompt + messages exactly as session_voice does...  # synchronous
    return StreamingResponse(_sse_reply(...), media_type="text/event-stream")
```

Because ownership (`get_owned_session`), the persona-visibility gate (`personality_visible`),
and prompt assembly all run **before** `StreamingResponse` is constructed, any auth/gate
failure returns a normal JSON `HTTPException` with headers not yet sent — identical to
today. Only the Anthropic model stream runs inside the generator (after `200 OK` headers
are committed).

### 2.3 Refactor to avoid drift (mandatory)

Extract the context/prompt assembly currently inlined in `session_voice` (lines ~485–576)
into a helper, e.g. `_build_session_voice_prompt(session, request) -> (system_prompt, messages, persona_id)`,
and the equivalent block in `voice_caddie` (~924–985) into `_build_voice_prompt(request, user_id)`.
Both the JSON endpoint and its streaming twin call the same helper. Do **not** copy-paste the
prompt logic — the two mouths must stay identical (brain-parity, audit #6).

### 2.4 The SSE generator (async)

Use **`anthropic.AsyncAnthropic`** with `async with client.messages.stream(...)` so the
FastAPI event loop is never blocked. Params match the existing non-streaming call exactly —
do not change them:

```
async def _sse_reply(system_prompt, messages, *, round_id=None, request=None):
    client = anthropic.AsyncAnthropic(api_key=api_key)
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")   # unchanged default
    parts: list[str] = []
    completed = False
    try:
        async with client.messages.stream(
            model=model, max_tokens=300, temperature=0.7,
            system=system_prompt, messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                if text:
                    parts.append(text)
                    yield f"event: token\ndata: {json.dumps(text)}\n\n"
        completed = True
    except anthropic.AuthenticationError:
        log.exception("session_voice_stream auth failed")
        yield 'event: error\ndata: "%s"\n\n' % _CADDIE_ERROR_DETAIL   # calm, no str(e)
        return
    except Exception:
        log.exception("session_voice_stream failed")                  # traceback to journal
        yield 'event: error\ndata: "%s"\n\n' % _CADDIE_ERROR_DETAIL
        return

    full = "".join(parts) or "Say that once more? I want to get this right."   # empty-content guard
    if round_id is not None and completed:
        # Persist the FULL assembled turn atomically — user+assistant or neither.
        await sessions.append_message_pair(
            round_id, user_content=request.transcript,
            assistant_content=full, hole_number=request.hole_number,
        )
    yield "event: done\ndata: {}\n\n"
```

Notes:
- **Empty-content guard preserved** — mirrors `_first_text(...) or "Say that once more?"`.
  (When streaming, `stream.text_stream` yields nothing for an empty turn, so `parts` is
  `[]` → the same fallback string is what we persist and send. We still emit `done` with
  that fallback already... — see 2.5 for the empty edge case.)
- The stateless generator omits `round_id`/persistence.
- `json.dumps(_CADDIE_ERROR_DETAIL)` (not `%`) is cleaner; shown inline for brevity.

### 2.5 Persistence integrity + edge cases (session stream)

- **Atomicity is unchanged.** `append_message_pair` is called exactly once, at the very end,
  with the COMPLETE assembled text. It is already an atomic dual-append (both rows or
  neither) — so the round history can never wedge into a user-without-assistant state.
- **Client disconnects mid-stream** (sheet closed, navigated away): FastAPI cancels the
  generator; the `async with ... stream` context exits, `completed` never flips to `True`,
  and `append_message_pair` is **never reached** → nothing persisted. Simplest correct
  behavior: an abandoned turn is dropped from history entirely (no partial, no wedge). The
  golfer stopped watching, so losing that turn from memory is acceptable and safe.
- **Anthropic errors mid-stream** (after some tokens): caught → `log.exception` (traceback
  to journal) → emit `error` event with `_CADDIE_ERROR_DETAIL` → `completed` stays `False`
  → **not persisted**. Server never persists a partial reply.
- **Empty content / immediate `done`:** if `parts` is empty we persist and send the calm
  "Say that once more?" fallback (matches today). Client renders it as the final answer.

### 2.6 What is preserved verbatim

- `_CADDIE_ERROR_DETAIL` calm copy; `log.exception` traceback-to-journal on failure;
  the empty-content guard; the persona-visibility gate; ownership via `get_owned_session`;
  the same system-prompt + context + last-20-messages assembly; the `ANTHROPIC_MODEL`
  env default. None of these change.

---

## 3. Frontend changes — `frontend/src/lib/caddie/api.ts`

### 3.1 New streaming reader (new function; `postWithTimeout` UNCHANGED)

Add `streamCaddieReply(path, body, { onToken, firstTokenTimeoutMs, idleTimeoutMs, signal })`
that:
1. Opens `fetch(${API_BASE}/api${path}, { method:'POST', headers:{...authHeaders(),'Content-Type':'application/json','Accept':'text/event-stream'}, body: JSON.stringify(body), signal })`
   — same auth path as `speakCaddieReply`, bypassing `fetchAPI` (which only speaks JSON).
2. Feature-detects `res.body?.getReader`. If missing → read full text, return it as the
   completed reply (non-progressive fallback).
3. Reads chunks via `getReader()` + `TextDecoder`, parses SSE frames, and:
   - `token` → `onToken(delta)` and append to an internal accumulator.
   - `done` → resolve with the accumulated string.
   - `error` → throw a **terminal** calm error (do NOT fall back — see 3.2).

### 3.2 The exact timeout model (reconciles with cycle-4 `postWithTimeout`)

`postWithTimeout` (the whole-body AbortController timeout + 1 retry + `CALM_REPLY_ERROR`)
**stays untouched** and continues to serve the non-streaming fallback. The stream reader
uses a DIFFERENT model — a stream legitimately runs >10s while emitting tokens the whole
time, so a whole-body timeout is wrong:

- **First-token timeout** (`firstTokenTimeoutMs`, e.g. `STREAM_FIRST_TOKEN_TIMEOUT_MS = 8_000`,
  matching today's `SESSION_VOICE_TIMEOUT_MS` fail-fast budget): a timer armed when the
  request opens. If **no first `token`** (nor `error`/`done`) arrives before it fires →
  abort the fetch → throw a **`BeforeFirstByteError`** sentinel (fallback-eligible).
- **Inter-token idle timeout** (`idleTimeoutMs`, e.g. `10_000`): once the first token has
  arrived, the first-token timer is cleared and replaced by an idle timer that **resets on
  every token**. It fires only on dead air (a stalled stream), never on a slow-but-live one.
  Firing after the first token throws a **terminal** calm error (NOT fallback-eligible).
- **No whole-body timeout.** A stream that streams for 30s while emitting tokens completes
  normally.

The reader must clearly distinguish the two failure classes:
- **Before first token** (first-token timeout, network error, immediate `error` event before
  any token) → `BeforeFirstByteError` → the caller may fall back to a different endpoint.
- **After first token** (idle timeout, mid-stream `error` event) → terminal calm error →
  the caller must **not** fall back (tokens are already on screen; re-running another
  endpoint would double-render / double-speak). Surface calm copy, discard the partial.

Add the two new consts alongside the existing voice budgets. Keep `CALM_REPLY_ERROR` for
the reused terminal calm copy.

### 3.3 Two thin wrappers

- `sessionVoiceStream({ round_id, transcript, personality_id, hole_number }, { onToken, signal })`
  → `streamCaddieReply('/caddie/session/voice/stream', ..., { firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000 })`.
- `talkToCaddieStream({ ...same body as talkToCaddie }, { onToken, signal })`
  → `streamCaddieReply('/caddie/voice/stream', ...)`.

`sessionVoice()` and `talkToCaddie()` (non-streaming) are **kept** as the final fallback.

---

## 4. Frontend changes — the sheets (the ladder + progressive render)

### 4.1 CaddieSheet.tsx — reconcile with the existing 2-tier ladder

Today (`askCaddie`, ~297–361): `sessionVoice` (8s fail-fast, 0 retries) → catch →
`talkToCaddie` (10s, 1 retry). New **3-tier** ladder, streaming-first, falling back only on
`BeforeFirstByteError`:

```
1. session-stream    sessionVoiceStream(...)   — pre-first-byte fail →
2. stateless-stream  talkToCaddieStream(...)   — pre-first-byte fail →
3. stateless-nonstream talkToCaddie(...)       — existing calm-copy + 1-retry path
```

Rules:
- Streaming tiers pass `onToken` that appends into a **live buffer** (§4.3). The first tier
  that emits a first token "wins" — from that point, any failure is terminal (calm error,
  discard partial), never a fall-through to a lower tier.
- Only a `BeforeFirstByteError` from tier 1 advances to tier 2; only a `BeforeFirstByteError`
  from tier 2 advances to tier 3. Tier 3 resolves a full string exactly as today.
- On success (any tier): set `voiceAnswer` to the final full text (already displayed for
  streaming tiers; set once for tier 3), update `convHistoryRef`/`onUpdateConvHistory` with
  `{user}` + `{assistant: fullText}` exactly as today, then `tts.speak(fullText, personaId)`
  **once**.
- On terminal failure: `setError(humanizeVoiceError(...))` and clear the partial
  `voiceAnswer` (see §5 UX). `humanizeVoiceError` + the calm SSE copy keep machine strings
  off screen.

Note: LooperSheet only ever used `talkToCaddie` (stateless, off-course orb). Its ladder is
2-tier: `talkToCaddieStream` → (pre-first-byte) → `talkToCaddie`. Same progressive-render
wiring.

### 4.2 Persist history only on the FULL text

Unchanged invariant: `convHistoryRef.current` / `onUpdateConvHistory` are updated with the
assistant turn only after the stream resolves (full text), never per-token. This keeps the
client conversation ledger consistent with the server's atomic `append_message_pair`.

### 4.3 Progressive render + smoothing cadence (NORTHSTAR: calm, not jittery)

Anthropic deltas arrive in uneven bursts; appending each raw delta to React state stutters
and thrashes re-renders. Prescribe a **rAF-coalesced** buffer:

- Keep a `pendingRef` string buffer. `onToken(delta)` does `pendingRef.current += delta` and,
  if no flush is scheduled, `requestAnimationFrame(flush)`.
- `flush()` appends `pendingRef.current` to a `streamingText` state (e.g. via
  `setVoiceAnswer(prev => (prev ?? '') + pending)`), clears the buffer, unschedules.
- This yields ~1 render per frame (~60fps ceiling) — a smooth, even fill rather than
  per-token flicker, and no re-render storm. On `done`, do a final flush then set the
  authoritative full text.
- Render the streaming text in the SAME `voiceAnswer` slot the sheet already shows in the
  `"answered"` phase (CaddieSheet ~1173/1228). Add a subtle "answering…" affordance while
  streaming if desired, but keep it quiet (no spinner churn).

### 4.4 Abort on sheet close / new question

Thread an `AbortController` (the existing `openGenRef`/gen pattern) into `streamCaddieReply`'s
`signal`. Closing the sheet or starting a new question aborts the in-flight stream — the
reader treats an external abort as a caller-cancel (mirror `postWithTimeout`'s
`signal?.aborted && !timedOut` branch: propagate, never normalize to calm, never persist).

---

## 5. UX for the rare mid-stream error

Partial text is already on screen when a mid-stream `error` arrives (or the idle timeout
fires). Two options were weighed:
- (a) keep the partial + append a calm note, or
- (b) discard the partial + show the calm line.

**Choose (b): discard the partial, surface the calm line** via the existing
`setError(humanizeVoiceError(...))` path, and clear `voiceAnswer`. Rationale: a truncated
caddie reply can be actively misleading (cut mid-club or mid-aim), and the server persisted
nothing, so discarding keeps client and server consistent. TTS never fires (it is gated on
`done`), so there is no half-spoken reply. The brief flicker (text appears, then a calm
line) is acceptable because genuine mid-stream Anthropic failures are rare, and correctness
> cosmetics. Document this tradeoff in the code comment.

---

## 6. Shared types

Streaming is **out-of-band** (`text/event-stream`), so **no shared JSON type changes**:
- `VoiceCaddieResponse` (`backend/app/caddie/types.py`) and its consumers are untouched —
  the non-streaming endpoints still return it.
- `VoiceCaddieMessage` (`frontend/src/lib/caddie/types.ts`) is unchanged and stays in sync
  with its backend counterpart as today.
- The SSE `token`/`done`/`error` framing is an internal endpoint contract documented in
  §1; the reader defines a small local TS type for parsed frames. No Pydantic model, no
  cross-boundary schema to keep in sync.

(Note: the audit brief referenced `models.py`; the voice models actually live in
`backend/app/caddie/types.py` — either way, no change is required.)

---

## 7. Tests + exact verification gates

### 7.1 New unit tests

**Frontend (vitest):**
- `api.stream.test.ts` (new) — drive `streamCaddieReply` against a mock `fetch` returning a
  `ReadableStream`:
  - tokens accumulate; `done` resolves with the full string; `onToken` called per delta.
  - **first-token timeout** with no token → `BeforeFirstByteError` (fallback-eligible).
  - **inter-token idle timeout** after first token → terminal error (NOT fallback).
  - mid-stream `error` event → terminal calm error, partial discarded; the message is the
    calm SSE copy, never `str(e)`.
  - external `signal` abort → propagates, not normalized to calm.
  - `res.body.getReader` absent → non-progressive full-body fallback path.
- Progressive-render test (new, or extend `CaddieSheet.session.test.tsx`): the rAF buffer
  accumulates deltas and finalizes on `done`; ladder falls back tier1→tier2→tier3 only on
  `BeforeFirstByteError`; `tts.speak` called exactly once with the full text.
- `api.timeout.test.ts` stays green (`postWithTimeout` unchanged).
- `useSheetTTS.test.ts` stays green (TTS unchanged).

**Backend (no Postgres required):**
- Test the SSE generator with a monkeypatched `AsyncAnthropic` whose `messages.stream`
  yields a scripted `text_stream`:
  - emits `event: token` per delta and one `event: done`.
  - assembles the full text; asserts `sessions.append_message_pair` (mocked) is called with
    the COMPLETE text (session generator) and NOT called (stateless generator).
  - a raised exception mid-stream → one `event: error` carrying `_CADDIE_ERROR_DETAIL`, no
    `str(e)`/traceback in the payload, and `append_message_pair` NOT called.
  - empty `text_stream` → persists + sends the "Say that once more?" fallback.
- Gate tests at the sync layer (mock `personality_visible` / `get_owned_session`): a
  non-visible persona downgrades to `classic`; missing `ANTHROPIC_API_KEY` → 500 JSON before
  any streaming. DB-backed ownership tests run in CI (no local Postgres/docker).

### 7.2 Exact commands

```
cd frontend && npm run lint && npx tsc --noEmit && npm run build && npx tsx voice-tests/runner.ts --smoke
cd backend && ruff check .
```

The `voice-tests` smoke corpus is deterministic and does not exercise the LLM mouth, so it
must stay green unchanged (streaming is additive, non-streaming endpoints untouched).

---

## 8. Sequencing

1. Backend: extract `_build_session_voice_prompt` / `_build_voice_prompt` helpers; assert
   the existing JSON endpoints still behave identically (`ruff` + backend tests).
2. Backend: add the two `/stream` endpoints + `_sse_reply` async generator (AsyncAnthropic);
   backend generator unit tests.
3. Frontend: `streamCaddieReply` + timeout model + `sessionVoiceStream`/`talkToCaddieStream`;
   `api.stream.test.ts`.
4. Frontend: CaddieSheet 3-tier ladder + rAF progressive render; LooperSheet 2-tier;
   wire `tts.speak` to `done`; update `CaddieSheet.session.test.tsx`.
5. Run all gates; verify on-device (owner sees text stream in on TestFlight).

## 9. Risks

1. **Fallback double-render** — falling back after a token is already on screen would
   double-render / double-speak. Mitigation: strict `BeforeFirstByteError`-only fallback;
   any post-first-token failure is terminal.
2. **WKWebView fetch-streaming variance** — if the platform buffers the body, progressive
   render silently degrades. Mitigation: `getReader` feature-detect + full-body fallback;
   verify on a real TestFlight device, not just desktop Safari.
3. **Persistence on abandoned turns** — client disconnect must not wedge history. Mitigation:
   single atomic `append_message_pair` at the very end, gated on a `completed` flag; nothing
   persists on disconnect or mid-stream error.
