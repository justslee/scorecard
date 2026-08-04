# Cascaded-STT Feasibility Spike — Deepgram Confidence Gate

**Status:** Plan (spike — proof + recommendation, minimal committed code). Planned on Fable.
**Feasibility question:** Can a cascaded STT path with a *hard, deterministic confidence gate*
stop the live caddie from answering misheard audio ("makes up words"), at an acceptable latency
cost versus the shipped speech-to-speech orb?

## 1. What already exists (verified in code — do not rebuild)

- **Speech-to-speech live orb** (`frontend/src/lib/voice/realtime.ts`): OpenAI Realtime consumes
  raw audio. Vocab-bias transcription prompt and the soft `INPUT_GROUNDING_RULE` nudge
  (`backend/app/caddie/voice_prompts.py:59-69`) are SHIPPED. Neither yields a confidence signal
  to hard-gate on.
- **Full cascaded pipeline already ships** as the classic hands-free sheet: Deepgram nova-3
  streaming (`frontend/src/lib/voice/deepgram-live.ts`, keyterms via
  `frontend/src/lib/voice/keyterms.ts`) → text caddie SSE → TTS. Consumed by
  `frontend/src/components/CaddieSheet.tsx` (gate attach point = `stopListening`, after
  `pickDictationTranscript`, before `askCaddie`, ~line 992).
- **Cascaded latency is already instrumented in prod** (`frontend/src/lib/voice/caddie-turn-timing.ts`):
  legs `caddie.eos_to_transcript`, `caddie.transcript_to_first_token`,
  `caddie.first_token_to_first_audio`, headline `caddie.eos_to_first_audio`, on surface
  `"caddie-turn"` (classic sheet) and `"caddie-rt"` (orb baseline).
- **Confidence already flows on the one-shot path**: `backend/app/services/deepgram.py:72` reads
  `alt.get("confidence")` from `results.channels[0].alternatives[0]`; `TranscribeResult.confidence`
  (`frontend/src/lib/voice/deepgram.ts:16`) surfaces it. The STREAMING live path just discards it.
- **The gap:** `parseDeepgramLiveMessage()` (deepgram-live.ts:102) extracts `{transcript, isFinal}`
  and **discards** `channel.alternatives[0].confidence` (0..1 utterance conf) and
  `alternatives[0].words[].confidence` (per-word). That signal is the entire spike.

So the spike is NOT "build a cascaded architecture" — it is: **prove the confidence gate is
implementable, testable, and cheap, and assemble the honest latency evidence from telemetry that
already exists.**

## 2. Committed code (behind a flag, zero live wiring)

### 2.1 New file: `frontend/src/lib/voice/confidence-gate.ts`

Pure module, style matching `deepgram-live.ts` / `confirm-guidance.ts` (never-throw parser,
exported tunable constants, dense header comment). Shape:

```ts
export interface DeepgramWord { word: string; confidence: number; }
export interface GateInput {
  transcript: string;
  confidence: number | null;   // utterance-level; null when Deepgram omitted it
  words: DeepgramWord[];        // [] when omitted
}
export type GateRejectReason = 'empty' | 'low-utterance-conf' | 'low-word-conf';
export type GateVerdict =
  | { verdict: 'ACCEPT' }
  | { verdict: 'REJECT'; reason: GateRejectReason; detail?: string };

export const UTTERANCE_CONFIDENCE_FLOOR = 0.60;
export const WORD_CONFIDENCE_FLOOR = 0.45;
export const SHORT_UTTERANCE_CONFIDENCE_FLOOR = 0.45; // terse-question guard, see §3
export const SHORT_UTTERANCE_MAX_CONTENT_WORDS = 2;
export const FILLER_WORDS: ReadonlySet<string>;        // uh, um, a, an, the, is, it, to, of, and, so, like...
export const REPROMPT_LINE = "Didn't catch that — say again?"; // matches INPUT_GROUNDING_RULE phrasing
export const CONFIDENCE_GATE_ENABLED = false; // future attach point; nothing reads it yet

export function gateTranscript(input: GateInput): GateVerdict;
export function extractGateInput(raw: string): (GateInput & { isFinal: boolean }) | null;
```

