# Spec — course-review-model (B2, epic course-search-reviews)

Status: in-progress · Classification: **noticeable** (new user-facing capability) ·
Area: backend + frontend · Size: M · Headless: yes

## Goal
Let a golfer **write a short review of a course right after a round** — a calm rating
(1–5) + a short note — stored server-side, owner-scoped, keyed on a `course_key` (the
GolfAPI course id when available). This deliberately sidesteps the course-identity
unification refactor (`course-identity-unify`, B5) by keying on a stable string instead of
a foreign key into a unified course table.

Surfacing reviews anywhere else (course detail page, profile section, other users) is a
**separate later item** (`course-reviews-surface`, B3) — OUT OF SCOPE here. This item only
delivers: the data model + migration, the create/list endpoints, and the review-entry
form on the RoundRecap modal.

## Backend

### ORM model — `backend/app/db/models.py` (`CourseReview`)
Follow the existing owner-scoped table pattern (`Player`). Table `course_reviews`:
- `id` — UUID PK, `server_default=func.gen_random_uuid()`
- `owner_id` — Text, indexed (the writer; = `current_user_id`). The author identity.
- `course_key` — Text, NOT NULL, indexed. The GolfAPI course id as a string when known,
  else a `name:<normalized-course-name>` fallback so the entry never blocks on missing
  GolfAPI id.
- `course_name` — Text, nullable. Display name captured at write time (so B3 can render
  reviews without re-resolving the course).
- `round_id` — Text, nullable (no DB FK — round ids are plain text elsewhere; matches the
  `round_players.player_id` precedent of no DB-level constraint).
- `rating` — Integer, NOT NULL. Validated 1–5 at the Pydantic layer.
- `body` — Text, nullable. Short note.
- `played_at` — Date, nullable.
- `created_at` — DateTime(timezone=True), NOT NULL, `server_default=func.now()`.

Add an index on `(course_key)` (for B3 list-by-course) — keep it simple; a composite
`(owner_id, created_at)` is optional. Mirror the wording/style of the `Player` model.

### Pydantic shapes — `backend/app/models.py`
camelCase response contract, mirroring `SavedPlayer`:
- `CourseReview` (response): `id, ownerId, courseKey, courseName, roundId, rating, body,
  playedAt, createdAt` (ISO strings for dates).
- `CourseReviewCreate` (request body): `rating` (int, `Field(ge=1, le=5)`), `body`
  (optional, short — cap length e.g. `max_length=2000`), `roundId` (optional),
  `courseName` (optional), `playedAt` (optional). `course_key` comes from the **path**, not
  the body.

Keep `frontend/src/lib/types.ts` ↔ `backend/app/models.py` consistent: add the matching
`CourseReview` / `CourseReviewCreate` TS interfaces.

### Migration — Alembic, ADDITIVE ONLY
`backend/migrations/versions/0006_009_course_reviews.py`:
- `revision = "009_course_reviews"`, `down_revision = "008_round_owner_player"` (current
  head).
- `upgrade()`: `op.create_table("course_reviews", ...)` + `op.create_index` on
  `course_key` (and `owner_id`). **CREATE TABLE / CREATE INDEX only — no drops/alters of
  existing tables.**
- `downgrade()`: drop the index(es) + drop table.
- MUST apply cleanly via `alembic upgrade head` against Postgres (deploy.yml runs this on
  ship). Verify locally against a Postgres container (CI itself uses
  `Base.metadata.create_all`, NOT alembic — so the migration is verified by us, not CI).

### Endpoints — new `backend/app/routes/course_reviews.py`
Auth-gated with the existing `current_user_id` dependency; owner-scoped. Register the
router in `app/main.py` like the other routers. **Do NOT touch `require_owner`.**
- `POST /api/courses/{course_key}/reviews` → create a review owned by the caller; returns
  the `CourseReview`. `course_key` from the path; rating validated 1–5.
- `GET /api/courses/{course_key}/reviews` → list reviews for that `course_key`. For B2,
  scope to the caller's own reviews (`owner_id == current_user_id`) so we expose nothing
  cross-user until B3 deliberately designs that. Order `created_at desc`.

Note: these live under `/api/courses/...` but in a SEPARATE router file — confirm no path
collision with the existing `courses.py` router (which owns `/api/courses`,
`/api/courses/{id}`). The `{course_key}/reviews` sub-path must not shadow or be shadowed by
`/api/courses/{id}`; order/registration must keep both working. The Plan must verify this.

### Tests — `backend/tests/integration/test_course_reviews.py`
Route/integration tests (httpx + the conftest harness): create (201/200 + echo), list
(returns created, owner-scoped — other owner can't see), validation (rating out of 1–5 →
422), auth fails-closed (no auth → 401/403). Add `course_reviews` to the conftest TRUNCATE
list so rows don't leak across tests (legitimate harness upkeep, not test-gaming).

## Frontend

### API client — `frontend/src/lib/api.ts`
Mirror existing patterns (`fetchAPI`):
- `getCourseReviews(courseKey: string): Promise<CourseReview[]>`
- `createCourseReview(courseKey: string, data: CourseReviewCreate): Promise<CourseReview>`
URL-encode `courseKey`.

### Resolving the course_key at recap time (KEY DECISION for the Plan)
`Round` carries `courseId` + `courseName` only — NOT `golfApiCourseId` (that lives on the
GolfAPI search/`Course`/recent-course layer). So the entry point must derive `course_key`:
prefer a resolvable GolfAPI id (e.g. via `getRecentCourses()` matched on course name, or
`getCourse(round.courseId).golfApiCourseId`), else fall back to `name:<normalized
courseName>`. Always send `courseName` (display) + `roundId` + `playedAt` (round date) in
the body. If even `courseName` is empty, hide the entry gracefully. The Plan picks the
simplest robust resolution and documents it.

### Review form — RoundRecap entry point
From `RoundRecap` (rendered by `RoundPageClient.tsx` ~line 1382 on completion). Add a small
calm rating (1–5) + short-note form inside the recap (or a quiet affordance that reveals
it). Yardage-book styling: `T.*` tokens only, Instrument Serif / mono kickers, generous
whitespace, 44pt+ targets, safe-area aware — NO zinc/emerald/slate/lucide, no SaaS card.
POST on submit; show a quiet confirmed state; never block the existing Done flow. Pass the
needed course info into `RoundRecap` via props (keep it a display-plus-one-action view).

## Gates (all must pass; paste output)
- frontend: `npm run lint` · `npx tsc --noEmit` · `npx tsx voice-tests/runner.ts --smoke`
  (265/265) · `npx vitest run` · `npm run build`
- backend: `ruff check .` + `pytest` (incl. new tests) + `alembic upgrade head` against a
  Postgres container (additive migration applies cleanly).

## Review
MAJOR: new authed endpoint + data handling + new table → `reviewer` + `/security-review`
skill; `designer` on the review form against NORTHSTAR. Fold findings in.

## Out of scope
Surfacing reviews (course detail/profile/cross-user) = `course-reviews-surface` (B3).
Course identity unification = `course-identity-unify` (B5).
