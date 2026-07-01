# Tee-Time Voice Booking Agent — Execution Plan (2026-07-01)

Owner ask: build the **whole outbound voice call agent** that (1) finds the pro shop
phone number for a course, (2) calls it with a realistic conversational AI, (3) reacts
to responses, (4) navigates IVR menus ("Press 1 for grill, Press 2 for pro shop"),
and (5) reads a **saved credit card** on request — safely, never leaking it elsewhere.

This deviates from `tee-time-booking-plan.md` in ONE way: that plan had a human take
payment (never touch a card). The owner now wants the agent to read the card. We build
it, but with a hardened card vault + redaction + PCI/legal flag (see Risks).

## What "done" means here
- **Code-complete + high-confidence via a call SIMULATOR** (scripted pro-shop calls that
  exercise the FULL dialog/IVR/card/outcome logic with no real telephony). This is the
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
- **`card_vault.py`** — the ONLY place a card is read. Loads from env
  `LOOPER_PAYMENT_CARD` (JSON in Secrets Manager `looper/prod`: `{number,exp,cvc,zip,name}`).
  `get_card()`, `spoken_card()` (digit-by-digit for clean TTS), and `redact(text)` that
  masks any 13–19-digit PAN / CVV in transcripts + logs. Card NEVER enters a log line,
  the LLM system prompt, or any stored transcript. Injected only at the payment turn.
- **`ivr.py`** — `detect_menu(text) -> IvrMenu | None` (parses "press N for …", "for X, press N",
  "say 'pro shop'"), `choose_option(menu, goal) -> digit|None` with a golf synonym map
  (pro shop / golf shop / tee times / reservations / front desk). DTMF-ready.
- **`dialog.py`** — `build_instructions(ctx)`: the agent's system prompt/goals — AI
  disclosure opening, state the golfer + desired date/time window + party, accept
  alternatives inside the window ≤ price ceiling, ONLY provide payment when a human asks,
  confirm + read back date/time/confirmation#/cost. Guardrail: the card is NEVER in the
  prompt (a tool/function boundary supplies it at the moment of payment).
- **`outcome.py`** — `parse_outcome(structured|transcript) -> CallOutcome` → `BookingResult`
  (booked y/n, date, time, confirmation#, cost).
- **`compliance.py`** — `within_calling_hours(tz, now)` (8am–9pm local), disclosure text,
  business-line best-effort gate, no-audio-storage flag, opt-out/suppression hook.
- **`phone_lookup.py`** — Google Places **Place Details** (`places.v1`, uses the same
  server key as course search) → the course's `internationalPhoneNumber`. No-op → None
  without a key.

I/O modules (gated on env; live path needs owner creds):
- **`telephony.py`** — Twilio Programmable Voice outbound call + Media Streams (bidirectional
  audio) bridged to **OpenAI Realtime** (we already run Realtime for the caddie). Sends DTMF
  for IVR, calls a `provide_payment` tool at the payment turn (pulls from card_vault),
  streams disclosure first, enforces max duration. Gated on `TWILIO_*` + `OPENAI_API_KEY`;
  clear error (never a crash) when unset.
- **`provider.py`** — `VoiceCallProvider(TeeTimeProvider)`: `book()` = lookup phone →
  compliance gate → place call (telephony) → parse outcome. `search_availability()` →
  `not_supported`.
- **`simulator.py`** — scripted "pro shop" runner: feeds a turn sequence (auto-greeting →
  IVR menu → human → availability → payment request → confirmation, plus voicemail /
  no-answer / out-of-window variants) through the SAME dialog+ivr+card+outcome logic with
  NO telephony. Returns the (redacted) transcript + `CallOutcome`. This is the test/demo core.

## Route
- `POST /api/tee-times/book-by-call` → `VoiceCallProvider.book()` (owner-gated, live).
- `POST /api/tee-times/book-by-call/simulate` → runs `simulator.py` for a named scenario,
  returns redacted transcript + outcome. Lets the owner SEE it work with no real call/creds.

## Tests (the confidence bar)
Per-module unit tests + simulator scenarios: happy-path booking, IVR-menu navigation to
pro shop, alternative-time acceptance within window, price-ceiling refusal, voicemail /
no-answer → `needs_human`, out-of-hours gate, and — critically — **card is spoken ONLY at
the payment turn and NEVER appears in the transcript/logs** (redaction asserted).

## Compliance guardrails (built in; lawyer review before live)
AI-disclosure opening; 8am–9pm local calling-hours gate; treat as all-party recording
consent (announce, don't store audio); honest caller ID / callback #; opt-out + suppression
hook. Business-line best-effort (can't reliably tell cell from landline — gate to
owner-confirmed pro-shop landlines).

## Go-Live checklist (owner)
1. Pick telephony: **Twilio** (DIY, full IVR/DTMF/card control — this build targets it) or a
   managed platform (Vapi/Retell). Provision a number + STIR/SHAKEN Attestation-A.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and
   `LOOPER_PAYMENT_CARD` (JSON) in Secrets Manager `looper/prod`. `OPENAI_API_KEY` already set.
   (`GOOGLE_PLACES_API_KEY` — the course-search key — powers the phone lookup.)
3. Expose the Media-Streams webhook publicly (the backend is already at api.looperapp.org).
4. **TCPA / recording-consent attorney review** of the script + posture.
5. First real test call to a consenting number (your own phone acting as the "pro shop").

## Risks / honest notes
- **Card-over-voice** is the owner's explicit choice; it's PCI-adjacent. We minimize scope
  (vault + redaction + never-logged + injected only at pay turn) but a human-takes-payment
  design is lower-risk — flagged, owner decides.
- Live telephony + real-world IVR/voicemail variety can't be fully proven without real calls;
  the simulator gives logic confidence, not carrier confidence.
