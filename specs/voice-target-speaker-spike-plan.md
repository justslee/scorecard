# Target-Speaker Voice Filtering — Spike Plan (enrollment + TSVAD gate)

*Fable-authored plan (2026-07-09). Branch `spike/voice-target-speaker` · Classify: SILENT
(research spike; no app-visible change). Continues `specs/voice-target-speaker-spike-report.md`
and `specs/voice-target-speaker-research.md` (owner ask 2026-07-09: filter out playing
partners / background voices). Deliverable: evidence + go/no-go + ONE small pure-TS commit.*

## 0. Scope guard
- Tier-1 is done and verified (all three `getUserMedia` constraint flags true at
  `realtime.ts:325-331`, `realtime.ts:453-459`, `deepgram.ts:52-58`; backend
  `noise_reduction: near_field` + `server_vad` threshold 0.5 in `realtime_relay.py:129-141`).
  This plan does not re-propose it. The one remaining Tier-1 lever — raising `server_vad`
  0.5 → ~0.6-0.7 — stays QUEUED as an A/B tuning item, not spike work.
- Pretrained models only. Zero training. Zero heavy deps added to `package.json` in this spike.

## 1. Feasibility — concrete pretrained options
Architecture is a two-stage gate before the mic-to-caddie path:
**Silero VAD (is anyone speaking?) → speaker-embedding model (is it the OWNER?) → cosine
gate vs the enrolled voiceprint.**

