# Tournament Settlement Honesty — Implementation Plan

**Principle:** [[no-fake-data-fallbacks]] — the app must never display a money term it won't
honor. Displayed stake == settled stake, everywhere, deterministically.

Plan authored on the `fable` model (2026-07-06), grounded against the code file:line.

## 1. Verified current behavior (all claims checked against code)

### Bug 1 — Stake mirage: formats that show a stake but settle $0

**The only writer of `settings.pointValue` for new games is `buildRoundGames`** (verified by
project-wide grep): `frontend/src/lib/round-games.ts:88` — `settings: { pointValue: stakeValue
> 0 ? stakeValue : undefined }` for **any** format in `GAME_ID_TO_FORMAT` (lines 49–59, includes
`stable→stableford`, `bbb→bingoBangoBongo`, `bb→bestBall`, `scr→scramble`, `vegas→vegas`).

**Settlement never pays those formats.** `frontend/src/lib/settlement.ts:13-14` (header):
"Formats without a clear monetary result (bestBall, scramble, stableford, chicago,
bingoBangoBongo, trash) are skipped". `computeGameNetWinnings` (line 66) has branches only for:
skins (87), wolf (110), nassau-individual (121), matchPlay (145), threePoint (157), vegas (181),
hammer (208), rabbit (219), defender (236). A stableford game with `pointValue=5` passes the
`moneyGames` filter (`settlement.ts:304-306`, `pointValue > 0`), gets all players initialized to
$0 (lines 76–78), hits no branch, and returns an **all-zeros record** — worse than nothing:
`computeNetSettlement.isEmpty` is key-count-based (lines 323–327), so a stableford-only "money"
round renders a fabricated $0 settlement rather than none. (`computeTournamentSettlement` uses a
dust check at line 363 and is honest; the two are inconsistent.) `hasMoneyGames` (376–382) also
returns `true` for stableford-with-pointValue.

**The UI offers the stake anyway:**
- `frontend/src/components/GamePicker.tsx:74` — `takesStake = g.id !== "none"`: every format
  except "none" shows the $2/$5/$10/$20 + custom stake row (lines 167–225).
- Tournament consumer: `frontend/src/app/tournament/[id]/round/new/NewTournamentRoundClient.tsx:1276`
  — toggle defaults `stake: id === 'nassau' ? '$20' : '$5'`; summary at line 805 renders
  `` `${label} ${sel.stake}` `` → "Stableford $5".
- `/round/new` consumer: `frontend/src/app/round/new/page.tsx:1199` — same default; and the page
  **default selection is `[{ id: "stroke", stake: "$5" }]`** (lines 106–108) — `stroke` isn't even
  in `GAME_ID_TO_FORMAT` (`round-games.ts:80` skips it), so the very first thing a golfer sees in
  the picker is a $5 stake on a format that produces no game at all. Same for `quota`.
- Downstream displays repeat the mirage for persisted games: `TournamentPageClient.tsx:1488-1498`
  and `1571-1581` render "$X / pt" for any game with pointValue; `components/yardage/LeaderboardSheet.tsx:58-59`
  renders "Stableford · $5"; `GameLeaderboards.tsx:93`.

**Additional finding (same class, new mechanism) — vegas:** `buildRoundGames` never constructs
`teams`, `computeVegas` requires them (`games.ts:959-968`; empty teams → every hole null → totals
0), settlement's vegas branch distributes over `game.teams` members (`settlement.ts:199-201` →
no-op), and **no team-assignment UI exists anywhere** (`GameResults.tsx` only edits wolf choices,
lines 453–466). So picker-created Vegas with a stake settles $0, always. Vegas is "settleable in
principle" but **not constructible by the picker** — the honest predicate must account for both.

