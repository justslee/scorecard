# Implementation Plan — course-detail-start-round (frontend only)

Contract for the builder. Frontend only, no backend. Reuse GolfAPI proxy
(`lib/golf-api.ts`), CourseSearch, and the round/new setup flow. NORTHSTAR:
quiet, voice-first, yardage-book; reuse `@/components/yardage/tokens` `T.*`;
calm list, NOT a grid dashboard.

Spec: `specs/course-detail-start-round.md`. Pattern references verified:
`lib/round-url.ts`, `app/round/[id]/page.tsx`, `app/round/[id]/RoundPageClient.tsx`,
`app/round/new/page.tsx`, `components/CourseSearch.tsx`, `components/nav/*`,
`app/page.tsx` (hub padding), `lib/golf-api.ts`.

---

## Files to ADD

1. `frontend/src/lib/course-url.ts` — pure URL helper (unit-tested).
2. `frontend/src/lib/course-handoff.ts` — sessionStorage handoff (SSR-safe).
3. `frontend/src/lib/course-list.ts` — pure recent-list mapping helper (unit-tested).
4. `frontend/src/app/courses/page.tsx` — `/courses` hub (client).
5. `frontend/src/app/courses/[id]/page.tsx` — static shell + Suspense.
6. `frontend/src/app/courses/[id]/CourseDetailClient.tsx` — detail client.
7. `frontend/src/lib/course-url.test.ts` — vitest.
8. `frontend/src/lib/course-list.test.ts` — vitest.

## Files to CHANGE

9. `frontend/src/app/round/new/page.tsx` — one mount effect to prefill from handoff.
10. `frontend/src/components/nav/FloatingTabBar.tsx` — add 5th "Courses" tab + icon.
11. `frontend/src/components/nav/shouldShowTabBar.ts` — add `/courses` to `HUB_ROUTES`.
12. `frontend/src/components/nav/shouldShowTabBar.test.ts` — true/false cases.

No new dependencies. No backend changes.

---

## 1. `lib/course-url.ts` (pure)

Mirror `lib/round-url.ts` exactly (same static-export rationale — copy the
header comment intent).

```
export const COURSE_VIEW_SEGMENT = "view";

export function courseHref(
  args: { courseId: string | number; clubId?: string | number }
): string {
  const id = encodeURIComponent(String(args.courseId));
  const base = `/courses/${COURSE_VIEW_SEGMENT}?id=${id}`;
  return args.clubId != null && String(args.clubId) !== ""
    ? `${base}&clubId=${encodeURIComponent(String(args.clubId))}`
    : base;
}
```

Why a query param, not a real dynamic path: static export (`output: 'export'`)
has no RSC data file for `/courses/<realId>` → Next falls back to a HARD browser
navigation → Capacitor serves root `index.html` → cold-boot/AuthGate hang. The
single static `view` segment keeps navigation client-side. This is the
established fix (round + tournament already do it).

## 2. `lib/course-handoff.ts` (SSR-safe sessionStorage)

Avoids restructuring `round/new` (no Suspense/useSearchParams rewrite) while
passing a rich course object intact.

```
const KEY = "looper_course_handoff";

// Shape MUST equal SelectedCourse in round/new (id | name | clubName? |
// location? | holes? | par?). Keep these in sync (see "Keep in sync").
export interface CourseHandoff {
  id: number | string;
  name: string;
  clubName?: string;
  location?: string;
  holes?: number;
  par?: number;
}

export function stashCourseForRound(c: CourseHandoff): void {
  if (typeof window === "undefined") return;
  try { sessionStorage.setItem(KEY, JSON.stringify(c)); } catch {}
}

export function takeCourseForRound(): CourseHandoff | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);     // read-and-clear (one-shot)
    return JSON.parse(raw) as CourseHandoff;
  } catch { return null; }
}
```

sessionStorage (not localStorage) so a stale handoff never survives an app
relaunch and silently overrides a fresh manual/voice setup.

## 3. `lib/course-list.ts` (pure)

