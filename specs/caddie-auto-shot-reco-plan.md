# caddie-auto-shot-reco — Implementation Plan

Backlog id: `caddie-auto-shot-reco` · P1 · low risk · frontend-only
Owner intent: when "Ask Caddie" opens during an active round, the caddie
IMMEDIATELY delivers a brief "here's the play from where you are" as its OPENING
turn — no typing/speaking. Default question is exactly *"What should I hit or do
on this next shot"*. Follow-ups then proceed fully conversationally as today.

This is a contract. Build it as written; do not re-decide architecture.

---

## 1. Chosen approach + transport decision (with justification)

**Reuse the existing `askCaddie` path verbatim.** On a fresh sheet-open the
component auto-invokes the SAME `askCaddie(question)` that a spoken/typed turn
uses. No new endpoint, no second transport, no second render path.

### Where does distance-to-pin come from? (the load-bearing investigation)
- `CaddieSheet` is deliberately **GPS-free** (see its header comment) and today
  receives only `holeNumber/holePar/holeYards` — never a live player position or
  a distance-to-pin. `holeYards` is the hole's **tee-to-green** length, not
  "where you are."
- The **session backend prompt** (`_build_session_voice_prompt`,
  `backend/app/routes/caddie.py` ~L524) assembles hole intel (par, yards,
  effective_yards, hazards, green slope), weather, handicap, clubs,
  `last_recommendation`, and recent shots — but it carries **no live
  distance-to-pin** either.
- The **streaming voice endpoint** `/caddie/session/voice/stream`
  (`sessionVoiceStream`) accepts only `{ round_id, transcript, personality_id,
  hole_number }`. It has **no `distance_yards` field**. So for a session round
  (the target case) the only way to ground the streamed reply in live
  distance-to-pin is to put the distance **into the transcript**.
- Live GPS + green coords DO exist in the parent: `RoundPageClient` has
  `holeCoordsForTiles?.green` (current hole green lat/lng, from `mapCoords`) and
  the app already has `GPSWatcher.getCurrentPosition()` (`frontend/src/lib/gps.ts`)
  and `haversineYards()` (`frontend/src/lib/map/google-map-helpers.ts`).
  `GoogleSatelliteMap` uses GPS internally but never lifts distance-to-pin up to
  `RoundPageClient` state, so nothing is available to the sheet today.

### Decision
**One call fires on open: `askCaddie(openingQuestion)`**, where the parent
resolves a real GPS distance-to-pin and the question embeds it, e.g.:

> `"I'm about 147 yards from the pin. What should I hit or do on this next shot?"`

Rationale:
- **Single existing path.** `askCaddie` already gives streaming + TTS + history
  append + the exact completion lifecycle. Reusing it satisfies constraints 3
  and 6 for free and cannot drift from a normal reply — because it *is* one.
- **Grounded + transparent (constraint 2).** The GPS distance is real, and it is
  surfaced verbatim in the user-question bubble the existing `VoiceBody` already
  renders above the answer ("show what the reco is based on"). The session
  prompt supplies hazards/weather/clubs so the streamed reco is fully grounded.
- **No structured `/session/recommend` call is needed.** We only add one if
  distance-to-pin is otherwise unavailable to the reply — and embedding it in
  the transcript makes it available on the single streaming path, so the second
  call would be redundant surface area. (If a future cycle wants the structured
  club/target/miss card seeded into `session.last_recommendation`, that is an
  additive follow-up; not this cycle.)

The distance is computed in the **parent** (which already owns course coords and
GPS), and passed to the sheet as an async resolver that returns a real number or
`null`. The sheet stays free of map/GPS APIs; it only decides "number → fire,
null → stay idle."

---

## 2. Exact files to touch

### A. `frontend/src/components/CaddieSheet.tsx` (primary)
1. **New prop** on `CaddieSheetProps`:
   ```ts
   /** Resolves the golfer's live distance-to-pin (yards) for the auto opening
    *  turn, or null when there is no GPS fix / no green coords / it times out.
    *  Parent owns GPS + course coords; the sheet stays GPS-free. */
   resolveOpeningShot?: () => Promise<{ distanceYards: number } | null>;
   ```
