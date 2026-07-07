# Tee-Time Preferences Rework — real dates, slide-to-edit windows, checklist fixes

Owner escalation (2026-07-06, screenshots): (1) "the check list is buggy"; (2) "+ Add another window" stamps identical un-editable 'Custom 08:00 → 11:00' cards; (3) wants a date choice ("maybe Calendar view"); (4) "I should be able to edit existing windows by sliding the slider".

**ONE builder item** — both work items overlap in `frontend/src/app/tee-time/page.tsx` (WindowChip, CourseRow, Where section, addWindow, DEFAULT_WINDOWS, Prefs body); two parallel builders would collide. Lands on integration/next (noticeable).

**Backend impact: none.** `TeeTimeQuery.date` (backend/app/services/tee_times/base.py) is a plain ISO string consumed verbatim; the frontend is the only place resolving "Saturday" → date (`dateForWindowLabel`). types.ts already carries an ISO date — no shared-shape drift.

## WORK ITEM 1 — Windows with real dates + slide-to-edit

### 1a. Model: TimeWindow gets a real date
- `interface TimeWindow` (+`date: string` ISO YYYY-MM-DD, the source of truth for WHEN; `label`/`sub` become display-only).
- `DEFAULT_WINDOWS` becomes a factory `defaultWindows(from = new Date())` (module constant can't resolve "next Saturday"); sat-am/sat-pm → `nextDateForWeekday(6, from)`, sun-am → `nextDateForWeekday(0, from)` (helpers exist in dates.ts, timezone-safe local formatting, DST-immune). Init state via `useState(() => defaultWindows())`.

### 1b. Thread the date through dispatch
- `lib/teetime/query.ts`: `QueryPrefs.windows[]` gains `date`; `buildTeeTimeQueries` uses `date: w.date ?? dateForWindowLabel(w.label, from)` (fallback keeps old callers/tests green). No-windows fallback branch unchanged.
- page.tsx Searching (~799): map selectedWindows to include `date: w.date`.

### 1c. Slide-to-edit
NEW pure module `frontend/src/lib/teetime/window-slider.ts` — all drag math unit-testable without a DOM:
- Constants: TRACK_START_MIN=6*60, TRACK_END_MIN=21*60, STEP_MIN=30, MIN_WINDOW_MIN=60, MAX_WINDOW_MIN=6*60.
- `hhmmToMin`/`minToHhmm`/`fracToMin` (snapped)/`minToFrac`; `type Handle = "start"|"end"|"band"`; `pickHandle(frac, startMin, endMin)` (nearest edge with edge bias, else band); `applyDrag(handle, frac, startMin, endMin, grabOffsetMin)` → clamped, snapped, end > start (no midnight cross), min/max length, band drag preserves length and clamps at edges.

Gesture design (decisive):
- Card stays tap-to-toggle. The TRACK (a taller ~24pt strip at the card bottom) is the drag surface: onPointerDown → `setPointerCapture`, `touchAction: "none"`, `stopPropagation` so drags never bubble to the card toggle.
- Two visually-small handle pills with generous invisible hit-slop (44pt-friendly); grabbing between them drags the whole band.
- Movement threshold distinguishes tap from drag on the track (below threshold on pointer-up = ignore/toggle).
- EVERY window editable, presets too — editing a preset keeps `label` ("Saturday"), flips `sub` to "custom" so the card reads honestly as adjusted.
- Haptics: `haptic("light")` on each 30-min snap crossing (track last step, fire on change) via lib/haptics.ts.
- Extract the card to NEW `frontend/src/app/tee-time/WindowCard.tsx` (replaces inline WindowChip ~1291). Props: `{ win, accent, onToggle, onEdit(start,end), onPickDate, onDelete }`. Owns pointer handlers, live band via minToFrac, ticks, start→end mono label, date chip, quiet delete.

### 1d. Calendar date picker
NEW `frontend/src/components/yardage/MiniCalendar.tsx` — dependency-free compact month grid in the app idiom (mono weekday headers, serif day numerals, T.ink/T.hairline tokens, accent ring on selected). Props `{ value, min?, onPick(date), onClose() }`; prev/next month chevrons; past days disabled (min = today). NO native <input type="date">, NO new dependency.
- WindowCard date chip (e.g. `SAT · JUL 11`, existing formatDateLabel idiom) opens MiniCalendar in the same AnimatePresence/motion sheet pattern as the roster picker. Presets stay one tap — the calendar is the affordance for arbitrary days. Picking a date updates win.date + chip; if weekday differs from label, set label to the picked weekday's name.

### 1e. "+ Add another window" — real, editable, deletable
- Fix addWindow (~426): pure helper `nextDefaultWindow(existing)` returns the first free morning slot (Sat 06:30–09:30 → Sun → Sat midday …) so a second add is a DIFFERENT editable window, never a duplicate stamp.
- Deletion: a quiet `×` on each card (rejected long-press — collides with drag, undiscoverable), 44pt hit area, haptic on delete, guard: keep ≥1 window.

### 1f. Voice path keeps working
- `lib/teetime/voice-prefs.ts::applyParsedWindows`: gains optional `from: Date = new Date()`; additions get `date: nextDateForWeekday(DAY_INDEX[p.day], from)`; matched windows keep their date; `VoicePrefWindow` gains `date: string`.

## WORK ITEM 2 — Course checklist fixes

- **2a. Refetch race (effect ~148-190):** debounce + `cancelled` guard exist but `lastFetched` is written post-await and only guards shrinking radius, not mid-flight area changes. Harden with the course-search-session pattern (AbortController + live-query equality). Keep the debounce. Selections/order preserved by append-only merge — add a test.
- **2b. Auto-pre-selection:** keep first-load convenience (nearest-3 / favorites) but NEVER re-apply after the user touches the list: `coursesTouched` set on first toggleCourse/addCourse; once touched, merged additions arrive `selected: false`.
- **2c. Kicker copy:** `{selected} of {count}` reads as a bug when favorites-beyond-cap exceed MAX_COURSE_OPTIONS. Change to **`{selected} selected`** (matches the When section's kicker).
- **2d. Junk rows:** reject results whose name has NO identifying tokens after stripping golf stopwords — reuse `tokenizeCourseName` from lib/course-search-helpers.ts (mirrors backend stopword list). "Golf Course" → filtered; "Presidio Golf Course" → kept.
- **2e. Radius shrink:** new pure `reconcileCourseOptions(existing, incoming, { maxMiles })` — drop rows that are `distance != null && distance > maxMiles && !selected && !favorite`; KEEP hand-added (distance null), favorited, or selected rows. Voice-widen path (~345) still works: a voice-named far course is selected → kept.
- **2f. Tap targets:** CourseRow row padding → ~13px (≥44pt), checkbox 20-22px; same 44pt review on WindowCard handles + date chip.

All fixes preserve the honest-empty / no-fake-data contract (courses.ts docstring + memory rule).

## Edge cases
- "Next Saturday" late on a Saturday → next week's (existing `|| 7` semantics). Local-time date-only helpers (DST-safe).
- No midnight-crossing windows; 60min floor, 6h cap.
- iOS drag vs scroll: touchAction none + pointer capture on the track only; movement threshold.
- Deleting the last window: guarded.
- Preset weekday overridden via calendar → label updates to the picked weekday.

## Tests
- NEW `window-slider.test.ts`: round-trips, snapping, domain clamps, applyDrag start/end/band (no midnight cross, min/max, band preserves length), pickHandle.
- `courses.test.ts`: junk-name filter, reconcile prune-on-shrink semantics, touched-guard, kicker.
- `query.test.ts`: buildTeeTimeQueries uses w.date verbatim; fallback when absent.
- `voice-prefs.test.ts`: applyParsedWindows stamps correct ISO date per spoken day (fixed `from`); matched windows keep dates.
- `dates.test.ts`: nextDefaultWindow non-colliding slots.

## Gates
tsc, lint, vitest, voice smoke (the applyParsedWindows change must not break tee-time parsing), build. Sim check per frontend/ios/SIMTEST.md — the ONLY way to validate drag/pointer-capture + haptics in real WKWebView (highest-risk piece). Designer review of MiniCalendar + WindowCard vs NORTHSTAR. /code-review before ready (no /security-review trigger — no auth/endpoint/dep change).

## Rejected alternatives
Native date input (SaaS drift); date-picker dependency (no new deps); long-press delete (gesture collision); two builders (same-file collisions); backend date change (unnecessary); whole-card drag (ambiguous with toggle); muni-labeling junk rows (still identity-less; filter instead).

## Files
- frontend/src/app/tee-time/page.tsx · lib/teetime/{courses,query,voice-prefs,dates}.ts
- NEW: lib/teetime/window-slider.ts (+test) · app/tee-time/WindowCard.tsx · components/yardage/MiniCalendar.tsx
