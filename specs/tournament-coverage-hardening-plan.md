# Tournament + Settlement Coverage Hardening Plan

**Target path:** `specs/tournament-coverage-hardening-plan.md`
**Scope:** ADD tests only (Vitest, frontend). One production fix permitted — and one is REQUIRED: a confirmed zero-sum money bug in `settlement.ts` (threePoint). No UI changes, no behavior changes otherwise, no edits/deletes to existing tests (CLAUDE.md rule).
**Baseline (verified 2026-07-12):** `npx vitest run` on the 5 target files → 117/117 green.

---

## CONFIRMED REAL MONEY BUG (highest-value outcome — fix RED→GREEN)

**Where:** `frontend/src/lib/settlement.ts:195-212` — the `threePoint` branch of `computeGameNetWinnings`.

**What:** Unlike skins (lines 125–135) and vegas (`distributeTeam`, lines 222–235), the threePoint team-split has **no rounding-residual absorber**:

```ts
const shareA = r2(teamANet / teamAPlayers.length);
const shareB = r2(-teamANet / teamBPlayers.length);
```

JS `Math.round` rounds half toward +infinity, so `r2(0.375) = 0.38` but `r2(-0.375) = -0.37`. Whenever `teamANet` is an odd number of cents, every player on the winning team rounds up and every loser rounds toward zero — the game **fabricates money** and violates the module's own documented invariant (settlement.ts:19-21).

**Reproduced against real code** (`npx tsx -e`, importing `./src/lib/settlement`): threePoint 2v2, `pointValue: 0.25` (the classic "quarter a point" stake for 9s), team A sweeps hole 1 (point diff 3 → `teamANet = $0.75`):

```
net: { p1: 0.38, p2: 0.38, p3: -0.37, p4: -0.37 }   SUM: +0.02   (must be 0)
transfers: p3→p2 $0.37, p4→p2 $0.01, p4→p1 $0.36
```

Two symptoms: (1) +$0.02 created per game; (2) `minimizeTransfers` on the non-zero-sum input leaves p1 **$0.02 short of his displayed net** (+0.38 shown, $0.36 delivered) — displayed ≠ delivered. Over an N-round tournament this accumulates (+$0.02·N), which is exactly the gap-3 amplification scenario.

**Reachability:** threePoint is not in the `buildRoundGames` picker (`round-games.ts:13-25`), but the voice pipeline creates it (`voice/parseVoiceTranscript.ts:118` sets `format = "threePoint"`) and the voice game schema accepts any non-negative `pointValue` (`voice/schemas.ts:19`). `computeNetSettlement` settles any persisted `threePoint` game with `pointValue > 0` (settlement.ts:342-344, threePoint ∈ `SETTLEABLE_FORMATS`).

**Why existing tests miss it:** every threePoint test uses an even-dividing stake — `settlement.test.ts:540-619` and the property fixture at `settlement.test.ts:1318-1348` use `pointValue: 10` (integer point diff × $10 / 2 players is always 2dp-exact).

**The fix (only production change in this plan):** in the threePoint branch, distribute each team's net with the same last-member-absorbs-residual pattern vegas uses (settlement.ts:222-235): distribute `+teamANet` across `teamAPlayers`, `-teamANet` across `teamBPlayers`, last member of each team gets `r2(teamNet − runningSum)`. Minimal, local; also hardens unequal team sizes (e.g. 3v2 → 0.33/0.33/0.33 vs −0.50/−0.50 currently drifts −$0.01). All existing threePoint tests use exact divisions, so the absorber produces identical values for them — no existing test is touched or affected. No shared-shape change → `types.ts`/`models.py` stay untouched.

**RED→GREEN order is mandatory:** land the failing tests first, confirm they fail with the exact +0.02 sum, then apply the fix, then confirm green.

---

## Where new tests live

New file: `frontend/src/lib/settlement.tournament.test.ts` — keeps the RED→GREEN diff isolated and guarantees zero edits to `settlement.test.ts` (2,345 lines). Re-declare the small local helpers (`makeRound`, `makeGame`, `makePlayers`, `uniformScores`, `sumNet` — ~50 lines, patterns at `settlement.test.ts:34-84`; they are unexported and importing a test file executes it, so duplication is correct here). Reuse the realistic wolf fixture shape from `settlement.test.ts:1423-1469` and the vegas/skins fixture shapes from `settlement.test.ts:1276-1371` as construction references.

Shared assertion helper for the new file — **conservation**: for a ledger, every player satisfies `r2(net[p] − inflow(p) + outflow(p)) === 0` and every transfer has `amount ≥ 0.01` at 2dp. This is the real "displayed == settled" guarantee (see gap 5) and is RED today via the threePoint bug.

---

## Gap 1 — Cross-roster cumulative settlement (HIGHEST VALUE after the bug)