2. **Extend `askCaddie` with a silent-failure flag** (keeps ONE path; only the
   auto-turn needs honest-idle-on-failure). Change the signature to
   `askCaddie(question: string, opts?: { suppressError?: boolean })`. In its
   `catch` block, when `opts?.suppressError` is set, do **not** call
   `setError(...)`; instead leave the sheet idle (`setError(null)` — voiceAnswer
   is already null on a discarded partial). All other behavior identical
   (partial discarded, `tts.speak` still gated on `done` so it never fires on
   failure). Add `openingFiredRef` and `resolveOpeningShot` are NOT in
   `askCaddie` deps.
3. **New ref + auto-fire effect** (the fire-once-on-open trigger — see §3).
4. **Ref-mirror `resolveOpeningShot`** (`resolveOpeningShotRef`) synced via a
   tiny effect, mirroring the existing `convHistoryRef`/`autoStopRef` pattern, so
   the auto-fire effect need not list it as a dep.

No changes to `VoiceBody`, `TapBody`, streaming, TTS, or the mic UI: the auto
turn renders through the existing `thinking` → `answered` phases (the question
shows via the existing `transcript` display; the reply streams into the existing
answer bubble; the mic re-arms via the existing `showMic`/`isStreaming` gate).

### B. `frontend/src/app/round/[id]/RoundPageClient.tsx`
1. Add a memoized resolver and pass it to `<CaddieSheet>` as `resolveOpeningShot`:
   ```ts
   const greenForHole = holeCoordsForTiles?.green ?? null; // {lat,lng} | null
   const resolveOpeningShot = useCallback(async () => {
     if (!greenForHole) return null;                 // no green coords → honest null
     try {
       const pos = await withTimeout(GPSWatcher.getCurrentPosition(), 6000);
       if (!pos) return null;
       const d = haversineYards(pos, greenForHole);
       if (!Number.isFinite(d) || d < 1 || d > 800) return null; // implausible → null
       return { distanceYards: d };
     } catch {
       return null;                                  // no fix / denied / timeout → honest null
     }
   }, [greenForHole?.lat, greenForHole?.lng]);
   ```
   - Add a local `withTimeout(promise, ms)` helper (race against a timer that
     resolves `null`) OR inline an `AbortController`-free timeout; keep it to the
     6s budget so a hanging fix falls back fast (getCurrentPosition's own 15s is
     too long for an on-open experience).
   - Imports: `GPSWatcher` from `@/lib/gps`, `haversineYards` from
     `@/lib/map/google-map-helpers` (both already exist).
2. Wire the prop: `resolveOpeningShot={caddieSessionActive && !isLocalRound ? resolveOpeningShot : undefined}`
   (mirrors the existing `sessionActive` gate; passing `undefined` when there is
   no session means the sheet's guard short-circuits before any GPS call).

### C. Backend — **no changes.** All endpoints reused as-is.

---

## 3. Open-trigger + idempotency mechanism

Add ONE effect and ONE ref in `CaddieSheet`:

```ts
const openingFiredRef = useRef(false);

useEffect(() => {
  if (!open) { openingFiredRef.current = false; return; } // reset only on close
  if (openingFiredRef.current) return;          // already fired this open (guards
                                                //  re-render AND strict-mode double effect)
  if (!sessionActive || !roundId) return;       // no session → open exactly as today
  if (!resolveOpeningShotRef.current) return;    // parent opted out → idle
  if (convHistory.length > 0) return;           // reopened onto an existing thread → no auto-fire
  if (voiceAnswer || isThinking || isListening) return; // never fire over an in-flight/answered turn

  openingFiredRef.current = true;               // set BEFORE any await → strict-mode-safe
  const gen = openGenRef.current;               // reuse existing open-generation guard
  void (async () => {
    const shot = await resolveOpeningShotRef.current!();
    if (openGenRef.current !== gen) return;      // sheet closed/reopened while awaiting GPS
    if (!shot) return;                            // no GPS fix → stay idle (open as today)
    const q = `I'm about ${shot.distanceYards} yards from the pin. What should I hit or do on this next shot?`;
    setTranscript(q);                             // existing state → shows in the user bubble (transparency)
    await askCaddie(q, { suppressError: true });  // identical streaming path; honest-idle on failure
  })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [open, sessionActive, roundId, convHistory.length]);
