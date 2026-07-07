# Implementation Plan: `voice-tts-sheet-replies`

Spoken caddie replies in the text sheets (`CaddieSheet`, `LooperSheet`). Today those sheets render the caddie's answer as silent text — unreadable on-course in sunlight. This adds opt-in TTS playback of a completed sheet reply, persona-matched, tap-to-silence, iOS-safe, and degrading silently to text on any failure. The Realtime orb (`CaddiePanel` voice tab) already speaks and is out of scope.

## 1. Chosen approach + provider

**Provider: OpenAI TTS** (`/v1/audio/speech`, model `gpt-4o-mini-tts`, mp3).

One-line justification: the caddie persona's `voice_id` field already holds OpenAI voice names (`ash`/`sage`/`verse`/`fable` — see `backend/app/caddie/types.py:192` and `personalities.py`), the orb already speaks in those voices via `realtime_relay.py`, and the backend already holds `OPENAI_API_KEY` — so OpenAI TTS makes the sheet caddie sound **identical to the orb caddie for the same persona with zero new voice-mapping table**. Deepgram Aura would need a new `voice_id → aura-*` map and would sound different from the orb.

Shape: one HTTP call per completed reply (not per token), whole-file mp3 back (replies are 1-3 sentences), played through a single unlocked `<audio>` element. Streaming TTS is noted as a later optimization to pair with P2 reply-streaming.

## 2. Backend

New service module `backend/app/services/openai_tts.py`, mirroring `services/deepgram.py` structure exactly (module-level key guard, `httpx.AsyncClient`, `HTTPException` on error):

```
async def synthesize_speech(text: str, voice_id: str | None) -> bytes
```
- Guards `OPENAI_API_KEY` (500 if missing, like `realtime_relay.py:236`).
- Clamps `text` to ~4096 chars (OpenAI input limit + cost cap); strips empty.
- POSTs `https://api.openai.com/v1/audio/speech` with `{model: "gpt-4o-mini-tts", voice: voice_id or "sage", input: text, response_format: "mp3"}`, `Authorization: Bearer OPENAI_API_KEY`.
- Returns raw mp3 bytes; raises `HTTPException(resp.status_code, ...)` on ≥400.

New endpoint in `backend/app/routes/voice.py` (this router is already registered `dependencies=_owner_only` in `main.py:71`, so auth is inherited):

```
class SpeakRequest(BaseModel):
    text: str
    personality_id: str = "classic"

@router.post("/speak")
async def speak(req: SpeakRequest, user_id: str = Depends(current_user_id)):
    persona = await load_personality(req.personality_id)   # DB-first, hardcoded fallback
    audio = await synthesize_speech(req.text, persona.voice_id)
    return Response(content=audio, media_type="audio/mpeg")
```
- Auth: `Depends(current_user_id)` — matches `/transcribe` (metered key stays server-side). Owner-gate is also applied at router level.
- Whole-file, not streaming: simplest and most robust for the iOS `<audio>` element; replies are short. Note streaming as future.
- Reuses the persona resolver `load_personality` (`app/caddie/personalities.py`) — the same one the orb uses — so the voice is guaranteed consistent with the orb.

**Shared types:** No new shared `types.ts` ↔ `models.py` shape is required — the request is a tiny route-local Pydantic model and the response is binary. The one shared shape that matters, persona `voice_id`, is already synced (`CaddiePersonalityInfo.voice_id` exists in `frontend/src/lib/caddie/types.ts:94` and on the backend persona). A reviewer should NOT expect a models.py edit.

## 3. Frontend

