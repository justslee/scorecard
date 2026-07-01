"""Outbound voice tee-time booking agent (calls a course's pro shop).

See specs/tee-time-voice-agent.md. Pure logic modules (card_vault, ivr, dialog,
outcome, compliance, phone_lookup, simulator) are unit-tested and telephony-free;
telephony.py + provider.py are the live I/O path (gated on Twilio/OpenAI creds).
"""
