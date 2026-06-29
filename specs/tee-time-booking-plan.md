# Tee-Time Booking — Plan (research-backed, 2026-06-29)

Owner direction: build the tee-time finder *properly*. Integrate free/open booking APIs; where none exist,
build an outbound **voice agent that calls the pro shop**; **web scraping** OK as part of scope. This is a
multi-iteration EPIC — proper infra, not a quick feature. (Current `/app/tee-time` is a hardcoded demo.)

## The one cross-cutting insight: booking hits a payment/legal wall — except by voice
- **APIs** can book, but the *payment* step needs the provider's flow (Chronogolf/GolfNow handle it; good).
- **Scraping** can read availability but **cannot complete checkout** — blocked by 2FA + 3-D Secure/SCA;
  *no existing bot even attempts payment*. Auto-booking-by-scraping is also the current legal bullseye
  (BIRDIE Act, BOTS Act, Southwest v. Kiwi, Bethpage enforcement). → **never auto-book via scraping.**
- **Voice agent** sidesteps the payment-automation wall entirely: a human staffer takes payment / books
  on their system, so we never touch a card or a 2FA gate. It's also legally cleaner than scraping (no
  ToS/CFAA) and on-brand for Looper's voice-first Northstar. noteefy & Sagacity already do AI voice
  booking into tee sheets — direct validation.

## Three tracks (priority order)
### Track A — Official partner APIs (PRIMARY)
- **Lightspeed Golf / Chronogolf Partner API V2 — START HERE.** Public docs, credentials by emailing
  `golf.api@lightspeedhq.com` (staging+prod, no big contract), REST/JSON, 200 req/min. Full loop:
  availability + 3-step booking + cancel/modify + pricing + **payment**. Large US+CA coverage. Best
  effort-to-coverage ratio.
- **GolfNow / TeeOff Affiliate & Partner API — breadth.** ~9,000+ courses, OAuth2, sandbox, full
  availability+booking, **free rev-share (~$3/round)** — but a *vetted application* (start early). Also
  covers EZLinks/TeeSnap inventory via the network.
- **foreUP — conditional third.** Truly open docs, big coverage, BUT reserves per-call fees + a ToU
  anti-compete clause (a consumer booking app needs their blessing, per-course, revocable).
- Defer (contract/enterprise-gated): EZLinks/EZTeePro, Supreme Golf, Club Caddie, Club Prophet,
  TeeSnap, Quick18, MembersFirst, Golf18, TeeWire (tiny). Sagacity/noteefy are NOT sources (they
  consume tee sheets) — but are competitive signals.

### Track B — Outbound voice agent (DIFFERENTIATOR + long tail)
- For phone-only / API-less courses. Build on a **managed platform — Vapi** (best structured JSON
  extraction → clean "booked y/n + date/time/confirmation#/cost" back to Looper) or **Retell** (best
  appointment-booking ergonomics). NOT DIY initially (telephony/AMD/voicemail/IVR/retry = weeks of
  undifferentiated plumbing the platforms solve). Keep OpenAI-Realtime DIY (we already run it for the
  caddie; native SIP since Aug 2025) as a later cost-optimization fallback (BYO key on the platforms).
- Architecture: FastAPI `POST /bookings/call` → per-call dynamic vars (course #, golfer, window, party,
  price ceiling) → platform outbound call → mid-call function calls capture fields → post-call webhook
  lands structured result + success flag → persist + notify user. Voicemail/no-answer/IVR → "not
  completed" partial → fall back to telling the golfer to call.
- **Cost: ~$0.75–$1.00 per completed booking** (incl. retries/no-answers).
- **COMPLIANCE (gating; lawyer review before launch):**
  1. **Never AI-dial an unverified CELL** without consent — TCPA artificial-voice (FCC 24-17, Feb 2024)
     has **no business carve-out for cell numbers** ($500–$1,500/call, uncapped). Can't tell cell from
     landline by number → **gate to verified business landlines** (or get consent).
  2. **Treat every call as all-party recording consent** — announce recording, or (better) **don't store
     audio**; transcribe ephemerally. (CIPA $5k/violation; active AI-notetaker litigation.)
  3. **Open with AI disclosure**: "automated AI assistant on behalf of [user], callback # [x], may be
     recorded." (Pre-complies CA AB 2905 + pending FCC rule; satisfies §64.1200(b) identity.)
  4. Not an autodialer (Duguid — user-supplied #); transactional not telemarketing (DNC/TSR/most
     mini-TCPAs don't apply). STIR/SHAKEN Attestation-A carrier, honest caller ID, 8am–9pm local,
     honor opt-outs + permanent suppression list. **TCPA/telecom attorney reviews scripts + recording
     posture + CPaaS/VSP status before launch.**

### Track C — Web scraping (READ-ONLY availability fallback; never auto-book)
- For API-less courses, fill *availability* only. foreUP exposes a public JSON endpoint
  (`/api/booking/times?...api_key=no_limits`) — genuinely easy. GolfNow/Chronogolf reachable via
  internal JSON behind a browser-minted token. Defended sites (Cloudflare/DataDome, JA4 fingerprinting)
  = ~0.5 FTE perpetual arms race + silent failures — not worth it for a small team beyond easy targets.
- **Legal:** reading **public/logged-out** availability is defensible (hiQ, Meta v. Bright Data) IF we
  stay logged-out + honor C&Ds. Logged-in scraping / ToS breach / auto-booking = the danger zone (hiQ
  lost on contract: $500k). → scraping = **discover + alert + deep-link/pre-fill the official form, hand
  2FA + payment to the human.** Never automate booking/payment by scraping.

## Build phases
- **Phase 0 — research + plan.** ✅ (this doc).
- **Phase 1 — Foundation (buildable NOW, no creds).** Replace the hardcoded demo with a real
  `TeeTimeProvider` abstraction (search + book interfaces) + provider registry + cache-first layer (reuse
  the GolfAPI cache-first pattern). Wire the real UI to a **mock provider** so the flow works end-to-end
  and flips to live per-provider. Wire the two no-op buttons. Define the availability/booking data model
  + a `POST /bookings/*` backend surface (mock).
- **Phase 2 — First real API: Lightspeed/Chronogolf** (owner emails for creds) → real availability +
  booking for those courses, cache-first. In parallel: **apply to GolfNow affiliate**.
- **Phase 3 — Breadth: GolfNow/TeeOff** once approved (+ foreUP if pursued).
- **Phase 4 — Voice agent (needs owner go: budget + lawyer):** Vapi/Retell outbound booking for
  phone-only courses, with the compliance controls above. The marquee differentiator.
- **Phase 5 — Scraping availability fallback** (read-only) for API-less courses; deep-link to book.

## Owner actions / decisions required
1. **Provider access (you):** email `golf.api@lightspeedhq.com` for Chronogolf/Lightspeed Partner API
   creds; apply to GolfNow affiliate (golfnow.com/business-partnership). These gate Tracks A's real data.
2. **Voice-agent go + budget** (~$0.75–1/booking + platform) and commitment to a **TCPA attorney review**
   before the voice track launches.
3. **Confirm phasing** (APIs → voice → scraping read-only). 
- Meanwhile the team builds **Phase 1 (abstraction + mock + real UI)** now — no creds needed.

## Honest risks
Provider approvals take time (GolfNow vetting); voice-agent compliance is the real gate (cell-dialing +
recording consent — controllable but needs a lawyer); scraping defended sites is a maintenance sink
(limit to easy read-only targets); booking-by-scraping is legally radioactive (avoid). No single track
covers all courses — the product is the *union* (APIs where possible, voice for the phone-only long tail,
scraping to fill availability gaps).
