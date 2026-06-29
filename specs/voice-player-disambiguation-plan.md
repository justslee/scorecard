# Plan — voice-player-disambiguation

Owner bug (2026-06-28): in voice round setup, saying a saved partner's name resolves to a
phonetic near-miss ("Dipak" → "Deepak") instead of the saved partner, so the round links
the wrong/no profile. The current matcher in `round/new` does an EXACT lowercase compare
(`sp.name.toLowerCase() === name.toLowerCase()`), so any transcription drift fails to link.

## Goal (PRIMARY — frontend-only, safe)
Map each spoken player name from `set_round_setup` to the matching `SavedPlayer.id` using a
fuzzy + light-phonetic match against the saved roster, with a confidence threshold. Unknown
names fall back to free-text (today's behavior) — never force a wrong match.

## Why exact + plain-Levenshtein is insufficient
- Exact compare: any drift ("Dan"→"Dann", "Dipak"→"Deepak") misses.
- Plain Levenshtein: "dipak" vs "deepak" = 2 edits over maxLen 6 → similarity ~0.667,
  below a sane 0.72 threshold. A **phonetic key** closes this: Soundex("dipak")=D120 =
  Soundex("deepak")=D120. So the matcher must combine string similarity OR phonetic-key
  equality (gated by a softer threshold), taking the best confident candidate.

## Approach
New pure module `frontend/src/lib/player-match.ts`:
- `soundex(s: string): string` — classic 4-char Soundex (light phonetic key). Pure, tested.
- `matchPlayerName(spoken, roster, opts?): { player: SavedPlayer | null; score: number; via: 'exact'|'fuzzy'|'phonetic'|'none' }`
  - Normalize via existing `normalizeName` (reuse from `@/lib/voice/utils`).
  - Consider both `name` and `nickname` of each `SavedPlayer` as candidate keys.
  - Score = max over candidates of:
    - exact normalized equality → 1.0 (`via:'exact'`)
    - `similarity()` (reuse from voice/utils; handles containment + Levenshtein) (`via:'fuzzy'`)
    - phonetic boost: if `soundex(spoken) === soundex(candidate)` AND first letters match,
      treat as a confident match at a fixed phonetic score (e.g. 0.8) (`via:'phonetic'`).
  - Accept only if best score ≥ threshold (default `MIN_MATCH = 0.72`). Phonetic equality is
    only allowed to win when the plain similarity is already "close" (guard: similarity ≥
    ~0.5) so wildly different names that collide on Soundex (rare) don't false-match.
  - Tie/empty roster → `{ player: null, score, via:'none' }`.
- `matchPlayerNames(spoken[], roster): Array<{ name; player; ... }>` convenience that also
  prevents linking the SAME saved id to two different spoken slots (first wins; later slot
  keeps free-text) — mirrors the existing de-dup intent in `handleTeeOff`.

## Wiring
In `frontend/src/app/round/new/page.tsx` `handleVoiceSetup` (lines ~180-191), replace the
exact `savedPlayers.find(...)` with `matchPlayerName(name, savedPlayers)`; when a confident
match is found use `{ id, name, handicap }` from the saved player (preserving the SAVED
display name so the profile links correctly), else keep the free-text custom slot exactly as
today (`custom-player-${i}`). Do not change the unknown-name fallback shape.

## Tests (Vitest, hard) — `frontend/src/lib/player-match.test.ts`
- Dipak ↔ Deepak matches (the owner bug). 
- soundex unit cases (Dipak/Deepak collide; Robert/Rupert behavior; etc.).
- Clearly different names DON'T match (e.g. "Dan" vs "Matthew" → null).
- Exact match wins; nickname match works.
- Empty roster → null.
- Threshold behavior: a borderline name below threshold → null (free-text).
- No same-id double-link across two slots (matchPlayerNames).

## Gates
`npm run lint` · `npx tsc --noEmit` · `npx tsx voice-tests/runner.ts --smoke` (265/265) ·
`npx vitest run` (existing + new) · `npm run build`. No backend touched in PRIMARY.

## SECONDARY (optional, only if zero risk to the Realtime mint CONFIG)
Bias transcription by injecting saved roster names into `build_setup_instructions`
(`backend/app/caddie/setup_voice.py`), passing names through `/setup-session`. If wiring
risks the mint/voice path at all → SKIP, leave a follow-up note. The frontend match is the
deliverable.

## Constraints
Push only to `integration/next`. Never main. No mint-config change. No `.env*`/`deploy/`/
migrations. One item. Do not regress echo/ordering/no-preload voice fixes.
