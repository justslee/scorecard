# Tournament Per-Round Game Format — Implementation Plan

**Slice:** Let the golfer pick game formats + stakes per tournament round, so (a) each
tournament round can be a different game, and (b) the already-tested cumulative settlement
engine (`computeTournamentSettlement`) comes alive. NOTICEABLE (new picker UI + populated
settlement).

## 0. Verified findings (do not re-derive)

- **Backend already persists round games — NOT a blocker.** `frontend/src/lib/api.ts:260`
  (`RoundCreate.games?: Game[]`), `backend/app/models.py:169` (`games: list[Game] = []`), and
  `backend/app/routes/rounds.py:320-334` insert one `GameORM` row per game at round creation.
  `_build_full_round` loads them back (`rounds.py:137-141`). **No backend change in this slice.**
- **The Game shape settlement expects** (`frontend/src/lib/settlement.ts:66-74, 303-306`):
  `game.format`, `game.settings.pointValue` (> 0 = money game), `game.playerIds` (falls back to
  round roster if empty). Money math exists for: `skins`, `wolf`, `nassau` (individual),
  `matchPlay`, `threePoint`, `vegas`, `hammer`, `rabbit`, `defender`. `stableford`/`chicago`/etc.
  produce a zero net (harmless).
- **The source pattern** (`frontend/src/app/round/new/page.tsx`): `GameId` union (lines 31-43),
  `GAME_OPTIONS` (66-79), `GAME_ID_TO_FORMAT` (96-107 — note `stroke`, `quota`, `none` have **no**
  entry and are silently skipped), `selectedGames` state (146-149, default
  `[{ id: "stroke", stake: "$5" }]` → produces **zero** game objects), the `gameObjects` build
  block (390-405), the picker-sheet wiring (1240-1266), and `GamePicker` (1785-2022).
- **`GamePicker` is already fully props-driven** — props `{accent, selected, onToggle, onStakeFor,
  onDone}` plus module-level `GAME_OPTIONS`/`T`. Zero coupling to page state. Extraction is a
  cut-paste, not a rewrite.
- **The target** (`frontend/src/app/tournament/[id]/round/new/NewTournamentRoundClient.tsx`):
  `handleStartRound` (line 402) builds `players` from `tournament.playerIds` (413-420) and calls
  `createRound` (433-442) with **no `games`**. The file already imports `T, PAPER_NOISE,
  DEFAULT_ACCENT` (line 10); it does **not** yet import `framer-motion` or `haptic`.
- **A gating gap in the tournament page that would break the E2E check:** in
  `frontend/src/app/tournament/[id]/TournamentPageClient.tsx`, the Games tab's "Settle up" block
  (line 1409) is gated on `hasGames`, which is `tournament.games.length > 0` (**tournament-level**
  games, line 402-403) — per-ROUND games alone would never surface the settlement UI even though
  `computeTournamentSettlement` (line 193) and `hasMoneyGame` (line 404) already read
  `memberRounds[].games`. This plan includes the minimal gate fix (§4).

## 1. Files — new / changed

| File | Change | Responsibility |
|---|---|---|
| `frontend/src/lib/round-games.ts` | **NEW** | Pure shared module: `GameId`, `GameOption`, `GAME_OPTIONS`, `GAME_ID_TO_FORMAT`, `buildRoundGames()`. No React, no side effects. |
| `frontend/src/lib/round-games.test.ts` | **NEW** | Vitest unit tests locking the exact `Game[]` shape (money-adjacent — must be exact). |
| `frontend/src/components/GamePicker.tsx` | **NEW** (moved) | The presentational picker, cut from `page.tsx` unchanged, plus an optional `options` prop (default `GAME_OPTIONS`). |
| `frontend/src/app/round/new/page.tsx` | MOD | Delete local `GameId`/`GAME_OPTIONS`/`GAME_ID_TO_FORMAT`/`GamePicker`; import from the new modules; replace the `gameObjects` block with one `buildRoundGames(...)` call. **Behavior must stay byte-equivalent.** |
| `frontend/src/app/tournament/[id]/round/new/NewTournamentRoundClient.tsx` | MOD | Add optional per-round game selection (card + bottom sheet) and pass `games` into `createRound`. |
| `frontend/src/app/tournament/[id]/TournamentPageClient.tsx` | MOD (small) | Surface per-round games in the Games tab and fix the Settle-up gate so round-level money games render it. |

