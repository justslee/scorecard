# Filtering out other people's voices — feasibility & approach

*Owner 2026-07-09: "How hard is it to do voice recognition so it filters out other
people's voices, especially in the background?" (on-course: playing partners, wind.)*

## The key distinction
What we have today is **VAD (voice ACTIVITY detection)** — server_vad/semantic_vad decide
speech-vs-silence, but NOT WHO is speaking. So a partner's "nice shot" 10ft away can trigger
or get transcribed. What the owner wants is **target-speaker filtering** — keep only HIS
voice, suppress everyone else. Different, harder tech.

## Three tiers, easiest → hardest

### Tier 1 — knobs we already have (low effort, partial)
- **WebRTC mic constraints**: `echoCancellation`, `noiseSuppression`, `autoGainControl` —
  confirm all ON. Help with steady wind/echo, NOT a nearby human voice.
- **Raise the server_vad energy threshold** — only close/loud speech (the owner holding the
  phone) triggers; a partner 10ft away falls below. Crude but real, zero ML.
- **Hold-to-talk on the realtime path** — physically gate the mic to when the owner is
  speaking. ELIMINATES partner pickup entirely, zero ML — but fights the hands-free goal.

### Tier 2 — target-speaker filtering (the real answer, MEDIUM)
- **One-time voice enrollment**: the owner records ~5-10s once → a speaker embedding
  (voiceprint).
- **Target-Speaker VAD (TSVAD)** — the LIGHT option: a gate that opens the mic-stream only
  when the enrolled speaker is the one talking (vs full audio separation). Cheaper, lower
  latency; a strong fit for "only listen when it's HIM." (arXiv TSVAD line of work is mature.)
- **VoiceFilter-class target-speaker EXTRACTION** — the HEAVY option: mask the audio to keep
  only his voice, suppressing others even when overlapping. Better, but a real model in the
  pipeline.
- **The tension**: both add a PREPROCESSING model before the realtime speech-to-speech
  model, which fights the sub-second latency the caddie's live mode depends on. On-device
  (Core ML) TSVAD is the sweet spot: light, private, gates before audio ever leaves the phone.

### Tier 3 — full diarization (HARD, overkill)
Identify + label all speakers. Unnecessary here — we don't need to know the partner, just
ignore them.

## Honest recommendation (sequenced)
1. **NOW, ~free**: verify echoCancellation/noiseSuppression/autoGainControl are on; A/B a
   higher server_vad threshold so distant voices don't trigger. Ships as a small tuning item.
2. **The hands-free answer**: a one-time voice enrollment + on-device **Target-Speaker VAD**
   gate — open the mic-to-model only when the enrolled owner speaks. Medium effort; the
   right SOTA fit; keeps the hands-free feel AND rejects partners. Needs a spike: which
   on-device TSVAD model, latency budget vs the realtime path, enrollment UX.
3. Full VoiceFilter extraction only if TSVAD gating proves insufficient in overlap.

## Difficulty verdict
- "Ignore distant/background voices": EASY (Tier 1 tuning) — do it now.
- "Only ever respond to the owner's voice, hands-free": MEDIUM — needs enrollment + a
  target-speaker gate; a real but well-trodden feature, not research. The cost is pipeline
  latency, mitigated by on-device TSVAD.
- Not a "train a model from scratch" problem — pretrained speaker-embedding + TSVAD models
  exist.

## Sources
- https://www.assemblyai.com/blog/what-is-speaker-diarization-and-how-does-it-work
- https://arxiv.org/pdf/2309.12521 (Profile-Error-Tolerant Target-Speaker VAD)
- https://arxiv.org/pdf/2501.03184 (Noise-Robust Target-Speaker VAD)
- https://arxiv.org/pdf/2501.03612 (Universal Speaker-Embedding-Free Target Speaker Extraction / personal VAD)
