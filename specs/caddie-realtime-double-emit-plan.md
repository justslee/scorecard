# Caddie Realtime Double-Emit Fix — Implementation Plan

**Owner bug (TOP-PRIORITY):** "Everything in the caddie chat is getting duplicated." One spoken
question in the LIVE realtime caddie produces the turn TWICE — the user bubble twice (verbatim on
Hole 3; transcription *variants* on Hole 2) and TWO distinct, independently-grounded caddie answers.
Doubles OpenAI cost per question. The #139 numbers-coherence grounding is working inside each
individual answer — the defect is the double-emit.

**Hard constraint:** do NOT touch VAD / mic / turn-detection thresholds
(`backend/app/services/realtime_relay.py:84-100` stays byte-identical).

---

## 1. Traced root cause (with evidence)

### Verdict on the three candidates

- **Candidate 1 (two `response.create` per utterance): NOT the primary cause — but a real secondary
  contributor for multi-tool turns.** Grep of every `response.create` send in
  `frontend/src/lib/voice/realtime.ts`: `sendText` (line 430), `sendOpener` (line 481), `runTool`
  (line 1000). None fires on a speech turn — speech turns rely entirely on server-VAD auto-response
  (`backend/app/services/realtime_relay.py:95-100` sets `turn_detection: server_vad`; GA server VAD
  auto-creates the response). HOWEVER, `runTool` sends one `conversation.item.create`
  (function_call_output) **plus one `response.create` per `response.function_call_arguments.done`
  event** (realtime.ts:805-811 → 988-1000). When the model emits ≥2 tool calls in ONE response
  (plausible for "what should I hit": `get_conditions` + `get_shot_distance`/`get_carries`), the
  client fires N `response.create`s → the GA API queues them → N sequential spoken answers for one
  question. This doubles the ANSWER but cannot double the USER bubble — so it is ranked #2, below.

- **Candidate 2 (optimistic local user bubble + server transcript both rendering): NO.** A voice
  user bubble is emitted from exactly ONE place: the
  `conversation.item.input_audio_transcription.completed` branch (realtime.ts:740-775), keyed by
  the server `item_id` (line 745-746). Input-transcription `.delta` events are ignored (they fall
  to the `default:` at line 829-831) — final-only commit already holds. The only local-optimistic
  user bubble is for TYPED text (`sendText`, realtime.ts:436-443), not voice. The consumers dedup
  renders by message id (`useCaddieLiveSession.ts:266-271`, `useRealtimeCaddie.ts:34-42`), so a
  re-delivered event with the same `item_id` coalesces. Two rendered user bubbles therefore require
  two DISTINCT committed input items.

- **Candidate 3 (cycle-118/119 hardening regression): NO.** The held-response machinery emits at
  most one partial stream + one final per response id: the done-branch second-`done` case is inert
  (realtime.ts:725-735 — `partials` already deleted), `releaseHeld`/`suppressHeld` delete all state
  (913-940), and `resolveHeldFor` only acts on responses still in `heldResponses` (949-963). The
  priming-echo drop `break`s before any emit (756-764). No path in the 118/119 code emits twice.

### The actual root cause: a ZOMBIE second live session — `stop()` during the mint await does not cancel `startInner()`, which resurrects a full connection

**The defect, line by line (`frontend/src/lib/voice/realtime.ts`):**

1. `startInner()` registers the singleton cap **before** the mint:
   lines 294-300 (`activeRealtimeClient.stop()` on the previous client, then
   `activeRealtimeClient = this`) run synchronously, then line 303-310 `await`s the backend mint
   (`startRealtimeSession` → POST `/api/realtime/session`, which itself awaits OpenAI
   `/client_secrets` — routinely 1-4s on course LTE).
2. If **`stop()` is called during that await** (realtime.ts:581-584 → `cleanup()` 588-616):
   `this.pc` is still `null`, so cleanup closes nothing that matters, clears
   `activeRealtimeClient` (line 592), and returns. **There is no aborted/stopped flag, and
   `startInner` never re-checks anything after the await.**
