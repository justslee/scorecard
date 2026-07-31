# STT A/B bench (Deepgram nova-3 vs OpenAI gpt-live-transcribe)

specs/live-transcription-plan.md §7 — owner-mandated, GATES the cutover.
**Explicit rule, restated:** the cutover recommendation rides on
measurements. If this bench has never been run, the answer is **NO
CUTOVER** — `LIVE_STT_ENGINE` stays `deepgram`.

**STATUS AS OF THIS COMMIT: UNRUN.** Code + method only. See
`specs/stt-live-ab-report.md` at the repo root for the formal UNRUN report.

Deliberately located at `backend/bench/stt_ab/` — **not** under
`frontend/voice-tests/` (the 278 deterministic offline text tests there must
stay green; audio has no place in that gate).

## Why it hasn't run

- `OPENAI_API_KEY` + `DEEPGRAM_API_KEY` are both required. Neither exists on
  the dev Mac that wrote this bench.
- The prod keys live on the EC2 boxes (`i-0826ae70df62d9fe8` /
  `i-0a7f675b219a2a93a`, SSM-reachable).
- An automated SSM `send-command` was BLOCKED by the permission classifier
  in a prior session — this plan does NOT assume unattended execution. The
  bench is scripted + reproducible; the run is a **manual** step (eng-lead
  via an interactive SSM session, or the owner locally where a key is
  available).

## How to run (once on a box with both keys)

```bash
cd backend
export OPENAI_API_KEY=...      # or already set in the environment
export DEEPGRAM_API_KEY=...

uv sync                         # installs numpy + websockets (see pyproject.toml)

# 1. Synthesize the audio fixtures (clean + pink10 + wind5 per utterance).
uv run python bench/stt_ab/synthesize.py \
    --utterances bench/stt_ab/utterances.json \
    --out-dir bench/stt_ab/audio

# 2. Stream every fixture to BOTH engines' live WS APIs and score them.
uv run python bench/stt_ab/run_ab.py \
    --utterances bench/stt_ab/utterances.json \
    --audio-dir bench/stt_ab/audio \
    --out bench/stt_ab/results.json
```

`bench/stt_ab/audio/` and `bench/stt_ab/results.json` are gitignored bench
output — not checked in (real TTS audio + a specific run's numbers; the
utterances + scored terms that PRODUCE them are what's version-controlled).
After a run, hand-transcribe `results.json` into
`specs/stt-live-ab-report.md`'s per-utterance tables and update its status
line from UNRUN to the measured verdict.

## Method

- **Utterances:** `utterances.json` — 10 golf-vocabulary-dense lines drawn
  from `frontend/voice-tests/corpus/seed-utterances.jsonl` (club names,
  formats, player names) plus the known confusion targets from
  `frontend/voice-tests/generators/stt-noise.ts`'s `WORD_SWAPS`
  (four→fore/ford, stableford→stable ford, three→tree, nassau→nassow, best
  ball→bestball, match play→matchplay). Each utterance carries a
  `scored_terms` list — the golf-term error rate's denominator.
- **Audio (no fixtures exist repo-wide — verified before writing this
  bench):** synthesized via the EXISTING server-side TTS
  (`app/services/openai_tts.py`, gpt-4o-mini-tts — extended with an
  optional `response_format` param, default unchanged at `"mp3"`, so the
  bench can request `"wav"` and avoid needing an mp3 decoder). Three
  conditions per utterance: clean, +pink-noise at SNR 10 dB, +wind-like
  low-frequency noise at SNR 5 dB (numpy — the ONE new dependency this
  bench introduces, dev-group only, never imported by `app/`).
- **Streaming:** each clip is chunked and sent at real-time pacing (250 ms
  cadence, matching the client's actual `TIMESLICE_MS`/`PcmCapture` chunk
  cadence) over BOTH engines' live WebSocket APIs — Deepgram at
  linear16@16kHz (mirrors `deepgram-live.ts`'s PCM transport exactly), and
  OpenAI at base64 PCM16@24kHz (mirrors `openai-live.ts`).
- **Metrics per engine, per utterance, per noise condition** (`wer.py`,
  pure + unit-tested — `bench/stt_ab/test_wer.py`, run explicitly:
  `cd backend && python -m pytest bench/stt_ab/test_wer.py`):
  1. **WER** — overall word error rate (Levenshtein edit distance /
     reference word count, normalized: lowercased, punctuation-stripped).
  2. **Golf-term error rate** — fraction of that utterance's `scored_terms`
     the hypothesis got wrong (word-boundary matched, not substring).
  3. **First-partial latency** — first audio chunk sent → first interim/
     delta event, in ms.
  4. **Settle time** — last audio chunk sent → the final transcript event,
     in ms.
- **Output:** `results.json` (per-utterance × per-condition × per-engine
  rows) — hand-summarized into `specs/stt-live-ab-report.md`'s tables.

## Cutover bar (restated from the plan — do not weaken this)

golf-term error rate for `openai` <= Deepgram's, **AND** first-partial
latency within +150 ms of Deepgram's, **across all three noise
conditions**, before `LIVE_STT_ENGINE` may flip to `openai`.

## Honest limitation

Clean TTS + synthetic (FFT-shaped) noise does **not** represent real
outdoor wind, distance-to-mic, or Lombard speech (golfers unconsciously
raising their voice/enunciating differently in wind/noise) — exactly the
conditions where WER matters most on a course. This bench measures
vocabulary WER and latency credibly; acoustic robustness only weakly.
**On-course spot-checks by the owner remain the real-world check** before
any cutover ships, same as every other bundle.

## P2 probe — "does gpt-live-transcribe mint inside a `type:"realtime"`
session?" (specs/live-transcription-plan.md §1.4)

Settles whether `gpt-live-transcribe` could instead just replace
`OPENAI_REALTIME_TRANSCRIBE_MODEL` inside the conversational caddie's
EXISTING realtime session (the cheap-and-simple outcome, if it worked) vs.
the current working assumption (it CANNOT — its model card lists only
`v1/realtime/transcription_sessions` support, so this plan built the
separate `type:"transcription"` mint path in `realtime_relay.py`). One
manual curl, on the EC2 box (where `OPENAI_API_KEY` lives — never run this
with a key pasted into a shell history on a shared machine):

```bash
curl -s https://api.openai.com/v1/realtime/client_secrets \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "session": {
      "type": "realtime",
      "model": "gpt-realtime",
      "audio": {
        "input": {
          "transcription": { "model": "gpt-live-transcribe" }
        }
      }
    }
  }'
```

**Expected result:** a 400 rejecting `gpt-live-transcribe` as an invalid
`transcription.model` value for a `type:"realtime"` session (established
400-on-invalid-fields behavior — `app/services/realtime_relay.py:213-214`
docs the same mint endpoint's validation posture). That confirms the fork
this plan already built on. **If it unexpectedly returns 200**, that opens
a cheaper follow-up (swap `OPENAI_REALTIME_TRANSCRIBE_MODEL` directly,
no separate transcription-session mint needed) — file it as its own item,
do not fold it silently into this one (specs/live-transcription-plan.md
§13).

STATUS: **UNRUN** (same reason as the bench above — no `OPENAI_API_KEY` on
this machine).
