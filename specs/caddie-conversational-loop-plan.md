# Caddie Conversational Loop — Implementation Plan

Backlog id: `caddie-conversational-loop` (MAJOR / owner-directed, on-course 2026-07-07)

> Owner: "Doesn't feel conversational to have to click the speaker for each
> interaction. Should be more similar to the round set up to pick up pauses and
> proceed as needed."

Goal: make the in-round **Ask Caddie** sheet a continuous, hands-free
conversation. After the caddie **speaks** a reply, automatically re-arm the mic
so the golfer just talks, pauses, and the caddie proceeds — no tapping the mic
per turn. The speaker preference **persists** (never per-interaction). This must
**compose with the auto opening shot recommendation** (commits e5a9526 +
e8141d7): the opening reco is the caddie's first spoken turn, and when its
playback finishes, hands-free listening begins — with zero special-casing.

---

## 1. Transport decision (and the tradeoff)

**Decision: build the loop on the EXISTING Deepgram dictation + `useSheetTTS`
path already in `CaddieSheet.tsx`. Re-arm dictation when TTS playback ends. Do
NOT route Ask Caddie through the Realtime session.**

Why this path (lower risk, fully testable, reuses sheet machinery):

- The sheet already owns the full turn machine: `startListening` /
  `stopListening` (VoiceRecorder + `DeepgramLiveTranscriber`), UtteranceEnd
  auto-send, the streaming ladder (`askCaddie`), `useSheetTTS.speak` on reply
  completion, and the persisted speaker pref (`tts-pref.ts`). The **only**
  missing piece is a single edge: *TTS playback end → re-arm dictation*. That is
  an additive event wire, not a re-architecture.
- The Realtime warm-path invariants (`realtime.ts` / `warm-session.ts` /
  `useVoiceCaddie.ts` / `useRealtimeCaddie.ts`) are load-bearing and only
  device-verifiable. Routing the sheet through Realtime as primary transport
  would mean the sheet becomes a transcript view over a WebRTC session, which:
  (a) changes the sheet's whole history/streaming model (it currently owns
  `convHistory` text turns, not `RealtimeMessage`s), (b) risks the mic-withhold
  / `attachMic()`-is-the-only-`getUserMedia` invariant, and (c) is far harder to
  test deterministically in jsdom. The backlog's "consider Realtime" note is
  explicitly a *consider* — the guidance is to prefer the lower-risk path that
  reuses existing sheet machinery unless Realtime is clearly better. It is not:
  Realtime already exists as the tier-1 orb transport (`useVoiceCaddie`); the
  sheet is the tier-2 text fallback. Making the fallback depend on the thing it
  is a fallback for would be backwards.

**The tradeoff, stated explicitly:** the Realtime path would give true full-duplex
barge-in and server-VAD turn-taking "for free," and a marginally more seamless
feel. We are trading that incremental smoothness for: no risk to the Realtime
mic invariants, no rewrite of the sheet's text-turn model, deterministic
tests, and a change that **degrades to today's exact behavior** the moment the
speaker is off. The half-duplex loop (speak → grace → listen) is the correct
first implementation of "pick up pauses and proceed"; a Realtime upgrade can be
a later, separately-planned, device-tested cycle if the feel demands it.

---

## 2. What already exists (verified by reading, not assumed)

- **Auto-send on end-of-speech.** `DeepgramLiveTranscriber` emits
  `onUtteranceEnd` (Deepgram `utterance_end_ms=1200`) which fires
  `autoStopRef.current()` → `stopListening()` → `askCaddie(finalText)`.
  Critically, `deepgram-live.ts` only fires UtteranceEnd **when speech was
  heard** (`if (this.accumulatedFinals || this.latestInterim)`), never on pure
  silence. (deepgram-live.ts:303-308)
