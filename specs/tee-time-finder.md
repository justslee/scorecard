# Spec — Tee-Time Finder ("Dispatch a Looper")

**Status:** Roadmap · major · phased. The MVP ships with **no gated API**; live
availability and real booking are gated behind **business partnerships** (owner action).

## Problem & vision
`/tee-time` already has a polished, three-phase experience — **prefs** (time windows,
group, courses, drive radius) → **searching** (a "looper" is dispatched, live log +
radar) → **confirmed** (a booked tee time with weather, group, conf code, ETA). Today
it is **100% fabricated**. Make it real, grounded to the existing UI and data contract —
without pretending we have data access we don't.

**The hard part is data, not UI.** There is no free/open "all tee times near me" API.
Every real source is gated (see below). So this is phased, and the deepest phases depend
on the owner securing API access.

## Data contract — DO NOT change the UI shape
Every provider normalizes into this exact shape (from the current mock,
`frontend/src/app/api/tee-times/route.ts`), so the 3-phase UI is untouched:

```ts
type TeeTime = {
  id: string;            // `${courseId}-${date}-${time}-${slotIndex}`
  courseId: string;
  courseName: string;
  city: string;
  date: string;          // ISO 8601
  time: string;          // "HH:MM" 24h
  players: number;       // available slots 1-4
  priceUsd: number;
  cartIncluded: boolean;
  distanceMiles: number;
  rating: number;        // 0-5
  designer?: string;
  bookingUrl?: string;   // NEW — deep-link to book (Phase 1+)
};
// GET /api/tee-times?q=&date=&players=  ->  { query, date, players, results: TeeTime[] }
```
The **only** addition is the optional `bookingUrl`. The prefs (windows, courses, radius,
group) are collected by the UI today but **not yet sent** to the API — wiring them into
the query is part of Phase 1.

## How we actually get tee-time data (grounded reality)
| Source | Inventory | Access | Notes |
|---|---|---|---|
| **GolfNow Affiliate & Partner API** | Largest (dominant marketplace, now Versant Media) | Gated — owner applies ([affiliate.gnsvc.com](https://affiliate.gnsvc.com/)) | REST/JSON/OAuth2; the path to nationwide live slots |
| **Lightspeed (Chronogolf) Partner API** | Per-course (Lightspeed courses) | Gated — email `golf.api@lightspeedhq.com` ([docs](https://partner-api.docs.chronogolf.com/)) | Read tee sheet + **book/pay** → enables real auto-booking; 200 req/min |
| **foreUP** | Per-course | Gated | Booking-engine API, similar to Lightspeed |
| **Commercial aggregators** (SportsFirst, TeeWire) | Multi-source | Pay-per-use | Faster to access than direct partnerships; cost + coverage vary |
| **Affiliate deep-link** | Real courses, no live slots | **No gate** | The MVP: link out to GolfNow/course booking pages |

## Architecture — provider pattern (backend-owned)
Move `/api/tee-times` from the Next.js mock to a **FastAPI route** (secrets like GolfNow
OAuth must stay server-side per the security model — and this is route #9 of the B1
relocation anyway). Behind it, a pluggable `TeeTimeProvider` selected by config:

```
GET /api/tee-times  ->  TeeTimeProvider.search(query, date, players, prefs) -> TeeTime[]
  ├─ MockProvider          (port the seeded generator — keeps dev/demo working)
  ├─ AffiliateLinkProvider (Phase 1 — real courses + booking deep-links, no live slots)
  ├─ GolfNowProvider       (Phase 2 — real availability via the Affiliate API)
  └─ LightspeedProvider    (Phase 3 — real BOOKING; powers true auto-dispatch)
```

## Phases
### Phase 1 — MVP, ships now, NO gated API  *(major)*
- New backend `GET /api/tee-times` (replaces the Next.js mock; identical response shape),
  with `MockProvider` (fallback/demo) + `AffiliateLinkProvider`.
- **AffiliateLinkProvider** reuses our existing real course search
  (`backend/app/routes/course_search.py` + golfapi.io/OSM) to find courses near the
  golfer, and attaches a `bookingUrl` (a GolfNow search deep-link or the course's site).
  It has **no live slots**, so `priceUsd`/`time` are surfaced as "see booking site," not
  fabricated.
- **Wire the prefs** (windows, courses, radius, players) into the query.
- **Honest "confirmed" phase:** best match → "Book on GolfNow →" (a real deep-link), not a
  fake confirmation code.
- *Verify:* from `/tee-time`, set prefs → Dispatch → real Bay-Area courses with working
  booking links; backend returns the exact `{query,date,players,results}` shape; the
  static-export build works (no Next.js route left).

### Phase 2 — Live availability  *(major, gated)*
- **Owner:** apply to the GolfNow Affiliate & Partner program; creds → Secrets Manager.
- `GolfNowProvider`: real slots/prices/times normalized to `TeeTime`; the "searching"
  phase now matches live availability against prefs (windows / radius / players).
- *Verify:* live availability returned for a known course + window.

### Phase 3 — Real auto-booking ("the looper books it")  *(major, deepest)*
- `LightspeedProvider` (or foreUP/GolfNow booking) turns "confirmed" into a **real
  reservation** (conf code, payment). The "Dispatch Looper" becomes a genuine agent:
  poll → match → book → confirm.
- *Verify:* a real test booking against a provider sandbox.

## Owner-only steps (business, not code — agents can't do these)
- Apply for the **GolfNow Affiliate & Partner API** (the big inventory) — Phase 2+.
- *(Optional)* Email `golf.api@lightspeedhq.com` for **Lightspeed Partner** creds — Phase 3 booking.
- *(Optional)* Evaluate a commercial aggregator (SportsFirst / TeeWire) if GolfNow approval is slow.
- Provider API keys → **AWS Secrets Manager** (`looper/prod`), never in the repo.

## Files
- **New backend:** `backend/app/routes/tee_times.py`; `backend/app/services/tee_times/`
  (`base.py` interface + `mock.py`, `affiliate.py`, `golfnow.py`, `lightspeed.py`).
- **Delete:** `frontend/src/app/api/tee-times/route.ts` (moves to backend; also required for static export).
- **Edit:** `frontend/src/app/tee-time/page.tsx` — send prefs via authed `fetchAPI` (`lib/api.ts`); render `bookingUrl`; show "availability on booking site" where slots are unknown.
- **Reuse:** `backend/app/routes/course_search.py`, `frontend/src/lib/golf-api.ts`, `frontend/src/lib/api.ts`.

## Out of scope
- In-app payment processing (Phase 3+). · "Watch for a slot to open" monitoring/push (future).

## Edge cases
- No courses in radius / no availability → empty state.
- Provider unconfigured or down → fall back to `MockProvider`, clearly labeled "demo data."
- Requested players > available slots → exclude or flag.

## Verification (end-to-end)
Phase 1 is the gate to "real": from `/tee-time`, real prefs produce real nearby courses
with working booking links; the backend route returns the exact contract; the static
build succeeds with the Next.js mock route removed.
