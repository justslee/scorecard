# tournament-net-handicap-leaderboard — plan-lite

## Handicap data trace (what's ACTUALLY available)
- `Player` (`round.players[]`, `types.ts:42`) carries optional `handicap?: number`. This is
  the ONLY per-player handicap available in a tournament — it's a manually-set course
  handicap/index copied onto each round's player record (same place names come from).
- `estimateHandicapFromRounds` (`handicap.ts`) is **owner-only** — it uses
  `getOwnerPlayerId(round)` and computes a WHS index for ONE player (the app owner). It
  CANNOT produce per-player handicaps for a tournament field. So we do NOT use it here.
- Precedent for applying a handicap to a score already exists in `games.ts` (chicago):
  `quotas[pid] = quotaBase - Math.round(player?.handicap ?? 0)` — full-handicap subtraction,
  rounded to an integer. We reuse THAT convention (integer strokes, full allocation). We do
  NOT invent hole-by-hole stroke-index allocation (the app has none).

## Honest missing-handicap rule (DECIDED)
Net = gross − course-handicap applied **per round** and summed. A player with **no handicap
on any of their round-player records** is NOT assigned 0 (that would fabricate a scratch
advantage). Instead, in Net mode they are **unranked**: `totalNet = null`, rank label `—`,
sorted last, total cell shows `—`. Gross/To-Par modes are unaffected — they never read the
handicap. State this in the UI honest state (designer to refine copy).

## Net computation (reuse the chicago convention, no new formula)
- Resolve a `playerHandicaps: Record<string, number>` map in the load effect, same as
  `resolvedNames`: walk `members[].players[]`, take the first defined `handicap` per id
  (round copy), then overlay any tournament-level source if present. Round to integer with
  `Math.round` at use (match chicago).
- Extend `PlayerStanding`:
  - `handicap: number | null` (resolved rounded course handicap, null = none)
  - `roundNet: (number | null)[]` — per round: `roundTotals[i] === null ? null : roundTotals[i] - hcp` (null if no hcp)
  - `totalNet: number | null` — null if `handicap === null` OR no scores; else
    `totalStrokes − handicap × (#rounds with a score)` (per-round allocation summed).
- `computeStandings(playerIds, playerNames, playerHandicaps, rounds)` — add the 3rd arg.

## Mode toggle + rendering
- `LbMode = "gross" | "toPar" | "net"`. Add `{ k: "net", l: "Net" }` as the 3rd pill.
- `sortedStandings`: add net branch — nulls last, ascending by `totalNet`.
- `tieRankLabel`: add net branch — `myTotal = totalNet`; reuse existing tie logic (returns
  `—` when null). No new ranking code.
- Leader callout: label gross→STROKES / toPar→TO PAR / net→NET; value picks totalNet in net
  (shows `—` if null, honest).
- Body rows: `perRound`/`total` pick the net arrays in net mode; net cells render the integer
  or `—`. Consider showing the player's HCP subtly in net mode (designer call).

## Motion guard (must cover the new mode)
- `prevOrderRef` already tracks `mode: LbMode`. Gross→Net and ToPar→Net are `prev.mode !==
  lbMode` → silent rebase, NO phantom haptic. Verify the guard treats ALL cross-mode
  switches as view toggles (it already compares mode inequality, so Net is covered for free).
  The FLIP `layout="position"` re-sort animates the net re-order the same as gross/toPar.

## Gross / To-Par: byte-identical BEHAVIOR
Do not change any gross/toPar branch. Only ADD net branches alongside them.

## Testability
Named-export the pure helpers (`computeStandings`, `tieRankLabel`, and any net helper) from
the client file so vitest can import them without rendering the component. If framer-motion
import breaks the vitest import, extract the pure helpers to `src/lib/tournament-standings.ts`
and import from the client (behavior-preserving). Add tests: net total/per-round math,
per-round allocation over multi-round, missing-handicap → null (unranked, not 0), net re-rank
+ tie-aware label, and gross/toPar unchanged.

## Scope: frontend-only. No settlement/aggregation/motion-code changes (only ensure the mode
guard covers net, which it does). Backend untouched.
