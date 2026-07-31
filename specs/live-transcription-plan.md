# Plan: Live user-speech visualization ("see my text as I say it") + gpt-live-transcribe evaluation

Owner directive (2026-07-31): "A new ChatGPT model came out called gpt-live-transcribe. Can we
use that instead of Deepgram for caddie chats? This would be nice for visualizing my text as I
say it which was something I've wanted for a while for this app."

The FEATURE (live text while speaking) is the priority; the model is the owner's proposed
vehicle. This plan delivers the feature, evaluates the model honestly, and gates any vendor
cutover on measurements.

All paths below are relative to the worktree root
`/Users/justinlee/projects/scorecard/.claude/worktrees/agent-a7ff743ade6e18867/`.

---

## 1. Research + honest verdict

### 1.1 What gpt-live-transcribe is
Launched ~2026-07-29: a streaming speech-to-text model for "low-latency transcript deltas from
live audio." API shape (established by prior research; builder re-verifies against
developers.openai.com/api/docs/models/gpt-live-transcribe and /guides/realtime-transcription):

- **Endpoint constraint (LOAD-BEARING):** the model card states only
  `v1/realtime/transcription_sessions` is supported. It is NOT listed among the values
  accepted at `session.audio.input.transcription.model` for `type:"realtime"` sessions
  (documented set at `backend/app/services/realtime_relay.py:29-33`: `gpt-4o-transcribe`,
  `gpt-4o-mini-transcribe`, `whisper-1`). **Working assumption: it CANNOT replace the
  transcriber inside our conversational caddie session.** §1.4 defines the cheap runtime
  probe that settles this; do not build on the optimistic branch.
- Session config: `{"type":"session.update","session":{"type":"transcription","audio":
  {"input":{"format":{"type":"audio/pcm","rate":24000},"transcription":{"model":
  "gpt-live-transcribe","prompt":"...","keywords":[...],"languages":["en"],"delay":"low"},
  "turn_detection":...}}}}`. `delay` in {minimal, low, medium, high, xhigh}. `keywords` =
  literal domain terms — a first-class upgrade over the free-text `prompt` our realtime
  path uses today.
- Events: partial `conversation.item.input_audio_transcription.delta` (field `delta`),
  final `conversation.item.input_audio_transcription.completed` (field `transcript`).
- Transport: `wss://api.openai.com/v1/realtime?intent=transcription`; browser auth via the
  ephemeral client secret as WebSocket subprotocol (`openai-insecure-api-key.<ephemeral>`),
  minted server-side, ~60s TTL. Audio input over the WS is `input_audio_buffer.append`
  events carrying **base64 PCM16 @ 24 kHz** — no opus/webm.

### 1.2 Cost math (honest)
- gpt-live-transcribe: **$0.017/min**. Deepgram nova-3 streaming: **$0.0077/min** (~2.2x).
- Dictation-path usage per 18 holes: the dictation mic is open in bursts (score entry, sheet
  questions). Estimate 25–40 utterances x ~6–10 s ~= **3–5 min live audio/round**.
  - Deepgram: ~$0.023–0.039/round. gpt-live-transcribe: ~$0.051–0.085/round.
  - **Delta ~= +$0.03–0.05 per round.** Immaterial next to the conversational realtime
    session (gpt-realtime audio pricing dominates caddie cost by an order of magnitude).
- A PARALLEL always-on transcription session next to the caddie realtime session (option B,
  §2) would bill $0.017/min for the entire session duration (~10–30 min mic-open per round
  -> $0.17–0.51/round) AND double uplink audio. That is the expensive shape; rejected below.
- No public WER/latency benchmark exists for gpt-live-transcribe. Deepgram nova-3 is the
  acknowledged streaming-latency leader (~250–300 ms). Claims of superiority in either
  direction are unmeasured until our A/B (§7) runs.

### 1.3 The honest verdict — say it plainly
**The owner's feature is mostly an event-handling gap in our own client, not a missing
vendor.** In the live caddie (`frontend/src/lib/voice/realtime.ts`) the ASSISTANT's words
already stream (`response.audio_transcript.delta`, ~line 844) but the USER's transcription
deltas are silently swallowed by the `default:` case (~line 1044) — only `.completed`
(~line 936) renders. That asymmetry is exactly what the owner noticed. Our own test suite
(`frontend/src/lib/voice/realtime-dedup.test.ts:170-188`, pin R5) already models
`conversation.item.input_audio_transcription.delta` arriving in the CURRENT session with
gpt-4o-transcribe — the events exist today at zero added cost; we drop them.

