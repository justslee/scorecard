# Tee-time AI call — owner rehearsal harness ("call me, I'll be the pro shop")

*Owner directive 2026-07-09: "I would like it to 'call me' when I tell it to so I
can mimic being the pro shop." The safest possible POC of the outbound AI
booking call — the owner is BOTH the trigger and the callee; no real course is
ever dialed during rehearsal.*

## What it does
Owner triggers a rehearsal → the backend places an outbound Twilio call **to the
owner's own verified number** → bridges the caller to the realtime booking agent
running the REAL dialog (disclosure → availability ask → booking in the player's
name → confirmation capture) against a TEST course context → the owner answers
and role-plays the pro shop, saying whatever a real shop might → the agent's
transcript + structured CallOutcome/BookingResult are captured and shown. It's a
live rehearsal of the exact script that will one day call a real pro shop.

## Why this is the right test
- **Zero external risk**: dials ONLY the owner's number (allowlist of one), never
  a course. No ToS, no TCPA surface, no wrong-number liability.
- **Real path, not a mock**: exercises the actual telephony bridge + realtime
  agent + dialog + disclosure + outcome capture — the parts a pure simulator
  can't prove (audio, barge-in, latency, the agent hearing unexpected answers).
- **The owner hears what a course will hear** and can throw curveballs ("we're
  full", "how many players?", "what's the name?", "we don't take AI bookings").

## Design
- **Trigger**: an owner-only action — a dev/settings control or a chat command
  ("rehearse a tee-time call") → `POST /api/tee-times/rehearsal-call` (owner-auth,
  owner's own number pulled from profile, never a passed-in number).
- **Callee**: the owner's OWN verified phone (E.164, from profile / a one-time
  verify). The compliance allowlist is set to exactly that number for the
  rehearsal; the suppression + calling-hours gates still apply.
- **Bridge**: the existing `voice_booking/telephony.py` live transport (gated on
  VOICE_BOOKING_ENABLED + Twilio creds) → connects the inbound-answered call to
  the realtime booking agent (reuse the realtime relay/session the caddie uses).
- **Context**: a TEST course ("Rehearsal Pro Shop") + a sample query (Saturday,
  1 player, a window) so the agent has something concrete to ask for.
- **Script**: the REAL `dialog.py` flow — FIRST words are always the AI
  disclosure (`compliance.disclosure_line`), then availability ask, then it
  tries to book in the player's name, then reads back / captures the outcome.
- **Capture**: transcript + `CallOutcome` → `BookingResult` persisted + shown to
  the owner (what the agent heard, what it concluded, did it "book").
- **Safety rails (all already in the scaffold)**: VOICE_BOOKING_ENABLED gate,
  owner-only trigger, allowlist = owner's number only, disclosure mandatory,
  calling-hours + suppression, no card capture, transcript logged.

## Build placement
This is the verification tool for tee-time Slice S3 (the AI-caller route). Build
it AS PART OF S3 so S3 ships with a way for the owner to prove the call works
before any real course is ever dialed. Live Twilio dialing stays behind the
existing gate + (per the scaffold's own note) attorney sign-off before dialing a
real pro shop — but rehearsal-to-self is safe to exercise as soon as Twilio
creds + VOICE_BOOKING_ENABLED are set for the owner's own number.

## Also usable: the pure simulator (no phone)
The scaffold already has a `/book-by-call/simulate` path (text-in/text-out of the
dialog, no telephony). Keep that as the CI-safe test; the rehearsal CALL is the
owner's real-audio confidence check on top of it.