```

Idempotency guarantees (constraint 4, recalling #104's double-render tail race):
- `openingFiredRef` is set **synchronously before the first `await`**, so React
  strict-mode's mount→unmount→mount double-invoke fires the network turn at most
  once; the second pass sees `true` and bails.
- The ref is reset to `false` ONLY on `open === false`, never in a cleanup that
  runs on a strict-mode remount — so a remount does not re-arm it.
- `askCaddie` updates `convHistory` → the effect re-runs (dep `convHistory.length`)
  → `openingFiredRef.current` is `true` → bail. No duplicate opening turn.
- `openGenRef` (already bumped on every open/close, L256) invalidates a GPS fix
  that resolves after the sheet was closed/reopened.
- `convHistory.length > 0` guard: history is parent-owned and persists across
  close/reopen (#9), so reopening onto an existing conversation does NOT auto-fire.

---

## 4. Fallback branches (constraint 1 — honest, never fabricated)

Every branch below leaves the sheet in its **existing idle state** (phase
`idle`: the "Ask anything…" prompt + armed mic). No fake reco, ever.

| Condition | Where caught | Result |
|---|---|---|
| No active session / local round | `!sessionActive \|\| !roundId`, or parent passes `resolveOpeningShot={undefined}` | Effect returns early. Sheet opens idle, exactly as today. |
| No GPS fix / permission denied / GPS timeout (6s) | `resolveOpeningShot` returns `null` | Effect bails after the ref-set (no retry-spam). Sheet stays idle. |
| No green coords for hole (unmapped/legacy) | resolver returns `null` (no `greenForHole`) | Sheet stays idle. |
| Implausible distance (<1 or >800 yds) | resolver returns `null` | Sheet stays idle. |
| Reopened onto an existing conversation | `convHistory.length > 0` | No auto-fire; prior thread shown as today. |
| Stream/recommend call fails or times out | `askCaddie` catch + `suppressError:true` | Partial discarded, **no error bubble**, sheet reverts to idle. TTS never fires (gated on `done`). |

Note: for a normal (user-initiated) turn the error bubble still shows — only the
unprompted auto-turn suppresses it, because the golfer asked nothing yet.

---

## 5. Shared-type sync check

**No wire-shape changes.** The opening turn rides `askCaddie` → existing
`sessionVoiceStream` payload `{ round_id, transcript, personality_id,
hole_number }` (and the stateless tier-2/3 fallbacks, all unchanged). Nothing is
added to any request/response model. Therefore:
- `frontend/src/lib/types.ts` — unchanged.
- `frontend/src/lib/caddie/types.ts` — unchanged.
- `backend/app/models.py` — unchanged.
The new `resolveOpeningShot` is a **frontend component prop only**, not a
transport type — no cross-boundary sync needed.

---

## 6. TTS behavior (constraint 5)

- `tts.speak(fullText, personaId)` already no-ops when `getSheetTtsEnabled()` is
  false, so the opening turn is spoken only when the persisted speaker pref is on
  and silent (text-only) otherwise. No forced audio.
- **iOS autoplay caveat (document, do not fix this cycle):** `useSheetTTS` needs
  a prior `unlock()` inside a user gesture. The tap that opens the sheet happens
  in the parent and does not reach `tts.unlock()`, so on the *first* open in a
  session before any mic/speaker tap, playback may be blocked — `useSheetTTS`
  swallows the autoplay-block error (never throws). `unlockedRef` persists for
  the life of the mounted `CaddieSheet`, so every subsequent open (and its auto
  turn) speaks normally. This satisfies "never force audio." Optional future
  enhancement (not this cycle): bless the audio element in the parent's caddie
  button gesture.

---

## 7. Composability with future `caddie-conversational-loop` (constraint 3)

Because the opening turn IS an `askCaddie` call, it terminates through the exact
same lifecycle as any reply: `answerBuffer.flush()` → `setVoiceAnswer(fullText)`
→ `onUpdateConvHistory(pair)` → `tts.speak(...)` (once) → `finally`
`setIsThinking(false); setIsStreaming(false)`. A future auto-listen can hook the
identical completion point (stream `done` + TTS `ended`) with zero special-casing
for the opening turn. **Do NOT build auto-listen now** — just do not block it
(this design does not).

---

## 8. Test plan (deterministic, scheduler-controlled)

Extend `frontend/src/components/CaddieSheet.session.test.tsx` (reuse its existing
mocks: framer-motion→synchronous passthrough, `stream-buffer`→synchronous,
`useSheetTTS`→spies, `deferredStream()` hand-controlled stream). Add a
`describe("CaddieSheet — auto opening shot recommendation", …)`. Pass
`resolveOpeningShot` via `renderSheet` overrides; default it to a resolver
returning `null` in existing tests so they are unaffected (or gate on it being
provided). Never use real `setTimeout`/rAF.

Required cases:
- **(a) Fires exactly once on fresh open.** `resolveOpeningShot` →
  `{ distanceYards: 147 }`, `sessionVoiceStreamMock` = `deferredStream()`. Assert
  `sessionVoiceStream` called once with a transcript containing `"147"` and
  `"What should I hit or do on this next shot"`; push tokens + resolve; assert the
  answer renders, history updated with the user+assistant pair, `ttsSpeakSpy`
  called once with the full text.
- **(b) Does NOT fire with no session.** `renderSheet({ sessionActive: false,
  resolveOpeningShot })`. Assert `sessionVoiceStream`/`talkToCaddieStream`/
  `talkToCaddie` never called; the idle "Ask anything…" prompt is present.
- **(b2) Does NOT fire with no GPS fix.** `resolveOpeningShot` → `null`. Assert no
  caddie call; sheet idle. Also assert it is not retried (advance ticks, still 0).
- **(c) Does NOT re-fire.** (i) Re-render via a prop change (e.g. `accent`) after
  the turn resolved → still exactly one call. (ii) `renderSheet({ convHistory:
  [{role:'user',…},{role:'assistant',…}] })` with a resolver → no auto-fire
  (reopened onto an existing thread).
- **(c2) Strict-mode double-effect safety.** Render inside `React.StrictMode`
  with a `deferredStream()`; assert `sessionVoiceStream` called exactly once.
- **(d) TTS honored.** Default (spy) speak fires once on success (pref-gating is
  covered by the spy; the real pref path is unchanged). Add a case: a
  `suppressError` failure (`sessionVoiceStreamMock` rejects post-first-token or a
  non-BeforeFirstByte error) → assert `ttsSpeakSpy` NOT called and **no error
  bubble** rendered (sheet returns to idle), proving honest-empty-on-failure.
- **(e) Same completion lifecycle as a normal reply.** After the opening turn
  resolves, assert "Ask follow-up" mounts and the mic re-arms
  (`findByLabelText("Start recording")`) — identical to the existing tier-1 test.

Mirror the existing suite's `afterEach` drain (5 `act(async…Promise.resolve())`
ticks) so a settled stream continuation never crosses a test boundary.

---

## 9. Gates to run (all must pass)

```
cd frontend && npm run lint && npx tsc --noEmit && npm run build \
  && npx tsx voice-tests/runner.ts --smoke
