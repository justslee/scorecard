# Spec: voice-low-confidence-ux (P33)

**Classification: NOTICEABLE** — in-round voice scoring is a new user-visible path;
the amber confidence warning on round setup is a visible change to an existing screen.

---

## Problem

The voice pipeline can parse low-confidence transcripts and silently apply a wrong
guess. A mis-scored hole or a wrong course name requires manual correction — the
opposite of effortless. NORTHSTAR demands the app feel personal and calm; a wrong
silent guess breaks trust in the voice interface, the app's core differentiator.

## User story

As a golfer on-course, when I speak a score or round setup and the app is unsure what
it heard, I see what it understood and confirm (or re-speak) before anything is
applied — calmly, without friction, in the same yardage-book style as the rest of
the app.

---

## Confidence signal — grounded in the actual pipeline

### What the pipeline already has

**Setup path (game/tournament voice config):**
- `VoiceParseResultSchema` (`frontend/src/lib/voice/schemas.ts:68`): required field
  `confidence: z.number().min(0).max(1)`.
- `parseVoiceHeuristics` (`pipeline.ts:527`): returns `confidence: 0.8` (deterministic
  pattern match — high confidence).
- `parseVoiceLocalBasic` (`pipeline.ts:497`): returns `confidence: 0.6` (rule-based
  fallback — moderate).
- LLM repair exhaustion (`pipeline.ts:327`): returns `confidence: 0.25` with a
  `warnings` array — explicit low-confidence signal.
- Backend `/api/voice/parse-round-setup` (`voice_advanced.py:72`): `RoundSetupResponse`
  already has `confidence: float = 0.5`; LLM success hardcodes `0.75`, local fallback
  hardcodes `0.55`. This field is already in the JSON response.

**Score path (in-round hole scoring):**
- `VoiceScoreParseResultSchema` (`schemas.ts:104`): `confidence: z.number().min(0).max(1).optional()`.
  Optional — not always populated.
- `parseVoiceScoresLocally` (`parseVoiceScores.ts:224`): returns `{ hole, scores }` with
  NO confidence field. `VoiceParseScoresResult` (`types.ts:28`) has no confidence field.
- Backend `/api/voice/parse-scores` (`voice.py:53`): `VoiceScoreResponse` has only `hole`
  and `scores` — no confidence. The voice test runner (`runner.ts:76`) explicitly comments
  "confidence check (setup only — VoiceParseScoresResult has no confidence field)."
- The frontend `ScoreSheet.tsx` shows "Or say..." as static hint text with NO mic button
  — in-round voice scoring does not exist in the UI yet.

### What counts as "low confidence / needs confirm"

These are honest, derivable signals — not fabricated numbers.

**Round setup** (`confidence < 0.7` from backend, or any empty required field):
- Backend returns `confidence: 0.55` when the local fallback fires (no API key or LLM
  unavailable). This means the pipeline did its worst job — always prompt for review.
- Backend returns `confidence: 0.75` for LLM success. This is high enough to skip the
  amber warning UNLESS `courseName` is empty (common failure: user forgot the course).
- Threshold: `confidence < 0.7 OR courseName === ""` → show amber kicker on result card.

**In-round scoring** (to be derived in the backend):
- 0 players scored from transcript: `confidence = 0.2` — do not apply, show error.
- Partial parse (fewer players scored than are in the round): `confidence = 0.55`.
- All players scored via heuristics: `confidence = 0.8`.
- After LLM parse: use `(playersScored / totalPlayers) * 0.9` to derive, min 0.6.
- Threshold: `confidence < 0.65` → amber warning in the confirm step.

---

## UX — what the confirm step looks like

Reuse the established yardage-book patterns. Do NOT invent new components or tokens.

### Surface 1 — Round setup (low effort; existing confirm step, add warning)

`VoiceRoundSetup.tsx` already has a result card (phase `"result"`) that shows
course, players, tees, and "You said…". The user taps "Start round" to confirm.
The only missing piece is a visual warning when confidence is low.

**Change:** In the result card's kicker (`Got it — confirm below`), when
`parseResult.confidence < 0.7 OR parseResult.courseName === ""`:
- Replace the kicker text with `"Hard to hear — check the details below"` in
  `T.warningInk` (amber).
- Show a `T.warningWash` / `T.warningInk` border on any card that has an empty or
  uncertain field (e.g. no course → highlight the course card with an amber dashed
  border and placeholder text `"No course detected — tap to add"`).
- The "Start round" button is NOT blocked — the user can still confirm after
  reviewing.

Pattern match: identical to `ScanSheet.tsx:388` — the "Hard to read" kicker in
`T.warningInk`, and the amber `T.warningWash` cell background on flagged fields.

### Surface 2 — In-round scoring (new voice-to-score flow in ScoreSheet)

