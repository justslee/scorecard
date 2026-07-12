# Tournament Wolf Money Settlement — Implementation Plan

**Goal:** Make the `wolf` format settle real money with a strict zero-sum guarantee, then re-add `wolf` to `SETTLEABLE_FORMATS` — gated on the all-formats zero-sum property test passing with a registered wolf fixture. Scope: the Wolf settlement engine + exhaustive money tests ONLY. Out of scope (design-gated, stays filed): match-play >2-player opponent picker; vegas/bestBall/scramble/threePoint team-assignment UI.

**Predecessor:** `specs/tournament-settlement-honesty-plan.md` (do not edit it — it is a historical record; its adversarial review is what removed wolf from `SETTLEABLE_FORMATS`).

---

## 0. Verified preconditions (all confirmed against code — the builder does not re-verify)

- **The pick is captured and user-populated.** `frontend/src/lib/types.ts:146-152` defines `wolfOrderPlayerIds?: string[]` (length 4) and `wolfHoleChoices?: Record<number, {mode:'lone'} | {mode:'partner'; partnerId:string}>`. `frontend/src/components/GameResults.tsx:442-568` renders a per-hole "Lone Wolf" button + partner `<select>` and persists choices via `onUpdateGame`. **Wolf money is NOT design-gated.** No stop condition applies.
- **Order fallback:** `computeWolf` (`frontend/src/lib/games.ts:806-809`) uses `wolfOrderPlayerIds` when length 4, else `game.playerIds` when length 4, else `round.players.slice(0,4)`. `buildRoundGames` never writes `wolfOrderPlayerIds`, but its wolf roster guard (`ROSTER_REQUIREMENT.wolf === 4`, skip-not-truncate) guarantees `playerIds.length === 4`, so builder-produced wolf games always get a well-defined 4-player rotation. No change needed.
- **Backend model:** `backend/app/models.py` `Game.settings: Optional[dict]` — free-form JSON. `wolfHoleChoices` already round-trips today (GameResults saves it in production). **No backend model change, no migration.** (JSON round-trip turns numeric keys into strings; JS object indexing is string-keyed anyway, so `choices[holeNumber]` works — existing behavior, unchanged.)
- **`STAKE_GAME_IDS` is derived** (`frontend/src/lib/round-games.ts:82-86`): the moment `'wolf'` enters `SETTLEABLE_FORMATS`, wolf becomes a stake game — `buildRoundGames` writes its `pointValue`, GamePicker auto-renders the stake row (`GamePicker.tsx:88`), and `/round/new` auto-defaults its stake to `$5` (`page.tsx:1221`). All derived; **zero UI code changes**. The tournament picker (`TOURNAMENT_GAME_IDS`) does not offer wolf — unchanged, out of scope.

---

## 1. The design decision: Option (A) — make `computeWolf`'s points zero-sum; money = points × pointValue

**Decision: (A).** Change `computeWolf` (`games.ts:806-883`) so every hole's `pointsDelta` sums to zero, then add a thin `settlement.ts` branch that multiplies the per-player point totals by `pointValue` (same shape as the `threePoint` branch: points-diff × stake).

**Why (A) over (B):**

1. **Honesty (displayed == settled).** Under (B), the points scoreboard (GameResults "Points" summary, GameLeaderboards, LeaderboardSheet — all render `results.wolf.totals`) says "lone win: wolf +3, others 0" while the money ledger debits the three others $1·stake each. Two contradictory stories about the same holes is precisely the class of dishonesty `tournament-settlement-honesty-plan.md` exists to kill, and the reviewer who removed wolf from `SETTLEABLE_FORMATS` would (correctly) reject it. Under (A), points ARE the money: a golfer multiplies the number on screen by the stake and gets exactly what settles.
2. **No duplicated engine.** (B) requires re-implementing lone/partner best-ball hole evaluation inside `settlement.ts` — a second copy of `computeWolf`'s core that can drift. (A) keeps one evaluator; settlement stays a dumb multiplier, matching the established pattern where the games engine produces zero-sum totals (hammer, defender, vegas) and settlement distributes.
3. **Regression is small, quantified, and intended.** The full blast radius of (A) is exactly 5 test cases in `games.test.ts` (enumerated in §5.1) plus the user-visible points display now showing negative points for hole losers. Negative points for losers is the standard "zero-sum wolf" scoring convention and is *more* honest, not less — the current "winners-only" tally understates who is losing. This display change touches no components (same `totals` record, same rendering) and preserves the yardage-book feel (NORTHSTAR check, §9).

