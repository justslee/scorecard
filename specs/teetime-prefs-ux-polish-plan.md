# Tee-time prefs/results — visual & layout polish (designer-led pass)

Classification: NOTICEABLE. Covers `specs/teetime-results-ux-fixes.md` bugs **#5** and **#4**
(the P2 polish items), plus three small same-file follow-ups. Frontend-only; ZERO backend
change; ZERO logic change to the just-shipped selection/options work (f9953f2).

This plan is the contract — the builder implements exactly this, no re-planning.

---

## Northstar guardrails (apply to every item)

- Calm yardage-book feel (NORTHSTAR.md): restrained palette from `T` tokens only
  (`frontend/src/components/yardage/tokens.ts`), serif display, mono kickers, dashed
  `T.hairlineSoft` row dividers, generous whitespace. Nothing dashboard-y, no new design
  language, no Tailwind, no new deps.
- All edits are inline-style JSX in existing components. No new files except test cases
  appended to an existing `.test.ts`.

---

## Item 1 — "WHERE / N SELECTED" header clipped behind the status bar (bug #5a)

### Diagnosis (confirmed by code trace — NOT a missing meta tag)

- `frontend/src/app/layout.tsx` already sets `viewportFit: "cover"` (L48) and
  `appleWebApp.statusBarStyle: "black-translucent"` (L34); `public/manifest.json` is
  `display: "standalone"`; the app also ships as a **Capacitor iOS** build
  (`@capacitor/*` in `frontend/package.json`). In all of these the WKWebView is
  full-bleed: page content renders and **scrolls under** the transparent iOS status bar.
- The screen the owner is on is the **Prefs phase** of
  `frontend/src/app/tee-time/page.tsx`. "WHERE" / "4 SELECTED" is NOT a screen masthead —
  it is the mid-page `<Section kicker="Where" ... aside={<Kicker>{selectedCount} selected}>`
  at **L715** (Kicker uppercases it). `TTMasthead` (L1526–1547) correctly pads
  `max(14px, env(safe-area-inset-top))`, but that only protects scroll offset 0. Once the
  owner scrolls down to the Where section, the section header sits directly under the
  status-bar clock/Dynamic Island — reads as "clipped". (`CourseSearch.tsx` is NOT the
  screen in the shot — its header has no "WHERE" text and already carries the inset.)
- Therefore: raising the `14px` floor would NOT fix it (it only adds dead space at
  scrollTop 0); the fix is a **status-bar scrim** so scrolled content never collides with
  the clock. This reuses the app's one existing scrim pattern — `.app-header` in
  `frontend/src/app/globals.css` (L141–148): paper @ ~88% + `backdrop-filter: blur(10px)`
  + safe-area padding. We are not inventing a new pattern, we are porting that exact
  treatment to the yardage shell.

### Fix (exact)

In `frontend/src/app/tee-time/page.tsx`, `PaperShell` (**L1495–1501**), render a fixed,
pointer-transparent scrim as the first child of the outer div:

```jsx
{/* Status-bar scrim — content scrolls under the transparent iOS status bar
    (viewport-fit=cover / Capacitor full-bleed). Mirrors .app-header's paper
    wash + blur (globals.css). Height is 0 in a desktop browser → invisible. */}
<div
  aria-hidden
  style={{
    position: "fixed", top: 0, left: 0, right: 0,
    height: "env(safe-area-inset-top, 0px)",
    zIndex: 40,                        // under CourseSearch (50) and LooperSheet (60)
    background: "rgba(244,241,234,0.88)",   // T.paper @ 88%, matches .app-header
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
    pointerEvents: "none",
  }}
/>
```

- Because every tee-time phase (Prefs L558, Searching L985, Options L1149, Confirmed
  L1272/L1322) renders inside `PaperShell`, one change covers the whole flow.
- Do NOT change `TTMasthead`'s existing `max(14px, env(safe-area-inset-top))` padding,
  and do NOT touch `layout.tsx` / manifest / globals.css.

**Before:** scrolled Section headers ("WHERE / 4 SELECTED") collide with the status-bar
clock. **After:** a quiet paper blur occupies exactly the status-bar strip; at desktop
(inset 0) nothing renders.

### On-device confirmation (required)

The designer must confirm the diagnosis and the fix **before/after in the iOS simulator**
(memory: `ios-simulator-map-testing`) — scroll the Prefs screen so the Where section
reaches the top, on a Dynamic Island device profile, in the Capacitor/standalone context
(clipping does not reproduce in plain Safari browser chrome).

---

## Item 2 — NEARBY list "reads as broken / grouped" (bug #5b)

### Diagnosis