**Not touched:** `frontend/src/lib/settlement.ts`, `frontend/src/lib/games.ts` (both tested; do
not modify their math), `frontend/src/lib/types.ts` (all shapes already exist — `Game`,
`GameFormat`, `Round.games`), the backend (confirmed above).

## 2. `frontend/src/lib/round-games.ts` — exact contract

```ts
import type { Game, GameFormat } from "./types";

export type GameId =
  | "stroke" | "match" | "skins" | "nassau" | "stable" | "wolf"
  | "vegas" | "bbb" | "bb" | "scr" | "quota" | "none";

export interface GameOption { id: GameId; l: string; sub: string; tag: string | null; }

export const GAME_OPTIONS: GameOption[] = [ /* verbatim from page.tsx:66-79 */ ];
export const GAME_ID_TO_FORMAT: Partial<Record<GameId, GameFormat>> = { /* verbatim from page.tsx:97-107 */ };

/** Formats offered in the TOURNAMENT round picker (see §5 for why). */
export const TOURNAMENT_GAME_IDS: GameId[] = ["none", "skins", "match", "nassau", "stable"];
export const TOURNAMENT_GAME_OPTIONS: GameOption[] =
  TOURNAMENT_GAME_IDS.map((id) => GAME_OPTIONS.find((g) => g.id === id)!);

export function buildRoundGames(
  selected: { id: GameId; stake: string }[],
  playerIds: string[],
  newId: () => string = () => crypto.randomUUID(),
): Game[]
```

**`buildRoundGames` semantics — identical to `page.tsx:392-405`, no drift:**
1. Iterate `selected` in order.
2. `const format = GAME_ID_TO_FORMAT[sel.id]; if (!format) continue;` — this skips `"none"`,
   `"stroke"`, and `"quota"` (unmapped today; keep it that way — do NOT add a quota→chicago
   mapping in this slice, that would change `/round/new` behavior).
3. Stake parse rule, exactly: `const stakeValue = parseFloat(sel.stake.replace("$", "")) || 0;`
   (so `""` → NaN → 0, `"$5"` → 5, `"$12.50"` → 12.5).
4. Push `{ id: newId(), roundId: "", format, name: GAME_OPTIONS.find((g) => g.id === sel.id)?.l ??
   sel.id, playerIds, settings: { pointValue: stakeValue > 0 ? stakeValue : undefined } }`.

The injectable `newId` (defaulting to a **wrapper arrow** `() => crypto.randomUUID()` — never pass
`crypto.randomUUID` unbound, it throws Illegal invocation in some engines) makes the function
deterministic under test so the FULL object shape can be asserted.

**`frontend/src/lib/round-games.test.ts`** (mirror the style of `settlement.test.ts`): with
`newId = () => "g${i++}"` assert — (a) mapping table for every mapped id (`match→matchPlay`,
`skins→skins`, `nassau→nassau`, `stable→stableford`, `wolf→wolf`, `vegas→vegas`,
`bbb→bingoBangoBongo`, `bb→bestBall`, `scr→scramble`); (b) `stroke`/`none`/`quota` produce nothing;
(c) stakes: `"$5"→pointValue 5`, `"5"→5`, `"$0"→undefined`, `""→undefined`, `"$12.50"→12.5`;
(d) `playerIds` passed through verbatim; (e) `roundId === ""`; (f) name comes from the
`GAME_OPTIONS` label; (g) multiple selections preserve order.

## 3. Refactor `/round/new/page.tsx` (regression risk — verify byte-equivalence)

- Delete the local `GameId` type, `GAME_OPTIONS`, `GAME_ID_TO_FORMAT` (lines 31-43, 66-79, 96-107)
  and the `GamePicker` function (1785-2022); import them from `@/lib/round-games` and
  `@/components/GamePicker`.
- Replace the `gameObjects` block (390-405) with:
  `const gameObjects: Game[] = buildRoundGames(selectedGames, deduped.map((p) => p.id));`
- Everything else — default `selectedGames` (`stroke $5`), toggle/none-exclusive logic (1244-1258),
  stake defaults (`nassau→$20`, else `$5`), `haptic("light")` on toggle, offline-fallback
  `games: gameObjects` (line 455) — stays untouched.
