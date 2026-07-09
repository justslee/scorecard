# Real tee-time availability — routes without a GolfNow partnership

*Fable direct-research, 2026-07-09. Owner: GolfNow/Lightspeed likely won't grant API
access. Diagnosed the current state and researched workarounds: scraping, AI caller,
other platforms.*

## Diagnosis of today's behavior (the screenshot)
- The AFFILIATE provider returns **one synthesized slot per nearby course**:
  `time = the requested window start, estimated=True` (backend/app/services/tee_times/
  affiliate.py). Data model honest; the UI renders it "Found ~6:30 AM… **Held** for
  you" — **no hold exists anywhere**. Presentation violates no-fake-data.
- No private-club filter: Liberty National (fully private) surfaced as bookable.
- IMMEDIATE FIXES (queued): kill "Held"; render estimates as "suggested window — call
  to check"; filter/flag private clubs (Places types + a curated private list).

## The landscape (verified)
- **GolfNow affiliate API** exists ([affiliate.gnsvc.com](https://affiliate.gnsvc.com/))
  but is partnership-gated behind a business-development form — the owner's read is
  right; low odds for an unlaunched app. Free to apply anyway (parallel track).
- **Supreme Golf** aggregates GolfNow + TeeOff + Chronogolf and runs affiliate
  programs — the most approachable aggregator; apply in parallel.
- **foreUP has genuinely open APIs** (public docs at
  [foreup.docs.apiary.io](https://foreup.docs.apiary.io/); a vendor program that syncs
  third-party bookings to the tee sheet). A real application path for a small vendor.
- **TeeWire** advertises an SDK for third-party tee-sheet access; niche but open-posture.

## THE FIND: Bethpage runs on foreUP, with a public booking page
`foreupsoftware.com/index.php/booking/19765/2431` is Bethpage's own public booking
front end — foreUP public pages fetch availability as JSON from documented-pattern
endpoints. **The owner's home course exposes real availability publicly.** Many
municipal courses nationwide run the same stack (foreUP is big in munis).

## POC routes, ranked

### Route 1 (build first): read-only availability + deep-link handoff
Fetch real slots from public booking endpoints (foreUP-family first), show them
honestly, and deep-link the user into the COURSE'S OWN booking page to finish.
- No booking automation, no user credentials, no "Held" — we're a smart index.
- Engineering: per-platform adapters (foreUP first; Lightspeed/Chronogolf widget JSON
  second); heavy caching + strict rate limits (one poll per course per window, not
  per user); circuit-break on any 4xx pattern.
- **Honest risk flags**: browse-wrap ToS on these pages typically prohibit scraping —
  read-only display for a personal app is low-risk in practice but not zero;
  **Bethpage specifically overhauled reservations in 2025 to fight tee-time bots**
  ([golf.com](https://golf.com/news/bethpage-overhauls-reservation-system-tee-time-bots/)) —
  their fight is with booking bots, not availability display, but we must be gentle
  (low frequency, no login, never auto-book) and accept we could be blocked.

### Route 2 (the epic's original plan): AI caller POC
Outbound calls to PRO SHOPS (a business line, not consumers — outside classic TCPA
telemarketing consent) asking availability / making a booking in the player's name.
- 2026 compliance norms: disclose AI at the top of the call; several states require
  it ([FCC 2024 ruling treats AI voice as artificial voice](https://www.henson-legal.com/ai-voice-compliance);
  [disclosure guide](https://thoughtly.com/blog/ai-disclosure-requirements-what-to-tell-callers)).
  "Hi, this is Looper, an AI assistant calling on behalf of Justin…" is both legal
  posture and good manners.
- Feasible with our existing realtime stack + Twilio; the POC: call one friendly local
  course, ask Saturday availability for 1 player, log the transcript, human-confirm.
- This is the route no aggregator can gate — every course has a phone.

### Route 3 (parallel, free): partnership applications
GolfNow affiliate form + Supreme Golf affiliate + foreUP vendor API application.
Cost: an afternoon of forms. Any yes upgrades Route 1 from scraping to sanctioned.

### Route 4: Reserve-with-Google deep links where present (some Lightspeed courses
publish through Google) — indexable without any partnership.

## Recommended sequence
1. Ship the honesty fixes NOW (kill "Held", suggestion framing, private filter).
2. POC Route 1 against **Bethpage's own foreUP page** (the owner can validate against
   reality instantly — he knows what Saturday at Bethpage looks like).
3. POC Route 2 with one consented local course.
4. File Route 3 applications in parallel.

## Sources
- https://affiliate.gnsvc.com/
- https://www.golfnow.com/business-partnership
- https://foreup.docs.apiary.io/
- https://www.foreupgolf.com/the-411-on-foreup-and-3rd-party-tee-time-booking-engines/
- https://foreupsoftware.com/index.php/booking/19765/2431
- https://golf.com/news/bethpage-overhauls-reservation-system-tee-time-bots/
- https://supremegolf.com/
- https://teewire.com/developer-apis
- https://www.henson-legal.com/ai-voice-compliance
- https://thoughtly.com/blog/ai-disclosure-requirements-what-to-tell-callers
- https://www.sportsfirst.net/post/tee-time-availability-apis-how-u-s-golf-apps-fetch-real-time-slots