`extractGateInput` deliberately parallels rather than extends `parseDeepgramLiveMessage` — the
shipped parser stays byte-identical (its test file forbids modification), and the gate module owns
its own extraction so it can be deleted wholesale if the spike disproves.

**Gate logic** (O(words), documented in-file):
1. Empty/whitespace transcript → `REJECT 'empty'`.
2. Content words = `words[]` minus `FILLER_WORDS` (lowercase, strip trailing punctuation).
3. **Short-utterance path** (content words ≤ `SHORT_UTTERANCE_MAX_CONTENT_WORDS`): reject only if
   utterance confidence < `SHORT_UTTERANCE_CONFIDENCE_FLOOR`; skip the per-word check (for one-word
   utterances, word conf ≈ utterance conf — double-jeopardy otherwise).
4. Normal path: utterance confidence < `UTTERANCE_CONFIDENCE_FLOOR` → `REJECT 'low-utterance-conf'`;
   any *content* word below `WORD_CONFIDENCE_FLOOR` → `REJECT 'low-word-conf'` with the word in
   `detail`. Low-confidence fillers never reject.
5. Missing signal (confidence null / words empty) → **ACCEPT (fail-open)** — see §4.

**Honest calibration comment (must be in the file):** the numeric floors are placeholders chosen
from Deepgram's documented behavior (clean nova-3 speech typically scores >0.85; garble lands much
lower), NOT calibrated. Real calibration requires on-course audio: log
`(confidence, words, was-the-answer-wrong)` pairs from the classic sheet in prod before trusting any
number. The spike proves the **logic and testability**, not the thresholds.

### 2.2 New file: `frontend/src/lib/voice/confidence-gate.test.ts`

Vitest, mirroring `deepgram-live.test.ts` conventions (raw-JSON message helpers). Cases:

- **Accept**: clean high-conf golf utterance ("how far to carry the bunker", 0.97, words ≥0.9).
- **Reject low-utterance-conf**: the owner's real failure — "Scars" at utterance ~0.3.
- **Reject low-word-conf**: high utterance conf but one content word at 0.2; `detail` names the word.
- **Filler immunity**: "uh"@0.1 amid high-conf content words → ACCEPT.
- **Terse-question guard (adversarial, §3)**: `"driver?"`@0.55 → ACCEPT; same @0.30 → REJECT;
  `"what club"` two words moderate conf → ACCEPT.
- **Empty**: "" → `REJECT 'empty'`.
- **Fail-open**: confidence null, words [] → ACCEPT; malformed words entries never throw.
- **extractGateInput**: pulls confidence + words from a realistic full Results JSON (include
  `punctuated_word`, `start`/`end`); returns null for metadata/UtteranceEnd/malformed JSON without
  throwing; composes with `gateTranscript` end-to-end on a raw message.
- **Micro-benchmark sanity** (evidence, not a wall-time CI assertion): 10k calls on a 30-word
  utterance completes well under a second locally; record the number in the report.

No other files change. No wiring into `CaddieSheet.tsx`, `useLooperDictation.ts`, or `realtime.ts`.

## 3. Adversarial pass — where the gate makes things WORSE

Biggest risk: **false-rejecting real terse golf questions** — `INPUT_GROUNDING_RULE` itself warns
that "driver?", "what club", "how far", "read?", "wind?" are normal on-course speech. A gate that
answers "say again?" to a golfer who clearly said "driver?" is *worse* than an occasional
hallucination. Mitigations baked in: separate lower floor for short utterances + no per-word check
on them; per-word floor only on content words; tests pin the terse cases so threshold tweaks can't
silently regress them. Do NOT exempt keyterm matches from the gate — keyterm biasing can itself
produce a confident-looking wrong golf word (the original bug in disguise).

