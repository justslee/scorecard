# Plan: caddie-remove-seeded-question — the caddie opens the conversation itself

**Looper item:** caddie-remove-seeded-question · frontend-only · low risk (SILENT bundle accumulation)
**NORTHSTAR fit:** voice-first, calm, yardage-book. The caddie greets like a real caddie walking up —
brief acknowledgement of where you are, an open offer — never a fabricated player line. No SaaS chirp,
no exclamation points.

Authored by the Fable Plan agent (2026-07-10), trace-verified. Co-Authored-By: Claude Fable 5.

## 1. Authorship/role decision (the crux)

**Decision: the opener becomes an assistant-authored turn on both paths. No user-role item, no user
bubble, no user history entry is ever produced for the opener.**

- **The builder returns the caddie's greeting CONTENT** (the human words), renamed
  `buildOpeningGreetingText(shot)`. Single source of truth for the human-facing copy.
- **Classic path renders/speaks the greeting deterministically** — no network turn at all. The greeting
  is seeded directly as `{role:"assistant"}` history + `setVoiceAnswer` + `tts.speak`. Rationale: the
  classic opener's only job is to invite the player to talk; paying a full LLM round-trip (plus the
  3-tier fallback ladder and its failure modes) to generate an invitation is waste, and the deterministic
  string is exactly on-voice. This also *deletes* the fabricated user turn from transcript, request, and
  history in one move.
- **Live path must be spoken by the Realtime model** (its audio is the only voice in live mode), so the
  greeting content is wrapped — inside the same module — in a fixed instruction template
  `buildOpeningGreetingInstruction(shot)` and injected as a **system-role conversation item followed by
  `response.create`** via a new client method `sendOpener()`. The model voices a caddie-authored opener;
  its reply arrives through the normal server transcript events and therefore renders as an **assistant**
  bubble. No local `onMessage` emission, so no user bubble. System role (not per-response
  `response.instructions` override) keeps the session's persona instructions intact for that response.
- **Single source of truth reconciled:** the greeting words live in exactly one function
  (`buildOpeningGreetingText`); the live wrapper calls it and adds only fixed framing. Classic renders the
  words verbatim; live asks the model to say roughly those words in its own voice.

`buildHoleContextText` and `sendContext` are untouched. The connect ordering invariant becomes:
`sendContext` (silent hole anchor) fires strictly before `sendOpener`.

## 2. Exact new opener copy

In `frontend/src/lib/caddie/opening-turn.ts`:

```ts
export function buildOpeningGreetingText(shot: OpeningShot): string {
  return shot.fromTee
    ? `You're on the tee — about ${shot.distanceYards} to the pin. Want a read on the tee shot?`
    : `About ${shot.distanceYards} to the pin from here. Want a read on the shot?`;
}

export function buildOpeningGreetingInstruction(shot: OpeningShot): string {
  return (
    `Open the conversation now with one short greeting in your own voice, roughly: ` +
    `"${buildOpeningGreetingText(shot)}" The player has not said anything yet — ` +
    `do not answer a question they never asked. After the greeting, stop and listen.`
  );
}
```

Pure, deterministic, no DOM/network. `OpeningShot` unchanged. Update the file header comment (it currently
documents the "opening-turn question"; it now documents the caddie-authored greeting + the live instruction
wrapper). Delete `buildOpeningTurnText` entirely (rename, not alias — both consumers move in the same commit).

## 3. Files and edits

### 3.1 `frontend/src/lib/caddie/opening-turn.ts`
As above. `buildHoleContextText` / `HoleContext`: untouched.

### 3.2 `frontend/src/components/CaddieSheet.tsx` (classic auto-opening effect, ~L808-822)
Replace the tail of the async IIFE (all guards above it stay byte-identical — the `openingFiredRef`
strict-mode guard, `openingGenRef` gen check, the pristine-idle re-check at L817, and the
`if (!shot) return` honest-idle):

```ts
// OLD
const q = buildOpeningTurnText(shot);
setTranscript(q);
await askCaddie(q, { suppressError: true });