- **TTS playback.** `useSheetTTS` owns one `HTMLAudioElement`; `speak()` fetches
  audio and plays; `isSpeaking` reflects state; `stop()` pauses + rewinds. The
  element has `ended` **and** `pause` listeners, both currently routed to the
  same `onEndedOrPaused` → `setIsSpeaking(false)`. There is **no completion
  callback** exposed today — this is the hook gap we close. (useSheetTTS.ts:33-57)
- **Speaker preference persists.** `tts-pref.ts` (`looper.sheetTtsEnabled`,
  default OFF/opt-in). The header speaker toggle flips `ttsEnabled` state +
  localStorage. (CaddieSheet.tsx:919-972)
- **Auto opening reco.** On fresh open with an active session + GPS fix, the
  sheet fires `askCaddie("I'm about N yards from the pin…", {suppressError})` —
  the identical streaming path, and `tts.speak` fires on its completion. So its
  playback-end is indistinguishable from any other turn. (CaddieSheet.tsx:514-545)
- **Echo hardening.** `VoiceRecorder.start()` requests
  `{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }`.
  `DeepgramLiveTranscriber` reuses that same stream (no 2nd getUserMedia).
  (deepgram.ts:52-58, deepgram-live.ts:181-195)

**The missing piece:** when TTS playback FINISHES (sheet still open, speaker on),
start dictation again — with echo, dead-air, iOS, barge-in, and exit guards.

---

## 3. Design of the loop

### 3.1 The control surface — no new toggle (NORTHSTAR: minimal chrome)

**Recommendation: hands-free is IMPLICIT. It is ON whenever the sheet is open
AND the speaker (`ttsEnabled`) is on. The existing header speaker toggle IS the
hands-free switch.**

Justification against NORTHSTAR ("quiet", "minimal chrome", "no mode-fest"):
turning on spoken replies already means "I want to converse by voice." Coupling
the loop to that one persisted pref means zero new UI, zero new mental model, and
one intuitive control:

- Speaker **off** → today's exact tap-per-turn behavior (text only, no re-arm).
  This is also the rollback posture (§8).
- Speaker **on** → conversational: speak → the caddie speaks → it listens again.

The pref already persists (never per-interaction), satisfying the owner's
requirement directly.

### 3.2 State added to `CaddieSheet`

Constants (module-scope):

```
const REARM_GRACE_MS = 400;   // §3.3 echo guard — wait past playback end
const DEAD_AIR_MS    = 6000;  // §3.4 silence after re-arm → drop out
const MAX_EMPTY_STREAK = 2;   // §3.4 consecutive empty/failed listens → drop out
```

Refs / state:

- `graceTimerRef: useRef<number | null>` — the post-playback re-arm timer.
- `deadAirTimerRef: useRef<number | null>` — the "armed but silent" timer.
- `emptyStreakRef: useRef<number>` — consecutive empty auto-listens.
- `const [loopDroppedOut, setLoopDroppedOut] = useState(false)` +
  `loopDroppedOutRef` mirror — true once we've calmly exited the loop; blocks
  further auto re-arm until the golfer manually taps the mic.
- `ttsEnabledRef` mirror of `ttsEnabled` (read inside the playback-end callback
  without stale closure — mirrors the existing `convHistoryRef` pattern).
- All timers use `window.setTimeout` / `window.clearTimeout` (scoped to
  `window.*` per tasks/lessons.md 2026-07-07 so fake-timer stubs are testable and
  never leak across jsdom files).

### 3.3 Echo risk — detect playback END + grace delay (hard part #1)

Re-arming while the last TTS syllables still play makes Deepgram hear the app's
own voice (echoCancellation reduces but does not eliminate loudspeaker bleed).
Defense = **timing**, layered on top of the existing `echoCancellation:true`:

1. **Detect true playback end, not interruption.** Extend `useSheetTTS` to fire a
   new optional `onPlaybackEnd` callback **only on the audio element's native
   `ended` event** (natural completion). Split the current combined listener:
   - `ended`  → `setIsSpeaking(false)` **and** `onPlaybackEndRef.current?.()`.
   - `pause`  → `setIsSpeaking(false)` **only** (this is what `stop()`, a new
     `speak()`, or barge-in produce — must NOT trigger a re-arm).
   This makes "playback finished on its own" a clean, single signal and makes
   double-arm structurally impossible.
