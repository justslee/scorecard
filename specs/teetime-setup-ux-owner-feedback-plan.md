# Plan-lite — teetime-setup-ux-owner-feedback (cycle 70)

Owner feedback from testing v1.0.1149. All frontend, user-facing. Land on `integration/next`.

## (1) 8-vs-5 count clarity — INVESTIGATION FINDING (put in commit body)

**Root cause (traced, not guessed):** The progress log line at
`frontend/src/app/tee-time/page.tsx:931-933` reports the RAW per-query
`results.length` for route entries. That raw count is the backend's DISCOVERY set —
`RoutingTeeTimeProvider.search_availability` returns up to `MAX_COURSES = 8`
(`backend/app/services/tee_times/routing.py:53,207`) nearby PUBLIC courses. The
frontend then trims Options down to the golfer's actual picks via `filterToSelection`
(`page.tsx:951` → `options.ts:168`), which runs AFTER the loop. So the "8" describes
the discovered-nearby set while the golfer is only ever OFFERED his 5 picks (extras are
dropped from Options, never shown) — two different sets reported as one number. That is
the confusion. Product intent is unambiguously "search + offer only the golfer's picks"
(`emptySelectionNote`: "None of your picks…").

**Fix (honest, frontend-only, no fabrication):** Make the per-window route-entry log line
count the golfer's PICKS THAT ARE OPEN, computed from the selection-filtered set — so the
number matches exactly what Options offers. Apply `filterToSelection` (+ dedup by
normalized course name, guarding OSM duplicate entries) to each query's route-entry
results BEFORE counting. When there's an explicit selection, copy becomes e.g.
`"{n} of your {picks} picks open to the public in {window}"` (designer finalizes exact
wording — calm, yardage-book). When there's NO selection (discovery mode), keep the
existing `"{n} courses open to the public in {window}"` — that's honest there.
Do NOT surface "+N nearby extras": none are offered, so advertising them would be
dishonest. The number must equal the count of the golfer's picks actually open.

## (2) Auto-open calendar on new window
- `page.tsx`: add state `const [justAddedId, setJustAddedId] = useState<string|null>(null)`.
  In `addWindow` (line 535), generate the id first, `setJustAddedId(id)`, then append.
- Pass `autoOpenCalendar={w.id === justAddedId}` to each `<WindowCard>`.
- `WindowCard.tsx`: add prop `autoOpenCalendar?: boolean`; initialize
  `useState(autoOpenCalendar ?? false)` for `showCalendar`. A freshly-added window mounts
  a NEW WindowCard (new id → new key) so the initializer fires exactly once → calendar
  opens. Existing cards are already mounted; their state is untouched → no double-open,
  no regression. The initializer (not an effect) means it can't re-trigger on later
  re-renders. Verify existing windows never auto-open.

## (3) Discoverable date-edit affordance
- `WindowCard.tsx:147-169` date chip: add a small calendar glyph (inline SVG, ~10px,
  `currentColor`/`fgSoft`) immediately left of the date text, inside the same tappable
  role="button" element. Keep the ~44pt hit target (existing padding/margin) and the
  a11y (role, tabIndex, onKeyDown Enter/Space). Designer-led, must stay quiet — no loud
  button, no fill. A subtle glyph + existing text is the affordance.

## (4) Wider window span
- `window-slider.ts:17`: set `MAX_WINDOW_MIN = TRACK_END_MIN - TRACK_START_MIN` (= 900 min
  / 15h = full track). This effectively removes the cap while keeping the constant, so all
  drag-math clamps (`applyDrag` lines 103,111) and rendering still work at full width. Keep
  `MIN_WINDOW_MIN` (60) and 30-min snap unchanged.
- `window-slider.test.ts`: re-point the two "never exceeds the 6h cap" assertions
  (lines 94-97, 117-120) to the exact clamp so they stay correct at ANY max and are NOT
  weakened:
  - start: `expect(r.start).toBe(Math.max(TRACK_START_MIN, 780 - MAX_WINDOW_MIN))`
  - end:   `expect(r.end).toBe(Math.min(TRACK_END_MIN, 600 + MAX_WINDOW_MIN))`
  - keep the `r.end - r.start <= MAX_WINDOW_MIN` invariant assertions.
  - keep the sanity test at 160-162 (`MIN < MAX <= track`) — still holds (MAX == track).
  - ADD a positive test proving the window can now span the FULL track:
    `applyDrag("end", minToFrac(1), TRACK_START_MIN, TRACK_START_MIN+60)` →
    `end === TRACK_END_MIN` and `end - start === 900`.
  - keep ALL min/cross/snap tests unchanged.

## Gates (all must be SUCCESS on pushed head)
`cd frontend && npm run lint && npx tsc --noEmit && npx tsx voice-tests/runner.ts --smoke
&& npx vitest run src/lib/teetime`. No backend change (fix (1) is frontend-only) → no
backend gate needed, but confirm no backend file was touched.

## Classification: NOTICEABLE (all 4 are user-visible). Designer pass MANDATORY.
