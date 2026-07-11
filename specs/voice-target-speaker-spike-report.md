# Spike report — target-speaker voice filtering (enrollment + on-device TSVAD)

Branch: `spike/voice-target-speaker` · Classify: **SILENT** (research spike; no app-visible change)
Owner ask (2026-07-09): "how hard is it to filter out other people's voices, especially in
the background?" — on-course partners + wind degrade the caddie's ears (upstream of the
"makes up words" transcription problem).

Status: COMPLETE. Deliverable = this report + `specs/voice-target-speaker-spike-plan.md`
(Fable plan) + the pure `speaker-gate.ts` core (committed, gated). No app-visible change.

## TL;DR verdict
- **Tier-1 "ignore background/distant voices": ALREADY DONE.** Every mic constraint + backend
  noise-reduction is on; the only untouched lever (raise `server_vad` 0.5→~0.6-0.7) is a
  tuning A/B, QUEUED — not a code win. ~70% of the value was already shipped.
- **Tier-2 "only ever respond to the OWNER, hands-free" (enrollment + TSVAD gate): FEASIBLE,
  MEDIUM effort, but the honest on-device shape is a NATIVE Core ML Capacitor plugin — NOT
  in-webview WASM.** Reason (decisive, verified): Capacitor's WKWebView cannot enable the
  cross-origin isolation (COOP/COEP) that threaded WASM/WebGPU require, so onnxruntime-web is
  capped at single-threaded CPU there, and its iOS-WASM path has a live, still-open breakage
  history. Go/no-go: **GO on the feature, but sequence it AFTER the current voice-reliability
  work and build it as a native plugin.** Not-worth-it-yet: full VoiceFilter extraction.
- **Committed now (path-independent):** the pure cosine-gate decision core + enrollment
  centroid + voiceprint serialization (`speaker-gate.ts`, 20 unit tests) — reusable by both
  the WASM and native paths, so no work is wasted regardless of which inference path wins.

## Tier-1 (mic constraints + VAD knobs) — VERIFIED FINDING
Evidence from the real capture path (this branch, HEAD):
- `frontend/src/lib/voice/realtime.ts:325-331` (cold mic open) — `echoCancellation:true,
  noiseSuppression:true, autoGainControl:true`.
- `frontend/src/lib/voice/realtime.ts:453-459` (warm `attachMic`) — same three, all `true`.
- `frontend/src/lib/voice/deepgram.ts:52-58` (VoiceRecorder for STT) — same three, all `true`.
- `frontend/src/lib/voice/pcm-capture.ts` and `deepgram-live.ts:195` consume an ALREADY
  constrained `MediaStream` (no second getUserMedia) — inherit the constraints.
- Backend `backend/app/services/realtime_relay.py:129-141` already sets server-side
  `noise_reduction:{type:"near_field"}` before VAD, and `server_vad` threshold `0.5`
  (prefix_padding 300ms, silence 500ms — OpenAI defaults). semantic_vad available via env.

