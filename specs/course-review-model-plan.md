# Implementation Plan — course-review-model (B2)

Contract for the builder. Refines `specs/course-review-model.md` into exact steps,
names, edge cases, and gates. Follows NORTHSTAR (yardage-book, voice-first, calm) and
CLAUDE.md. Scope is exactly: data model + migration, create/list endpoints, and the
review-entry affordance on RoundRecap. Surfacing reviews elsewhere = B3 (out of scope).

No implementation code is written by this plan; it specifies it.

---

## 0. The three hardest decisions — resolved up front

### 0.1 `/api/courses` path-collision (DEFINITIVE)
There is **no collision**, and registration order is made safe by convention.

- Existing `courses.py` (prefix `/api/courses`) owns single-segment paths:
  `GET ""`, `GET "/{course_id}"`, `POST ""`, `POST "/default"`, `DELETE "/{course_id}"`.
- New router owns **two-segment** paths: `GET "/{course_key}/reviews"`,
  `POST "/{course_key}/reviews"`.
- Starlette compiles a plain path param `{course_id}` to the regex `[^/]+` — it matches a
  **single** segment and never crosses a `/`. A request `GET /api/courses/abc/reviews`
  has two trailing segments, so `/{course_id}` (one segment) cannot match it, and
  `/{course_key}/reviews` (which requires the literal `reviews` suffix) cannot match a
  single-segment `GET /api/courses/<id>`. The two route sets are structurally disjoint.
- Therefore correctness does **not** depend on order. BUT `main.py` already documents the
  house rule (lines 59-64): "Specific `/api/courses/*` routers MUST be registered before
  the catch-all `courses.router`." We follow it defensively (guards against any future
  single-segment review route). **Register `course_reviews.router` immediately BEFORE
  `courses.router`**, alongside `course_search` / `courses_mapped`.

Verification gate (added to the test file): assert `GET /api/courses/{id}` still 404s for a
non-existent scoring course (catch-all intact) AND `GET /api/courses/{key}/reviews` returns
the review list — both in the same test run, proving no shadowing.

### 0.2 `course_key` resolution (client-side, DEFINITIVE)
`Round` carries only `courseId` + `courseName` (see `types.ts` line 153); it has **no**
`golfApiCourseId`. The backend scoring `Course` model has **no** `golf_api_course_id`
column, so `getCourse(round.courseId)` cannot supply a GolfAPI id. The **only** client-side
place a GolfAPI id survives is `getRecentCourses()` (`golf-api.ts` ~line 363), which stores
`{id, name, clubName}` where `id` is the GolfAPI course id.

Resolution order (pure function `resolveCourseKey`, see §4.1):
1. **Prefer GolfAPI id:** normalize `round.courseName` and compare against the normalized
   `name` and `clubName` of each `getRecentCourses()` entry. On first match, use
   `String(match.id)` as the `courseKey`.
2. **Fallback:** `` `name:${normalizeCourseName(round.courseName)}` `` — a stable,
   slug-normalized key so an entry never blocks on a missing GolfAPI id.
3. **Hide:** if `round.courseName` is empty/whitespace, `resolveCourseKey` returns `null`
   and RoundRecap renders no review affordance (graceful hide).

`courseName` (raw display), `roundId` (`round.id`), and `playedAt` (`round.date`) are ALWAYS
sent in the POST body regardless of which key branch was taken. Resolution is computed in
`RoundPageClient` (parent) and passed to RoundRecap as props — RoundRecap stays a
display-plus-one-action view.

### 0.3 Slash-in-key handling (DEFINITIVE)
A raw course name can contain `/` (e.g. "Pebble Beach / Old Course"). If a `course_key`
contained a literal slash and the client `encodeURIComponent`'d it to `%2F`, ASGI servers
(uvicorn) URL-decode the path into `scope["path"]` **before** Starlette routes — `%2F`
becomes `/`, creating a spurious third segment and a 404. This is a real failure mode.