2. **Grace window.** On `onPlaybackEnd`, do not arm immediately — schedule
   `startListening` `REARM_GRACE_MS` (400ms) later via `graceTimerRef`. Rationale:
   the element has fully released, iOS can tear down the playback route (§3.5),
   and any residual echo tail is past. Deepgram's `utterance_end_ms` is 1200ms,
   so even a stray echo fragment surviving EC would not complete an utterance
   before real speech; combined with EC the risk is negligible. 400ms is
   imperceptible in the calm cadence and well under the golfer's own reaction
   time to start talking.

`onPlaybackEnd` handler guard (all must hold to schedule a re-arm):
`open && mode === "voice" && ttsEnabledRef.current && !loopDroppedOutRef.current
&& !isListening && !isTranscribing && !isThinking && !isStreaming &&
!streamAbortRef.current`.

### 3.4 Infinite-loop / dead-air guards (hard part #2)

The loop is **structurally bounded**: the ONLY thing that triggers a re-arm is a
successful TTS playback, which requires a successful `askCaddie`, which requires
a **non-empty** transcript (`isEmptyTranscript` gate in `stopListening`). Empty
input produces no reply, no TTS, no `ended` event → no re-arm. So an empty/failed
transcription can never spin the loop. Two explicit guards make the exit calm and
cover the "armed but the golfer is silent" case (where UtteranceEnd never fires):

- **Dead-air timer.** When an auto re-arm opens the mic, start `deadAirTimerRef`
  (`DEAD_AIR_MS`, 6s). Cancel it the moment any `onInterim` text arrives (speech
  detected — let UtteranceEnd finish the turn). If it expires with no speech:
  `stopListening`-equivalent cleanup (cancel the recorder/live socket, no ask),
  then **drop out** (`setLoopDroppedOut(true)`). Silence = the golfer is done.
- **Empty-streak counter.** `emptyStreakRef` increments on any auto-armed listen
  that ends empty/failed (belt-and-braces for repeated ambient noise that trips
  UtteranceEnd but yields nothing usable). Reset to 0 on any successful turn.
  At `>= MAX_EMPTY_STREAK` (2), drop out.

**What the UI shows on drop-out (calm, not alarming):** no error, no red. The
sheet returns to its normal idle mic block; the label reads its existing calm
copy — "Tap to speak". (Optionally a one-line, pencil-colored note is acceptable,
but the default is simply the existing idle affordance — the golfer taps the mic
to re-engage, which clears `loopDroppedOut`.) This matches VoiceRoundSetup's calm
"try again" posture rather than an error surface.

Only a genuine mic/permission failure uses the existing error path (unchanged).

### 3.5 iOS audio-session interplay (hard part #3)

Inside WKWebView (Capacitor) the switch is playback (`HTMLAudioElement`, playsinline)
→ record (`getUserMedia`). Known pitfalls and how this plan handles them,
consistent with how the Realtime setup flow treats audio:

- **Switching order:** fully finish/release playback BEFORE acquiring the mic.
  The `ended`-event + 400ms grace guarantees the audio element is stopped and the
  AVAudioSession has settled before `getUserMedia` runs. Never overlap them.
- **Gesture/unlock:** the audio element is blessed once via `tts.unlock()` inside
  the first mic tap (the existing `handleMicTap` line), identical to
  `realtime.ts`'s remote-audio-sink bless-play-then-pause. Subsequent auto re-arms
  need no gesture: `getUserMedia` permission is already granted for the session
  and the element is already blessed. This mirrors the setup flow, which also does
  its one getUserMedia (`attachMic`) at open and then runs continuously.
