"""Outbound voice tee-time booking agent (calls a course's pro shop).

See specs/tee-time-voice-agent.md. Pure logic modules (types, dialog, ivr,
outcome, compliance, phone_lookup, simulator) are unit-tested and
telephony-free; provider.py slots behind the TeeTimeProvider ABC and runs the
dialog against a supplied transport. Two transports exist:
  - simulator.SimulatedCallTransport — scripted personas, no telephony, the
    default for tests/dev/QA.
  - telephony.LiveCallTransport — the real Twilio ↔ OpenAI Realtime bridge
    (specs/teetime-s3b-twilio-bridge-plan.md); `telephony.get_live_transport()`
    still refuses unless VOICE_BOOKING_ENABLED=1, full Twilio credentials, and
    VOICE_BOOKING_PUBLIC_HOST are all configured — code shipping is not the
    same as the owner turning live calling on.

No card handling anywhere in this package — payment is handed to the human
staffer / the golfer (eng-lead decision, specs/tee-time-booking-phase1b.md).
"""
