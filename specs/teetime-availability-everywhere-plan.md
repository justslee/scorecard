# Tee-time availability everywhere — API → scrape → AI-call ladder (plan)

*Owner directive 2026-07-10 (screenshot: Marine Park Golf Course, Brooklyn — "No online booking — call the pro shop" + bare phone number): "even if there is no online booking there should be a way to fetch it in some form right? That is a must. We can build a web scraper if that's the best option. This is not quite good enough." Fable plan per `fable-for-plan-agents`. Builds ON S0–S3 (`specs/teetime-real-booking-plan.md`) — this is S4, widened from "scraping adapters" into the full availability-fetch ladder.*

## 0. The finding that reframes the epic

**Marine Park was never phone-only.** Its own site (`golfmarinepark.com/tee-times/rates/`) links a live online booking portal — `https://marineparkridepp.ezlinksgolf.com/` (EZLinks, a GolfNow/NBC Sports property) — and the course is also listed on GolfNow (facility 4857), TeeOff, Chronogolf's marketplace page, and Supreme Golf. The screenshot's dead-end was a **capability-detection gap**, not a data-doesn't-exist gap: our router only knows one platform (foreUP, 1 seeded course), so every non-foreUP course degrades to the S0 route entry, and when Google Places/OSM has no `website` for the course, that degrades further to "call".

Consequences for the design:

1. The epic is mostly **breadth of engine adapters + per-course capability detection**, not exotic scraping. Most "widget" booking engines expose a replayable XHR JSON endpoint (foreUP-style) once you watch the network tab — a true headless-browser scrape is the minority case.
2. The **ladder has 4 rungs**, not 3: (1) direct/near-public JSON API, (2a) widget-XHR replay over plain HTTP — technically scraping, engineered like our foreUP client, (2b) headless-browser render for genuinely JS-/anti-bot-gated pages, (3) AI phone call, (4) honest empty — only when every rung above genuinely fails.
3. Marine Park itself is fixed at rung 1/2a (EZLinks portal), and it should be the acceptance test of the first increment: the owner re-runs the exact screenshot search and sees real times.

## 1. Booking-engine landscape — NY-area public courses

Verification method for every row: open the course's own "book a tee time" page in a browser, watch DevTools → Network for the availability XHR, note URL/params/headers/response shape, then confirm the same request replays from `curl`/httpx **without cookies or login**. That's exactly how foreUP's `api_key=no_limits` shape was confirmed (S1), and the existing `backend/scripts/validate_foreup_courses.py --capture-fixture` pattern is the codified version of it.

