# Plan: Suppress the caddie's no-input "Didn't catch that" clarifier bubble

**Baseline (IMPORTANT):** branch from / rebase onto `integration/next` at or after commit
`6a68078` (`fix(caddie): drop STT priming-context echo…`). That commit adds
`frontend/src/lib/voice/priming-echo.ts` and the `isPrimingEcho()` call in `realtime.ts`
— this fix builds directly on both. All line references below to the
`input_audio_transcription.completed` handler assume the 6a68078 version (echo-drop block
at the top of that case).

## 1. Problem and scope

On a noisy course, server-VAD false-triggers commit a no-signal audio turn. The Realtime
model — following `INPUT_GROUNDING_RULE` in `backend/app/caddie/voice_prompts.py` (~line
59: canonical phrase `"Didn't catch that — say again?"`, freely paraphrased) — speaks a
clarifier. The triggering "user turn" produces either an empty transcript (skipped by the
`if (text)` gate in `realtime.ts`) or a priming-echo transcript (dropped by `isPrimingEcho()`
since 6a68078). Result: a **lone assistant bubble with no user turn above it** — the caddie
appears to talk to itself.

**Fix:** never render the clarifier **bubble** when the turn provably had no real user input.
Everything else — VAD, turn-detection thresholds, mic gain, `noiseSuppression`, audio-commit
timing, transcription config — is untouched (§5).

**Decision — bubble only, audio untouched.** This fix suppresses the visible chat bubble
ONLY. We do NOT send `response.cancel`. Justification: (a) the brief's primary concern is the
transcript reading broken — a lone bubble; (b) by the time the clarifier is classifiable
(input transcript resolved), its ~2s of audio is already buffered/playing — a cancel would
produce an audible mid-word truncation artifact, worse than the phrase itself; (c) hearing
"say again?" on a noisy course is arguably useful feedback that the caddie triggered — the
broken part is the *record* of it; (d) `response.cancel` on an already-completed response is a
data-channel error, adding a race for zero visual gain. **Residual (explicitly accepted): the
spoken clarifier still plays; only the transcript stays clean.**

## 2. Response↔input correlation mechanism

### 2.1 Definitions

**"Real user input for a turn"** = the turn's
`conversation.item.input_audio_transcription.completed` transcript is non-empty (after
`String(evt.transcript || '')`) **and** not an `isPrimingEcho()`. A typed message (`sendText`)
is always real. **"No-input"** = transcript empty/whitespace, or classified as priming echo.
**Unresolved** = the transcript event hasn't arrived yet (the ordering race: per
`realtime-ordering.ts` header comment, the input transcript lands AFTER the assistant deltas
it triggered).

### 2.2 New client state (private fields on `RealtimeCaddieClient`, `realtime.ts` ~line 215, next to `partials`/`order`)

```ts
// ── No-input clarifier suppression (specs/caddie-noise-clarification-reply-plan.md) ──
// Speech turns whose transcript hasn't been classified yet, oldest→newest.
// Consumed at response.created (most-recent wins, list cleared) to correlate
// a response with the input turn that triggered it.
private pendingSpeechItems: string[] = [];
// item_id → 'real' (non-empty, non-echo transcript) | 'noinput' (empty or
// priming echo). Written at input_audio_transcription.completed / .failed.
private inputClassByItem = new Map<string, 'real' | 'noinput'>();
// response_id → the speech item_id that triggered it. Absent = unconditional
// (typed text, opener, tool follow-up, unknown) — those are NEVER held.
private triggerItemByResponse = new Map<string, string>();
// Responses whose deltas are being HELD (not yet emitted) pending input
// classification; `timer` is the finalize-grace release timer.
private heldResponses = new Map<string, { finalized: boolean; timer: ReturnType<typeof setTimeout> | null }>();
// response.create messages WE sent (sendText / sendOpener / tool output)
// whose response.created hasn't arrived yet — those are unconditional.
private selfTriggeredResponses = 0;
```

All cleared in `cleanup()` (~line 526), timers cancelled — same lifecycle as
`partials.clear()` / `order.reset()`.

### 2.3 Event wiring (correlation)

