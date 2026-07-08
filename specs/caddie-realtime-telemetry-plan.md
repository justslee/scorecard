# Caddie Stage-Timing Telemetry — Implementation Plan (Slice)

Parent: `specs/caddie-realtime-conversation-plan.md` (§6.5, §6.5.1, §6.5.3).
Backlog slice: **stage-timing telemetry**. Classification: **SILENT** (no user-visible UI; telemetry events only). Risk: **low**.
Status: PLAN. This document is the contract handed to the builder.

## 0. Scope & non-goals

**In scope:** extend the existing `voiceEvent` telemetry bus with caddie-turn stage markers on BOTH live paths that exist in production today —
- the **classic** sheet path (Deepgram VAD + SSE text + `useSheetTTS`), and
- the **Realtime orb** path (`useVoiceCaddie`, already live) —
plus the critical **iOS immediate-flush** of the headline number so the one measurement we care about is not eaten by the known "voicetel flush-drop" (batch dies on background).

**Explicitly NOT in this slice:**
- Slice C (Realtime **transport migration** of the sheet) — DEFERRED, not touched here.
- A2 (sentence-level TTS pipelining) — the NEXT slice; this telemetry is its measurement precondition (§6.5.4). We add markers only; we change no latency behavior.
- Any dashboard / UI overlay. No new endpoint. No schema/type change.

**Why the Realtime orb path IS in scope even though transport migration is deferred:** the orb (`useVoiceCaddie`, `mode:'caddie'`) already runs `gpt-realtime` in production. Its equivalents (`input_audio_buffer.speech_stopped` → first `response.audio.delta` playing) are measurable today from the consumer with zero `realtime.ts` edits. Measuring it now gives the honest speech-to-speech baseline the A2 "~1–2 s" claim will be judged against.

---

## 1. Approach

### 1.1 Monotonic clock
All durations use `performance.now()` (monotonic), never `Date.now()`. It is injectable in the timing module so tests are deterministic (fake `now`). `performance.now()` is already used elsewhere in the codebase (`src/hooks/useLooperDictation.ts`).

### 1.2 Where per-turn timing state lives
A single tiny, dependency-free module owns per-turn marks and all emission/flush logic:

**NEW `frontend/src/lib/voice/caddie-turn-timing.ts`** — exports a factory:

```
createCaddieTurnTimer({
  surface,                       // "caddie-turn" (classic) | "caddie-rt" (realtime)
  now  = () => performance.now(),// injectable monotonic clock
  emit = voiceEvent,             // injectable bus (swallows, never throws)
  flush = flushVoiceEvents,      // injectable immediate flush
}) => {
  markEos(): void          // start of turn — records t_eos AND resets all downstream marks
  markTranscript(): void   // final transcript resolved
  markFirstToken(): void   // first SSE token (idempotent — only the first sticks)
  markFirstAudio(): void   // audio actually playing — TERMINAL: emits legs 3 & 4, then flushes
}
```

Design rules baked into the module (so callers stay dumb and safe):
- **Emit only COMPLETE legs.** A leg is emitted only when BOTH its bracketing marks exist for the current turn. No mark → no leg. Never a bogus `0` or a huge number.
- **Sanity clamp.** A computed leg that is `<= 0` or `> 60000` ms is dropped (stale/aborted-turn cross-talk, clock weirdness) — emit nothing rather than garbage.
- **Once per turn.** Each leg emits at most once per turn; a second `markFirstToken`/`markFirstAudio` in the same turn is ignored.
- **`markEos()` resets** all downstream marks and the per-leg "already emitted" flags — this is the per-turn reset that makes rapid successive turns safe.
- **Everything is wrapped in try/catch** and swallows, exactly like the `voiceEvent` bus — a telemetry failure can NEVER throw into dictation/audio.

Instances (one per surface, held in a `useRef` so they persist across renders):
- **Classic:** created in `CaddieSheet` — `const turn = useRef(createCaddieTurnTimer({ surface: "caddie-turn" })).current;`
- **Realtime:** created in `useVoiceCaddie` — `const rtTurn = useRef(createCaddieTurnTimer({ surface: "caddie-rt" })).current;`