- **Pitfall to avoid:** do NOT call `getUserMedia` while `isSpeaking` — on iOS
  this can duck or interrupt the playback route mid-word. The `ended`-only signal
  plus grace is precisely what prevents this. Barge-in (§3.6) explicitly stops
  playback first, then acquires the mic — same ordering, never overlapped.

### 3.6 Barge-in (hard part #4)

Tapping the mic **while the caddie speaks** must interrupt cleanly. In
`handleMicTap`, before starting to listen:

1. `if (graceTimerRef.current) clear it` — cancel any pending auto re-arm so it
   can't double-fire.
2. `if (tts.isSpeaking) tts.stop()` — pauses playback immediately (fires `pause`,
   NOT `ended`, so no re-arm is scheduled from the interruption).
3. `setLoopDroppedOut(false)` and `emptyStreakRef = 0` — the golfer re-engaged.
4. Existing `tts.unlock()` (already there) + `startListening()`.

Net interaction: caddie is talking → golfer taps mic → voice cuts, mic opens,
"Hearing…". This reuses the existing tap handler; it's an addition, not a rewrite.

### 3.7 A way out / cleanup (hard part #5)

- **Closing the sheet exits the loop.** The existing `!open` cleanup effect
  already stops recorder, live socket, TTS, and stream. Extend it to also:
  `clear graceTimerRef`, `clear deadAirTimerRef`, `emptyStreakRef = 0`,
  `setLoopDroppedOut(false)` — no dangling timers, no leaks. The effect's
  unmount return also clears both timers (belt-and-braces, like the existing
  recorder/live teardown).
- **Turning the speaker off** mid-conversation immediately halts the loop: the
  `onPlaybackEnd` guard checks `ttsEnabledRef.current`, and the header toggle's
  `tts.stop()` path fires `pause` (no re-arm). This is the in-conversation "stop
  talking to me" gesture, using the control that already exists.
- No new toggle (§3.1).

---

## 4. Voice invariants that MUST hold (enumerated + confirmed)

This plan touches only `useSheetTTS.ts` (additive callback) and `CaddieSheet.tsx`
(additive loop). It does NOT touch `realtime.ts`, `warm-session.ts`,
`useVoiceCaddie.ts`, `useRealtimeCaddie.ts`, `deepgram-live.ts`,
`deepgram.ts`, or `pcm-capture.ts`. Invariants preserved:

1. **Realtime mic-withhold.** `getUserMedia` is called only in
   `RealtimeCaddieClient.attachMic()`; warm sessions use a silent track until
   adopted. UNTOUCHED — the sheet's dictation is a separate VoiceRecorder path.
2. **Warm-session single-getUserMedia / adoption ladder** (`useVoiceCaddie`,
   `warmSession.takeWarm/attachMic`). UNTOUCHED.
3. **No double getUserMedia in dictation.** `DeepgramLiveTranscriber.start()`
   reuses `VoiceRecorder.getStream()`. The loop re-uses `startListening()`
   verbatim, so this holds — one getUserMedia per listen, live socket shares it.
4. **UtteranceEnd never fires on silence** (deepgram-live.ts guard). Relied upon;
   the dead-air timer covers the silence case the guard intentionally ignores.
5. **Single HTMLAudioElement → double-voice impossible; `stop()` = pause.** The
   new `onPlaybackEnd` fires only on `ended`, never on the pause that `stop()` /
   overlap / barge-in produce — so the loop can never double-arm or fight a new
   `speak()`. Preserved and reinforced.
6. **`openGenRef` stale-async invalidation** on open/close. The new timers are
   cleared in the same close path, matching the existing discipline.
7. **`showMic` only re-mounts after a reply has fully streamed** (`!isStreaming`).
   The loop respects this — it arms via `startListening` gated on
   `!isStreaming`, and only after `onPlaybackEnd` (which is strictly after the
   turn resolved and `tts.speak` played).

---

## 5. Shared types (frontend ↔ backend)