// NEW — caddie-authored greeting; no network turn, no fabricated user line
const greeting = buildOpeningGreetingText(shot);
const seeded: VoiceCaddieMessage[] = [{ role: "assistant", content: greeting }];
convHistoryRef.current = seeded;   // next askCaddie sees it immediately (ref-mirror pattern, matches askCaddie)
onUpdateConvHistory(seeded);
setVoiceAnswer(greeting);          // renders the caddie answer card (phase → "answered"); transcript stays "" so no quoted user line
tts.speak(greeting, personaId);    // spoken once; onPlaybackEnd re-arms the hands-free loop exactly as after any reply
```

- Update the import (L60) to `buildOpeningGreetingText`.
- Update the effect's doc comment (L775-783): it no longer "fires the SAME askCaddie path with a default
  question" — it seeds a deterministic caddie greeting.
- Effect deps stay `[open, sessionActive, roundId, convHistory.length, liveActive]` with the existing
  eslint-disable; `personaId`/`onUpdateConvHistory`/`tts.speak` are read from the closure exactly as
  `askCaddie` already does, and `openingFiredRef` prevents refire on dep churn.
- Why this plugs in cleanly: `phase` derivation puts `voiceAnswer` before `isThinking`, so the greeting
  renders as the "answered" caddie card immediately; the follow-up CTA and mic mount because
  `isStreaming`/`isThinking` are never set; `handlePlaybackEnd` → loop re-arm opens the mic after the
  greeting is spoken — literally "invites the player to talk". The next real user turn goes through
  `askCaddie` unchanged, reading `convHistoryRef.current = [assistant greeting]` and appending
  `{user, assistant}`; `VoiceBody`'s `convHistory.slice(0, -2)` then shows the greeting as a prior caddie
  bubble.
- Honest-idle fallbacks hold: no-session / no `resolveOpeningShot` / null GPS / user-turn-during-GPS-await
  guards are all upstream of the change and untouched. `suppressError` becomes moot (nothing can fail — no
  network), which *removes* a failure mode.

### 3.3 `frontend/src/lib/voice/realtime.ts` (new method after `sendContext`, ~L413)

```ts
/** Inject the caddie-authored opening greeting: a system-role instruction item
 *  plus response.create so the model SPEAKS the opener in its own voice.
 *  Unlike sendText: role is system (never fabricates a player turn) and NO
 *  local onMessage is emitted — the assistant bubble comes from the model's
 *  own transcript events. Unlike sendContext: it does trigger a response. */
sendOpener(text: string): void {
  this.idle.touch();
  if (this.dc?.readyState === 'open') {
    this.dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    }));
    this.dc.send(JSON.stringify({ type: 'response.create' }));
  }
}
```

A separate method (not a `sendContext` option) so the existing sendContext call-count tests stay valid
unmodified. `sendText` is untouched — it still serves real typed input.

### 3.4 `frontend/src/hooks/useCaddieLiveSession.ts` (~L283)
```ts
// OLD: clientRef.current?.sendText(buildOpeningTurnText(shot));
clientRef.current?.sendOpener(buildOpeningGreetingInstruction(shot));
```
Update the import (L60) and `maybeFireOpeningTurn`'s doc comment. Everything else (openedTurnRef once-only,
mic+connect gating, `voiceEvent("caddie","opening_shot")` breadcrumb, no-re-greet on reconnect/resume) is
mechanism-agnostic and unchanged. `anchorHole()` still runs on connect before `maybeFireOpeningTurn` —
ordering invariant preserved by construction.

## 4. Tests to re-point (all deliberate spec changes unless noted)

### 4.1 `frontend/src/lib/caddie/opening-turn.test.ts`
- Replace the `buildOpeningTurnText` describe (L36-45) with `buildOpeningGreetingText`: exact new tee and
  non-tee strings; plus an authorship lock: output never contains first-person-as-player phrasing (`"I'm"`),
  and contains the distance.
- Add `buildOpeningGreetingInstruction` tests: contains the greeting verbatim (single-source-of-truth lock),
  instructs "your own voice", states the player has not spoken, and differs between tee/non-tee only via the
  embedded greeting.
- `buildHoleContextText` describe: untouched.

### 4.2 `frontend/src/components/CaddieSheet.realtime.test.tsx`
- Fake client (L158-197): add `sendOpener = vi.fn();`.
- L329 opening test → `sendOpener` called once with a string containing the greeting (e.g.
  `/about 231 to the pin/i` — use whatever distance the resolveOpeningShot mock returns) **and**
  `expect(client.sendText).not.toHaveBeenCalled()` (the authorship assertion — no fabricated user turn).
  Honest-idle half unchanged.
- L344 ordering test → `sendContext` invocationCallOrder strictly before `sendOpener`'s; still exactly one
  `sendContext` on connect. Intent (anchor-before-opener) preserved, mechanism re-pointed.
- sendContext counting tests (L371-405): unchanged (why `sendOpener` is a new method).
- honest-idle (L407): `sendOpener` (and `sendText`) not called.
- No-re-greet suite (L569, L610-611, L726, L747, L819-820, L845-871, L1043): mechanical `sendText` →
  `sendOpener` swaps; intent identical.

### 4.3 `frontend/src/components/CaddieSheet.session.test.tsx` (describe at L645)
- **(a)** rewrite: no `sessionVoiceStream`/`talkToCaddie*` call at all (assert all three mocks uncalled);
  greeting rendered in the caddie card; `onUpdateConvHistory` called with exactly
  `[{ role: "assistant", content: <greeting> }]` — **no user entry** (the core defect lock); `ttsSpeakSpy`
  once with `(greeting, "strategist")`; lifecycle completes ("Ask follow-up" + "Start recording" mount).
- **(a-tee)** rewrite: fromTee greeting rendered (`/You're on the tee — about … to the pin/`), no
  `/from here/`; no network mocks called; history has no user role. The old "transparency: user bubble
  renders the wording" assertion is deleted — that transparency was the bug.
