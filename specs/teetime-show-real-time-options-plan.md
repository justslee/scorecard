# Plan: Show real tee-time options (results/prefs UX fixes #1–#3)

Source spec: `specs/teetime-results-ux-fixes.md` (owner screenshots 2026-07-09).
Northstar: calm yardage-book results list, voice-first, NO fake data — never present a
search window as a found time, never substitute an unselected course.

**Scope guard:** this plan touches the tee-time RESULTS/PREFS UI and the
dispatch→search wiring ONLY. Do NOT touch `backend/app/services/voice_booking/*`,
telephony, or the tee_times booking DIALOG/simulator (`/book-by-call/simulate`) —
that is PR #124's area. Bugs #4 (location labels) and #5 (header safe-area) are P2
stretch, listed at the end; the core plan is bugs #1–#3.

---

## 0. The crux — verified in code (not assumed)

**Q: Does the API return a slot LIST per course, and does the frontend collapse it?
A: YES and YES.**

- **Backend** `backend/app/routes/tee_times.py` — `GET /api/tee-times/search`
  (`search_tee_times`, line ~230) returns `SearchResponse.results:
  list[TeeTimeSlotOut]`. Each `TeeTimeSlotOut` carries `time` ("HH:MM" 24h, or `""`),
  `players`, `priceUsd`, `route` (`"book_on_site" | "call" | None`), `phone`,
  `bookingUrl`, `provider`. For foreUP-capable courses,
  `RoutedTeeTimeProvider._slots_for_course`
  (`backend/app/services/tee_times/router_provider.py` line ~71) returns MULTIPLE real
  slots per course via `ForeUpProvider.slots_for_capability` — `provider="foreup"`,
  `route=None`, real `time` (foreup.py ~line 222–234). For every other public course,
  `build_route_entry` (`backend/app/services/tee_times/routing.py` line 94) emits ONE
  entry per course with `time=""`, `price_usd=None`, `route="book_on_site"|"call"`.
  So a single response can be a MIX of real-slot lists and call-route entries.

- **Frontend collapse** — `frontend/src/app/tee-time/page.tsx`:
  - `Searching.run()` (lines ~868–943) fans out one `searchTeeTimes(q)` per selected
    window, accumulates `allSlots`, dedupes → `unique`, then **collapses the list to
    ONE slot**: `const best = unique.slice().sort(...)[0]` (line ~906), immediately
    auto-calls `bookTeeTime(best, …)` (line ~921), and hands only that single slot to
    `Confirmed` via `onFound(unique, best, result)` (line ~942).
  - The full list IS kept but never rendered — line 238:
    `void slots; // available for future "results list" UI`.
  - `Confirmed` (lines ~1104–1114) then renders the **window instead of options**:
    when `slot.time === ""` (a route entry), `timeCardKicker = "Your window"` and
    `timeCardFigure = formatWindowRange(requestedWindow.start, requestedWindow.end)`.
    That's the "YOUR WINDOW 6:00–9:30AM" card in the screenshot.

- **Shared types are ALREADY in sync — no type additions needed.**
  `frontend/src/lib/teetime/types.ts` `TeeTimeSlot` has `time`, `players`,
  `priceUsd: number | null`, `route?: "book_on_site" | "call"`, `phone?`,
  `bookingUrl?`, `provider` — field-for-field parity with `TeeTimeSlotOut`
  (routes/tee_times.py line 119) and the service `TeeTimeSlot` dataclass
  (`backend/app/services/tee_times/base.py` line 45). The slot list flows end to end
  today; **all three fixes are frontend/dispatch-side. No backend code changes are
  required** (backend files are listed below for verification only).

**The real-slot vs call-route discriminator** (use this exact rule everywhere):
`slot.route == null && slot.time !== ""` → a REAL bookable time (foreup today, mock in
dev). `slot.route === "book_on_site" | "call"` → a route entry whose `time` is `""` —
there is no found time; the window is only the ASK. Key on `route`/`time`, not on the
`provider` string (future providers keep working).

---

## 1. Root causes, per bug

### Bug #1 — window shown instead of options
Collapse points above. Two sins: (a) real foreup slots are collapsed to `best` and the
rest never rendered; (b) for route entries, the big time-card figure presents the
SEARCH RANGE with the same visual weight as a found time.

