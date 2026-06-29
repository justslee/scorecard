# Implementation Plan — `social-partner-profile`

Partner profile detail screen at `/players/view?id=…`, reached by tapping a player in the
`/players` roster. Frontend-first, read-only, reuses existing data only. Mirrors the
yardage-book `courses/[id]` pattern.

## Hard constraints (restated, enforced by this plan)
- NO cross-account friend graph.
- DO NOT touch the `require_owner` auth gate.
- NO new backend aggregation endpoint this cycle (shared rounds derived client-side).
- NO new dependencies, NO new design language, NO `lucide-react`.
- `frontend/src/lib/types.ts` stays untouched — no model changes needed.
- Frontend only.

## Verified basis for "shared rounds" (the chosen derivation)
When a player is added to a round from the saved roster, the round's `Player.id` is the
`SavedPlayer.id`. Confirmed in `frontend/src/app/round/new/page.tsx`:
- Roster match path: `return saved ? { id: saved.id, name: saved.name, handicap: saved.handicap } : { id: \`custom-player-${i}\`, ... }` (~line 187).
- Tee-off resolution: `const newId = p.id.startsWith("custom-player-") ? crypto.randomUUID() : p.id;` (~line 250) — only custom slots get a random UUID; saved ids pass through unchanged.

Therefore: `sharedRounds = rounds.filter(r => r.players.some(p => p.id === playerId))`, sorted by
`date` descending. Custom (non-saved) participants get random UUIDs and never match a
`SavedPlayer.id`, which is correct — they have no profile. **There is no cleaner existing
signal**: `Round` has no separate saved-player linkage field, and `SavedPlayer.roundsPlayed`
is only a stored counter (no round ids). The id-membership derivation is the right one.

---

## 1. New files and exact responsibilities

### 1a. `frontend/src/lib/player-url.ts`
Mirror `course-url.ts` / `round-url.ts` exactly, including the static-export shim rationale in
the header comment (dynamic-path → hard nav → Capacitor index.html fallback → AuthGate hang;
fix = one static path + `?id=` read client-side). Exports:
```ts
export const PLAYER_VIEW_SEGMENT = "view";
export function playerHref(id: string): string {
  return `/players/${PLAYER_VIEW_SEGMENT}?id=${encodeURIComponent(id)}`;
}
```
Signature note: `id` is a `string` (SavedPlayer.id is always a string), so — unlike
`courseHref` — no `String(...)` coercion and no second arg. Keep it minimal.

