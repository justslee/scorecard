# Voice agent audit — Looper vs state-of-the-art (2026-07-07)

Owner directive: "Bulletproofing and improving our voice looper agent across the board is our
most important thing." Full-stack review of every voice surface, compared against current
production voice-agent practice (OpenAI Realtime speech-to-speech, Deepgram streaming STT +
Aura TTS, server VAD/endpointing, sub-2s reply budgets, graceful degradation, telemetry).

## The stack today (5 surfaces, 3 pipelines)

| Surface | Pipeline | State |
|---|---|---|
| Realtime orb (in-round) + setup voice | gpt-realtime WebRTC, server VAD, tools, warm preload, degradation ladder | STRONGEST — genuinely SOTA-shaped (speech-to-speech, barge-in, tool grounding) |
| CaddieSheet voice tab | tap-to-talk → Deepgram live/batch → Claude → **text** reply | Good input path (after today); reply is silent text |
| Looper sheets (general/tee-time) | same dictation → talkToCaddie / intent parser | same |
| Course voice search | dictation → query | new, thin |
| Score dictation (ScoreSheet) | Deepgram live + batch | works, same transport caveats |

## Fixed today (P0 — shipped in this bundle)

1. **Crash leakage**: `session_voice`/`voice_caddie` catch-alls returned `str(e)` as the client
   detail (owner saw `{"detail": "list index out of range"}`) and logged no traceback. Now:
   tracebacks to the journal, one calm in-character detail, empty-Claude-content guarded
   (`_first_text`), frontend `humanizeVoiceError` renders machine-looking errors as calm copy.
2. **Live dictation dead on iPhone**: WKWebView MediaRecorder records audio/mp4 (AAC) which the
   Deepgram live socket can't reliably decode, AND the live path ran a second MediaRecorder on
   the same stream (flaky on AVFoundation). Desktop worked; every iPhone silently fell back to
   "Transcribing…". Now: transport split — webm/opus MediaRecorder where supported, WebAudio
   PCM tap (AudioWorklet → linear16@16k, ScriptProcessor fallback) everywhere else.
3. **Fake tiles**: wind/elev were hardcoded → real weather + per-hole relative wind from true
   hole bearings; Gust replaces Elev until real elevation data exists; plays-like wind-adjusted
   and honestly labeled.

## Gap analysis vs SOTA → prioritized roadmap

### P1 — next cycle (each is high-value, contained)
1. **Keyterm boosting** (cheapest accuracy win in the stack): Deepgram nova-3 supports keyterm
   prompting. Boost player names (score dictation), course names (tee-time/search), and golf
   vocabulary (birdie, bogey, up-and-down, club names) on BOTH live and batch calls. SOTA
   agents always bias STT with domain/context vocabulary; we send none.
2. **Spoken replies in the sheets (TTS)**: the caddie only *talks* in the realtime orb; sheet
   answers are silent text — on-course that means reading in sunlight. Add TTS playback of
   sheet replies (Deepgram Aura via a backend proxy or OpenAI TTS), tap-to-silence, honoring
   the persona. This is the single biggest UX gap vs "constant assistant" SOTA.
3. **Auto-send on end-of-speech**: tap-to-talk currently requires a second tap. The Deepgram
   live socket already emits endpointing/UtteranceEnd events — auto-finalize after ~1.2s of
   silence (with the tap still available). One tap → speak → answer, like every modern agent.
4. **Voice telemetry**: we had ZERO visibility (the owner discovered the iOS fallback, not us).
   Log structured client events (transport chosen, live-vs-fallback used, latency ms, error
   class) to the backend; a weekly glance shows fallback rates and regressions.

### P2
5. **Stream the reply text** into the sheet (SSE/chunked from the backend) instead of waiting
   for the full Claude turn — perceived latency drops ~2x; pairs with TTS streaming later.
6. **Brain parity**: orb (gpt-realtime + tools) vs sheets (Claude + injected context) — keep
   grounding at parity (hazards now in both; verify profile/memory parity every time context
   is enriched). Long-term: one brain definition, two transports.
7. **Timeouts/retries**: talkToCaddie/sessionVoice have no client timeout; add budgets +
   single retry on transient failure, degrade with calm copy.
8. **Latency budget + measurement**: target <2s tap-release→first-word; measure via (4).

### P3
9. Language picker at onboarding (already on backlog: voice-language-onboarding).
10. Persona-matched TTS voices in sheets; barge-in during sheet TTS playback.
11. Real per-hole elevation (DEM ingestion at course-map time) to resurrect an HONEST Elev
    tile and a real plays-like model (backlog: course-elevation-ingestion).

## Non-goals (deliberate)
- Replacing the deterministic tee-time parser with an LLM (it's fast, offline-testable, and
  the voice-tests gate depends on determinism).
- A second realtime (speech-to-speech) provider; gpt-realtime stays the orb transport.
