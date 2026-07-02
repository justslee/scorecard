"""Voice booking agent — pure-module tests (no network, no DB, no telephony).

Covers, per specs/tee-time-voice-agent.md:
  - dialog happy path per simulator persona (incl. IVR navigation + hold)
  - compliance gates as code: verified-landline allowlist, 8am–9pm local hours,
    disclosure line ALWAYS the agent's first words to a human, suppression list
  - outcome mapping (voicemail / no-answer / card-required → needs_human, …)
  - simulator determinism
  - provider contract: statuses stay within the stable BookingResult set
  - telephony stays a stub (env-gated RuntimeError, then NotImplemented)
"""

import re
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.services.tee_times.base import BookingDetails, TeeTimeSlot
from app.services.voice_booking import compliance, ivr, telephony
from app.services.voice_booking.dialog import (
    BookingDialog,
    parse_offered_time,
    parse_price,
)
from app.services.voice_booking.outcome import to_booking_result
from app.services.voice_booking.provider import VoiceCallProvider, _window_end
from app.services.voice_booking.simulator import (
    PERSONA_NAMES,
    SimulatedCallTransport,
    default_context,
    run_simulation,
)
from app.services.voice_booking.types import CallOutcome

STABLE_STATUSES = {"confirmed", "pending", "failed", "needs_human", "not_supported"}

LA = ZoneInfo("America/Los_Angeles")
NOON = datetime(2026, 7, 11, 12, 0, tzinfo=LA)

DISCLOSURE_PREFIX = "Hi — I'm an automated AI assistant calling on behalf of"


def _spoken_agent_turns(transcript):
    """Agent turns that are speech (not DTMF presses)."""
    return [
        t for t in transcript
        if t.speaker == "agent" and not t.text.startswith("[pressed")
    ]


# ─── Simulator personas: the dialog happy paths ────────────────────────────────


class TestPersonas:
    def test_friendly_books_and_confirms(self):
        sim = run_simulation("friendly")
        assert sim.outcome.result == "booked"
        assert sim.outcome.time == "07:40"
        assert sim.outcome.cost_usd == 86.0
        assert sim.outcome.confirmation_number == "PG7402"
        assert sim.booking_result.status == "confirmed"
        assert sim.booking_result.confirmation_number == "PG7402"

    def test_busy_hold_waits_then_books(self):
        sim = run_simulation("busy_hold")
        assert sim.outcome.result == "booked"
        assert sim.outcome.time == "08:10"
        assert sim.outcome.confirmation_number == "BH8102"
        assert sim.booking_result.status == "confirmed"

    def test_ivr_first_presses_pro_shop_digit_then_books(self):
        sim = run_simulation("ivr_first")
        assert sim.outcome.result == "booked"
        assert sim.outcome.confirmation_number == "IV7501"
        pressed = [t.text for t in sim.transcript if t.text.startswith("[pressed")]
        assert pressed == ["[pressed 2]"]

    def test_voicemail_hangs_up_needs_human(self):
        sim = run_simulation("voicemail")
        assert sim.outcome.result == "voicemail"
        assert sim.booking_result.status == "needs_human"
        # Never negotiate with a machine — the agent says nothing.
        assert _spoken_agent_turns(sim.transcript) == []

    def test_no_availability_fails_honestly(self):
        sim = run_simulation("no_availability")
        assert sim.outcome.result == "no_availability"
        assert sim.booking_result.status == "failed"
        assert sim.booking_result.confirmation_number is None

    def test_card_required_declines_payment_needs_human(self):
        sim = run_simulation("card_required")
        assert sim.outcome.result == "card_required"
        assert sim.booking_result.status == "needs_human"
        agent_text = " ".join(t.text for t in _spoken_agent_turns(sim.transcript))
        assert "not able to provide payment" in agent_text
        # The agent NEVER reads out a card — no PAN-like contiguous digit run
        # (13–19 digits, separators allowed) anywhere in its speech. The 11-digit
        # callback number and dates are fine; a card number is not.
        pan_like = re.compile(r"(?:\d[\s-]?){13,}")
        assert not any(pan_like.search(t.text) for t in _spoken_agent_turns(sim.transcript))

    def test_no_answer_needs_human_with_empty_transcript(self):
        sim = run_simulation("no_answer")
        assert sim.outcome.result == "no_answer"
        assert sim.booking_result.status == "needs_human"
        assert sim.transcript == []

    def test_disclosure_is_first_words_to_every_human(self):
        """Compliance: the AI disclosure opens every human conversation."""
        for persona in PERSONA_NAMES:
            sim = run_simulation(persona)
            spoken = _spoken_agent_turns(sim.transcript)
            if not spoken:            # voicemail / no_answer — nothing spoken
                continue
            assert spoken[0].text.startswith(DISCLOSURE_PREFIX), (
                f"persona {persona}: first agent words must be the disclosure, "
                f"got: {spoken[0].text!r}"
            )

    def test_all_persona_statuses_stay_in_stable_set(self):
        for persona in PERSONA_NAMES:
            sim = run_simulation(persona)
            assert sim.booking_result.status in STABLE_STATUSES

    def test_simulator_is_deterministic(self):
        for persona in PERSONA_NAMES:
            a, b = run_simulation(persona), run_simulation(persona)
            assert a.transcript == b.transcript
            assert a.outcome == b.outcome
            assert a.booking_result == b.booking_result

    def test_unknown_persona_raises(self):
        with pytest.raises(ValueError, match="unknown persona"):
            run_simulation("angry_goose")


