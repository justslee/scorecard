# Spec — course-detail-start-round

**Epic:** course-search-reviews · **Classification:** noticeable · **Area:** frontend only
**No backend change** (reuse the existing GolfAPI proxy + `/api/courses/*` endpoints).

## Goal
A quiet **Courses** section: browse/search courses, view a course, and **start a round
from one** — reusing the existing CourseSearch / golf-api.ts / round-setup flow. Calm,
yardage-book feel (NORTHSTAR) — a list, not a grid dashboard.

## Routes
1. `/courses` — hub page (a floating-tab destination).
   - **Search:** reuse the existing `CourseSearch` sheet. Open it from a quiet "Find a
     course" affordance; on `onSelectCourse`, navigate to the course detail (do NOT start a
     round directly here).
   - **Recent:** `getRecentCourses()` (golf-api.ts) → calm list; tap → detail.
   - **Nearby (optional):** `searchNearby(lat,lng)` behind `navigator.geolocation`. Degrade
     gracefully: if no permission / no location / error, simply omit the section (no noise,
     no scary error). GPS path is device-only (note in PR).
   - Page body padding `calc(88px + env(safe-area-inset-bottom,0px))` (hub pattern) so the
     floating tab bar clears content.
2. `/courses/[id]` — course **detail**, static-export safe.
   - Follow the round pattern exactly: `src/app/courses/[id]/page.tsx` emits
     `generateStaticParams() => [{ id: "view" }]` and wraps a client component in
     `<Suspense>`; the client reads the real id from `useSearchParams()` (`?id=` =
     `golfApiCourseId`; also carry `?clubId=` so club detail can be fetched). See
     `lib/round-url.ts` / `round/[id]/page.tsx`.
   - Render: course name, location, holes/par, tees (from `getCourseDetails` /
     `getClubDetails`). Graceful loading + not-found states (yardage-book styled).
   - **"Start a round here"** button → stashes the course and routes to `/round/new`,
     prefilling via the existing `selectedCourse` path.

## "Start a round here" handoff (reuse round/new's onSelectCourse path)
`round/new` already populates a round from `setSelectedCourse({id,name,clubName,location,
holes,par})`. To avoid restructuring round/new (no Suspense/useSearchParams rewrite) and to
keep the object intact, pass the course via a small **sessionStorage handoff helper**:
- `src/lib/course-handoff.ts` — pure-ish module: `stashCourseForRound(course)` and
  `takeCourseForRound()` (reads + clears). SSR-safe (`typeof window` guards).
- Detail page "Start a round here": `saveRecentCourse(...)` + `stashCourseForRound(...)` +
  `router.push('/round/new')`.
- `round/new`: on mount, `const c = takeCourseForRound(); if (c) setSelectedCourse(c);`
  (one `useEffect`, runs once, clears the stash). Existing voice/manual paths untouched.

## URL helper
`src/lib/course-url.ts` mirroring `round-url.ts`:
`COURSE_VIEW_SEGMENT = "view"`; `courseHref({ courseId, clubId? }): string` →
`/courses/view?id=<courseId>[&clubId=<clubId>]` (encodeURIComponent). Pure → unit test.

## Floating tab bar
Add a **Courses** tab (5th) to `FloatingTabBar.tsx` `TABS` (a flag/map-pin or yardage
icon, inline SVG, strokeWidth 1.5, matching the others). Add `/courses` to `HUB_ROUTES` in
`shouldShowTabBar.ts`. Detail `/courses/view` is NOT a hub → tab bar auto-hidden (correct).
Update `shouldShowTabBar.test.ts`: add `/courses` (+ `/courses/` trailing) to the true
cases and `/courses/view` to the false cases.

## Pure logic to unit-test (vitest)
- `course-url.ts` `courseHref` (with/without clubId, id encoding).
- a **recent-list mapping** helper (map `getRecentCourses()` rows → `{title, subtitle,
  href}`) — keep this pure and tested.
- updated `shouldShowTabBar`.
(Live GolfAPI + GPS paths are not headless — call that out in the report.)

## Design / NORTHSTAR
Quiet, on-paper, serif display, generous whitespace; reuse `@/components/yardage/tokens`
(`T.*`) and existing list-row patterns (see CourseSearch rows). NOT a grid dashboard. One
calm screen. `designer` reviews before done.

## Out of scope
No reviews (later items), no course-identity unification, no backend change, no new deps.

## Gates
`npm run lint` · `npx tsc --noEmit` · `npx tsx voice-tests/runner.ts --smoke` (265/265) ·
`npx vitest run` · `npm run build`.
