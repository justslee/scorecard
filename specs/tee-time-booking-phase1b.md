# Tee-Time Booking — Phase 1b: make it real (2026-07-01)

Parent plan: `specs/tee-time-booking-plan.md` (epic) + `specs/tee-time-finder.md` (UI contract).
Phase 1 scaffolding is ALREADY BUILT on `integration/next`: `frontend/src/lib/teetime/*`
(types/provider/registry/client/mock), `backend/app/services/tee_times/` (base ABC + mock),
`backend/app/routes/tee_times.py` (`GET /api/tee-times/search`, `POST /api/tee-times/book`),
and the 3-phase UI in `frontend/src/app/tee-time/page.tsx`. Phase 1b closes the gap between
"works on mock" and "real courses, honest booking, persisted results" — with NO provider creds.

## Eng-lead decisions (locked)
- **Keep the `/api/tee-times/*` prefix.** Do NOT rename to `/bookings/*` — the voice-agent
  scaffold (`specs/tee-time-voice-agent.md`) plans `POST /api/tee-times/book-by-call` and the
  finder spec matches. The epic plan's `/bookings/*` naming is superseded.
- **`BookingResult` statuses are a stable contract** (`confirmed|pending|failed|needs_human|
  not_supported`) — the voice agent depends on them. Extend, never rename.
- **Never fabricate live slots.** The affiliate provider surfaces real courses + a real
  booking URL with `needs_human` semantics ("Book on the course site →"), not invented
  times/prices presented as bookable. (finder spec line 13/21–37; legal posture in the plan.)
- **UI shape is fixed** (prefs → searching → confirmed). Polish within it; don't restructure.
- All work rides the `integration/next` bundle (PR #86). Commit per work item; no pushes to main.

## Work item A — backend real-data slice
1. **`AffiliateLinkProvider`** (`backend/app/services/tee_times/affiliate.py`):
   - Given `TeeTimeQuery` (with `area` = lat/lng or place name), find real nearby golf courses
     by reusing `routes/course_search.py` internals (OSM name filter + Google Places when
     `GOOGLE_PLACES_API_KEY` is set — extract shared helpers rather than HTTP-calling ourselves).
   - Emit one slot per course per requested window: `start` = window start (clearly an
     *estimate*: add an `estimated: bool` field to the slot dataclass + Pydantic + TS types),
     no fabricated price, `booking_url` = course website/Places URL when known.
   - `book()` returns `needs_human` with the booking URL (the Confirmed screen already renders
     `slot.bookingUrl`).
   - Registry: `TEETIME_PROVIDER=affiliate` selects it; default stays `mock` until QA passes,
     then flip the default to `affiliate` with mock fallback when course search yields nothing.
2. **Search cache**: replace the hardcoded `cached=False` in `routes/tee_times.py` with a
   small TTL cache (15 min, keyed by normalized query) following the injectable-store pattern
   of `services/golfapi_cache.py` (in-memory + JSON file under `backend/data/`, tests inject
   a fake). Cache protects the Places quota; availability freshness matters more than hit rate.
3. **Booking persistence**: ORM `TeeTimeBooking` in `backend/app/db/models.py` (snake_case:
   id, owner_id, course_id/name, slot start, party size, price, status, booking_url,
   provider, confirmation_code, created_at) + Alembic migration `0007_*`. `POST /book` gains
   `owner_id: str = Depends(current_user_id)` (copy the `rounds.py` pattern) and persists every
   attempt (incl. `needs_human`). Add `GET /api/tee-times/bookings` (owner-scoped list).
   Pydantic response models in camelCase per `models.py` convention.
4. Tests: pytest for provider (mock course-search), cache TTL, booking persistence
   (existing test DB pattern), route auth scoping. Gates: `ruff check .` + full pytest.

## Work item B — frontend real-data wiring
1. **Send `area`**: get geolocation (existing pattern — see the round map GPS code) with a
   graceful fallback; include lat/lng in every `TeeTimeQuery`. Never block the UI on it.
2. **Real courses in prefs**: replace `DEFAULT_COURSES` (6 hardcoded SF ids that only the mock
   knows) with nearby real courses fetched via the existing `/api/courses/search` client;
   keep the current list as offline/dev fallback. Radar pins (hardcoded PRESIDIO/HARDING/
   LINCOLN) render from the same fetched list.
3. **Honest confirm**: when `BookingResult` is `needs_human` + `bookingUrl`, the Confirmed
   screen says "Reserved by phone/site — Book on the course site →" (no fake confirmation
   number). `estimated` slots render "~" times, no invented price.
4. **Calendar button**: "Add to calendar" generates a real ICS (blob download, no deps) from
   the booked slot; "Set reminder" folds into the ICS alarm. Keep the yardage-book idiom
   (inline `T` tokens; no new libraries).
5. **Date correctness**: `nextSaturday()` ignores the chosen window's day — compute the target
   date from the selected window's day label.
6. Tests: vitest for ICS + date logic + query building. Gates: `tsc --noEmit`, lint, full
   vitest, voice smoke, `next build`.

## Work item C — voice prefs ("Hold to talk")
Wire the decorative button (page.tsx ~193–221) to the existing voice pipeline
(`frontend/src/lib/voice/*`, reuse the `Voice.tsx` affordance): parse "find me a tee time
Saturday morning at Presidio, party of 4, under $80" → windows/courses/party/price prefs.
Zod schema + heuristics + repair loop like existing intents; deterministic cases added to
`voice-tests` (runner smoke must stay green). Voice-first is the Northstar — this is the
primary path, tapping is the fallback.

## Work item D — voice booking agent pre-build (Phase 4, env-gated)
Per `specs/tee-time-voice-agent.md` on `feat/voice-booking-agent` (scaffold commit 0d2f609,
"paused for Fable 5" — unblocked): build the PURE modules only (`types.py`, `dialog.py`,
`ivr.py`, `outcome.py`, `compliance.py`, `phone_lookup.py`) + `simulator.py` and the
`book-by-call/simulate` route. NO real telephony (`telephony.py` stub raises unless
`VOICE_BOOKING_ENABLED=1` + Twilio creds). Compliance module encodes the plan's gates
(business-landline-only, AI disclosure line, no audio storage). Real-call launch remains
owner-gated (budget + TCPA attorney) — code ≠ launch.
**Deviation to resolve in favor of the epic plan: NO card vault** — payment is handed to the
human staffer (plan §Track B); drop `card_vault.py` from the scaffold's module list.

## Sequencing
A → B (shared slot type change lands in A) → C → D. One commit per item, gates before each
commit. Security review after A+D (new endpoints + data handling). Then board + progress.