# ─── Dialog negotiation edges ──────────────────────────────────────────────────


class TestDialogNegotiation:
    def test_rejects_over_ceiling_then_accepts_cheaper(self):
        dialog = BookingDialog(default_context())      # ceiling $100
        dialog.respond("Pro shop, this is Pat.")
        action = dialog.respond("I have 8:00 am at $150 a player.")
        assert action.kind == "say" and "budget" in action.text
        dialog.respond("Okay — I can do 9:15 at $85.")
        action = dialog.respond("You're all set, confirmation number is XY1234.")
        assert dialog.done
        assert dialog.outcome.result == "booked"
        assert dialog.outcome.time == "09:15"
        assert dialog.outcome.cost_usd == 85.0
        assert dialog.outcome.confirmation_number == "XY1234"

    def test_rejects_out_of_window_then_accepts_alternative(self):
        dialog = BookingDialog(default_context())      # window 07:00–10:00
        dialog.respond("Pro shop.")
        action = dialog.respond("I only have 2:30 pm open.")
        assert action.kind == "say" and "between" in action.text
        dialog.respond("How about 7:15 am?")
        dialog.respond("Great, you're booked — confirmation AA9001.")
        assert dialog.outcome.result == "booked"
        assert dialog.outcome.time == "07:15"

    def test_gives_up_after_bounded_attempts(self):
        dialog = BookingDialog(default_context())
        dialog.respond("Pro shop.")
        dialog.respond("I only have 2:30 pm.")
        dialog.respond("Or 3:45 pm?")
        dialog.respond("Maybe 6:00 pm?")
        assert dialog.done
        assert dialog.outcome.result == "no_availability"

    def test_opt_out_ends_call_and_flags_suppression(self):
        dialog = BookingDialog(default_context())
        dialog.respond("Pro shop.")
        dialog.respond("Please take us off your list and don't call again.")
        assert dialog.done
        assert dialog.opt_out_requested is True
        assert dialog.outcome.opt_out_requested is True
        assert to_booking_result(dialog.outcome, default_context()).status == "needs_human"

    def test_parse_offered_time_resolves_ambiguity_toward_window(self):
        assert parse_offered_time("I have 7:40", "07:00", "10:00") == "07:40"
        assert parse_offered_time("I have 2:30", "13:00", "16:00") == "14:30"
        assert parse_offered_time("how about 8 am", "07:00", "10:00") == "08:00"
        assert parse_offered_time("how about 1 pm", "07:00", "16:00") == "13:00"
        assert parse_offered_time("no numbers here", "07:00", "10:00") is None

    def test_parse_price(self):
        assert parse_price("that's $86 per player") == 86.0
        assert parse_price("$92.50 each") == 92.5
        assert parse_price("free!") is None