### Bug #2 — displayed window ≠ submitted prefs
`Confirmed`, page.tsx lines ~1108–1110:
```ts
const requestedWindow = windows.find((w) => w.date === slot.date)
  ?? windows.find((w) => w.selected)
  ?? windows[0];
```
`windows` contains ALL windows including **deselected defaults**
(`defaultWindows()` in `frontend/src/lib/teetime/dates.ts` line 81 seeds
`sat-am 06:30–09:30 (selected)`, `sat-pm 11:00–14:00 (unselected)`,
`sun-am 07:00–10:00 (selected)`). Both Saturday windows share the same `date`, so
`find(w => w.date === slot.date)` returns the FIRST Saturday window — the early
default — even when the owner selected/edited a different one. Voice-added windows
(`applyParsedWindows`, `frontend/src/lib/teetime/voice-prefs.ts` line 68) append at
the END of the array, so a voice-created window loses the `find` race to a deselected
default every time. The displayed window is thus a default range, not what was
submitted. The fix is to stop re-deriving from prefs state and instead thread the
ACTUAL dispatched queries (which are correct — `buildTeeTimeQueries` in
`frontend/src/lib/teetime/query.ts` maps only SELECTED windows verbatim) through to
the results view.

### Bug #3 — unselected course returned
Backend selection filtering is correct and shipped (#122):
`RoutingTeeTimeProvider.search_availability`
(`backend/app/services/tee_times/routing.py` lines 194–204) filters discovered courses
through `matches_selection` (`selection.py`) whenever `query.course_ids` is non-empty,
and returns `[]` (honest empty, logged) when nothing matches — it never substitutes.
The 15-min route cache is also safe: `query_cache_key`
(`backend/app/services/tee_times/search_cache.py` line 30) includes sorted `ids`.

**The hole is on the DISPATCH path — the frontend can silently send NO courseIds:**
1. page.tsx line ~838:
   `const selectedCourses = courses.filter((c) => c.selected && (c.distance == null || c.distance <= maxMiles));`
   A selected course beyond the current `maxMiles` is kept on the prefs LIST
   (`reconcileCourseOptions` in `frontend/src/lib/teetime/courses.ts` line 179 never
   prunes selected rows) but is silently EXCLUDED from the dispatch. Shrink the radius
   (by slider or voice "within 5 miles") below all four picks → `selectedCourses = []`.
2. `buildTeeTimeQueries` (`query.ts` line 42) omits `courseIds` entirely when the list
   is empty → the query becomes an ALL-NEARBY search → the backend honestly returns
   every nearby public course → `best` = nearest (Forest Park), an unselected course,
   auto-"booked" and presented.
3. Voice: `applyParsedCourses` (`voice-prefs.ts` line 108) with spoken names that match
   NOTHING on the list returns `courses.map(c => ({...c, selected: wanted.has(...)}))`
   — i.e. **deselects everything** — and `applyParsed` (page.tsx ~line 403)
   auto-dispatches 1.4s later → same all-nearby degradation.

So: selection is honored by the provider, but the dispatch can drop the selection
before it ever reaches the provider. Fix the dispatch + add a defense-in-depth result
guard; when the selected set yields nothing, say so honestly.

---

## 2. Approach

Replace the auto-pick-and-book collapse with an **Options phase**: a calm,
yardage-book list of what was actually found, grouped per course; the golfer picks.
Real slots render as tappable times ("6:10 AM · 2 spots · $24"); call-route courses
render in a quieter section framed as the ASK ("No online times — call for a time in
your 6:30–9:30 window"). Booking (the existing `bookTeeTime` → `Confirmed` flow) moves
to AFTER the pick. The window shown anywhere post-dispatch comes from the dispatched
queries themselves, never re-derived from prefs state.

Phases go `prefs → searching → options → confirmed` (today: `prefs → searching →
confirmed`). `Confirmed` survives nearly intact as the post-pick screen.

Pure logic goes in a new leaf module `frontend/src/lib/teetime/options.ts` with unit
tests, following the repo's established pattern (query.ts, courses.ts, confirm-copy.ts
are all pure + tested; the page stays thin).

---

## 3. Steps

### Step 1 — pure helpers: `frontend/src/lib/teetime/options.ts` (NEW) + `options.test.ts`
- `isRealSlot(s: TeeTimeSlot): boolean` — `s.route == null && s.time !== ""`.
- `interface DispatchedAsk { date: string; start: string; end: string }` — one per
  dispatched query (derived 1:1 from `TeeTimeQuery`s in Searching).
- `asksForDate(asks: DispatchedAsk[], date: string): DispatchedAsk[]` +
  `formatAskWindows(asks): string` — "6:30–9:30 AM", or
  "6:30–9:30 AM or 11:00 AM–2:00 PM" when two selected windows share the date (reuse /
  move `formatWindowRange` from page.tsx line 1305 into this module or a shared spot).
- `groupSlotsByCourse(slots: TeeTimeSlot[]): CourseGroup[]` — groups by `courseId`
  (fallback normalized `courseName`), real-slot groups first, then route-entry groups;
  groups ordered by `distanceMiles`; times sorted ascending within a group.
  `CourseGroup = { courseId, courseName, city, distanceMiles, realSlots: TeeTimeSlot[], routeEntry?: TeeTimeSlot }`.
- `filterToSelection(slots, selection: Array<{id, name}>): TeeTimeSlot[]` — the
  defense-in-depth guard (bug #3): keep a slot iff `slot.courseId` equals a selected
  id OR normalized-name equality (lowercase, trim, collapse whitespace/punctuation —
  mirror the tolerant spirit of backend `matches_selection`, which may legitimately
  return a slot whose `course_id` is the DISCOVERED id, not the selected mapped-row
  UUID; an id-only guard would false-reject good results). Applied only when the
  golfer actually has selected courses.
- `slotOptionLabel(s): string` — "6:10 AM · 2 spots · $24"; `players !== 1` pluralizes;
  `priceUsd == null` → omit the price segment entirely (never "$—", never fabricated).
  Note: `players` is real capacity ONLY on real slots (routing.py line 115 documents
  route entries echo the request) — route entries never show spots.
- `emptySelectionNote(names: string[]): string` — honest miss copy naming the picks,
  e.g. "None of your picks — Clearview, Silver Lake, Forest Hills, Knickerbocker —
  had times in your windows. Widen a window, or add a course."

### Step 2 — dispatch honors the selection (bug #3), in `Searching` (page.tsx)
- Line ~838: **stop radius-dropping explicit picks.**
  `const selectedCourses = courses.filter((c) => c.selected);`
  (The radius already shaped what got LISTED; a check next to a course's name is the
  golfer's explicit instruction. This matches the existing comment's own principle:
  "the golfer's explicit picks — never silently dropped by the radius filter", which
  today only protects distance-unknown rows.)
- After `buildTeeTimeQueries`: if `selectedCourses.length > 0`, every query carries
  their ids (ids are guaranteed non-empty — verified: `golf-api.ts` nearby legs skip
  id-less rows, `courseOptionFromSelection` stringifies real ids — so keep
  `.filter(Boolean)` as belt only).
- After the dedupe: when `selectedCourses.length > 0`, run
  `filterToSelection(unique, selectedCourses)`. If that empties the list (or `unique`
  was already empty), set the error to `emptySelectionNote(...)` — an honest miss with
  the existing "← Adjust prefs" button. **Never fall through to unselected results.**
- Live-log copy: "Checking your 4 picks …" when a selection exists (keep the current
  "Checking N courses…" otherwise).
- Voice hole: in `applyParsedCourses` (`voice-prefs.ts` line 108), when
  `courseNames.length > 0` but the wanted set matches ZERO listed courses, return
  `courses` untouched instead of deselecting everything (and in page.tsx `applyParsed`,
  have the ack `say(...)` note "couldn't find <name> on your list — kept your picks").
  Small, honest, unit-testable.

### Step 3 — stop the collapse: Options phase (bug #1)
- `TeeTimePage`: `type Phase = "prefs" | "searching" | "options" | "confirmed"`. New
  state `const [asks, setAsks] = useState<DispatchedAsk[]>([])` (delete the
  `void slots;` escape hatch — `slots` finally gets rendered).
- `Searching`: DELETE the auto-pick (`best`, line ~906) and the auto
  `bookTeeTime(best, …)` (line ~921) and their log lines. `onFound` becomes
  `onFound(slots: TeeTimeSlot[], asks: DispatchedAsk[])` (asks = the queries actually
  sent, mapped `{date, timeWindowStart→start, timeWindowEnd→end}`) → `setPhase("options")`.
  Final log line: "N times at M courses — take your pick." / for route-only results:
  "Found M courses — no online times, here's how to book."
- New `Options` component (in page.tsx alongside its siblings, or
  `frontend/src/app/tee-time/Options.tsx` if page.tsx growth is a concern — builder's
  call; reuse `PaperShell`/`Section`/`Kicker`/`TTMasthead`, serif/mono tokens from
  `@/components/yardage/tokens`; NO new design language, no table/dashboard):
  - Masthead: kicker "Found" / title honest to content: "Take your pick" when any real
    slots exist; "Here's how to book" when only route entries.
  - Per real-slot course group, a Section-like block: course name (serif), city ·
    distance sub-line, then a calm list of tappable time rows —
    `slotOptionLabel(slot)` — hairline-divided like `CourseRow`. Cap visible rows per
    course (~5) with a quiet "+ N more" expander to protect the calm (exact cap =
    designer's call, see §7).
  - Route-entry courses under a quieter "No online times" divider: course name + the
    ASK line using the dispatched window —
    `Call for a time in your ${formatAskWindows(asksForDate(asks, entry.date))} window`
    (or "Book on their site — ask for your …" for `route === "book_on_site"`), with
    the real CTA (`bookingUrl` link or `tel:` via `callTelHref`) inline. The window is
    NEVER the big figure — it lives inside the ask sentence. No-fake-data.
  - Back → `prefs` ("← Adjust prefs").
- Voice-first note: the Options list is tap-to-pick; the looper's spoken/log line
  ("N times at M courses") keeps the voice path informed. Full voice slot-picking
  ("take the 6:10") is out of scope — flagged in §7.

### Step 4 — pick → book → Confirmed (bugs #1 + #2)
- Tapping a real time row: `setChosenSlot(slot)` → `bookTeeTime(slot, { name: bookerName ?? "Guest", partySize })`
  (moved intact from Searching, including the catch → honest `needs_human` fallback,
  page.tsx lines ~919–930) → `setBookingResult` → `phase = "confirmed"`. Booking
  attempts stay persisted server-side (POST /book), same as today.
- Tapping a route-entry CTA: also route through `bookTeeTime(entry, …)` → `Confirmed`
  (this persists the handoff and reuses the existing honest needs_human copy), OR
  deep-link/tel directly from the list — builder picks; going through `bookTeeTime`
  preserves today's persistence behavior and is preferred.
- `Confirmed` fixes:
  - Replace the `windows` prop with `asks: DispatchedAsk[]`. Delete the
    `requestedWindow` find-chain (lines ~1108–1110); derive
    `askText = formatAskWindows(asksForDate(asks, slot.date))` (fallback: all asks).
    This makes the displayed window equal the SUBMITTED prefs by construction (bug #2).
  - Route-entry rendering: kicker "Your ask" (not "Your window"), figure stays the
    range but the looper line frames it: pass the ask text into `confirmCopy` —
    `confirmCopy(slot, bookingResult, { askWindow?: string })` in
    `frontend/src/lib/teetime/confirm-copy.ts` — so line ~58 becomes
    "Found ${courseName}. No online booking — call the pro shop for a time in your
    ${askWindow} window." (and the book_on_site line similarly). Update
    `confirm-copy.test.ts`.
  - Real-slot rendering (big "6:10 AM" figure, ICS button) is already correct — keep.

### Step 5 — tests
- NEW `frontend/src/lib/teetime/options.test.ts`: isRealSlot on route/time
  permutations; grouping order + mixed real/route responses; filterToSelection id
  match, name match, false-reject protection (discovered-id ≠ selected-id but same
  name), Forest-Park rejection (unselected course dropped → empty → honest note);
  label price-null omission; multi-window same-date ask formatting.
- UPDATE `frontend/src/lib/teetime/voice-prefs.test.ts`: zero-match courseNames keeps
  the current selection.
- UPDATE `frontend/src/lib/teetime/confirm-copy.test.ts`: askWindow threading; still
  no "Held" anywhere.
- Backend: NO code changes → existing `backend/tests/test_tee_time_routing.py`,
  `test_tee_time_router.py`, `test_tee_time_selection.py`, `test_tee_time_foreup.py`,
  `test_tee_time_search_cache.py` must still pass untouched (run as the no-regression
  gate).

## 4. Edge cases (decided)
- **Bookable course, zero slots in window (verified-empty):** the router OMITS it
  (router_provider.py case 4) — it simply won't appear in Options. If ALL selected
  courses are omitted/unmatched → the honest `emptySelectionNote`. Per-course "0 at
  Clearview" callouts would need a backend echo of checked-but-empty courses — out of
  scope, flagged in §7.
- **Partial selection match:** only matched courses render; no substitution, no
  padding.
- **Multiple prefs windows:** one query per selected window already
  (`buildTeeTimeQueries`); real slots differ by id and all render (grouped per course,
  sorted by time). Route entries share one id per course-date
  (`{course_id}-{date}-route`) so the dedupe keeps one — its ask must name ALL
  dispatched windows for that date (`asksForDate` handles this).
- **Two selected windows, same date, different ranges:** ask text joins both ("… or …").
- **No selection at all (golfer unchecked everything):** all-nearby search stays
  legitimate (that IS the request); Options renders what's found — but never when a
  selection exists.
- **Selected course beyond radius:** now dispatched (Step 2) — matches the widening
  behavior voice already has (page.tsx ~line 387 widens maxMiles for named far courses).
- **Mock provider (dev opt-in):** slots have real times + `route` undefined → render
  as real slots; existing "Demo" stamp/copy on Confirmed still applies.
- **`priceUsd: null` / `players` on route entries:** never rendered (see Step 1).
- **Search legs failing mid-fan-out:** existing per-query catch keeps its honest
  "Couldn't reach that window — skipping it." log; unchanged.

## 5. Shared-type sync notes
No additions needed. Verified parity: `TeeTimeSlotOut` (routes/tee_times.py L119) ↔
`TeeTimeSlot` (frontend types.ts L45) ↔ service dataclass (base.py L45) all carry
`time`, `players`, `priceUsd/price_usd`, `route`, `phone`, `bookingUrl/booking_url`,
`provider`, `estimated` (deprecated, inert). `DispatchedAsk` is frontend-only (a
projection of the already-shared `TeeTimeQuery`). If the builder is tempted to add a
"checkedCourses" echo to `SearchResponse` for per-course empties — don't; that's the
§7 follow-up, not this slice.

## 6. Gates (all must pass; run from repo root)
- `cd frontend && npm run lint`
- `cd frontend && npx tsc --noEmit`
- `cd frontend && npm run build`
- `cd frontend && npx vitest run src/lib/teetime` (new options.test.ts + updated
  voice-prefs/confirm-copy tests; then full `npm test` for the suite)
- `cd frontend && npx tsx voice-tests/runner.ts --smoke` (CI voice gate — the tee-time
  parse fixtures must stay green since voice-prefs.ts changes)
- `cd backend && ruff check .` (backend untouched but gate stays)
- `cd backend && python -m pytest tests/test_tee_time_routing.py tests/test_tee_time_router.py tests/test_tee_time_selection.py tests/test_tee_time_search_cache.py tests/test_tee_time_foreup.py -q`
  (no-regression proof that the provider/selection layer was not disturbed)
- Manual/designer pass per NORTHSTAR: Options must read as a yardage-book list
  (serif course names, mono time rows, hairline dividers) — not a SaaS table.

## 7. Flagged for eng-lead (do not guess)
1. **Tap-to-book directness:** single tap on a time row goes straight to
   `bookTeeTime` → Confirmed (mirrors today's auto-book). If a confirm sheet is wanted
   before the POST, that's a product call — plan assumes single tap.
2. **Per-course verified-empty visibility** ("Clearview: nothing in your window")
   needs a backend response echo — deliberate follow-up slice, not here.
3. **Rows-per-course cap** before "+ N more" (plan says ~5) — designer's call.
4. **Voice slot-picking** ("grab the 6:10") — natural next voice-first step, out of
   scope here.
5. **Exact "6:00–9:30" in the screenshot vs 06:30 default:** the find-by-date bug
   class is confirmed regardless; if the owner's build had a different default/slider
   snap, the by-construction fix (display = dispatched query) covers it either way.

## 8. P2 stretch (optional, separate commits if attempted)
- **#4 location labels:** `muniFromAddress` (`frontend/src/lib/teetime/courses.ts`
  line 58) filters "united states" but not "USA"/"United States of America" — extend
  the country filter so the suffix is a real locality or omitted; test in
  courses.test.ts. Also applies to `slot.city` (backend passes the raw address for
  route entries) — display-side trimming only.
- **#5 prefs header safe-area + grouping:** `TTMasthead` already pads with
  `max(14px, env(safe-area-inset-top))` (page.tsx line 1354) — verify `viewport-fit=cover`
  is set in the app viewport meta (frontend/src/app/layout.tsx) so `env()` is non-zero
  in the WKWebView; audit the WHERE section's "Your favorites"/"Open to" divider
  rhythm for the "broken/grouped" look. Screenshot-verify on device.