**None.** Grep of `src/lib/types.ts` and `backend/app/models.py` for
hands-free / TTS / conversational shapes returns nothing; this is a pure
frontend interaction change over existing endpoints. `SheetTTS` (the hook's TS
interface in `useSheetTTS.ts`) gains an optional `onPlaybackEnd` option — a
local frontend type, not a wire type. No `models.py` change, no backend change.
Confirmed.

---

## 6. Precise, minimal file-by-file change list (the builder's contract)

### 6.1 `frontend/src/hooks/useSheetTTS.ts` (additive, backward-compatible)

- Add an optional options arg: `useSheetTTS(opts?: { onPlaybackEnd?: () => void })`.
  **Must remain callable as `useSheetTTS()`** — `LooperSheet.tsx` (and today's
  `CaddieSheet`) call it with no args.
- Store `opts?.onPlaybackEnd` in a ref updated each render
  (`onPlaybackEndRef`), so the callback identity can change without recreating
  the audio element.
- Split `createAudioEl`'s listeners:
  - `ended` → `setIsSpeaking(false)`; `onPlaybackEndRef.current?.()`.
  - `pause` → `setIsSpeaking(false)` only.
- No change to `speak` / `stop` / `unlock` / unmount cleanup semantics.

### 6.2 `frontend/src/components/CaddieSheet.tsx` (additive loop)

- Add constants `REARM_GRACE_MS`, `DEAD_AIR_MS`, `MAX_EMPTY_STREAK`.
- Add refs: `graceTimerRef`, `deadAirTimerRef`, `emptyStreakRef`,
  `loopDroppedOutRef`, `ttsEnabledRef`; add `loopDroppedOut` state.
- Keep `ttsEnabledRef` and `loopDroppedOutRef` in sync via effects (mirror the
  existing `convHistoryRef` pattern).
- Pass `onPlaybackEnd` into `useSheetTTS({ onPlaybackEnd: handlePlaybackEnd })`.
  `handlePlaybackEnd` applies the §3.3 guard, then schedules
  `graceTimerRef = window.setTimeout(() => { startListening(); }, REARM_GRACE_MS)`.
- In `startListening`: on successful arm, if this arm came from the loop, start
  `deadAirTimerRef` (`DEAD_AIR_MS`). Simplest: always (re)start the dead-air timer
  when listening begins from an auto re-arm; clear it in the `onInterim` handler
  (add one line: `if (deadAirTimerRef.current) clear it`) and whenever listening
  stops. (A manual tap does not need the dead-air drop-out, but arming it there is
  harmless since a manual user is present; to stay minimal, gate the dead-air arm
  on a `armedByLoopRef` set true just before the loop calls `startListening`.)
- In `stopListening`: on empty/failed transcript from a loop-armed listen,
  `emptyStreakRef++`; if `>= MAX_EMPTY_STREAK` → `setLoopDroppedOut(true)`. On a
  successful (non-empty) turn, reset `emptyStreakRef = 0`. Clear `deadAirTimerRef`.
- Dead-air expiry callback: cancel recorder/live (reuse the cancel path), clear
  timers, `setLoopDroppedOut(true)` — no error, return to idle.
- In `handleMicTap`: barge-in per §3.6 (clear grace timer; `tts.stop()` if
  speaking; `setLoopDroppedOut(false)`; reset `emptyStreakRef`) before the
  existing start/stop branch.
- In the `!open` cleanup effect (and its unmount return): clear both timers,
  reset `emptyStreakRef`, `setLoopDroppedOut(false)`.
- No visual redesign. Optional: when `loopDroppedOut`, the idle mic label already
  reads "Tap to speak" — leave as is (calm). The speaker toggle already exists.

### 6.3 `frontend/src/components/CaddieSheet.handsfree.test.tsx` (NEW)

A dedicated deterministic file (see §7) that OWNS fake timers so its
`vi.useFakeTimers()` cannot leak into `CaddieSheet.session.test.tsx` or any other
jsdom suite. Mirrors the session file's mocks (framer-motion passthrough,
synchronous stream-buffer, deepgram/deepgram-live fakes) but uses a
**capturing** `useSheetTTS` mock that records the `onPlaybackEnd` callback and
exposes a `firePlaybackEnd()` helper.