3. The mint resolves and `startInner` **continues**: creates a new `RTCPeerConnection` (line 313),
   appends a fresh hidden `<audio>` sink (332-336), calls `getUserMedia` (371-377 — a cold client
   has `opened = true` from construction, line 278, so its mic is hot immediately), creates the
   data channel (388-389), completes the SDP exchange (394-404) — a **fully live, billed, mic-open
   session that no reference points at**. It never re-registers as `activeRealtimeClient` (line 300
   already executed), so the "ONE live Realtime connection per app" cap (lines 194-198) can never
   see or stop it — the next client's cap check at line 294 finds `null` and starts alongside it.

**Who triggers stop-during-mint in the field (`frontend/src/hooks/useCaddieLiveSession.ts`):**

- The **3s mint deadline** (lines 521-524) → `fallBack()` (226-235) → `clientRef.current?.stop()`
  while `client.start()` is still awaiting the mint. A mint slower than 3s on course cell is the
  expected trigger.
- **Sheet closed during "Connecting…"** → `active` flips false → the `!active` branch stops the
  client mid-mint (line 332), or the effect cleanup does (line 579).
- An effect re-run on `personaId`/`roundId` change (dep array, line 584).
- Reconnect/resume deadline (`fallBack` at 442-445 / 494-497) while the fresh client is mid-mint.

**Why the zombie's turns land in the SAME transcript:** the activation's event handlers
(`useCaddieLiveSession.ts:360-428`) gate `onStatus`/`onError` on the `cancelled` closure flag —
but **`onMessage` is the bare `upsert` (line 423), and `upsert` checks only `mountedRef`
(lines 255-272)**. `fallBack()` (226-235), the `!active` reset (314-339), and the effect cleanup
(575-582) all stop the client **without detaching handlers** — unlike `startReconnect()`, which
correctly does `dead?.setEvents({})` at line 440. CaddieSheet stays mounted across open/close
(`open` prop, CaddieSheet.tsx:1611-1618 renders `LiveVoiceBody` from `live.messages`), so
`mountedRef` stays true. Net: when the owner reopens the sheet, activation N+1 cold-mints client B
while zombie A (from activation N) is still connected with a live mic — and **both clients' events
flow through the same `upsert` into one `messages` list**.

**Why this exactly reproduces both screenshots:**