Reusing the SAME factory for the realtime path means the immediate-flush headline logic is written and tested once.

### 1.3 The five markers — which two events bracket each

Surface/event naming (both fields are free-form `str` on the backend, ≤40 chars each — all names below are within budget):

| Marker (event) | Surface | Lower bracket | Upper bracket |
|---|---|---|---|
| `caddie.eos_to_transcript` | `caddie-turn` | `markEos()` | `markTranscript()` |
| `caddie.transcript_to_first_token` | `caddie-turn` | `markTranscript()` | `markFirstToken()` |
| `caddie.first_token_to_first_audio` | `caddie-turn` | `markFirstToken()` | `markFirstAudio()` |
| `caddie.eos_to_first_audio` **(HEADLINE)** | `caddie-turn` | `markEos()` | `markFirstAudio()` → **flush now** |
| `caddie.eos_to_first_audio` **(Realtime equiv.)** | `caddie-rt` | `markEos()` (status `listening`→`connected`) | `markFirstAudio()` (first `speaking`) → **flush now** |

The headline event uses the **same event name** on both surfaces so a single `journalctl … | grep caddie.eos_to_first_audio` compares classic vs realtime directly; the `surface` field disambiguates the path.

### 1.4 Exact seams — classic path (`CaddieSheet.tsx`)

The classic turn funnels through `CaddieSheet`; each mark is a one-liner at an existing seam:

- **`markEos()`** — at the **top of `stopListening`** (currently ~line 768), before any transcript work. `stopListening` is the single funnel for "speech ended, begin processing": it is reached both by the hands-free auto-send (`onUtteranceEnd` → `autoStopRef.current()` → `stopListening`) and by a manual tap-to-stop. This is the honest end-of-speech instant for the owner's VAD path.
  - The **auto opening turn** (`askCaddie(q, {suppressError})` fired from GPS with no speech) never goes through `stopListening`, so it never calls `markEos()` — correct: that turn has no end-of-speech, so no `eos_*` legs are fabricated.
- **`markTranscript()`** — in `stopListening`, immediately after `finalText` is resolved and passes `isEmptyTranscript` (currently ~line 831-832), just before `await askCaddie(finalText)`. Brackets `eos_to_transcript`. (In the live-dictation path this leg is small — words are already accumulated; in the blob-fallback path it captures the real `transcribeBlob` round-trip. Both honest.)
- **`markFirstToken()`** — in `askCaddie`'s `onToken` handler (currently ~line 482-485, alongside `setIsStreaming(true)`). Idempotent in the timer, so it lands on the FIRST token only.
- **`markFirstAudio()`** — via a NEW `useSheetTTS` callback `onSpeakStart` (see §1.5), wired in `CaddieSheet` to `turn.markFirstAudio()`. This is the terminal mark: it emits `first_token_to_first_audio` + the headline `eos_to_first_audio`, then flushes.

Note: in the classic path `tts.speak(fullReply)` is called only AFTER the whole reply has streamed (line ~567), so "first audio" legitimately trails the full text stream — that is exactly the pain §6.5.1 predicts, and what A2 will later attack. We are measuring it, not changing it.

### 1.5 `useSheetTTS` — the "audio actually playing" seam
`useSheetTTS` is the one place that observes real playback start. Add an optional callback, mirroring the existing `onPlaybackEnd` pattern:

- New option: `onSpeakStart?: () => void` — "fires once when a REAL reply's audio actually begins playing (`play()` resolved), never for the silent prime clip, never for an aborted/superseded `speak()`."
- Fire it inside `speak()`'s async IIFE **immediately after `await audioElRef.current.play()` resolves**, guarded by `if (controller.signal.aborted) return;` first (so a superseded turn's late `play()` cannot mismark a newer turn). It sits right where `playingRealRef.current = true` / `setIsSpeaking(true)` already are.
- Ref-mirror it (`onSpeakStartRef`) exactly like `onPlaybackEndRef`, so the stable callback identity is used without recreating the audio element.
- `useSheetTTS` stays a pure audio hook — it emits NO telemetry itself; it only signals "audio started." All marker/flush logic remains centralized in the timer + `CaddieSheet`.

