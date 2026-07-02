"""
Live telephony transport — DELIBERATELY a stub.

Real outbound calls are owner-gated (budget + TCPA attorney review — see the
go-live checklist in specs/tee-time-voice-agent.md). Code ≠ launch: this
module refuses to construct a live transport unless VOICE_BOOKING_ENABLED=1
AND full Twilio credentials are present, and EVEN THEN it is NotImplemented —
the Twilio Media-Streams ↔ OpenAI Realtime bridge ships with the live track,
after the attorney sign-off.

The only transport that exists today is the simulator (simulator.py).
"""

from __future__ import annotations

import os

_TWILIO_ENV_VARS = ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER")


def get_live_transport():
    """Return the live call transport. Raises unless explicitly enabled.

    RuntimeError("voice booking disabled")  — the default, safe state.
    NotImplementedError                     — enabled + creds, but the live
                                              bridge hasn't shipped (owner-gated).
    """
    if os.getenv("VOICE_BOOKING_ENABLED") != "1":
        raise RuntimeError("voice booking disabled")
    missing = [v for v in _TWILIO_ENV_VARS if not os.getenv(v)]
    if missing:
        raise RuntimeError(
            f"voice booking disabled — missing credentials: {', '.join(missing)}"
        )
    raise NotImplementedError(
        "live voice calls are owner-gated (TCPA attorney review + first "
        "supervised test call) — the telephony bridge ships with the live track"
    )