### New shared hook `frontend/src/hooks/useSheetTTS.ts`
Single owner of one `HTMLAudioElement`, reusing the exact iOS pattern from `realtime.ts` (DOM-attached, `playsinline`, hidden). API:
- `unlock(): void` — call synchronously **inside a user gesture**. Creates the element on first call, appends to `document.body`, sets `playsInline`/`muted` bless-play-then-pause so later programmatic `.play()` is allowed under WKWebView autoplay rules. Idempotent.
- `speak(text, personaId): void` — no-op if the mute setting is off or text is empty. Otherwise: abort any in-flight fetch, stop current playback, `fetch` `/api/voice/speak` via `authHeaders()` + `res.blob()` (fetchAPI only does JSON, so use a direct `fetch` with `authHeaders()` like `getGolferProfileAsync` does), `URL.createObjectURL` → `audioEl.src` → `.play()`. Revoke the previous object URL. Wrapped in try/catch: any failure is swallowed (text is already on screen) and reported via the existing `lib/voice/telemetry.ts`.
- `stop(): void` — pause + reset currentTime; used by tap-to-silence and on sheet close/unmount.
- `isSpeaking: boolean` state for the affordance.
- Uses an `AbortController` so a new reply cancels an outstanding fetch (overlap handling), and a single element guarantees no double-voice.

### iOS unlock wiring (reusing realtime.ts's approach)
The `<audio>` element must be blessed during the same gesture that starts dictation. In each sheet's existing mic-tap handler, call `tts.unlock()` **synchronously at the top, before** the `async` dictation start:
- `CaddieSheet.tsx` → `handleMicTap` (line 456).
- `LooperSheet.tsx` → `handleMicTap` (line 332).
Also call `tts.unlock()` on the speaker-toggle tap (also a user gesture) so enabling TTS mid-session works even if the next reply isn't preceded by a mic tap.

### Where replies are spoken (the single completed-reply site per host)
- `CaddieSheet.tsx`: in `askCaddie`, right where `setVoiceAnswer(responseText)` is set (line 315) → `tts.speak(responseText, personaId)`. `personaId` is already a prop.
- `LooperSheet.tsx`: in `handleMicTap`, where `setTurns([..., {role:"looper", text: res.response}])` is set (line 360) → `tts.speak(res.response, "classic")`.

### Tap-to-silence affordance
- A quiet, hairline speaker glyph (inline SVG, `T.pencil` stroke, matching the existing `MicIcon`/`FlagIcon` style in `CaddieSheet.tsx` — no lucide, no new icon lib). Two roles on one control:
  - When idle: toggles the mute setting on/off (persisted).
  - When `isSpeaking`: a tap calls `tts.stop()` (silence) but the control stays present.
- Placement: `CaddieSheet` header row next to the persona identifier; `LooperSheetShell` header (shared, so the general Looper sheet — and tee-time, which reuses the shell — inherit it). Keep it visually minor to protect the calm feel.

### Components that change (exact)
1. `frontend/src/hooks/useSheetTTS.ts` (new)
2. `frontend/src/components/CaddieSheet.tsx` (unlock on mic tap, speak on answer, speaker/silence control)
3. `frontend/src/components/LooperSheet.tsx` (same, in `LooperSheetShell` + the default `LooperSheet` host)
4. `frontend/src/lib/caddie/api.ts` (add `speakCaddieReply(text, personaId): Promise<Blob>` helper, or keep the fetch inside the hook — prefer the api.ts helper for consistency with the other caddie calls)
5. Small settings helper (see §5)

`CaddiePanel.tsx` is NOT changed (its voice tab is the Realtime orb, which already speaks).

## 4. Persona wiring

`persona.voice_id` is the single source of truth and is already synced both ways. Flow: sheet passes `personaId` → `/api/voice/speak` → `load_personality(personality_id)` → `persona.voice_id` → OpenAI `voice`. Fallback mirrors `realtime_relay` (`voice_id or "sage"`). Result: the sheet voice equals the orb voice for the same persona, including custom DB personas (their `voice_id` column flows through). No mapping table, no drift.

## 5. Mute / settings affordance

**No existing sound/voice preference exists** (confirmed — `storage.ts` has no mute/sound key; the only voice-adjacent pref is the persona id in `persona.ts`). Propose the minimal calm affordance, following the `persona.ts` localStorage pattern:
- New tiny helper (either in `storage.ts` or a small `lib/voice/tts-pref.ts`): `getSheetTtsEnabled()/setSheetTtsEnabled(b)` backed by localStorage key `looper.sheetTtsEnabled`.
- Surfaced only as the one quiet speaker toggle described in §3 — no new settings screen.

