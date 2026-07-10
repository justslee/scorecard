# Plan: voicetel per-leg immediate flush (SILENT, telemetry-only)

**Branch:** `integration/next` · **Backlog:** `voicetel-timing-immediate-flush` — cascaded-STT go/no-go unblocker (#125/#126) · **Classification:** SILENT (telemetry, no UI)

## 1. Problem statement (with falsified-premise correction)

Prod (owner's iPhone, Capacitor WKWebView) shows ~1 `caddie.eos_to_first_audio` and 0 `caddie-rt` events in 3 days, blocking the spike #126 go/no-go which needs `caddie-turn` vs `caddie-rt` p90 for `caddie.eos_to_first_audio`. The naive premise — "the headline event is not in the immediate-flush tier" — is **falsified**: `createCaddieTurnTimer` (`frontend/src/lib/voice/caddie-turn-timing.ts`) already calls `safeFlush()` synchronously inside `markFirstAudio()` (L129–145), and that code has been live in `origin/main` since 2026-07-07 (commit 6fcb40d) — the entire measurement window. The actual gap is the **earlier legs**: `markTranscript()` (`caddie.eos_to_transcript`, L105–115) and `markFirstToken()` (`caddie.transcript_to_first_token`, L117–127) emit via `safeEmit` → `voiceEvent` **without** flush, so they sit in the 8s batch queue and are delivered only if a later `markFirstAudio()` flush, the batch timer, or pagehide/visibilitychange drains them. On iOS, `markFirstAudio()` is fired by `useSheetTTS`'s `onSpeakStart` (classic — TTS audio actually starting, unreliable on iOS) or the first `'speaking'` RT status; if it never fires and the WKWebView is suspended before the timer, the entire turn's timing — including the headline — is lost, and we cannot even tell a turn happened. The fix: flush **each stage-timing leg immediately as it is emitted**, so `caddie.eos_to_transcript` reaches prod the moment the transcript resolves, independent of whether first audio is ever marked. This delivers reliable `caddie-turn` volume AND disambiguates "no turns happening" from "turns happen but iOS audio-marking never fires."

## 2. Exact files to change (verified)

| File | Change |
|---|---|
| `frontend/src/lib/voice/caddie-turn-timing.ts` | Add per-leg flush in `markTranscript()` and `markFirstToken()`; update header comment (L21–25) |
| `frontend/src/lib/voice/caddie-turn-timing.test.ts` | Update flush-count/ordering expectations; strengthen clamp tests |
| `frontend/src/components/CaddieSheet.handsfree.test.tsx` | Update test "(14)" flush expectations (L700–729) |

**No product-code change anywhere else — verified:**
- `frontend/src/components/CaddieSheet.tsx` NO change. Wiring: timer L403 (`surface: "caddie-turn"`), `markFirstAudio` via `onSpeakStart` L405, `markFirstToken` L616, `markEos` L959, `markTranscript` L1022.
- `frontend/src/hooks/useVoiceCaddie.ts` NO change. Wiring: timer L98 (`surface: 'caddie-rt'`), `markEos` L149 (listening→connected), `markFirstAudio` L152 (first `'speaking'`).
- `frontend/src/lib/voice/telemetry.ts` NO change — the injectable `flush` seam (`flushVoiceEvents`) already exists and is the same drain path failure events (`flush:true`) use.
- `backend/app/routes/voice.py` `/telemetry` NO change — already caps events/batch and clamps field lengths.

## 3. Mechanism

**Chosen approach: call the existing injectable `safeFlush()` seam immediately after each successful leg emit**, inside the existing `if (ms !== null)` guards:

- `markTranscript()` (~L111): `if (ms !== null) { safeEmit("caddie.eos_to_transcript", ms); safeFlush(); }`
- `markFirstToken()` (~L123): `if (ms !== null) { safeEmit("caddie.transcript_to_first_token", ms); safeFlush(); }`
- `markFirstAudio()`: **unchanged** — conditional emits for `first_token_to_first_audio` + headline, followed by the existing single terminal `safeFlush()` (one flush ships both audio-time legs in one POST).
- Update the file-header design notes (L21–25) to state the per-leg flush rationale (legs must survive an iOS suspend even when first audio is never marked).

**Why this and not `voiceEvent(..., { flush: true })`:** functionally identical (`voiceEvent` with `flush:true` pushes then drains the same queue via `flushVoiceEvents`), but routing the flag through would require widening the injectable `emit` seam signature (`CaddieTurnTimerOptions.emit`) to carry `flush?: boolean`, leaking a control flag into every test assertion and coupling the timer to telemetry.ts internals. Using the already-injected `flush` seam right after `emit` keeps both seams' contracts unchanged and keeps flush independently spy-able in tests.

**Keep the explicit `safeFlush()` at `markFirstAudio()`: KEEP.** Not redundant: (a) it is the ONLY flush that ships the two audio-time legs (they get no per-emit flush, avoiding a redundant back-to-back double-POST); (b) it is the sole flush on the `caddie-rt` path (headline-only); (c) in the all-legs-clamped case it drains ride-along batched events at end of turn, and on an empty queue `flushVoiceEvents()` early-returns with zero network cost.

**All existing guards preserved untouched:** once-per-turn idempotence (`tTranscript !== null`, `tFirstToken !== null`, `audioMarked`), `markEos()` full downstream reset, the `<=0 || >60000ms` sanity clamp in `leg()`, and the try/catch-swallow discipline (`safeFlush` swallows sync throws and attaches a `.catch` to the returned promise).

**Not over-flushing:** a full classic turn produces exactly 3 POSTs (transcript leg, token leg, both audio legs in one), an RT turn exactly 1, an incomplete turn only as many as legs that actually emitted; clamped legs emit and flush nothing. Caddie turns are human-paced, so worst case is a few small POSTs per minute from one device. Backstops: frontend `MAX_QUEUE=60`, backend per-batch cap + per-field clamps. Honesty note: `/telemetry` carries no per-endpoint telemetry limiter (auth only); "backstop" = those caps plus the upstream LLM limiter that bounds turn frequency. Non-timing telemetry surfaces keep their existing batch cadence.

**No PII:** `safeEmit` (L73–79) only ever forwards `{ ms }`; the timer never touches transcript text or user content. POSTed shape = `surface` + `event` + `ms`. A test assertion pins this.

**caddie-rt:** unchanged; still delivers the headline with an immediate flush at `markFirstAudio()`. Note for the go/no-go reader: 0 `caddie-rt` events may also be low orb usage — this change maximizes capture per turn but cannot manufacture turns; if `caddie-rt` stays at 0 while `caddie-turn` volume appears, that is a usage signal, not telemetry loss.

## 4. Test plan

**This is an intended behavior change to flush counts — updated assertions match the new intended behavior; explicitly NOT test-gaming, and no assertion is weakened beyond what the behavior change requires (several are strengthened).**

`frontend/src/lib/voice/caddie-turn-timing.test.ts`:
- "full classic turn": emit expectations unchanged (4 legs, exact ms); add `expect(flush).toHaveBeenCalledTimes(3)`.
- "immediate flush" → rename "per-leg immediate flush": assert flush called after `markTranscript()` (count 1, order `emit:caddie.eos_to_transcript` then `flush`), after `markFirstToken()` (count 2), after `markFirstAudio()` (count 3, order `emit:first_token_to_first_audio`, `emit:eos_to_first_audio`, `flush` — two audio legs share one flush).
- "realtime two-mark turn": unchanged, must still pass — headline emit ×1, flush ×1 (RT regression tooth).
- "incomplete turn": flip `expect(flush).not.toHaveBeenCalled()` → `expect(flush).toHaveBeenCalledTimes(1)`. **Core new tooth**: a turn that never reaches first audio still ships `eos_to_transcript` immediately.
- "reset per turn": per-turn flush count 1 → 3.
- Both sanity-clamp tests: add `expect(flush).not.toHaveBeenCalled()` — a clamped leg must not trigger a flush (strengthened).
- "failure isolation": must still pass unmodified — the always-throwing flush mock now also throws inside `markTranscript`/`markFirstToken` and must still be swallowed.
- New assertion (in the rewritten flush test): the `emit` spy is only ever called with `{ ms: <number> }` — no `detail`, no text (no-PII pin).

`frontend/src/components/CaddieSheet.handsfree.test.tsx` test "(14)" (L700–729), end-to-end with the real timer and mocked bus:
- L719 `expect(telemetryState.flushVoiceEvents).not.toHaveBeenCalled()` → `toHaveBeenCalledTimes(2)` (transcript + token legs each flushed before first audio).
- L728 `toHaveBeenCalledTimes(1)` → `toHaveBeenCalledTimes(3)`.
- Rename from "…flushes exactly once at first audio" to "…flushes each stage-timing leg immediately".
- All four `voiceEvent` payload assertions (L717–718, L723–726) and `toHaveBeenCalledTimes(4)` stay exactly as-is.

`frontend/src/lib/voice/telemetry.test.ts`: no changes (telemetry.ts untouched); must still pass.

## 5. Verification gates (all must pass)

1. `cd frontend && npm run lint`
2. `cd frontend && npx tsc --noEmit`
3. `cd frontend && npm run build`
4. `cd frontend && npx tsx voice-tests/runner.ts --smoke`
5. `cd frontend && npx vitest run src/lib/voice/caddie-turn-timing.test.ts src/components/CaddieSheet.handsfree.test.tsx src/lib/voice/telemetry.test.ts`
6. `cd backend && ruff check .`

No local Postgres, no docker, no UI change (silent per NORTHSTAR.md).

## 6. Edge cases / risks

- **Over-flush:** bounded ≤3 POSTs/classic turn, 1/RT turn, human-paced; clamped/no-op marks flush nothing; empty-queue flush early-returns. Non-timing surfaces stay batched.
- **Redundant double-flush:** avoided — audio legs share the single terminal flush; per-emit flush added only to the two text legs.
- **Rate-limit interaction:** `/telemetry` has no server-side limiter (verified); backstops are the per-batch cap, 60-item client queue, and the LLM limiter bounding turn frequency. Acceptable for one owner device; revisit if user count grows.
- **keepalive on suspend:** each POST already uses `keepalive: true`; pagehide/visibilitychange flushes remain final backstops — per-leg flushing leaves far less to them.
- **Failed POST = dropped events** (queue spliced before fetch): existing accepted telemetry semantics; do NOT add retries.
- **Guards:** idempotence/reset/clamp/swallow all untouched; the failure-isolation test proves a throwing flush in the new call sites can't reach dictation/audio.
- **Signal interpretation:** post-ship, `eos_to_transcript` volume without matching `eos_to_first_audio` is itself the diagnostic that iOS audio-marking (`onSpeakStart`) never fires — a separate follow-up, not this change.
