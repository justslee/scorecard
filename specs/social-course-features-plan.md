# Plan — Social/Playing Partners + Course Search/Reviews

Status: planning (owner: "not high priority, but get to it"). Backlog ids:
`social-*` (epic `social-playing-partners`) and `course-*` (epic `course-search-reviews`).

## UI decision (owner's explicit question: "is a bottom tab the best approach?")
**No global bottom tab bar.** NORTHSTAR forbids SaaS/dashboard chrome; the app is
intentionally hub-and-spoke (calm home, full-bleed sub-screens that return to `/`,
`viewportFit:"cover"` safe-area layout). Neither feature is a "camp here" destination —
Partners are contextual (adding/inviting players), course search is already mid-flow in
round-setup and tee-time. A tab bar would also intrude on the immersive voice/round/GPS
screens where the app is meant to disappear.

**Homes instead:**
- **Playing Partners** — promote the already-built, orphaned `/players` page (full
  SavedPlayer roster CRUD, shows `roundsPlayed`, badges linked accounts) to "Playing
  Partners." Two quiet entry points: a link from home masthead/profile, and inline in the
  round-setup & tee-time player pickers (where invites naturally happen). Partner profile =
  pushed `/players/[id]` detail route, not a tab.
- **Courses** — keep course search where it already lives (the `CourseSearch` sheet in
  round-setup & tee-time) and add ONE quiet `/courses` spoke from home with a
  `/courses/[id]` detail screen ("Start a round here" + reviews).

If the owner ever insists on persistent nav, the only Northstar-compatible form is a 3-item
home dock (Round · Partners · Courses) shown ONLY on home, hidden on round/voice/GPS — but
the recommendation is to not build it; the home hub already does this calmly.

## Current-state findings (grounded)
- **No bottom nav today.** `layout.tsx` wraps everything in `AuthProvider` only; `page.tsx`
  is the hub-and-spoke home; every sub-screen's back returns to `/`.
- **Two orphaned pages already exist, linked from nowhere:** `/players` (full roster CRUD)
  and `/settings`. The Partners "home" is ~80% built and merely hidden.
- **Social foundation is a private roster, not a graph.** `SavedPlayer` (types.ts:51) already
  has `nickname,email,phone,handicap,avatarUrl,clerkUserId,roundsPlayed`; backend `players.py`
  is CRUD, owner-scoped (`owner_id == current_user_id`). No friend/invite/lookup endpoints.
- **CRITICAL constraint — single-owner gate.** `main.py` applies `require_owner` to EVERY
  router (`clerk_auth.py:92` → 403 "owner-only"). Any real social feature requires relaxing
  this for specific new endpoints (use `current_user_id` + per-row authz). Biggest decision
  in Feature A.
- **Course data is fragmented into 4 systems** (GolfAPI proxy `golf.py`+`golf-api.ts`+
  `CourseSearch.tsx`; OSM/Mapbox `course_search.py`; saved `scoring_courses` `courses.py`;
  PostGIS mapped `courses_mapped.py`). You can ALREADY start a round from a found course
  (`round/new` `onSelectCourse`). Stable review key available: `Course.golfApiCourseId`.
- **Reviews: net-new** (no model/UI). Profile is cleanly sectioned (`Section` shell) — trivial
  to add a "Reviews" section. Review entry point is free: the `RoundRecap` modal on completion.
- **Native gaps:** installed Capacitor plugins are camera, geolocation, preferences, ios only.
  NO push and NO contacts plugin — both are net-new native deps needing iOS permission strings +
  on-device testing.

## New data models
- `Friendship`/`PlayingPartner` — `{id,user_id,friend_user_id,status:pending|accepted|blocked,
  created_at,accepted_at}`. The owner-scoped `Player` row stays as local roster/cache; the
  Friendship is the real cross-account edge. Link a roster `Player` to an account via its
  existing `clerk_user_id` column (no schema change there).
- `RoundInvite` — `{id,from_user_id,to_user_id|to_player_id,round_id|tee_time_search_id,
  context:tee_time_found|pre_search|add_to_round,status,channel:in_app|sms|push,created_at}`.
- `CourseReview` — `{id,author_user_id,course_key(=golfApiCourseId),round_id?,rating,body,
  played_at,created_at}`. Keyed on `golfApiCourseId` so reviews work BEFORE course unification.

## Privacy (phone matching)
On-device contacts read ONLY after explicit consent; add `NSContactsUsageDescription` +
Apple privacy-manifest reason. Never upload raw numbers — normalize to E.164 client-side,
HMAC-SHA256 (server-shared pepper), send only hashes to `POST /api/partners/match` vs hashes
of opted-in users. Per-user "discoverable by phone" toggle (default off). Consent + SMS copy
must satisfy TCPA. Invite default channel = IN-APP + native share/SMS; push is a LATE phase,
reserved for accept/tee-time-found moments (notifications rare by design).

## Phases (see backlog.json for full cards)
**A — Social:** A1 surface Partners (S, FE) · A2 partner profile (S/M) · A3 in-app invite
surfaces (M) · A4 friend graph + relax owner gate (M/L, **needs owner decision + security
review**) · A5 phone matching (L, native+privacy) · A6 push invites (L, native).
**B — Course:** B1 course detail + start-a-round (S/M) · B2 CourseReview + write-after-round
(M) · B3 surface reviews (S/M) · B4 discovery from home (S/M) · B5 unify course identity
(L, migration — owner applies, LAST).

Quick wins first (A1–A3, B1–B4 reuse SavedPlayer/PlayerAutocomplete/CourseSearch/golf-api.ts
and are mostly headless). The owner-gate relaxation (A4) is the gating dependency for true
social and bundles its own `/security-review`.

## Critical files
- `frontend/src/app/players/page.tsx` — orphaned roster → Partners home; partner profile
- `backend/app/routes/players.py` + `backend/app/db/models.py` — add Friendship/RoundInvite/
  CourseReview; owner-scope pattern to extend
- `backend/app/services/clerk_auth.py` — the `require_owner` gate to relax for social/reviews
- `frontend/src/components/CourseSearch.tsx` + `frontend/src/lib/golf-api.ts` — reuse for
  `/courses` detail + start-a-round; `golfApiCourseId` review key
- `frontend/src/app/page.tsx` + `frontend/src/app/round/[id]/RoundPageClient.tsx` — home
  spokes for Partners/Courses; RoundRecap review entry point