**Default: OFF (opt-in).** Reasoning: NORTHSTAR mandates a *quiet, calm* app — audio that starts itself is the opposite of quiet, and a barrage of spoken replies would break the on-paper feel. Off-by-default also means zero TTS cost for users who never opt in. The one-tap speaker toggle keeps it discoverable for the sunlight/on-course case the audit calls the "biggest UX gap."

**FLAG FOR OWNER (genuine product decision):** the audit frames spoken replies as high-value on-course, which argues for default-ON. Recommendation is default-OFF + discoverable toggle; the owner should confirm whether they want it default-ON for the on-course value. This is surfaced in the bundle PR / approval note — build ships default-OFF; owner can request the flip when testing.

## 6. Critical files to touch (full paths)

- `/Users/justinlee/projects/scorecard/backend/app/services/openai_tts.py` (new)
- `/Users/justinlee/projects/scorecard/backend/app/routes/voice.py` (new `/speak` endpoint)
- `/Users/justinlee/projects/scorecard/frontend/src/hooks/useSheetTTS.ts` (new)
- `/Users/justinlee/projects/scorecard/frontend/src/components/CaddieSheet.tsx`
- `/Users/justinlee/projects/scorecard/frontend/src/components/LooperSheet.tsx`
- `/Users/justinlee/projects/scorecard/frontend/src/lib/caddie/api.ts` (`speakCaddieReply` helper)

## 7. Edge cases + risks

- **iOS autoplay failure:** `.play()` rejects if the element wasn't blessed in a gesture → catch the rejection, swallow, log a telemetry event (`surface="sheet-tts", event="autoplay_blocked"`). Text is already rendered, so the reply is never blocked. This is the hard rule: TTS is strictly additive.
- **Overlapping playback (new reply while old speaks):** `speak()` aborts the in-flight fetch and calls `stop()` before starting the new one; a single shared element makes double-voice structurally impossible (same guarantee `realtime.ts` enforces for the orb).
- **Rapid taps:** `stop()`/`unlock()` are idempotent; toggling mute rapidly just flips the persisted boolean.
- **Cost of TTS calls:** off-by-default → zero cost for most; one call per completed reply (not per token); server clamps input length. `gpt-4o-mini-tts` is the cheap tier.
- **Streaming replies vs one-shot:** replies today are one-shot full text, so whole-file TTS fits cleanly. When P2 reply-streaming lands, TTS can synthesize per-sentence — noted as future, not built now.
- **Offline / no network:** fetch throws → swallowed → text stays. No spinner, no error surfaced for TTS (it is a silent enhancement).
- **Empty / very long replies:** empty → `speak()` no-ops; long → server clamps (speaks the leading portion) and never errors the reply path.
- **Persona switch or sheet close mid-playback:** `stop()` on persona change and on sheet close/unmount (`CaddieSheet` already has an open-gen cleanup effect; `LooperSheet` has `close()`).
- **Northstar / no-fake-data:** TTS reads the real reply text verbatim — never invents content. Quiet is preserved by default-OFF + a single minor hairline control; no notification noise, no new design language, no new dependency.

## 8. Gates + new tests

Run exactly:
- `cd frontend && npm run lint`
- `cd frontend && npx tsc --noEmit`
- `cd frontend && npm run build`
- `cd frontend && npx tsx voice-tests/runner.ts --smoke` (deterministic parser gate — unaffected by TTS; must stay green, i.e. no broken imports)
- `cd backend && ruff check .`

New tests:
- **Backend unit test** `backend/tests/test_voice_speak.py`: monkeypatch `httpx`/`synthesize_speech`, assert (a) persona → `voice_id` resolution passes the right voice to the OpenAI call, (b) input length clamp, (c) missing-key → 500, (d) response `media_type == "audio/mpeg"`. Mirrors existing service-mock tests in `backend/tests/`.
- **Frontend hook test** `frontend/src/hooks/useSheetTTS.test.ts` (Vitest, jsdom): mock `fetch` returning a Blob and stub `HTMLMediaElement.prototype.play` (jsdom lacks it); assert (a) `speak()` is a no-op when muted, (b) a second `speak()` aborts/stops the first, (c) `unlock()` is idempotent, (d) a rejected `play()` does not throw out of `speak()`.
