# Live dictation in the CaddieSheet voice tab

Owner (2026-07-06): "Is live transcription of what I'm saying not possible? Instead of the 'Transcribing' loader, show my live dictation and just show some kind of loading animation while the caddie thinks."

## Verified facts
- The sheet is tap-to-toggle (handleMicTap; captions "Tap to speak / Tap to stop / Tap to ask again") — KEEP tap semantics.
- Current flow: startListening() → VoiceRecorder + window.SpeechRecognition (dead on iOS WKWebView) → stopListening() → transcribeBlob (batch Deepgram) → "Transcribing…" dead state → askCaddie(text).
- **The backend already takes TEXT**: askCaddie posts the transcript string to sessionVoice (POST /caddie/session/voice) or talkToCaddie fallback. NO backend change.
- DeepgramLiveTranscriber (lib/voice/deepgram-live.ts) already has onInterim (accumulated finals + partial = best-so-far), onFinal, onError; auths via POST /api/voice/live-token; accepts an existing MediaStream (no double mic prompt); language en-US.
- Reference integration: ScoreSheet.tsx ~358-416 (VoiceRecorder → getStream → DeepgramLiveTranscriber, openGen guard for stale async).
- Calm thinking idiom to reuse: the VoiceOrb pulse dot (components/yardage/Voice.tsx ~70-75, motion.span scale [1,1.4,1], 2.2s loop).

## Decisions
1. **Live final is authoritative; audio upload is fallback-only.** On stop, snapshot the live best-so-far → send it directly → straight to `thinking`. transcribeBlob runs only when live failed/unsupported/empty (brief "Transcribing…" acceptable there only). Rejected: audio-authoritative w/ live display (keeps the dead state); server-side streaming STT (backend already takes text).
2. **Failure modes degrade seamlessly**: keep VoiceRecorder running the whole utterance so the blob always exists; isSupported() false / start() throw / onError / empty snapshot → blob path. Permission denied unchanged.
3. **Tap-to-toggle stays** (no hold-to-talk / VAD — that's the orb's model).

## Voice-path state machine
idle →(tap)→ listening [recorder + live stream; onInterim/onFinal grow a quiet serif-italic line; liveTranscriptRef = best-so-far]
listening →(tap)→ thinking [snapshot ref BEFORE stopping; live.stop(); recorder.stop() (blob kept); snapshot non-empty && !liveFailed → transcript = snapshot (NO upload); else transcribeBlob fallback; empty → error "No speech detected"; pinned transcript stays as the user's line; calm pulse dot + "{caddy.name} is thinking…" while askCaddie runs]
thinking → answered (unchanged render) | error → idle.
`transcribing` is REMOVED from the voice happy path. Distance-tab phases unchanged.

## Files
1. **frontend/src/components/CaddieSheet.tsx** — the work. Imports: +DeepgramLiveTranscriber; REMOVE SpeechRecognition usage; keep VoiceRecorder + transcribeBlob (fallback). Refs: liveRef, liveTranscriptRef, liveFailedRef, openGenRef (bumped on open; guards ALL async). startListening mirrors ScoreSheet (recorder.start → getStream → live.start(stream) in try/catch). stopListening: snapshot → phase 'thinking' → pickDictationTranscript branch → setTranscript → askCaddie; ALWAYS release the recorder/mic even on the live path. Thinking indicator: pulse dot + quiet caption (reuse/export the VoiceOrb idiom — see 4). Listening render keeps the growing quoted serif-italic interim line (wraps; latest visible); consider dropping/shrinking the Waveform (flag to designer). Close-cleanup effect also stops liveRef and clears refs.
2. **frontend/src/lib/caddie/dictation.ts (NEW) + dictation.test.ts** — pure helpers: pickDictationTranscript(liveSnapshot, liveFailed) → 'live' | 'fallback'; isEmptyTranscript(t).
3. **frontend/src/components/CaddieSheet.session.test.tsx** (extend): mock deepgram-live (capture onInterim/onFinal); tests: live happy path (interim renders; stop sends the LIVE transcript; transcribeBlob NOT called; no "Transcribing…"; pinned line + pulse then answer); fallback path (live.start rejects → transcribeBlob called + sent); no-speech (error, back to idle).
4. **frontend/src/components/yardage/Voice.tsx** (tiny, optional): export PulseDot({accent}) extracted from VoiceOrb so the sheet reuses the exact idiom (or inline the same motion.span — either; exporting preferred).
5. **deepgram-live.ts — NO change.** (Optional deferred refinement: flush-before-close in stop(); not needed — interim carries best-so-far and blob covers empties.)
6. **Backend — none.**

## Edge cases
Fast stop no speech → "No speech detected. Tap the mic to try again." Long utterance → line wraps, scroll body keeps latest visible. Sheet closed mid-listen → cleanup stops live + recorder, openGen drops in-flight. Closed mid-thinking → openGen drops the late reply. WS fail mid-utterance → liveFailedRef → seamless blob fallback. Unsupported WKWebView → isSupported false → today's path. Permission denied unchanged. **Concurrent realtime orb**: the orb's degrade path already tears down before opening the sheet; the manual-open path in RoundPageClient must guarantee one mic/stream at a time — DO NOT touch RoundPageClient in this item (a parallel builder owns it); note the check for eng-lead to verify after both land, and guard startListening component-side if a live client is detectable without touching that file.

## Gates
tsc, lint, vitest (deepgram-live, dictation, CaddieSheet.session tests), voice smoke, build. /code-review + designer (growing italic line + pulse vs NORTHSTAR; Waveform keep/drop call). No /security-review (no new endpoint/dep/auth).

## Rejected
Audio-authoritative + live display (keeps dead state); server-side streaming STT; hold-to-talk/VAD; new SaaS thinking animation; keeping window.SpeechRecognition (dead on iOS).