- **(b), (b2), (c-ii)**: intent unchanged; (b2)'s `queryByText(/on the tee/)` null assertion still guards
  the new copy (adjust regex to the new phrasing as needed).
- **(c-i), (c2 StrictMode)**: re-key the once-only assertions from `sessionVoiceStreamMock` counts to
  `ttsSpeakSpy` count 1 / greeting rendered once / `resolveOpeningShot` count 1.
- **(d)** suppressError-failure: obsolete (no network to fail). Replace with a stronger claim: the opener
  makes zero backend calls even with `sessionVoiceStreamMock` primed to reject.
- **(f)** GPS-pending stomp guard: keep; re-point final assertions — greeting never rendered,
  `onUpdateConvHistory` never called with a greeting seed, user's turn intact. The pristine-idle guard
  still protects this.

### 4.4 `frontend/src/components/CaddieSheet.handsfree.test.tsx` test (9), L576
Re-point: drop the `sessionVoiceStreamMock` priming; the persisted "opening answer" is now the deterministic
greeting. `ttsSpeakSpy` once → `firePlaybackEnd` → loop re-arms → greeting still on screen. Intent (answer
survives re-arm) unchanged — a genuine regression lock that must keep passing.

Unrelated hits verified as untouched: `transport.test.ts` L153 (generic fixture), `yardage/Voice.tsx` L285
(hint chips), backend tests (generic transcripts).

## 5. Edge cases & risks
- **Double-fire guards**: `openingFiredRef` (strict-mode-safe, set pre-await) and `openedTurnRef` (live)
  untouched; the classic `convHistory.length > 0` reopen guard now trips on the seeded `[assistant]`
  history — same no-re-greet-on-reopen behavior as before (old code seeded 2 messages).
- **No user artifact anywhere**: classic never calls `setTranscript`/`askCaddie` for the opener; live sends
  role `system` and emits no local bubble. The only remaining `role:'user'` producers are real player actions.
- **Live double-response**: `sendOpener` fires once behind `openedTurnRef`, after connect, before any player
  speech — no competing `response.create`.
- **TTS**: greeting spoken via the existing single-call `tts.speak`; sheet-close `tts.stop()` still cancels
  mid-greeting; TTS-muted golfers still see the card.
- **Session memory**: the greeting is client-only. Accepted: the greeting carries zero strategic content,
  and the stateless fallback still sends it via `conversation_history`. Backend renders history as a text
  block (`voice_prompts.py` `_conversation_history_block`) with no role-alternation requirement, so an
  assistant-first history is safe.
- **Model compliance (live)**: the model paraphrases rather than recites — acceptable ("roughly"); the
  instruction pins content (distance, tee) and brevity.
- **Copy drift**: prevented by the instruction-contains-greeting-verbatim unit test.

## 6. Shared-types check
No wire-shape changes: `VoiceCaddieMessage` (`frontend/src/lib/caddie/types.ts`) already covers
`role:"assistant"`; backend session/prompts unchanged; no `types.ts` ↔ `models.py` edits. None needed.

## 7. Gates
```
cd frontend
npm run lint
npx tsc --noEmit
npx vitest run src/lib/caddie/opening-turn.test.ts src/components/CaddieSheet.realtime.test.tsx src/components/CaddieSheet.session.test.tsx src/components/CaddieSheet.handsfree.test.tsx
npx tsx voice-tests/runner.ts --smoke
```