**Payout magnitude convention (validated):** keep the engine's existing winner-side magnitudes — lone = 3 units (one from each of 3 opponents), partner = 1 unit per player. This is the standard "1 point per opponent" wolf convention, minimizes displayed-points regression (winners' numbers don't change; only losers gain the offsetting −1s), and stays consistent between points and money by construction. The "lone wolf worth double" (±6) and "blind/double wolf" variants are **excluded**: blind wolf requires distinguishing a pick made before vs. after seeing tee shots, which the data model does not capture (`wolfHoleChoices` has no `blind` flag) — not "trivially clean," so it is filed as a follow-up, not planned around.

---

## 2. Exact per-hole payout rules (zero-sum deltas — normative)

Let `pv = game.settings.pointValue` (dollars), wolf = `order[(holeNumber-1) % 4]`. Points first (what `computeWolf` emits); money for the hole = points × pv.

| Case | Condition | Points delta (must sum to 0) |
|---|---|---|
| **Lone win** | `choice.mode === 'lone'`, wolf score < min of **all 3** opponents' scores | wolf **+3**; each opponent **−1** |
| **Lone loss** | wolf score > min of all 3 opponents' scores | wolf **−3**; each opponent **+1** |
| **Lone tie** | wolf score == min of opponents' scores | **no entries** (empty delta — the hole displays "—", not "+0") |
| **Partner win** | `choice.mode === 'partner'`, valid partner, min(wolf, partner) < min(other two) | wolf **+1**, partner **+1**; each opponent **−1** |
| **Partner loss** | min(other two) < min(wolf, partner) | wolf **−1**, partner **−1**; each opponent **+1** |
| **Partner tie** | best balls equal | no entries |
| **No choice recorded for the hole** | `choices[holeNumber]` absent | no entries → **$0** |
| **Wolf's score missing** | existing guard `if (choice && typeof wolfScore === 'number')` | no entries → $0 |
| **Lone: any opponent score missing** | require `otherScores.length === 3` (**tightened** — today the lone branch settles points against the best of *available* scores, `otherScores.length >= 1`) | no entries → $0 |
| **Partner: partner score missing or opponents' scores incomplete** | existing guard (`typeof partnerScore === 'number' && otherScores.length === 2`) | no entries → $0 |
| **Invalid partnerId** (missing, == wolf, not in order) | existing guard | no entries → $0 |

**The lone-branch tightening is deliberate:** you cannot debit a player −1 who has no score for the hole, and letting the lone payout magnitude vary with data completeness (+1 per *scored* opponent) would make identical wins pay differently. Requiring all 3 opponent scores mirrors the partner branch's existing all-scores requirement and keeps every lone result exactly ±3. No existing test exercises the partial-scores lone path (all `games.test.ts` lone cases provide 4 scores), so this tightening breaks nothing.

**Missing scores / no picks = $0 holes** — matches the honesty rule: money only moves on holes that were actually decided and chosen. A wolf game with `pointValue > 0` but zero recorded choices produces an all-zeros (non-empty) net — identical semantics to an unscored skins game with a stake (net record of zeros, `minimizeTransfers` → `[]`), so no new special case in `computeNetSettlement`.

---