**Wolf roster subtlety:** wolf legitimately settles (choices are recorded in-round via
`GameResults.tsx:453-466`), but the engine is 4-player: `computeWolf` (`games.ts:806-809`) cycles
`order[(hole-1)%4]` and with roster ≠ 4 falls back to `round.players.slice(0,4)` — a 5+-player
round silently drops players from a money game (match-play's bug class), and a 3-player round
silently skips every 4th hole.

**Voice path — verified clean, no change needed:** the active voice round setup
(`VoiceRoundSetupRealtime.tsx` → its `onSetupRound` prop, lines 42–47) passes only
`courseName/playerNames/teeName`; the realtime tool's `gameFormat` arg (line 38) is received and
dropped; the backend `/parse-round-setup` schema is course/players/tee only
(`backend/app/routes/voice_advanced.py:230-264`). The only pointValue-bearing voice path —
`lib/voice-parser.ts:116` `parseVoiceCommand` → `/api/voice/parse-transcript`
(`voice_advanced.py:435`) — is **dead code**: grep finds no frontend consumer.
`lib/voice/schemas.ts:19` `pointValue` flows only into `tournament-prefill.ts`, which uses the
*tournament* branch exclusively (lines 22–24). Voice-tests assert only format detection
(`voice-tests/corpus/curated.ts:77-82`), never a stake. The picker copy "say: skins at ten"
(`GamePicker.tsx:65-68`) is aspirational display copy — nothing parses it into a stake today.

### Bug 2 — Match play silently drops players 3+

`frontend/src/lib/games.ts:739-741`: `p1 = game.settings.matchPlayPlayers?.player1Id ??
game.playerIds[0]`, `p2 = ... ?? game.playerIds[1]` — only ever two players. `buildRoundGames`
passes the **full roster** as `playerIds` (`round-games.ts:87`); the tournament consumer passes
**all tournament players** (`NewTournamentRoundClient.tsx:421-431`). Settlement's matchPlay branch
(`settlement.ts:145-152`) moves money only between winner/loser of that pair; everyone else was
initialized to $0 (lines 76–78) — in the game, showing a stake, guaranteed to settle $0. An
8-player tournament offering "Match play $5" is a 6-player mirage. No picker path sets
`matchPlayPlayers`.

## 2. Chosen fixes and why

### Bug 1 → **Honest-label (do not offer the stake), NOT invent settlement**
There is no canonical zero-sum money convention for plain stableford (points-vs-field payouts vary
by group; quota — the "beat your number" money variant — already exists as a separate format).
Inventing math in `settlement.ts` would itself fabricate money terms. Same for bbb/bb/scr. The fix
is a **single source of truth for "this format moves money"**, consumed on both the write side
(picker/builder) and the read side (settlement of legacy data):

- Export `SETTLEABLE_FORMATS: ReadonlySet<GameFormat>` from `settlement.ts` = exactly the nine
  formats `computeGameNetWinnings` handles: `skins, wolf, nassau, matchPlay, threePoint, vegas,
  hammer, rabbit, defender`.
- In `round-games.ts`, derive `STAKE_GAME_IDS` = mapped ids whose format is settleable **and
  constructible by the picker** (no teams needed) = **`{skins, match, nassau, wolf}`**. Vegas is
  excluded (team-only, unconstructible — documented in code with a `TEAM_ONLY_FORMATS` note);
  stable/bbb/bb/scr excluded (not settleable); stroke/quota/none never had a format.
- Also apply `SETTLEABLE_FORMATS` inside `computeGameNetWinnings` (early-return `{}` for unhandled
  formats) and the `moneyGames`/`hasMoneyGames` filters — so **legacy persisted** stableford-$5
  games stop producing fabricated $0 ledgers and stop flipping `hasMoneyGames` on (fixes the
  round-level `isEmpty` dishonesty at `settlement.ts:323-327`).

Scope: **fix shared, not tournament-only.** The module is already shared; forking it to protect
`/round/new` would duplicate money-adjacent code and leave live mirages (including the default
"stroke $5"). This **deliberately breaks PR #135's "byte-equivalent /round/new" guarantee** — the
lock was preserving dishonest behavior; the locked tests get updated intentionally, and the
PR/progress note must say so. (PR #135's own follow-ups section already names both bugs.)

Northstar fit: calm = no warnings/toasts; the stake row simply doesn't appear for points-only
formats, plus one quiet italic line in the selected card ("Points game — no money settlement") so
the absence reads as intent, not omission. Tags like `stable: "Net"` stay; no new chrome.

### Bug 2 → **Prevent (not label, not invent pairing), generalized as roster requirements**
- Add `ROSTER_REQUIREMENT: Partial<Record<GameId, number>> = { match: 2, wolf: 4 }` +
  `gameSelectableForRoster(id, rosterSize)` in `round-games.ts`. (Wolf rides along because it is
  the same silent-drop class for rosters ≠ 4 — `games.ts:806-809`; one mechanism, two entries. If
  the implementer judges wolf out of slice, ship `{ match: 2 }` and file wolf as follow-up — but
  say so.)
- `GamePicker` renders unmet-requirement rows disabled (non-toggleable) with calm sub-copy:
  "Match play is 1v1 — opponent picker coming." / "Wolf needs a foursome."
- Consumers pass `rosterSize` (tournament: `tournament.playerIds.length`; round/new: current named
  players) and **prune** a selected id when a roster edit invalidates it (round/new lets you add a
  3rd player after selecting match) — the visible `gameLabel` (page.tsx:417-422) reflects pruning.
- **Defense-in-depth in `buildRoundGames`:** never emit a game whose roster requirement is unmet
  (skip, never truncate). A truncated match must be unrepresentable at the builder boundary
  regardless of UI state.

Why prevent over label: a labeled-but-truncated match still silently zeroes players 3+ in a money
game; and inventing a pairing/bracket is a product decision. **Owner follow-up (deferred,
product-shaped):** opponent-picker UI for match play (`settings.matchPlayPlayers` already exists in
the engine, `games.ts:740-741`), team-assignment UI (unlocks vegas/bestBall/scramble/threePoint
stakes), wolf 3-player engine support, stableford/quota payout conventions if the owner ever wants
them.

## 3. Implementation steps

1. **`frontend/src/lib/settlement.ts`** — export `SETTLEABLE_FORMATS`; early-return `{}` in
   `computeGameNetWinnings` for non-members; use the set in the `moneyGames` filter (304–306) and
   `hasMoneyGames` (376–382); update the header comment (10–15) to point at the exported set.
2. **`frontend/src/lib/round-games.ts`** — import the set; export `STAKE_GAME_IDS` (derived:
   mapped ∩ settleable ∖ team-only `{vegas}`), `ROSTER_REQUIREMENT`, `gameSelectableForRoster`; in
   `buildRoundGames` set `pointValue` only for `STAKE_GAME_IDS` members and skip games with unmet
   roster requirements.
3. **`frontend/src/components/GamePicker.tsx`** — line 74 becomes `takesStake =
   STAKE_GAME_IDS.has(g.id)`; new optional `rosterSize` prop → disabled state + honest sub-copy for
   unmet requirements; quiet "points only" line in selected no-stake cards. No new design language
   (yardage tokens only).
4. **Both consumers** — default stake only for stake-taking ids (`''` otherwise); pass `rosterSize`;
   prune invalid selections on roster change; tournament summary (NewTournamentRoundClient.tsx:805)
   renders the stake suffix only for stake-taking ids; `/round/new` default becomes
   `[{ id: "stroke", stake: "" }]` (page.tsx:106-108). Nassau keeps its $20 default (it settles:
   `settlement.ts:121-141`).
5. **Read-side display honesty (small, recommended)** — gate the "$X / pt" chips
   (`TournamentPageClient.tsx:1488,1571`) and `LeaderboardSheet.tsx:58` "· $X" suffix on
   `SETTLEABLE_FORMATS`, so legacy stableford-$5 rows stop advertising money. (`GameLeaderboards.tsx`
   renders per-format cards; its money copy only exists for settleable formats — verify while there.)
6. **No `types.ts`/`models.py` changes** — no shared shape is touched (`pointValue` stays optional;
   we just stop writing it dishonestly). Backend untouched; `ruff` gate still runs.

## 4. Edge cases & risks
- **Voice**: no active path writes `pointValue` (evidence in §1) — no voice change needed; verify
  `npx tsx voice-tests/runner.ts --smoke` stays green (it asserts format detection only). Note the
  dead `voice-parser.ts` stake path and the "skins at ten" copy for whenever stakes-by-voice ships —
  it must route through `STAKE_GAME_IDS`.
- **Legacy persisted rounds** with stableford/vegas pointValue: handled by the read-side filter
  (step 1) — they become honest non-money games rather than $0 ledgers.
- **Existing tests intentionally change** (`round-games.test.ts` was PR #135's byte-equivalence
  lock): line 29 builds every mapped id with roster `["p1"]` (match/wolf now need 2/4); lines 48–62
  expect `match "5"→5` and `vegas "$12.50"→12.5` (vegas becomes `undefined`, match needs a 2-roster).
  Update, don't delete.
- **Round/new roster edits after selection** — pruning effect covered above; builder guard is the
  backstop.
- Wolf with roster exactly 4 keeps its stake — an unscored/unchosen wolf settles $0 the same honest
  way an unscored skins game does (choices are live round data, `GameResults.tsx:453-466`).

## 5. Deterministic test matrix (money math — mandatory)

**`frontend/src/lib/round-games.test.ts`** (exists — update + add):
- Invariant: `STAKE_GAME_IDS` equals exactly `{skins, match, nassau, wolf}` AND every member's
  `GAME_ID_TO_FORMAT` value ∈ `SETTLEABLE_FORMATS` (import both — the sets can never drift).
- For every non-stake id (`stable, bbb, bb, scr, vegas, stroke, quota, none`) built with
  `stake: "$5"`: any emitted game has `settings.pointValue === undefined` — **stableford displays no
  stake and settles $0, consistently**.
- `buildRoundGames` never returns a `matchPlay` game with `playerIds.length !== 2` (rosters of 1,
  3, 4 → no matchPlay emitted; roster 2 → emitted with both ids) and never a `wolf` game with roster
  ≠ 4.
- Updated stake-rule and full-shape assertions for skins/nassau (unchanged behavior for settleable
  formats — displayed stake == `pointValue`).

**`frontend/src/lib/settlement.test.ts`** (exists — add):
- Stableford game with `pointValue: 5` on a fully-scored round → `computeGameNetWinnings` returns
  `{}`; `computeNetSettlement(...).isEmpty === true`; `hasMoneyGames([round]) === false`.
- Zero-sum holds for **every** member of `SETTLEABLE_FORMATS` (skins/wolf/nassau/matchPlay/vegas/
  hammer/rabbit/defender already covered at lines 130–673; **threePoint has no describe block — add
  one**).
- Displayed==settled: for each `STAKE_GAME_IDS` id, a builder-produced game with `pointValue > 0`
  and a decided score yields a non-empty, zero-sum `computeGameNetWinnings` record.

**`frontend/src/components/GamePicker.test.tsx`** (new; component tests are established practice —
e.g. `CourseSearch.test.tsx`): stableford selected → no stake row rendered; skins selected → stake
row rendered; `rosterSize={3}` → match row disabled with the 1v1 copy and `onToggle` not fired on
click.

## 6. Gates
`cd frontend && npm run lint` · `npx tsc --noEmit` · `npx tsx voice-tests/runner.ts --smoke` ·
`npx vitest run` · `npm run build`; `cd backend && ruff check .`

## Critical files
- frontend/src/lib/settlement.ts
- frontend/src/lib/round-games.ts
- frontend/src/components/GamePicker.tsx
- frontend/src/app/tournament/[id]/round/new/NewTournamentRoundClient.tsx
- frontend/src/app/round/new/page.tsx
