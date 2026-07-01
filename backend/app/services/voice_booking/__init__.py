"""Outbound voice tee-time booking agent (calls a course's pro shop).

See specs/tee-time-voice-agent.md. Pure logic modules (types, dialog, ivr,
outcome, compliance, phone_lookup, simulator) are unit-tested and
telephony-free; provider.py slots behind the TeeTimeProvider ABC and runs the
dialog against a supplied transport — the ONLY transport shipped today is the
simulator. telephony.py is a stub gated on VOICE_BOOKING_ENABLED + Twilio
creds (live launch is owner-gated: budget + TCPA attorney review).

No card handling anywhere in this package — payment is handed to the human
staffer / the golfer (eng-lead decision, specs/tee-time-booking-phase1b.md).
"""