`ScoreSheet.tsx` currently shows "Or say…" as a static text hint with no mic.
Replace that hint row with a functional voice entry path.

**State additions to ScoreSheet:**

```typescript
type ScoreVoicePhase =
  | "idle"           // "Or say..." prompt visible
  | "listening"      // recording
  | "thinking"       // transcribing or parsing
  | "confirm"        // parsed result shown, awaiting confirm
  | "error";         // parse failed
```

**Flow:**
1. User taps mic button (44pt, T.ink background, inline SVG — no lucide-react).
2. `VoiceRecorder.start()` + Web Speech API interim text in a "Hearing…" line
   (same pattern as `VoiceRoundSetup.tsx:683`).
3. User taps mic again to stop → `transcribeBlob` → POST `/api/voice/parse-scores`
   with `{ transcript, playerNames, hole, par }`.
4. Show parsed result in the same sheet (slide the digit-wheel area up; show confirm
   panel below):
   - For each player: their name (T.mono kicker) + parsed score (T.serif large) with
     inline edit (tap → digit wheel for that player).
   - If `confidence < 0.65`: amber kicker `"Double-check these — I wasn't sure"` in
     `T.warningInk`, and amber `T.warningWash` background on each score tile.
   - If `confidence >= 0.65`: neutral kicker `"Confirm scores"`.
5. Footer: "Try again" ghost pill (refresh icon) + "Apply scores" solid pill (T.ink).
6. "Apply scores" → calls `onSetScore(pid, holeIdx, score)` per player → closes sheet.

The existing "Or say..." div (ScoreSheet.tsx line 282–286) is replaced with this
voice entry UI. The digit-wheel and quick-pick remain visible above it for manual
fallback.

**Backend change:** Add `confidence: float` and `warnings: list[str]` to
`VoiceScoreResponse` in `backend/app/routes/voice.py`. Derive confidence as:
`min(1.0, (len(scores) / max(1, len(playerNames))) * 0.9)` after extraction.
An empty `scores` dict returns `confidence: 0.2`.

---

## Scope boundaries

### In scope (v1)
- Round setup: amber kicker when `confidence < 0.7` or empty course name
  (`VoiceRoundSetup.tsx` result card).
- In-round scoring: full new voice-to-score flow in `ScoreSheet.tsx` with
  confidence-aware confirm step.

### Explicitly deferred
- `VoiceGameSetup.tsx` (dead/unmounted — no entry point in any live route).
- `VoiceTournamentSetup.tsx` (dead/unmounted).
- `CaddieSheet.tsx` — caddie voice is a different interaction model (question/answer,
  not parse-then-apply); defer.
- Per-player confidence scoring (fine-grained "I'm sure about Justin but not Bob").
- LLM self-rated confidence on the round-setup endpoint (backend improvement; unblock
  after v1 ships).

---

## Files / interfaces to change

| File | Change |
|------|--------|
| `backend/app/routes/voice.py` | Add `confidence: float = 0.5` and `warnings: list[str] = []` to `VoiceScoreResponse` (Pydantic model). Derive confidence after extraction. |
| `frontend/src/lib/voice/types.ts` | Add `confidence?: number; warnings?: string[]` to `VoiceParseScoresResult`. |
| `frontend/src/lib/voice/parseVoiceScores.ts` | `parseVoiceScoresLocally` returns confidence: `(scoredCount / totalPlayers) * 0.8`, min 0.1 if empty. |
| `frontend/src/components/VoiceRoundSetup.tsx` | Add `confidence?: number` to `ParsedRoundConfig` (line 31 type). In result card: amber kicker + amber border on empty fields when `confidence < 0.7 \|\| !courseName`. |
| `frontend/src/components/yardage/ScoreSheet.tsx` | Replace static "Or say…" hint row with voice entry UI: mic button, `ScoreVoicePhase` state, `VoiceConfirmPanel` (inline — no new file needed), POST to `/api/voice/parse-scores`. |
| `frontend/voice-tests/corpus/seed-utterances.jsonl` | Add ≥4 new scenarios for low-confidence paths (see acceptance criteria). |

No new files. No new dependencies. No new design tokens (use `T.warningWash`,
`T.warningInk` already defined in `tokens.ts`).

---

## Acceptance criteria

### Round setup
1. Record "Harding Park blues" → backend returns `confidence: 0.75`, `courseName:
   "Harding Park"` → NO amber warning. "Start round" button visible, user confirms.
2. Record a garbled utterance (API unavailable, local fallback fires) → backend returns
   `confidence: 0.55` → amber kicker appears: "Hard to hear — check the details below."
3. Record "Play with Justin and Bob" (no course) → `courseName: ""` → course card shows
   amber dashed border and placeholder "No course detected — tap to add" regardless of
   confidence value.
4. User taps "Start round" in all three cases — round is created correctly.

