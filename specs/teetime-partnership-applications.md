# Tee-time partnership applications — owner checklist

*Companion to `specs/teetime-availability-everywhere-plan.md` §4e / §9 ("prefer
official APIs and keep the partnership applications filed and refreshed — any
grant retires the corresponding scraper"). These are web-form applications an
agent cannot submit — this is a ready-to-send checklist for the owner. Each
grant upgrades that engine's adapter from rung-1/2a (public/replayed
endpoint) to fully **sanctioned** (an official key) with **zero router
change** — `router_provider.py`'s `ADAPTERS` dispatch is already
platform-keyed; a sanctioned key just changes what `build_times_request`
sends (or, worst case, one file), never who gets called.*

Boilerplate to reuse in every "use case" field below — copy-paste and adjust:

> Looper is a mobile-first, voice-driven golf app (scorecard, caddie, tee
> times). We show golfers real, live tee-time availability for public courses
> near them and deep-link them to the course's own booking page to complete
> the reservation — we never book on the golfer's behalf without their
> explicit confirmation, never resell availability data, and always send the
> course its own booking traffic. We're requesting API/affiliate access so we
> can query availability through your official, sanctioned channel instead of
> our own request replay.

---

## 1. Lightspeed Golf Partner API (Chronogolf) — HIGHEST PRIORITY

- **What it grants:** an official, versioned API (`partner-api.docs.chronogolf.com`,
  V2 = current, JSON:API/UUID-based) to read a club's tee sheet, pricing, and
  customers, and to book/modify/check-in/pay for rounds programmatically —
  the sanctioned replacement for our `chronogolf.py` adapter's marketplace-
  widget replay (S4c). We already have 3 live NJ/NY-metro Chronogolf clubs
  wired (Rock Spring, Pleasantville, Beaver Brook) — a granted key upgrades
  all three with **zero router change** (only `chronogolf.py`'s request
  builder/auth changes; `ADAPTERS["chronogolf"]` stays the same entry).
- **Application / signup URL:** `https://partner-api.docs.chronogolf.com/`
  (documentation entry point) — the docs describe becoming an "approved
  partner" but the live signup/contact form behind that gate could not be
  confirmed from here (blocked to automated fetch). Best-known alternate
  entry point: Lightspeed's general partner/integrations contact at
  `https://www.lightspeedhq.com/golf/integrations/` ("Become a partner" /
  contact-sales flow) — **owner should open both and use whichever surfaces
  a live contact form**, and note the confirmed URL in the Notion card once
  found.
- **Info to submit (copy-paste-ready):**
  - Business name: **Looper** (mobile golf app — scorecard, caddie, tee times)
  - Contact: `justinlee627@gmail.com`
  - Website / app: the Looper staging/production URL (owner fills in current link)
  - Expected volume: low initially — a handful of NJ/NY-metro Chronogolf
    clubs, read-mostly (availability search), booking handoff via deep-link
    today; will grow with course coverage
  - Use case: the boilerplate blurb above, plus: "Currently replaying the
    public marketplace widget endpoint (`chronogolf.com/marketplace/...`,
    unauthenticated, read-only) for a small number of clubs — requesting
    Partner API access to move to your sanctioned channel."

## 2. GolfNow / TeeOff Affiliate & Partner API

- **What it grants:** OAuth2 REST/JSON tee-time search + booking across
  GolfNow's full marketplace (which includes many courses we currently can't
  reach directly, e.g. Marine Park's GolfNow listing, facility 4857) —
  this is the single highest-leverage grant in the whole ladder, since it's
  the one aggregator explicitly marked "avoid as fetch source" in the plan
  (§1) specifically *because* it's partnership-gated rather than scrapeable.
  A grant here doesn't map to one existing adapter file — it would be a new
  `adapters/golfnow.py` sanctioned from day one (no scrape-first version
  exists, by design).
- **Application / signup URL:** `https://www.golfnow.com/business-partnership/form`
  (the partnership request form) — page returned a login/paywall gate to
  automated fetch, so the exact field list below is best-known, not
  screen-confirmed; the **documentation portal for existing partners** is
  `https://affiliate.gnsvc.com/` ("Affiliate & Partner API"), which the
  application likely leads into after approval. TeeOff has a parallel form at
  `https://www.teeoff.com/business-partnership` (same GolfNow-family
  program — try both, they may route to the same intake).
- **Info to submit (copy-paste-ready):**
  - Business name: **Looper**
  - Contact: `justinlee627@gmail.com`
  - Website / app: current Looper link
  - Expected volume: low-to-moderate — tee-time *search* traffic across
    NY-metro public courses (booking stays a deep-link handoff, not native
    booking, at least initially)
  - Use case: the boilerplate blurb above, plus: "We're a consumer golf app
    surfacing real availability for public courses; GolfNow/TeeOff lists many
    of the courses we serve (e.g. NYC Parks courses) that we currently show
    as phone-only or via a lower-trust source. API access would let us show
    accurate GolfNow-sourced availability and deep-link bookings directly to
    your platform."

