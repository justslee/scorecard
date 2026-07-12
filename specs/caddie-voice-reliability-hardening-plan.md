# Caddie Voice Reliability Hardening — Realtime rendering/correlation pass

## 0. Scope & hard constraint

Client-side correctness hardening of the Realtime caddie-voice rendering path, following
the two prod bugs shipped 2026-07-11/12: the priming-echo context leak (@6a68078,
`priming-echo.ts`) and the phantom "didn't catch that" clarifier (@76d8c95,
`noinput-clarifier.ts` + the hold/suppress/release machine in `realtime.ts`). This pass
closes the three reviewer/designer nits tracked in `backlog.json` (attribution race, map
lifecycle, empty-state copy) plus two audit findings, all lockable via pure unit tests.

**HARD CONSTRAINT — CONFIRMED:** this plan touches **zero** VAD / `turn_detection` / mic /
gain / `noise_reduction` / commit-timing surface. The `getUserMedia` constraint blocks in
`realtime.ts` (lines ~346-352 and ~498-504) and every server-session parameter are
untouched. Anything that would require them is punted to §8 "Needs owner nod (VAD-gated)".
All edits are to client event-handling/rendering state machines + copy, provable with
vitest.

Files touched (all frontend):
- `frontend/src/lib/voice/realtime.ts` — correlation state machine (edges 1, 2, 4a, 4b)
- `frontend/src/lib/voice/realtime-ordering.ts` — bounded order maps (edge 2, minor)
- `frontend/src/components/CaddieSheet.tsx` — empty-state copy (edge 3)
- New: `frontend/src/lib/caddie/live-copy.ts` (pure copy helper),
  `frontend/src/lib/voice/realtime-attribution.test.ts`,
  `frontend/src/lib/voice/realtime-lifecycle.test.ts`
- Strengthened: `realtime-noinput.test.ts`, `realtime-ordering.test.ts`,
  `CaddieSheet.realtime.test.tsx`

NOT touched: `priming-echo.ts`, `noinput-clarifier.ts` (the shipped closed-vocabulary
detectors stay exactly as landed), `warm-session.ts`, `useCaddieLiveSession.ts`, all
backend files.

## 1. Edge 1 — VAD-blip-mid-real-turn attribution race

### Current mechanics (realtime.ts)
- `input_audio_buffer.speech_started` (line ~743) pushes `item_id` onto
  `pendingSpeechItems`.
- `response.created` (lines ~607-614): if not self-triggered, `pendingSpeechItems.pop()`
  (LIFO, most-recent wins) becomes THE single trigger in `triggerItemByResponse`; the
  array is then cleared.
- Deltas (lines ~630-643) hold while trigger class `!== 'real'` and
  `couldBecomeClarifier(text)`.
- `done` (lines ~650-682): trigger class `'noinput'` + clarifier-shaped → suppress;
  `undefined` → arm the 2s grace timer; `'real'` → release/emit.
- `transcription.completed/.failed` (lines ~691-700, ~727-733) classify the item and call
  `resolveHeldFor(itemId)` (lines ~821-833), which only acts on held responses whose
  SINGLE trigger equals `itemId`.