- **Risk callout for the builder:** the created round's `games` payload must be byte-equivalent
  before/after (modulo random UUIDs). The unit test in §2 locks the pure part; manually confirm one
  `/round/new` round with skins $5 still creates one game row and the round page's game UI
  (GameResults/SettleUpPanel) is unchanged.

`frontend/src/components/GamePicker.tsx`: verbatim move of the component + its local
`stakes = ["$2","$5","$10","$20"]`, importing `T` from `@/components/yardage/tokens` and
`GameId, GameOption, GAME_OPTIONS` from `@/lib/round-games`. Add one prop: `options?: GameOption[]`
defaulting to `GAME_OPTIONS`, used in place of the hardcoded `GAME_OPTIONS.map(...)` at what is now
the render loop.

**Decision — shared component, not a copy.** `GamePicker` is verified props-only
(accent/selected/onToggle/onStakeFor/onDone); it touches no page state, no hooks, no routing. A copy
would duplicate ~240 lines of money-adjacent UI (stake entry) that would inevitably drift. The one
extension (an `options` prop with a default) keeps `/round/new` rendering pixel-identical. The
bottom-sheet *chrome* (backdrop + spring sheet, `page.tsx:1191-1238`) is NOT extracted — the
tournament flow reproduces that small wrapper locally (it is ~40 lines and the two pages' sheet
stacks differ).

## 4. Tournament flow UI (`NewTournamentRoundClient.tsx`)

**State** (next to `selectedTeeId`, ~line 212):
```ts
const [selectedGames, setSelectedGames] = useState<{ id: GameId; stake: string }[]>([]);
const [showGamePicker, setShowGamePicker] = useState(false);
```
Default `[]` = today's behavior (no games) — the feature is strictly opt-in, and rounds without
games keep the honest-empty settlement.

**Placement:** a third card between the Course card (ends line 739) and the Groups card (starts line
741), matching the existing card grammar exactly (`border: 1px solid T.hairline`, `borderRadius: 14`,
`padding: '12px 14px'`, `background: T.paper`, `marginBottom: 16`). Contents: mono label
`GAME · OPTIONAL` (same style as the `Course` label, lines 663-675), and a full-width tappable row
showing the current selection — serif italic `None — stroke play` when empty, else e.g.
`Skins $5 + Nassau $20` (label + stake per selection) — with the `›` chevron. Tapping opens the
sheet. This is quiet: one more paper card, no new design language. A small serif-italic hint line
("Each round can play a different game.") under the label states the per-round nature in the app's
voice.

**Sheet:** `AnimatePresence` + backdrop + `motion.div` sheet with drag handle, copied from the
established pattern (`page.tsx:1191-1238`, `transition={T.springSoft}`), hosting:
```tsx
<GamePicker
  accent={DEFAULT_ACCENT}
  options={TOURNAMENT_GAME_OPTIONS}
  selected={selectedGames}
  onToggle={(id) => { haptic("light"); /* same reducer as page.tsx:1246-1257: toggle off; default stake nassau→"$20" else "$5"; "none" exclusive */ }}
  onStakeFor={(id, stake) => setSelectedGames((prev) => prev.map((s) => (s.id === id ? { ...s, stake } : s)))}
  onDone={() => setShowGamePicker(false)}
/>
```
New imports: `motion, AnimatePresence` from `framer-motion` (already a dependency), `haptic` from
`@/lib/haptics`, `GamePicker`, and `buildRoundGames, TOURNAMENT_GAME_OPTIONS, GameId` from
`@/lib/round-games`; add `Game` to the existing types import (line 6).

**Wiring into `handleStartRound`** (after the `players` array, line 420):
```ts
const games: Game[] = buildRoundGames(selectedGames, players.map((p) => p.id));
```
and add `games` to the `createRound({...})` call (433-442). `playerIds` = the full tournament roster
for this round — matches what `computeGameNetWinnings` expects and what `/round/new` does.

**Tournament page surfacing (`TournamentPageClient.tsx`) — minimal, two edits:**
1. Near line 403 add `const roundGames = memberRounds.flatMap((r) => (r.games ?? []).filter((g) =>
   g.format !== "settlement"));`
