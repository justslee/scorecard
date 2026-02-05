# Voice command test system (command lane)

Offline, deterministic regression testing for the **command lane voice parsing pipeline**:

- `parseVoiceTranscript()` (setup/game + tournament)
- `parseVoiceScores()` (score entry)

Everything runs **in Node** (via `tsx`) and calls the functions directly.

## Scenario schema

Each scenario is:

```ts
{
  id: string,
  context: {
    mode?: string,
    screen?: string,
    knownPlayers?: string[],
    knownCourses?: string[],
    hole?: number,
    par?: number,
  },
  utterance: string,
  endpoint: 'parse-voice' | 'parse-voice-scores',
  expectedEffect: object,          // deep-subset match against actual result
  expectedConfidenceMin?: number,
  tags?: string[],
  notes?: string
}
```

## How generation scales to 1,000,000

The generator produces scenarios deterministically from `(seed, index)`:

- base templates + combinators for:
  - formats (skins/nassau/match play/etc)
  - player counts + names
  - handicaps
  - tournaments + rounds + courses
  - scoring styles ("everyone par", `Name 5`, `Name birdie`, etc)
- optional **STT-noise mutator** (lowercasing, punctuation removal, word swaps)

No scenarios are stored on disk; they are re-derived at runtime.

## Running

From `frontend/`:

```bash
# Default (smoke): curated corpus + 200 generated
npx tsx voice-tests/runner.ts --smoke

# Large deterministic batch
npx tsx voice-tests/runner.ts --seed 123 --count 50000

# One endpoint only
npx tsx voice-tests/runner.ts --endpoint parse-voice-scores --count 5000

# Filter by tags (must include ALL)
npx tsx voice-tests/runner.ts --tags setup,handicaps --smoke
```

Exit code is non-zero on failures.

## Shrinking

On failure the runner will attempt to shrink the utterance:

- remove filler words
- remove whole clauses
- trim trailing words

It also re-tests the scenario's **unmutated base utterance** (when present) to separate "mutator" failures from "core" parsing failures.

## Files

- `voice-tests/scenario.ts` – scenario types
- `voice-tests/corpus/curated.ts` – initial curated corpus (setup + scoring)
- `voice-tests/generators/*` – deterministic generators + STT mutator
- `voice-tests/runner.ts` – CLI runner
- `voice-tests/shrink.ts` – utterance shrinking
- `voice-tests/match.ts` – deep subset matcher
- `voice-tests/run-one.ts` – ad-hoc single-run helper
