# Real tee-time finding + booking — implementation plan

*Owner directive 2026-07-09: "I'm at the point where I want real data." Delete
synthesized slots. Route by reachability: foreUP API where reachable, AI call
otherwise. Not Bethpage for the first foreUP target. No private courses. Include
web-scraping techniques for gated cases.*

## Core move
Delete the synthesized-slot path (one fake `estimated=True` slot per course
rendered as "Held") and replace with a REACHABILITY ROUTER. Every course
resolves to exactly one honest route: real foreUP availability + deep-link, OR
AI phone call, OR honest empty. Private clubs filtered out before rendering.

## Routing architecture (per course, resolved once, cached)
```
resolve_route(course):
  is_private?          -> EXCLUDE entirely (Liberty National was the offender)
  foreUP record known? -> ForeUpProvider (real times endpoint + deep-link)
  has phone, no API?   -> VoiceCallProvider (AI call, disclosed)
  else                 -> HONEST EMPTY ("no online availability — call the course")
```
Backed by a per-course `CourseBookingCapability` record (platform, booking_url,
schedule_id, course_id, phone, is_private, verified_at) — a stored fact, never
runtime guessing.

## foreUP integration (concrete)
- Public booking page: `foreupsoftware.com/index.php/booking/{bookingId}/{scheduleId}`.
- **Availability endpoint (public, no login):** `GET
  foreupsoftware.com/index.php/api/booking/times?time=all&date=MM-DD-YYYY&
  holes=all&players={N}&booking_class={id|false}&schedule_id={scheduleId}&
  specials_only=0&api_key=no_limits`, header `api-key: no_limits`. Returns JSON
  tee slots. FLAG: verify param casing + booking_class against a LIVE NY page
  during build; extract course_id/schedule_id from the page bootstrap, never
  hardcode.
- **Booking endpoints are account+card gated** → S2 decision: DEEP-LINK
  HANDOFF, not programmatic booking. Never store user payment/credentials.
- **NY foreUP discovery:** curated seed list (backend/data/foreup_ny_seed.json,
  NOT Bethpage-first) + per-course validation script (fingerprint the page,
  extract ids, single read-only probe, write capability row). No mass crawl.

## Scrape-vs-API-vs-call decision tree
```
clean public JSON (foreUP times)  -> API adapter       [S1, low-risk]
availability behind rendered page -> Playwright adapter [S4, GRAY, gated]
no web availability, has phone     -> AI caller         [S3, business line, disclosed]
private club                       -> excluded
nothing                            -> honest empty
```

## Ordered slices
- **S0** (ship first, no external deps): delete affiliate.py synthesized slots +
  the mock-fallback substitution; private-course filter (private_clubs.json,
  Liberty National fixture); kill "Held" copy everywhere (route-driven "Found" /
  "Call" / "Book on course site"). Honest empty.
- **S1**: ForeUpProvider read-only availability for a validated NY course set +
  deep-link; CourseBookingCapability table + migration; cache (5-10min TTL, one
  poll/course/window) + per-host rate limit + circuit-breaker on 4xx/bot-signal.
  Verify against a REAL live NY foreUP course; capture the response as the CI
  fixture (never live-hit in CI). Legal: LOW-not-zero, read-only, honest UA.
- **S2**: foreUP booking = deep-link handoff (evidence: reservations need
  account+card). needs_human + booking_url. No auto-charge.
- **S3**: AI-caller route for non-API courses — wires the existing voice_booking
  scaffold (disclosure already implemented; live calls stay owner-gated behind
  VOICE_BOOKING_ENABLED + attorney sign-off). MEDIUM risk, mitigated.
- **S4**: Playwright scraping adapters for gated platforms (Chronogolf/
  Lightspeed widgets) — headless, HTML parse, honest UA, low freq, heavy cache,
  never solve CAPTCHAs, never log in to scrape. GRAY, per-course opt-in, lowest
  priority. Tests against saved HTML fixtures.

## Legal posture (honest)
foreUP's public `times` endpoint (api_key=no_limits) is what the course's own
unauthenticated page calls — read-only display at one-poll-per-window with heavy
cache + circuit-break is low-risk but not zero (browse-wrap ToS). Identify
honestly, never log in for scraping, never auto-book/charge. Bethpage's 2025
anti-bot overhaul targets booking bots not availability display — stay read-only
there, accept possible blocking. File foreUP vendor-API application in parallel.
S4 scraping explicitly GRAY and gated.

## Frontend honesty (end to end)
Kill "Held" (route → "Found"/"Call"); drop "Held for you to book"; CTA "Book on
the course site →"; remove demo-data leakage on the real path; honest empty copy.

## Test posture
No live external hits in CI (recorded JSON/HTML fixtures). Private-filter,
routing-resolver, honest-empty, circuit-breaker, cache single-flight tests.

## Critical files
- DELETE backend/app/services/tee_times/affiliate.py (synthesized-slot source)
- backend/app/services/tee_times/{foreup,routing,router_provider,private_filter}.py (new)
- backend/app/routes/tee_times.py (remove mock-fallback; wire router)
- backend/app/services/voice_booking/provider.py (AI-call route)
- frontend/src/app/tee-time/page.tsx (kill "Held"; route-driven copy)
- backend/app/db/models.py (CourseBookingCapability)