### In-round scoring — voice
5. Open ScoreSheet. Mic button is visible in place of the "Or say..." hint.
6. Speak "Justin four Bob five" → parsed result shown: Justin=4, Bob=5, no amber warning
   (full parse, high confidence).
7. Speak "four five" (no names) → result shown with `confidence: 0.2` → amber kicker +
   amber backgrounds. "Apply scores" is available but user is prompted to review.
8. Tap "Apply scores" → `onSetScore` called for each player → sheet closes → scores
   appear on the scorecard.
9. Tap "Try again" from the confirm step → returns to mic-ready state, no scores applied.

### Voice test cases (deterministic, offline — extends runner without breaking 260/260)

Add to `seed-utterances.jsonl` or a new `low-confidence.jsonl` in the corpus:

```jsonl
{"id":"lowconf:scores:001","context":{"kind":"scores","lane":"scoring","playerNames":["Justin","Bob"],"hole":5,"par":4},"utterance":"four five","endpoint":"/api/parse-voice-scores","expectedEffect":{"scores":{}},"expectedConfidenceMin":0,"notes":"No player names — should return empty scores, low confidence"}
{"id":"lowconf:scores:002","context":{"kind":"scores","lane":"scoring","playerNames":["Justin","Bob"],"hole":3,"par":3},"utterance":"Justin birdie","endpoint":"/api/parse-voice-scores","expectedEffect":{"scores":{"Justin":2}},"expectedConfidenceMin":0,"notes":"Partial — only one of two players named; confidence should be < 0.8"}
{"id":"lowconf:scores:003","context":{"kind":"scores","lane":"scoring","playerNames":["Justin","Bob"],"hole":7,"par":4},"utterance":"uh","endpoint":"/api/parse-voice-scores","expectedEffect":{"scores":{}},"expectedConfidenceMin":0,"notes":"Empty/filler transcript — no parse, low confidence"}
{"id":"lowconf:setup:001","context":{"kind":"setup","lane":"game"},"utterance":"playing with Justin and Bob","endpoint":"/api/parse-voice","expectedEffect":{"type":"game","game":{"playerNames":["Justin","Bob"]}},"expectedConfidenceMin":0.5,"notes":"No course name — confidence acceptable but courseName should be empty"}
```

The runner's existing `expectedConfidenceMin` check (runner.ts:77) gates setup
confidence. For scoring scenarios, the new `confidence` field on
`VoiceParseScoresResult` enables parity. The parser must return it without breaking
existing tests that do not assert on it (the field is additive/optional).

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Backend `voice.py` confidence formula is approximate | It is honest and labeled as derived — no fake precision. Document the formula in a comment. |
| ScoreSheet voice flow adds complexity to a busy component | Keep all voice state local to `ScoreSheet`; no prop drilling. Extract `VoiceConfirmPanel` as an internal sub-component if the file grows past 400 lines. |
| Deepgram transcription fails on-course (poor signal) | Voice fallback to local heuristics already exists in `parseVoiceScoresLocally`. The confirm step still shows even for local parse results. |
| New mic button in ScoreSheet alters an existing happy path | The digit-wheel and quick-pick remain unchanged above the mic row. The mic row is additive. |
| Voice test runner comments "VoiceParseScoresResult has no confidence field" (runner.ts:76) | Adding `confidence?: number` to the type is backward-compatible. The test harness comment should be updated when the field lands. |

---

## Required CI gates (all must pass before PR is marked ready)

- `cd frontend && npm run lint` — exit 0 / 0 problems
- `cd frontend && npx tsc --noEmit` — no errors (strict)
- `cd frontend && npx tsx voice-tests/runner.ts --smoke` — 260/260 pass (new tests
  add to this count; none of the existing 260 may regress)
- `cd frontend && npm run build` — clean build
- `cd backend && ruff check .` — exit 0

---

## End-to-end verification (human or QA agent)

1. Start the app (`cd frontend && npm run dev`). Open a round.
2. Tap "Enter score" → ScoreSheet opens. Tap the mic button.
3. Say "Justin four Bob five". Stop recording.
4. Confirm step appears: Justin=4, Bob=5. No amber warning. Tap "Apply scores".
5. ScoreSheet closes. Scorecard shows 4 and 5 for the correct players on the current hole.
6. Re-open ScoreSheet. Tap mic. Say "uh" (garbled). Stop recording.
7. Confirm step appears with amber warning and empty/zero scores. Tap "Try again".
8. Returns to mic state. Nothing was applied.
9. On the home screen, tap "New round". Tap the mic button in the voice setup overlay.
10. Say "playing with Justin and Bob" (no course). Stop. Tap "Understand this".
11. Result card shows players, empty course card with amber border. "Hard to hear"
    kicker visible. Tap "Start round" — round starts with the player list intact.
