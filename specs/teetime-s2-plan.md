# S2 — foreUP booking = deep-link handoff (implementation plan)

*Slice of specs/teetime-real-booking-plan.md. Status of the code at planning time: the handoff is ALREADY IMPLEMENTED end-to-end (built during S0/S1 with S2 in mind). S2's deliverable is therefore **pinning the invariants with tests + closing two small honesty gaps**, not feature code. Low-code, high-invariant.* (Fable plan, 2026-07-09.)

## 1. The S2 decision (and its evidence)

**Booking a foreUP slot = deep-link handoff. Never programmatic booking.**

Evidence, from specs/teetime-real-booking-plan.md (do NOT re-verify with live external calls):
- §foreUP integration: *"Booking endpoints are account+card gated → S2 decision: DEEP-LINK HANDOFF, not programmatic booking. Never store user payment/credentials."*
- §Ordered slices S2: *"foreUP booking = deep-link handoff (evidence: reservations need account+card). needs_human + booking_url. No auto-charge."*
- §Legal posture: read-only display is LOW-not-zero risk; *"never log in for scraping, never auto-book/charge"*; Bethpage's 2025 anti-bot overhaul targets **booking bots** — programmatic booking is exactly the category we must never enter.

The five invariants this slice pins (the S2 contract):
1. `ForeUpProvider.book()` ALWAYS returns `status="needs_human"` — never `confirmed`/`pending`.
2. `confirmation_number` is ALWAYS `None` from any foreUP path — a confirmation is never fabricated (MEMORY: no-fake-data-fallbacks; NORTHSTAR honesty).
3. `booking_url` on the result is the course's **own foreUP booking page** (`https://foreupsoftware.com/index.php/booking/{bookingId}/{scheduleId}`), not a generic course website.
4. No card, payment, or credential data is ever collected, transmitted, or stored (`BookingDetails` = name/party_size/email/phone only; the only HTTP verb in foreup.py is GET against the public `times` endpoint).
5. Every handoff attempt is persisted (`tee_time_bookings` row, `status=needs_human`, `confirmation_code=NULL`) so the owner has a durable record; the UI stamp reads "Found", never "Held"/"Booked".

## 2. Gap analysis — what already exists vs. what is missing

### Already correct (verified in source; do not rewrite)
| Invariant | Where it lives today |
|---|---|
| `book()` -> needs_human, no confirmation, foreUP deep-link, honest message | `backend/app/services/tee_times/foreup.py:489-502` (docstring: "we NEVER book programmatically") |
| foreUP slots dispatch to `ForeUpProvider.book` | `backend/app/services/tee_times/router_provider.py:115-118` |
| foreUP slots carry the real deep-link (`cap.booking_url`) | `foreup.py:231` (`_emit_slots`), degraded path `router_provider.py:110`; capability rows hold `foreupsoftware.com/index.php/booking/...` (`capability_store.py`, seed) |
| Every attempt persisted incl. needs_human; `booking_url = result.booking_url or slot.booking_url`; `confirmation_code=None` | `backend/app/routes/tee_times.py:289-373`; ORM `backend/app/db/models.py:462` |
| GET /bookings owner-scoped, newest first | `backend/app/routes/tee_times.py:376-385` |
| Frontend handoff UI: `<a target=_blank>` "Book on the course site ->", honest subCopy, stamp "Found", confCode renders "—" (never fabricated) | `frontend/src/app/tee-time/page.tsx:1087-1219`; `frontend/src/lib/teetime/confirm-copy.ts:40-77` |
| Existing tests: `book()` unit (`backend/tests/test_tee_time_foreup.py:532-560`), router dispatch (`test_tee_time_router.py:248-267`), foreup needs_human copy (`confirm-copy.test.ts:92-115`), routing-provider needs_human persistence (`tests/integration/test_tee_time_bookings.py:121-139`) | — |