## 3. foreUP Vendor / Partner Integration

- **What it grants:** we already reach foreUP's public `no_limits` booking-
  times endpoint (rung 1, live in prod — S1) without a key; a vendor/partner
  relationship would mainly (a) formalize that access so it survives a
  foreUP-side tightening, and (b) potentially unlock write access (native
  booking) instead of today's deep-link handoff. Lower urgency than #1/#2
  since the read path already works.
- **Application / signup URL:** `https://www.foreupgolf.com/partner-integrations/`
  lists existing integrations but has no visible self-serve apply form (page
  fetch confirmed this — only a general "Request Information" contact link
  is present). Best-known entry point: foreUP's general contact/sales page
  linked from `foreupgolf.com` (owner should use the site's "Contact" or
  "Request a Demo" flow and ask specifically for **API/vendor partner**
  access, referencing the existing public `index.php/api/booking/times`
  endpoint we already use). There is a public `foreUP API Terms of Use` PDF
  (`foreupgolf.com/wp-content/uploads/2024/03/foreUp-API-TOU.pdf`) worth
  reading before applying — it governs the existing public endpoint too.
- **Info to submit (copy-paste-ready):**
  - Business name: **Looper**
  - Contact: `justinlee627@gmail.com`
  - Website / app: current Looper link
  - Expected volume: currently 1 seeded NY/NJ-metro foreUP course (18 Mile
    Creek), designed to scale to many more as we curate more capability rows
  - Use case: the boilerplate blurb above, plus: "We currently query
    foreUP's public tee-times endpoint (the same one your own booking pages
    call, `api_key=no_limits`) read-only for a small set of courses.
    Requesting a formal vendor/partner relationship so this access is
    sanctioned and durable, and to discuss native booking API access."

## 4. Supreme Golf affiliate / distribution program

- **What it grants:** Supreme Golf connects directly to many course tee
  sheets via its own API and distributes to SupremeGolf.com,
  BarstoolGolfTime.com, GolfDigest.com, and GolfBook.com — another
  aggregator (like GolfNow) we currently treat as "avoid as fetch source"
  (plan §1) specifically because scraping an aggregator is higher-risk/
  lower-trust than the course's own engine. A grant would add coverage for
  courses whose own engine we can't reach directly.
- **Application / signup URL:** could not confirm a dedicated apply/signup
  page — `courses.supremegolf.com` (the course-facing "free distribution"
  program terms page) returned a paywall/login gate to automated fetch, so
  its exact terms are unconfirmed. Best-known entry point: contact Supreme
  Golf through `supremegolf.com`'s general course-partnership inquiry (their
  site has a "For Golf Courses" / partnership contact path) and ask
  specifically for **API/affiliate access for tee-time search**, distinct
  from their course-distribution product. Lowest confidence of the four —
  confirm the live URL before sending.
- **Info to submit (copy-paste-ready):**
  - Business name: **Looper**
  - Contact: `justinlee627@gmail.com`
  - Website / app: current Looper link
  - Expected volume: low initially, NY-metro focus
  - Use case: the boilerplate blurb above, plus: "Requesting affiliate/API
    access to Supreme Golf's tee-time search so we can show accurate,
    sanctioned availability for courses in your network, with bookings
    deep-linking to your platform."

---

## Priority order (owner's time is the scarce resource)

1. **Lightspeed/Chronogolf Partner API** — we already have 3 live clubs on
   the scrape-shaped adapter; this is the closest, highest-confidence win.
2. **GolfNow/TeeOff** — the single biggest coverage unlock (the aggregator
   that lists almost everything, incl. Marine Park), worth the extra
   friction of a less-confirmed form.
3. **foreUP** — read access already works; this mainly future-proofs it +
   opens a booking-write conversation.
4. **Supreme Golf** — smallest incremental coverage of the four; do last.

## What changes in the codebase when a grant lands (no router change)

Per plan §3/§6: every adapter dispatches through `ADAPTERS[cap.platform]` in
`router_provider.py`, keyed on the capability row's `platform` — a sanctioned
key only changes **inside** that platform's adapter file (auth headers, the
base URL, maybe the response shape if V2-vs-widget differs) and, for a brand
new aggregator like GolfNow, adds one new `adapters/golfnow.py` + one new
`ADAPTERS` entry. `capability_store.py` rows just get their `channel` flipped
from `"scrape_http"`/`"api"` (unauthenticated) to `"api"` (sanctioned) and a
`probe_status` refresh — the search/routing/UX layers never need to know the
difference.