### 1.6 Exact seams — Realtime orb path (`useVoiceCaddie.ts`, CONSUMER only)

**Decision (stated explicitly): emit the Realtime markers from the CONSUMER (`useVoiceCaddie.handleConnectionStatus`), NOT from `realtime.ts`.** Evaluated both:

- *Option A — edit `realtime.ts` event handlers* (emit a marker directly from the `input_audio_buffer.speech_stopped` case ~line 547 and the first `response.audio*.delta` case ~line 488): most literally faithful to the parent's "`speech_stopped` → first `response.audio.delta`". **Rejected** — it touches the warm/mic/attach machinery's file and would trip the hard gate (must grow `realtime-warm.test.ts`), for no measurement benefit.
- *Option B — derive from the consumer's `onStatus` stream (CHOSEN)*: `realtime.ts` already collapses those raw events into status transitions that `useVoiceCaddie` receives via `onStatus: handleConnectionStatus`:
  - `input_audio_buffer.speech_started` → `setStatus('listening')`
  - `input_audio_buffer.speech_stopped` → `setStatus('connected')`
  - first `response.audio_transcript.delta` → `setStatus('speaking')`
  - `response.done` → `setStatus('connected')`

  A `listening` → `connected` transition is **unambiguously** `speech_stopped` (only `speech_started` sets `listening`). The FIRST `speaking` after that is first audio. So:
  - Add `prevStatusRef` (last status seen) in `useVoiceCaddie`.
  - In `handleConnectionStatus(s)`: if `prevStatusRef.current === 'listening' && s === 'connected'` → `rtTurn.markEos()`. If `s === 'speaking'` → `rtTurn.markFirstAudio()` (timer's once-per-turn guard collapses the many `speaking` calls in one response to a single emit + flush). Update `prevStatusRef.current = s` at the end.

  This touches ONLY `useVoiceCaddie` (a consumer). `realtime.ts` is untouched → the `realtime-warm.test.ts` hard gate is **not** triggered.

**Honesty note on the proxy:** status `speaking` is set on the first `response.audio_transcript.delta`, not literally on the first decoded PCM sample of `response.audio.delta`. In `gpt-realtime` the transcript and audio deltas stream together and the audio plays straight through the WebRTC track into the `<audio>` sink; the transcript-delta transition is the closest consumer-observable proxy for "voice starting." Measuring the literal first audio sample would require editing `realtime.ts` (forbidden). We use the closest honest seam and document it as such.

---

## 2. Files to touch

### Frontend (all changes)
- **NEW `frontend/src/lib/voice/caddie-turn-timing.ts`** — the `createCaddieTurnTimer` factory (§1.2): per-turn marks, complete-leg-only emission, sanity clamp, once-per-turn guard, immediate headline flush, full swallow. Injectable `now`/`emit`/`flush`.
- **`frontend/src/hooks/useSheetTTS.ts`** — add `onSpeakStart?` option + ref mirror; fire it after `play()` resolves and `!aborted` (§1.5). No other behavior change.
- **`frontend/src/components/CaddieSheet.tsx`** — instantiate the classic timer (`useRef`); wire `markEos` (top of `stopListening`), `markTranscript` (before `askCaddie(finalText)`), `markFirstToken` (in `onToken`), and pass `onSpeakStart: () => turn.markFirstAudio()` into `useSheetTTS({...})`.
- **`frontend/src/hooks/useVoiceCaddie.ts`** — instantiate the realtime timer (`useRef`); add `prevStatusRef`; in `handleConnectionStatus` mark eos on `listening`→`connected` and first-audio on `speaking` (§1.6). Consumer-only; no `realtime.ts` edit.

### CONSUMED, do NOT modify
- `frontend/src/lib/voice/telemetry.ts` — used as-is (`voiceEvent`, `flushVoiceEvents`; `keepalive:true` already set). Nothing added that can throw into a caller.
- `frontend/src/lib/voice/realtime.ts`, `warm-session.ts` — untouched (warm-path invariant).
- `frontend/src/lib/voice/deepgram-live.ts` — untouched; `onUtteranceEnd` already funnels into `stopListening` where we mark eos.
- `frontend/src/lib/caddie/stream-buffer.ts` — untouched; the first token is observed in `CaddieSheet.onToken`, not here.

### Backend — NO CHANGE (confirmed)
`backend/app/routes/voice.py:208-235`: `VoiceTelemetryEvent` types `surface`/`event` as plain `str` (each truncated to 40 chars; no `Enum`, no validation). Our new surfaces (`caddie-turn`, `caddie-rt`) and events (longest is `caddie.first_token_to_first_audio` = 33 chars) ride the existing `POST /api/voice/telemetry` unchanged. **No backend edit, no backend gates required.**

---

## 3. iOS immediate-flush design (the must-fix) + how it is tested

**Problem:** `telemetry.ts` batches (`FLUSH_AFTER_MS=8000`, `FLUSH_AT_COUNT=12`) and best-effort flushes on `visibilitychange:hidden`. On iOS the app can background before the 8 s timer fires and the batch dies ("voicetel flush-drop"). The headline `caddie.eos_to_first_audio` is the single number we cannot afford to lose.

**Design:** inside `createCaddieTurnTimer`, `markFirstAudio()` does, in order:
1. emit `caddie.first_token_to_first_audio` (if `markFirstToken` present),
2. emit the headline `caddie.eos_to_first_audio` (if `markEos` present),
3. **call `flush()` synchronously** right after the headline emit.

`flushVoiceEvents()` already uses `fetch(..., { keepalive:true })`, which survives a background/navigation — so the number is on the wire at turn end rather than sitting in the queue waiting for a timer. This holds for BOTH surfaces (classic via `useSheetTTS.onSpeakStart`; realtime via the first `speaking` status), because both go through the same `markFirstAudio()`.

**How it is tested (deterministic):** in `caddie-turn-timing.test.ts`, inject a mock `emit` and a mock `flush`. Drive a full turn and assert:
- `flush` is **not** called by `markEos`/`markTranscript`/`markFirstToken`;
- after `markFirstAudio`, `flush` is called **exactly once**, and the immediately-preceding `emit` call was `caddie.eos_to_first_audio`.

This deterministically proves the headline flushes immediately at turn end without needing a real background event.

---

## 4. Edge cases

- **Turn abandoned mid-way (no first token / no audio):** only complete legs emit. No `markFirstToken` → no `transcript_to_first_token` / `first_token_to_first_audio`; no `markFirstAudio` → no headline. No bogus `0`, no huge number.
- **TTS disabled (mute pref off):** `tts.speak` is a no-op, so `onSpeakStart` never fires → no `*_to_first_audio` legs on the classic path. Correct — with voice off there is no "voice starting" to measure; the text legs (`eos_to_transcript`, `transcript_to_first_token`) still emit and remain useful.
- **Fallback classic-from-live (orb → sheet degrade):** unchanged — once the sheet is on the classic path, the classic timer covers it. The realtime timer simply never reaches `markFirstAudio` for that aborted burst (its marks are discarded on the next `markEos`).
- **Barge-in / interrupt mid-reply:** a new turn calls `markEos()` which resets the timer, discarding the abandoned turn's incomplete marks (no stale emit). On the classic path, a superseded `askCaddie`/`tts.speak` is aborted, and `onSpeakStart` is gated on `!controller.signal.aborted`, so a late `play()` from the old turn cannot mismark the new one. The timer's `<=0` / `>60000` sanity clamp is the backstop against any residual cross-turn skew.
- **Multiple rapid turns:** `markEos()` is the per-turn reset (marks + emitted-flags cleared). Timers are held in `useRef` (one per surface), so state is per-surface and reset per turn, never leaking across turns.
- **Realtime: repeated `speaking` status within one response:** the timer's once-per-turn guard collapses them to a single `markFirstAudio` emit + single flush.
- **Telemetry failure isolation:** every timer method is wrapped in try/catch and swallows (like the `voiceEvent`/`flushVoiceEvents` bus). A throwing `emit`/`flush`, or a `voiceEvent` internal error, can never propagate into `stopListening`, `askCaddie`, `useSheetTTS.speak`, or `handleConnectionStatus`.

---

## 5. Test strategy (deterministic, vitest — no sockets, no getUserMedia)

- **NEW `frontend/src/lib/voice/caddie-turn-timing.test.ts`** (authoritative, pure):
  - **Full classic turn:** inject `now` returning scripted values (e.g. eos@0, transcript@120, firstToken@700, firstAudio@1400). Assert exactly four emits with plausible ms: `eos_to_transcript=120`, `transcript_to_first_token=580`, `first_token_to_first_audio=700`, `eos_to_first_audio=1400`, each on surface `caddie-turn`.
  - **Immediate flush:** assert `flush` not called on the first three marks; called exactly once right after the headline emit (§3).
  - **Realtime two-mark turn:** `markEos` then `markFirstAudio` (surface `caddie-rt`) emits ONLY `caddie.eos_to_first_audio` + one flush; no text legs.
  - **Incomplete turn:** `markEos` + `markTranscript` only → emits just `eos_to_transcript`, no headline, no flush.
  - **Reset per turn:** two `markEos` cycles don't cross-contaminate; second turn emits its own legs.
  - **Sanity clamp:** a non-positive or `>60000` leg emits nothing.
  - **Failure isolation:** `emit` throws / `flush` throws → no method throws; subsequent marks still work.
- **EXTEND (do not weaken) `frontend/src/hooks/useSheetTTS.test.ts`:**
  - `onSpeakStart` fires exactly once after a real `speak()`'s `play()` resolves.
  - `onSpeakStart` does NOT fire for the silent prime clip in `unlock()`.
  - `onSpeakStart` does NOT fire for a superseded/aborted `speak()` (a second `speak()` racing the first).
  - All existing cases must still pass byte-for-byte.
- **EXTEND `frontend/src/components/CaddieSheet.handsfree.test.tsx`** (wiring proof of the "simulated turn"): mock `@/lib/voice/telemetry` (`voiceEvent`, `flushVoiceEvents`) and stub `performance.now` to scripted values; drive a hands-free turn (interim → `onUtteranceEnd` → transcript → streamed token → TTS play) and assert the four `caddie-turn` markers were emitted with plausible ms and that `flushVoiceEvents` was called at first audio. Keep existing assertions intact.
- **Realtime consumer:** the two-mark realtime logic is proven authoritatively by the timer unit test above. The `useVoiceCaddie` wiring is a 3-line, consume-only status-transition detection; if a render test is added it must use the existing injected-fake patterns (no real `RTCPeerConnection`/sockets). No `useVoiceCaddie.test` exists today; adding one is optional and low-risk — do NOT introduce socket/getUserMedia usage.
- **Warm-path gate:** `realtime.ts` is untouched, so `realtime-warm.test.ts` is unchanged. (If — contrary to this plan — any `realtime.ts` warm/mic/attach code is edited, growing `realtime-warm.test.ts` is a HARD STOP per parent §3.)

---

## 6. Gates

Frontend (all required):
- `cd frontend && npm run lint`
- `cd frontend && npx tsc --noEmit`
- `cd frontend && npm run build`
- `cd frontend && npx tsx voice-tests/runner.ts --smoke`
- `cd frontend && npx vitest run` (new `caddie-turn-timing.test.ts` + extended `useSheetTTS.test.ts` + extended `CaddieSheet.handsfree.test.tsx` + existing suites)

Backend: **not required** — no backend file changes (§2). (Only if a future change edits the telemetry route: `cd backend && ruff check .` + `cd backend && uv run pytest`.)

---

## 7. Classification

**SILENT.** No user-visible UI, no copy, no behavior change — telemetry events only. Automatically NORTHSTAR-compliant (calm, voice-first) since there is no surface. This is the measurement foundation that must precede the A2 (sentence-level TTS pipelining) slice; A2's ~1–2 s first-voice claim can only be honestly verified once these markers exist on the owner's device.
