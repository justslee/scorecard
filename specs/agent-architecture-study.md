# Study: the caddie & tee-time agents vs 2026 state of the art

*Evaluated 2026-07-09 against the current voice-AI + agentic literature (Anthropic,
AssemblyAI's 2026 voice stack, the hallucination/grounding research, real-time-vs-cascaded
architecture writeups). Verdict: both are SOTA; the caddie's grounding is ahead of the
field's RAG default. Honest gaps noted.*

## The caddie agent

### What the field calls state of the art (2026)
- Real-time speech-to-speech, sub-1.5s response, interruptible.
- Structured tool calls with JSON-schema validation.
- Grounding to prevent hallucination (RAG is the common answer).
- "Speech is the rendering layer, not the reasoning layer — draft, ground, verify, then
  speak."
- Connected memory/state; latency engineering; eval + observability.

### What the caddie actually does — mapped
| SOTA expectation | Caddie implementation | Verdict |
|---|---|---|
| Real-time S2S, sub-1.5s, interruptible | OpenAI gpt-realtime WebRTC, server_vad (+ optional semantic_vad), barge-in, streamed replies, sentence-level TTS pipelining, idle-suspend | **Match+** |
| Connect latency | **Warm-session preload** (DORMANT→WARMING→WARM→CONSUMED, withholdMic, silent-placeholder track) — the session is live before the golfer taps | **Ahead** (most agents eat the cold-connect) |
| Structured tool calls | One canonical tool registry (get_carries/conditions/profile/recommendation/session_status/record_shot/…) shared by BOTH mouths (realtime + text) with a **parity drift test** | **Match+** |
| Grounding / anti-hallucination | **Deterministic engines, not RAG**: hazards geometry, ball-flight physics, dispersion, strokes-gained, DECADE, green geometry. The LLM CITES computed truth; a grounding RULE forbids it from computing; a VALIDATOR rejects ungrounded claims before they cache | **Ahead** — see below |
| Draft → ground → verify → speak | Text path: tool-loop → grounded reply → eval-harness verification. Cached strategy guides: LLM-as-writer, geometry as ground truth, validator rejects hallucinated hazards | **Match** (text) / frontier (realtime, below) |
| Eval + observability | Advice-quality eval harness with TEETH (every check proves it can fail); the exact incident failures become golden regression cases; voice telemetry | **Ahead** (most have no output-quality gate) |
| Connected memory | Session memory + player profile + learning.py + shot history | Match |
| Cost | Prompt caching (~75% cut), per-user rate limits, timeouts | Match |

### Why "deterministic engines" beats RAG here — the key insight
The field's default anti-hallucination tool is RAG: retrieve trusted text, hope the model
stays faithful to it. That's right for open-domain knowledge. But golf advice is a
COMPUTABLE domain — a hazard's side and carry, a shot's distance, a putt's uphill side are
math, not documents. So the caddie doesn't retrieve text about the hole; it COMPUTES the
truth (polyline geometry, RK4 ball flight) and forbids the model from doing the math itself.
This is a *stronger* guarantee than RAG: RAG can still be reasoned-around; a validator that
REJECTS any claim the geometry doesn't support cannot. The hazard side-flip incident is the
proof — the system caught and refused a wrong-side claim rather than narrating it. Where the
domain is NOT computable (local course knowledge, "how does this hole play"), it falls back
to exactly the SOTA pattern: LLM-as-writer, grounded + validated, cached.

### Honest frontier (the realtime path)
The SOTA ideal is "draft → ground → verify → THEN speak." The caddie's TEXT path does this
(tool-loop, then a grounded reply). The REALTIME path is true speech-to-speech: faster and
more natural, but the model reasons IN the speech layer — grounding rides on the injected
tools + instructions + the grounding rule, not a post-hoc verify-before-speak gate (which is
hard in S2S). This is the field's acknowledged cascaded-vs-S2S trade-off, and the caddie
hedges it well by running BOTH (S2S for the live feel, the tool-loop/eval for structured
truth). A future enhancement: a lightweight claim-check on realtime tool results before the
model voices a number. Also: semantic_vad is wired but server_vad is the default — worth an
A/B.

**Caddie verdict: state of the art, and its grounding architecture leads the field's RAG
default because the domain is computable and it exploits that.**

## The tee-time booking agent

### What the field calls state of the art (2026)
- For TRANSACTIONAL voice (booking, taking money): an external STATE MACHINE enforcing the
  action sequence, NOT freeform LLM — "trust AI for understanding, enforce action order with
  rules."
- Structured extraction from speech (don't let the model self-report the outcome).
- Guardrails for high-stakes: disclosure, human-in-the-loop, logging.
- Connected to real telephony + real inventory.

### What the tee-time agent actually does — mapped
| SOTA expectation | Implementation | Verdict |
|---|---|---|
| State machine, not freeform | `BookingDialog`: connecting → negotiating → confirming → ended — an explicit FSM | **Match** (exactly the recommended pattern) |
| Structured extraction | Deterministic parsers: `parse_offered_time`, `parse_price`, `parse_confirmation_number` — never trusts the LLM to self-report the booking | **Match** |
| High-stakes guardrails | **Mandatory AI disclosure as the FIRST words** (2026 FCC/state law), owner-verified allowlist, suppression list, calling-hours, human-confirm on outcome | **Ahead** (most booking bots DON'T disclose — a legal + trust edge) |
| Telephony | Twilio bridge, gated on VOICE_BOOKING_ENABLED + creds + attorney sign-off; simulator for CI-safe testing | Match |
| Real inventory | **Not yet** — search currently uses the synthesized affiliate provider (being ripped out); the foreUP-real-availability + reachability-router plan is written and queued | **Gap (planned)** |

### Honest gaps
1. **Real data isn't wired yet** — the booking DIALOG is SOTA, but it's negotiating over
   synthesized availability today. The `teetime-real-booking-plan.md` (reachability router:
   foreUP API / AI call / honest empty) fixes this; S0 rips out the fake data first.
2. **Regex extraction has no LLM fallback** — `parse_offered_time` etc. are robust and
   observable (the right default), but an utterance the regex misses ("how's a quarter past
   seven sound?") falls through. A belt-and-suspenders LLM-extraction-with-schema-validation
   fallback would harden it — a queued enhancement, not a redesign.

**Tee-time verdict: the AGENT design is state of the art (FSM + structured extraction +
disclosure-first compliance — genuinely ahead on the legal/trust layer). The DATA feeding it
isn't real yet; that's the foreUP plan's job, already written.**

## Bottom line
Both agents use current SOTA technology (realtime S2S, warm preload, canonical tool
registries, FSM booking, structured extraction) AND a design philosophy — *ground in
computed/verified truth, let the model render, never let it invent* — that is ahead of the
field's RAG-and-hope default. The two honest frontiers (a verify-before-speak gate on the
realtime path; real inventory + an LLM-extraction fallback for booking) are enhancements on a
sound foundation, not missing fundamentals. This is a deliberately architected system, not a
prompt wrapper.
