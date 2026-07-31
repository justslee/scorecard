# STT A/B report — Deepgram nova-3 vs OpenAI gpt-live-transcribe

specs/live-transcription-plan.md §7 (owner-mandated, GATES the cutover) and
§11 build sequence step 7.

## Status: **UNRUN**

**Explicit rule (plan §7, restated verbatim): the cutover recommendation
rides on measurements. If the A/B ends up UNRUN, the answer is NO
CUTOVER — `LIVE_STT_ENGINE` stays `deepgram`.**

This bench has never been executed. The code (`backend/bench/stt_ab/`) is
complete and its pure component (`wer.py`) is unit-tested (18 passing tests,
`backend/bench/stt_ab/test_wer.py`) — but the streaming run itself requires
`OPENAI_API_KEY` and `DEEPGRAM_API_KEY`, neither of which exists on the
machine that built this bundle.

## Why it hasn't run

- Both API keys are required to stream real audio to both vendors' live WS
  APIs. Neither is available on the dev Mac.
- The prod keys live on the EC2 boxes (`i-0826ae70df62d9fe8` /
  `i-0a7f675b219a2a93a`, SSM-reachable) — but an automated SSM
  `send-command` was BLOCKED by the permission classifier in a prior
  session (per the plan's own §7 credentials note), so this was never
  assumed to run unattended.
- Per this bundle's explicit builder instructions: do NOT attempt to run the
  bench and do NOT try to reach the EC2 boxes from this session. The run is
  a deliberate manual follow-step for whoever has key access (eng-lead via
  an interactive SSM session, or the owner locally).

## What's ready to run (a future manual step)

```bash
cd backend
export OPENAI_API_KEY=...
export DEEPGRAM_API_KEY=...
uv sync   # installs numpy + websockets

uv run python bench/stt_ab/synthesize.py \
    --utterances bench/stt_ab/utterances.json --out-dir bench/stt_ab/audio

uv run python bench/stt_ab/run_ab.py \
    --utterances bench/stt_ab/utterances.json \
    --audio-dir bench/stt_ab/audio --out bench/stt_ab/results.json
```

Full method, honest limitations, and the P2 probe curl are documented in
`backend/bench/stt_ab/README.md` — not duplicated here to avoid drift
between two copies of the same method description.

## Method summary (see the bench README for the full version)

- **10 utterances** (`backend/bench/stt_ab/utterances.json`): golf-vocabulary
  dense lines drawn from `frontend/voice-tests/corpus/seed-utterances.jsonl`
  plus the known STT confusion targets from
  `frontend/voice-tests/generators/stt-noise.ts`'s `WORD_SWAPS`.
- **3 noise conditions per utterance**: clean, +pink-noise SNR 10 dB,
  +wind-like low-frequency noise SNR 5 dB (server-side TTS +
  numpy-synthesized noise — `backend/bench/stt_ab/synthesize.py`).
- **Streamed to both engines** at real-time pacing (250 ms chunk cadence)
  over their actual live WS APIs — Deepgram linear16@16kHz (mirrors
  `deepgram-live.ts`), OpenAI base64 PCM16@24kHz (mirrors `openai-live.ts`).
- **Metrics**: overall WER, golf-term error rate (scored-term list per
  utterance), first-partial latency, settle time — computed by
  `backend/bench/stt_ab/wer.py` (pure, unit-tested, no network).

## Cutover bar (unchanged, restated so this report is self-contained)

`LIVE_STT_ENGINE` may only flip from `deepgram` to `openai` once a real run
shows, **across all three noise conditions**:
1. golf-term error rate for `openai` <= Deepgram's, **AND**
2. first-partial latency within +150 ms of Deepgram's.

Until that run happens and clears the bar, `LIVE_STT_ENGINE` stays at its
default `deepgram` and this report's status stays **UNRUN**.

## Per-utterance results

_Not applicable — no run has occurred. This section will be filled in with
the measured per-utterance × per-condition × per-engine table (WER, golf-
term error rate, first-partial ms, settle ms) the first time
`run_ab.py` actually executes, and this file's Status line updated
accordingly._

## P2 probe — does gpt-live-transcribe mint inside a `type:"realtime"` session?

**Status: UNRUN** (same missing-key reason as above). The curl + expected
result (a 400, confirming the working assumption that `gpt-live-transcribe`
requires the separate `type:"transcription"` mint this bundle built, per its
model card listing only `v1/realtime/transcription_sessions` support) is
documented in `backend/bench/stt_ab/README.md`'s P2 section. If a future run
unexpectedly returns 200, that is a NEW, cheaper follow-up item (swap
`OPENAI_REALTIME_TRANSCRIBE_MODEL`) — per plan §13, it must be filed and
planned separately, not folded silently into this one.