Second risk (state honestly): a rejected utterance costs a full re-ask round-trip (~3–5s on course).
If false-reject rate exceeds a few percent, the gate is net-negative even if it kills every
hallucination. That is a calibration/telemetry question the spike cannot answer without on-course audio.

## 4. Fail-open vs fail-closed on missing confidence

**Decision: fail-open (ACCEPT).** Missing confidence most likely means schema drift; fail-closed
would turn a format change into a caddie that rejects *every* utterance. The gate is additive;
failing open degrades to exactly today's shipped behavior with `INPUT_GROUNDING_RULE` still active.
Matches the codebase philosophy ("failures degrade silently; the final path is authoritative").

## 5. Answering the latency question without fabrication

| Quantity | Status | Source |
|---|---|---|
| Cascaded end-to-end (EOS → first audio) | **MEASURED in prod** | `caddie.eos_to_first_audio`, surface `caddie-turn` |
| Cascaded sub-legs | **MEASURED in prod** | `caddie.eos_to_transcript` / `transcript_to_first_token` / `first_token_to_first_audio` |
| Speech-to-speech orb baseline | **MEASURED in prod** | same legs, surface `caddie-rt` |
| Gate's own compute overhead | **MEASURED locally** | micro-benchmark in the test (pure O(words); ≪1ms) |
| Architectural delta of routing the LIVE orb through cascaded STT | **ESTIMATED (bracketed)** | Deepgram turn-end wait (`utterance_end_ms=1200`, tunable) + measured downstream legs |

**Go/no-go gate:** this machine cannot query the prod telemetry DB. The owner must pull p50/p90 of
`caddie.eos_to_first_audio` for both surfaces. If cascaded p90 − orb p90 is under ~1.5–2s, options
B/C are viable; if 3s+, the hard gate on the live orb is likely not worth it → option A. The report
ships with the query as an open action item; no invented numbers.

## 6. Architecture options for the final report

- **(A) STAY PUT** — orb + shipped vocab-bias + soft nudge. Zero cost, zero new complexity; no hard
  guarantee. Valid **DISPROVE** outcome.
- **(B) FULL CASCADED live caddie** — promote the existing classic-sheet pipeline + the gate. Pros:
  deterministic gate; pipeline + telemetry exist. Cons: loses Realtime native barge-in; adds turn-end
  wait (≥1200ms) + TTS start; two TTS stacks.
- **(C) HYBRID (recommended candidate)** — Deepgram STT + hard gate produce *verified text*; on
  ACCEPT feed it via the existing `sendText()` (`realtime.ts:368`) so Realtime does LLM+TTS with
  low-latency audio; on REJECT play the canned `REPROMPT_LINE` locally without waking the LLM. Cons:
  still pays the Deepgram turn-end wait; barge-in semantics change; two vendors in the hot path.

**Spike verdict to write:** "gate logic proven cheap and testable; C is the architecture to prototype
next **iff** the prod `caddie-turn` vs `caddie-rt` percentile delta clears the bar; otherwise A." The
disprove outcome is respectable: the shipped nudge may already be enough.

## 7. Implementation sequence

1. `confidence-gate.ts` (types → constants w/ calibration comments → `extractGateInput` → `gateTranscript`).
2. `confidence-gate.test.ts` (§2.2 cases incl. adversarial terse pins + micro-benchmark).
3. Gates: `cd frontend && npm run lint && npx tsc --noEmit && npx vitest run src/lib/voice/confidence-gate.test.ts`,
   then smoke: `cd frontend && npx tsx voice-tests/runner.ts --smoke`. No backend/DB tests.
4. Feasibility report (findings + A/B/C + the open prod-telemetry query as go/no-go); commit both
   files behind the default-off flag.

**Out of scope (explicit):** any wiring into CaddieSheet/useLooperDictation/realtime; threshold
calibration; backend changes; gate-verdict telemetry (note as the obvious next step: emit
`caddie.gate_reject` with `reason` so real false-reject rates become measurable).