## 3. Implementation steps (in order — the gate is step 5)

### Step 1 — `frontend/src/lib/games.ts` (`computeWolf`, lines 806-883)
Modify only the delta assignments inside the existing structure:
- Lone: require `otherScores.length === 3`; win → `delta[wolf]=3` and `delta[opp]=-1` for each of the 3; loss → mirror; tie → assign nothing (delete the current `delta[wolfPlayerId] = 0` tie write — empty delta on ties, consistent with the partner branch).
- Partner win → add `delta[opp] = -1` for both opponents alongside the existing `+1`s; partner loss → winners `+1` (existing) and `delta[wolf] = delta[partner] = -1`.
- No signature/type changes (`WolfResults` unchanged, `games.ts:85-95`); `totalsAfter`/`totals` accumulation logic unchanged.
- Update the doc comment to state the zero-sum invariant: *every hole's `pointsDelta` sums to 0; settlement multiplies `totals` by `pointValue`, so this invariant is a money invariant.*

### Step 2 — `frontend/src/lib/games.test.ts` (`computeWolf` describe, lines 900-1046)
Update the 5 cases that encode the old non-zero-sum expectations (§5.1 has exact new numbers). Add new cases: lone tie → empty delta; lone with a missing opponent score → empty delta (locks the tightening); per-hole `sumNet(pointsDelta) === 0` across a mixed round.

### Step 3 — `frontend/src/lib/settlement.ts`
- Add the wolf branch to `computeGameNetWinnings` (after matchPlay, before threePoint, keeping file order readable):
  ```
  // ─── Wolf ─── totals are zero-sum POINTS (computeWolf); money = points × pointValue.
  if (game.format === 'wolf' && results.wolf) {
    for (const pid of playerIds) net[pid] = r2((net[pid] ?? 0) + r2((results.wolf.totals[pid] ?? 0) * pointValue));
  }
  ```
- Replace the "`wolf` is deliberately NOT a member" comment block (lines 36-41) with documentation of the fixed zero-sum engine and the gate that readmitted it.
- Add `'wolf'` to `SETTLEABLE_FORMATS` (line 43-52). **Order note:** land steps 1–4 together in one change; the readmission is "gated" by step 5's property test passing in the same CI run — if the wolf property test fails, the change does not merge.

### Step 4 — `frontend/src/lib/round-games.ts` (comments only — behavior is derived)
- Update the `ROSTER_REQUIREMENT` doc comment (lines 88-103): wolf is again a `STAKE_GAME_IDS` member, so the exact-4 roster requirement is once more a **money guard**, not just a display guard.
- No logic changes: `STAKE_GAME_IDS` derives wolf membership automatically; `buildRoundGames` needs nothing (roster guard already ensures 4 players; stake parsing is generic).

### Step 5 — `frontend/src/lib/settlement.test.ts` (the money gate)
1. **REPLACE** the "wolf settles honestly empty" describe (lines 240-287) with a real `computeGameNetWinnings — wolf` describe (§5.2). **This is a legitimate, intended behavior change, not test-hacking:** those tests encoded the *deferred* state ("wolf is points-only until the engine is fixed to true zero-sum") whose fix is exactly this plan. Say so in a comment above the new describe so a reviewer diffing the deletion isn't alarmed.
2. **ADD** a `wolf` entry to `SETTLEABLE_FORMAT_FIXTURES` (lines 1126-1271) — the multi-hole mixed fixture in §5.3 (lone win + partnered loss + lone loss + partnered win + lone tie; asymmetric totals, NOT a hand-balanced pair). The existing property test loop (1273-1289) then automatically asserts non-empty + zero-sum for wolf; without the fixture it fails loudly ("no zero-sum fixture registered") — that failure mode is the enforcement mechanism.
3. **REPLACE** the "wolf … never carries a stake" test (lines 1342-1352) with the displayed→settled test (§5.4): `buildRoundGames` now writes wolf's `pointValue`, and the full path (builder → simulated GameResults picks → settlement) yields a non-empty zero-sum net. **§5-invariant ruling:** wolf needs no "documented exception" to *"scores alone → non-empty"* — a *decided* wolf round by definition includes recorded picks (they are in-round data exactly like hammer's `hammerMultiplierByHole`), so the wolf §5 case simply includes `wolfHoleChoices`. Add a companion assertion for the picks-absent case: stake + scores but no choices → all-zero net, zero transfers ($0 honest).
4. Update the file-header comment (lines 4-7) that says "wolf is points-only (not settleable)".