On the dictation path (Deepgram), live interim text ALREADY exists
(`frontend/src/lib/voice/deepgram-live.ts` requests `interim_results=true`;
`CaddieSheet.tsx:2060` and `CaddieOrbSheet.tsx:302` render it). The reason the owner
doesn't experience it: (a) `backlog.json` item `caddie-realtime-conversation` (line ~509)
records "the sheet's Deepgram live path keeps failing on his iPhone -> fallback recorder has
no VAD -> manual taps", and (b) the in-round caddie was deliberately routed to the OpenAI
Realtime session — the one path with NO user partials. Verified in code: both are true.

**Recommendation:** gpt-live-transcribe is NOT required for the feature and CANNOT (per its
model card) replace the transcriber inside the caddie realtime session. It IS the right
candidate for the *dictation* engine (purpose-built streaming STT, first-class `keywords`,
same ephemeral-mint security shape we already run) — but at 2.2x the per-minute price, an
unproven WER, an unproven-on-iOS transport, and ~2x today's uplink bandwidth on iOS. So:
ship the feature via our own dropped event (zero vendor change), and land the
gpt-live-transcribe engine **behind a server-side flag, default off**, cut over only if the
owner-mandated A/B (§7) measures it at parity or better.

### 1.4 Two cheap runtime probes (design, not assumption)
- **P1 — "does the conversational session stream user deltas on device, and when?"**
  Add telemetry (existing `voiceEvent` -> `POST /api/voice/telemetry` -> `journalctl … | grep
  voicetel`): `caddie/input_delta_first` with `ms` measured from
  `input_audio_buffer.speech_started`, and detail `before_stop=true|false` (whether the
  first delta preceded `speech_stopped`). This settles the one real unknown of seam A: GA
  docs describe input transcription as asynchronous — deltas may stream mid-speech or burst
  just after the turn commits. Either way text "types itself in"; the telemetry tells us
  which experience shipped and whether escalation (§13 deferred B') is warranted.
- **P2 — "does gpt-live-transcribe mint inside a `type:"realtime"` session?"** One manual
  curl on the EC2 box (where OPENAI_API_KEY lives) against `/v1/realtime/client_secrets`
  with `transcription.model="gpt-live-transcribe"`; the mint 400s on invalid fields
  (established behavior, `realtime_relay.py:213-214`). Expected: rejection, confirming the
  fork. Documented in the bench README (§7); if it unexpectedly succeeds, that opens a
  cheaper follow-up (swap `OPENAI_REALTIME_TRANSCRIBE_MODEL`) — a follow-up, not this item.

---

## 2. Seam choice for live visualization

Candidates:
- **(A) Handle `.delta` in the existing realtime session.** Zero new vendor, zero new
  per-minute cost, works today (events already arrive; R5 models them). Delivers the
  feature on the exact surface the owner uses (the live caddie). Risk: delta timing may be
  "fast settle after speech" rather than word-by-word mid-speech (P1 measures).
- **(B) Parallel gpt-live-transcribe session alongside the caddie realtime session.**
  Word-by-word guaranteed, but double audio uplink, double per-minute cost ($0.17–0.51 per
  round), a second mic pipeline fighting the WebRTC echo-cancel path, and a merge problem
  (two transcripts of the same utterance). Rejected as the primary; kept as the measured
  escalation IF P1 shows deltas are unusably late (§13).
- **(C) Replace Deepgram's dictation WS with a gpt-live-transcribe transcription session.**
  The right home for the owner's named model: same display-only live-text role, same
  ephemeral-token shape, first-class `keywords`. Costs 2.2x/min (immaterial at 3–5 min per
  round), but transport unproven on iOS and uplink is base64 PCM (§5, §10).
- **(D) = A + C.** **CHOSEN.** A is the noticeable feature; C is the flagged engine swap
  that honors the owner's model request and fills the slot the never-built cascaded-STT
  spike left open (`specs/caddie-input-grounding-plan.md` L4; backlog
  `caddie-cascaded-stt-spike` blocked) — ground-truth streaming TEXT of the user's words,
  independent of the speech-to-speech model.

**Surfaces that get live user text (A):**
- CaddieSheet live mode: `frontend/src/components/CaddieSheet.tsx:1831-1839` (LiveVoiceBody)
  already maps `streaming: m.partial` into the `Transcript` primitive — user partials render
  with ZERO UI change once emitted.
- Round-page orb VoiceSheet: `frontend/src/components/yardage/Voice.tsx:259` already sets a
  streaming user turn but has no partial text; fed via
  `frontend/src/hooks/useVoiceCaddie.ts:385` -> `messagesToTurns`
  (`frontend/src/lib/caddie/transport.ts:162-166`), which today flattens to `{role,text}`
  and DROPS `partial` — the one widening needed.
- Round setup: `frontend/src/components/VoiceRoundSetupRealtime.tsx` consumes the same
  `RealtimeMessage` stream — rides along.
- Dictation surfaces (CaddieSheet classic, CaddieOrbSheet, LooperSheet, ScoreSheet,
  CourseSearch) already render live interim text; (C) changes their engine, not their UI.

---

## 3. Part A — user transcription deltas in `realtime.ts` (the noticeable feature)

### 3.1 `frontend/src/lib/voice/realtime-ordering.ts`
Add `peekOrderForUserTranscript(itemId?: string): number` to `MessageOrderTracker`:
- Reservation exists for `itemId` -> return it **WITHOUT deleting** (the existing
  `orderForUserTranscript` at the `.completed` path still consumes it — reservation
  lifecycle unchanged, so partial emission can never desync user/assistant ordering).
- `itemId` present but no reservation (speech_started dropped) -> reserve a fresh slot keyed
  by `itemId` (so the later final finds and consumes the SAME slot) and return it.
- No `itemId` -> peek `pendingUserOrders[0]` without shifting; else `++seq` fallback.
Unit-test in `realtime-ordering.test.ts`: peek is idempotent, peek-then-consume returns the
same key, peek never shifts another turn's order.

### 3.2 `frontend/src/lib/voice/realtime.ts` — new event case
Add `case 'conversation.item.input_audio_transcription.delta':` (today swallowed by
`default:` at ~L1044). Exact guard semantics — which existing guards apply to a PARTIAL:

| Guard | Applies to partial? | How |
|---|---|---|
| `!this.opened` pre-open gate | YES | `if (!this.opened) break;` — a warm session must never leak a phantom partial |
| `processedUserItems` dedupe | YES (read-only) | a delta for an already-completed item is inert: `if (itemId && this.processedUserItems.has(itemId)) break;` — never ADD to the set from a delta |
| `isPrimingEcho` | PARTIALLY | per-delta, check `isPrimingEcho(accumulated)`; once true, stop EMITTING further partial frames (keep accumulating). The `.completed` handler remains the sole authority that drops/commits. A rendered-then-dropped partial is retracted (§3.3) |
| `setInputClass` / `resolveHeldFor` (no-input clarifier) | NO | a partial must never classify input or release/suppress a held response — only `.completed`/`.failed` classify |
| `pendingSpeechItems` / order reservation consumption | NO | partials peek (§3.1), never consume |

Mechanics: accumulate per `item_id` in the existing `this.partials` map (`id = itemId`,
`role:'user'`, `partial:true`, `order = this.order.peekOrderForUserTranscript(itemId)`);
track emission in a new bounded `userPartialEmitted: Set<string>` (same
`MAX_DEDUP_ENTRIES`/evict-oldest posture as `processedUserItems`). Emit via the existing
`this.events.onMessage?.(…)` seam — the message shape already carries `partial`. Do NOT
touch status (speech_started already set 'listening'). Emit telemetry `input_delta_first`
once per item (§1.4 P1).

### 3.3 Retraction + settle (the two new lifecycle rules)
- **Retraction:** when `.completed` DROPS the turn (empty transcript or priming echo,
  L959-967) or `.failed` fires, and a partial for that `item_id` was emitted: emit
  `{id: itemId, role:'user', text:'', partial:false, order}` — the retraction sentinel.
  Consumers delete on it (§3.5). Without this, a hallucinated echo would linger on screen
  as live text — the exact leak `specs/caddie-context-leak-plan.md` fixed for finals.
- **Settle:** `.completed` with real text upserts the same `id` with `partial:false`
  (existing behavior — same id means the partial bubble settles in place, no jump). On
  terminal status (`closed`/`error`), consumers settle any lingering user partial to
  `partial:false` in place (caret stops blinking; text stays) — orphan handling for a
  socket that dies mid-utterance.

### 3.4 The R5 test pin — intent-preserving alignment, not weakening
`frontend/src/lib/voice/realtime-dedup.test.ts:170-188` ("R5: input transcription .delta
events never commit a user message (final-only pin)") counts ALL user-role emissions via
`userMessages()` (L46-48, filters only on role) — it would go red on partial emission.
The fix uses the file's OWN established idiom for "committed": three lines above R5, the
assistant pin (L165) reads `assistantMessages(onMessage).filter((m) => !m.partial)`.

- Before: `expect(userMessages(onMessage)).toHaveLength(0);` … then `…toHaveLength(1);`
- After:  `expect(userMessages(onMessage).filter((m) => !m.partial)).toHaveLength(0);`
  … then `expect(userMessages(onMessage).filter((m) => !m.partial)).toHaveLength(1);`
- ADD (not replace) assertions in R5 proving the partials DID arrive: 2 partial user
  messages, text accumulating `'what'` -> `'what club'`, each carrying the SAME `order` the
  final later carries. Coverage strictly increases; the pin's stated invariant — deltas
  never COMMIT a user message — is preserved verbatim and becomes symmetric with the
  assistant pin in the same describe block. Frame exactly this way in the PR; the reviewer
  will check this edit against the never-weaken-tests rule.

New sibling test file `frontend/src/lib/voice/realtime-user-partials.test.ts` (same
fake-WebRTC harness, `realtime-test-fakes`): accumulation; ordering before the assistant
reply (delta -> response deltas -> completed); pre-open gate; late-delta-after-completed
inert (R3 interplay); priming-echo emission stop + retraction on drop; `.failed`
retraction; empty-completed retraction; no `setInputClass`/`resolveHeldFor` calls from
deltas (clarifier hold untouched — drive with `driveClarifierResponse`); terminal settle.

### 3.5 Consumer changes
All merging happens upstream of the Transcript primitive — its header invariant at
`frontend/src/components/yardage/Transcript.tsx:3-18` forbids the primitive itself from
sorting/deduping/filtering.

- `frontend/src/hooks/useCaddieLiveSession.ts` `upsert` (~L371): on a retraction sentinel
  (`role:'user' && !partial && text.trim()===''` for an id present in state) DELETE the
  entry; on terminal status, settle user partials in place.
- `frontend/src/hooks/useVoiceCaddie.ts` merge (~L139): same retraction-delete + settle.
- `frontend/src/lib/caddie/transport.ts` `messagesToTurns` (L162-166): widen `VoiceTurn`
  to `{ role; text; partial?: boolean }` and carry `partial` through (existing
  empty-text filter is the belt for any retraction that slips through).
- `frontend/src/components/yardage/Voice.tsx` (L17-18 type, ~L259): streaming flag becomes
  `!isCaddie && (t.partial ?? (isLast && voiceState === "listening"))` — live partial text
  now fills the previously blank streaming turn.
- `frontend/src/components/CaddieSheet.tsx` LiveVoiceBody: no change (already maps
  `streaming: m.partial`).

---

## 4. Part C — dictation engine flag + `OpenAILiveTranscriber` (gpt-live-transcribe)

### 4.1 The flag
- Name: **`LIVE_STT_ENGINE`**, backend env, values `deepgram` (DEFAULT) | `openai`.
- Read server-side only, in the new mint endpoint (§4.2). The browser learns the engine
  from the endpoint's response — no `NEXT_PUBLIC_*` var, so the flag flips without an app
  build or TestFlight round (matches the bundle cadence).
- Flag-off behavior: endpoint returns `engine:"deepgram"` + a Deepgram token (same
  `grant_live_token()` as today) -> frontend constructs `DeepgramLiveTranscriber` —
  byte-equivalent behavior to today apart from the endpoint consolidation. The legacy
  `POST /api/voice/live-token` stays untouched for one release (older clients + fallback).
- Document `LIVE_STT_ENGINE`, `OPENAI_REALTIME_TRANSCRIBE_MODEL`, `OPENAI_REALTIME_VAD` in
  `backend/.env.example` — CAVEAT: the guard hook blocks `**/.env*`; if `.env.example` is
  caught by that glob, document in `backend/README.md` (or ops notes) instead and say so
  in the PR. Never touch real `.env` files.

### 4.2 Backend: mint endpoint
- `backend/app/services/realtime_relay.py`: add `build_transcription_session_payload(
  keyterms: list[str]) -> dict` (pure, unit-testable, mirrors `build_session_payload`)
  producing `{"session": {"type": "transcription", "audio": {"input": {"format":
  {"type":"audio/pcm","rate":24000}, "transcription": {"model": LIVE_STT_OPENAI_MODEL
  (env, default "gpt-live-transcribe"), "languages": ["en"], "delay": "low", "keywords":
  [...], "prompt": golf_baseline_prompt()}, "turn_detection": {"type":"server_vad",
  "silence_duration_ms": 1200, …}}}}}` — `silence_duration_ms=1200` deliberately mirrors
  Deepgram's `utterance_end_ms=1200` (deepgram-live.ts:41) to preserve auto-send timing
  (§4.4). Add `mint_transcription_session(keyterms) -> dict` POSTing it to the SAME
  `_REALTIME_CLIENT_SECRETS_URL` (builder verifies the GA mint accepts
  `type:"transcription"` config; fallback design if it only mints a bare secret: client
  sends the equivalent `session.update` as its first WS frame — both shapes specified so
  the builder needn't re-plan). This keeps EC2 stateless — mint-only, no WebSocket bridge,
  honoring the invariant stated at `backend/app/routes/realtime.py:9`.
- `backend/app/routes/voice.py`: `POST /api/voice/live-session` — auth
  `Depends(current_user_id)` (same as `/live-token`); body `{keyterms?: string[]}`
  sanitized exactly like `/transcribe` (L69-76: parsed, `str(t)[:80]`, cap 50); response
  `LiveSttSessionResponse {engine, access_token, expires_in, model?}`. Rate limit: reuse
  the existing sliding-window limiter from `backend/app/services/rate_limit.py` at a
  generous rpm (mint is cheap; this is abuse protection, not budget control).
- Server-side keyterm source for the golf baseline: `backend/app/caddie/keyterms.py`
  (`GOLF_KEYTERMS` mirror + `golf_baseline_prompt()`); client context terms (players,
  courses) arrive in the request body from `buildKeyterms()`
  (`frontend/src/lib/voice/keyterms.ts:47`).

### 4.3 Frontend: `frontend/src/lib/voice/openai-live.ts` — new `OpenAILiveTranscriber`
Honors the EXACT `DeepgramLiveEvents` contract (`deepgram-live.ts:76-86`:
`{onInterim, onFinal, onUtteranceEnd, onError}` + `static isSupported()` +
`start(stream)/stop()`) so the six call sites need zero UI changes:
- `start(stream)`: POST `/api/voice/live-session` with `buildKeyterms(...)`; open
  `new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription',
  ['realtime', 'openai-insecure-api-key.' + token])` (builder verifies exact subprotocol
  list against the realtime-websocket guide); stream audio via `PcmCapture` at 24 kHz,
  base64-encoded into `{"type":"input_audio_buffer.append","audio":"<b64>"}` frames.
  `PcmCapture` (`frontend/src/lib/voice/pcm-capture.ts`, TARGET=16000 at L12) gains a
  constructor `targetRate` param (default 16000 — Deepgram path unchanged).
- Event mapping (mirrors `deepgram-live.ts` accumulation semantics exactly, L318-333):
  `…transcription.delta` -> interim = accumulatedFinals + ' ' + currentDelta-accumulation ->
  `onInterim(display)`; `…transcription.completed` -> append to accumulatedFinals, clear
  current, `onFinal(accumulated)`; `input_audio_buffer.speech_stopped` (server VAD, tuned
  to 1200 ms) -> `onUtteranceEnd()` ONLY if words were heard (same guard as
  deepgram-live.ts:305) — this preserves hands-free auto-send at the three
  `onUtteranceEnd` consumers (e.g. `CaddieOrbSheet.tsx:125` `() => micTapRef.current()`).
- `isSupported()`: `typeof WebSocket !== 'undefined' && PcmCapture.isSupported()`.
- Failure at any point -> `onError` + throw from `start()` — identical contract to today.

### 4.4 Engine selection + GENUINE fallback
New `frontend/src/lib/voice/live-stt.ts`: `createLiveTranscriber(events, {keyterms})`
returning the shared `LiveTranscriber` interface (extract from deepgram-live.ts types):
1. POST `/api/voice/live-session`. `engine==='deepgram'` -> `DeepgramLiveTranscriber`
   (token from the same response; constructor extended to accept a pre-fetched token,
   else it self-fetches as today).
2. `engine==='openai'` -> try `OpenAILiveTranscriber.start()`; on ANY failure (mint, WS
   handshake, first-frame error) fall back to `DeepgramLiveTranscriber` via the legacy
   `/api/voice/live-token` path, with telemetry `live_engine_fallback`. Only if BOTH fail
   does the caller's existing `liveFailed` -> blob-recorder fallback engage — the reviewer
   can test flag-on-with-bad-key and see Deepgram interims still work.

Call sites switched from `new DeepgramLiveTranscriber(...)` to the factory:
`frontend/src/hooks/useLooperDictation.ts:87-126`, `frontend/src/components/CaddieSheet.tsx:942`,
`frontend/src/components/yardage/ScoreSheet.tsx:394`, `frontend/src/components/LooperSheet.tsx`,
`frontend/src/components/CourseSearch.tsx:455`. (CaddieOrbSheet rides on useLooperDictation.)
The live-vs-blob contract (`frontend/src/lib/caddie/dictation.ts::pickDictationTranscript`;
live final authoritative, blob fallback-only) is untouched.

---

## 5. Security

- No API key or long-lived token ever reaches the client — unchanged posture. Both current
  paths already prove the shape: Deepgram `grant_live_token(ttl_seconds=60)`
  (`backend/app/services/deepgram.py:78-106`) with the `['token', token]` subprotocol
  (browser WebSockets cannot set Authorization headers), and OpenAI ephemeral client
  secrets (`realtime_relay.py`). The new path is the same pattern: server-side mint, ~60 s
  TTL, browser receives ONLY `{engine, access_token, expires_in}`.
- Mint endpoint auth: `Depends(current_user_id)` (Clerk), plus sliding-window rate limit.
- Keyterms are user-adjacent strings entering a vendor payload: server-side clamp
  (`[:80]` per term, <=50 terms) exactly as `/transcribe` does; `keywords` is a literal
  list, not a prompt — no instruction-injection surface; the free-text `prompt` stays
  composed ONLY from closed-set server constants (`backend/app/caddie/keyterms.py`
  posture: "no user free text can enter it").
- WebView/Capacitor: `capacitor://localhost` origin sends no cookies to third-party WS
  hosts; auth rides entirely in the subprotocol — same as Deepgram today. The ephemeral
  secret is single-session, 60 s; leak blast radius is one transcription session.
- This adds a new endpoint + user-facing capability -> run `/security-review` before the
  PR is ready (CLAUDE.md rule), plus `/code-review`.

## 6. iOS reality check + on-device proof

- **Transport asymmetry (the biggest new risk):** the caddie realtime path is **WebRTC**
  (`/v1/realtime/calls`, SDP POST — realtime.ts:282) — that is the iOS-proven OpenAI
  transport. The transcription session is **WebSocket + subprotocol auth** — proven in
  WKWebView for DEEPGRAM (ships today, deepgram-live.ts:207) but UNPROVEN for OpenAI's
  handshake. Evidence says WS+subprotocol works in the WebView generally; OpenAI's
  specific accept behavior must be proven on device. Builder also checks the docs for a
  WebRTC establishment path for transcription sessions (`intent=transcription` on the
  calls endpoint) — if it exists, prefer proving it second; WS is primary per the guide.
- **Proof path (exists in repo):** `frontend/ios/SIMTEST.md` — sim build via
  `npm run build && npx cap sync ios`, `xcodebuild … -sdk iphonesimulator`, launch with JS
  console capture (Capacitor Console plugin). The simulator passes the host mic through,
  so: launch, open a dictation surface with `LIVE_STT_ENGINE=openai` pointed at a dev
  backend, speak a golf sentence, and read `voicetel` events (`live_start_ok` vs
  `live_engine_fallback`) + on-screen interims. **This sim run is a REQUIRED gate for
  flipping the flag, and recommended (cheap) even for the flag-off bundle** to prove the
  fallback path. Note: sim WebKit ~= device WebKit for WS/subprotocol behavior; a
  TestFlight spot-check by the owner remains the final word, as with every bundle.
- Uplink honesty: OpenAI WS audio is base64 PCM16@24 kHz ~= **512 kbps**, vs Deepgram on
  iOS today at linear16@16 kHz binary ~= 256 kbps (and ~32 kbps opus on Android/Chrome).
  2x today's iOS uplink, ~16x the Android path. On weak course LTE this can lag interims
  or starve the socket. Listed as an A/B observation point and a standing argument for
  keeping Deepgram the default until measured (§7).

## 7. The A/B bench (owner-mandated; GATES the cutover)

- **Location:** `backend/bench/stt_ab/` (new; NOT under `frontend/voice-tests/` — the 278
  deterministic offline text tests must stay green and audio has no place in that gate).
  Contents: `README.md` (how to run, where credentials come from, P2 probe curl),
  `synthesize.py`, `run_ab.py`, `wer.py` (pure, unit-tested), `utterances.json`.
- **Utterances:** ~10 golf-vocabulary-dense lines drawn from
  `frontend/voice-tests/corpus/seed-utterances.jsonl` (club names, formats, player names)
  plus the known confusion targets from `frontend/voice-tests/generators/stt-noise.ts`
  WORD_SWAPS (four->fore/ford, stableford->stable ford, …) as the scored-term list.
- **Audio (no fixtures exist repo-wide — verified):** synthesize via the existing
  server-side TTS (`backend/app/services/openai_tts.py`, gpt-4o-mini-tts), then augment:
  clean / +pink-noise SNR 10 dB / +wind-like low-frequency noise SNR 5 dB (numpy; no new
  heavy deps). **Honest limitation, stated in the report template: clean TTS + synthetic
  noise does NOT represent outdoor wind, distance-to-mic, or Lombard speech — exactly the
  conditions where WER matters most. The bench measures vocabulary WER and latency
  credibly; acoustic robustness only weakly. On-course spot-checks by the owner remain
  the real-world check.**
- **Method:** stream each clip to BOTH engines at real-time pacing (chunked sends, 250 ms
  cadence) over their live WS APIs. Metrics per engine: (1) WER overall (pure
  `wer.py`, normalized), (2) golf-term error rate over the scored-term list, (3)
  first-partial latency (first audio byte sent -> first interim), (4) settle time (last
  audio byte -> final). Output: JSON + a written report at
  `specs/stt-live-ab-report.md` with per-utterance tables.
- **Credentials (explicit):** `OPENAI_API_KEY` + `DEEPGRAM_API_KEY` from the environment.
  Neither exists on the dev Mac; prod keys live on the EC2 boxes
  (`i-0826ae70df62d9fe8` / `i-0a7f675b219a2a93a`, SSM-reachable) — but an automated SSM
  `send-command` was BLOCKED by the permission classifier in a prior session, so the plan
  does NOT assume unattended execution. The bench is scripted + reproducible; the run is
  a manual step (eng-lead via an interactive SSM session, or the owner locally).
- **Explicit rule: the cutover recommendation rides on measurements. If the A/B ends up
  UNRUN, the answer is NO CUTOVER — `LIVE_STT_ENGINE` stays `deepgram`.** Cutover bar:
  golf-term error rate <= Deepgram's AND first-partial latency within +150 ms, across the
  noise conditions.

## 8. Designer-facing (BLOCKING review)

The live text must read as the yardage book thinking — quiet, in-place, settling — never a
karaoke box or a transcription widget. Reuse ONLY existing primitives:
- `frontend/src/components/yardage/Transcript.tsx` — the ONE shared turn primitive; its
  `TranscriptTurn.streaming` already renders the blinking listening caret for the USER
  speaker (L152-165). User partials = text in the normal serif turn + that caret; the
  caret disappears when the final settles in place (same id upsert — no jump, no reflow).
- `CaddieSheet.tsx` ListeningIndicator (L2021-2060) serif-italic quoted interim — already
  the dictation idiom; unchanged by the engine swap.
- `frontend/src/components/yardage/tokens.ts` for any incidental styling.
- Standing designer override (CaddieSheet.tsx:1835-1836): partial -> `streaming`, NOT
  `muted` — "dimmed live text reads as broken." Do not re-propose dimming.
- In-place correction: partials are append-accumulated (OpenAI deltas append), so text
  grows rather than flickers; a retraction (§3.3) removes the line entirely — brief and
  rare (echo/empty), reads as the book "thinking better of it."

Designer reviews CaddieSheet live mode, VoiceSheet, and one dictation surface before ship.

## 9. Shared types (`frontend/src/lib/types.ts` <-> `backend/app/models.py`)

- NEW `LiveSttSession` (ts) <-> `LiveSttSessionResponse` (pydantic, in `routes/voice.py`
  following the file's local-model pattern, e.g. `LiveTokenResponse`): `{engine:
  'deepgram'|'openai', access_token: string, expires_in: number, model?: string}`. If the
  builder places the pydantic model in `models.py` instead, mirror in `types.ts` — either
  way the two files stay in sync and the PR lists the pair.
- `RealtimeMessage` unchanged (`partial` already exists). `VoiceTurn` widening is
  frontend-internal (`transport.ts` / `Voice.tsx`), no backend mirror.

## 10. Risks + edge cases (each with its owner in the design)

1. **Partial/final race:** final upserts same id (§3.3); late delta after `.completed`
   inert via `processedUserItems` read (§3.2). Tested.
2. **Ordering desync:** peek-not-consume (§3.1); reservation consumed exactly once by the
   final, as today. Tested against out-of-order sequences.
3. **Dedupe:** deltas never add to `processedUserItems`; duplicate `.completed` stays
   single-commit (R3 untouched).
4. **Priming echo on partials:** emission stops once accumulated text classifies as echo;
   final drop retracts (§3.2/3.3). A dense-golf-vocab REAL utterance that trips the
   classifier mid-stream merely pauses live display; the final still commits it.
5. **No-input clarifier interaction:** partials never classify input or release/suppress
   holds — clarifier logic byte-identical (§3.2 table). Tested with the clarifier driver.
6. **Flapping text:** OpenAI deltas are append-only -> no rewrite flicker. Deepgram interims
   (dictation) already accumulate finals + current partial — unchanged.
7. **Reconnect mid-utterance / orphaned partial:** terminal-status settle in consumers
   (§3.3); reconnect constructs a NEW client with fresh state (existing lifecycle).
8. **Cost blowup:** no parallel session (B rejected); dictation delta ~= +$0.03–0.05/round
   only when flag is ON; realtime session cost unchanged.
9. **Battery/data on course:** OpenAI WS ~= 512 kbps uplink vs 256 (iOS Deepgram) — flag
   default off; A/B + on-course check gate cutover; fallback ladder keeps dictation alive
   on failure.
10. **`onUtteranceEnd` timing regression (hands-free auto-send):** server VAD
    `silence_duration_ms=1200` mirrors `utterance_end_ms=1200`; guard "only if words
    heard" preserved; covered by an adapter unit test asserting no fire on silence.
11. **OpenAI mint/WS unproven on iOS:** genuine Deepgram fallback (§4.4) + sim proof
    (§6) before any flag flip.
12. **R5 pin edit misread as test-weakening:** framed + quoted as intent-preserving
    alignment with the file's own assistant idiom, with strictly-increased coverage (§3.4).

## 11. Build sequence (execute in order; each step leaves gates green)

1. `frontend/src/lib/voice/realtime-ordering.ts`: add `peekOrderForUserTranscript` + tests
   (`realtime-ordering.test.ts`).
2. `frontend/src/lib/voice/realtime.ts`: add the `.delta` case per §3.2, retraction/settle
   per §3.3, telemetry P1. Align R5 per §3.4; add
   `frontend/src/lib/voice/realtime-user-partials.test.ts`.
3. Consumers: `transport.ts` (`VoiceTurn` + `messagesToTurns`), `Voice.tsx`,
   `useCaddieLiveSession.ts` upsert retraction/settle, `useVoiceCaddie.ts` merge
   retraction/settle. Extend `useCaddieLiveSession.connect.test.tsx` /
   `useDetachedCaddieLive.test.tsx` where they assert message flow.
4. Backend: `backend/app/caddie/keyterms.py` reuse; `realtime_relay.py`
   `build_transcription_session_payload` + `mint_transcription_session`;
   `routes/voice.py` `POST /api/voice/live-session` + `LiveSttSessionResponse`;
   DB-free unit tests `backend/tests/test_live_stt_session.py` (payload shape, keyterm
   clamp, flag routing — pattern: `tests/test_transcription_prompt.py`).
5. Frontend engine: `pcm-capture.ts` `targetRate` param; new `openai-live.ts`; new
   `live-stt.ts` factory + fallback ladder; switch the five construction sites; adapter
   unit tests (event mapping, utterance-end guard, fallback ladder with mocked WS/fetch).
6. Types sync (§9). Docs: `backend/.env.example` (or README if guarded); the CLAUDE.md
   caddie-path correction (already landed @d2e36fa — verify, do not redo).
7. A/B bench (§7) — code + README + P2 probe doc; run is a manual follow-step; results
   (or UNRUN status) recorded in `specs/stt-live-ab-report.md`.
8. Proof: iOS sim run per §6 (flag-off fallback proof at minimum); designer review (§8);
   `/security-review` + `/code-review`.

## 12. Exact gates

- `cd frontend && npm run lint`
- `cd frontend && npx tsc --noEmit`
- `cd frontend && npm run build`
- `cd frontend && npx tsx voice-tests/runner.ts --smoke` — **278 must stay green; the
  bench is deliberately outside this harness**
- `cd frontend && npx vitest run src/lib/voice/realtime-user-partials.test.ts
  src/lib/voice/realtime-dedup.test.ts src/lib/voice/realtime-ordering.test.ts` (plus the
  full vitest suite as usual)
- `cd backend && ruff check .`
- `cd backend && python -m pytest tests/test_live_stt_session.py` (DB-free only — this
  machine has NO local Postgres; DB-backed tests run in CI)

## 13. Scope discipline + deferred

**This bundle (ONE buildable item, classified NOTICEABLE):** Part A (live user text in the
caddie surfaces — the owner-visible change), Part C behind `LIVE_STT_ENGINE=deepgram`
(silent rider), the bench harness (silent), docs/type sync.

**Deferred (explicitly NOT this item):**
- Flag flip to `openai` — only after the A/B runs and passes (§7 rule) + sim/device proof.
- Full Deepgram removal (dependency, `deepgram.py`, `/live-token`) — one release AFTER a
  successful cutover, as its own silent item.
- **B' escalation:** if P1 telemetry shows conversation-session deltas land unusably late
  (e.g. first delta consistently > ~1.5 s after speech_started AND after speech_stopped),
  spec a parallel gpt-live-transcribe session for the live caddie as a NEW planned item
  with its cost/merge tradeoffs — not silently grown from this one.
- Course-name/player-context `keywords` server-side enrichment beyond what the client
  sends; per-user language wiring into `languages` (rides the existing
  `voice-language-onboarding` backlog item).
- If P2 unexpectedly shows gpt-live-transcribe mints inside `type:"realtime"` sessions:
  evaluate swapping `OPENAI_REALTIME_TRANSCRIBE_MODEL` as its own item.