- One utterance is heard by TWO independent OpenAI sessions. Each runs its own server-VAD commit +
  its own `gpt-4o-transcribe` pass → two committed items with two independent transcripts —
  sometimes verbatim-identical (Screenshot A), sometimes variants ("What should I hit…" / "What
  club should I hit…", Screenshot B). **A single-session VAD double-commit is excluded**: it would
  split the audio into complementary fragments, never produce the same complete sentence twice.
- Each session auto-creates its own response and runs its own grounded tool solve → two DISTINCT,
  each-internally-coherent answers with slightly different numbers (exactly the #139-fix-working,
  two-independent-solves signature the owner captured).
- Ordering: each client has its own `MessageOrderTracker` (realtime.ts:228). Client B's tracker is
  advanced by the opener (the opener/anchor go only to `clientRef.current` = B —
  useCaddieLiveSession.ts:284, 310), so per utterance the merged sort renders
  A-question / A-answer / B-question / B-answer — the "each question followed by its own answer"
  layout in the screenshots.
- Corroboration: commit `727c7df` ("single in-DOM audio sink to stop double/overlapping caddie
  voice") fixed an earlier owner report of TWO overlapping voices as an iOS audio-sink issue — two
  overlapping voices is also precisely what a zombie session produces. The class of bug predates
  the 118/119 cycles.
- **False test confidence:** `CaddieSheet.realtime.test.tsx:684-720`
  ("fallback-during-pending-start (Gap 2): no resurrection, no second mint") asserts the HOOK-level
  guard (`if (cancelled || fellBackRef.current) return;` after `await client.start()`,
  useCaddieLiveSession.ts:560-562) against a **mocked** client whose `start()` resolves to nothing.
  The real resurrection happens INSIDE `RealtimeCaddieClient.startInner`, one level below the mock
  — the hook guard only prevents the hook's `attachMic`, which a cold client doesn't need
  (`opened = true` at construction, realtime.ts:278). The existing test can never catch this.

### Ranked causes

1. **Zombie session via stop-during-mint resurrection** (realtime.ts:291-313 no post-await abort
   check; cap registered at 294-300 / cleared at 592, never re-checked) + **undetached zombie
   handlers feeding the same list** (useCaddieLiveSession.ts:226-235, 314-339, 423, 575-582).
   Explains BOTH screenshots completely (doubled user turn + two distinct answers + variants).
2. **Multi-tool double `response.create`** (realtime.ts:805-811 → 988-1000): N tool calls in one
   response → N queued follow-up responses → duplicated ANSWERS (not user bubbles) on multi-tool
   turns. Fix is small and in-scope (it is literally a double-`response.create` per user turn).
3. No regression found in the 118/119 held-response / attribution / priming-echo code (see
   Candidate 3 verdict) — those guards are preserved untouched.

---

## 2. The fix design

### Part A — kill the resurrection (load-bearing), `frontend/src/lib/voice/realtime.ts`

1. Add `private aborted = false;` to `RealtimeCaddieClient`. Set it at the top of `stop()`
   (line 581) before `cleanup()`. A stopped client is TERMINAL — document on `start()` that a
   stopped instance never (re)starts; every caller already constructs a fresh client per burst
   (useCaddieLiveSession.ts:451/500/553, useVoiceCaddie.ts:199, warm-session.ts:134).
2. In `startInner()`, insert an abort re-check **after every await**, silently releasing whatever
   was acquired and returning WITHOUT emitting `'error'` (stop() already emitted `'closed'`; an
   error here would falsely trigger `degradeToText`/`fallBack` on an already-closed surface):
   - after the mint await (line 310, before `onMinted`/pc creation) — the load-bearing check:
     `if (this.aborted || activeRealtimeClient !== this) { this.cleanup(); return; }`
     (the `activeRealtimeClient !== this` clause is belt: any successor client re-took the cap);
   - after the `getUserMedia` await in the non-withheld path (line 377) — must stop the acquired
     tracks via `cleanup()`;
   - after the SDP `fetch` (line 402) and before `setRemoteDescription` (line 404).
   Emit a silent telemetry breadcrumb `voiceEvent('caddie', 'realtime_start_aborted')` at the
   post-mint check so field occurrences are visible (mirrors `realtime_dc_error`'s posture).
3. `start()` (line 281): `if (this.aborted) return;` so a stale reference can't restart it.
4. `attachMic()` (line 513): `if (this.aborted) throw new Error('attachMic: client stopped');`
   after the in-flight-start await — an adoption of a torn-down warm client must fail into the
   caller's existing error handling, never silently "succeed" deaf.
5. This same fix covers the warm pool (`warm-session.ts` `teardown()` mid-`warming` currently
   resurrects a billed mic-withheld zombie) and the orb path (`useVoiceCaddie.teardownClient` /
   `degradeToText` stopping a mid-mint burst) with **zero changes** to those call sites.

### Part B — consumer belts (a zombie must not be able to render, ever), `frontend/src/hooks/useCaddieLiveSession.ts`

- `fallBack()` (line 233): add `clientRef.current?.setEvents({});` before `stop()` — copy the
  exact pattern `startReconnect()` already uses (line 440).
- The `!active` reset branch (line 332) and the effect cleanup (line 579): same
  `setEvents({})`-before-`stop()` detach.
- The activation `events.onMessage` (line 423): wrap with the per-activation gate the other
  handlers already have — `onMessage: (m) => { if (cancelled || fellBackRef.current) return; upsert(m); }`.
- `frontend/src/hooks/useVoiceCaddie.ts` `teardownClient` (line 108-116): add
  `clientRef.current?.setEvents({})` before `stop()` (orb-path belt).

These are additive detach/gate lines; no state machine, ordering, or reconnect/resume logic
changes. `startReconnect`/`doResume` already detach correctly.

### Part C — the id-keyed single-emit guard (additive, per the contract)

All keyed on OpenAI Realtime ids, all **instance-scoped** (cleared in `cleanup()`,
realtime.ts:588-616) — reconnect/resume constructs a NEW client
(useCaddieLiveSession.ts:451/500), so a fresh session's ids can never collide with a dead
session's keys even if OpenAI's id sequence resets; cross-client transcript ordering is already
handled by `orderOffsetRef` (useCaddieLiveSession.ts:160-165, 262-265). This is why the guard
survives reconnect by construction.

1. **User turn commits exactly once per item id.**
   `private processedUserItems = new Set<string>();` (cap 64, evict oldest via insertion order —
   same posture as `MAX_INPUT_CLASS_ENTRIES`, realtime.ts:241). In the
   `conversation.item.input_audio_transcription.completed` branch, immediately after the
   `if (!this.opened)` gate and `itemId` extraction (realtime.ts:744-746):
   `if (itemId && this.processedUserItems.has(itemId)) break;` then mark processed. Marking happens
   whether the item renders, is dropped as a priming echo, or is empty — a re-delivered event for
   the SAME item is fully inert (no re-classification, no second telemetry breadcrumb, no second
   bubble). Final-only commit is preserved: input `.delta` events keep falling through the
   `default:` case untouched. **NOT keyed by text** — a rapid legit follow-up (even the identical
   sentence re-asked) arrives as a NEW committed item with a new `item_id` and is kept.
2. **A response finalizes exactly once per response id.**
   `private finalizedResponses = new Set<string>();` (cap 64, cleared in cleanup). Mark in the
   done-branch final emit (realtime.ts:721-724 and 726-729), in `releaseHeld(id, true)` (921-925),
   and in `suppressHeld` (932-940). Check at the top of the delta branch (661-688): a delta for an
   already-finalized id `break`s instead of re-creating a partial; and at the top of the done
   branch: an already-finalized id sets status and `break`s. Today the second `done` is inert only
   because `partials` was deleted — this makes the invariant explicit and closes the
   late-delta-resurrects-a-partial hole.
3. **Exactly one `response.create` per user turn — including multi-tool turns.**
   Extract the identical triple at realtime.ts:428-430 / 479-481 / 998-1000 into one private
   `sendResponseCreate()` (increments `selfTriggeredResponses`, clears `pendingSpeechItems`,
   sends). Then coalesce tool follow-ups per originating response:
   `private toolBatch = new Map<string, { pending: number; created: boolean }>();` keyed by
   `String(evt.response_id)` from `response.function_call_arguments.done` (GA carries
   `response_id` on that event). In the event case (805-811): bump `pending` BEFORE
   `void this.runTool(evt)`. In `runTool` (988-1001): post the `function_call_output` as today,
   then decrement; only when `pending === 0 && !created` send ONE `sendResponseCreate()` and mark
   `created` (delete the batch entry). Single-tool turns are byte-identical to today
   (1 → 0 → one create). If `response_id` is absent (defensive), fall back to the current
   per-call immediate create — never worse than today. Entries are deleted at create-time;
   also cleared in `cleanup()`.

### Why Part C stays strictly additive to the shipped guards

- **Priming-echo drop** (realtime.ts:756-764): unchanged; the dedup check sits above it and only
  fires for a repeated `item_id`, which by definition was already fully processed (including the
  drop + breadcrumb) the first time.
- **No-input clarifier hold/suppress** (classifyCandidates/releaseHeld/suppressHeld/resolveHeldFor,
  841-963): decision logic untouched; `finalizedResponses` is only WRITTEN at the exact points a
  response already resolves today, and only READ to reject duplicate events that today are
  accidentally inert.
- **Attribution candidate sets** (`triggerItemsByResponse`, 637-659): untouched; a duplicate
  `.completed` breaking early cannot re-run `setInputClass`/`resolveHeldFor`, which is safe because
  the first delivery already classified and resolved.
- **Ordering** (`realtime-ordering.ts`): no changes. A duplicate `.completed` never reaches
  `orderForUserTranscript`, so it can no longer burn a fresh FIFO/seq slot (today a duplicate
  would — line 101-103 — subtly desyncing order; the guard improves this).

**Explicitly out of scope:** `turn_detection` config (realtime_relay.py:84-100), mic constraints
(realtime.ts:371-377, 523-529), all thresholds — owner-gated.

---

## 3. Critical files to touch (and why)

| File | Change |
|---|---|
| `frontend/src/lib/voice/realtime.ts` | Part A abort guard (root cause) + Part C id-keyed dedup, response finalize-once, tool-batch single `response.create` |
| `frontend/src/hooks/useCaddieLiveSession.ts` | Part B: detach handlers (`setEvents({})`) in `fallBack`/`!active`/cleanup; gate `onMessage` on `cancelled`/`fellBack` |
| `frontend/src/hooks/useVoiceCaddie.ts` | Part B belt: detach handlers in `teardownClient` |
| `frontend/src/lib/voice/realtime-test-fakes.ts` | Add `getAllPcs()` (count every constructed FakePeerConnection) + deferred-mint helper — additive; existing suites keep `getLastPc()` |
| `frontend/src/lib/voice/realtime-dedup.test.ts` (NEW) | The event-stream harness pinning single-emit + no-resurrection (see §5) |
| `frontend/src/components/CaddieSheet.realtime.test.tsx` | Strengthen the Gap-2 test + close-during-connect detach assertions (see §5) |

No changes to: `realtime-ordering.ts`, `priming-echo.ts`, `noinput-clarifier.ts`,
`warm-session.ts`, `backend/**` (this fix), existing guard test suites (they must stay green
unmodified).

---

## 4. Edge cases & risks

- **Rapid legit follow-ups:** dedup keys are server ids, never text/time — a repeated identical
  question is a new committed item (new `item_id`) + new response id → rendered and answered.
  Pinned by test R4.
- **Reconnect id reset:** all new state is per-instance and reconnect/resume always constructs a
  new `RealtimeCaddieClient`; no cross-session id comparison exists → id reuse across sessions is
  structurally harmless. Order offset behavior unchanged.
- **Deltas before `transcription.completed`:** the normal GA ordering — untouched paths; ordering
  still reserved at `speech_started` (realtime.ts:789-799). Pinned by R6.
- **Aborted start must be silent:** no `'error'` status from an abort (would re-enter
  `degradeToText`/`fallBack` on a surface that already moved on). `stop()`'s `'closed'` is the only
  emission. Pinned by R1.
- **Held-response interactions:** `finalizedResponses` writes only at existing resolution points;
  suppression (`suppressHeld`) also marks finalized so a late duplicate `done` can't resurrect a
  suppressed clarifier. Pinned by R8.
- **Multi-tool batch hang:** if one tool dispatch never settles, no follow-up `response.create` —
  identical exposure to today (each `runTool` already awaits its dispatch before its create);
  dispatch errors still post an error output and decrement, so the batch always completes on
  settled promises.
- **Warm pool:** teardown mid-warming stops resurrecting billed zombies for free via Part A; no
  warm-session.ts edits, `realtime-warm.test.ts` must stay green.
- **Cost:** Part A also eliminates the invisible zombie's per-minute audio billing — the cost win
  is larger than the visible double-answer.
- **Risk of over-suppression:** the ONLY suppressed events are exact-id repeats of an
  already-processed item/response and 2nd..Nth `response.create` for one tool batch. No heuristic
  text matching anywhere.

---

## 5. Exact test additions

### 5.1 `frontend/src/lib/voice/realtime-test-fakes.ts` (extend, additive)

- Track every constructed pc: `const allPcs: FakePeerConnection[] = []` pushed in
  `RTCPeerConnectionMock`; export `getAllPcs()`. `getLastPc()` unchanged.
- Export `deferred<T>()` helper (`{ promise, resolve, reject }`) for mint-in-flight tests.

### 5.2 NEW `frontend/src/lib/voice/realtime-dedup.test.ts`

`// @vitest-environment jsdom`, same `vi.mock('@/lib/caddie/api')` / `vi.mock('@/lib/voice/telemetry')`
pattern as `realtime-lifecycle.test.ts:12-19` (the api mock's `startSetupSession`/
`startRealtimeSession` are `vi.fn`s so tests can `mockImplementationOnce` a deferred; also mock the
tool endpoints `getSessionStatus`/`getSessionConditions` to resolve `{ ok: true }` for R7).
`installFakeWebRTC()`/`uninstallFakeWebRTC()` per test.

- **R1 — stop-during-mint does not resurrect (RED first, the root cause):**
  `startSetupSession.mockImplementationOnce(() => d.promise)`; `client.start()` (don't await);
  `client.stop()`; `d.resolve({ client_secret: 's' })`; flush microtasks. Assert
  `getAllPcs()).toHaveLength(0)`, `navigator.mediaDevices.getUserMedia` not called, global `fetch`
  not called (no SDP exchange), `onStatus` never received anything after `'closed'`, and
  `voiceEvent` got `realtime_start_aborted`.
- **R2 — successor + resurrected predecessor → exactly one live pc:** client A with deferred mint;
  `A.stop()`; client B with instant mint, `await B.start()`; resolve A's mint; flush. Assert
  `getAllPcs()).toHaveLength(1)` (B's only) and B's dc still handles events.
- **R3 — duplicate `input_audio_transcription.completed` (same `item_id`) commits ONE user turn
  (RED first):** full normal turn (speech_started → response.created → delta → done → completed),
  then re-emit the identical `completed`. Assert exactly one `onMessage` with `role: 'user'`, and
  its `order` is below the response's order.
- **R4 — rapid legit follow-up KEPT:** two full turns, distinct `item-1`/`item-2` +
  `resp-1`/`resp-2`, with the SAME transcript text both times. Assert two user bubbles + two
  finals (guards against any blunt drop-the-second-message dedup).
- **R5 — interim transcripts never commit (final-only pin):** emit
  `conversation.item.input_audio_transcription.delta` events for `item-1` (with partial text),
  then `.completed`. Assert zero user messages before `.completed`, one after.
- **R6 — response deltas BEFORE `transcription.completed` (ordering pin):** speech_started(item-1)
  → response.created(resp-1) → deltas → done → completed(item-1). Assert one user + one final
  assistant, `user.order < assistant.order` (mirrors `realtime-ordering.test.ts` semantics through
  the real client).
- **R7 — multi-tool turn sends EXACTLY ONE `response.create` (RED first):** speech_started →
  response.created(resp-1) → two `response.function_call_arguments.done` events sharing
  `response_id: 'resp-1'` (`get_session_status`, `get_conditions`) → flush dispatch microtasks.
  Filter `dc.send` payloads: exactly 2 `conversation.item.create` function_call_outputs, exactly
  **1** `{type:'response.create'}`, and the create is sent after both outputs. Also a single-tool
  control case: exactly 1 output + 1 create (byte-parity with today).
- **R8 — shipped guards still fire with dedup active:**
  (a) priming echo: `completed` whose transcript `isPrimingEcho` matches → zero user bubbles +
  `realtime_priming_echo_dropped` breadcrumb; re-emit the same event → still zero, breadcrumb count
  still 1 (dedup makes the duplicate fully inert).
  (b) no-input clarifier: two blips + `driveClarifierResponse` (fakes:144-154) + empty transcripts
  → suppressed (`realtime_noinput_clarifier_suppressed`), zero assistant emits;
  (c) real-turn release: blip + real transcript → clarifier released, never swallowed
  (mirrors lifecycle L2 so the dedup provably didn't change these decisions).
- **R9 — double `done` emits one final (pin):** `output_audio_transcript.done` then
  `response.done` for the same id → exactly one non-partial assistant message. Then a late delta
  for that id → no new partial emitted (`finalizedResponses` check).
- **R10 — VAD re-trigger inert:** two `speech_started` with the SAME `item_id` then one
  `completed` → one user bubble, ordering intact.

### 5.3 `frontend/src/components/CaddieSheet.realtime.test.tsx` (extend)

- Strengthen the Gap-2 test (line 684): additionally assert
  `first.setEvents` was called with `{}` on fallback, and that a post-fallback
  `first.emitMessage(...)` does NOT surface (the `onMessage` gate).
- New: **close-during-connect detach** — render, start pending, rerender with `open: false`;
  assert `first.setEvents({})` called before `first.stop()`; reopen; assert a
  `first.emitMessage(...)` from the old client renders nothing while the second client's messages
  render.

---

## 6. Gates (all must pass)

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && npx vitest run src/lib/voice/realtime-dedup.test.ts \
  src/lib/voice/realtime-lifecycle.test.ts src/lib/voice/realtime-attribution.test.ts \
  src/lib/voice/realtime-noinput.test.ts src/lib/voice/realtime-ordering.test.ts \
  src/lib/voice/realtime-warm.test.ts src/lib/voice/realtime-dispatch.test.ts \
  src/lib/voice/priming-echo.test.ts src/lib/voice/warm-session.test.ts \
  src/components/CaddieSheet.realtime.test.tsx
```

RED-first discipline: R1, R3, R7 (and the strengthened Gap-2 assertion) must FAIL against current
code before the fix, then pass after. The existing guard suites must pass UNMODIFIED.

---

## 7. Shared-types check

**No sync needed.** All changes are frontend-internal client state (`RealtimeCaddieClient` private
fields) and hook wiring. No wire schema, request/response model, or event payload changes.
`frontend/src/lib/types.ts` contains no realtime types (verified by grep);
`backend/app/models.py` and `backend/app/routes/realtime.py` request/response models are untouched.

---

## 8. Secondary finding (flag only — file as a SEPARATE item)

**Hole-3 header/caddie mismatch:** header "PAR 3 · 355 YDS" vs caddie "466y par 4". The header and
the client-side anchor use the SAME frontend-resolved facts — `holeNumber/holePar/holeYards` props
flow into both the header and `buildHoleContextText` via `holeContextRef`
(useCaddieLiveSession.ts:187-192, 281-287). The caddie's spoken numbers, however, are grounded by
the BACKEND session: the minted instructions' situation block
(`backend/app/routes/realtime.py:115-141` → `build_realtime_instructions(personality, session=...)`,
sourced from the server-side caddie session's course data) and the session tool payloads
(`backend/app/routes/caddie.py`). So the mismatch is a frontend-round-snapshot vs backend-course-data
divergence — exactly the pre-ingest-round caveat: the owner's rounds predate the Bethpage re-ingest,
so the round's stored hole facts (header) and the re-ingested course rows the backend session reads
(caddie) disagree (hole numbering/pars shifted). Notably the client's silent `sendContext` re-anchor
carried the header's numbers and the model still spoke the backend's — worth one telemetry check in
the follow-up (did the `role:"system"` anchor item get rejected? `realtime_dc_error` breadcrumb,
realtime.ts:813-828).

**Recommendation:** owner starts a FRESH round on the re-ingested Bethpage to confirm; file
"live caddie hole-context source mismatch on pre-re-ingest rounds" as its own item. Do NOT fold any
context plumbing changes into this de-dup fix.