### Genuinely missing (the S2 work)
1. **No foreUP-provider integration test.** `test_needs_human_attempt_is_persisted` uses the ROUTING provider and a generic website URL. Nothing proves the full HTTP path (search -> foreUP slot -> POST /book -> persisted row) with the **foreupsoftware.com deep-link** end-to-end.
2. **No guard test** that the foreUP surface *cannot* produce `confirmed`/a confirmation number, and has no card/credential affordance.
3. **Frontend foreup needs_human test asserts `looperLine` only** — `ctaLabel === "Book on the course site ->"` and `stampWord === "Found"` are not pinned for the foreup-with-real-time case (they're pinned only for the routing shape).
4. **Missing-booking_url edge is untested** on both sides (provider returns needs_human with `booking_url=None`; UI falls back to tel:/honest no-phone copy — the code paths exist at `page.tsx:1220-1239`, untested for a foreup slot).
5. **One real honesty gap found (fix candidate, see §4):** `page.tsx:919-923` — when `bookTeeTime` throws (network failure), the UI fabricates `{status:"pending", message:"Booking request sent — check back shortly."}`. No request was sent; the stamp then reads "Pending"/confCode "PENDING". For a foreUP slot this overclaims exactly the way S2 forbids.

## 3. Tests to add (the contract; exact specs)

### 3a. Backend integration — foreUP-provider handoff persisted (DB-backed -> **CI only**; local has no Postgres, conftest auto-skips)
File: `backend/tests/integration/test_tee_time_bookings.py` (new class `TestForeUpHandoffPersistence`, follow the `_use_routing`/`_isolate_cache` monkeypatch pattern already in the file).

Setup: monkeypatch `route_mod._get_provider` to a `RoutedTeeTimeProvider(find_courses=<offline finder returning a course matching a test capability>, foreup=ForeUpProvider(capabilities=lambda: (CAP,), transport=httpx.MockTransport(<fixture handler>), cache=FakeCacheStore, limiter=..., breaker=...), capabilities=lambda: (CAP,), foreup_enabled=True)` — reuse the fake/fixture machinery from `backend/tests/test_tee_time_foreup.py` (`_cap()`, `_fixture_transport()` over `backend/tests/fixtures/foreup_18mile_times.json`). No live network, ever.

Assertions:
1. `GET /search` -> a slot with `provider == "foreup"`, real `time != ""`, `bookingUrl == "https://foreupsoftware.com/index.php/booking/20410/4467"` (the deep-link, NOT a generic website), `estimated is False`, `route is None`.
2. `POST /book` with that exact serialized slot -> 200, `result.status == "needs_human"`, `result.bookingUrl` == the same foreupsoftware.com deep-link, `result.confirmationNumber is None`, and `"Held" not in r.text`.
3. `GET /bookings` -> one row: `status == "needs_human"`, `confirmationCode is None`, `bookingUrl` == the deep-link, `provider == "foreup"`, `time` == the real slot time.

### 3b. Backend guard — no foreUP path can confirm, charge, or store credentials (non-DB, runs locally)
File: `backend/tests/test_tee_time_foreup.py` (extend `TestBook` / new `TestS2Invariants`):
1. **Universal needs_human:** call `ForeUpProvider().book()` across a sweep of slots (with/without `booking_url`, with/without `time`, `route=None`/`"book_on_site"`) -> every result has `status == "needs_human"` and `confirmation_number is None`. Include the missing-booking_url case: result `booking_url is None` (honestly absent — never a fabricated URL).
2. **Provider-surface guard (source-level):** `src = inspect.getsource(app.services.tee_times.foreup)`; assert `'status="confirmed"' not in src` and `"client.post" not in src` and `"client.put" not in src` (GET-only surface); assert `re.search(r"card|payment|cvv|credit", src, re.I) is None`. Assert `{f.name for f in dataclasses.fields(BookingDetails)} == {"name", "party_size", "email", "phone"}` — the booking surface structurally cannot carry a card.
3. **Router guard:** with the existing `FakeForeUp` pattern in `test_tee_time_router.py`, assert a `provider="foreup"` slot booked through `RoutedTeeTimeProvider` never yields `confirmed` (already partially covered by the dispatch test — add the explicit `status`/`confirmation_number is None` assertions there).

### 3c. Frontend vitest — the handoff copy contract
File: `frontend/src/lib/teetime/confirm-copy.test.ts` (extend the existing `"needs_human with a real known time (foreup)"` describe):
- foreup slot (`provider:"foreup"`, `time:"07:10"`, `route:undefined`, `bookingUrl:"https://foreupsoftware.com/index.php/booking/20410/4467"`) + `{status:"needs_human", bookingUrl: slot.bookingUrl}` ->
  - `ctaLabel === "Book on the course site ->"` (exact string)
  - `stampWord === "Found"` (and explicitly `not "Held"`, `not "Booked"`)
  - `subCopy === "You book direct — the course takes the reservation."`
- The deep-link precedence rule the page uses (`bookingResult.bookingUrl ?? slot.bookingUrl`, `page.tsx:1093`) — pin it in a small test if extracted, else assert both sources carry the foreupsoftware.com URL in the copy test's fixtures so a drift to a generic website fails.
- Missing-booking_url foreup slot + needs_human with no phone -> `ctaLabel === "Call the course to book"`; with `callTelHref` returning null the page renders no dead button (already tested for routing — add the foreup-provider variant).

## 4. Correctness fixes (only if verification confirms; keep minimal)

1. **Fabricated "pending" on network failure** (`frontend/src/app/tee-time/page.tsx:919-923`): change the catch fallback so it never claims "Booking request sent". Recommended minimal fix: return `{status:"needs_human", message:"Couldn't reach the booking service — book directly on the course site."}` (the CTA still works because `bookingUrl` falls back to `slot.bookingUrl`), stamp reads "Found". This is provider-agnostic, one small diff + one vitest case. **In slice for S2** — it is a live violation of the no-fake-status rule on the booking path.
2. **Deep-link verification (expected to pass, assert don't assume):** confirm via the new tests that a foreUP slot's persisted `booking_url` is the foreupsoftware.com page (route persists `result.booking_url or slot.booking_url` — both are `cap.booking_url` today). The degraded couldn't-check path already points at `cap.booking_url` (`router_provider.py:110`) — correct, leave as is.
3. **`estimated` flag:** foreUP slots hard-code `estimated=False` (`foreup.py:232`); the flag is deprecated-inert. No S2 action beyond the existing `estimated is False` assertions; deletion stays a separate cleanup (per base.py note).
4. **Do NOT touch** the mock provider's `confirmed` + "Demo mode — link opens real booking page" path — intentional demo behavior, guarded by explicit `TEETIME_PROVIDER=mock` opt-in and the "(Demo data.)" label. The integration suite's mock tests must keep passing byte-identical.

## 5. Shared-type sync check

- `frontend/src/lib/teetime/types.ts` `BookingResult.status` union == backend `base.py` `BookingResult.status` Literal (`confirmed|pending|failed|needs_human|not_supported`) — **in sync**, no action.
- `TeeTimeSlot` shapes match field-for-field (camelCase wire via `TeeTimeSlotOut`), incl. `bookingUrl`, `route`, `phone`, deprecated `estimated` — **in sync**.
- `TeeTimeBookingOut` (GET /bookings) has **no frontend type/consumer yet** — not drift, but note it so whoever builds a bookings surface adds the mirror type in `types.ts` then.
- No changes needed; re-check after any test-driven tweaks.

## 6. Gates (run in this order)

```
cd /Users/justinlee/projects/scorecard/backend && ruff check .
cd /Users/justinlee/projects/scorecard/backend && python -m pytest \
    tests/test_tee_time_foreup.py tests/test_tee_time_router.py \
    tests/test_tee_time_routing.py tests/test_tee_time_provider_default.py -q
# DB-backed: tests/integration/test_tee_time_bookings.py runs in the CI backend
# gate ONLY — local machine has no Postgres (conftest skips; never start one).
cd /Users/justinlee/projects/scorecard/frontend && npm run lint
cd /Users/justinlee/projects/scorecard/frontend && npx tsc --noEmit
cd /Users/justinlee/projects/scorecard/frontend && npx vitest run src/lib/teetime
cd /Users/justinlee/projects/scorecard/frontend && npm run build
cd /Users/justinlee/projects/scorecard/frontend && npx tsx voice-tests/runner.ts --smoke
```
Grep-level gates (from S1, still binding): "Held" absent from frontend copy paths; `no_limits` confined to foreup.py + its tests/scripts; no test performs a live URL fetch.

## 7. Edge cases & risks

- **foreUP slot with missing `booking_url`:** provider still returns needs_human with `booking_url=None` (never invents a URL); UI falls to a real `tel:` link if `phone` exists, else the honest "No phone number on file" line — never inert button chrome. Pinned by §3b.1/§3c.
- **Private course leaking a book CTA:** `cap.is_private -> []` (`router_provider.py:87-88`) and standalone-mode skip (`foreup.py:474-475`) already exclude these before any slot exists; the existing private-filter/router tests guard it — no new S2 surface.
- **Mock path stays `confirmed`:** intentional demo behavior behind explicit opt-in; the guard tests target the foreUP/router surface only. Don't break `test_confirmed_booking_is_persisted`.
- **Never introduce stored-card/auto-charge affordances:** the source-level guard (§3b.2) makes this a failing test, not a review hope. Any future "save your card so Looper can book" idea is a new owner-approved slice with attorney review, per the spec's legal posture — out of S2 by definition.
- **Legal drift risk:** the deep-link sends the golfer to foreUP's own page to book with their own account/card — zero ToS exposure beyond S1's read-only display. Keep it that way: no query params, no autofill, no iframe embedding of the foreUP page.
- **Copy drift:** all handoff language flows through `confirmCopy` — keep it centralized; the exact-string CTA test makes silent drift fail loudly.