### Step 6 — `frontend/src/lib/round-games.test.ts`
- Line 183-185: `STAKE_GAME_IDS` equality → `{skins, match, nassau, wolf}`; rewrite the test name (the "its engine fabricates money" rationale is now false).
- Lines 167-179: remove `"wolf"` from `nonStakeIds`; add a positive twin: wolf with a 4-player roster and `"$5"` emits `pointValue: 5` (and with `"$0"` emits `undefined`).
- Everything else (roster tests at 152-165 and 196-208, format-mapping at 26-46, drift test at 187-193) passes unchanged — confirm, don't touch.

### Step 7 — sweep stale prose (no behavior)
- `GamePicker.test.tsx` needs no changes (no test asserts wolf shows the no-money note) — verify only. The `"wolf, no money"` example copy in `GamePicker.tsx:81` stays: playing wolf without a stake remains valid.
- Voice tests (`voice-tests/corpus/curated.ts:85-91`) assert only `format: "wolf"` — unaffected; run the smoke gate to prove it.

---

## 4. Zero-sum proof (why it holds in every branch)

1. **Per hole:** every non-empty delta is one of: `{+3, −1, −1, −1}`, `{−3, +1, +1, +1}`, `{+1, +1, −1, −1}`, `{−1, −1, +1, +1}` — each sums to 0; every other path emits the empty delta (sum 0). There is no branch that writes an unbalanced delta.
2. **Per round (points):** `totals` is the sum of per-hole deltas over integer arithmetic (no FP error possible on integers of this size) → `Σ totals == 0` exactly.
3. **Money:** `net[pid] = r2(totals[pid] × pv)`. `totals[pid]` is an integer and `pv` has ≤ 2 decimal places (the picker input strips non-digits so it is an integer in practice, but the proof only needs ≤ 2dp), so each product is exact at 2dp and `r2` is the identity up to FP epsilon; `Σ net = pv × Σ totals = pv × 0 = 0`, and `sumNet`'s 2dp rounding absorbs any epsilon. **No last-player residual absorber is needed** (unlike skins/vegas, which divide a pot); state this in the branch comment so nobody "fixes" it later.

---

## 5. Deterministic test matrix (ground truth — the builder writes exactly these)

### 5.1 `games.test.ts` — updated `computeWolf` expectations (order `p1..p4`, wolf = p1 on hole 1)
| Test (existing, lines) | Old expectation | New expectation |
|---|---|---|
| lone wolf wins (926-944) | p1 +3; p2/p3/p4 **0** | p1 +3; p2/p3/p4 **−1 each** |
| lone wolf loses (946-962) | p1 −3; p2 0 | p1 −3; **p2/p3/p4 +1 each** |
| partner win, p1+p3 (964-984) | p1/p3 +1; p2/p4 0 | p1/p3 +1; **p2/p4 −1 each** |
| partner loss, p1+p3 (986-1004) | p2/p4 +1; p1/p3 0 | p2/p4 +1; **p1/p3 −1 each** |
| cumulative totals (1024-1045): h1 p1 lone win, h2 p2 lone win | `holes[1].totalsAfter.p1 = 3`; totals p1=3, p2=3 | h1: p1 +3, others −1; h2: p2 +3, p1/p3/p4 −1 → `holes[1].totalsAfter.p1 = 2`; **totals p1=2, p2=2, p3=−2, p4=−2** |