Fix at the source: **`normalizeCourseName` slugifies so the key can never contain a slash**
(or any path-significant char). Rule: `trim → toLowerCase → replace /[^a-z0-9]+/g with "-"
→ strip leading/trailing "-"`. The resulting `name:` key contains only `[a-z0-9:-]`, a
single path segment. GolfAPI ids are numeric strings (also slash-free). The client still
wraps the key in `encodeURIComponent` defensively (encodes the `:` as `%3A`, which decodes
back to a non-slash `:` and stays one segment). FastAPI's plain `{course_key}` str
convertor then receives the intact value. Because the key is slash-free by construction,
the `%2F` ambiguity never arises on either branch. The same normalization is the canonical
key for B3, so GET and POST always agree.

---

## 1. Files to CREATE
- `backend/app/routes/course_reviews.py` — new owner-scoped router (mirrors `players.py`).
- `backend/migrations/versions/0006_009_course_reviews.py` — additive Alembic migration.
- `backend/tests/integration/test_course_reviews.py` — route/integration tests.
- `frontend/src/lib/course-review-key.ts` — pure `resolveCourseKey` + `normalizeCourseName`.
- `frontend/src/lib/course-review-key.test.ts` — vitest unit tests for the helpers.

## 2. Files to EDIT
- `backend/app/db/models.py` — add `CourseReview` ORM model; update header docstring list.
- `backend/app/models.py` — add `CourseReview` + `CourseReviewCreate` Pydantic shapes.
- `backend/app/main.py` — import + register `course_reviews.router` BEFORE `courses.router`.
- `backend/tests/integration/conftest.py` — add `course_reviews` to the TRUNCATE list (~L122).
- `frontend/src/lib/types.ts` — add `CourseReview` + `CourseReviewCreate` interfaces.
- `frontend/src/lib/api.ts` — add `getCourseReviews` + `createCourseReview` (+ TS interfaces).
- `frontend/src/components/RoundRecap.tsx` — add the calm review affordance (props-driven).
- `frontend/src/app/round/[id]/RoundPageClient.tsx` — compute + pass courseKey/courseName props.

---

## 3. Backend

### 3.1 ORM model — `backend/app/db/models.py`
Add after `Player` (template at line 196). Table `course_reviews`:

```
class CourseReview(Base):
    """Owner-scoped course review (B2). Keyed on a string course_key (GolfAPI id
    when known, else name:<slug>) to sidestep course-identity unification (B5)."""
    __tablename__ = "course_reviews"

    id          UUID(as_uuid=False), primary_key, server_default=func.gen_random_uuid()
    owner_id    Text, nullable=False, index=True      # the writer == current_user_id
    course_key  Text, nullable=False, index=True      # GolfAPI id str, or name:<slug>
    course_name Text, nullable=True                    # display name captured at write
    round_id    Text, nullable=True                    # plain text, NO DB FK (round_players precedent)
    rating      Integer, nullable=False                # 1-5 enforced at Pydantic, NOT in DB
    body        Text, nullable=True
    played_at   Date, nullable=True
    created_at  DateTime(timezone=True), nullable=False, server_default=func.now()
```

Notes:
- `owner_id` is `nullable=False` here (the writer is always known); `index=True`.
- `course_key` `index=True` (B3 list-by-course). The `Player` model has `owner_id` nullable;
  we intentionally make `owner_id` NOT NULL on reviews because a review always has an author.
- `import Date` is already present in the models.py import block (line 12). No new imports.
- **No CheckConstraint on `rating`** — the DB does not enforce 1-5; that lives in Pydantic
  (§3.2). This is deliberate and called out so the builder does not add a DB constraint that
  would diverge from the migration / `create_all` test schema.
- Update the module docstring (lines 1-10) "Core scoring schema" line to mention `CourseReview`.

### 3.2 Pydantic shapes — `backend/app/models.py`
Add a new `# ============ Course Reviews ============` section (mirror `SavedPlayer`):

```
class CourseReview(BaseModel):          # response contract, camelCase
    id: str
    ownerId: str
    courseKey: str
    courseName: Optional[str] = None
    roundId: Optional[str] = None
    rating: int
    body: Optional[str] = None
    playedAt: Optional[str] = None      # ISO date string (date.isoformat())
    createdAt: str                      # ISO datetime string

class CourseReviewCreate(BaseModel):    # request body
    rating: int = Field(ge=1, le=5)
    body: Optional[str] = Field(default=None, max_length=2000)
    roundId: Optional[str] = None
    courseName: Optional[str] = None
    playedAt: Optional[str] = None      # ISO date string; parsed to date in the route
```

