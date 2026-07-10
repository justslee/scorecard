# Spike report — target-speaker voice filtering (enrollment + on-device TSVAD)

Branch: `spike/voice-target-speaker` · Classify: **SILENT** (research spike; no app-visible change)
Owner ask (2026-07-09): "how hard is it to filter out other people's voices, especially in
the background?" — on-course partners + wind degrade the caddie's ears (upstream of the
"makes up words" transcription problem).

Status: IN PROGRESS — Fable plan + TSVAD research pending. This file is the deliverable.

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

## Tier-2 (TSVAD) — pending research below.