### 1a. Activity front-end
- **Silero VAD via `@ricky0123/vad-web`** (onnxruntime-web). Browser-first, maintained. Silero
  `.onnx` ~2 MB + ORT WASM ≈ **~10 MB** total assets ([vad-web docs](https://docs.vad.ricky0123.com/user-guide/browser/)).
  Known iOS risk: a reported WASM memory-out-of-range on iPhone ([vad #134](https://github.com/ricky0123/vad/issues/134))
  — **must be measured in OUR WKWebView**.
- Consumes what `pcm-capture.ts` already produces (16 kHz mono PCM from an AudioWorklet tap on
  the existing constrained stream) — no second `getUserMedia`, no WebRTC-sender contention.

### 1b. Speaker-embedding model ("is it HIM")

| Model | Params / dim | Artifact | Size (basis) | Runs where |
|---|---|---|---|---|
| **3D-Speaker CAM++** | ~7M / 192-dim | ONNX (sherpa-onnx) | ~28 MB fp32, ~14 MB fp16 ([HF](https://huggingface.co/Luigi/campplus-zh-en-onnx)) | ORT-web WASM / sherpa-onnx |
| **3D-Speaker ERes2NetV2** | lighter/faster | ONNX | read off release | same |
| **WeSpeaker** (ResNet34-LM…) | varies | ONNX ([sherpa release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models)) | read off release | sherpa-onnx |
| **SpeechBrain ECAPA-TDNN** | ~14-22M | ONNX export | tens of MB fp32 — measure | ORT-web / Core ML |
| **FluidAudio** (pyannote + embedding + Silero, **Core ML**, Swift, Apache-2.0, iOS17+) | packaged | Core ML ([HF](https://huggingface.co/FluidInference/speaker-diarization-coreml)) | RTF 0.017 (~60× realtime) M1 ([repo](https://github.com/FluidInference/FluidAudio)) | **native plugin** |
| Resemblyzer (GE2E) | ~1.4M / 256 | PyTorch-era | small | fallback only |

**Prototype pick:** CAM++ fp16 (~14 MB, 192-dim) for webview; FluidAudio for native. Caveat:
CAM++/WeSpeaker ONNX take kaldi 80-dim fbank features, not raw PCM — sherpa-onnx bundles the
extractor and ships WASM ([docs](https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html)),
tilting the webview path toward **sherpa-onnx WASM** over hand-rolled ORT-web.

### 1c. Where it runs — three shapes
1. **In WKWebView (WASM):** feasible in principle (sherpa-onnx→WASM, vad-web native). Verify:
   (a) **single-threaded SIMD WASM** — Capacitor's custom scheme lacks COOP/COEP so no threads
   ([ORT flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html));
   (b) documented iOS WASM failures ([ORT #15644](https://github.com/microsoft/onnxruntime/issues/15644),
   [ORT #22086](https://github.com/microsoft/onnxruntime/issues/22086), [vad #134](https://github.com/ricky0123/vad/issues/134));
   (c) WKWebView jetsam ceilings. WebGPU not load-bearing (small models, CPU fine).
2. **Native Capacitor plugin (Core ML):** wrap FluidAudio / Core ML-CAM++ in a Swift plugin
   exposing `enroll(pcm)→embedding`, `score(pcmWindow)→similarity`. ANE = best latency/battery,
   no WASM fragility. Cost: first native plugin in the repo; Swift maintenance; iOS 17+ floor.
3. **Backend gate:** rejected — audio flows WebRTC phone→OpenAI directly; shipping partner audio
   off-device to decide whether to listen violates NORTHSTAR on-device/private preference.

### 1d. Latency / CPU budget
The gate is NOT in the network path (it toggles the LOCAL track) — adds nothing to speech→reply
once open. Cost = time-to-open at onset + continuous CPU.
- Speaker decision needs a ~0.25-0.5 s window → intrinsic onset delay ~**0.3-0.6 s + inference**.
- Inference time **must be measured** on-device. Optimism: sherpa-onnx runs speaker-ID realtime
  on phones (native APKs); FluidAudio 60× realtime M1. Caution: single-thread WASM is several×
  slower — no number until measured.
- Budget: ≤ ~200 ms compute per 0.5 s window, duty-cycled only on VAD-positive frames. If WASM
  misses it → flip to native plugin.
- Bundle: webview ≈ 12-40 MB lazy web assets; native ≈ similar MB in the app binary, off JS heap.

## 2. Enrollment UX + storage + threshold
Flow (one-time): calm yardage-book card "Teach the caddie your voice (~10 s)" → capture via the
existing constrained `getUserMedia` + `pcm-capture` tap → slice ~3×3 s, embed each, **average →
L2-normalized centroid** → store on-device ONLY via `@capacitor/preferences` (already a dep;
192-dim ≈ 768 bytes as base64; survives WKWebView eviction better than localStorage/IndexedDB) →
immediate verify loop with one-tap re-enroll. **Never sent to the backend.**

**Threshold:** cosine accept points are model/condition-specific — **must calibrate** (record
owner in quiet/wind/speakerphone + 2-3 other voices, pick equal-error, then **bias toward
false-accept over false-reject** — the caddie ignoring its owner is product death). The gate is
a **filter, not a lock**: on indeterminate windows, **fail open**. Mitigations: hysteresis +
sticky-open for the turn, slow rolling centroid adaptation (capped), one-tap re-enroll.

## 3. Gate composition (defense-in-depth, mic inward)
1. Mic constraints (echo/noise/AGC) — SHIPPED.
2. **TSVAD gate (this work):** Silero VAD → embedding window → cosine vs centroid → drive mic.
   - **Option A gate-first:** hold `track.enabled=false` (`realtime.ts:416-420` `setMuted`) until
     owner confirmed. Best privacy; clips first ~0.3-0.6 s of every owner utterance.
   - **Option B open-then-verify:** open on any VAD speech, verify within ~0.5 s; if not owner,
     re-mute + `response.cancel` over the data channel. No clipping; brief partner-audio leak +
     occasional cancelled turns. Likely better feel — report recommends one with reasoning.
3. Server `noise_reduction: near_field` + `server_vad` — SHIPPED (threshold A/B queued).
4. Transcription vocab bias (GOLF_KEYTERMS) — SHIPPED (#122).
5. `INPUT_GROUNDING_RULE` ("don't answer what you didn't clearly hear") — SHIPPED (#122).
6. Cascaded-STT confidence gate — QUEUED/blocked; slots between 4 and 5 if it lands.

The TSVAD gate is the earliest layer: it fixes "answers the wrong PERSON," which no text-level
gate can (a partner's cleanly-transcribed "what club here?" passes every grounding rule).

## 4. What this spike commits (minimal, testable)
One new pure-TS module + tests, **zero model dependency**:
- `frontend/src/lib/voice/speaker-gate.ts` — `cosineSimilarity`, `meanEmbedding`
  (L2-normalized enrollment centroid), `SpeakerGate` (hysteresis + fail-open + reset;
  model-agnostic — any 1b candidate's score plugs in later), and voiceprint serialization
  helpers (embedding ↔ base64 for Preferences).
- `frontend/src/lib/voice/speaker-gate.test.ts` — synthetic-embedding unit tests
  (identical/orthogonal/noisy, threshold boundary, hysteresis no-flap, fail-open on
  zero-norm, centroid math, serialization round-trip).
- Named-but-NOT-added deps (recorded with costs): `@ricky0123/vad-web` + onnxruntime-web
  (~10 MB), CAM++ ONNX (~14-28 MB) / sherpa-onnx WASM; FluidAudio Swift (native path).
- Update `specs/voice-target-speaker-spike-report.md` with Tier-2 findings + §6 verdict.

**Gates (from `frontend/`):** `npm run lint` · `npx tsc --noEmit` ·
`npx vitest run src/lib/voice/speaker-gate.test.ts` (+ full `npm test` green) ·
`npx tsx voice-tests/runner.ts --smoke` (pipeline untouched).

## 5. Edge cases & risks
- **Overlapping speech:** the mixture embedding matches neither voice — gating can't separate
  overlap; that's Tier-3 VoiceFilter-class extraction, explicitly deferred.
- **Enrollment drift** (wind/exertion/illness/distance): multi-condition enrollment, fail-open
  bias, slow centroid adaptation, one-tap re-enroll.
- **Cold-start:** 14-28 MB parse + WASM init is seconds-class (**measure**); piggyback on the
  existing warm-session preload, never on the tap-to-talk critical path.
- **Memory/stability:** WKWebView jetsam + documented iOS WASM failures — a gate crash must
  degrade to gate-off (mic behaves exactly as today), never a dead mic.
- **Privacy:** voiceprint on-device only, never in telemetry/backend; enrollment audio discarded
  after embedding (NORTHSTAR-positive). Option B's brief partner-audio leak is the one trade.
- **Battery:** duty-cycle the embedding model to VAD-positive windows; native/ANE wins if WASM hot.

## 6. Go/no-go
| Path | Verdict | Cost |
|---|---|---|
| **A. In-WKWebView WASM** (sherpa-onnx WASM / vad-web + ORT-web + CAM++ fp16) | **CONDITIONALLY FEASIBLE — pending one on-device latency/memory measurement.** Parts all exist pretrained with web runtimes; open risks = iOS-WASM stability + single-thread speed. | +12-40 MB lazy web assets; TS-only (no Swift); slowest inference; the measurement. |
| **B. Native Capacitor plugin** (FluidAudio Core ML / Core ML CAM++) | **FEASIBLE, higher confidence** — proven Core ML embeddings on ANE, best latency/battery, immune to WASM fragility. The destination if A's measurement disappoints. | First custom native plugin; Swift maintenance; iOS 17+ floor; model in binary. |
| **C. VoiceFilter extraction** (overlap) | **NOT-WORTH-IT-YET** — full enhancement model attacks the sub-second budget; only if B ships and overlap dominates. | Real DSP pipeline + latency; research-grade risk. |

**Recommended sequencing:** commit the §4 gate logic now (path-independent core of A and B) →
measure A in the simulator/device next cycle → if A misses §1d budget, go straight to B rather
than optimizing WASM. Enrollment UX (§2) and gate composition (§3) are already designed.
