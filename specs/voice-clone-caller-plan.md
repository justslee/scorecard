# Voice-Clone Caller — Plan: the AI pro-shop caller speaking in the owner's own voice

*Owner ask: "how can I inject my voice for use" — in the context of the AI tee-time caller (PR #124, merged inert). Reading: he enrolls a sample of his voice once, and the outbound caller SPEAKS in a clone of his voice instead of a preset synthetic voice.*

**Disambiguation, briefly:** there is a second plausible reading — enrolling his voice so the CADDIE only *listens* to him (target-speaker filtering). That is a different feature and is already researched in `specs/voice-target-speaker-research.md` (TSVAD / voice-enrollment gate on the mic path). If that's what he meant, point him there. This plan is the caller-voice reading. Notably, the two features could share the same one-time enrollment recording — worth remembering if both ever ship.

---

## 1. Feasibility verdict (the honest answer first)

**Can the current pipeline produce his voice? No.** The live-call path (`backend/app/services/voice_booking/media_bridge.py`) is Twilio μ-law ↔ **OpenAI Realtime**, speech-to-speech end-to-end, and OpenAI Realtime exposes **preset voices only** (`voice: "sage"` in `build_call_session_update`). As of mid-2026, gpt-realtime voices are limited to OpenAI's catalogue; OpenAI has announced "Custom Voices" but access is restricted to eligible/selected enterprise partners via sales — not something a solo app can get. **So the owner's voice is impossible without changing the architecture of the bridge.**

**Is it possible at all? Yes** — by replacing the single speech-to-speech hop with a split pipeline whose TTS leg is a voice-cloning provider (ElevenLabs or Cartesia), streaming `ulaw_8000` straight back to Twilio (ElevenLabs supports μ-law 8k output natively, no transcoding). Expected turn latency lands at roughly **0.6–1.4 s** depending on which brain drives the turn (§2) vs ~0.5–0.8 s today. Feasible, borderline-acceptable latency, comparable per-call cost, meaningful engineering cost.

**Should we build it? Recommendation in §3: not now.** The caller is inert (no Twilio keys, zero real calls placed), the pro shop does not care whose voice books the time, and the disclosure already announces an AI assistant. But the owner asked, so the full design and sequenced build follow — gated so it ships dark like everything else in this feature.

---

## 2. Architecture options

### Option A — split pipeline with a cloning TTS provider (the only way to his voice)

```
Twilio media WS --u-law--> STT (Deepgram streaming) --text--> BRAIN --text--> ElevenLabs Flash streaming (cloned voice, ulaw_8000) --u-law--> Twilio
```

Two sub-variants for the BRAIN, and this is the interesting fork:

**A1 — deterministic `BookingDialog` as the brain (no LLM on the turn path).** `dialog.py` was *literally designed for this shape* — its docstring says: "The simulator drives it today; the live telephony bridge will drive it the same way (speech-to-text in, text-to-speech out)." `BookingDialog.respond()` is pure and returns in microseconds. Turn latency budget:

| Leg | p50 |
|---|---|
| Twilio transit (both directions) | ~100–150 ms |
| Deepgram streaming STT endpointing (end-of-speech wait + final) | ~300–500 ms |
| BookingDialog.respond() | ~0 ms |
| ElevenLabs Flash v2.5 TTFB, cloned voice, `optimize_streaming_latency` | ~150–350 ms (cloned voices add ~80–120 ms vs stock; the latency knob claws back ~40–60 ms) |
| **Total voice-to-voice** | **~600–1000 ms** — comparable to today's Realtime bridge |

Tradeoff: BookingDialog's regex heuristics are brittle against messy real humans compared to gpt-realtime's conversational flexibility (that's *why* PR #124 put the Realtime model on the live path and demoted BookingDialog to the simulator).

**A2 — streaming LLM as the brain (gpt-4.1-mini / gpt-realtime-mini text mode, sentence-chunked into TTS).** Adds LLM TTFT ~200–400 ms → **~0.9–1.4 s** per turn. Phone conversation tolerance is ~1 s before it feels broken; 1.4 s p50 with p95 excursions past 2 s is in "the pro shop says hello? hello? and hangs up" territory unless every leg is tuned (connection pre-warming alone is worth 80–200 ms). Also must hand-reimplement what OpenAI Realtime gives for free: server VAD/turn-taking, barge-in (we'd keep the Twilio `clear` event on Deepgram interim speech-started), and the `record_booking_outcome` tool loop.

Recommended sub-variant if A is built: **A1 with an A2 escape hatch** — deterministic dialog on the turn path, and only if it hits `unclear` twice does a single LLM repair turn fire. Best latency, lowest cost, reuses tested code.

### Option B — keep OpenAI Realtime, preset voice (the "you can't have your exact voice" answer)

No custom voices on Realtime, period. What CAN ship cheaply: make the caller's preset voice an owner-visible choice (`OPENAI_REALTIME_DEFAULT_VOICE` already exists in `.env.example`; the bridge hardcodes `sage` via `OPENAI_REALTIME_DEFAULT_VOICE_DEFAULT`) and pick the preset closest to a natural adult male on 8 kHz phone audio. Zero new latency, zero new vendors, zero new PII.

### Option C — a realtime speech-to-speech API that supports cloning?

Researched; **no true single-hop speech-to-speech API offers custom voice cloning today.** What exists is hosted *orchestration* of the same split pipeline:
- **ElevenLabs Agents** (Scribe STT + LLM + Eleven TTS, native Twilio integration, cloned voices supported) — ~$0.08/min all-in. But it would move the conversation brain, the `record_booking_outcome` tool contract, and — critically — the compliance posture (`STORE_AUDIO = False`; their platform records calls by default) onto a third-party platform. Porting the disclosure-first invariant and no-audio-storage posture out of our code into vendor config is a compliance regression risk.
- **Cartesia Sonic + Line**: fastest TTS in class (~40 ms TTFA), instant clone from ~3 s of audio, agents at ~$0.06/min. A credible ElevenLabs alternative for the TTS leg of Option A — cheaper and faster, slightly less battle-tested cloning quality.
- OpenAI Custom Voices: enterprise-gated, not available. Amazon Nova Sonic / Gemini Live: no user voice cloning.

So Option C collapses into "Option A, hosted" — and hosting it surrenders the compliance invariants we deliberately wrote as code. If A is built, build it in-house on the existing bridge skeleton.

### The tradeoff, stated plainly

**Owner's voice = Option A**: +0–600 ms per turn (variant-dependent), a second (or third) realtime vendor, his voiceprint becoming stored PII at a third party, and rebuilding turn-taking/barge-in/tool-calling we currently get free — versus **preset voice = Option B**: none of that, and the person answering the phone cannot tell the difference in value.

---

## 3. Recommendation & sequencing verdict

**Recommend Option B now; build Option A only if the owner confirms he wants his voice for its own sake.** Reasons, honestly:

1. **Nobody on the receiving end benefits.** The call opens with "I'm an automated AI assistant calling on behalf of Justin…" — the shop knows it's a bot in the first sentence regardless of timbre. The owner's voice buys zero booking success.
2. **The caller has never placed a real call.** Twilio keys haven't landed. Rebuilding the voice path of a feature with zero live usage is optimizing a car that hasn't left the driveway.
3. **It slightly muddies the honesty story.** A human-cloned voice that *discloses* is defensible (§5), but it narrows the gap between "obviously a bot" and "sounds exactly like Justin," which is the gap regulators care about. The preset voice keeps us in the safest posture for the first real calls.
4. The cheap win exists: expose the preset-voice picker (Option B) in the tee-time settings — one env/config read, no new code paths.

If the owner says "I want my voice regardless" — the sequenced build in §7 is the plan, and it's genuinely buildable.

---

## 4. Enrollment design (how the owner provides his voice)

- **Sample:** ElevenLabs Instant Voice Clone works from ~30–60 s of clean speech (tens of seconds minimum; 1–2 min ideal). Professional Voice Clone (30+ min, verification step) is overkill for a phone-band (8 kHz μ-law) output — IVC quality is indistinguishable through a phone. **IVC it is.**
- **Capture:** in-app record flow on the owner's settings/profile surface, reusing the existing hold-to-record + upload pattern from voice round setup (Deepgram one-shot path, `routes/voice.py` / frontend voice lib). He reads a fixed ~45 s script whose FIRST sentence is a spoken consent statement (see §5) — the consent is *inside the sample itself*, which is exactly the documented-consent artifact ElevenLabs' ToS wants.
- **Server flow:** new owner-gated endpoint (e.g. `POST /api/profile/voice-clone`) receives the audio blob → POSTs it to ElevenLabs `POST /v1/voices/add` (multipart, with the required "I have the right and consent" flag) → receives a `voice_id` → **persists only the `voice_id` + enrollment timestamp + consent-script version on the owner's account row** (`backend/app/models.py`) → **discards the raw audio immediately** (consistent with the repo's `STORE_AUDIO = False` posture — we never hold the voiceprint ourselves; the enrollment sample is the single deliberate exception and it lives only in transit).
- **Privacy honesty:** ElevenLabs retains the sample/model on their side per their terms — surface that to the owner in the enrollment UI ("your voice sample is stored by ElevenLabs to power the clone; delete anytime"), plus a delete button that calls `DELETE /v1/voices/{voice_id}` and clears the stored ID. A voiceprint is biometric-adjacent PII (BIPA-style statutes) — single-owner self-enrollment keeps this simple, but the code should be written as if a second user might someday enroll: consent recorded per-account, never shared, never defaulted.

## 5. Consent / ethics / legal / disclosure

- **Self-consent:** his voice, his behalf — fine, and ElevenLabs IVC's requirement is a confirmed-consent attestation at upload time. We satisfy it doubly: the API consent flag + the spoken consent line in the sample ("I, {owner}, consent to Scorecard using a synthetic copy of my voice for tee-time calls made on my behalf").
- **Disclosure stays, verbatim, first — non-negotiable.** `compliance.disclosure_line()` already opens every call with "I'm an automated AI assistant calling on behalf of {name}…". Assessment: a realistic cloned voice that *says it's an AI assistant in its first sentence* is not deceptive — the listener is told the truth before any negotiation happens, which is the FCC/AB-2905 posture the compliance module was built around. A cloned voice *without* that disclosure absolutely would be deceptive, so the disclosure-first invariant (enforced in both `dialog.py` and `media_bridge._send_forced_greeting`) must survive the pipeline swap byte-for-byte. Optional wording refinement for the clone path only: append "— you may notice I sound like him; this is a synthetic voice." Nice-to-have, lawyer's call, not a blocker.
- **Hard constraint, enforced in code:** the cloned `voice_id` is used **only** when `ctx.golfer_name` is the enrolled owner's own account — one enrolled voice per account, always the account holder's own, never selectable for calls on anyone else's behalf. This is a guard in the transport/bridge selection, not a UI convention.
- **No new audio storage:** the split bridge keeps `assert compliance.STORE_AUDIO is False`; transcription stays ephemeral text exactly as today.

## 6. Cost (per ~3-minute call, order-of-magnitude)

| | Today (OpenAI Realtime) | Option A1 (split, cloned voice) |
|---|---|---|
| Twilio outbound | ~$0.04 | ~$0.04 |
| Speech-to-speech / STT | $0.55–$1.40 (gpt-realtime ~ $0.18–0.46/min uncached) | Deepgram streaming ~ $0.02 |
| LLM | — (included) | ~$0 (A1: none; A2: pennies) |
| Cloned TTS (~1–1.5 min agent speech) | — | ElevenLabs Flash ~ $0.05–$0.15 — or Cartesia at roughly half |
| **Total** | **~ $0.60–$1.45** | **~ $0.10–$0.25 + a monthly ElevenLabs subscription floor** |

Surprise finding: the split pipeline is actually *cheaper* per call than gpt-realtime — the real costs are the ElevenLabs monthly minimum, a new vendor relationship holding his biometric data, and the engineering/latency complexity. Cost is not the argument against; complexity and pointlessness-at-current-usage are.

## 7. Sequenced build (if the owner wants his voice regardless)

Everything ships dark behind the existing gating ladder; nothing dials until Twilio keys land, same as today.

1. **Slice V1 — enrollment (inert without `ELEVENLABS_API_KEY`).** `services/elevenlabs_voice.py` (create/delete voice, mirroring `services/deepgram.py`'s module shape); owner-gated route in `routes/profile.py`; `voice_clone_id` + consent metadata on the owner model (`models.py` + migration); frontend record-script flow with the spoken-consent line; delete/re-enroll path. Tests: consent-flag required, sample never persisted, delete clears both sides.
2. **Slice V2 — cloned TTS streaming service.** `services/elevenlabs_tts.py`: WebSocket/HTTP streaming synth, `output_format=ulaw_8000`, `optimize_streaming_latency=3`, Flash v2.5, connection pre-warm. Structure mirrors `services/openai_tts.py`. Unit tests with a fake transport.
3. **Slice V3 — the split bridge, behind a flag.** New `voice_booking/split_bridge.py` implementing the same interface as `run_media_bridge` (Twilio WS in, `PendingCall` future out): Deepgram streaming STT (endpointing tuned ~300 ms) → `BookingDialog.respond()` (A1) → ElevenLabs stream → Twilio `media` frames; barge-in via Twilio `clear` on interim speech; disclosure-first guaranteed by BookingDialog's `connecting` state; outcome via `dialog.finish()` (no tool-call loop needed — deterministic brain). Selection in `routes/voice_booking_ws.py`: `VOICE_BOOKING_VOICE_MODE=clone` **and** an enrolled `voice_clone_id` on the owner → split bridge; anything else → existing OpenAI bridge unchanged. The owner-voice-only guard lives here.
4. **Slice V4 — latency + quality harness.** Extend the rehearsal-call harness (`specs/teetime-rehearsal-call-harness.md`, `_rehearsal_transport_factory` in `routes/tee_times.py`) to measure voice-to-voice turn latency per leg; acceptance: p50 ≤ 1.0 s, p95 ≤ 1.8 s on a rehearsal call, else the flag stays `preset`.
5. **Ship dark.** Flag defaults to `preset`; docs note in `.env.example`; go-live checklist gains "lawyer eyeballs the cloned-voice + disclosure combo before first real cloned call."

Rough sizing: V1 ~1 cycle, V2 ~0.5, V3 ~1.5–2 (the real work), V4 ~0.5.

### Critical Files for Implementation
- `backend/app/services/voice_booking/media_bridge.py` — the current OpenAI Realtime bridge the split bridge sits beside (and whose interface `split_bridge.py` must match)
- `backend/app/routes/voice_booking_ws.py` — where the bridge is selected per call; the `VOICE_BOOKING_VOICE_MODE` fork and owner-voice-only guard go here
- `backend/app/services/voice_booking/dialog.py` — the pure BookingDialog state machine that becomes the split pipeline's zero-latency brain (A1)
- `backend/app/services/voice_booking/compliance.py` — disclosure-first + STORE_AUDIO invariants that must survive the swap unchanged
- `backend/app/services/deepgram.py` — existing STT service the split bridge's STT leg extends; `services/openai_tts.py` is the structural template for the new `elevenlabs_tts.py`