### 6.4 `frontend/src/hooks/useSheetTTS.test.ts` (extend)

Add two cases: (a) `onPlaybackEnd` fires on a dispatched `ended` event; (b) it
does NOT fire on a dispatched `pause` event (barge-in / stop). Reuse the existing
`HTMLMediaElement.prototype.play/pause` stub setup.

**No backend files. No `models.py`. No migrations. No shared-type edits.**

---

## 7. Deterministic tests (control the scheduler — tasks/lessons.md 2026-07-07)

Rules applied: mock framer-motion to passthrough; drive TTS-end and transcription
via hand-controlled callbacks/deferreds, never real `setTimeout`; use
`vi.useFakeTimers()` **scoped and cleaned up** (`afterEach(() =>
{ vi.runOnlyPendingTimers(); vi.useRealTimers(); })`) in a dedicated file so no
dead stub bleeds into a later jsdom file. The `useSheetTTS` mock captures
`onPlaybackEnd` so tests fire playback-end by hand (no audio, no real timer).

Tests to add in `CaddieSheet.handsfree.test.tsx` (speaker pref forced ON):

1. **playback-end → re-arm.** Complete a turn (or fire the opening reco), call
   `firePlaybackEnd()`, `vi.advanceTimersByTime(REARM_GRACE_MS)` →
   `VoiceRecorder.start` called, phase `listening`.
2. **grace delay is respected.** After `firePlaybackEnd()`, advance
   `REARM_GRACE_MS - 1` → mic NOT started; advance the last ms → started.