# ─── IVR heuristics ────────────────────────────────────────────────────────────


class TestIvr:
    def test_detect_press_n_for_x(self):
        menu = ivr.detect_menu("Press 1 for the grill. Press 2 for the pro shop.")
        assert menu is not None
        assert ivr.choose_option(menu) == "2"

    def test_detect_for_x_press_n(self):
        menu = ivr.detect_menu("For tee times and reservations, press 3.")
        assert menu is not None
        assert ivr.choose_option(menu) == "3"

    def test_front_desk_is_a_fallback(self):
        menu = ivr.detect_menu("For the front desk, press 0.")
        assert menu is not None
        assert ivr.choose_option(menu) == "0"

    def test_no_matching_option_returns_none(self):
        menu = ivr.detect_menu("For the grill, press 1. For events, press 3.")
        assert menu is not None
        assert ivr.choose_option(menu) is None

    def test_speech_only_menu_detected_without_digits(self):
        menu = ivr.detect_menu("To make a reservation, say 'pro shop'.")
        assert menu is not None
        assert menu.options == []
        assert ivr.choose_option(menu) is None

    def test_human_greeting_is_not_a_menu(self):
        assert ivr.detect_menu("Good morning, golf shop, this is Danny.") is None


# ─── Compliance gates ──────────────────────────────────────────────────────────


class TestCompliance:
    def test_audio_is_never_stored(self):
        assert compliance.STORE_AUDIO is False

    def test_disclosure_line_names_golfer_and_callback(self):
        ctx = default_context()
        line = compliance.disclosure_line(ctx)
        assert "automated AI assistant" in line
        assert ctx.golfer_name in line
        assert ctx.callback_number in line
        assert "may be recorded" in line

    def test_calling_hours_boundaries(self):
        tz = "America/Los_Angeles"
        def at(h, m):
            return datetime(2026, 7, 11, h, m, tzinfo=LA)
        assert compliance.within_calling_hours(tz, at(7, 59)) is False
        assert compliance.within_calling_hours(tz, at(8, 0)) is True
        assert compliance.within_calling_hours(tz, at(20, 59)) is True
        assert compliance.within_calling_hours(tz, at(21, 0)) is False

    def test_unknown_timezone_fails_closed(self):
        assert compliance.within_calling_hours("Not/AZone", NOON) is False

    def test_normalize_phone(self):
        assert compliance.normalize_phone("+1 (415) 555-0132") == "+14155550132"
        assert compliance.normalize_phone("415-555-0132") == "+14155550132"
        assert compliance.normalize_phone("12") is None
        assert compliance.normalize_phone("") is None
        assert compliance.normalize_phone(None) is None

    def test_verified_business_line_is_an_allowlist(self):
        verified = {"+1 (415) 555-0132"}
        assert compliance.is_verified_business_line("415-555-0132", verified) is True
        # A cell-looking / unverified number is REFUSED — no heuristic dialing.
        assert compliance.is_verified_business_line("+1 917 555 0001", verified) is False
        assert compliance.is_verified_business_line("garbage", verified) is False
        assert compliance.is_verified_business_line(None, verified) is False
        assert compliance.is_verified_business_line("415-555-0132", set()) is False

    def test_suppression_list(self):
        sup = compliance.SuppressionList({"+1 415 555 0132"})
        assert sup.is_suppressed("(415) 555-0132") is True
        assert sup.is_suppressed("+1 415 555 9999") is False
        sup.add("415-555-9999")
        assert sup.is_suppressed("+14155559999") is True

    def test_check_call_allowed_gates(self):
        ctx = default_context()
        verified = {ctx.phone}
        ok = compliance.check_call_allowed(
            ctx, verified_lines=verified,
            suppression=compliance.SuppressionList(), now=NOON,
        )
        assert ok.allowed is True and ok.reason is None

        # Unverified number → blocked.
        blocked = compliance.check_call_allowed(
            ctx, verified_lines=set(),
            suppression=compliance.SuppressionList(), now=NOON,
        )
        assert blocked.allowed is False and "landline" in blocked.reason

        # Suppressed → blocked.
        blocked = compliance.check_call_allowed(
            ctx, verified_lines=verified,
            suppression=compliance.SuppressionList({ctx.phone}), now=NOON,
        )
        assert blocked.allowed is False and "suppression" in blocked.reason

        # Out of hours → blocked.
        late = datetime(2026, 7, 11, 22, 0, tzinfo=LA)
        blocked = compliance.check_call_allowed(
            ctx, verified_lines=verified,
            suppression=compliance.SuppressionList(), now=late,
        )
        assert blocked.allowed is False and "calling hours" in blocked.reason

        # No callback number → blocked (disclosure requires one).
        ctx2 = default_context()
        ctx2.callback_number = ""
        blocked = compliance.check_call_allowed(
            ctx2, verified_lines=verified,
            suppression=compliance.SuppressionList(), now=NOON,
        )
        assert blocked.allowed is False and "callback" in blocked.reason

        # No phone at all → blocked.
        ctx3 = default_context()
        ctx3.phone = None
        blocked = compliance.check_call_allowed(
            ctx3, verified_lines=verified,
            suppression=compliance.SuppressionList(), now=NOON,
        )
        assert blocked.allowed is False and "no phone number" in blocked.reason


