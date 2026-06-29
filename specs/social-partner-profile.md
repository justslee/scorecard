# social-partner-profile — Partner profile detail (`/players/view?id=…`)

Epic: social-playing-partners (A2). Classification: **noticeable** (new user-visible screen).
Scope: **frontend-first, read-only.** Reuse existing data. DO NOT build the cross-account
friend graph and DO NOT touch the `require_owner` gate (owner decision).

## Goal
A calm, read-only partner profile reachable by tapping a player in the `/players` roster.
Shows what we already know about a saved player: name/nickname, handicap, rounds played,
and recent **shared rounds** if derivable from existing round data.

## Why this is buildable now
- `GET /api/players/{id}` already exists (owner-scoped: `backend/app/routes/players.py:56`)
  and `api.getPlayer(id)` already exists (`frontend/src/lib/api.ts:202`).
- `SavedPlayer` (`types.ts:51`) carries `name, nickname, handicap, avatarUrl, roundsPlayed,
  clerkUserId`.
- **Shared rounds ARE derivable client-side.** When a player is added to a round from the
  saved roster, the round's `Player.id` is set to the `SavedPlayer.id`
  (`round/new/page.tsx:187,250` — saved players keep their id; only custom players get a
  random UUID). So shared rounds = rounds where `round.players.some(p => p.id === playerId)`.
  Custom (non-saved) participants never match, which is correct — they have no profile.

## Build

### 1. URL helper — `frontend/src/lib/player-url.ts`
Mirror `course-url.ts` / `round-url.ts` exactly (static-export shim rationale in the header
comment). Export:
- `PLAYER_VIEW_SEGMENT = "view"`
- `playerHref(id: string): string` → `/players/${PLAYER_VIEW_SEGMENT}?id=${encodeURIComponent(id)}`

### 2. Static route shell — `frontend/src/app/players/view/page.tsx`
Mirror `courses/[id]/page.tsx`? NO — `/players` is a real folder route, not `[id]`. Use a
plain `players/view/page.tsx` with `export const dynamic = 'force-static'` is not needed;
follow the courses pattern: a server `page.tsx` that renders `<Suspense><PartnerProfileClient/></Suspense>`.
(There is no `[id]` segment to statically param here — `players/view` is itself the static
path, so no `generateStaticParams` is required. Confirm `npm run build` emits `out/players/view`.)

### 3. Client — `frontend/src/app/players/view/PartnerProfileClient.tsx`
- `"use client"`. Read `id` from `useSearchParams().get("id")`.
- Load the player: reuse `getPlayersAsync()` (offline-cache resilient) and find by id, OR
  add `getPlayerAsync(id)` to `storage-api.ts` mirroring the other wrappers (prefer the
  list-and-find approach to also fetch rounds in one place and stay offline-resilient).
  Load rounds via `getRoundsAsync()`.
- States (mirror CourseDetailClient styling):
  - **loading** — calm "Loading…" mono shell.
  - **missing/unknown id** — calm empty state ("Player not found." serif italic + "Back to
    players" button). NO crash.
  - **loaded** — header kicker "Partner", serif name, optional nickname, mini-stats (Handicap,
    Rounds played from `roundsPlayed`), and a "Recent rounds together" section listing shared
    rounds (course name + date), each tapping through to `roundHref(round.id)`. If there are
    zero shared rounds, show a quiet "No rounds together yet." line — do NOT invent data.
- Back button → `router.push("/players")`.
- Styling: reuse the yardage-book tokens (`T.*`, `PAPER_NOISE`) and the exact visual
  grammar of `CourseDetailClient.tsx` (kicker/serif-name/MiniStat/dashed-row list). NO new
  design language. NO lucide-react.

### 4. Make `/players` rows tap through
In `frontend/src/app/players/page.tsx`, the row is currently a `<motion.button>` whose
onClick opens the edit modal. Add navigation to the profile WITHOUT removing edit:
- Wrap/convert the row so the main body navigates to `playerHref(player.id)` (use `useRouter`
  push so it stays client-side; keep it inside `SwipeableRow`).
- Preserve an edit affordance (the existing "tap row = edit" can move to a small edit control,
  OR row tap → profile and edit stays reachable from the profile / a pencil). Builder picks the
  least-disruptive option; the simplest is: row tap → profile; keep edit via a small inline
  "Edit" control on the row. Designer reviews the final affordance.

### 5. Pure helper + tests
- Add `getSharedRounds(rounds: Round[], playerId: string): Round[]` (pure; sorted most-recent
  first by `date`), either in `player-url.ts` sibling `lib/partner-rounds.ts` or co-located.
- `vitest`: test `playerHref` (basic, encoding, special chars — mirror `course-url.test.ts`)
  and `getSharedRounds` (matches by id, excludes non-members, sort order, empty result).

## Out of scope (note as follow-ups, do NOT build)
- Backend shared-rounds aggregation endpoint (client derivation is sufficient this cycle).
- Friend graph / cross-account linking (`social-friend-graph`).
- Any change to `require_owner` / auth gating.

## Gates (paste output)
`cd frontend`: `npm run lint` · `npx tsc --noEmit` · `npx tsx voice-tests/runner.ts --smoke`
(265/265) · `npx vitest run` · `npm run build`.

## Designer
Run the `designer` agent against the new screen + the changed `/players` row affordance vs
NORTHSTAR (yardage-book, calm, voice-first-respecting).
