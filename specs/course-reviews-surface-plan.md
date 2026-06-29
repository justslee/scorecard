# Implementation Plan — `course-reviews-surface` (B3)

Epic: `course-search-reviews`. Classification: **noticeable** (two new user-visible surfaces).
This plan is the contract handed to the builder. READ/DISPLAY ONLY.

## Hard constraints (do not violate)
- **No new migration. No schema change.** Reuse the existing `course_reviews` table.
- **Do not touch the write path** (`POST /api/courses/{course_key}/reviews`), `require_owner`, or `_owner_only`.
- New endpoint must be **additive, owner-scoped, read-only**.
- **No new design language.** `T.*` tokens + existing yardage-book patterns only (NORTHSTAR).
- Reuse the existing GET endpoint on Surface 1; reuse `_orm_to_pydantic`, `current_user_id`, `async_session` on the backend.

---

## 1. Surface 1 — Course detail (`frontend/src/app/courses/[id]/CourseDetailClient.tsx`)

### Key resolution (confirmed)
The route reads `?id=` via `sp.get("id")` into `courseId` (line 24). This `?id=` value **is the GolfAPI course id string** — the exact same value B2 persists as `course_key` when `resolveCourseKey` matches a recent course (`String(match.id)`, see `frontend/src/lib/course-review-key.ts` line 51). Therefore `courseId` can be used **directly** as the `courseKey` for the fetch — no new key plumbing. This matches B2's stored key only for the GolfAPI-id branch; the `name:<slug>` fallback branch will NOT match here (see Edge cases §6).

### Where to fetch
Extend the **existing cancellable load effect** (lines 31-64), do not add a second effect. Add a third promise to the existing `Promise.all`, guarded by the same `courseId` check that already gates the effect:

- New state alongside `course`/`club`/`loading`:
  - `const [reviews, setReviews] = useState<CourseReview[]>([]);`
  - (No separate reviews-loading flag needed; piggyback on the existing `loading`. The reviews block simply renders empty until `loading` clears.)
- Import `getCourseReviews` and the `CourseReview` type:
  - `import { getCourseReviews } from "@/lib/api";`
  - `import type { CourseReview } from "@/lib/types";`
- In `load()`, change the `Promise.all` to include reviews. Because `getCourseDetails`/`getClubDetails` already swallow errors and return null, but `getCourseReviews` (via `fetchAPI`) may **throw**, wrap the reviews fetch so a review failure NEVER blocks course rendering:

```ts
const [courseData, clubData, reviewData] = await Promise.all([
  getCourseDetails(courseId!),
  clubId ? getClubDetails(clubId) : Promise.resolve(null),
  getCourseReviews(courseId!).catch(() => [] as CourseReview[]), // silent fail → empty
]);
if (!cancelled) {
  setCourse(courseData);
  setClub(clubData);
  setReviews(reviewData);
}
```

- In the outer `catch`, also `setReviews([])` for the unexpected-runtime-failure safety net.
- The `cancelled` guard already in place covers the new state setter.

### Where to render
Insert a new **Reviews section** between the Tees section (ends line 364) and the Primary CTA (line 366). Rationale: tees are course facts, reviews are the golfer's own notes, the CTA is the action — reviews read naturally just above the action. (Placing it after the CTA is also acceptable per spec; prefer before to keep the CTA as the last, most prominent element.)

Mirror the **Tees section header pattern** exactly (lines 282-296): a `padding: "18px 22px 10px"` wrapper, a mono uppercase kicker reading `Reviews`, then dashed-hairline rows.

### Row layout (per review)
Each row mirrors the Tees row treatment (lines 312-361): `display:flex`, `gap`, `padding: "11px 0"`, `borderTop: i === 0 ? "none" : "1px dashed " + T.hairline`, `minHeight: 44`.
- **Rating** (mono, `T.ink`): render as `"{rating} / 5"` in `T.mono` (e.g. `fontSize: 10, letterSpacing: 1.1`). Keep it textual/mono for calm — avoid glyph dots unless trivial; `"4 / 5"` is the safe default. Rating is always 1-5 (validated server-side), so no clamping logic needed, but render `Math.max(1, Math.min(5, rating))` defensively is optional.
- **Body note** (serif, `T.ink`, `fontSize: 14-16`, `letterSpacing: -0.1`): the main line. Only render when `body` is present.
- **Date** (mono, `T.pencilSoft`, `fontSize: 9-10`, uppercase, `letterSpacing: 1.1`): prefer `playedAt`, fall back to `createdAt` (see §6 for formatting).
- Suggested arrangement: a left column with the serif body note (or course context) and a mono date sub-line, and a right-aligned mono rating — matching how the Tees row puts name left and yards right.

