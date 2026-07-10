# Caddie "makes up words" — it's TRANSCRIPTION, not hallucination

*Owner 2026-07-09 (screenshots): the caddie chat shows the OWNER saying "Scars.",
"of God", "Why is it squeaking?" — words he never said. The caddie then gamely responds
to the nonsense ("Focus. If the club's squeaking or…"). "Making up words. Research other
avenues to make this more reliable."*

## Root cause — this is ASR (speech-to-text), not the LLM
In the live (OpenAI Realtime speech-to-speech) mode, the DISPLAYED user transcript comes
from a separate input-transcription model (gpt-4o-transcribe). Outdoors — wind, distance
from the phone mic, a partner's voice — it MIS-HEARS and INVENTS plausible words ("Scars",
"of God"). Worse: in speech-to-speech, the caddie responds to the AUDIO directly, so
garbled audio → a confused reply, AND the honesty layer we built for FACTS (hazards,
physics) does NOT cover "did I even hear the question right." The model treats noise as a
real utterance and confidently answers it.

## Current config (verified)
- Realtime transcription = `gpt-4o-transcribe` (already the best OpenAI option — lower WER
  + less silence-hallucination than whisper-1), `language=en`. GOOD baseline.
- BUT **no vocabulary/context biasing** on the realtime transcription (config is just
  {model, language}). Our GOLF_KEYTERMS + player/hole context are wired ONLY to the
  Deepgram sheet path, NOT the realtime transcript.
- gpt-4o-transcribe real-world WER ≈ 8–12% on noisy audio — every ~10th word can be wrong,
  which is exactly what the screenshots show.

## Avenues, ranked by leverage

### 1. Confidence-gate + never-answer-gibberish (BIGGEST win, in OUR control)
The caddie must treat a low-confidence / non-parseable utterance as "I didn't catch that —
say again?" — NEVER confidently answer noise. Extend the grounding doctrine (hazards,
physics) to the INPUT: if the transcript doesn't parse as a plausible golf request (or the
ASR confidence is low), ask for a repeat instead of responding. A prompt rule + a light
"is this a real question" check. This alone kills the "responds to Scars" failure.

### 2. Vocabulary + context biasing on the transcription
Feed golf terms + the player's clubs + hole context so "Scars" biases toward a real word.
CAVEAT (verified): OpenAI realtime transcription PROMPT support is limited/unsupported for
some transcribe models — verify gpt-4o-transcribe accepts a biasing prompt in the realtime
session; if not, option 3.

### 3. Cascaded STT with keyterms + confidence (the SOTA reliability architecture)
Route the transcript through our OWN Deepgram nova-3 (which we ALREADY use for the sheet,
WITH keyterm prompting) even in live mode — the transcript becomes ground truth, gated on
confidence, THEN the caddie responds to TEXT. This is the "treat speech as the rendering
layer, not the reasoning layer" pattern (our own agent-architecture study): garbled input
is caught BEFORE a reply. Trades a little latency for a lot of reliability + observability.
Biggest architectural lever; a real slice, not a tweak.

### 4. Noise robustness / target-speaker (already queued)
Wind + partner voices degrade the audio at the source. The queued voice-target-speaker
(enrollment + on-device TSVAD) + mic noiseSuppression/echoCancellation directly reduce the
garbage going INTO the ASR. Compounds with 1–3.

### 5. Push-to-talk option / confirmation echo
Hold-to-talk gives cleaner segments; echo "I heard: <x> — right?" on ambiguous input.

## Recommendation (sequenced)
1. **NOW, high-leverage, our control**: confidence-gate + never-answer-gibberish (a caddie
   input-grounding rule + a plausibility/confidence check). Ships fast, biggest UX win.
2. **Vocab biasing** on the realtime transcript if supported; else stand up
3. **Cascaded Deepgram+keyterms+confidence transcript** as the reliability architecture
   (evaluate latency vs the current speech-to-speech).
4. The **queued target-speaker/noise** work reduces garbage at the source.

## Honest framing
The caddie's FACTS are now grounded (hazards, physics — it won't invent a bunker or a
distance). The gap the owner sees is that its EARS aren't grounded — it will answer a
question it misheard. Fix = extend "don't state what you don't know" from facts to INPUT:
don't answer what you didn't clearly hear.

## Sources
- https://developers.openai.com/api/docs/guides/realtime-transcription
- https://developers.openai.com/api/docs/models/gpt-4o-transcribe
- https://vexascribe.com/how-accurate-is-whisper (WER by condition)
- https://www.mindstudio.ai/blog/gpt-realtime-voice-models-explained