New: lone tie (wolf 4 vs best-other 4) → `pointsDelta` empty; lone with only 2 of 3 opponent scores → `pointsDelta` empty; assert `Σ pointsDelta === 0` for every hole of the mixed fixture. Unchanged: rotation (914-924), no-choice (1006-1022), dispatcher routing (1101-1115).

### 5.2 `settlement.test.ts` — new `computeGameNetWinnings — wolf` describe (replaces 240-287). All at **pointValue = 2**, order/roster `p1..p4`:
| Case | Scores (hole 1 unless noted) | Choice | Expected net |
|---|---|---|---|
| Lone win | p1=3, p2=5, p3=5, p4=5 | `{1:{mode:'lone'}}` | **p1 +6; p2/p3/p4 −2 each**; sum 0 |
| Lone loss | p1=5, p2=3, p3=4, p4=4 | lone | **p1 −6; p2/p3/p4 +2 each** |
| Lone tie | p1=4, p2=4, p3=5, p4=5 | lone | all 0; `minimizeTransfers` → `[]` |
| Partner win (p1+p3) | p1=3, p2=4, p3=3, p4=4 | `{1:{mode:'partner',partnerId:'p3'}}` | **p1 +2, p3 +2, p2 −2, p4 −2** |
| Partner loss (p1+p3) | p1=5, p2=3, p3=5, p4=3 | partner p3 | **p1 −2, p3 −2, p2 +2, p4 +2** |
| Partner tie | all 4 | partner p3 | all 0 |
| Stake + scores, **no picks** | lone-win scores, `wolfHoleChoices: {}` | — | all-zero net; zero transfers ($0 honest) |
| No stake | pointValue 0/unset, decided pick | lone | `{}` (early return — points-only wolf still settles nothing) |
| Fractional stake robustness | lone win at pointValue **2.5** | lone | p1 +7.5; others −2.5 each; `sumNet === 0` (proves no residual handling needed) |
| Full mixed round | the §5.3 fixture | mixed | per-hole `Σ pointsDelta === 0` for all 18 AND round `sumNet === 0` AND the exact totals below |

### 5.3 The `SETTLEABLE_FORMAT_FIXTURES.wolf` fixture (realistic, asymmetric — reused as the "full mixed round" case)
Roster/order `p1..p4`, `pointValue: 2`, holes 6-18 unscored & unchosen (honest $0 tail):
- **H1** p1 wolf, lone: p1=3, p2=5, p3=5, p4=5 → Δ p1 +3, others −1
- **H2** p2 wolf, partner p4, loses: p1=3, p2=5, p3=4, p4=5 → Δ p1 +1, p3 +1, p2 −1, p4 −1
- **H3** p3 wolf, lone, loses: p1=4, p2=4, p3=6, p4=4 → Δ p3 −3, others +1
- **H4** p4 wolf, partner p1, wins: p1=4, p2=4, p3=4, p4=3 → Δ p4 +1, p1 +1, p2 −1, p3 −1
- **H5** p1 wolf, lone, tie: all 4s → Δ none

**Ground truth:** points `p1 +6, p2 −2, p3 −4, p4 0` (sum 0) → net at $2: **p1 +12, p2 −4, p3 −8, p4 0**. Non-empty (4 keys, p4 legitimately $0), `sumNet === 0`, and NOT a hand-balanced pair — exactly what the property test (1273-1289) demands. The property test itself needs **no edits**; adding the fixture and the set member makes the loop cover wolf.