```
import { courseHref } from "./course-url";

export interface RecentCourseRow { id: string; name: string; clubName: string; }
export interface RecentCourseItem {
  id: string; title: string; subtitle: string; href: string;
}

// getRecentCourses() rows -> calm list items. Recent rows carry no clubId,
// so href omits clubId (detail falls back to getCourseDetails(id) alone).
export function mapRecentCourses(
  rows: Array<{ id: string | number; name: string; clubName: string }>
): RecentCourseItem[] {
  return rows.map((r) => ({
    id: String(r.id),
    title: r.name,
    // subtitle: clubName only when it differs from the display name (composed
    // names like "Bethpage Black" already contain the club).
    subtitle: r.clubName && r.clubName !== r.name ? r.clubName : "",
    href: courseHref({ courseId: r.id }),
  }));
}
```

Pure → fully unit-testable without GolfAPI.

## 4. `app/courses/page.tsx` — hub (`"use client"`, default `CoursesHubPage`)

Layout (calm, single column, NOT a grid). Reuse `T.*`, `PAPER_NOISE`, the
round/new "course card" button styling, and `app/page.tsx` row/section idioms.

Outer wrapper mirrors `app/page.tsx`:
- `minHeight:100vh`, background `${PAPER_NOISE}, ${T.paper}`, `backgroundBlendMode:"multiply"`.
- Inner `maxWidth:420, margin:"0 auto"`, **`paddingBottom:"calc(88px + env(safe-area-inset-bottom, 0px))"`** (hub clears the floating tab bar).

Sections top→bottom:
1. Masthead: mono kicker `COURSES`, serif-italic title (e.g. "The course book").
   Header top inset `padding:"max(14px, env(safe-area-inset-top)) 22px 14px"`.
2. "Find a course" affordance — full-width paper card button (clone round/new's
   Course card visual: `border 1px ${T.hairline}`, `borderRadius:14`, serif
   italic prompt "Search by name or location"). `onClick` → `setShowSearch(true)`.
3. "Recent" section — `getRecentCourses()` → `mapRecentCourses(...)`; render rows
   with dashed separators (`borderTop: i===0 ? none : 1px dashed ${T.hairline}`),
   serif title + mono subtitle + `›`, `minHeight:44`. Tap → `router.push(item.href)`.
   Omit the whole section when empty (no empty-state noise on first run; the
   search affordance is the primary action).
4. "Nearby" section (optional, device-only) — see geolocation flow below. Omit
   entirely on no permission / no fix / error (NORTHSTAR: no scary errors).

State: `showSearch`, `recent` (from getRecentCourses on mount), `nearby`,
`nearbyState: "idle"|"loading"|"done"`.

CourseSearch overlay (reuse, do NOT start a round here):
```
{showSearch && (
  <CourseSearch
    onClose={() => setShowSearch(false)}
    onSelectCourse={(c) => {
      setShowSearch(false);
      router.push(courseHref({ courseId: c.id, clubId: c.clubId }));
    }}
  />
)}
```
`CourseSearch.onSelectCourse` payload is `{id,name,clubName,clubId,location?,
holes?,par?}` — `id` is the course id (golfApiCourseId) when a sub-course is
picked, or the club id when the club has no sub-courses; `clubId` is always the
club id. `courseHref` carries both.

Geolocation (Nearby) — best-effort, mount effect:
```
if (!("geolocation" in navigator)) return;        // omit section
navigator.geolocation.getCurrentPosition(
  async (pos) => {
    setNearbyState("loading");
    const res = await searchNearby(pos.coords.latitude, pos.coords.longitude);
    setNearby(res); setNearbyState("done");
  },
  () => { /* denied / no fix → leave idle, section omitted */ },
  { timeout: 8000, maximumAge: 600000 }
);
```
Nearby rows are `CourseSearchResult`: navigate with
`courseHref({ courseId: r.golfApiCourseId ?? r.id, clubId: r.golfApiClubId })`.
Rows lacking `golfApiCourseId` (pure OSM results) still navigate by `r.id`; the
detail page handles a not-found gracefully. (Acceptable for v1; note in PR.)

## 5. `app/courses/[id]/page.tsx` — static shell (mirror round/[id]/page.tsx)

```
import { Suspense } from "react";
import CourseDetailClient from "./CourseDetailClient";

export function generateStaticParams() { return [{ id: "view" }]; }

export default function Page() {
  return (<Suspense><CourseDetailClient /></Suspense>);
}
```
Suspense is required because the client calls `useSearchParams()`.

## 6. `app/courses/[id]/CourseDetailClient.tsx` (`"use client"`)

Reads ids from the query (NOT the path param):
```
const sp = useSearchParams();
const courseId = sp.get("id");
const clubId = sp.get("clubId");
```