### States (calm)
- **Loading**: while the outer `loading` is true the whole component already shows the centered `Loading…` screen (lines 74-94); the Reviews block never renders during load, so no separate spinner. (If reviews ever get their own effect, suppress the body with a `minHeight` placeholder like the profile sections — but with the shared effect this is unnecessary.)
- **Empty** (`reviews.length === 0`): mirror the "Tee data unavailable." treatment (lines 297-309) exactly — serif italic, `fontSize: 14`, `color: T.pencilSoft`. Copy: **"No reviews yet."**
- **Error**: silent — already handled by `.catch(() => [])`, which collapses to the empty state. Never crash; never surface an error chrome on this calm screen.

---

## 2. Surface 2 — Profile (`frontend/src/app/profile/page.tsx`)

### New `Section`
Reuse the existing `Section` shell (defined line 298) — `kicker` + `title` + optional `aside` + `children`. New component `CourseReviews` (or `MyReviews`) following the `ScoringByTee`/`YearLog` shape:

```
<Section kicker="Notes" title="Course reviews" aside={countAside}>
```

- `kicker`: `"Notes"` (mono uppercase, set by `Section`). `title`: `"Course reviews"` (serif italic, set by `Section`).
- Optional `aside`: review count, only when data exists and not loading — same pattern as `YearLog` (lines 1312-1316): `{n} {n === 1 ? "review" : "reviews"}`.

### Where to insert in render composition
In the main render (lines 282-287), insert after `<YearLog .../>` (the season log) and before `<ShotAnalytics />`. This keeps real-data sections grouped and leading, with the placeholder shot analytics last. Final order:
`ScoringByTee → ParBreakdown → ScoreDistribution → YearLog → CourseReviews (new) → ShotAnalytics → Footer`.

