# Caddie Experience — measurement harness

Owner directive (verbatim): *"Most important to this app is improving the caddie experience,
no dupes, smart caddy, nice flowing conversation, voice that doesn't sound robotic,
consistency, reliability, minimal loading."*

This is the index for how each of those eight things is MEASURED — deterministically and
offline wherever possible, gated-but-runnable-later everywhere a live model/API key/device is
required. See `specs/caddie-experience-harness-plan.md` for the full implementation plan this
file is the durable output of.

> "An eval that can't fail is worse than none." Every check cited below has a proof it can go
> RED — see each area's teeth tests.

## The eight dimensions

| # | Dimension | Measured by (existing) | Measured by (this harness) |
|---|---|---|---|
| 1 | no dupes | `frontend/src/lib/voice/realtime-noinput/attribution/ordering.test.ts`, `priming-echo.test.ts`, `CaddieSheet.realtime.test.tsx` | suite membership (below) + `CaddieSheet.realtime-glitch.test.tsx` asserts exactly-once bubbles across drop/hole-change glitches |
| 2 | smart caddie | `backend/tests/eval` tier1 golden set + tier2 (gated) | multi-turn golden scenarios + `history_renders_in_order` tier1 check |
| 3 | flowing conversation | `realtime-ordering.test.ts`, `caddie-turn-timing.test.ts`, `CaddieSheet.realtime.test.tsx` transcript-order tests | multi-turn scenarios (follow-up, challenge-and-admit); glitch tests keep flow across drops |
| 4 | non-robotic voice | `personalities.py` voice_ids; `realtime_relay.py` voice "sage", speed 1.15 | `backend/tests/eval/test_realtime_session_config.py` — deterministic session-config pins (voice validity + speed); soft quality (does it actually SOUND natural) stays a gated tier2-judge property, filed for later |
| 5 | consistency | — (new) | `backend/tests/eval/substance.py` extractor (lands now) + gated `run_consistency.py` probe |
| 6 | reliability | `realtime-lifecycle/warm.test.ts`, `warm-session.test.ts`, Slice D/E reconnect+suspend tests in `CaddieSheet.realtime.test.tsx` | `CaddieSheet.realtime-glitch.test.tsx` — reconnect mid-answer, hole-change mid-answer (glitches DURING a turn, not just between turns) |
| 7 | minimal loading | `caddie-turn-timing.ts` telemetry (`caddie.eos_to_first_audio`), `warm-session.ts` pool | latency methodology (below) + gated `run_latency.py`; baseline table left TBD (no keys in this environment) |
| 8 | well-integrated | `realtime-dispatch.test.ts`, `test_tool_parity.py` | suite membership + this table |

## Running the gates

```bash
# Frontend — the named, focused gate (16 test files spanning dims 1/3/6/7/8):
cd frontend && npm run test:caddie-experience

# Frontend — the full suite (superset; also runs the manifest guard itself):
cd frontend && npm run test

# Backend — the eval harness (dims 2/3/4/5, all offline/deterministic):
cd backend && uv run pytest tests/eval
```

## Gated tools (require API keys — never run in CI, refuse without them)

```bash
# Dim 5 — consistency: sample a golden scenario N times live, diff the substance.
cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_consistency --budget-usd 0.50

# Dim 7 — latency: ephemeral-mint round-trip p50/p95 (the backend-controllable leg).
cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_latency --n 5

# Dim 2/3 (soft judge properties) + candidate-quality regression, on-demand only:
cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_tier2 --budget-usd 2.00
```

All three refuse (exit 2) unless their required API key AND `CADDIE_EVAL_LIVE=1` are both set;
none is ever collected by pytest or invoked by CI. `run_consistency.py`/`run_latency.py` write
key-free `last_*_run.json` reports (gitignored) — a real `client_secret`/API key is never
printed or persisted.

## Latency methodology (dim 7 — "minimal loading")