- `course_key` comes from the **path**, never the body.
- `Field` requires `from pydantic import BaseModel, Field` — update the import on line 3.
- `rating` out of [1,5] -> FastAPI 422 automatically. `body` over 2000 chars -> 422.

### 3.3 Router — `backend/app/routes/course_reviews.py`
Copy the shape of `players.py` (module docstring, `current_user_id` dependency, owner
filtering, `_orm_to_pydantic` mapper). `prefix="/api/courses"`, `tags=["course-reviews"]`.

`_orm_to_pydantic(row)` maps snake_case -> camelCase, with
`playedAt = row.played_at.isoformat() if row.played_at else None` and
`createdAt = row.created_at.isoformat() if row.created_at else ""`.

Endpoints:
```
@router.post("/{course_key}/reviews", response_model=CourseReview)
async def create_review(course_key: str, data: CourseReviewCreate,
                        owner_id: str = Depends(current_user_id)):
    # parse data.playedAt -> date (date.fromisoformat) if present, else None;
    #   on bad format raise HTTPException(422). (Or type playedAt as Optional[date]
    #   in the Pydantic model and let FastAPI coerce/422 — pick the latter, simpler.)
    # build CourseReviewORM(id=str(uuid.uuid4()), owner_id=owner_id, course_key=course_key,
    #   course_name=data.courseName, round_id=data.roundId, rating=data.rating,
    #   body=data.body, played_at=<parsed>)
    # add/commit/refresh; return _orm_to_pydantic(row)

@router.get("/{course_key}/reviews", response_model=list[CourseReview])
async def list_reviews(course_key: str, owner_id: str = Depends(current_user_id)):
    # select CourseReviewORM where course_key == course_key AND owner_id == owner_id
    #   (B2: scope to the caller only — expose nothing cross-user until B3)
    # order_by created_at desc; return [_orm_to_pydantic(r) ...]
```

Decision for `playedAt`: type it as `Optional[date]` in `CourseReviewCreate` so FastAPI does
ISO parsing + 422 on bad input, and the route assigns it straight to `played_at`. The
response `CourseReview.playedAt` stays `Optional[str]` (ISO string from the mapper). This
keeps date handling at the framework layer and avoids manual parsing.

Do NOT touch `require_owner`. The app-level `_owner_only` dependency (main.py) gates the
router; the route body only needs `current_user_id` for row filtering — identical to
`players.py`.

### 3.4 Register router — `backend/app/main.py`
- Add `course_reviews` to the import on line 48 (the `from app.routes import golf, ...` line)
  or extend line 47. Either import line works; keep it with the other course routers for
  readability.
- Add `app.include_router(course_reviews.router, dependencies=_owner_only)` **immediately
  before** `app.include_router(courses.router, ...)` (line 64), grouped with the
  "Specific /api/courses/* routers" block (after course_search / courses_mapped). Add a
  one-line comment noting it is the two-segment reviews sub-resource.

### 3.5 Migration — `backend/migrations/versions/0006_009_course_reviews.py`
Mirror the style of `0005_008_round_owner_player.py`. **ADDITIVE ONLY.**

```
revision = "009_course_reviews"
down_revision = "008_round_owner_player"   # current head
branch_labels = None
depends_on = None

def upgrade():
    op.create_table(
        "course_reviews",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("owner_id", sa.Text, nullable=False),
        sa.Column("course_key", sa.Text, nullable=False),
        sa.Column("course_name", sa.Text, nullable=True),
        sa.Column("round_id", sa.Text, nullable=True),
        sa.Column("rating", sa.Integer, nullable=False),
        sa.Column("body", sa.Text, nullable=True),
        sa.Column("played_at", sa.Date, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("ix_course_reviews_owner_id", "course_reviews", ["owner_id"])
    op.create_index("ix_course_reviews_course_key", "course_reviews", ["course_key"])

def downgrade():
    op.drop_index("ix_course_reviews_course_key", table_name="course_reviews")
    op.drop_index("ix_course_reviews_owner_id", table_name="course_reviews")
    op.drop_table("course_reviews")
```

