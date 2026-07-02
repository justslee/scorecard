# Tee-Time Voice Booking Agent — Execution Plan (2026-07-01)

> Ported from `feat/voice-booking-agent` (scaffold commit 0d2f609) onto `integration/next`,
> **amended per the eng-lead decision locked in `specs/tee-time-booking-phase1b.md`:
> NO card vault.** Payment is handed to the human staffer / the golfer (epic plan
> `specs/tee-time-booking-plan.md` §Track B). `card_vault.py` is dropped from the module
> list and all card handling is stripped from the dialog plan — if a course insists on a
> card to hold the time, the agent declines and returns `needs_human`.

Owner ask: build the outbound voice call agent that (1) finds the pro shop
phone number for a course, (2) calls it with a realistic conversational AI, (3) reacts
to responses, and (4) navigates IVR menus ("Press 1 for grill, Press 2 for pro shop").
Payment is never spoken by the agent — a human completes it.

## What "done" means here
- **Code-complete + high-confidence via a call SIMULATOR** (scripted pro-shop calls that
  exercise the FULL dialog/IVR/outcome logic with no real telephony). This is the
  confidence bar we CAN hit autonomously.
- **Live calls need owner setup** we cannot self-provision: a telephony provider + phone
  number + a TCPA/recording review + a first real test call. Documented in Go-Live below.

## Architecture — `backend/app/services/voice_booking/`
Slots behind the existing `TeeTimeProvider` ABC (`services/tee_times/base.py`):
`VoiceCallProvider.book()` places a call and returns a `BookingResult`
(`confirmed | pending | failed | needs_human | not_supported`).

Pure, unit-tested modules (no I/O — the confidence core):
- **`types.py`** — `VoiceBookingContext` (course, phone, golfer name+callback, date,
  window, party, price ceiling, hole pref), `IvrMenu`, `CallTurn`, `CallOutcome`.
- **`ivr.py`** — `detect_menu(text) -> IvrMenu | None` (parses "press N for …", "for X, press N",
  "say 'pro shop'"), `choose_option(menu, goal) -> digit|None` with a golf synonym map
  (pro shop / golf shop / tee times / reservations / front desk). DTMF-ready.
- **`dialog.py`** — the booking conversation state machine (goal → opener → slot
  negotiation → confirm → outcome): AI-disclosure opening ALWAYS the first words to a
  human, state the golfer + desired date/time window + party, accept alternatives inside
  the window ≤ price ceiling, confirm + read back date/time/confirmation#/cost.
  **No payment path**: if asked for a card, the agent offers to hold under the golfer's
  name + callback number; if the course requires a card, end politely → `needs_human`.
- **`outcome.py`** — `CallOutcome` → `BookingResult` mapping (booked → confirmed;
  voicemail / no-answer / card-required / unclear → needs_human; no availability → failed).
- **`compliance.py`** — the plan's gates as CODE: `within_calling_hours(tz, now)`
  (8am–9pm local), AI-disclosure line generator (user name + callback number),
  business-landline-only check (owner-verified allowlist — can't tell cell from landline
  by number), no-audio-storage posture flag, opt-out/suppression list.
- **`phone_lookup.py`** — Google Places text search (`places.v1`, same server key as
  course search) → the course's `internationalPhoneNumber`. No-op → None without a key.

I/O modules (gated on env; live path needs owner creds):
- **`telephony.py`** — STUB. Raises RuntimeError("voice booking disabled") unless
  `VOICE_BOOKING_ENABLED=1` AND Twilio creds are present — and even then it is
  NotImplemented for now. Launch is owner-gated (budget + TCPA attorney); code ≠ launch.
  The live build targets Twilio Programmable Voice + Media Streams bridged to
  OpenAI Realtime (we already run Realtime for the caddie), sending DTMF for IVR,
  streaming the disclosure first, enforcing max duration.
- **`provider.py`** — `VoiceCallProvider(TeeTimeProvider)`: `book()` = lookup phone →
  compliance gate → run the dialog against a supplied transport → parse outcome.
  `search_availability()` → `[]` (not supported). The ONLY transport shipped now is the
  simulator.
- **`simulator.py`** — scripted "pro shop" runner: deterministic personas (friendly
  booker, busy/hold, voicemail, IVR-first, no-availability, card-required) drive the SAME
  dialog+ivr+outcome logic with NO telephony. Returns the transcript + `CallOutcome`.
  This is the test/demo core.

## Route
- `POST /api/tee-times/book-by-call/simulate` — runs `simulator.py` for a named persona,
  returns transcript + outcome + BookingResult. Owner-auth like the rest of the router.
  Lets the owner SEE it work with no real call/creds. **NO real-call route yet** —
  `POST /api/tee-times/book-by-call` ships only with the live telephony track.

## Tests (the confidence bar)
Per-module unit tests + simulator scenarios: happy-path booking, IVR-menu navigation to
pro shop, alternative-time acceptance within window, price-ceiling refusal, voicemail /
no-answer → `needs_human`, card-required → `needs_human`, out-of-hours gate,
disclosure-line-first asserted on every human conversation, suppression respected,
simulator determinism, provider statuses stay within the stable set.

## Compliance guardrails (built in; lawyer review before live)
AI-disclosure opening; 8am–9pm local calling-hours gate; treat as all-party recording
consent (announce, don't store audio); honest caller ID / callback #; opt-out + suppression
list. Business-line best-effort (can't reliably tell cell from landline — gate to
owner-confirmed pro-shop landlines). Never AI-dial an unverified cell (TCPA, FCC 24-17).

## Go-Live checklist (owner)
1. Pick telephony: **Twilio** (DIY, full IVR/DTMF control — this build targets it) or a
   managed platform (Vapi/Retell — the epic plan's Track B recommendation). Provision a
   number + STIR/SHAKEN Attestation-A.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` in Secrets Manager
   `looper/prod` and `VOICE_BOOKING_ENABLED=1`. `OPENAI_API_KEY` already set.
   (`GOOGLE_PLACES_API_KEY` — the course-search key — powers the phone lookup.)
3. Expose the Media-Streams webhook publicly (the backend is already at api.looperapp.org).
4. **TCPA / recording-consent attorney review** of the script + posture.
5. Populate the verified pro-shop landline allowlist (compliance gate refuses all other
   numbers) and the course time zones.
6. First real test call to a consenting number (your own phone acting as the "pro shop").

## Risks / honest notes
- Live telephony + real-world IVR/voicemail variety can't be fully proven without real
  calls; the simulator gives logic confidence, not carrier confidence.
- Calling-hours need the COURSE's local time zone; the pre-build defaults to a single
  configurable zone — per-course tz data is part of the go-live checklist.