### 1b. `frontend/src/lib/partner-rounds.ts` (pure, unit-testable)
A standalone pure module (NOT co-located in the client component) so it can be unit-tested
without React. Single export:
```ts
import type { Round } from "./types";
export function getSharedRounds(rounds: Round[], playerId: string): Round[] {
  if (!playerId) return [];
  return rounds
    .filter(r => r.players.some(p => p.id === playerId))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}
```
Rationale for separate file: matches the repo convention where derivable logic lives in
`lib/*.ts` with a sibling `lib/*.test.ts` (e.g. `round-owner.ts` + `round-owner.test.ts`,
`profile-stats.ts` + `.test.ts`). Sort uses the codebase's established desc pattern
(`new Date(b.date).getTime() - new Date(a.date).getTime()`). Returns a NEW array (does not
mutate the caller's `rounds`).

### 1c. `frontend/src/app/players/view/page.tsx` (Suspense shell)
Mirror `courses/[id]/page.tsx` MINUS `generateStaticParams`:
```tsx
import { Suspense } from "react";
import PartnerProfileClient from "./PartnerProfileClient";
export default function Page() {
  return (
    <Suspense>
      <PartnerProfileClient />
    </Suspense>
  );
}
```
**Why NO `generateStaticParams`:** `generateStaticParams` is required only for *dynamic*
segments (`courses/[id]`, `round/[id]`) to tell the static export which param values to emit.
`players/view` is a *literal* folder route — exactly like `round/new` (which is
`src/app/round/new/page.tsx` and emits `out/round/new` with no `generateStaticParams`). A
literal route is always emitted. Verified: `out/round/new` exists and `round/new/page.tsx` has
no `generateStaticParams`. So `npm run build` will emit `out/players/view` automatically.
The `<Suspense>` boundary IS still required because the client reads `useSearchParams()`
(static-export prerender bails to CSR at that boundary — same reason as CourseDetailClient).

### 1d. `frontend/src/app/players/view/PartnerProfileClient.tsx`
`"use client"`. Responsibilities:
- Read id: `const id = useSearchParams().get("id")`.
- `useRouter()` for back navigation and shared-round taps.
- Load data in one effect (see section 2). State: `player: SavedPlayer | null`,
  `rounds: Round[]`, `loading: boolean`.
- Derive `const shared = useMemo(() => getSharedRounds(rounds, id ?? ""), [rounds, id])`.
- Render the four states (section 2) using ONLY the yardage-book grammar from
  `CourseDetailClient.tsx`: `T.*` tokens + `PAPER_NOISE`, `T.serif` italic for the name,
  `T.mono` uppercase kickers, the `MiniStat` sub-component (copy its shape), dashed-divider
  rows for the shared-round list (`borderTop: i === 0 ? "none" : \`1px dashed ${T.hairline}\``,
  `minHeight: 44`). Reuse the inline `←` back-button styling from CourseDetailClient.
  NO `lucide-react`; if any glyph is needed use a unicode char like the existing `←`/`→`.

**Loaded layout (top → bottom):**
- Back button `← Players` → `router.push("/players")`.
- Kicker `Partner` (mono, uppercase).
- Name (serif italic, 32px) + optional nickname (rendered like the roster row:
  italic `T.pencil` in quotes).
- MiniStats row: `Handicap` (from `player.handicap`, only if defined) and `Rounds played`
  (from `player.roundsPlayed`). Use the same MiniStat as CourseDetailClient.
- Section `Recent rounds together` (mono kicker). For each `shared` round: a dashed row
  showing `round.courseName` (serif) + formatted `round.date` (mono, e.g.
  `new Date(r.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })`),
  whole row taps to `router.push(roundHref(round.id))` (import from `lib/round-url.ts`).
- If `shared.length === 0`: quiet single line `No rounds together yet.` (serif italic,
  `T.pencilSoft`) — DO NOT invent data.

---

## 2. Data loading + states

**Chosen approach: list-and-find via `getPlayersAsync()` + `getRoundsAsync()` in one effect.
Do NOT add `getPlayerAsync` to storage-api.ts.**

Justification:
- We must call `getRoundsAsync()` anyway to derive shared rounds, so one effect already
  fetches the rounds list. Fetching the player from the same already-loaded list keeps a
  single offline-resilient code path.
- `getPlayersAsync()` is offline-cache resilient (falls back to `localCache.getSavedPlayers()`
  on API failure). A new `getPlayerAsync` wrapping `api.getPlayer(id)` would either need its
  own cache-fallback logic (duplicating storage-api semantics) or would hard-fail offline —
  worse than list-and-find. `api.getPlayer` exists but is not the right call here.
- Avoids touching `storage-api.ts` at all (smaller surface, fewer review/test obligations).

Effect sketch:
```ts
useEffect(() => {
  if (!id) { setLoading(false); return; }
  let cancelled = false;
  (async () => {
    setLoading(true);
    try {
      const [players, allRounds] = await Promise.all([getPlayersAsync(), getRoundsAsync()]);
      if (cancelled) return;
      setPlayer(players.find(p => p.id === id) ?? null);
      setRounds(allRounds);
    } catch {
      if (!cancelled) { setPlayer(null); setRounds([]); }
    } finally {
      if (!cancelled) setLoading(false);
    }
  })();
  return () => { cancelled = true; };
}, [id]);
```

**States (mirror CourseDetailClient styling exactly):**
1. **loading** — calm centered mono `Loading…` shell on `PAPER_NOISE` paper (copy
   CourseDetailClient's loading block verbatim in structure).
2. **missing id** (`!id`) — render the same empty state as #3.
3. **unknown player** (`!loading && !player`) — calm empty state: serif italic
   `Player not found.`, mono sub-line (e.g. `They may have been removed from your players.`),
   and a `Back to players` pill button → `router.push("/players")`. NO crash. (Mirror the
   `Course not found.` block.)
4. **loaded** — the layout in 1d. Zero shared rounds is a *normal* loaded sub-state (quiet
   line), NOT an error.

---

## 3. Make `/players` rows tap through while preserving edit (least-disruptive)

Current: each row is a single `<motion.button onClick={() => openEditPlayer(player)}>` inside
`SwipeableRow`. Goal: row body → profile; edit still reachable; swipe-to-delete intact.

**Chosen approach (simplest that keeps both, stays inside SwipeableRow):**
Keep the existing `<motion.button>` as the row body but change its `onClick` to navigate to the
profile, and add ONE small inline `Edit` control at the right end of the row for the edit
affordance.

Concretely, in `frontend/src/app/players/page.tsx`:
- Add `import { useRouter } from 'next/navigation';` and `import { playerHref } from '@/lib/player-url';`; `const router = useRouter();` in the component.
- Row button: `onClick={() => router.push(playerHref(player.id))}`, update
  `aria-label` to `View ${player.name}`.
- Add a small trailing edit control INSIDE the row, after the Info block (before/near the
  `Linked` badge). It is a real nested interactive element, so it must be a `<span role="button">`
  / styled element whose handler calls `e.stopPropagation()` then `openEditPlayer(player)` —
  NOT a `<button>` nested inside the row `<button>` (invalid HTML / hydration issue). Pattern:
  ```tsx
  <span
    role="button"
    tabIndex={0}
    aria-label={`Edit ${player.name}`}
    onClick={(e) => { e.stopPropagation(); openEditPlayer(player); }}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openEditPlayer(player); } }}
    style={{ /* mono uppercase "Edit", T.pencil, min 44x44 tap target, flexShrink:0 */ }}
  >
    Edit
  </span>
  ```
  Use a text `Edit` label (or the existing inline pencil-free style) — NO new icon import.

Why this over alternatives:
- It is the minimal diff: the row stays a `motion.button` inside `SwipeableRow`, so
  swipe-to-delete (the outer `SwipeableRow` drag handler) is untouched. The nested edit control
  only `stopPropagation`s its own click so it never triggers the row navigation, and being a
  `<span>` (not `<button>`) avoids nested-button invalid markup.
- "Edit lives only on the profile" was rejected as more disruptive this cycle (would require
  adding an edit entry point + modal to the new screen). Designer reviews final affordance per
  spec (the inline `Edit` text vs a pencil).

Note for the builder: confirm a nested `role=button` span inside a `motion.button` does not
trip the existing eslint config; if it does, the fallback is to convert the row body from
`<motion.button>` to a `<motion.div role="button" tabIndex={0}>` with keyboard handlers and put
both the navigate handler (on the div) and the edit span as siblings — slightly larger diff but
fully valid. Prefer the span-stopPropagation version first.

---

## 4. Unit tests to add

### 4a. `frontend/src/lib/player-url.test.ts` (mirror `course-url.test.ts`)
- builds a basic href: `playerHref("abc")` === `/players/${PLAYER_VIEW_SEGMENT}?id=abc`.
- encodes a space: `playerHref("John Smith")` → `...?id=John%20Smith`.
- encodes an ampersand: `playerHref("a&b")` → `...?id=a%26b`.
- encodes unicode: `playerHref("café")` → `...?id=caf%C3%A9`.
- encodes a slash / UUID-with-special char round-trips through `encodeURIComponent`.
- (Import and assert against `PLAYER_VIEW_SEGMENT`, never the literal "view".)

### 4b. `frontend/src/lib/partner-rounds.test.ts`
Build minimal `Round` fixtures (only the fields used: `id`, `date`, `players: [{id,name}]`;
cast via a small helper or `as Round` to avoid filling every field). Cases:
- **membership**: returns rounds where some `player.id === playerId`.
- **exclusion**: rounds with only other players (incl. custom UUID ids) are excluded.
- **sort**: result is date-descending (give rounds with out-of-order dates, assert order).
- **empty**: unknown playerId → `[]`; empty `rounds` → `[]`; empty `playerId` string → `[]`.
- **non-mutation**: original `rounds` array order is unchanged after the call (optional but cheap).

Place both in `src/lib/` next to the modules they test (repo convention). Run via `npx vitest run`.

---

## 5. Edge cases & risks
- **Missing `?id=`** → render not-found empty state, no crash (handled by `!id` short-circuit).
- **Unknown id** (deleted player / stale link) → `find` returns undefined → not-found state.
- **Zero shared rounds** → quiet `No rounds together yet.` line; never fabricate.
- **Custom-player ids never match** → correct by design (they are random UUIDs); covered by an
  exclusion test.
- **Encoding** → `playerHref` uses `encodeURIComponent`; `useSearchParams().get("id")` decodes;
  covered by url tests.
- **Static-export route emission** → `players/view` is a literal route → emitted as
  `out/players/view` automatically (verified by analogy with `out/round/new`). The `build` gate
  is the proof; check `out/players/view` exists after build.
- **SwipeableRow swipe-to-delete** → must remain functional. Risk: the nested edit control or
  the new navigate handler swallowing the drag. Mitigation: keep the body a single
  `motion.button` (drag is owned by the outer `SwipeableRow` `motion.div`), and only
  `stopPropagation` on the edit span's click (not pointer/drag events). Manually verify a swipe
  still reveals the trash + confirm dialog.
- **No `lucide-react`** → use existing inline SVG icons / unicode glyphs only.
- **Nested interactive elements** → edit control is a `role="button"` span, not a nested
  `<button>`, to avoid invalid HTML / hydration warnings.
- **Offline resilience** → list-and-find through `getPlayersAsync`/`getRoundsAsync` falls back
  to local cache; no hard dependency on a live API.
- **`roundHref` import** → reuse existing `lib/round-url.ts`; do not re-implement.
- **types.ts untouched** → confirmed no new fields needed; `SavedPlayer` + `Round` already
  carry everything the screen reads.

---

## 6. Gates (run from `frontend/`, paste output)
```
cd frontend
npm run lint
npx tsc --noEmit
npx tsx voice-tests/runner.ts --smoke      # expect 265/265
npx vitest run
npm run build                               # then confirm out/players/view emitted
```
After `npm run build`, verify `out/players/view` (and `out/players/view.html`) exist — the
static-export emission check for the new route.

---

## Out of scope (follow-ups, do NOT build)
- Backend shared-rounds aggregation endpoint.
- Friend graph / cross-account linking (`social-friend-graph`).
- Any change to `require_owner` / auth gating.
- `designer` agent review of the new screen + changed `/players` row affordance (runs after build).

## Files touched (summary)
New: `frontend/src/lib/player-url.ts`, `frontend/src/lib/partner-rounds.ts`,
`frontend/src/app/players/view/page.tsx`,
`frontend/src/app/players/view/PartnerProfileClient.tsx`,
`frontend/src/lib/player-url.test.ts`, `frontend/src/lib/partner-rounds.test.ts`.
Modified: `frontend/src/app/players/page.tsx` (row tap-through + inline edit control).
Untouched: `frontend/src/lib/types.ts`, `frontend/src/lib/storage-api.ts`,
`require_owner` gate, all backend files.