- Imports: `import sqlalchemy as sa`, `from sqlalchemy.dialects import postgresql`,
  `from alembic import op`, plus the `revision/down_revision` typing block as in 0005.
- `gen_random_uuid()` is built-in in Postgres 13+ (PG16 in CI/deploy) — no pgcrypto needed.
- Index names use the SQLAlchemy `ix_<table>_<col>` convention so they match what
  `Base.metadata.create_all` generates from `index=True` (keeps the migration and the test
  schema describing the same indexes).
- **No create_extension, no ALTER/DROP of existing tables.** CREATE TABLE + CREATE INDEX only.

### 3.6 Tests — `backend/tests/integration/test_course_reviews.py`
Mirror `test_routes.py` style (httpx client fixture, `set_auth`, TEST_OWNER_ID /
OTHER_OWNER_ID). Cover, one cluster per property:
1. **Create + echo:** `set_auth(TEST_OWNER_ID)`; POST
   `/api/courses/12345/reviews` with `{rating:4, body:"calm", roundId:"r1",
   courseName:"Pebble Beach", playedAt:"2026-06-20"}` -> 200; body echoes `ownerId ==
   TEST_OWNER_ID`, `courseKey == "12345"`, `rating == 4`, fields round-trip.
2. **List owner-scoped:** create as owner A, GET as A returns it; GET same key as
   OTHER_OWNER_ID returns `[]` (cross-user isolation — never leaks).
3. **Rating validation:** POST `rating:0` -> 422; `rating:6` -> 422; boundary `rating:1`
   and `rating:5` -> 200 (boundaries inclusive).
4. **Body cap:** POST `body` of 2001 chars -> 422.
5. **Auth fails-closed:** no `set_auth` -> POST and GET both in (401, 503) (match the
   existing pattern in `test_routes.py::TestAuthRequired`).
6. **`name:` key with special chars:** POST to a URL-encoded
   `name:pebble-beach-old-course` key -> 200 and GET round-trips it (proves slash-free key +
   encoding path-param handling). Build the path with the same encode the client uses.
7. **No-shadowing guard:** in the same run, GET `/api/courses/<random-uuid>` -> 404
   (catch-all `courses.router` still owns single-segment) while GET
   `/api/courses/<key>/reviews` -> 200/`[]`.

### 3.7 conftest TRUNCATE — `backend/tests/integration/conftest.py`
Add `course_reviews` to the `TRUNCATE TABLE ...` statement (~line 122-127) so rows do not
leak across tests. Insert it in the list (e.g. before `players`):
`"TRUNCATE TABLE scores, games, round_players, player_groups, rounds, course_reviews,
players, golfer_profiles, tournaments RESTART IDENTITY CASCADE"`. Legitimate harness
upkeep, not test-gaming. (Schema itself is created by `Base.metadata.create_all`, so the
ORM model in §3.1 must exist for the table to appear in the test DB.)

---

## 4. Frontend

### 4.1 Key helper — `frontend/src/lib/course-review-key.ts`
Pure, dependency-light (so it is unit-testable and reusable by B3):

```
export function normalizeCourseName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// recent: Array<{id: number|string; name: string; clubName: string}> from getRecentCourses()
export function resolveCourseKey(
  round: { courseName?: string | null },
  recent: Array<{ id: number | string; name: string; clubName?: string }>,
): string | null {
  const raw = (round.courseName ?? "").trim();
  if (!raw) return null;                        // graceful hide
  const norm = normalizeCourseName(raw);
  const match = recent.find(
    (c) => normalizeCourseName(c.name ?? "") === norm ||
           normalizeCourseName(c.clubName ?? "") === norm,
  );
  if (match && String(match.id) !== "") return String(match.id);  // GolfAPI id branch
  return `name:${norm}`;                         // slug fallback (slash-free by construction)
}
```

Keep this file free of React / DOM imports so it runs in vitest cleanly. `getRecentCourses`
is called by the *caller* (RoundPageClient) and the array passed in, so the helper stays pure.