- **`input_audio_buffer.speech_started`** (~line 618): after the existing
  `noteUserTurnStarted(...)`, `if (evt.item_id) this.pendingSpeechItems.push(String(evt.item_id))`.
  No `item_id` → push nothing (that turn's response becomes unconditional — err-keep).
- **`sendText` / `sendOpener` / `runTool`'s post-output `response.create`**: immediately
  before each `this.dc.send(JSON.stringify({ type: 'response.create' }))`, do
  `this.selfTriggeredResponses += 1; this.pendingSpeechItems = [];` (a client-triggered
  response must never be blamed on a stale speech item).
- **`response.created`** (~line 560): after the existing order-slot reservation:
  ```ts
  if (respId) {
    if (this.selfTriggeredResponses > 0) {
      this.selfTriggeredResponses -= 1;               // typed/opener/tool — unconditional
    } else {
      const trigger = this.pendingSpeechItems.pop();   // most recent speech turn
      this.pendingSpeechItems = [];                    // stale items must never leak forward
      if (trigger) this.triggerItemByResponse.set(String(respId), trigger);
    }
  }
  ```
  Consume-most-recent-and-clear (not FIFO) is deliberate: a stale never-answered speech item
  can then never be misattributed to a *later* response. The misattribution failure mode that
  remains (attributing to the newest item) biases toward `'real'`/keep — the mandated direction.
- **`conversation.item.input_audio_transcription.completed`** (~line 598, the 6a68078
  version): compute the classification ONCE, before the existing render logic:
  ```ts
  const real = Boolean(text) && !isPrimingEcho(text);
  if (itemId) {
    this.inputClassByItem.set(itemId, real ? 'real' : 'noinput');
    this.resolveHeldFor(itemId);   // §4 — releases or suppresses any held response
  }
  ```
  The existing behavior (echo-drop + telemetry, `if (text)` render gate,
  `orderForUserTranscript`) stays byte-identical below this.
- **`conversation.item.input_audio_transcription.failed`** (new case): classify `'real'`
  (err-keep — a failed transcription may have been a genuine garbled utterance) and
  `resolveHeldFor(itemId)`, so a held clarifier releases immediately instead of waiting out
  the grace timer.

### 2.4 The race, head-on

Both orders work with the same state machine:
- **Transcript resolves BEFORE the response** (fast STT / slow model): `inputClassByItem`
  already holds the class when `response.created` correlates the trigger; the very first delta
  reads it — `'real'` streams normally, `'noinput'`+clarifier-shaped holds and is suppressed
  at finalize. No held period at all in the `'real'` case.
- **Transcript resolves AFTER the response finalizes** (the documented common race):
  clarifier-shaped deltas are held (never emitted); at `done` the response enters
  `finalized: true` with a grace timer (`NOINPUT_RESOLVE_GRACE_MS = 2000`); when the
  transcript lands, `resolveHeldFor()` decides immediately (suppress if `'noinput'` +
  `isNoInputClarifier`, emit otherwise) and cancels the timer.
- **Transcript NEVER resolves**: the grace timer fires and emits the held final message.
  **Deadlock/strand proof:** a response can only be withheld while (a) live-streaming —
  bounded by the response itself; (b) finalized with a running 2s timer — bounded by the
  timer; every exit path (resolve-real, resolve-noinput-but-not-clarifier, timeout,
  `cleanup()`) emits or intentionally suppresses; there is no state that waits on an event
  without a timer. A response that is *cancelled* mid-hold (interruption; no `done` ever
  arrives) simply never surfaces — the identical outcome today's code gives a cancelled
  response's *final* message, and its map entries are reclaimed at `cleanup()`.

## 3. Suppression predicate — new pure module

### 3.1 `frontend/src/lib/voice/noinput-clarifier.ts` (mirrors `priming-echo.ts`: pure, no DOM/WebRTC, closed-vocabulary, header comment citing this spec)

```ts
export function isNoInputClarifier(responseText: string, hadRealUserInput: boolean): boolean
export function couldBecomeClarifier(partialText: string): boolean
export const NOINPUT_RESOLVE_GRACE_MS = 2000;
```

**Normalization** (same shape as `priming-echo.ts`'s `normalize()`): lowercase; curly→straight
apostrophes then strip apostrophes (`didn't`→`didnt`); em/en-dashes and hyphens → space; strip
remaining punctuation (`.,!?;:…"()`) → space; collapse whitespace; trim.

**`isNoInputClarifier(text, hadRealUserInput)`** — ALL must hold:
1. `hadRealUserInput === false` (the gate — a clarifier after real input is legitimate by
   definition);
2. normalized text non-empty;
3. contains **no digit** (`/\d/`);
4. `≤ MAX_CLARIFIER_WORDS = 14` words;
5. **every** word ∈ `CLARIFIER_VOCAB` — a closed set of ~30 ask-again function words: `i, im,
   sorry, didnt, dont, quite, catch, caught, get, got, hear, heard, that, say, it, could, can,
   you, please, again, what, was, missed, come, repeat, one, more, time, me, by, run, there,
   pardon, huh, just, a, the, bit`;
6. contains at least one **marker phrase**: `say again`, `say that again`, `say it again`,
   `catch that`, `come again`, `repeat that`, `repeat it`, `one more time`, `didnt hear`,
   `didnt get that`, `missed that`, `run that by me again`, `try that again` (matched against
   the normalized string).

**Why it cannot match a real answer:** any substantive caddie reply necessarily names a club,
number, distance, hazard, direction, or target ("driver", "152", "pin", "wind", "left") — none
are in `CLARIFIER_VOCAB` and digits are banned outright, so rule 5/3 fails before the marker is
even consulted. "Didn't catch the **wind** — it's calm" → `wind`, `calm`, `its` ∉ vocab →
kept. "Say again — the **driver** or the 3-**wood**?" → kept. "Take one more **club**" →
`club`, `take` ∉ vocab → kept. "Sorry about that." → no marker → kept. The recognizer is
paraphrase-robust across the model's observed variants ("Didn't quite catch that. Could you say
that again?") because it's content/vocabulary-based, not exact-string — the same design
argument as `priming-echo.ts`.

**`couldBecomeClarifier(partial)`** — the streaming hold test: empty → `true` (nothing to judge
yet); digit → `false`; > 14 words → `false`; every word except the last ∈ vocab, and the last
word ∈ vocab **or a prefix of a vocab word** (a delta can split a word). No marker required (it
may not have streamed yet). Any divergence flips it `false` permanently for that response (the
hold releases and never re-arms — see §4).

## 4. Exact wiring in `realtime.ts` (emit vs hold vs suppress)

Import `{ isNoInputClarifier, couldBecomeClarifier, NOINPUT_RESOLVE_GRACE_MS }` alongside the
existing `isPrimingEcho` import.

**Delta case** (~line 567, after the `!this.opened` gate and after `partials.set(id, updated)`):
```ts
const trigger = this.triggerItemByResponse.get(id);
const cls = trigger ? this.inputClassByItem.get(trigger) : undefined;
// Hold ONLY while the correlated speech turn is not yet proven real AND the
// text so far still reads as a pure ask-again clarifier. Everything else
// emits exactly as before. Status still goes 'speaking' — audio IS playing.
if (trigger !== undefined && cls !== 'real' && couldBecomeClarifier(updated.text)) {
  if (!this.heldResponses.has(id)) this.heldResponses.set(id, { finalized: false, timer: null });
} else {
  if (this.heldResponses.has(id)) this.releaseHeld(id, /*emitFinal*/ false); // diverged — flush partial
  this.events.onMessage?.(updated);
}
this.setStatus('speaking');
```
(Uncorrelated responses — `trigger === undefined` — take the else-branch on the first delta:
zero behavior change for openers, typed replies, tool follow-ups, and normal streaming.)

**Done case** (~line 584, inside the existing `if (existing)` block, before `onMessage(final)`):
```ts
const held = this.heldResponses.get(id);
if (held) {
  const trigger = this.triggerItemByResponse.get(id);
  const cls = trigger ? this.inputClassByItem.get(trigger) : undefined;
  if (cls === 'noinput' && isNoInputClarifier(existing.text, false)) { this.suppressHeld(id); … break; }
  if (cls === undefined) { held.finalized = true; arm NOINPUT_RESOLVE_GRACE_MS timer → releaseHeld(id, true); … break; }
  this.releaseHeld(id, false); // 'real', or noinput-but-not-a-clarifier — emit final below as today
}
```
`setStatus('connected')` runs on every path, as today. A second `done` for the same id (e.g.
`output_audio_transcript.done` then `response.done`) is inert: suppression deletes the
`partials` entry (existing `if (existing)` guard short-circuits) and the `finalized` flag
prevents re-arming the timer.

**Two small private helpers** (~10 lines total): `releaseHeld(id, emitFinal)` — clear timer,
delete held entry, emit the accumulated partial (and final if `emitFinal`); `suppressHeld(id)`
— clear timer, delete held entry, delete `partials` entry,
`voiceEvent('caddie', 'realtime_noinput_clarifier_suppressed', { detail: `len=${text.length}` })`
(length-only, mirroring `realtime_priming_echo_dropped`'s privacy posture). `resolveHeldFor(itemId)`
— scan `triggerItemByResponse` for held responses with that trigger and apply the done-case
decision (suppress if finalized+noinput+clarifier; release if real; if noinput but not yet
finalized, keep holding — the done case decides).

**No retract path.** Because held deltas are never emitted, `useRealtimeCaddie.ts`'s
upsert-only contract, `useCaddieLiveSession.ts`'s `upsert`, and `VoiceRoundSetupRealtime.tsx`
all work UNCHANGED — the suppression happens entirely inside the client before `onMessage`, so
every consumer benefits with zero contract change. The one behavior visible to consumers: a
clarifier-shaped bubble triggered by real speech appears when the input transcript resolves
(typically < 1s) instead of on the first delta — acceptable, because non-clarifier-shaped text
(every normal answer) diverges from the closed vocab within the first delta or two and streams
exactly as today.

## 5. Explicit confirmation — no recognition-sensitivity changes

This plan changes **nothing** about server VAD, `turn_detection` thresholds, silence
durations, mic constraints (`echoCancellation`/`noiseSuppression`/`autoGainControl` in
`realtime.ts` stay byte-identical), input gain, `noise_reduction`, audio-commit timing, or the
backend session mint (`backend/app/caddie/*` untouched, including `voice_prompts.py` — the
INPUT_GROUNDING_RULE persona behavior is *kept*; we only stop rendering its output when no
input existed). The fix is achievable purely client-side — the "impossible without a VAD
change" escape hatch is **not** needed.

## 6. Test plan

**New `frontend/src/lib/voice/noinput-clarifier.test.ts`** (mirrors `priming-echo.test.ts`:
table-driven, exhaustive):
- Suppress-eligible (`hadRealUserInput=false`): canonical `"Didn't catch that — say again?"`;
  paraphrases `"Didn't quite catch that. Could you say that again?"`, `"Sorry, come again?"`,
  `"Say that one more time?"`, `"Sorry — I missed that. Say it again."`, curly-apostrophe
  variants.
- Never suppressed: canonical string with `hadRealUserInput=true` (the gate); `"You've got
  152 to the pin — smooth 8-iron."`; `"Driver. Favor the left side."`; `"Didn't catch the
  wind — it's calm out there."`; `"Say again — the driver or the 3-wood?"`; `"Take one more
  club into this wind."`; `"Sorry about that."` (no marker); a 15+-word ramble containing a
  marker (length cap); empty string; digits.
- `couldBecomeClarifier` streaming: `""`→true, `"Didn't"`→true, `"Didn't quite ca"`→true
  (prefix), `"You've"`→false, full canonical→true.

**New `frontend/src/lib/voice/realtime-noinput.test.ts`** (jsdom; duplicate the minimal
`FakePeerConnection`/`FakeDataChannel` plumbing from `realtime-warm.test.ts`, same mock of
`@/lib/caddie/api`; `vi.useFakeTimers` where the grace timer is exercised). Scenarios, each
driven via `dataChannel.emit(...)`:
1. Noise turn, transcript after done: `speech_started(item-A)` → `response.created(resp-1)` →
   clarifier deltas → `done` → `transcription.completed(item-A, '')` ⇒ `onMessage` NEVER called
   with an assistant message; suppression telemetry fired.
2. Same but transcript (`''`) arrives before `done` ⇒ suppressed.
3. Priming-echo transcript (a real signature string, e.g. containing "player's clubs") ⇒
   suppressed (exercises the `isPrimingEcho` integration for real).
4. Real-but-garbled turn: `transcription.completed(item-A, 'scars of god')` ⇒ clarifier
   EMITTED (partial flush + final) — the load-bearing never-swallow test.
5. Normal answer: deltas `"You've got 152…"` stream as partials immediately, before the
   transcript resolves.
6. Typed text: `sendText('what club')` → `response.created` → even a clarifier-shaped reply is
   emitted (unconditional).
7. Grace timeout: `done`, transcript never arrives, advance 2000ms ⇒ emitted.
8. `transcription.failed` ⇒ released/emitted.
9. Two rapid noise turns ⇒ both suppressed; then a real turn ⇒ user bubble + answer emitted
   with correct ordering.
10. Withheld-mic pre-open: events dropped as before (`!this.opened` unchanged).

**Changed/new files (complete list):** `frontend/src/lib/voice/noinput-clarifier.ts` (new),
`frontend/src/lib/voice/noinput-clarifier.test.ts` (new),
`frontend/src/lib/voice/realtime-noinput.test.ts` (new),
`frontend/src/lib/voice/realtime.ts` (modified),
`specs/caddie-noise-clarification-reply-plan.md` (this plan). Nothing else.

## 7. Shared types

`RealtimeMessage`, `RealtimeCaddieEvents`, and the `onMessage` contract are **unchanged**
(verified: `RealtimeMessage` lives only in `realtime.ts`, not `frontend/src/lib/types.ts` — no
`grep` hit there). No `backend/app/models.py` / `types.ts` sync needed. No backend changes.

## 8. Gates

`cd frontend && npm run lint` · `npx tsc --noEmit` · `npx vitest run` · `npm run build` ·
`npx tsx voice-tests/runner.ts --smoke`. Backend untouched ⇒ no `ruff` run required.

## 9. Edge cases & risks

| Case | Handling |
|---|---|
| Transcript before `response.created` | Class already in `inputClassByItem`; first delta reads it — no hold for `'real'`. |
| Transcript never arrives | 2s grace timer after `done` → emit (err-keep). No deadlock (§2.4 proof). |
| Multiple rapid noise turns | Each `response.created` consumes the most recent pending item and clears the list; each suppressed independently; identity-keyed ordering (`realtime-ordering.ts`) already tolerates unconsumed slots and order-key gaps. |
| Real turn immediately after a noise turn | Consume-most-recent + clear biases misattribution toward the *newer* (more likely real) item ⇒ err-keep. |
| Typed messages (no `speech_started`) | `selfTriggeredResponses` counter + clearing `pendingSpeechItems` in `sendText`/`sendOpener`/`runTool` ⇒ unconditional, never held. |
| Withheld-mic warm path | `!this.opened` drops deltas before any new logic — unchanged, existing warm tests still pass. |
| `speech_started` without `item_id` | Not tracked ⇒ response unconditional ⇒ err-keep. |
| Duplicate `done` events | `partials` deletion + `finalized` flag make the second inert. |
| Response cancelled mid-hold (interruption) | Held clarifier never surfaces (correct — it was an interrupted noise reply); state reclaimed at `cleanup()`. |
| Late transcript after grace-timeout emit | Bubble already shown; no retract by design. Requires transcription > 2s late on a ~2s response — rare; accepted residual, keeps the hook contract untouched. |
| Spoken audio | The clarifier is still audible (deliberate, §1 decision). |

## Why this can't swallow a legit clarifier

A legitimate clarifier is, by definition, a reply to a turn where the golfer actually said
something. If they did, the ASR transcript is non-empty and non-echo, so the turn classifies
`'real'`, `hadRealUserInput` is true, and the predicate's first gate returns false — the held
bubble is released the instant the transcript resolves (or was never held at all if the
transcript won the race). If the transcript *fails* or *never arrives*, we classify `'real'` /
time out to emit — both err-keep. If the golfer spoke but ASR produced an empty string, there
is no user bubble either — so a rendered clarifier would be exactly the lone-bubble breakage
this fix targets; suppressing its *bubble* is correct, and the golfer still *hears* "say
again?" because audio is untouched. Every substantive answer is protected twice over: the
closed vocabulary + digit ban + marker requirement make it unrecognizable as a clarifier
regardless of input state, and any response following a real user bubble (spoken or typed) is
gated off before text is even examined.