3. **speaker OFF → no re-arm.** With `ttsEnabled` false, `firePlaybackEnd()` +
   advance → mic never arms (guard blocks). (Also asserts today's behavior.)
4. **dead-air drop-out.** Auto-arm, send no `onInterim`, advance `DEAD_AIR_MS` →
   recorder cancelled, `loopDroppedOut`, idle "Tap to speak" shown; a subsequent
   `firePlaybackEnd()` does NOT re-arm.
5. **empty-streak drop-out.** Two consecutive loop-armed listens ending empty
   (`onFinal("")` / UtteranceEnd with empty) → dropped out; assert no 3rd arm.
6. **barge-in stops playback.** With the mocked `isSpeaking` true and a grace
   timer pending, tap the mic → `tts.stop` called, grace timer cleared (advancing
   time starts no 2nd recorder), `startListening` runs.
7. **sheet-close cleanup.** With grace + dead-air timers pending, rerender with
   `open={false}` → `tts.stop` called, recorder cancelled; advancing timers
   starts nothing (no leak).
8. **happy multi-turn loop + streak reset.** turn1 answer → playback-end →
   re-arm → speak → answer → playback-end → re-arm; assert `emptyStreakRef`
   behavior via observable re-arms (loop keeps going on real turns).

Plus in `useSheetTTS.test.ts`: `ended` fires `onPlaybackEnd`; `pause` does not.

The existing `CaddieSheet.session.test.tsx` must stay green — its `useSheetTTS`
mock ignores the new optional arg (backward compatible); confirm the auto-opening
tests still pass (playback-end wiring is inert there because that file's TTS mock
never calls `onPlaybackEnd`).

---

## 8. The exact gates that verify it

```
cd frontend && npm run lint \
  && npx tsc --noEmit \
  && npm run build \
  && npx tsx voice-tests/runner.ts --smoke \
  && npx vitest run src/components/CaddieSheet.handsfree.test.tsx \
                    src/components/CaddieSheet.session.test.tsx \
                    src/hooks/useSheetTTS.test.ts
```

(Then the full `npm run test` before ship to confirm no cross-file fake-timer
leak.) **Backend: no change → no `ruff` needed** (run `cd backend && ruff check .`
only if any backend file is unexpectedly touched — it should not be).

Because this is a MAJOR, user-facing voice change: run `/code-review` and
`/security-review`, and have the `designer` agent confirm the calm feel
(no new chrome, drop-out is not alarming). Device-verify on TestFlight — the
playback→record iOS switch is only fully testable on a real device.

---

## 9. Ordered step sequence

1. `useSheetTTS.ts`: add `onPlaybackEnd` option + ref; split `ended`/`pause`
   listeners. Extend `useSheetTTS.test.ts`.
2. `CaddieSheet.tsx`: add constants, refs/state, `ttsEnabledRef` /
   `loopDroppedOutRef` mirrors.
3. Wire `handlePlaybackEnd` (guarded) → grace timer → `startListening`. Pass into
   `useSheetTTS`.
4. Add `armedByLoopRef` + dead-air timer (arm on loop listen, clear on
   `onInterim` / stop / close).
5. Add empty-streak counter + drop-out; reset on success.
6. Barge-in in `handleMicTap`.
7. Extend the `!open` cleanup effect + unmount return to clear timers / reset.
8. Write `CaddieSheet.handsfree.test.tsx` (§7).
9. Run the gates (§8); `/code-review`, `/security-review`, designer; device test.

---

## 10. Edge cases + risks

- **Speaker toggled off mid-listen:** the current auto-armed listen finishes; its
  reply is text-only (no TTS → no `ended` → no re-arm). Loop halts. Correct.
- **User taps "Ask follow-up" / "Clear" while a grace timer is pending:** those
  clear `voiceAnswer`; the grace timer still fires `startListening`, which is the
  desired hands-free behavior. If undesired, the guard `!isStreaming`/phase check
  and the fact that `startListening` resets answer state keeps it consistent.
- **Persona picker / mode switch to "Distance" mid-loop:** re-arm is gated on
  `mode === "voice"`; switching to Distance suspends re-arm. Switching back does
  not auto-arm (no pending playback) — golfer taps to resume. Calm.
- **Opening reco fails (`suppressError`):** no reply, no TTS, no re-arm — sheet
  stays idle exactly as today. The loop composes without special-casing.
- **Rapid open/close:** timers cleared on close + `openGenRef` invalidation; the
  new timers join that discipline. No zombie mic.
- **iOS route glitch on first auto-arm:** the 400ms grace + `ended`-only signal
  minimize it; if `getUserMedia` still fails, the existing `startListening`
  error path shows the calm mic-denied/idle state — degrades safely.
- **Risk: echo on speakerphone despite EC + grace.** Mitigated by timing; if
  field-observed, raise `REARM_GRACE_MS` (single constant) — no structural change.
- **Risk: fake-timer leak across jsdom files** (the named lessons.md failure) —
  mitigated by the dedicated file + `useRealTimers()` afterEach + `window.*`
  scoping.

## 11. Rollback / graceful degradation

The feature is **inert when the speaker is off** — which is the default (opt-in)
and today's behavior. So the safe rollback is intrinsic: if anything in the loop
misbehaves in the field, turning off the speaker toggle returns the sheet to the
exact current tap-per-turn experience, per-user, instantly. A code rollback is
equally clean: the change is two additive surfaces — remove the `onPlaybackEnd`
wire in `CaddieSheet` (the hook change is harmless/unused elsewhere) and the sheet
reverts. No data, no endpoint, no type migration to unwind.

---

### Critical files for implementation
- /Users/justinlee/projects/scorecard/frontend/src/components/CaddieSheet.tsx
- /Users/justinlee/projects/scorecard/frontend/src/hooks/useSheetTTS.ts
- /Users/justinlee/projects/scorecard/frontend/src/components/CaddieSheet.session.test.tsx
- /Users/justinlee/projects/scorecard/frontend/src/lib/voice/deepgram-live.ts
- /Users/justinlee/projects/scorecard/frontend/src/lib/voice/tts-pref.ts
