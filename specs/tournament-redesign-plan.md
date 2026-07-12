# Tournament Setup Redesign — "The Program"

Design-led redesign of the tournament SETUP page (plus one double-rule touch on the
view page). The designer's concept is the CONTRACT — this plan encodes it exactly and
adds edit points, edge cases, and gates. **Presentation only: zero behavioral change.**

## Concept (verbatim contract)

The setup page is the club **typesetting the program for the event** — the program
composes live as the form is filled. Ceremony through typography, numbering, and rules
(the printed kind), not decoration. Instrument Serif / on-paper / restrained palette per
`NORTHSTAR.md`. No confetti, no gradients, no dashboard chrome, no new design language.

## Files touched

| File | Change |
|---|---|
| `frontend/src/app/tournament/new/page.tsx` | All of a–e below |
| `frontend/src/app/tournament/[id]/TournamentPageClient.tsx` | ONE insertion: double rule between name and Meta row |
| `frontend/src/lib/tournament-program.ts` | NEW — pure copy/format helpers (no React, no framer-motion) |
| `frontend/src/lib/tournament-program.test.ts` | NEW — vitest for the helpers |

**Untouched:** `frontend/src/lib/types.ts`, `backend/app/models.py`, all shared types,
all API calls, `tournament-prefill.ts`, voice pipeline. This is presentation only.

---

## 0. New pure helper module — `frontend/src/lib/tournament-program.ts`

The ONLY real logic added. Keep it pure and framer-motion-free so vitest imports it
directly (same reason `tournament-standings.ts` exists — see the comment at
`TournamentPageClient.tsx:73-77`).

```ts
/** 1→"one" … 9→"nine"; anything else (0, 10+) falls back to String(n). */
export function numberWord(n: number): string

/** "SATURDAY, JULY 12" — weekday, month, day; no year. */
export function formatProgramDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  }).toUpperCase();
}

/**
 * Composing summary sentence. players < 1 → "" (caller hides it).
 * "A field of three, over two days."  ·  "A field of one, over one day."
 * players ≥ 10 → digits: "A field of 12, over two days."
 * rounds is 1–4 by construction (NUM_ROUNDS) so its word form always exists.
 */
export function fieldSummary(players: number, rounds: number): string

/**
 * Colophon. "2 DAYS · 3 ENTRANTS" · singulars "1 DAY · 1 ENTRANT".
 * Digits, not words (it is a mono spec line). players < 1 → "" (caller hides).
 */
export function colophonLine(rounds: number, players: number): string

/** Ghost entry lines remaining: max(0, min(3, 4 - totalPlayers)).
 *  0→3, 1→3, 2→2, 3→1, ≥4→0 — cap 3, yields one-for-one, zero once field ≥ 4. */
export function ghostCount(totalPlayers: number): number
```

Note on dates: the existing `formatDate` (`frontend/src/lib/tournament-standings.ts:53`,
re-exported through `TournamentPageClient.tsx`) renders `"Jul 12, 2026"` from an ISO
string — the wrong shape for the kicker ("SATURDAY, JULY 12") and keyed to `createdAt`,
not today. So `formatProgramDate` is a NEW minimal formatter, deliberately built on the
same `toLocaleDateString("en-US", …)` mechanism so date rendering stays consistent
app-wide. Do NOT modify `formatDate`.

**Unit test** (`tournament-program.test.ts`, mirror style of
`tournament-standings.test.ts`):
- `numberWord`: 1→"one", 4→"four", 9→"nine", 10→"10", 0→"0"
- `formatProgramDate(new Date(2026, 6, 12))` → "SUNDAY, JULY 12" (construct with the
  local-time Date constructor, NOT an ISO string, so the test is timezone-proof)
- `fieldSummary(3, 2)` → "A field of three, over two days."
- `fieldSummary(1, 1)` → "A field of one, over one day."
- `fieldSummary(12, 4)` → "A field of 12, over four days."
- `fieldSummary(0, 2)` → ""
- `colophonLine(2, 3)` → "2 DAYS · 3 ENTRANTS"; `colophonLine(1, 1)` → "1 DAY · 1 ENTRANT"
- `ghostCount`: 0→3, 1→3, 2→2, 3→1, 4→0, 9→0

---

## 1. Setup page — `frontend/src/app/tournament/new/page.tsx`

All line numbers reference the CURRENT file; insertions shift later ones, so anchors
(quoted code) are authoritative.

### 1.0 Imports + shared wiring (top of file, lines 1–17)

- Add: `import { motion, AnimatePresence, useReducedMotion } from "framer-motion";`
  — framer-motion is in package.json (`^12.29.2`) but NOT yet imported on this page.