### 4.2 Helper tests — `frontend/src/lib/course-review-key.test.ts`
vitest cases: empty/whitespace name -> null; name with `/` -> slug has no `/`
(`name:pebble-beach-old-course`); recent match by `name` -> returns the id string; match by
`clubName`; no match -> `name:` fallback; numeric id coerced to string.

### 4.3 types.ts — `frontend/src/lib/types.ts`
Add (kept in sync with §3.2):
```
export interface CourseReview {
  id: string;
  ownerId: string;
  courseKey: string;
  courseName?: string;
  roundId?: string;
  rating: number;
  body?: string;
  playedAt?: string;
  createdAt: string;
}
export interface CourseReviewCreate {
  rating: number;       // 1-5
  body?: string;
  roundId?: string;
  courseName?: string;
  playedAt?: string;    // ISO date
}
```

### 4.4 api.ts — `frontend/src/lib/api.ts`
Add a `// ===== Course Reviews API =====` block after the Courses API block (~line 395),
importing the new types. Mirror the Players fns and `fetchAPI`:
```
export async function getCourseReviews(courseKey: string): Promise<CourseReview[]> {
  return fetchAPI<CourseReview[]>(`/api/courses/${encodeURIComponent(courseKey)}/reviews`);
}
export async function createCourseReview(
  courseKey: string, data: CourseReviewCreate): Promise<CourseReview> {
  return fetchAPI<CourseReview>(`/api/courses/${encodeURIComponent(courseKey)}/reviews`, {
    method: "POST", body: JSON.stringify(data),
  });
}
```
`encodeURIComponent(courseKey)` on BOTH calls (defensive; key is already slash-free).

### 4.5 RoundRecap form — `frontend/src/components/RoundRecap.tsx`
Add two optional props to `RoundRecapProps`:
`courseKey?: string | null` and `courseName?: string` (resolved by the parent). Keep
RoundRecap display-plus-one-action: the POST + state are self-contained and NEVER block the
Done flow.

Affordance (calm, yardage-book — `T.*` tokens only, NO zinc/emerald/slate, NO lucide, NO
SaaS card):
- Render the review section ONLY when `courseKey` is a non-empty string (else hide — covers
  the missing-courseName / unresolved case from §0.2).
- Place it as a new section after the player rows / before the closing caption, separated by
  the existing `hairlineRule`, with a mono kicker label ("How was it?" or "Your note").
- Rating: five tappable marks (1-5), each a >=44pt target, using `T.ink` for selected and
  `T.pencilSoft` for unselected, serif/mono per surrounding style. Optional short note:
  a quiet single-line/short `textarea` styled on-paper (`T.paper`/`T.hairline`), `maxLength`
  2000 to mirror the server cap.
- Local state: `rating` (number|null), `body` (string), `status`
  ('idle'|'saving'|'saved'|'error'). Submit is enabled only when `rating` is set.
- On submit: call `createCourseReview(courseKey, { rating, body: body || undefined,
  roundId: round.id, courseName: courseName ?? round.courseName,
  playedAt: <round.date as YYYY-MM-DD> })`. Wrap in try/catch; on success show a quiet
  "Noted." confirmed state (replace the form with one calm line); on error set
  `status:'error'` with a single muted retry line (`T.errorInk`) — NEVER throw, NEVER block
  Done. The Done button keeps calling `onDone` regardless of review state.
- Derive `playedAt`: if `round.date` is ISO, take the date portion (`new Date(round.date)`
  -> `toISOString().slice(0,10)`), guarding `isNaN`; if invalid, omit `playedAt`.
- Voice-first note: this is a quiet tap affordance on a terminal screen — acceptable as a
  tap fallback; no voice path required for B2. Keep it minimal so it does not add chrome.

### 4.6 Wire-up — `frontend/src/app/round/[id]/RoundPageClient.tsx`
- Import `resolveCourseKey` from `@/lib/course-review-key` and `getRecentCourses` from
  `@/lib/golf-api`.
- Compute once (e.g. `useMemo`, guarded for SSR — `getRecentCourses` returns `[]` when
  `window` is undefined): `const reviewCourseKey = useMemo(() => resolveCourseKey(round,
  getRecentCourses()), [round.courseName, round.id]);`
- Pass to the existing `<RoundRecap ... />` at line 1382:
  `courseKey={reviewCourseKey} courseName={round.courseName}`. Leave `open`, `round`,
  `onDone` unchanged.