### Fetching (independent of profile/rounds)
The profile page loads `profile`/`rounds` via `storage-api` in a `useEffect` (lines 173-188). Reviews come from a **separate source** (`getMyReviews()`), so add a small dedicated effect inside the new `CourseReviews` component (self-contained, mirrors how sections receive data but here it owns its own fetch since the parent doesn't have it):

```ts
function CourseReviews() {
  const [reviews, setReviews] = useState<CourseReview[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    getMyReviews()
      .then((rs) => { if (!cancelled) setReviews(rs); })
      .catch(() => { if (!cancelled) setReviews([]); })   // silent fail → empty
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  ...
}
```

Import `getMyReviews` from `@/lib/api` and `type { CourseReview }` from `@/lib/types`.

### Row layout (per review)
Grid like `YearLog` (lines 1359-1456): `gridTemplateColumns` with a course-name column (flex/serif), a rating column (mono), and a date column (mono), `borderTop: i === 0 ? "none" : "1px dashed " + T.hairlineSoft`, `minHeight: 44`.
- **Course name** (serif, `fontSize: 14`, `T.ink`, ellipsis-truncated like the YearLog course cell): `review.courseName` with **fallback to `review.courseKey`** when `courseName` is absent. For a `name:<slug>` key, optionally strip the `name:` prefix for display (cosmetic, see §6).
- **Rating** (mono, `T.ink`): `"{rating} / 5"`.
- **Date** (mono, `T.pencilSoft`): prefer `playedAt`, fall back to `createdAt`, formatted short (§6).

### States
- **Loading**: suppress body with `<div style={{ minHeight: 40 }} />` exactly like `ScoringByTee`/`YearLog` (lines 1200-1202) to avoid empty-state flash on mount.
- **Empty**: serif italic `T.pencilSoft` `fontSize: 14` block — copy **"No reviews yet."** (matches the calm empty copy used by sibling sections such as "Play a round to see…").
- **Error**: silent — `.catch` collapses to empty.

(No "Show all" cap needed initially; if the list grows, reuse the `YearLog` `SEASON_LOG_CAP` disclosure pattern. Out of scope for v1.)

---

## 3. Backend — `GET /api/reviews/mine`

### Design (in `backend/app/routes/course_reviews.py`)
Add a **second `APIRouter`** in the same file, with a distinct prefix so it cannot collide with the `/api/courses/*` sub-resource router or the catch-all `courses.router`:

```python
reviews_router = APIRouter(prefix="/api/reviews", tags=["course-reviews"])

@reviews_router.get("/mine", response_model=list[CourseReview])
async def list_my_reviews(
    owner_id: str = Depends(current_user_id),
) -> list[CourseReview]:
    """List ALL of the calling owner's reviews across every course_key.

    B3 read surface. Owner-scoped (owner_id == current_user_id), ordered
    created_at desc. Reuses _orm_to_pydantic; no new model, no migration.
    """
    async with async_session() as db:
        result = await db.execute(
            select(CourseReviewORM)
            .where(CourseReviewORM.owner_id == owner_id)
            .order_by(CourseReviewORM.created_at.desc())
        )
        return [_orm_to_pydantic(r) for r in result.scalars().all()]
```

- Reuses the file's existing imports (`APIRouter`, `Depends`, `select`, `async_session`, `CourseReviewORM`, `CourseReview`, `current_user_id`, `_orm_to_pydantic`). No new imports required.
- Owner-scoped filter is the ONLY `where` clause (no `course_key`) — returns the user's reviews across all keys.
- Ordering: `created_at desc` (consistent with the existing `list_reviews`).
- The route body only needs `current_user_id` for row-level filtering — the app-level `_owner_only` dependency (registered in main.py) does the auth gate, identical to the existing routes.

### Registration (in `backend/app/main.py`)
- Import is already covered by `from app.routes import course_reviews` (line 50) — `reviews_router` is an attribute of that module, so **no new import line** is needed; reference it as `course_reviews.reviews_router`.
- Register **with `dependencies=_owner_only`**, alongside the existing `course_reviews.router` registration (after line 66):

```python
app.include_router(course_reviews.router, dependencies=_owner_only)
app.include_router(course_reviews.reviews_router, dependencies=_owner_only)  # NEW — /api/reviews/mine
app.include_router(courses.router, dependencies=_owner_only)
```

### Route-shadowing analysis (confirmed: none)
- The new prefix is `/api/reviews`, which shares **no** path prefix with `/api/courses`. Starlette's first-match-wins ordering concern (documented at main.py lines 60-62) applies only within `/api/courses/*`. `/api/reviews/mine` is a fixed two-segment literal path under a distinct prefix; nothing can shadow it and it shadows nothing.
- Registration order relative to `courses.router` is therefore **irrelevant** for correctness; place it adjacent to the other reviews router for readability.

---

## 4. Frontend client helper (`frontend/src/lib/api.ts`)

Add below `createCourseReview` (after line 504), in the existing "Course Reviews API" block:

```ts
/**
 * List ALL of the calling user's course reviews across every course key.
 * Owner-scoped server-side; ordered created_at desc. (B3 read surface.)
 */
export async function getMyReviews(): Promise<CourseReview[]> {
  return fetchAPI<CourseReview[]>('/api/reviews/mine');
}
```

- `CourseReview` is already imported in api.ts (lines 23/40). `fetchAPI` is already in scope.
- **No `types.ts` change** — `CourseReview` (types.ts line 226) already mirrors the backend model exactly (`courseKey`, `courseName?`, `rating`, `body?`, `playedAt?`, `createdAt`). The endpoint returns the same shape as `getCourseReviews`. Confirmed: no type changes needed.

---

## 5. Backend tests (`backend/tests/integration/test_course_reviews.py`)

Append a new class using the existing conftest helpers (`TEST_OWNER_ID`, `OTHER_OWNER_ID`, `set_auth`, `client` fixture — confirmed at conftest.py lines 46-47, 138, 149). Reuse the existing POST endpoint to seed data.

```python
MINE = "/api/reviews/mine"

class TestMyReviews:
    async def test_returns_own_across_keys_ordered_desc(self, client):
        set_auth(TEST_OWNER_ID)
        # seed across multiple course_keys
        await client.post(f"{BASE}/11111/reviews", json={"rating": 3, "body": "first"})
        await client.post(f"{BASE}/22222/reviews", json={"rating": 5, "body": "second"})
        await client.post(f"{BASE}/name:third-course/reviews".replace("name:", "name%3A"),
                          json={"rating": 4, "body": "third"})
        r = await client.get(MINE)
        assert r.status_code == 200, r.text
        items = r.json()
        assert len(items) == 3
        # all owned by caller
        assert all(it["ownerId"] == TEST_OWNER_ID for it in items)
        # spans multiple keys
        assert {it["courseKey"] for it in items} == {"11111", "22222", "name:third-course"}
        # created_at desc — non-increasing
        created = [it["createdAt"] for it in items]
        assert created == sorted(created, reverse=True)

    async def test_cross_user_isolation(self, client):
        set_auth(TEST_OWNER_ID)
        await client.post(f"{BASE}/11111/reviews", json={"rating": 4})
        set_auth(OTHER_OWNER_ID)
        r = await client.get(MINE)
        assert r.status_code == 200, r.text
        assert r.json() == [], f"owner B must not see owner A's reviews, got {r.json()}"

    async def test_empty_when_none(self, client):
        set_auth(OTHER_OWNER_ID)
        r = await client.get(MINE)
        assert r.status_code == 200, r.text
        assert r.json() == []

    async def test_auth_fails_closed(self, client):
        # no set_auth — overrides cleared by fixture
        r = await client.get(MINE)
        assert r.status_code in (401, 503), f"expected fail-closed, got {r.status_code}"
```

Notes for the builder:
- Ordering assertion compares ISO `createdAt` strings; if rows can share a timestamp at sub-second granularity in the test DB, prefer asserting the set membership + that the list is sorted-desc rather than exact positions. Keep the seed inserts sequential (they are awaited in order).
- Use the existing `quote(...)` helper (already imported) for the `name:` key rather than manual `.replace`; shown inline above for clarity.

---

## 6. Edge cases & risks

- **courseKey mismatch on the detail page (GolfAPI id vs `name:<slug>`).** Surface 1 fetches with `courseId` (the GolfAPI id). Reviews written via the `name:<slug>` fallback branch of `resolveCourseKey` are keyed differently and will NOT appear on the detail page. This is expected and graceful: the detail page simply shows "No reviews yet." for those. Do not attempt cross-key reconciliation in B3 (out of scope; would require resolving recent courses on the detail screen). Surface 2 (`/mine`) shows ALL reviews regardless of key, so nothing is lost to the user.
- **Date formatting.** `playedAt` is an ISO date (`YYYY-MM-DD`); `createdAt` is an ISO datetime. Prefer `playedAt`; fall back to `createdAt`. Parse defensively: `const d = new Date(value); isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" })` — mirrors the `YearLog` date handling (lines 1341, and the invalid-date guard at lines 138-139). For a bare `YYYY-MM-DD`, `new Date("2026-06-20")` parses as UTC midnight; acceptable for a short month/day label. If exact-day fidelity matters, split the string manually — but short label is fine and calm here.
- **Rating render (1-5).** Always within 1-5 (server-validated, 422 otherwise). Render `"{rating} / 5"` in mono. Optional defensive clamp; not required.
- **SSR / `'use client'`.** Both target files already declare `"use client"` (CourseDetailClient.tsx line 1; profile/page.tsx line 1). All fetching happens in `useEffect` (client-only), so there is no prerender/Clerk-hook hazard — same approach the profile page already uses to avoid `useAuth()` during prerender (see comment at lines 166-168). `getMyReviews`/`getCourseReviews` go through `fetchAPI`, which carries auth the same way as every other client call.
- **Empty-state copy.** Use **"No reviews yet."** on both surfaces — calm, matches the tone of "Tee data unavailable." and the profile sections' empty copy. Do not add CTAs to write a review (write path is RoundRecap's job, out of scope).
- **Error handling philosophy.** Both surfaces swallow fetch errors to the empty state (`.catch(() => [])`). No error chrome, no crash — consistent with NORTHSTAR "calm, out of the way."
- **Risk: review fetch throwing and blocking course render on Surface 1.** Mitigated by the per-promise `.catch` inside `Promise.all` (see §1) so a reviews failure cannot null out `course`/`club`.

---

## 7. Gates (all must pass)

Frontend (run in `frontend/`):
- `npm run lint`
- `npx tsc --noEmit`
- `npx tsx voice-tests/runner.ts --smoke`  (expect 265/265)
- `npx vitest run`
- `npm run build`

Backend (run in `backend/`):
- `ruff check .`
- `pytest`  (including the new `TestMyReviews` class)

Review gates (per spec §"Out of scope / constraints"):
- Designer (NORTHSTAR) review on both surfaces.
- Reviewer + `/security-review` on the new endpoint.

---

## Critical files for implementation
- /Users/justinlee/projects/scorecard/backend/app/routes/course_reviews.py
- /Users/justinlee/projects/scorecard/backend/app/main.py
- /Users/justinlee/projects/scorecard/frontend/src/lib/api.ts
- /Users/justinlee/projects/scorecard/frontend/src/app/courses/[id]/CourseDetailClient.tsx
- /Users/justinlee/projects/scorecard/frontend/src/app/profile/page.tsx
- /Users/justinlee/projects/scorecard/backend/tests/integration/test_course_reviews.py
