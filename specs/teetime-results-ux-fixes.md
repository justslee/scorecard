# Tee-time results & prefs UX bugs (owner screenshots 2026-07-09)

## Bugs observed (owner-reported + diagnosed)

### 1. Shows the WINDOW, not the actual tee-time OPTIONS (the core ask)
"If you found a tee time you should tell me what time/s you found, not just that entire
range. I want you to show me my options." The result card shows "YOUR WINDOW 6:00-9:30AM"
— the SEARCH RANGE — as if it's the result. For **foreUP courses we HAVE real slots** (S1
proved 18 Mile Creek returns real times) but the UI collapses them to the window. For
**no-online-booking / call-route courses (Forest Park in the shot)** we genuinely have NO
times until we call — but showing "YOUR WINDOW" reads as "found a time in this window",
which is misleading.
FIX: when real slots exist (foreUP) → show a LIST of the actual bookable times the golfer
can pick ("6:10, 6:30, 6:50 — 2 spots each"), not the window. When it's a call-route course
→ be honest: "Found the course. Call the pro shop for times in your 6:00-9:30 window" —
frame the window as the ASK we'll make, never as a found time.

### 2. The displayed window ≠ what the owner submitted
"That time window is not what I submitted." The result shows 6:00-9:30AM but that's not the
prefs window the owner set. State/plumbing bug — the found-result window must reflect the
ACTUAL submitted prefs windows, not a default/hardcoded range. Trace prefs → dispatch →
result window (voice-prefs windows → the searching/confirmed phase).

### 3. The found course was NOT selected
The owner checked Clearview / Silver Lake / Forest Hills / Knickerbocker (header "4
SELECTED") but the result is **Forest Park Golf Course (Wood Haven NY)** — not selected.
The "Go find us one / Dispatch Looper" flow isn't honoring the selected course set (or
searches all-nearby and returns an unselected one). This is the SAME class the #122 course-
ids-wiring targeted — verify the DISPATCH path (not just the provider) passes the selected
ids and the result is drawn from them; if no selected course has availability, say so
honestly rather than substituting an unselected course.

### 4. Location labels wrong / inconsistent
"Marine Park Golf Course · USA" shows "USA" instead of a city; other rows show a city, some
show none. The location suffix should be a real city/locality or omitted — never "USA".

### 5. Courses-selection header cut off ("checklist is broken and they are grouped")
The top header ("WHERE" / "4 SELECTED") is clipped behind the status bar (safe-area/top-
inset), and the grouped/divided list reads as broken. Apply the top safe-area inset; make
the NEARBY list dividers/grouping clean and consistent (calm yardage-book, not broken rows).

## Priority
1 (core, owner-frustrated): #1 show options + #2 correct window + #3 respect selection —
these are the substance of "show me my options."
2 (polish): #4 location labels, #5 header safe-area + list grouping.

## Notes
- foreUP slot data already flows (S1) — the fix is presenting the list, not fetching.
- Do NOT touch voice_booking/telephony (the caller, PR #124) — this is the results/prefs UI
  + the dispatch→search wiring.