# ─── Outcome → BookingResult mapping ───────────────────────────────────────────


class TestOutcomeMapping:
    def test_booked_maps_to_confirmed(self):
        ctx = default_context()
        outcome = CallOutcome(
            result="booked", date=ctx.date, time="07:40", party_size=4,
            confirmation_number="PG7402", cost_usd=86.0,
        )
        result = to_booking_result(outcome, ctx)
        assert result.status == "confirmed"
        assert result.confirmation_number == "PG7402"
        assert "07:40" in result.message and "$86.00" in result.message

    def test_no_availability_maps_to_failed(self):
        result = to_booking_result(
            CallOutcome(result="no_availability"), default_context()
        )
        assert result.status == "failed"
        assert "nothing was booked" in result.message

    @pytest.mark.parametrize(
        "call_result", ["voicemail", "no_answer", "card_required", "unclear"]
    )
    def test_unresolved_calls_map_to_needs_human(self, call_result):
        ctx = default_context()
        result = to_booking_result(CallOutcome(result=call_result), ctx)
        assert result.status == "needs_human"
        assert ctx.course_name in result.message

    def test_every_mapping_stays_in_stable_status_set(self):
        for call_result in (
            "booked", "no_availability", "voicemail", "no_answer",
            "card_required", "unclear",
        ):
            result = to_booking_result(CallOutcome(result=call_result), default_context())
            assert result.status in STABLE_STATUSES


# ─── VoiceCallProvider contract ────────────────────────────────────────────────

_VERIFIED = {"+1 415-555-0132"}


def _slot(time: str = "07:00") -> TeeTimeSlot:
    return TeeTimeSlot(
        id=f"presidio-2026-07-11-{time}-0",
        course_id="presidio",
        course_name="Presidio Golf Course",
        city="San Francisco, CA",
        date="2026-07-11",
        time=time,
        players=4,
        price_usd=None,
        cart_included=False,
        distance_miles=0.0,
        rating=4.3,
        provider="voice_call",
        holes=18,
    )


_DETAILS = BookingDetails(name="Justin", party_size=4, phone="+1 415-555-0199")


async def _lookup_ok(_name, _area=None):
    return "+1 415-555-0132"


async def _lookup_none(_name, _area=None):
    return None


def _provider(**overrides) -> VoiceCallProvider:
    kwargs = dict(
        transport=SimulatedCallTransport("friendly"),
        phone_lookup=_lookup_ok,
        verified_lines=set(_VERIFIED),
        suppression=compliance.SuppressionList(),
        now=NOON,
    )
    kwargs.update(overrides)
    return VoiceCallProvider(**kwargs)


