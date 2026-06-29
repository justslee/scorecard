# Spec — course-reviews-surface (B3, epic course-search-reviews)

## Goal
Display the course reviews that B2 (`course-review-model`) lets users write. READ/DISPLAY ONLY.
Do NOT change the write path, the `course_reviews` table, or any migration. No new migration.

Classification: **noticeable** (two new user-visible surfaces). Owner-only app; all routes
gated by `_owner_only`; reads are additionally row-scoped to `current_user_id`.

## Surface 1 — Course detail screen
`frontend/src/app/courses/[id]/CourseDetailClient.tsx` (route `/courses/[id]`, read via `?id=`).
- The `?id=` query param IS the GolfAPI course id — the same value B2 stores as `course_key`
  when `resolveCourseKey` matches a recent course (`String(match.id)`). So use `courseId`
  directly as the `courseKey` for the fetch. No new key plumbing needed.
- Fetch `getCourseReviews(courseId)` (already in `frontend/src/lib/api.ts`) in the existing
  load effect (guarded by `courseId`, cancellable like the current effect).
- Render a calm "Reviews" section below the Tees section / before or after the CTA:
  rating (e.g. ●●●●○ or "4 / 5" mono), body note (serif), date (mono, from `playedAt`
  or `createdAt`). Yardage-book styling with `T.*` tokens, matching the Tees section header
  pattern (mono uppercase kicker + dashed hairline rows).
- States: loading (quiet), empty ("No reviews yet." calm serif/mono — mirror the existing
  "Tee data unavailable." treatment), error (silent fail / treat as empty — do not crash).

## Surface 2 — Profile screen
`frontend/src/app/profile/page.tsx`.
- Add a new **`Section`** (reuse the existing `Section` shell, kicker/title pattern) listing
  the user's OWN reviews across all courses. Insert it in the main render composition
  (around line 282-287, with the other real-data sections), e.g. after `ShotAnalytics` or
  near the season log — keep ordering calm and sensible.
- Each row: course name (serif, fallback to courseKey), rating (mono), date. Empty state:
  calm "No reviews yet." Loading: quiet.
- Fetch via new `getMyReviews()` client helper → new backend read endpoint.

## Backend — new additive read endpoint
`backend/app/routes/course_reviews.py`.
- Add `GET /api/reviews/mine` returning `list[CourseReview]` filtered by
  `owner_id == current_user_id`, ordered `created_at desc`.
- Implementation: add a SECOND `APIRouter(prefix="/api/reviews")` in the same file (export as
  e.g. `reviews_router`) OR add the route to the existing router with an absolute path. Prefer
  a second router named clearly; register it in `backend/app/main.py` with `dependencies=_owner_only`
  alongside `course_reviews.router` (BEFORE the catch-all `courses.router` is irrelevant here since
  the prefix differs, but register near it). Do NOT touch `require_owner` / `_owner_only`.
- Reuse `_orm_to_pydantic`, `current_user_id`, `async_session`. No new model, no migration.

## Frontend client + types
- `frontend/src/lib/api.ts`: add `getMyReviews(): Promise<CourseReview[]>` →
  `fetchAPI('/api/reviews/mine')`. Reuse existing `CourseReview` type (no type changes needed).

## Backend test
`backend/tests/integration/test_course_reviews.py` (extend): add a class for `/api/reviews/mine`:
- returns the caller's own reviews across multiple course_keys, ordered created_at desc;
- cross-user isolation (owner B does not see owner A's reviews);
- empty list when none;
- auth fails-closed (no auth → 401/503).

## Gates (all must pass)
Frontend: `npm run lint` · `npx tsc --noEmit` · `npx tsx voice-tests/runner.ts --smoke` (265/265)
· `npx vitest run` · `npm run build`.
Backend: `ruff check .` + `pytest` (incl. the new test).

## Out of scope / constraints
- No write-path changes, no table/schema/migration changes.
- No new design language — `T.*` tokens + existing patterns only.
- Designer review (NORTHSTAR) on both surfaces; reviewer + `/security-review` on the new endpoint.