Fetch (mount effect keyed on `[courseId, clubId]`):
- `getCourseDetails(courseId)` → `GolfCourse | null` (holes, par, slope, rating, tees).
- If `clubId` present: `getClubDetails(clubId)` → `GolfClub | null` (name, city/state, courses).
- Run both with `Promise.all`; tolerate either being null. Both are cache-first
  + proxy + already swallow errors (return null), so wrap in try/catch only as a
  safety net and always clear `loading` in `finally`.

Display name + location:
- name = `composeCourseName(club?.name ?? "", course?.name ?? club?.name ?? "")`
  (exported from golf-api.ts).
- location = `[club?.city, club?.state, club?.country].filter(Boolean).join(", ")`.
- holes = `course?.holes`; par = `course?.par`; tees = `course?.tees ?? []`.

States (yardage-styled, copy the visual language from RoundPageClient
loading/not-found blocks):
- `loading` → centered mono "Loading…" on paper.
- not-found (`!course && !club`) → serif-italic "Course not found" + sub +
  "Back to courses" pill → `router.push("/courses")`.

Render (calm single column, `maxWidth:420`, back chevron → `/courses`):
- mono kicker `COURSE`, serif-italic name (large), location line.
- MiniStat row: Par / Holes (reuse round/new MiniStat idiom) when present.
- Tees: section label "Tees" + dashed rows — color dot (`tee.color`), `tee.name`,
  `tee.totalYards` mono. If `tees.length === 0` → quiet "Tee data unavailable"
  line (no error).
- Primary CTA "Start a round here" (solid `T.ink` pill, serif italic), full width:
```
onClick={() => {
  const handoff = {
    id: courseId,                 // string from query; round/new stringifies anyway
    name,
    clubName: club?.name,
    location,
    holes: course?.holes,
    par: course?.par,
  };
  saveRecentCourse({ id: courseId, name, clubName: club?.name ?? name });
  stashCourseForRound(handoff);
  router.push("/round/new");
}}
```
`saveRecentCourse` + `stashCourseForRound` from golf-api.ts / course-handoff.ts.

NOTE this page is `/courses/view` at runtime → NOT a hub → tab bar auto-hidden
(correct; full-bleed CTA needs the space). Add bottom padding for the CTA only,
not for a tab bar.

## 9. `app/round/new/page.tsx` — prefill on mount (one effect)

Add import: `import { takeCourseForRound } from "@/lib/course-handoff";`

Add ONE effect near the existing saved-players effect (runs once):
```
useEffect(() => {
  const c = takeCourseForRound();
  if (c) setSelectedCourse(c);
}, []);
```
`takeCourseForRound` clears the stash, so it can't re-fire or fight a later
voice/manual selection. `CourseHandoff` is shape-compatible with the local
`SelectedCourse` type. No other change to round/new — voice/manual paths
untouched, `handleTeeOff` already stringifies `selectedCourse.id`.

## 10. `components/nav/FloatingTabBar.tsx` — 5th tab

Add an inline `CoursesIcon` matching the others (viewBox `0 0 24 24`, no fill,
`stroke="currentColor"`, `strokeWidth="1.5"`, round caps/joins, `aria-hidden`).
Use a flag-on-green / map-pin motif, e.g. flagstick:
```
function CoursesIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 21V4" />
      <path d="M6 4l11 2.5L6 10" />
      <path d="M4 21h16" />
    </svg>
  );
}
```
Insert into `TABS` (recommend after Home so browsing is high in the order):
```
{ href: '/', label: 'Home', Icon: HomeIcon },
{ href: '/courses', label: 'Courses', Icon: CoursesIcon },
{ href: '/players', label: 'Partners', Icon: UsersIcon },
{ href: '/tee-time', label: 'Tee times', Icon: CalendarClockIcon },
{ href: '/profile', label: 'Profile', Icon: ProfileIcon },
```
Risk: 5 tabs at `maxWidth:420` (and down to ~320px) tightens each cell; labels
already wrap to `fontSize:10.5`. "Courses" is short — fits. Verify visually at
320px in the designer review. No layout code change needed (flex:1 per tab).

## 11. `components/nav/shouldShowTabBar.ts`

`export const HUB_ROUTES = ['/', '/courses', '/players', '/profile', '/tee-time'] as const;`
`normalizePath` already strips the trailing slash → `/courses/` matches.
`/courses/view` is NOT in HUB_ROUTES → returns false → tab bar hidden on detail.