2. Games tab: change the empty-state condition (line 1329) to `!hasGames && roundGames.length === 0`;
   render per-round games using the SAME row markup as the tournament-games rows (1332-1406, reuse
   `FORMAT_LABELS` at ~line 47), each with a small mono sub-line naming its round (courseName · round
   index from `memberRounds` order); and change the Settle-up gate (line 1409) from `{hasGames && (`
   to `{(hasGames || roundGames.length > 0) && (`. The settle-up math, empty-state copy (1424-1439),
   reveal stagger, and haptic (lines 59-66, 255-266) all already exist — do not touch them.

## 5. Scope decisions, edge cases, risks

- **Team formats are OUT of the tournament picker** (`vegas`, `bb`, `scr`) — they need `Game.teams`
  and no team-setup UI exists in this flow; settlement's team math (`settlement.ts:157-203`) reads
  `game.teams` and silently moves no money without it. Also excluded: `wolf` (needs
  `wolfOrderPlayerIds` + per-hole choices and a 4-ball), `bbb` (needs per-hole event capture),
  `quota` (unmapped in `GAME_ID_TO_FORMAT` — offering it would be a dead option), `stroke` (the
  tournament leaderboard IS stroke play; offering a no-op row is noise). **Offered: `none`, `skins`,
  `match` (match play), `nassau`, `stable` (stableford).** Skins/nassau/matchPlay are the three
  no-team formats with real settlement money math; stableford rides along for the games list (it
  settles $0 — honest). Team formats are a natural later slice once a team-assignment sheet exists.
- **Match play with >2 players:** `games.ts:739-741` falls back to `playerIds[0]` vs `playerIds[1]`
  — same behavior as `/round/new` today; acceptable, no new risk. (The picker's "1v1" tag already
  signals it.)
- **Missing handicaps / net:** tournament-round players are built without `handicap`
  (`NewTournamentRoundClient.tsx:413-420`) and `/round/new` never sets `settings.handicapped`, so
  all offered formats compute gross — identical to the existing single-round behavior. No change.
- **No regression to `/round/new`:** the refactor is extract-and-call; §2's unit test plus the
  manual check in §7 guard the payload; `GamePicker`'s default `options` keeps its render identical.
- **No regression for game-less tournament rounds:** default `selectedGames = []` → `games: []` →
  `hasMoneyGames` false → Settle-up stays hidden / honest-empty exactly as now.
- **Offline:** the tournament flow intentionally has no offline round-creation fallback (line 458) —
  unchanged.
- **Animations/haptics (NORTHSTAR):** exactly ONE touch — `haptic("light")` on format toggle, which
  is parity with `/round/new` (line 1245) and the existing tab-switch haptic, plus the sheet's
  existing `T.springSoft` slide. The settlement-appeared haptic and reveal stagger already exist on
  the tournament page. **No confetti, no success celebration — explicitly deferred.**
- **Shared-types sync:** no `types.ts` or `models.py` shape changes; `Game`/`Round.games` already
  match across the boundary (verified §0).

## 6. Sequencing

1. Create `round-games.ts` + `round-games.test.ts`; run vitest (red→green against the copied logic).
2. Extract `GamePicker.tsx`; refactor `/round/new/page.tsx` to consume both; run lint/tsc/build;
   manual `/round/new` spot-check.
3. Add picker card + sheet + `games` wiring to `NewTournamentRoundClient.tsx`.
4. `TournamentPageClient.tsx` gate + round-games listing.
5. Full gates (§7), then the E2E manual check.

## 7. Verification gates (all must pass)

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && npm run build
cd frontend && npx vitest run src/lib/round-games.test.ts src/lib/settlement.test.ts src/lib/tournament-standings.test.ts
```
**End-to-end manual check:** create a tournament with 2+ players → Add Round → pick a course → Game:
select **Skins**, stake **$5** → Start Round → verify the created round's Games UI shows Skins $5 →
enter differing scores on a few holes → open the tournament page → Games tab lists "Skins · $5/pt"
under the round, and **Settle up** shows the minimized transfer (e.g. "Bob → Alice $x"). Then create
a second round with **Match play $10** and confirm the settlement is cumulative across both
(different formats per round = the owner's ask). Also re-verify a plain `/round/new` skins round is
unchanged, and a tournament round created with **no** game still shows "No money games in this
tournament."