| Engine | NY-area footprint | Availability channel (verified / expected) | Rung | Notes |
|---|---|---|---|---|
| **foreUP** | Bethpage (19765), 18 Mile Creek (seeded), many upstate munis | `GET foreupsoftware.com/index.php/api/booking/times?...&api_key=no_limits` — public JSON, **live in prod today** | **1 (done)** | Expand the seed list; validation script exists. |
| **TeeItUp** (GolfNow white-label, Kenna platform) | Essex County NJ group (`essex-group.book.teeitup.golf`), many NJ/metro munis | `GET https://phx-api-be-east-1b.kenna.io/tee-times?date=YYYY-MM-DD&courseIds=N` with header `x-be-alias: <tenant>` — plain JSON, no auth (verified via a public community script) | **1** | The cleanest new rung-1: one host, one header, foreUP-grade. Tenant alias + courseIds come from the course's `*.book.teeitup.golf` page bootstrap. |
| **EZLinks portals** (`*.ezlinksgolf.com`) — **Marine Park** | NYC munis incl. Marine Park (`marineparkridepp.ezlinksgolf.com`); likely several sibling NYC-Parks concession courses on the same portal family | SPA calling an internal JSON search API on the same host (community-known shape `POST /api/search/search`; MUST be re-verified by network-tab capture during build) | **1/2a** | Not documented-public like foreUP, but replayable HTTP JSON expected. If the portal signs requests → rung 2b. |
| **Chronogolf / Lightspeed Golf** | Marketplace pages exist for NY courses (incl. a Marine Park listing); Lightspeed has real NY-metro course share | `chronogolf.com/club/<slug>` marketplace pages fetch club/teetime JSON from `chronogolf.com` marketplace endpoints (network-tab verify exact path/params). ALSO: official **Partner API v2** (`partner-api.docs.chronogolf.com`) — partnership-gated | **1/2a**, upgradeable to sanctioned | Apply for the Partner API in parallel (free; any yes converts this to fully sanctioned). |
| **GolfNow.com marketplace** (incl. TeeOff) | Aggregates most of the above incl. Marine Park (facility 4857) | Internal APIs behind meaningful anti-bot (Akamai-class) + explicit anti-scraping ToS; affiliate API is partnership-gated (application already the parallel track per `tee-time-real-availability-research.md`) | **avoid as fetch source** | Never scrape golfnow.com itself: highest ToS/anti-bot risk, and every GolfNow course has a lower-risk source (its own portal/engine). Keep as deep-link + partnership application only. |
| **Club Prophet** (`book.cps.golf` / online v3/v4) | Scattered NY-metro publics | SPA + JSON API; per-tenant config/keys embedded in the JS bundle — network-tab verify; may need per-tenant token extraction | **2a**, else 2b | Classify per course during probe; if token dance is brittle → rung 2b or 3. |
| **Quick18** | Some metro publics | Server-rendered HTML (`quick18.com/teetimes/searchmatrix` style) — no JS needed | **2a-lite** (HTML parse) | Plain httpx + BeautifulSoup; cheapest scrape in the set. |
| **Teesnap** | ~400 facilities national, some NY | `<course>.teesnap.net` React app with a customer JSON API — network-tab verify | **1/2a** | Same probe → classify flow. |
| **ForeTees** | Mostly **private** clubs (member login) | Login-gated | **excluded / 3** | Private filter already excludes most; never scrape behind auth (hard rule). |
| **Municipal one-offs / no engine** | Small publics, par-3s | No online availability at all | **3 (AI call)** | The genuine phone-only tail — the caller (PR #124) is built for exactly this. |
| **Supreme Golf / GolfBook aggregators** | Aggregate everything | Aggregator sites (their own ToS; data is second-hand) | **avoid as fetch source** | Affiliate application is the parallel track; don't scrape aggregators when the course's own engine is reachable. |

**Marine Park classification: rung 1/2a via its EZLinks portal** (with GolfNow deep-link as the booking handoff if the portal proves hostile). Its "call the pro shop" rendering was wrong twice over — availability exists online, and even rung 3 would have been available.

Honest feasibility calls (per the "don't scrape for its own sake" instruction):
- **golfnow.com / supremegolf.com: do not scrape.** Anti-bot + explicit ToS + second-hand data. Every course they list has a first-party engine we can reach at lower risk.
- **ForeTees: don't bother.** Its courses are almost all private → excluded by `private_filter` anyway.
- **Headless-browser (rung 2b) is a last resort**, expected for a minority of engines (Club Prophet worst case, hostile EZLinks portals). If a specific engine demands sustained anti-bot evasion (CAPTCHA, fingerprint spoofing), we **stop** — that course goes to rung 3. We never solve CAPTCHAs or spoof fingerprints; that's the bright line between "polite client" and "adversarial bot".

## 2. Per-course capability detection + storage

### 2a. Generalize `CourseBookingCapability` (extend, don't replace)

`capability_store.py` today is foreUP-only (`_parse_row` skips `platform != "foreup"` — deliberately forward-compatible). Generalize:

```python
@dataclass(frozen=True)
class CourseBookingCapability:
    platform: str            # "foreup" | "teeitup" | "ezlinks" | "chronogolf"
                             # | "clubprophet" | "quick18" | "teesnap" | "phone_only"
    channel: str             # "api" | "scrape_http" | "scrape_browser" | "call" | "none"
    platform_ids: dict[str, str]   # engine-specific: foreup {booking_id, schedule_id};
                                   # teeitup {alias, course_id}; ezlinks {portal_host, course_id}; …
    booking_url: str | None  # the course's OWN booking page (deep-link handoff, S2 rule)
    phone: str | None
    is_private: bool
    verified_at: str         # last successful availability fetch through this channel
    probe_status: str        # "verified" | "stale" | "failed" — drives router trust
    name: str; lat: float; lng: float; aliases: tuple[str, ...]
    course_id: str | None    # discovery-namespaced id
```

Migration detail: keep reading the existing `foreup_ny_seed.json` rows (map `foreup_booking_id`/`schedule_id` into `platform_ids`) so the shipped 18 Mile Creek row keeps working unchanged. New generalized file: `backend/data/booking_capabilities_seed.json` (fail-loud, curated) + `booking_capabilities_validated.json` (fail-soft, script-appended) — the exact two-file pattern already in `capability_store.py`. A real DB table stays deferred exactly as the existing file header says (no local Postgres, migrations guarded); revisit when rows > ~100 or when scrape-job state needs transactional writes.

### 2b. Probe pipeline (how a course GETS classified)

Generalize `scripts/validate_foreup_courses.py` → `scripts/probe_booking_capability.py`:

1. Input: course name + location (+ optional website from Places/OSM — the discovery pipeline already carries it).
2. **Fingerprint the website**: fetch the course site, look for booking links/embeds (`foreupsoftware.com/index.php/booking/…`, `*.book.teeitup.golf`, `*.ezlinksgolf.com`, `chronogolf.com/club/…`, `book.cps.golf`, `quick18.com`, `teesnap.net`). Regex over the homepage + `/tee-times`-ish paths covers the vast majority.
3. **Extract platform ids** from the engine page bootstrap (never hardcode — S1 rule).
4. **One read-only availability probe** through the matching adapter; on success write a capability row (`verified_at`, `probe_status="verified"`) to the validated file; `--capture-fixture` saves the response as the CI fixture.
5. No match / no website → `platform="phone_only", channel="call"` when a phone is known, else `channel="none"`.

Cache discipline (`golfapi-budget-cache-first`): probing is **offline/manual or background**, never in the search request path; a course is probed once and the result **persisted** — searches only read the store. Re-probe cadence: on adapter failure streaks (breaker feedback marks `probe_status="stale"`), plus a monthly manual sweep. Never re-probe per search.

## 3. Rung 1 — expand direct APIs

Priority order by (NY coverage × cleanliness): **TeeItUp first** (single host `phx-api-be-east-1b.kenna.io`, one `x-be-alias` header, plain JSON, no auth — foreUP-grade), then **Chronogolf marketplace JSON**, then **EZLinks portal JSON** (§4 since it's technically scrape-shaped). Each adapter:

- Implements the same contract as `ForeUpProvider.slots_for_capability`: returns `list[TeeTimeSlot]` (real slots), `[]` (verified empty — course omitted), or `None` (couldn't check — degrade down the ladder). **Never raises.**
- Normalization into `TeeTimeSlot`: real `time` (HH:MM), `players` from the engine's open-spots field (bool-before-int coercion guard — reuse `_as_int`/`_as_price`), `price_usd=None` when absent (never 0/fabricated), `provider="<engine>"`, `route=None`, `booking_url` = the course's own booking page.
- Auth/keys: foreUP `no_limits` (public), TeeItUp none beyond the alias header (public), Chronogolf marketplace none expected (verify), EZLinks none expected (verify). **No adapter ever logs in.** Official keys (Lightspeed Partner API, GolfNow affiliate, foreUP vendor) are partnership applications running in parallel — any grant upgrades that engine to sanctioned and its adapter swaps endpoints without router changes.
- Shared politeness stack extracted from `foreup.py` into `tee_times/fetch_discipline.py`: per-host `SlidingWindowLimiter` (≤10 rpm), per-host `CircuitBreaker` (3 fails → open 300s → half-open), 8-min availability TTL cache keyed `(platform, ids, date, players)` caching the **full day** (window-filter on read — one poll per course/date), asyncio single-flight, honest UA `Looper/1.0 (golf tee-time availability)`, 8s timeout. foreUP keeps its current behavior byte-identical; it just imports the shared pieces.

## 4. Rung 2 — the web scraper (the owner's explicit ask)

### 4a. Two tiers, honestly named

- **2a — widget-XHR replay (plain httpx):** the engine's own booking page fetches JSON; we replay that exact request server-side. No browser. This is what foreUP already is, and what TeeItUp/Chronogolf/EZLinks/Teesnap are expected to be. Quick18 is the HTML variant: plain GET + BeautifulSoup parse of a server-rendered table (`selectolax`/`bs4` — tiny dependency).
- **2b — headless render (Playwright/Chromium):** only when the XHR is signed/short-lived-token'd/fingerprint-bound. Playwright launches Chromium, loads the booking page, waits for the availability network response (`page.wait_for_response` on the XHR URL pattern — parse the **JSON the page itself fetched**, not the DOM, wherever possible; DOM parsing is the fallback and the most fragile thing we'd own).

### 4b. Where it runs — never the request path

- 2a adapters are fast (one HTTP GET) → they run inline in `search_availability`, same as foreUP today, under the shared politeness stack. No new infra.
- 2b runs in a **background worker**, not the request: Playwright cold-start + render is 3–15s and a headless Chromium must not sit on the FastAPI request path (latency, memory, event-loop blocking). Design: an in-process asyncio worker (started in `main.py` lifespan — this repo has no Celery/queue infra and shouldn't grow one for this) with a bounded `asyncio.Queue`, concurrency 1–2 browser contexts, one shared Chromium. The **request path only reads the scrape cache**; a miss enqueues a job and the course renders in the "checking…" pending state (§7). A follow-up search (or the frontend's poll) picks up the cached result. Deploy note: Playwright + Chromium adds ~400MB to the backend image — gate with `TEETIME_SCRAPER_ENABLED` (default off) so the dependency is inert until the increment that needs it, and the image change rides its own slice.
- Job dedupe: keyed by `(platform, ids, date)` — single-flight at the queue level too.

### 4c. Caching + politeness (`golfapi-budget-cache-first`)

- Same TTL cache as rung 1 (8-min availability TTL; the route-level 15-min search cache sits above it — end-to-end staleness ≤ 15 min, unchanged from S1).
- Scrape a given course at most once per TTL window **globally** (cache is per course/date, not per user); per-host rpm caps; circuit breaker per host; `robots.txt` checked once per host per day and **respected** (a disallow on the availability path ⇒ that engine drops to rung 3 — recorded in the capability row, not silently ignored).
- Nightly-prefetch is explicitly OUT of scope (budget rule: never re-fetch needlessly; fetch on demand, cache hard).

### 4d. Normalization

Each scraper emits the same cache-safe day dicts foreUP uses (`{"time","players","price_usd","holes"}`) → `_emit_slots`-equivalent shared builder → `TeeTimeSlot` with `provider="<engine>"`, `route=None`, real times only. A scraper that cannot confidently parse a field emits `None`/skips the entry — **parse doubt = omit, never guess** (`no-fake-data-fallbacks`).

### 4e. ToS / legal / ethical assessment — stated plainly

- **What we'd be doing:** programmatically fetching publicly visible, unauthenticated availability data (facts: times/prices — facts are not copyrightable), displaying it read-only, and deep-linking the golfer to the engine's own page to book (we *send* the engine its booking traffic; we never book, never charge, never resell the data).
- **The gray:** these sites carry browse-wrap ToS that typically prohibit automated access; GolfNow/EZLinks properties especially (NBC Sports ToS, Akamai-class anti-bot; Bethpage's 2025 anti-bot overhaul targeted booking bots). US case law (hiQ v. LinkedIn line) has held that scraping publicly accessible pages isn't a CFAA violation, but **breach-of-contract and trespass theories survive**, and the practical risks are real: IP blocks, engine-level blocks that break rung 1 too, a cease-and-desist. Risk of actual litigation against a read-only, personal-scale availability display that drives bookings *to* the course is low — but it is not zero, and we say so.
- **Good-citizen rules (hard requirements, enforced in code):** identify honestly (the `Looper/1.0` UA — no browser-UA spoofing on 2a); respect robots.txt; ≤10 req/min/host and one fetch per course/date per TTL; cache hard; **never log in, never solve CAPTCHAs, never rotate IPs/fingerprints to evade a block** — a block means that engine falls to rung 3, full stop; prefer official APIs and keep the partnership applications (GolfNow affiliate, Lightspeed Partner, foreUP vendor, Supreme Golf) filed and refreshed — any grant retires the corresponding scraper; per-engine kill switches (`TEETIME_ENGINE_<X>_ENABLED`).
- **Escalation posture:** if any engine sends a C&D or blocks us, we comply immediately (capability rows flipped to `channel="call"`), and the router's ladder means the user experience degrades gracefully instead of breaking.

### 4f. Fragility (honest)

Scrapers break silently when sites change. Mitigations in §9 (schema-drift canary, verified-empty vs parse-failure distinction — a parse failure returns `None` → degrade + breaker, never a fake empty).

## 5. Rung 3 — AI-call fallback (PR #124)

- **New dialog mode: availability ask** (today's `dialog.py` books; this mode asks "what do you have Saturday between X and Y for N players?" and captures times/prices into `CallOutcome`-like structured fields). Small extension of the existing state machine + simulator personas; the disclosure line, compliance gates (verified-lines allowlist, suppression, calling hours), and transcript capture are already built.
- **Trigger model: user-initiated, never automatic.** A search must not place phone calls as a side effect (cost, intrusiveness, calling-hours, and the owner-gated launch posture). The result surface shows a real CTA — "No online times — we can call the pro shop" — tapping it enqueues the call (`POST /api/tee-times/availability-call`), the row flips to "Calling the pro shop…", and the frontend polls a status endpoint.
- **Result flow-back:** call outcome persists as an `availability_by_call` record `{course_id, date, window, party_size, slots_spoken[], outcome, transcript_ref, called_at}` with a same-day TTL (a staffer's word is good for hours, not minutes — and a call is the most expensive fetch we have, so per `golfapi-budget-cache-first` it is cached the hardest). Subsequent searches read this cache like any other rung: spoken times render as real `TeeTimeSlot`s with `provider="voice_call"`, `route="call"` retained for the booking handoff, plus a distinct provenance so the UI can label "confirmed by phone at 2:14 PM". `no_availability` outcome = verified empty for that window; `voicemail`/`no_answer` = couldn't check → honest empty with the phone number and a retry CTA.
- **Inert until keys:** the transport stays `telephony.get_live_transport()`-gated (VOICE_BOOKING_ENABLED + Twilio creds + verified-lines allowlist). Until then rung 3's CTA renders as today's tel: link — the wiring ships dark and the rehearsal harness (`specs/teetime-rehearsal-call-harness.md`) validates the availability-ask dialog the moment keys land. Also fix the known S3 TODO in `voice_booking/provider.py`: it builds the window from `slot.time` which is `""` on route entries — the availability-call path must pass the **query window**, not the slot time.

## 6. Router integration — the full ladder

Extend `RoutedTeeTimeProvider._slots_for_course` (the seam built for exactly this):

```
cap = match_capability(course)                      # generalized store
if cap and cap.is_private:            -> []          (excluded)
rung 1/2a: adapter = ADAPTERS.get(cap.platform)      # foreup, teeitup, chronogolf, ezlinks, quick18…
    slots  -> real slots            (provider=<engine>)
    []     -> omit course           (verified empty)
    None   -> continue down         (couldn't check)
rung 2b (channel=="scrape_browser"): read scrape cache
    hit: slots/[] as above; miss: enqueue job -> PENDING entry ("checking live availability")
rung 3 (phone known): route entry with route="call" + call-CTA affordance
    (+ any availability_by_call cache hit renders as real phone-confirmed slots)
rung 4: cap/channel unknown -> S0 route entry (book_on_site if website) ;
    truly nothing (no site, no phone, all rungs failed) -> honest empty
```

- `TeeTimeSlot` grows one field: `status: Literal["live","pending"] = "live"` (or equivalently a `pending: bool`) for the 2b "checking…" entry — `time=""`, no price, explicitly a *state*, never a slot. Plus `checked_via`/`checked_at` provenance for phone-confirmed slots. All additive, default-compatible with booking rehydration in `routes/tee_times.py`.
- Kill switches: existing `TEETIME_FOREUP_ENABLED` pattern generalizes to `TEETIME_ENGINES` allowlist env; unknown/disabled engine ⇒ that course behaves as S0. The S0 fallback remains byte-identical for cap-less courses — the S0/S1 test suites keep passing untouched.
- The 15-min route-level search cache: pending entries must be cached with a **short TTL or marked non-cacheable** so a completed scrape isn't masked for 15 minutes (concrete detail for the builder: either skip `_search_cache.set` when any result is pending, or add a 60s TTL variant for pending-bearing result sets).

## 7. UX per rung (`no-fake-data-fallbacks` throughout)

- **Rung 1/2 slots:** identical real-times UI shipped in S1/`teetime-show-real-time-options` — tappable times, real prices or nothing, "Book on the course site →" handoff. Engine identity is provenance metadata, not user-facing noise.
- **Rung 2b pending:** "Checking live availability…" row with the course name — an honest in-progress state (spinner, auto-poll/refresh), never a fabricated time, and it resolves to real times, verified-empty (course omitted with "nothing open in your window"), or degrades to rung 3.
- **Rung 3:** "No online times listed — we can call the pro shop for you" CTA (when the caller is live) → "Calling the pro shop…" async state → phone-confirmed times labeled with the call timestamp, or honest "they had nothing in your window". Until Twilio keys: today's honest call row with the real tel: link — but now it's the *last* rung, not the second.
- **Honest empty (rung 4):** only when API/scrape verified-empty-or-failed AND no phone (or the call failed/was declined). Copy states what was actually checked: "Checked <engine> — nothing open in your window" vs "Couldn't reach this course's booking system".

## 8. Sequencing — shippable increments, smallest-valuable-first

This is a **multi-cycle epic**; each slice is independently testable and independently shippable. S4a/S4b are the value core; S4d/S4e can reorder based on when Twilio keys land.

- **S4a — generalized capability store + adapter registry + TeeItUp (rung 1).** Generalize `capability_store.py` (platform/channel/platform_ids, back-compat with `foreup_ny_seed.json`), extract `fetch_discipline.py` from `foreup.py` (byte-identical foreUP behavior pinned by the existing 64-test S1 suite), add `adapters/teeitup.py` + captured fixture + 2–3 probed NY/NJ-metro seed rows, wire the router ladder for rung-1 adapters. *Cycle-sized. Everything after hangs off this.*
- **S4b — EZLinks portal adapter = Marine Park (the screenshot).** Network-tab capture of `marineparkridepp.ezlinksgolf.com`; expected 2a httpx adapter + fixture + Marine Park capability row. **Acceptance: the owner's exact screenshot search returns real Marine Park times.** If the portal proves signed/hostile, this slice reclassifies Marine Park to rung 2b and S4d is pulled forward — the honest-empty never regresses meanwhile. *Cycle-sized; the demo moment of the epic.*
- **S4c — Chronogolf marketplace adapter + probe script generalization** (`probe_booking_capability.py` with website fingerprinting, §2b) + Quick18 HTML-lite if trivially reachable. Partnership applications (Lightspeed Partner API, refresh GolfNow/Supreme/foreUP-vendor) filed as a rider here. *Cycle-sized.*
- **S4d — rung 2b infra (Playwright worker) + pending-state UX.** Background worker, scrape queue, `status="pending"` slot state, poll endpoint, frontend pending row, `TEETIME_SCRAPER_ENABLED` gate, first browser-scraped engine (Club Prophet, or a hostile EZLinks variant). *Cycle-sized; the only slice with deploy-image impact.*
- **S4e — rung 3 wiring (availability-by-call).** Availability-ask dialog mode + simulator personas, `availability_by_call` cache record, call CTA/async status UX, flow-back into results. Ships dark behind the existing VOICE_BOOKING gates; rehearsal harness validates it when keys land. Depends on PR #124 merging (it's merging now). *Cycle-sized.*
- **S4f — coverage flywheel (bundle-rider sized):** capability auto-probe on honest-empty telemetry (log which searched courses had no capability row → feed the probe script), a "% of searched courses returning real availability" metric, monthly re-probe sweep, schema-drift canary.

## 9. Risks / unknowns & test strategy

**Risks:** (1) Unverified endpoint shapes — EZLinks/Chronogolf/Club Prophet params are network-tab-confirmed during build, exactly like S1's "FLAG live param casing" rule; a slice that finds its engine infeasible reclassifies to a lower rung rather than forcing it. (2) Site changes break scrapers silently — mitigated below. (3) Anti-bot escalation — breaker + kill switch + fall to rung 3; never evade. (4) Wrong-course mapping (worst failure: *real times for the wrong course* — a fake-data violation wearing real data's clothes) — probe writes capability rows only on name+geo match (existing `match_capability` exact-name + ≤1mi rule), and every adapter carries the capability's verified ids, never guessed ones. (5) Call cost/annoyance — user-initiated only, same-day result cache, suppression list. (6) Playwright image bloat/flakiness — gated, worker-isolated, concurrency-capped.

**Tests (no live hits in CI, ever):** per-engine **captured fixtures** via the probe script's `--capture-fixture` (the `foreup_18mile_times.json` pattern) with all assertions fixture-derived; httpx adapters tested through `MockTransport`; Playwright scrapers tested against **saved HTML/XHR fixtures** loaded into the page (or the parse layer unit-tested directly on captured JSON — prefer parsing the page's own XHR JSON so the "scraper test" is mostly a JSON-parser test); ladder tests in `test_tee_time_router.py` for every degradation edge (adapter None → next rung; verified-empty → omit; pending → cache-TTL rule; all-fail → honest empty); breaker/limiter/single-flight reuse the S1 tests via the extracted module. **Drift handling:** a schema-guard on every parse (required keys present, plausible value ranges) — violation ⇒ `None` (couldn't check) + breaker failure + `probe_status="stale"`, never a silently-empty result; a manual/scheduled canary probe re-runs one live fetch per engine and diffs the shape against the fixture, flagging re-capture.

### Critical Files for Implementation
- `backend/app/services/tee_times/capability_store.py` — generalize platform/channel/platform_ids (the epic's backbone)
- `backend/app/services/tee_times/router_provider.py` — the ladder lives in `_slots_for_course`
- `backend/app/services/tee_times/foreup.py` — extract the shared fetch-discipline stack (limiter/breaker/cache/single-flight) every adapter reuses
- `backend/scripts/validate_foreup_courses.py` — generalize into the capability probe/fixture-capture harness
- `frontend/src/app/tee-time/page.tsx` — pending/call-CTA/phone-confirmed result states (with `backend/app/routes/tee_times.py` for the poll + availability-call endpoints)

---

*Sources consulted for the engine classification: golfmarinepark.com tee-times (EZLinks portal link), GolfNow Marine Park facility 4857, Chronogolf Marine Park listing, Lightspeed Golf Partner API docs (partner-api.docs.chronogolf.com), TeeItUp/kenna.io endpoint (community script), sportsfirst.net tee-time API survey, Teesnap, Club Prophet.*