class TestVoiceCallProvider:
    async def test_search_availability_is_not_supported(self):
        from app.services.tee_times.base import TeeTimeQuery
        provider = _provider()
        query = TeeTimeQuery(
            date="2026-07-11", time_window_start="07:00",
            time_window_end="10:00", party_size=4,
        )
        assert await provider.search_availability(query) == []

    async def test_book_happy_path_via_simulated_transport(self):
        result = await _provider().book(_slot(), _DETAILS)
        assert result.status == "confirmed"
        assert result.confirmation_number == "PG7402"

    async def test_book_blocked_without_verified_landline(self):
        result = await _provider(verified_lines=set()).book(_slot(), _DETAILS)
        assert result.status == "needs_human"
        assert "landline" in result.message

    async def test_book_blocked_out_of_hours(self):
        late = datetime(2026, 7, 11, 22, 30, tzinfo=LA)
        result = await _provider(now=late).book(_slot(), _DETAILS)
        assert result.status == "needs_human"
        assert "calling hours" in result.message

    async def test_book_blocked_when_no_phone_found(self):
        result = await _provider(phone_lookup=_lookup_none).book(_slot(), _DETAILS)
        assert result.status == "needs_human"
        assert "no phone number" in result.message

    async def test_book_respects_suppression_list(self):
        suppression = compliance.SuppressionList({"+1 415-555-0132"})
        result = await _provider(suppression=suppression).book(_slot(), _DETAILS)
        assert result.status == "needs_human"
        assert "suppression" in result.message

    async def test_opt_out_outcome_adds_number_to_suppression(self):
        class OptOutTransport:
            async def run_call(self, _ctx):
                return [], CallOutcome(
                    result="unclear",
                    detail="shop asked not to be called again",
                    opt_out_requested=True,
                )

        suppression = compliance.SuppressionList()
        provider = _provider(transport=OptOutTransport(), suppression=suppression)
        first = await provider.book(_slot(), _DETAILS)
        assert first.status == "needs_human"
        assert suppression.is_suppressed("+1 415-555-0132") is True
        # The very next attempt is blocked BEFORE any call.
        second = await provider.book(_slot(), _DETAILS)
        assert "suppression" in second.message

    async def test_no_transport_and_disabled_env_never_crashes(self, monkeypatch):
        monkeypatch.delenv("VOICE_BOOKING_ENABLED", raising=False)
        result = await _provider(transport=None).book(_slot(), _DETAILS)
        assert result.status == "needs_human"
        assert "voice booking disabled" in result.message

    async def test_all_persona_transports_stay_in_stable_statuses(self):
        for persona in PERSONA_NAMES:
            provider = _provider(transport=SimulatedCallTransport(persona))
            result = await provider.book(_slot(), _DETAILS)
            assert result.status in STABLE_STATUSES, (persona, result.status)

    def test_window_end_helper(self):
        assert _window_end("07:00") == "09:00"
        assert _window_end("22:30") == "23:59"


# ─── Telephony stays a stub ────────────────────────────────────────────────────


class TestTelephonyStub:
    def test_disabled_by_default(self, monkeypatch):
        monkeypatch.delenv("VOICE_BOOKING_ENABLED", raising=False)
        with pytest.raises(RuntimeError, match="voice booking disabled"):
            telephony.get_live_transport()

    def test_enabled_but_missing_creds(self, monkeypatch):
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        for var in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"):
            monkeypatch.delenv(var, raising=False)
        with pytest.raises(RuntimeError, match="missing credentials"):
            telephony.get_live_transport()

    def test_enabled_with_creds_is_still_not_implemented(self, monkeypatch):
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC-test")
        monkeypatch.setenv("TWILIO_AUTH_TOKEN", "tok-test")
        monkeypatch.setenv("TWILIO_FROM_NUMBER", "+14155550100")
        with pytest.raises(NotImplementedError, match="owner-gated"):
            telephony.get_live_transport()