- **Turn latency** (question-end → answer-start): already shipped —
  `caddie.eos_to_first_audio` (`frontend/src/lib/voice/caddie-turn-timing.ts`), surfaces
  `caddie-turn`/`caddie-rt` telemetry events with an immediate flush. Capture procedure: run
  real turns on a device, read backend telemetry log lines (`POST /api/voice/telemetry`),
  report p50/p95 per surface.
- **Cold vs warm time-to-first-audio**: cold = mint + WebRTC connect + greeting; warm =
  warm-pool adoption (`takeWarm` → `attachMic`) → greeting. Existing markers (`live_resume`,
  `opening_shot`, `resolved_live`, mint/connect statuses) partially bracket this. On-box
  procedure: 5 cold opens + 5 warm opens on TestFlight, bracketed by those markers. If a clean
  open→greeting bracket isn't achievable from existing telemetry, a one-line consumer-side
  marker (added to `useCaddieLiveSession.ts` / `CaddieSheet.tsx`, NEVER `realtime.ts`) is
  filed as a follow-up — not added speculatively here.
- **Backend-controllable leg**: the ephemeral-mint round-trip (`mint_ephemeral_session`) is
  fully backend-controlled and measured directly by the gated `run_latency.py` above.

### Baseline table

**TBD — requires a keyed, on-box run.** `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are both
unset in this environment; no live baseline can or will be captured this pass, and no number is
fabricated. Fill in after running the gated tools above with real keys:

| Metric | p50 | p95 | Captured |
|---|---|---|---|
| Turn latency (`caddie.eos_to_first_audio`) | TBD | TBD | — |
| Cold open → greeting | TBD | TBD | — |
| Warm open → greeting | TBD | TBD | — |
| Ephemeral mint round-trip (`run_latency.py`) | TBD | TBD | — |

## Reliability — glitch coverage (dim 6, new)

Existing Slice D/E coverage (`CaddieSheet.realtime.test.tsx`) fires reconnect/hole-change
events strictly BETWEEN turns. `CaddieSheet.realtime-glitch.test.tsx` fills the gap: a drop or
a hole change WHILE an assistant answer is still streaming (a partial bubble in flight) —
reconnect mid-answer (success and fail-to-classic-fallback), hole-change mid-answer, and
hole-change during the reconnect window. See that file's header for the manual mutation drill
(with the actual RED-on-mutant result captured) and two documented deviations from the plan's
literal wording, discovered by actually running the tests against production behavior rather
than assumed:

1. On classic fallback, an INTERRUPTED (never-finished) partial answer is intentionally
   dropped, not carried over as a fake completed reply (`CaddieSheet.tsx`'s existing
   `!m.partial` filter — the same no-fake-data convention this whole harness protects). The
   test asserts the last COMPLETE pre-drop turn survives instead.
2. A hole change landing exactly inside the reconnect window (before the fresh client reaches
   `'connected'`) can legitimately fire `sendContext` TWICE on the reconnecting client — once
   from the hole-change effect, once more from the connect-time re-anchor — both carrying the
   CORRECT (new) hole. This is a harmless redundant send, not a stale-hole bug; the test
   asserts the meaningful invariant (never stale) rather than an exact call count. Fixing the
   redundancy is a `useCaddieLiveSession.ts` behavior change, out of scope for this SILENT
   harness item — flagged for the eng-lead as a minor follow-up.

## Consistency (dim 5, new)

`backend/tests/eval/substance.py` extracts an `AnswerSubstance` (club / yardages / hazard
types — phrasing stripped away) from a caddie answer, reusing the exact club-mention regex
family `checks._parse_mentioned_club` already uses. `substance_variance` diffs N samples of the
SAME scenario: clubs must be identical, hazard sets identical, yardage spread within tolerance;
a sample simply omitting a number others state is *reported*, not failed. See
`backend/tests/eval/README.md`'s "Consistency probe" section for the full design and the gated
live sampler (`run_consistency.py`).

## Non-robotic voice (dim 4)

`backend/tests/eval/test_realtime_session_config.py` pins the deterministic parts:
`audio.output.voice` resolves from the personality's `voice_id` (or the documented default),
`audio.output.speed` stays 1.15, and — the correctness fix this harness delivered — every
`PERSONALITIES` entry's `voice_id` must be a member of the CLOSED valid-Realtime-voice set
`{alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar}`. This is the exact teeth
that caught The Professor personality shipping `voice_id="fable"` — a LEGACY OpenAI TTS-only
voice (v1/audio/speech), NOT a valid Realtime `audio.output.voice` enum member; the Realtime
API rejects it outright with an enum error at session-mint time, it does NOT silently fall back
to a working voice. Repointed to `voice_id="cedar"` (`backend/app/caddie/personalities.py`).

Perceptual "sounds robotic" (does the voice actually sound natural, not just validly-named) is
out of deterministic scope — a gated-judge/on-device follow-up, never faked here. The audible
DEFAULT-voice swap (Classic → cedar) and the speed 1.15 → ~1.0 nudge some owners might want are
OWNER-GATED product decisions, filed but not landed by this harness item.

## Smart caddie / flowing conversation (dims 2/3)

Multi-turn context-retention: `Situation.history: list[HistoryTurn]` (`backend/tests/eval/
schema.py`) seeds prior conversation turns into the synthetic `RoundSession.
conversation_history`, so the REAL `_build_session_voice_prompt` renders them into `messages`
exactly as a real multi-turn round would. The `history_renders_in_order` tier1 check asserts
every seeded turn appears in order, exact role+content, strictly before the current transcript
— offline, no LLM call. **Text-mouth only** — the realtime mouth's history lives server-side in
the OpenAI Realtime session itself, not assertable from a pure prompt-string check; that
surface is covered by the frontend ordering/lifecycle suites and, for a live read, the gated
consistency probe. Three golden scenarios exercise this: a follow-up club question
(`followup-3wood-after-driver`), context retention across a miss (`context-retention-prior-
club-result`), and an observed-reality challenge layered with seeded history (`challenge-and-
admit-yardage`).

## No dupes / well-integrated (dims 1/8)

Covered by suite MEMBERSHIP — `frontend/src/lib/voice/caddie-experience-suite.ts` is the
single source of truth mapping every relevant test file to the dimension(s) it measures,
enforced by `caddie-experience-suite.test.ts`'s manifest guard (runs in the ordinary `npm run
test` gate): every listed file must exist on disk, and every dimension 1-8 must have at least
one mapped file. This is what makes suite membership FALSIFIABLE rather than assumed — a
renamed/deleted file fails the guard by naming the exact missing path.

## Playbook: the dedup lane renamed/added a `realtime-*.test.ts`

If the parallel dedup lane (`specs/caddie-realtime-double-emit-plan.md`) renames or adds a
`realtime-*.test.ts` file, `caddie-experience-suite.test.ts`'s "every manifest file exists"
guard goes red, naming the exact missing path. Fix: update the `file` path (and `dimensions` if
the coverage changed) in `frontend/src/lib/voice/caddie-experience-suite.ts` to match — a
one-line manifest edit, not a re-plan.

## Known limitations (honest, not aspirational)

- The consistency-probe yardage extractor (`substance.py::_YARDAGE_RE`) matches bare 2-3 digit
  numbers without requiring a "yards" suffix (caddie speech states bare numbers, e.g. "152 to
  the pin", far more often than suffixed ones) — this accepts some false positives (e.g. a
  3-digit wind heading in degrees) as a documented tradeoff, not a silent gap.
- Perceptual "sounds robotic" and the realtime mouth's live conversation-consistency are gated
  judge/on-device properties, not deterministic — see the dim-4 and dim-5 sections above.
- No live baseline latency numbers exist yet in this repo state (no API keys in this
  environment) — the table above is honestly `TBD`, never fabricated.
