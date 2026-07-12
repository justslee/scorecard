# Caddie Context Leak — STT Priming Prompt Rendered as a User Turn (plan)

`specs/caddie-context-leak-plan.md` · Owner-reported, v1.1.3, LIVE-mode on-course caddie · TOP PRIORITY correctness bug

## 1. Confirmed injection path (verified against source)

The priming string is built and injected exactly as designed — as a transcriber hint, never a conversation item:

- **Composition** — `backend/app/caddie/keyterms.py`
  - `GOLF_KEYTERMS` tuple (24 terms) at `:23-48`, exact mirror of `frontend/src/lib/voice/keyterms.ts:11-36` (pinned by `backend/tests/test_transcription_prompt.py::test_keyterms_pinned_to_frontend_list`).
  - `golf_baseline_prompt()` at `:66-69` → `"Golf vocabulary: " + ", ".join(GOLF_KEYTERMS) + "."`
  - `build_transcription_prompt(session)` at `:72-112` → `"Player's clubs: …"` (`:100`, values from `CLUB_DISPLAY_NAMES`, `backend/app/caddie/club_selection.py:38-53` — `Driver, 3 Wood, 5 Wood, Hybrid, 4 Iron…9 Iron, PW, GW, SW, LW`), `"This hole: …"` (`:108`, values from `_HAZARD_TERMS` `:53-58` — `water hazard, bunker, out of bounds, trees`; NOT deduped within the list, hence the owner's `"trees, trees, trees, bunker, bunker, trees, trees"`), then the golf-vocab tail.
- **Injection** — `backend/app/routes/realtime.py:129` computes it; `:142-147` passes `transcription_prompt=` into `mint_ephemeral_session` (`backend/app/services/realtime_relay.py:152-169`), which threads it via `build_session_payload` into `session.audio.input.transcription.prompt` (`realtime_relay.py:111-119`). It is never a `conversation.item.create` and never merged into `session.instructions` (asserted by `test_injection_confined_to_transcription_field`). The setup route (`routes/realtime.py:86-90`) injects `golf_baseline_prompt()` the same way.
- Root cause confirmed: the leak is **downstream, in the transcriber**. When server VAD false-triggers on silence/ambient noise, `gpt-4o-transcribe` hallucinates its own `transcription.prompt` back as the transcript — either verbatim (variant 1) or paraphrased (variant 2, a known gpt-4o-transcribe behavior). That transcript arrives on the data channel as `conversation.item.input_audio_transcription.completed`.

## 2. Why it leaks (both symptoms, both variants)

- **Rendered**: `frontend/src/lib/voice/realtime.ts:598-617` — the `input_audio_transcription.completed` handler emits ANY non-empty `evt.transcript` as `{ role: 'user', … }` via `onMessage`. `CaddieSheet.tsx:1818-1839` styles `m.role === "user"` as the dark (`T.ink`), right-aligned (`flex-end`) bubble. The client has no notion that a transcript could be the transcriber echoing its own prompt.
- **"Answered"**: the "Didn't catch that — say again?" reply is NOT the model reading the leaked transcript (input transcription is a side-channel; the Realtime model hears audio directly). The same VAD false-trigger commits a noise-audio turn; the model independently responds to near-silence with a clarification. The adjacency makes it look like the caddie answered the leaked text. Fixing the bubble removes the visible leak; the phantom reply is a separate, pre-existing behavior (see §6).
- **Variant 2 (paraphrase)**: the transcriber rewords its prompt ("The player's clubs for this hole include a GW, LW…"), so exact-string matching against the minted prompt is insufficient — the classifier must be content-based.

## 3. The fix — client-side priming-echo classifier (load-bearing)

### 3.1 New pure module: `frontend/src/lib/voice/priming-echo.ts`

Exports `isPrimingEcho(transcript: string): boolean`. Pure, no WebRTC/DOM, imports `GOLF_KEYTERMS` from `./keyterms` (the frontend mirror stays the single source for the term list). Small local closed sets, with mirror comments pointing at `keyterms.py`:

- `HAZARD_TERMS = ['water hazard', 'bunker', 'out of bounds', 'trees']` (mirror of `_HAZARD_TERMS` values, `keyterms.py:53-58`).

**Normalization** (applied to the transcript once): lowercase; curly apostrophes → straight; hyphens → spaces (so `3-wood` ≡ `3 wood`); collapse whitespace.

**Decision rule — drop iff A ∨ B ∨ C, conservative by construction:**

- **A. Signature-label match** (catches BOTH observed variants): normalized transcript matches `/\bplayer'?s clubs\b/` OR `/\bgolf vocabulary\b/`. Justification: these noun phrases exist only in the prompt. Real golfers say "my clubs" / "what club", never "the player's clubs"; nobody says "golf vocabulary" mid-round. Both owner screenshots — raw and paraphrase — contain both phrases (the paraphrase kept "The player's clubs…" and "Golf vocabulary related to this hole includes…"). This branch alone fixes the reported bug.
- **B. Vocabulary-enumeration density** (catches label-free paraphrases of the tail): count DISTINCT `GOLF_KEYTERMS` present with word-boundary matching; match multi-word terms first and mask matched spans so `double bogey` doesn't also count `bogey`. **Drop iff ≥ 10 distinct terms.** Justification: the prompt tail enumerates all 24 terms; any paraphrase that survives as an enumeration retains most of them (the terms ARE the content — a paraphrase can reword connectives but not the vocabulary itself). The worst realistic user turn is a contrived compound like "should I hit driver or 3-wood, or lay up with the hybrid — don't want a double bogey, need to carry the fairway bunker and stay pin high" = 7 distinct terms (driver, 3-wood, hybrid, layup¹, double bogey, carry, fairway, pin high — ¹only if "lay up" normalizes to "layup", which we do NOT do; so 6-7). Threshold 10 leaves ≥3 terms of margin on both sides. (¹ "bunker" is not in `GOLF_KEYTERMS`.)
- **C. Hazard-list echo** (defensive, for a hypothetical unlabeled echo of only the "This hole:" sentence, which branch B can't see because hazard words aren't keyterms): after stripping an optional leading `this hole` (+ optional colon), split on commas / "and" / periods; drop iff there are **≥ 3 segments and every non-empty segment ∈ HAZARD_TERMS**. No human utterance is solely `trees, trees, trees, bunker, bunker` — the prompt's non-deduped repetition is itself the tell. A one- or two-word real answer ("bunker", "trees and water hazard" answering a caddie question) is never dropped.

Empty/whitespace transcript → `false` (the existing `if (text)` guard at `realtime.ts:606` already drops empties).

**False-positive / false-negative tradeoff, stated explicitly:**
- FP (dropping a real turn) is the catastrophic direction — a swallowed user question in a voice-first product. Branch A phrases are prompt-only artifacts; branch B's threshold (10) is ~1.4× the most contrived real turn we could construct and ~2.5× a plausible dense turn; branch C requires the transcript to contain *nothing but* hazard nouns, ≥3 of them. All four owner-representative turns ("what club for this bunker?", "I hit driver 250", "gimme range?", "how far to carry the water") contain 1-2 keyterms and no signature phrase — nowhere near any branch.
- FN (rendering a residual echo) is the safe direction and we accept it: an echo that lost BOTH labels AND retains <10 keyterms AND isn't a pure hazard list is a short garbled fragment indistinguishable from real speech; rendering it is the correct conservative default. Residual FNs are observable via the telemetry breadcrumb (below) if they recur.

### 3.2 Wiring in `realtime.ts`

In the `conversation.item.input_audio_transcription.completed` case (`realtime.ts:598-617`), after the `!this.opened` gate and text extraction, before `onMessage` / `orderForUserTranscript`:

```ts
if (text && isPrimingEcho(text)) {
  voiceEvent('caddie', 'realtime_priming_echo_dropped', { detail: `len=${text.length}` });
  break;
}
```

- Telemetry follows the existing `realtime_dc_error` breadcrumb precedent (`realtime.ts:648-650`): length only, never the transcript body — signal without noise, lets us see field frequency.
- **Ordering safety**: dropping before `orderForUserTranscript(itemId)` leaves the slot reserved at `speech_started` unconsumed — explicitly safe by design: `realtime-ordering.ts:41-47` documents that reservations are identity-keyed (not FIFO-shifted) precisely so an unconsumed phantom-turn slot "is simply never looked up" and cannot desync later turns. This is the same shape as the existing empty-transcript drop.
- The setup-mode surface (VoiceRoundSetupRealtime) shares `RealtimeCaddieClient`, so the `"Golf vocabulary: …"`-only echo from the setup mint (`routes/realtime.py:90`) is covered by the same filter (branch A).

### 3.3 Belt-and-suspenders rationale

The prompt is already in the correct non-visible channel (`transcription.prompt`) and doing its biasing job — there is nothing further to "relocate". The transcriber's self-echo on noise is an upstream model behavior we don't control; the client filter is the only place that can guarantee the invariant *"priming text never renders and never becomes a user turn"*, and it holds regardless of prompt content, hole, mint, or future backend prompt edits (closed-vocabulary detection, not exact-string matching against the minted prompt).

## 4. Backend assessment — keep the prompt; one optional 3-line rider

- **Keep the prompt as-is in substance.** The owner wants the biasing (it fixed "give me"/"bath page"-class errors per `keyterms.ts:1-9`); trimming the list would trade confirmed accuracy value for an unquantified reduction in an echo the client filter now guarantees against. No trim.
- **Optional, minimal, reversible rider (recommended)**: dedupe hazard terms *within* the `"This hole:"` sentence in `keyterms.py` (order-preserving; today each hazard instance emits its term, producing `trees, trees, trees, bunker, bunker, trees, trees`). Repeated identical words add zero biasing value, lengthen the prompt, and make any residual echo longer/stranger. ~3 lines in `build_transcription_prompt`; existing tests unaffected (`test_prompt_length_capped` uses one hazard of each type); add one assertion that duplicate hazards collapse. Keeps the `keyterms.py` ↔ `keyterms.ts` GOLF_KEYTERMS mirror untouched. If any doubt, cut this rider — the client filter is the guarantee.

## 5. Regression tests (exact)

1. **`frontend/src/lib/voice/priming-echo.test.ts`** (vitest, pure — no WebRTC):
   - DROPPED: the raw owner string verbatim ("Player's clubs: GW, LW, PW, SW, Driver. This hole: trees, trees, trees, bunker, bunker, trees, trees. Golf vocabulary: birdie, … pin high."); the natural-paraphrase owner string; a truncated paraphrase ending "…birdie, bogey" (branch A); a label-free full-vocabulary enumeration (branch B); `"This hole: trees, trees, trees, bunker, bunker."` (branch C); the golf-vocab-only setup echo `golf_baseline_prompt()` shape.
   - NOT dropped: "what club for this bunker?", "I hit driver 250", "gimme range?", "how far to carry the water", plus adversarial dense turns: "should I hit driver or 3-wood, or lay up with the hybrid — don't want a double bogey, need to carry the fairway bunker and stay pin high", "that's a double bogey, no gimme", "trees and bunker" (2-segment hazard answer), "bunker", empty string.
2. **Handler-level test** — the seam already exists: `frontend/src/lib/voice/realtime-warm.test.ts` drives `RealtimeCaddieClient` through a `FakePeerConnection`/`dataChannel.emit` mock (see its transcript-gating suite at `:208-270`). Add (there, or in a sibling file reusing the harness): after `start()` + `attachMic()`, emit `conversation.item.input_audio_transcription.completed` with the raw priming transcript → `onMessage` NOT called; then emit a real transcript → delivered as `role:'user'` with correct ordering (proves the filter is wired and doesn't break the normal path).
3. **Backend**: only if the §4 rider ships — extend `backend/tests/test_transcription_prompt.py` with a duplicate-hazard dedupe assertion; the mirror pin `test_keyterms_pinned_to_frontend_list` must keep passing (this test file is no-network/no-DB by design — runnable locally; DB-backed tests remain CI-only).

## 6. Edge cases & residual risk

- **Phantom "Didn't catch that" reply**: OUT OF SCOPE and residual. It's the model answering a committed noise turn, already mitigated by `noise_reduction: near_field` and `server_vad threshold 0.5` (`realtime_relay.py:96-101,133`); the `OPENAI_REALTIME_VAD=semantic_vad` env lever (`realtime_relay.py:33`) exists as a separate, owner-gated follow-up. Do not touch VAD thresholds here (`realtime_relay.py:84-86` explicitly says do not adjust).
- **Reconnect / warm pool / mid-session hole change**: `transcription.prompt` is fixed at mint time (`routes/realtime.py:129`); the mid-session `sendContext` hole re-anchor (`realtime.ts:400-413`) does not update it, and a warm-pool session may carry a previous hole's hazards until re-mint. Irrelevant to the classifier: it matches closed vocabulary, not the specific minted string, so it is correct across mints, holes, and reconnects.
- **Misclassification paths**: the only conceivable FP is a user literally reciting ≥10 vocabulary terms or saying "golf vocabulary"/"the player's clubs" — accepted as vanishingly unlikely and covered by adversarial tests. FNs render (safe) and are counted by `realtime_priming_echo_dropped`'s absence + owner reports.
- **Typed-text path** (`sendText`, `realtime.ts:385-393`) is untouched — user-typed lines must never be filtered.
- **NORTHSTAR/CLAUDE.md fit**: removes fake user turns from the transcript (calm, honest states); TS strict pure module matching neighboring `keyterms.ts`/`realtime-ordering.ts` style; mirror-sync comments maintained.

## 7. Gates

- Frontend: `cd frontend && npm run lint && npx tsc --noEmit && npm run build && npx tsx voice-tests/runner.ts --smoke`, plus `npx vitest run src/lib/voice/priming-echo.test.ts src/lib/voice/realtime-warm.test.ts` (or full `npm test`).
- Backend (only if the §4 rider ships): `cd backend && ruff check .` and `pytest tests/test_transcription_prompt.py` (no DB/network needed for this file).