`CourseRow` (`tee-time/page.tsx` **L1582–1608**) right column is
`[distance ? "Xmi" : null, c.muni || null].filter(Boolean).join(" · ")` — rows with a
muni show `3.2MI · BROOKLYN`, rows without show just `3.2MI`, so the right edge content
is **ragged** and column alignment breaks. Dividers themselves are consistent
(`borderTop: first ? none : 1px dashed T.hairlineSoft`), but the ragged right column plus
the two group restarts (Favorites / "Open to"|"Nearby", render at **L742–762**) make the
list read as broken.

### Fix (exact, in `CourseRow` L1582–1608 only)

1. **Right column = distance only**, always aligned:
   `{c.distance != null ? `${c.distance} mi` : ""}` — keep the existing mono style
   (fontSize 8.5, letterSpacing 1, `T.pencilSoft`, uppercase, `tabular-nums`) and add
   `textAlign: "right"`. Every row's right edge is now the same shape.
2. **Muni moves under the course name** as a sub-line, reusing the page's existing
   sub-line idiom (the roster rows' "hdcp 7" line, L685): render below the name, only
   when `c.muni` is truthy:
   `fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: T.pencilSoft,
   textTransform: "uppercase", fontWeight: 500, marginTop: 2`.
   Restructure the middle cell: name row (name + favorite star, unchanged styles) stacked
   above the optional muni line; keep `minWidth: 0`.
3. **Even row rhythm + tap target:** on the `<button>` add `minHeight: 44` and change
   padding to `"12px 2px"`; `alignItems: "center"` stays. One-line and two-line rows now
   share a consistent height floor.
4. **Divider treatment stays exactly as-is** (`first ? "none" : 1px dashed
   T.hairlineSoft`) — it matches LogRow/roster/Options; the group labels at L744 and
   L755 keep their current mono style. Only normalize spacing: give BOTH group labels
   `marginBottom: 6` (currently 4) so heading→first-row spacing matches row rhythm; the
   second label keeps its conditional `marginTop: 14`.

**Before:** ragged `distance · city` right column, uneven perceived row heights.
**After:** aligned `checkbox | name (+city sub-line) | distance` columns, uniform dashed
dividers, ≥44pt rows. NO change to `onToggle`, selection state, or ordering.

---

## Item 3 — Location labels: real city or omit, never "USA" (bug #4 residual)

`muniFromAddress` (`frontend/src/lib/teetime/courses.ts` **L60–74**) already drops
"USA"/"U.S.A."/"United States of America" via `COUNTRY_SEGMENT_RE` (commit 9f0577e), and
ALL three prefs groups (favorites / open-to / nearby) render through the same `CourseRow`,
so the row rendering is already consistent. Two residual gaps:

1. **The `r.city` fallback bypasses the guard** — `toCourseOptions` L106:
   `const muni = muniFromAddress(r.address) || r.city || "";`
   A provider `city` field of "USA" would leak. Fix (pure, one line):
   ```ts
   const rawCity = (r.city ?? "").trim();
   const muni = muniFromAddress(r.address) || (COUNTRY_SEGMENT_RE.test(rawCity) ? "" : rawCity);
   ```
   (Keep `COUNTRY_SEGMENT_RE` module-local; no export needed.)
2. **Appended favorites (L139–149) have `muni: ""`** — correct and intentional:
   `FavoriteCourse` (`frontend/src/lib/course-favorites.ts`) stores no address, so the
   label is honestly **omitted**, which the spec allows ("real city/locality or omit").
   NO change; do not fabricate a city.

**Test:** append cases to `frontend/src/lib/teetime/courses.test.ts`: result with
`address: undefined, city: "USA"` → `muni === ""`; `city: "Brooklyn"` → `"Brooklyn"`.

This touches `CourseOption` derivation only — NOT `frontend/src/lib/types.ts`, so no
`backend/app/models.py` sync is needed (flagging per protocol: no shared shape touched).

---

## Item 4 — Same-file follow-ups (fold in; all in `tee-time/page.tsx` `Options`, L1119–1249)

### 4a. Route-entry section header can contradict its rows

`<Section kicker="No online times" title="Call to book">` (**L1210**) is wrong when the
group contains `book_on_site` rows ("Book on their site — …"). Make it conditional
(presentational only — `groupSlotsByCourse`/`routeGroups` untouched):

```ts
const routeKinds = new Set(routeGroups.map((g) => g.routeEntry!.route));
const routeTitle =
  routeKinds.size > 1 ? "Book direct"
  : routeKinds.has("call") ? "Call to book"
  : "Book on their site";
```
Use `kicker="No listed times"` (honest for both kinds — we had no times to list) and
`title={routeTitle}`.

### 4b. Distance/city on route-entry rows

Route rows (**L1218–1233**) currently show only name + askLine, while real-slot course
Sections show `X mi` kicker + city line — inconsistent. Restructure each route row's
content (button element/handlers/disabled/opacity untouched):

- Line 1 becomes a grid `gridTemplateColumns: "1fr auto", gap: 10, alignItems:
  "baseline"`: course name (existing serif style) left; right cell
  `${g.distanceMiles} mi` in the CourseRow mono meta style (fontSize 8.5,
  letterSpacing 1, `T.pencilSoft`, uppercase, `tabular-nums`).
- If `g.city`: insert a city line between name and askLine, matching the real-group city
  line at L1170: serif italic, fontSize 12.5, `T.pencil`, `marginTop: 2`.
- askLine (L1231) unchanged.

### 4c. Sub-44pt tap targets on tee-time rows

Add `minHeight: 44` (keep existing paddings) to:
- Options real-slot rows (**L1176–1194**, currently ≈41px);
- the "+ N more" expander (**L1197–1203**, currently ≈27px — also give it
  `width: "100%"` and `textAlign: "left"` if not already);
- route-entry rows (4b rows — belt only, they clear 44 with the added lines);
- `CourseRow` (already covered in Item 2);
- Prefs roster "Add" rows (**L657–690**, ≈42px) and the "+ Add course" / "+ Add another
  window" dashed buttons (L589/L764, ≈34–36px).

**Deferred (do NOT do in this pass):** any tap-target work outside the tee-time flow;
any change to `Confirmed` layout; any city sanitization of `slot.city` on
Options/Confirmed (backend-provided; separate honesty pass if the owner reports it).

---

## Files & regions touched (complete list)

| File | Region | Change |
|---|---|---|
| `frontend/src/app/tee-time/page.tsx` | `PaperShell` L1495–1501 | status-bar scrim (Item 1) |
| `frontend/src/app/tee-time/page.tsx` | `CourseRow` L1582–1608 | columns/sub-line/minHeight (Item 2) |
| `frontend/src/app/tee-time/page.tsx` | Where section L742–762 | group-label `marginBottom: 6` (Item 2.4) |
| `frontend/src/app/tee-time/page.tsx` | `Options` L1119–1249 | 4a header, 4b row meta, 4c minHeights |
| `frontend/src/lib/teetime/courses.ts` | L106 | guard `r.city` fallback (Item 3) |
| `frontend/src/lib/teetime/courses.test.ts` | append | 2 new cases (Item 3) |

## Edge cases & risks

- **Do not regress f9953f2:** no edits to `frontend/src/lib/teetime/options.ts`
  (`filterToSelection`, `groupSlotsByCourse`, `DispatchedAsk`/asks projection,
  `slotOptionLabel`), no edits to the `phase` state machine
  (prefs→searching→options→confirmed) in `TeeTimePage` (L113–356), no edits to `pick()`
  / `bookTeeTime` (L1130–1146). Every Options change is inside JSX style/copy only.
- **Do not touch** `voice_booking`/telephony (PR #124), `CourseSearch.tsx` (already
  correct), `layout.tsx`, `globals.css`, manifest, or any backend file.
- Scrim: `pointerEvents: "none"` so it can never eat taps; zIndex 40 keeps it under
  CourseSearch (50) and LooperSheet (60), which are full-screen with their own insets;
  height is `env(...)` with 0 fallback so desktop/browser rendering is unchanged.
- `courses.ts` change alters ONLY the `muni` string; selection defaults, dedupe, junk-row
  filtering (`hasIdentifyingTokens` at L112 uses the `muni` value — note: a "USA"-only
  city on an all-generic name will now be honestly skipped, which is the correct
  no-fake-data behavior; call this out in the commit message).
- `frontend/src/lib/types.ts` ↔ `backend/app/models.py`: NOT touched (no shared shape).

## Gates (all must pass; run from `frontend/`)

```
cd frontend && npm run lint
npx tsc --noEmit
npm run build
npx tsx voice-tests/runner.ts --smoke
npm test                       # vitest run — includes src/lib/teetime/options.test.ts + courses.test.ts
# targeted while iterating: npx vitest run src/lib/teetime/options.test.ts src/lib/teetime/courses.test.ts
```
Backend `ruff` is not needed (no backend change) but is harmless if run.

Designer sign-off: iOS-simulator before/after of Item 1 (scrolled Where section, Dynamic
Island profile, Capacitor/standalone context — memory: `ios-simulator-map-testing`), plus
a visual pass of the Nearby list and Options screen against NORTHSTAR.md.