**NOTE for the builder — verify the H2/H4 wolf-rotation assumption:** the fixture assigns picks by hole number, but the wolf on each hole is `order[(holeNumber-1) % 4]` = H1→p1, H2→p2, H3→p3, H4→p4, H5→p1. The partner/lone modes above are keyed to that rotation; confirm each hole's `choice` is legal for that hole's actual wolf (e.g. H2 wolf p2 partners p4; H4 wolf p4 partners p1). Recompute the deltas from the engine if any hole's wolf differs from the assumption above, and use the engine's real output as ground truth (the totals must still be asymmetric and non-empty).

### 5.4 Displayed == settled (replaces 1342-1352)
1. `buildRoundGames([{id:'wolf', stake:'$2'}], ['p1','p2','p3','p4'])` → game emitted (roster 4), `format 'wolf'`, **`settings.pointValue === 2`** (flips the old assertion — wolf now carries the stake the golfer saw).
2. Simulate the in-round pick exactly as `GameResults.updateChoice` writes it: `game = {...game, settings: {...game.settings, wolfHoleChoices: {1:{mode:'lone'}}}}`; add the lone-win scores → net `p1 +6, p2/p3/p4 −2`, non-empty, `sumNet === 0`.
3. Same builder game, stake + scores, no picks → all-zero net, `minimizeTransfers` → `[]`.
4. `buildRoundGames` wolf with `stake: '$0'` → `pointValue undefined` (generic rule, locked for wolf).

### 5.5 Rounding
Integer point deltas × a ≤2dp stake terminate at 2dp — **no residual absorption needed** (unlike skins/vegas pot division); the pointValue-2.5 case in §5.2 is the regression lock.

---

## 6. Shared-types check
- `frontend/src/lib/types.ts`: `wolfOrderPlayerIds` / `wolfHoleChoices` already typed (146-152). **No changes.**
- `backend/app/models.py`: `Game.settings: Optional[dict]` — schemaless; wolf settings already persist in production. **No model change, no migration.** (`ruff check .` runs as a gate anyway since CI runs both sides.)
- Voice: `voice/schemas.ts` already allows optional `pointValue` per game; a voice-created wolf game with a stake now settles — correct, since the stake was explicitly requested (see Risks).

## 7. Gates (all must pass)
```
cd frontend && npm run lint && npx tsc --noEmit && npx vitest run && npm run build && npx tsx voice-tests/runner.ts --smoke
cd backend && ruff check .
```
The decisive gate is `vitest run` with the wolf property-test fixture registered: `SETTLEABLE_FORMATS` must not gain `'wolf'` in any commit where that test does not pass.

## 8. Risks & edge cases
- **Displayed points change (user-visible):** losers now show negative points in GameResults/GameLeaderboards/LeaderboardSheet (same components, same rendering, new values). Honesty-improving and standard for money wolf, but it alters a scoreboard golfers may know — flag to the designer per NORTHSTAR ("designer reviews every user-facing change"); no layout/chrome changes involved.
- **Retroactive money:** legacy builder-produced wolf games have `pointValue undefined` → still settle `{}`. A legacy *voice*-created wolf game that stored `pointValue > 0` will begin settling — correct (stake was asked for), but an unfinalized old round's ledger can change. Finalized rounds are safe: `getPersistedSettlement` reads the stored transfers.
- **Lone-branch tightening** (all 3 opponent scores required) zeroes points on partially-scored lone holes that previously scored against available opponents. Intended; covered by a test; no existing test depended on the loose path.
- **Partner edge data:** invalid `partnerId` (== wolf, absent, not in order) already guarded → $0; keep and cover.
- **9-hole rounds:** unscored holes are $0 by the guards; the fixture's unscored tail (H6-18) locks this.
- **Do not** add residual absorbers or per-hole rounding: integer points × stake is exact; extra "safety" rounding is where zero-sum bugs would creep in.

## 9. NORTHSTAR consistency
No new UI, no new chrome — the stake row and pick UI already exist; this change only makes numbers truthful (displayed == settled), which is the "quiet, honest yardage-book" posture. Voice path untouched ("wolf, no money" keeps working; "wolf at ten" now actually means $10).