**Current state:** every `computeTournamentSettlement` test (`settlement.test.ts:1126-1206`) uses the identical `{p1,p2}` roster via `matchPlayRound` (`settlement.test.ts:1103-1124`, hardcoded `'p1' | 'p2'`). The union-merge loop (`settlement.ts:390-395`) has never seen disjoint rosters. Confirmed genuinely uncovered.

**Invariants:** cumulative net zero-sum over the UNION of players; no player silently dropped; a player absent from a round's roster contributes exactly $0 that round; transfers minimized ONCE over the union with full conservation.

**Tests:**
1. **Rotating pairs:** r1 matchPlay {p1,p2} $10 (p1 wins), r2 {p2,p3} $10 (p2 wins), r3 {p1,p3} $10 (p3 wins). Assert: `netByPlayer` keys = exactly {p1,p2,p3}; each player's exact value (all $0 here — perfect circle → `transfers === []` and `isEmpty === true`); then a skewed variant (r3 $20) asserting exact nets (p1: −10... compute: p1 +10 −20 = −10; p2 −10+10 = 0; p3 −10+20 = +10), zero-sum, and exactly ONE transfer p1→p3 — cross-round chain compression **through a player who nets zero**, something per-round-minimize-then-concat can never produce.
2. **Mixed roster sizes:** r1 skins {p1,p2,p3,p4} (skins fixture pattern, one decided hole), r2 matchPlay {p1,p2}. Assert p3/p4 present in the cumulative with values exactly equal to `computeNetSettlement(r1).netByPlayer` for them (sat-out round contributed exactly $0), union zero-sum, conservation.
3. **Union property:** for both tournaments, assert `Object.keys(ledger.netByPlayer)` ⊇ every playerId that appears in any round's per-round ledger — no silent drops.

## Gap 2 — Genuinely mixed formats across rounds

**Current state:** the test titled "…across multiple rounds and formats" (`settlement.test.ts:1187-1197`) is three `matchPlayRound`s — all matchPlay. The multi-format claim is untested. Confirmed gap.

**Test:** one 6-round tournament: r1 skins 3p (fixture pattern :1276), r2 wolf 4p realistic decided round (fixture pattern :1423 — nets +12/−4/−8/0 at $2), r3 vegas 2v2 with teams (fixture pattern :1349), r4 matchPlay 2p, r5 nassau 2p, r6 **stableford with `pointValue: 5` set and full scores** (stableford confirmed ∉ `SETTLEABLE_FORMATS`, settlement.ts:43-53; per-game honesty covered at settlement.test.ts:192, but never inside a cumulative tournament).

**Assertions:** cumulative zero-sum over the union; cumulative `netByPlayer` deep-equals the hand-summed per-round `computeNetSettlement` ledgers (consistency invariant — the tournament function adds nothing beyond r2-summation, per its doc settlement.ts:373-375); `computeTournamentSettlement(all 6).netByPlayer` deep-equals `computeTournamentSettlement(rounds without r6).netByPlayer` — the stableford round contributes exactly $0 to the ledger; conservation on the final transfers.

## Gap 3 — Rounding-drift accumulation (contains the RED tests)

**Current state:** dust handling tested only at `minimizeTransfers` level (`settlement.test.ts:122-133`). No cumulative-drift test exists. Per-round post-`r2` zero-sum audit result (verified by reading every branch): skins exact (absorber :125-135), vegas exact (absorber :222-235), nassau/rabbit exact for 2dp stakes (integer multiples), matchPlay/wolf/hammer/defender exact (dollarized integer-multiple totals) — **threePoint is the sole violator** (bug above).

**Tests:**
1. **RED — per-round zero-sum, odd-cent threePoint:** the $0.25 repro above; assert `sumNet === 0` (fails today at +0.02). After fix, also assert team totals exact (±$0.75) and each |net| ∈ {0.37, 0.38}.
2. **RED — accumulation:** 6-round tournament of that threePoint round → assert cumulative `sumNet === 0` (fails today at +0.12) and conservation (fails today — p1 undelivered $0.02/round).
3. **NEW property (additive; do not touch the existing fixture table at :1273):** a second property describe, "odd-cent-stake zero-sum," iterating the pot-splitting formats (skins 3p, threePoint 2v2, nassau 3p, rabbit 3p) with `pointValue: 0.25` on decided rounds, asserting `sumNet === 0` each. Locks the absorber class of bugs for all division-based formats; threePoint leg is RED today, others GREEN (proves no padding).
4. **GREEN lock — fractional 3-way skins drift:** 6 rounds × 3-way skins $1 (nets like +0.67/−0.33/−0.34 per round, absorber-produced); assert cumulative `sumNet === 0` exactly and every cumulative value is a 2dp value (`Math.round(v*100) === v*100` within epsilon). Guards the skins absorber against future regression at tournament scale.

## Gap 4 — Money + game-less + unscored rounds in one tournament