cd frontend && npx vitest run src/components/CaddieSheet.session.test.tsx
```
Backend is untouched, so `ruff` is not required; run `cd backend && ruff check .`
only if any `.py` is edited (it should not be). DB-backed backend tests run in CI
only (no local Postgres).

---

## 10. Edge cases + risks

- **Distance staleness:** the fix is one-shot at open. If the golfer has moved,
  the reco reflects the open moment — acceptable; follow-ups are conversational.
- **Persona change while open:** `askCaddie` deps include `personaId`; the
  opening turn already fired (ref true) so a persona switch mid-open does not
  re-fire. Correct.
- **Fast open/close:** `openGenRef` + `streamAbortRef` (existing) abort an
  in-flight opening stream on close; nothing persists server-side (the stream
  only appends on `done`).
- **First-open iOS silence:** documented in §6 — honest, never forced.
- **Attributed "user" line:** the embedded-distance question renders in the user
  bubble. This is honest (real GPS distance, transparent grounding) and the
  chosen phrasing reads as the golfer's implicit ask; owner may tweak wording.
- **Risk — double-fire (recall #104):** mitigated by the synchronous pre-await
  ref-set, close-only reset, and `convHistory.length` re-run bailing on the ref.
  The test suite pins this (cases c, c2).

---

## 11. Explicitly NOT in this cycle

- **No auto-listen / hands-free re-arm** (`caddie-conversational-loop`). This plan
  only guarantees the opening turn ends at the identical completion point so that
  future cycle can hook it.
- **No structured `/session/recommend` seeding** of `last_recommendation` for the
  opening turn (redundant given transcript grounding; additive follow-up if ever
  wanted).
- **No new GPS surface in the sheet** (parent owns GPS; sheet stays GPS-free).
- **No wire/model changes.**