- Add: `import { formatProgramDate, fieldSummary, colophonLine, ghostCount, } from "@/lib/tournament-program";`
- Inside the component: `const reduce = useReducedMotion();` — the SAME gate pattern the
  view page uses (`TournamentPageClient.tsx:99`, applied at `:823`
  `transition={reduce ? { duration: 0 } : T.springSoft}` and `:1005`
  `layout={reduce ? false : "position"}`). Every motion element below uses exactly this.

**Hydration / timezone note:** this is a `"use client"` page, but Next static export
still prerenders it at build time — a bare `new Date()` in render would bake the BUILD
date into the HTML and mismatch on hydration. Gate it post-mount:

```ts
const [today, setToday] = useState<Date | null>(null);
useEffect(() => { setToday(new Date()); }, []);
```

Kicker renders `THE PROGRAM` alone until `today` is set, then
`THE PROGRAM · {formatProgramDate(today)}`. First paint without the date is a
sub-frame flash; no `suppressHydrationWarning` needed. Device-local timezone is
correct by definition (it is the user's "today").

### 1.a Header → cover plate (lines 228–279)

1. **Kicker** (lines 255–266): replace text `New · Tournament` with
   `The Program{today ? \` · ${formatProgramDate(today)}\` : ""}` — styles UNCHANGED
   (T.mono 9.5 / ls 1.6 / T.pencil / uppercase; `textTransform: "uppercase"` already
   uppercases "The Program", and `formatProgramDate` is pre-uppercased).
2. **Title → live cover echo** (lines 267–278): the div currently hardcodes
   `Set up a tournament.` Replace content and two style values:
   - `name.trim()` empty → `Set up a tournament.` with `color: T.pencilSoft`
     (italic serif). Permitted despite the contrast rule: it is placeholder-role,
     and at 34px it is WCAG large text where 3.0:1 passes AA.
   - `name.trim()` non-empty → `{name.trim()}` with `color: T.ink`.
   - Style deltas: `fontSize: 30` → `34`, `letterSpacing: -0.6` → `-0.8`. Keep
     `lineHeight: 1.05`; add `overflowWrap: "break-word"` so long names (input already
     caps at `maxLength={80}`) wrap instead of overflowing — no ellipsis, no maxHeight.
3. **Double rule** — insert after the title div, before the header wrapper closes
   (before line 279):

```tsx
<div style={{ marginTop: 12, borderTop: `1px solid ${T.hairline}`,
              height: 3, borderBottom: `1px solid ${T.hairline}` }} />
```

(1px rule, 3px gap, 1px rule — one div, no nesting.)

### 1.b Name field (lines 281–340)

Label text only: `Name` → `The event` (line 301; `textTransform: "uppercase"` renders
THE EVENT). Label keeps its EXISTING `T.pencilSoft` — the contrast rule governs NEW
informational elements; pre-existing label roles are not in scope, do not "fix" them.
Input, placeholder, `maxLength`, validation (`touched && nameMissing`), error line:
**byte-identical**.

### 1.c Rounds → Order of play + itinerary (lines 342–388)

1. Label text (line 360): `Rounds` → `Order of play`.
2. The 1–4 selector (lines 362–387): **byte-identical** — same `NUM_ROUNDS` map, same
   `onClick={() => setNumRounds(...)}`, same styles.
3. **Itinerary** — insert AFTER the selector's closing `</div>` (line 387), inside the
   same bordered section (before line 388). `numRounds` chips reusing the view page's
   round-strip "upcoming" pattern (`TournamentPageClient.tsx:610-696`, upcoming =
   transparent bg + T.hairline border):

```tsx
<div style={{ display: "flex", gap: 6, marginTop: 10 }}>
  <AnimatePresence initial={false}>
    {Array.from({ length: numRounds }, (_, i) => (
      <motion.div
        key={i}
        layout={reduce ? false : true}
        initial={reduce ? false : { opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reduce ? undefined : { opacity: 0, scale: 0.96 }}
        transition={reduce ? { duration: 0 } : T.springSoft}
        style={{ flex: 1, borderRadius: 12, border: `1px solid ${T.hairline}`,
                 background: "transparent", padding: "10px 12px" }}
      >
        <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3,
                      color: T.pencil, textTransform: "uppercase", marginBottom: 2 }}>
          Day {i + 1}
        </div>
        <div style={{ fontFamily: T.serif, fontSize: 14, letterSpacing: -0.2,
                      color: T.pencil, lineHeight: 1.1, whiteSpace: "nowrap",
                      overflow: "hidden", textOverflow: "ellipsis" }}>
          Course to be drawn
        </div>
      </motion.div>
    ))}
  </AnimatePresence>
</div>
```

Chips are plain divs — NOT buttons, no cursor, no onClick (the view's are buttons; here
they are a preview only — rounds are drawn later from the tournament page, this creates
nothing). "Course to be drawn" in `T.pencil` (placeholder role, but informational text →
pencil per the contrast rule; the view uses T.ink for real course names — intentional
difference).

### 1.d Field → Card of entry (lines 390–680)

1. Label text (line 409): `Field` → `Card of entry`. The counter (lines 411–422,
   `"{n} selected" / "select players"`) stays byte-identical.
2. **Entry numbers.** Selection order, derived from existing state (JS `Set` preserves
   insertion order; `togglePlayer` add/delete keeps it; voice `apply` bulk-adds in parse
   order — all fine):

```ts
const entryNumberById = new Map<string, number>();
[...Array.from(selectedIds), ...customPlayers.map((c) => c.id)]
  .forEach((pid, i) => entryNumberById.set(pid, i + 1));
```

   Saved-selected entrants number first (in tap order), then customs (in add order);
   numbers reflow on deselect/remove — they are program numbers, not IDs, and the live
   typesetting metaphor wants the reflow.
   - **Saved rows** (lines 473–543): when `sel`, render before the handicap block
     (before line 528):
     `<div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencil, flexShrink: 0 }}>№{entryNumberById.get(p.id)}</div>`
   - **Custom rows** (lines 557–617): same element before the `×` remove button
     (before line 599) — customs have no handicap numeral, so it sits right-aligned
     before the remove control.
   - Toggle/add/remove/✓-avatar/handicap rendering: **unchanged**.
3. **Ghost entry lines** — insert AFTER the add-player input box's closing `</div>`
   (line 679), inside the Players section (before line 680). `const ghosts =
   ghostCount(totalPlayers);` then:

```tsx
{ghosts > 0 && (
  <div aria-hidden style={{ pointerEvents: "none", marginTop: 6 }}>
    <AnimatePresence initial={false}>
      {Array.from({ length: ghosts }, (_, i) => (
        <motion.div
          key={totalPlayers + i + 1}
          layout={reduce ? false : true}
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={reduce ? { duration: 0 } : T.springSoft}
          style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44 }}
        >
          <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2,
                         color: T.pencilSoft }}>
            №{totalPlayers + i + 1}
          </span>
          <span style={{ flex: 1, borderBottom: `1px dashed ${T.hairlineSoft}` }} />
        </motion.div>
      ))}
    </AnimatePresence>
  </div>
)}
```

   Hard requirements: `aria-hidden` + `pointerEvents: "none"` on the wrapper, NO border
   box, NO background — must not read as tappable. Numbering continues from the live
   field (`№ totalPlayers + i + 1`). `T.pencilSoft` is allowed HERE ONLY (decorative,
   aria-hidden). The dashed rule uses `T.hairlineSoft`.
4. **Composing summary** — directly under the ghosts. Hidden until ≥ 1 entrant
   (`fieldSummary` returns "" for 0; gate on `totalPlayers > 0` anyway):

```tsx
{totalPlayers > 0 && (
  <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 15,
                color: T.pencil, marginTop: 12 }}>
    {fieldSummary(totalPlayers, numRounds)}
  </div>
)}
```

   `T.pencil`, NOT pencilSoft — informational text (contrast rule).

### 1.e Send-off colophon (lines 684–752)

Insert inside the sticky-CTA wrapper (opens line 685), ABOVE the error block (line 694):

```tsx
{totalPlayers > 0 && (
  <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3,
                color: T.pencil, textAlign: "center", marginBottom: 8,
                textTransform: "uppercase" }}>
    {colophonLine(numRounds, totalPlayers)}
  </div>
)}
```

"Hidden while form empty" is operationalized as `totalPlayers > 0` — rounds always ≥ 1,
so gating on entrants avoids ever rendering "· 0 ENTRANTS". The button itself
(lines 712–751): geometry, disabled logic, `handleCreate`, "Create tournament" /
"Creating…" labels, `→` glyph — **byte-identical**.

### Voice prefill (lines 85–109)

**NO changes.** `apply` fills `name` / `numRounds` / `selectedIds` / `customPlayers`;
every addition above derives from exactly that state, so voice prefill composes the
program (cover echo, itinerary, entry numbers, summary, colophon) with zero new wiring.

---

## 2. View page — `frontend/src/app/tournament/[id]/TournamentPageClient.tsx`

**TWO lines of JSX, one insertion point.** After the tournament-name div closes
(line 590), before the Meta row (line 592), insert the SAME double rule:

```tsx
<div style={{ marginTop: 14, borderTop: `1px solid ${T.hairline}`,
              height: 3, borderBottom: `1px solid ${T.hairline}` }} />
```

Leave the Meta row's `marginTop: 18` untouched. Everything else on the page — round
strip, leader callout, tabs, FLIP leaderboard, settlement, Wolf — **UNTOUCHED**.

---

## 3. Behavioral-unchanged contract (reviewer's checklist)

Verify each is identical before/after:

1. Name input: typing, `maxLength={80}`, placeholder "Club Championship",
   `touched && nameMissing` error "Name is required."
2. Rounds: tapping 1–4 sets `numRounds`; active/inactive button styling.
3. Saved-player toggle: tap toggles selection, ✓-avatar, `paperDeep` selected bg,
   handicap numeral (incl. `+` prefix logic).
4. Add-by-name: Enter key AND the "Add" pill both call `addCustom`; dedupe against
   saved + custom (case-insensitive); input clears + refocuses.
5. Remove custom via `×`.
6. Counter: "n selected" / "select players".
7. Validation: `canCreate`, `touched`-gated errors, "Add at least one player."
8. Create: `handleCreate` unchanged — persists customs via `createPlayer`, then
   `createTournament`, write-through `saveTournament`, `router.push(tournamentHref(created.id))`;
   offline/error copy unchanged; disabled/creating states unchanged.
9. Voice prefill (`apply` + `useCaddiePageContext`): unchanged; still never dispatches.
10. `← Home` back button unchanged.
11. Shared types: `frontend/src/lib/types.ts` and `backend/app/models.py` untouched —
    no API/schema/type change anywhere.
12. View page below the header: pixel-identical.

---

## 4. Gates

```
cd frontend && npm run lint && npx tsc --noEmit && npm run build
cd frontend && npm run test          # includes new tournament-program.test.ts (vitest)
cd frontend && npx tsx voice-tests/runner.ts --smoke
```

Backend ruff: N/A — no backend change. Note: CI additionally runs DB tests; irrelevant
here but expected to stay green since nothing crosses the API boundary.

---

## 5. Risks & edge cases

- **Sparse field (0–1 entrants):** the page must still look composed — that is what the
  3 ghost lines are for (`ghostCount(0) === 3`). Verify visually at 0 and 1 entrants.
- **Very long tournament name:** cover echo wraps (`overflowWrap: "break-word"`,
  `lineHeight: 1.05`); input already caps at 80 chars. No ellipsis on the title —
  wrapping is the yardage-book answer.
- **Ghost lines must never intercept taps:** `pointerEvents: "none"` on the wrapper AND
  `aria-hidden` — screen readers and hit-testing both skip them. No border/background so
  they cannot read as affordances.
- **Itinerary vs. real round creation:** chips are non-interactive divs labeled "Course
  to be drawn" — setup only PREVIEWS the order of play; rounds are actually drawn later
  from the tournament page. Do not add navigation or buttons to the chips.
- **Round count:** already capped at 4 by `NUM_ROUNDS` — itinerary never overflows a
  390px viewport (4 × flex-1 chips, same math as the view's strip).
- **Hydration/date:** post-mount `useState`/`useEffect` gate (§1.0) — no build-date
  bake-in, no `suppressHydrationWarning`.
- **Reduced motion:** every motion element gates with
  `reduce ? { duration: 0 } : T.springSoft` and `layout={reduce ? false : true}` —
  identical to the view page's existing pattern.
- **Contrast (WCAG, prior cycles hit real bugs here):** `T.pencilSoft` (#958d7d) on
  paper is ~3.0:1 → FAILS AA for normal text. Every NEW informational element — summary
  sentence, colophon, entry numbers, itinerary text — uses `T.pencil` (#6b6558,
  ~4.6:1). `pencilSoft` appears in new code ONLY on the decorative aria-hidden ghost
  lines (and the 34px placeholder title, which is AA large text at 3:1). Existing
  labels keep their current colors. On `T.ink` surfaces: `T.paper` for values,
  `T.paperMid` only for label roles (no new ink surfaces are added by this plan).

## 6. Build order

1. `tournament-program.ts` + `tournament-program.test.ts`; run vitest.
2. Setup page §1.0 wiring, then a → e in order (each is independent; header first makes
   the rest reviewable in context).
3. View-page double rule (§2).
4. Gates (§4), then walk the behavioral checklist (§3) by hand against a dev build.