Verdict: **the Tier-1 "quick win" is already shipped.** There is NO free 1-line
enablement to implement — the constraints have been on. The only remaining Tier-1 lever is
raising the `server_vad` threshold (0.5 → ~0.6-0.7) so distant/quiet partners fall below the
trigger. That is a behavior-change tradeoff (risks rejecting the owner's own quieter speech),
so it must be A/B tuned, not shipped blind → QUEUED, not implemented in this spike.

## Tier-2 (TSVAD) — feasibility findings

### The architecture (standard, pretrained, assemblable)
`Silero VAD (anyone speaking?) → speaker-embedding of the window → cosine similarity vs the
enrolled owner voiceprint → open/hold the mic-to-caddie`. This is literally Google's
**"Personal VAD"** Score-Combination baseline (Ding et al., Odyssey 2020, arXiv:1908.04284):
`s = cos(e_window, e_target)`, enrollment embedding stored on device. Named prior art, not
research. Caveat: the modular cosine-gate is the LOWER-accuracy baseline (~26% frame-EER in
arXiv:2406.09443) vs jointly-trained Personal-VAD (~10%) — but joint training violates our
pretrained-only constraint, so the cosine-gate is the right-sized tool, accepting the tradeoff.
It should behave as a **filter, not a lock** — but note the two distinct "fail" axes so the
wiring is honest:
- **Decision-level (identity):** the committed `SpeakerGate` is deliberately **fail-CLOSED** —
  an uncertain window (similarity between `closeAt` and `openAt`) does NOT open the gate
  (mechanic A / gate-first). Hysteresis protects the owner only AFTER a clear open, not on the
  first uncertain window. So `micEnabled = gate.open` alone would clip/ignore borderline
  openings — that is by design for the pure core.
- **System-level (availability):** "fail-open" belongs to the INTEGRATION layer — if the model
  or gate crashes/is unavailable, bypass the gate so the mic behaves exactly as today (never a
  dead mic). Mechanic B (open-then-verify) is the integration choice that also softens the
  decision-level clipping. The caddie ignoring its owner is product death, so the wiring must
  add mechanic-B openness on top of this fail-closed core; the core does not provide it alone.

### Concrete pretrained model options (real cited artifact sizes)
Speaker-embedding models, smallest-viable first:
- **NeMo TitaNet-Small** — 192-dim; community Core ML build (Otosaku/NeMoSpeaker-iOS) at
  **~14 MB FP16 / ~7 MB Int8**, iOS 16+. Strongest small-on-iOS lead. Core ML build is
  community, not NVIDIA-official.
- **WeSpeaker ResNet34-LM** — 256-dim, **ONNX 26.5 MB** (first-class ONNX via sherpa-onnx;
  int8 clears 25 MB). CAM++ ONNX 29.3 MB. No official Core ML (open issue).
- **Resemblyzer (GE2E)** — 256-dim, 16.3 MB native `.pt`, but LSTM/PyTorch → needs own
  conversion; weakest accuracy of the set. Fallback only.
- **SpeechBrain ECAPA-TDNN** (83 MB) / **pyannote/embedding** (96 MB) — too big to bundle;
  pyannote 3.1 itself moved to a WeSpeaker ResNet34 wrapper.
- **FluidAudio** (Swift/Core ML, Apache-2.0, ANE-optimized) — bundles Silero VAD + speaker
  embeddings + diarization as mobile-ready primitives (no ready-made "enroll one → gate mic"
  feature; you assemble the gate). Best fit for the native path.
- No off-the-shelf packaged "enroll one → gate the mic" exists free; **Picovoice Eagle** is the
  closest packaged product but commercial/closed.

VAD front-end: **Silero VAD** (~2 MB ONNX), via `@ricky0123/vad-web` in-webview or bundled
natively; far more accurate than WebRTC VAD.

### Where it runs — the decisive finding
1. **In-WKWebView WASM: structurally handicapped in Capacitor.** Threaded WASM + WebGPU need
   `SharedArrayBuffer`/cross-origin isolation (COOP/COEP), which Capacitor's custom-scheme
   loader (`capacitor://localhost`) cannot serve — open, unresolved 3+ yrs (capacitor#6182,
   discussion#7553). So onnxruntime-web is **single-threaded CPU only** there, and its iOS path
   has recurring still-open breakage (vad #227/#157/#134 — including a Capacitor-WKWebView SIMD
   report; ORT #15644 SIMD miscompute iOS 16.4+, #22776 "no iOS/WebGPU", #26827 CPU/memory
   blowup). WebGPU reaches WKWebView only from **iOS 26+**. No iOS-WKWebView latency benchmark
   for a speech model exists anywhere — would be **unbenchmarked AND handicapped**.
2. **Native Swift/Core ML Capacitor plugin: the honest choice.** Core ML on the ANE = best
   latency/battery, no WASM fragility, model in the app binary. Reference point: a ~13 MB
   Core ML WeSpeaker runs ~21 ms per second-of-audio on Apple Silicon (directional, not a
   per-window iPhone number). Cost: the FIRST custom native plugin in this repo (currently only
   stock `@capacitor/*`), Swift maintenance, iOS 17+ floor. Exposes `enroll(pcm)→embedding` and
   `score(pcmWindow)→similarity`; the JS side runs the committed `SpeakerGate` policy.
3. **Backend gate: rejected** — audio flows WebRTC phone→OpenAI directly, and shipping partner
   audio off-device to decide whether to listen violates NORTHSTAR's on-device/private feel.

### Latency / size budget (honest)
- The gate is NOT in the network path — it toggles the LOCAL mic track, so it adds nothing to
  speech→reply latency once open. Its cost is time-to-open (~0.3-0.6 s window + inference) +
  duty-cycled CPU (embedding runs only on VAD-positive frames).
- Bundle: ~9-30 MB depending on model+quantization (TitaNet-Small-Int8 + Silero ≈ ~9 MB;
  WeSpeaker-ResNet34 ≈ ~28 MB). All cited artifact sizes.
- Per-window inference: native Core ML plausibly tens-of-ms on a modern iPhone (extrapolated,
  MUST be measured on target hardware). WASM-in-WKWebView: **no iOS number exists — must be
  measured, and structurally slower.** We do NOT fabricate an end-to-end figure.

### Enrollment UX + storage + threshold
One-time, calm yardage-book card: "Teach the caddie your voice (~10 s)". Capture via the
existing constrained `getUserMedia` + `pcm-capture` tap → slice ~3×3 s, embed each, average →
L2-normalized centroid (`meanEmbedding`, committed) → store **on-device only** via
`@capacitor/preferences` (already a dep; 192-dim ≈ 768 B as base64 via the committed
`serializeEmbedding`; survives WKWebView eviction) → immediate verify loop + one-tap re-enroll.
**Never sent to the backend.** Threshold: NO universal cosine value (VoxCeleb EER 0.65-2.8% is
clean-room and won't transfer to a windy course) — MUST be calibrated on real outdoor/multi-
speaker audio at the equal-error point, then biased toward false-accept.

### Gate composition — defense in depth (mic inward)
1. Mic constraints (echo/noise/AGC) — SHIPPED. 2. **TSVAD gate (this work)** — earliest layer,
the only one that can fix "answered the wrong PERSON" (a partner's cleanly-transcribed "what
club here?" passes every text-level gate). Two mechanics to decide by measurement: **A
gate-first** (`track.enabled=false` until owner confirmed — best privacy, clips first ~0.3-0.6 s
of every owner utterance) vs **B open-then-verify** (open on any VAD speech, `response.cancel`
over the data channel if not the owner — no clipping, brief partner-audio leak; likely better
feel). 3. Backend `noise_reduction:near_field` + `server_vad` — SHIPPED. 4. GOLF_KEYTERMS vocab
bias — SHIPPED (#122). 5. `INPUT_GROUNDING_RULE` — SHIPPED (#122). 6. Cascaded-STT confidence
gate — QUEUED/blocked; slots between 4 and 5 if it lands.

### Overlap & risks
Overlapping speech (owner + partner at once) is the one thing a GATE cannot solve — that needs
Tier-3 VoiceFilter-class EXTRACTION (VoiceFilter-Lite ~2.7 MB), which must run continuously on
the whole stream (heavier, attacks the sub-second budget) → **NOT-WORTH-IT-YET**, defer unless
gating proves insufficient in the field. Other risks: enrollment drift (multi-condition enroll +
fail-open + slow centroid adaptation + one-tap re-enroll), cold-start model load (piggyback the
warm-session preload, never the tap-to-talk path), WKWebView jetsam (a gate crash must degrade
to gate-OFF = today's behavior, never a dead mic), battery (duty-cycle to VAD-positive frames).

## Recommended sequence (the answer to the owner's question)
1. **Now (~free, already shipped):** mic constraints + backend near-field noise reduction are
   ON. Optional next tuning item: A/B raise `server_vad` 0.5→~0.6-0.7 so distant partners fall
   below the trigger (behavior-change — test before shipping). This is the ~70%-for-1% win.
2. **The real hands-free answer (MEDIUM, when prioritized):** enrollment + on-device TSVAD gate,
   built as a **native Core ML Capacitor plugin** (TitaNet-Small-CoreML or FluidAudio + Silero),
   driving the already-committed `SpeakerGate` policy. Precede the build with ONE on-device
   latency/memory measurement (native `.mlmodel` vs single-threaded onnxruntime-web) on a
   physical iPhone. Sequence AFTER the current transcription-reliability work.
3. **Later, only if needed:** VoiceFilter extraction for true cross-talk de-mixing.

## Go / no-go
| Path | Verdict |
|---|---|
| Tier-1 mic-constraint quick win | **DONE** — already shipped; nothing to build. |
| Tier-1 `server_vad` threshold A/B | **QUEUE** — cheap tuning item, test before ship. |
| Tier-2 TSVAD gate, **native Core ML plugin** | **GO (medium), FEASIBLE** — the right hands-free answer; build when prioritized, native not WASM. |
| Tier-2 TSVAD gate, **in-WKWebView WASM** | **NO for now** — structurally single-threaded in Capacitor + iOS-WASM breakage + unbenchmarked. Only if a measurement surprises. |
| Tier-3 VoiceFilter extraction | **NOT-WORTH-IT-YET** — defer to field evidence of overlap. |

## Sources
Fable plan (`specs/voice-target-speaker-spike-plan.md`) carries the full cited source list.
Key: Personal VAD arXiv:1908.04284 · modular-vs-joint EER arXiv:2406.09443 · TitaNet CoreML
(Otosaku/NeMoSpeaker-iOS) · WeSpeaker ONNX (sherpa-onnx / csukuangfj HF) · SpeechBrain ECAPA ·
FluidAudio (Core ML) · Silero VAD · @ricky0123/vad-web + iOS issues #227/#157/#134 · Capacitor
COOP/COEP #6182/#7553 · onnxruntime iOS issues #15644/#22776/#26827 · WebGPU-in-WKWebView iOS 26
(webkit.org/blog/17333) · VoiceFilter-Lite arXiv:2009.04323.