**Current state:** the only mixed test (`settlement.test.ts:1165-1185`) has ALL rounds non-money — never money rounds alongside. Confirmed gap.

**Test:** r1 matchPlay $10 decided; r2 `games: []`; r3 skins $5 with `scores: []` (unscored, roster {p1..p4}); r4 matchPlay $15 decided. Assert: `transfers` deep-equal `computeTournamentSettlement([r1, r4]).transfers`; every **non-zero** entry of `netByPlayer` equals the [r1,r4]-only ledger; any key contributed by r3 (an unscored skins round initializes all roster players at $0 — settlement.ts:107-108 — so zero-valued keys MAY legitimately appear) has value exactly `0` — assert value-zero, not key-absence, so the test encodes the real contract: unscored/game-less rounds neither corrupt amounts nor drop players. Also `isEmpty === false`.

## Gap 5 — Displayed == settled (UI seam)

**Finding (honest):** the page consumes the pure function directly — `TournamentPageClient.tsx:302` (`computeTournamentSettlement(memberRounds)`) — and renders `tournamentSettlement.transfers` **verbatim** at :1669-1717 (`${t.amount.toFixed(2)}`, no re-derivation; name lookup is a display-only fallback chain :1670-1677). The three-way empty message (:1647-1661) keys off already-tested pure `hasMoneyGames` (:513) plus a trivial standings check (:510). There is **no pure helper between the tested function and the DOM**, and the component is a 1,700+-line page client with fetch effects, haptics, and framer-motion; the repo's RTL tests target small components (`GamePicker.test.tsx`, `DistancesCard.test.tsx`), never page clients. **Verdict: a page-level RTL test would be brittle mock scaffolding with no money-math payoff — skip it.** The substantive displayed==settled guarantee is that *transfers exactly settle the displayed nets*, which is pure: the **conservation assertion** applied across all new tournament fixtures (gaps 1–4) covers it — and it is RED today because of the threePoint bug, proving it is not vacuous.

## Gap 6 — tournament-program.ts edges

**Already covered — skip.** `tournament-program.test.ts` covers 0-players → `""` (lines 46, 57), 10+ digit fallback (:22, :42), ghostCount cap (:63). The "long-names" edge is **not applicable**: all five exports (`tournament-program.ts:20-63`) take counts/dates only — no export accepts a name. `rounds` is 1–4 by construction (doc :39) and both word/singular paths are tested. Adding more here would be padding.

---

## Sequencing

1. Create `frontend/src/lib/settlement.tournament.test.ts` with helpers + conservation assertion + **gap-3 RED tests only**; run `npx vitest run src/lib/settlement.tournament.test.ts` — confirm failures show `+0.02` / `+0.12` sums (evidence for the PR).
2. Fix `settlement.ts` threePoint branch (residual absorber, mirror of vegas :222-235). Re-run — RED→GREEN. Run the FULL suite — all pre-existing tests must stay green untouched.
3. Add gap 1, 2, 4 tests + the odd-cent property describe. All green.
4. Gates (all from repo commands, CLAUDE.md):
   - `cd frontend && npm run lint`
   - `cd frontend && npx tsc --noEmit`
   - `cd frontend && npx vitest run` (full)
   - `cd frontend && npm run build`
   - `cd frontend && npx tsx voice-tests/runner.ts --smoke`
   - `cd backend && ruff check .` (no backend changes — cheap sanity only)
   - **DB-backed integration tests run in CI only** (no local Postgres) — they ride the `integration/next` PR; nothing in this change touches the DB layer, so no special handling.
5. `types.ts` ↔ `models.py`: untouched — the fix is internal arithmetic inside one branch; no shared shape changes.
6. NORTHSTAR/CLAUDE.md compliance: pure-function tests + a money-honesty fix squarely in the `[[no-fake-data-fallbacks]]` tradition documented throughout settlement.ts/round-games.ts; zero UI/presentation drift; silent work that rides the rolling bundle. Commit as one feature: "fix threePoint zero-sum rounding drift + tournament settlement coverage hardening."

### Critical Files for Implementation
- /Users/justinlee/projects/scorecard/frontend/src/lib/settlement.ts (the threePoint fix, lines 195–212; all invariants under test)
- /Users/justinlee/projects/scorecard/frontend/src/lib/settlement.test.ts (existing coverage + helper/fixture patterns to replicate; DO NOT EDIT)
- /Users/justinlee/projects/scorecard/frontend/src/lib/settlement.tournament.test.ts (NEW — all added tests)
- /Users/justinlee/projects/scorecard/frontend/src/lib/games.ts (computeThreePoint/pointsForComparison semantics the fixtures depend on, lines 314–318, 594–670)
- /Users/justinlee/projects/scorecard/frontend/src/app/tournament/[id]/TournamentPageClient.tsx (gap-5 seam evidence, lines 302, 1647–1717)