---

## 5. Edge cases (must be handled / asserted)
- **Missing GolfAPI id:** no recent-course match -> `name:` slug fallback (§0.2 step 2).
- **Missing courseName:** `resolveCourseKey` -> null -> RoundRecap hides the form (§0.2 step 3).
- **Very long body:** client `maxLength=2000`; server `Field(max_length=2000)` -> 422 test.
- **Rating boundaries:** 0 and 6 -> 422; 1 and 5 -> 200 (inclusive) — both asserted.
- **Owner-scoping isolation:** GET as another owner returns `[]`; create-as-A / read-as-B
  test. No cross-user exposure (B3 will design that deliberately).
- **URL-encoding / slashes:** `name:` key is slash-free by construction (§0.3);
  `encodeURIComponent` on client + plain `{course_key}` str convertor on server; test #6
  round-trips a `name:` key.
- **No-shadowing:** test #7 proves both `/{id}` and `/{key}/reviews` resolve.
- **playedAt bad/empty:** omitted from body when `round.date` not ISO-parseable; server
  treats absent `playedAt` as NULL.
- **Network failure on submit:** caught; quiet error line; Done still works.

---

## 6. Gates (run all; paste output; do not declare done until green)

### Frontend (`cd frontend`)
- `npm run lint` -> 0 errors.
- `npx tsc --noEmit` -> clean (types in sync between types.ts and models.py).
- `npx tsx voice-tests/runner.ts --smoke` -> 265/265 (no voice surface touched; must stay).
- `npx vitest run` -> all pass, incl. new `course-review-key.test.ts`.
- `npm run build` -> succeeds.

### Backend (`cd backend`)
- `ruff check .` -> clean.
- `pytest` -> all pass incl. `test_course_reviews.py` (requires a reachable Postgres; the
  conftest skips gracefully if none — run against the docker DB from §6.1 so they actually
  execute, not skip).

### 6.1 Migration verification — LOCAL DOCKER (CI does NOT run alembic)
CI uses `Base.metadata.create_all`; deploy.yml runs `alembic upgrade head`. So WE verify the
migration against real Postgres 16 locally (docker available; Postgres not running):

```
# 1. start a throwaway PG16
docker run -d --name looper-mig-test -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=scorecard_test -p 5433:5432 postgres:16

# 2. point alembic at it (asyncpg driver — env.py uses the async engine online)
export DATABASE_URL="postgresql+asyncpg://postgres:postgres@localhost:5433/scorecard_test"

# 3. baseline protocol then upgrade (env.py docstring: stamp baseline, then upgrade head).
#    Confirm the full chain applies cleanly to head:
uv run alembic upgrade head        # must apply 009_course_reviews with no error
uv run alembic downgrade -1        # must drop table+indexes cleanly (proves downgrade)
uv run alembic upgrade head        # re-apply to confirm idempotent up/down

# 4. (optional) run the integration tests against this DB so they execute not skip:
DATABASE_URL="postgresql+asyncpg://postgres:postgres@localhost:5433/scorecard_test" \
  uv run pytest tests/integration/test_course_reviews.py -v

# 5. teardown
docker rm -f looper-mig-test
```
Expected: upgrade/downgrade/upgrade all exit 0; `course_reviews` table + the two
`ix_course_reviews_*` indexes present after upgrade, absent after downgrade. If the baseline
chain requires `alembic stamp 001_baseline` first (per env.py), do that before step 3.

---

## 7. Review (per CLAUDE.md — MAJOR: new authed endpoint + data + new table)
- Run `/security-review` (owner-scoping, IDOR, input validation, no cross-user leak) and
  `/code-review`; fold findings in.
- `designer` agent reviews the RoundRecap affordance against NORTHSTAR (yardage-book, calm,
  T.* only, 44pt targets, safe-area, no SaaS chrome).

## 8. Out of scope (do NOT build here)
- Surfacing reviews on course detail / profile / cross-user = `course-reviews-surface` (B3).
- Course identity unification = `course-identity-unify` (B5).
- Do NOT touch `require_owner`, `backend/supabase/migrations/**`, `deploy/**`, `.env*`.
