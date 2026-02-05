# Voice parsing pipeline (Scorecard)

Goal: turn *good transcripts* into *reliable, actionable* game/tournament setup and score updates.

## Summary

We now use a **multi-stage pipeline** instead of trusting raw LLM JSON:

1) **Deterministic heuristics** (fast + safe) for common commands
2) **LLM parse** (Anthropic) with **strict Zod schema validation**
3) **Auto-repair loop**: if invalid JSON/schema mismatch, re-prompt with the validation errors
4) **Normalization**: fuzzy-match player/course names to the known context
5) **Confidence + explainability**: return `confidence`, `explanations`, `warnings`, and `normalization` diffs

This reduces “transcript OK but config unusable” failures.

---

## Where the code lives

- `frontend/src/lib/voice/`
  - `schemas.ts` — Zod schemas for game/tournament results and score results
  - `utils.ts` — JSON extraction, fuzzy matching, number parsing
  - `pipeline.ts` — main parsing pipeline (heuristics → LLM → repair → normalize)
  - `index.ts` — public exports

- API routes
  - `frontend/src/app/api/parse-voice/route.ts` — calls `parseVoiceTranscript()`
  - `frontend/src/app/api/parse-voice-scores/route.ts` — calls `parseVoiceScores()`

---

## Public interfaces (for Node/test harness)

These functions are environment-agnostic (Node 18+ / Node 22 has `fetch`):

- `parseVoiceTranscript({ transcript, known, llm })`
- `parseVoiceScores({ transcript, playerNames, hole, par, llm })`

`known` supports:
- `players?: string[]`
- `courses?: string[]`

`llm` supports:
- `anthropicApiKey`
- `systemPrompt` (only for game/tournament)
- `model`, `maxTokens`, `temperature`

API routes simply pass through context and env/API key.

---

## Validation + repair loop

LLM output is only accepted if:
- We can extract a valid JSON object (`safeJsonExtract` prefers ```json fenced blocks, else uses balanced braces)
- It parses with `JSON.parse`
- It passes `VoiceParseResultSchema` / `VoiceScoreParseResultSchema`

If schema validation fails, we retry up to `maxRepairs` times:
- system prompt is amended with `Validation errors: ...`
- temperature forced to `0` for determinism

If we still fail, we fall back to local parsing with low confidence and warnings.

---

## Deterministic heuristics (examples)

### Scores (`parseScoresHeuristics`)
- "everyone par" → assigns par to all players
- "Justin 4 Jack 5" → parses name/number pairs (supports spoken numbers)
- "Justin birdie" / "Jack bogey" → converts relative-to-par words

### Game/tournament (`parseVoiceHeuristics`)
- simple 1v1 match play patterns (e.g., "match play justin vs jack") when known players exist

Heuristics run *before* the LLM to avoid unnecessary calls and to improve reliability.

---

## Normalization

After validation, the pipeline fuzzy-matches:
- `playerNames`
- team player lists
- handicap keys
- tournament courses + groupings

It returns normalization diffs:

```json
{
  "normalization": {
    "players": [{"from":"J Bell","to":"JBell","score":0.84}]
  }
}
```

---

## Extending the system

Add new patterns safely by:

1) **Heuristics first** (if deterministic)
   - Add to `parseVoiceHeuristics()` or `parseScoresHeuristics()`
   - Keep them conservative; only fire when the intent is unambiguous

2) **Schema changes**
   - Update `schemas.ts`
   - Keep optional fields optional to preserve UI compatibility

3) **Normalization tweaks**
   - Improve thresholds in `fuzzyBestMatch`
   - Add nickname tables (future) in `utils.ts`

---

## Notes

- `zod` was added to `frontend/package.json` as a dependency.
- The API routes now accept optional `apiKey`, `knownPlayers`, and `knownCourses`.