## 12. `components/nav/shouldShowTabBar.test.ts`

- Add `/courses` to the exact-hub `it.each` (true).
- Add `/courses/` to the trailing-slash `it.each` (true).
- Add `/courses/view` (and e.g. `/courses/view?id=123` is a pathname-only test,
  so just `/courses/view`) to the non-hub `it.each` (false).

## 7/8. Unit tests

`course-url.test.ts`:
- `courseHref({courseId: 123})` === `/courses/view?id=123`.
- with clubId === `/courses/view?id=123&clubId=45`.
- encoding: courseId/clubId containing space / `&` / unicode are
  `encodeURIComponent`-escaped.
- empty-string clubId is omitted.

`course-list.test.ts`:
- maps rows → `{id,title,subtitle,href}`; `href` uses `courseHref` (no clubId).
- subtitle blanked when `clubName === name`; kept when different.
- numeric ids stringified.

---

## Edge cases (handle, don't crash, stay quiet)

- **No GPS / permission denied / timeout** → Nearby section omitted entirely; no
  banner. (Device-only path; not headless — call out in PR.)
- **GolfAPI failure** → `getCourseDetails`/`getClubDetails` already return null
  (errors swallowed + cache-first). Detail shows not-found; hub search shows
  CourseSearch's own error row; Nearby just stays empty.
- **Missing tees** (`tees` empty/undefined) → quiet "Tee data unavailable", no error.
- **Club vs course id**: `?id=` is the course id; `?clubId=` the club id. When a
  club with no sub-courses was picked, `id === clubId` and `getCourseDetails(id)`
  returns null → fall back to club info for name/location; "Start a round" still
  works (name carried). Recent rows have no clubId → club fetch skipped.
- **Missing `?id=`** (direct hit on `/courses/view`) → treat as not-found.
- **OSM-only nearby rows** (no `golfApiCourseId`) → navigate by `r.id`; detail
  gracefully not-found. Acceptable v1.
- **Stale handoff**: sessionStorage + read-and-clear prevents leaking into a
  later manually/voice-configured round.

## Keep in sync

- `CourseHandoff` (course-handoff.ts) ⇄ `SelectedCourse` (round/new) — same fields.
- `COURSE_VIEW_SEGMENT` value `"view"` ⇄ `generateStaticParams()` in
  `courses/[id]/page.tsx` (must both be `"view"`).
- `HUB_ROUTES` ⇄ tab-bar mental model: every `TABS.href` must be in `HUB_ROUTES`
  (else the bar hides itself on its own destination). Adding `/courses` to TABS
  REQUIRES adding it to HUB_ROUTES + the test.
- Icon conventions in FloatingTabBar (viewBox 24, strokeWidth 1.5).
- Reuse `composeCourseName`, `saveRecentCourse`, `getRecentCourses`,
  `getCourseDetails`, `getClubDetails`, `searchNearby` from golf-api.ts — do not
  re-implement.

## Gates (all must pass)

1. `npm run lint`
2. `npx tsc --noEmit`
3. `npx tsx voice-tests/runner.ts --smoke`  → 265/265
4. `npx vitest run`  (incl. course-url, course-list, shouldShowTabBar)
5. `npm run build`  (static export must still generate `out/courses/view` and
   `out/courses` — verify no hard-nav regression)

Run gates from `frontend/` (where package.json + vitest config live). Live
GolfAPI + GPS paths are NOT headless — exercise the pure helpers in vitest and
note manual device verification in the PR.

## Suggested build order

1. `course-url.ts` + test → `course-list.ts` + test (pure, gate-able first).
2. `course-handoff.ts`.
3. `courses/[id]/page.tsx` + `CourseDetailClient.tsx`.
4. `courses/page.tsx` (hub).
5. `round/new` prefill effect.
6. Tab bar + shouldShowTabBar + test.
7. Run all gates; designer review against NORTHSTAR.

---

### Critical Files for Implementation
- /Users/justinlee/projects/scorecard/frontend/src/app/courses/[id]/CourseDetailClient.tsx
- /Users/justinlee/projects/scorecard/frontend/src/app/courses/page.tsx
- /Users/justinlee/projects/scorecard/frontend/src/lib/course-handoff.ts
- /Users/justinlee/projects/scorecard/frontend/src/lib/course-url.ts
- /Users/justinlee/projects/scorecard/frontend/src/components/nav/FloatingTabBar.tsx