### The race
A phantom noise `speech_started` (item-B) that fires inside the sub-second window between
a REAL turn's commit (item-A) and its `response.created` steals attribution: `pop()`
returns B. When A's garbled-but-real transcript arrives, `resolveHeldFor('item-A')`
matches nothing (the hold's trigger is B); when B's empty transcript arrives, the hold is
classified noinput and a LEGIT clarifier bubble is suppressed (audio still plays — the
bubble is what goes missing).

### Fix — candidate trigger SET + all-noinput suppression rule
Replace the single-trigger map with a candidate-set map:

- `triggerItemByResponse: Map<string, string>` →
  `triggerItemsByResponse: Map<string, string[]>`. At `response.created`, snapshot the
  ENTIRE `pendingSpeechItems` array as the response's candidate set, then clear the array
  (unchanged: empty snapshot / self-triggered ⇒ no entry ⇒ unconditional, never held).
- New private helper `classifyCandidates(respId): 'real' | 'noinput' | 'pending'`:
  - `'real'` if ANY candidate's `inputClassByItem` is `'real'` (incl. `.failed` err-keep);
  - `'noinput'` only if EVERY candidate is classified `'noinput'`;
  - `'pending'` otherwise.
- Delta branch: hold only while `classifyCandidates(id) !== 'real'` &&
  `couldBecomeClarifier(...)` (same shape as today, aggregate instead of single class).
- Done branch: `'noinput'` + `isNoInputClarifier` → suppress; `'pending'` → arm grace
  timer (unchanged 2000ms `NOINPUT_RESOLVE_GRACE_MS`); `'real'` → release + emit final.
- `resolveHeldFor(itemId)`: act on every finalized held response whose candidate set
  CONTAINS `itemId`; recompute the aggregate — `'real'` → `releaseHeld(id, true)`;
  `'noinput'` + clarifier-shaped → `suppressHeld(id)`; `'pending'` → keep waiting (grace
  timer stays armed).

Key property: **suppression now requires ALL candidates provably noinput** — strictly more
conservative than the shipped single-trigger rule, so a real utterance anywhere in the
attribution window can never have its clarifier swallowed. Because classification is
terminal per item (exactly one `.completed`/`.failed` arrives), a suppressed hold can
never retroactively become real — so no "resurrect a suppressed bubble" machinery is
needed; the backlog's "un-suppress on real transcript" is realized as
release-before-suppress. Single-candidate sets degenerate to today's exact behavior
(existing noinput tests 1-10 must pass unchanged).

### Interleaving orderings + tests (new `realtime-attribution.test.ts`)
Reuse the fake WebRTC plumbing from `realtime-noinput.test.ts` (extract it into a shared
test-only helper `frontend/src/lib/voice/realtime-test-fakes.ts` imported by the NEW
suites only; the two existing suites keep their local copies — zero churn to shipped
tests).

| # | Ordering | Expected | vs unfixed code |
|---|----------|----------|-----------------|
| A1 | speech_started(A) → speech_started(B, blip) → response.created → clarifier deltas → done → A transcript "scars of god" (real) → B transcript "" | user bubble "scars of god" + FINAL clarifier bubble emitted; NO `realtime_noinput_clarifier_suppressed` telemetry | **RED** (pop()=B, B noinput ⇒ suppressed) |
| A2 | Same but B's "" transcript arrives BEFORE A's real one | not suppressed at B (aggregate pending); released when A resolves real | **RED** |
| A3 | speech_started(A, blip) → speech_started(B) → response.created → clarifier held → B real | released (regression: real-last ordering already worked) | GREEN |
| A4 | Two blips A,B, clarifier, both transcripts "" | suppressed — the shipped phantom-clarifier fix must NOT regress; assert zero assistant messages + suppression telemetry | GREEN (guard) |
| A5 | A's real transcript classifies BEFORE response.created → blip B → response.created → clarifier deltas | never held: first delta emits a partial immediately (aggregate already 'real') | **RED** |
| A6 | Candidates [A,B]; B resolves ""; A never resolves; done; advance 2000ms fake timers | released by grace timer (err-keep) | **RED** (suppressed at B's classify) |
| A7 | Real transcript for an item in NO candidate set | no-op on holds; ordering unaffected | GREEN |

Also: run the entire existing `realtime-noinput.test.ts` unchanged — it is the
regression harness proving single-candidate behavior is bit-identical.

## 2. Edge 2 — correlation-map lifecycle (bounded pruning)

### Current growth
`cleanup()` (lines ~555-583) is the ONLY prune site for `inputClassByItem` and
`triggerItemByResponse`; each turn adds one entry to each for the life of the session.
Also audited: `partials` (pruned on final emit — OK, drop-mid-response leaks are cleared
at cleanup), `heldResponses` (pruned on release/suppress — OK), `pendingSpeechItems`
(cleared per response.created — OK), and `MessageOrderTracker.orderByResponseId` /
phantom `orderByUserItemId` entries (grow per response / per unconsumed blip).

### Fix
1. New private `finishResponse(respId)` in realtime.ts, called from every resolution
   point — the done-branch final-emit paths, `releaseHeld()`, and `suppressHeld()`
   (idempotent; a second `done` for the same id is already inert). It deletes:
   - `triggerItemsByResponse.get(respId)`'s `inputClassByItem` entries (an item is a
     candidate of at most ONE response — the array is cleared at `response.created` — and
     the user-bubble render path never reads `inputClassByItem`, so resolution is
     strictly after the last read; this is what keeps pruning from breaking edge 1's
     re-scan),
   - the `triggerItemsByResponse` entry itself.
2. Belt-and-braces cap for orphans (a classified blip that never becomes anyone's
   candidate, or a transcript landing after a grace-timeout release):
   `MAX_INPUT_CLASS_ENTRIES = 64` — on insert, evict oldest (Map insertion order),
   SKIPPING any item still referenced by a live `triggerItemsByResponse` value (that set
   is ~0-1 entries in practice, so the scan is trivial).
3. `MessageOrderTracker`: cap `orderByResponseId` and `orderByUserItemId` +
   `pendingUserOrders` at `MAX_TRACKED = 128` each, evict-oldest. Pure module, no
   behavior change for live turns (entries are consumed within a turn).

### Tests (new `realtime-lifecycle.test.ts` + `realtime-ordering.test.ts` additions)
- L1 "50 turns leave the correlation maps bounded": drive 50 full turns
  (speech_started → response.created → non-clarifier delta → done → real transcript);
  assert via private-field access
  (`client as unknown as { inputClassByItem: Map<...>; triggerItemsByResponse: Map<...> }`
  — TS-private, reachable at runtime, no production debug surface added):
  `triggerItemsByResponse.size === 0`, `heldResponses.size === 0`, `partials.size === 0`,
  `inputClassByItem.size` ≤ cap (expected ~0 with per-resolve pruning). **RED** pre-fix
  (both maps reach 50).
- L2 "pruning does not break suppression/release": 20 mixed turns, then re-run the
  scenario-A4 suppress and the scenario-A1 release inline; same outcomes. Guards the
  pruning change against both shipped behaviors.
- L3 "eviction never removes a live candidate": fill past the cap while one clarifier is
  held with an unresolved candidate; resolve it real afterwards → still released.
- O1 (realtime-ordering.test.ts) "order maps bounded at MAX_TRACKED": 200 responses / 200
  phantom user turns → sizes ≤ 128, and consumed lookups still return reserved slots.
  **RED** pre-fix.

## 3. Edge 3 — held-turn empty-state copy honesty (USER-FACING → designer review)

### Repro
Zero-message live session; noise blip triggers a held clarifier. Status goes `'speaking'`
(audio IS playing — line ~642 unchanged). Footer (`LiveFooter`, LIVE_STATUS_LABEL line
~206) says "Caddie speaking…" while the empty state (`LiveVoiceBody`, lines ~1802-1817)
says "Go ahead — {name} is listening." for up to ~2s (hold + grace). Two honest-states
claims disagreeing on screen.

### Fix
Extract the empty-state hint into a pure helper, new
`frontend/src/lib/caddie/live-copy.ts`:
`liveEmptyStateHint(status: RealtimeStatus, paused: boolean, name: string): string`
- paused → "Paused — tap resume below to keep talking." (existing copy, moved)
- `connecting`/`idle` → `Connecting to {name}…` (existing)
- `speaking` → `{name} is speaking.` (NEW — calm, serif-italic tone; exact wording is a
  **designer-review item** per NORTHSTAR quiet/yardage-book voice)
- everything else → `Go ahead — {name} is listening.` (existing)
Move `LIVE_STATUS_LABEL` into the same module so the consistency invariant is testable in
one place. `LiveVoiceBody` consumes the helper; no layout/JSX changes beyond the string.
(`closed`/`error` need no new branch: suspend flips `paused` and fallback swaps the body
within a render — note this in a code comment.)

### Tests
- `live-copy.test.ts`: branch table for all 7 statuses × paused; plus the invariant
  "the hint never claims listening while LIVE_STATUS_LABEL claims speaking" enumerated
  over every `RealtimeStatus`. **RED** pre-fix for `status='speaking'` (once the helper
  encodes today's ternary, the invariant case fails; land helper+fix together, prove RED
  by asserting against the old ternary's output).
- `CaddieSheet.realtime.test.tsx` (follows the existing suspend-copy test at line ~1046):
  drive the mocked live client to `'speaking'` with zero messages →
  `queryByText(/is listening/i)` is null and the speaking hint renders; back to
  `'connected'` → listening hint returns. **RED** pre-fix.

## 4. Edge 4 — audit findings

### 4a. FIX — `response.done` id extraction misses the GA event shape
The done branch (line ~650) reads `evt.response_id || evt.item_id`; a real GA
`response.done` carries the id at `evt.response.id` (exactly as `response.created`
parses it at line ~601). Today finalization rides on `output_audio_transcript.done`
(which does carry `response_id`); if that event is dropped, the bubble is stuck
partial (opacity 0.7) forever. Fix: extend the id fallback chain in the done branch with
`(evt.response as { id?: string } | undefined)?.id`. Test (realtime-lifecycle.test.ts):
stream deltas for `resp-1`, then emit GA-shape `{ type: 'response.done',
response: { id: 'resp-1' } }` with NO top-level `response_id` → a final
`partial: false` message is emitted. **RED** pre-fix.

### 4b. FIX — events arriving after cleanup() re-arm the idle timer / leak to rebound handlers
A data-channel message already queued when `stop()` runs still invokes `handleEvent`:
`idle.touch()` re-arms the 90s timer on a DEAD client → 90s later `stop()` fires again
and `setStatus('closed')` re-enters whatever handler is bound then (suspend/reconnect
rebind via `setEvents`); a late transcript could also emit a bubble post-teardown.
Fix: first line of `handleEvent`: `if (!this.dc) return;` (`cleanup()` nulls `dc`).
Test: start → stop() → emit transcript + status events on the retained fake dc → assert
no further `onMessage`, and with fake timers advance 90s → no second `'closed'`.
**RED** pre-fix.

### Audited, NO code change (documented as inert)
- **Reconnect/warm re-prime echo:** `transcription.prompt` echoes are per-transcript and
  `isPrimingEcho` is stateless — a Slice-D reconnect / resume / warm adoption is covered
  identically; `sendContext`/`anchorHole` items are conversation items, not the
  transcription prompt, and a hazard-list-shaped hallucination is already caught by
  branch C. Existing noinput test 3 + priming-echo.test.ts stay the lock.
- **Duplicate/overlapping responses:** partials are keyed per response id; a second
  `done` is inert (lines ~677-681); the hook's `upsert` dedupes by id.
- **Transcript ordering under reconnect:** the dead client is detached
  (`setEvents({})`) before the offset flips, so no dead-client message can receive the
  new offset; covered by useCaddieLiveSession design, no change.
- **Held partial lost on mid-response drop:** audio is also cut; honest, accepted.
- **`sendText` clearing `pendingSpeechItems` mid-speech-turn:** makes that speech turn's
  response unconditional — err-keep direction, safe.

## 5. Sequencing
1. Edge 1 (candidate sets) — the shape change everything else builds on.
2. Edge 2 (`finishResponse` pruning + caps) — depends on edge 1's map rename.
3. Edge 4a + 4b guards (small, independent within realtime.ts).
4. Edge 3 copy module + component test (independent; needs designer sign-off on copy).
5. Ordering-tracker caps (independent).

## 6. Shared-type sync (types.ts <-> models.py)
None. `RealtimeMessage`/`RealtimeStatus` are client-local (`lib/voice/realtime.ts`);
`lib/voice/types.ts` (voice parse DTOs mirrored from models.py) is untouched. No backend
file changes; `models.py` unchanged. Confirmed client-only.

## 7. Gates
- `cd frontend && npm run lint && npx tsc --noEmit && npx vitest run && npm run build && npx tsx voice-tests/runner.ts --smoke`
- backend: `ruff check .` (expected trivially green — zero backend files touched)

## 8. Needs owner nod (VAD-gated) — NOT planned here
Escalation candidates for the eng-lead; each would reduce the noise-false-trigger RATE at
the source, which this pass deliberately does not touch:
- `turn_detection` tuning (threshold / prefix_padding_ms / silence_duration_ms) or
  switching to semantic VAD in the minted session config.
- `input_audio_noise_reduction` session parameter.
- Any `getUserMedia` constraint change (noiseSuppression/autoGainControl/gain).
- Any input-audio commit-timing change.
This plan's diff shows zero `turn_detection`/mic/threshold surface touched.

## 9. Risk / regression matrix
| Risk | Direction | Guard |
|------|-----------|-------|
| A real turn's clarifier newly hidden (false positive — the never-swallow guarantee) | Edge-1 change | Suppression now needs ALL candidates noinput (strictly ⊆ old suppressions); noinput test 4 (load-bearing) + new A1/A2/A5/A6, each RED against unfixed code |
| Noise clarifier newly shown (the @76d8c95 phantom bug returning) | Edge-1 change | A4 two-blip suppress + existing noinput tests 1, 2, 9 unchanged; single-candidate path degenerates to shipped behavior |
| Priming echo leaks again (@6a68078 regression) | none (module untouched) | noinput test 3 + priming-echo.test.ts remain in the gate |
| Pruning deletes state edge-1 still needs | Edge-2 change | Prune only at response resolution (strictly after last read); eviction skips live candidates; tests L2/L3 interleave pruning with suppress/release |
| dc-null guard drops a live event | Edge-4b | Guard is only true pre-start/post-cleanup; entire existing suite passes through an open dc |
| done-id fallback finalizes the wrong partial | Edge-4a | Fallback chain mirrors response.created's existing parse; duplicate-done inertness test unchanged |
| Copy change contradicts another state | Edge-3 | live-copy invariant test over every status × paused; suspend test at CaddieSheet.realtime.test.tsx:1046 stays green; designer review before ship |

Every new behavioral test above is provable RED against the un-fixed code (A1, A2, A5,
A6, L1, O1, 4a, 4b, and the edge-3 component assertion).
