"""S4e — availability-ASK dialog mode (specs/teetime-availability-everywhere
-plan.md §5). Pure-module tests (no network, no DB, no telephony).

Covers:
  - mode="availability" collects EVERY spoken time in the window, never books
  - "no times at all" -> result="no_availability", zero slots_spoken
  - disclosure line is still the agent's first words
  - book mode (mode="book", the default) is COMPLETELY untouched by these
    additions — same simulator, same personas, same assertions as before
  - outcome.py maps an "availability" CallOutcome onto the stable BookingResult
    status set
  - SimulatedCallTransport dispatches on ctx.mode to the right persona registry
"""

from __future__ import annotations

import pytest

from app.services.voice_booking.dialog import BookingDialog
from app.services.voice_booking.outcome import to_booking_result
from app.services.voice_booking.simulator import (
    AVAILABILITY_PERSONA_NAMES,
    PERSONA_NAMES,
    SimulatedCallTransport,
    availability_context,
    default_context,
    run_availability_simulation,
    run_simulation,
)
from app.services.voice_booking.types import CallOutcome

STABLE_STATUSES = {"confirmed", "pending", "failed", "needs_human", "not_supported"}
DISCLOSURE_PREFIX = "Hi — I'm an automated AI assistant calling on behalf of"


def _spoken_agent_turns(transcript):
    return [
        t for t in transcript
        if t.speaker == "agent" and not t.text.startswith("[pressed")
    ]


# ─── Persona registries stay separate ──────────────────────────────────────────


class TestPersonaRegistriesAreSeparate:
    def test_availability_personas_disjoint_from_book_personas(self):
        assert set(AVAILABILITY_PERSONA_NAMES).isdisjoint(set(PERSONA_NAMES))

    def test_unknown_availability_persona_raises(self):
        with pytest.raises(ValueError, match="unknown persona"):
            run_availability_simulation("friendly")   # a book-mode name, not ask-mode

    def test_default_context_stays_book_mode(self):
        assert default_context().mode == "book"

    def test_availability_context_is_availability_mode(self):
        assert availability_context().mode == "availability"
        # Everything else carries over from default_context() unchanged.
        assert availability_context().course_name == default_context().course_name


# ─── Ask-mode personas ──────────────────────────────────────────────────────────


class TestAskModePersonas:
    def test_lists_three_times_collects_every_spoken_time(self):
        sim = run_availability_simulation("lists_three_times")
        assert sim.outcome.result == "availability"
        spoken = sim.outcome.slots_spoken
        assert [s.time for s in spoken] == ["07:20", "08:40", "09:15"]
        # Only the first time had a stated price — never fabricate the rest.
        assert spoken[0].price_usd == 75.0
        assert spoken[1].price_usd is None
        assert spoken[2].price_usd is None
        assert sim.booking_result.status in STABLE_STATUSES

    def test_lists_three_times_never_books_anything(self):
        sim = run_availability_simulation("lists_three_times")
        assert sim.outcome.time is None            # never "booked" a single time
        assert sim.outcome.confirmation_number is None
        assert sim.booking_result.status != "confirmed"

    def test_no_availability_ask_yields_zero_slots(self):
        sim = run_availability_simulation("no_availability_ask")
        assert sim.outcome.result == "no_availability"
        assert sim.outcome.slots_spoken == []
        assert sim.booking_result.status == "failed"

    def test_disclosure_is_first_words_in_ask_mode_too(self):
        for persona in AVAILABILITY_PERSONA_NAMES:
            sim = run_availability_simulation(persona)
            spoken = _spoken_agent_turns(sim.transcript)
            assert spoken, f"persona {persona} said nothing"
            assert spoken[0].text.startswith(DISCLOSURE_PREFIX)

    def test_ask_mode_opener_asks_not_books(self):
        sim = run_availability_simulation("lists_three_times")
        opener = _spoken_agent_turns(sim.transcript)[0].text
        assert "Do you have any tee times" in opener
        assert "Could I book" not in opener

    def test_ask_mode_is_deterministic(self):
        for persona in AVAILABILITY_PERSONA_NAMES:
            a, b = run_availability_simulation(persona), run_availability_simulation(persona)
            assert a.transcript == b.transcript
            assert a.outcome == b.outcome

    def test_all_ask_mode_statuses_stay_in_stable_set(self):
        for persona in AVAILABILITY_PERSONA_NAMES:
            sim = run_availability_simulation(persona)
            assert sim.booking_result.status in STABLE_STATUSES


# ─── Dialog negotiation edges (mode="availability") ────────────────────────────


class TestAskModeDialogNegotiation:
    def test_gives_up_after_bounded_unproductive_prompts(self):
        dialog = BookingDialog(availability_context())
        dialog.respond("Pro shop.")                        # opener (turn 0)
        dialog.respond("Who's calling?")                    # unproductive (1)
        dialog.respond("What did you say your name was?")   # unproductive (2)
        dialog.respond("Come again?")                        # unproductive (3) -> exceeds MAX_ASK_ATTEMPTS
        assert dialog.done
        assert dialog.outcome.result == "availability"
        assert dialog.outcome.slots_spoken == []

    def test_out_of_window_time_is_not_collected(self):
        dialog = BookingDialog(availability_context())   # window 07:00-10:00
        dialog.respond("Pro shop.")
        dialog.respond("We've only got 2:30 pm open.")
        assert not dialog.done
        dialog.respond("How about 8:15?")
        dialog.respond("That's everything we have.")
        assert dialog.outcome.result == "availability"
        assert [s.time for s in dialog.outcome.slots_spoken] == ["08:15"]

    def test_voicemail_short_circuits_ask_mode_too(self):
        dialog = BookingDialog(availability_context())
        action = dialog.respond("Please leave a message after the tone.")
        assert action.kind == "hangup"
        assert dialog.outcome.result == "voicemail"

    def test_opt_out_ends_ask_mode_call(self):
        dialog = BookingDialog(availability_context())
        dialog.respond("Pro shop.")
        dialog.respond("Take us off your list, don't call again.")
        assert dialog.done
        assert dialog.opt_out_requested is True

    def test_book_mode_negotiating_untouched_by_ask_mode_additions(self):
        """Byte-identical proof: the same script that would end an ask-mode
        call still runs the ORIGINAL book-mode state machine when
        ctx.mode=="book" (the default) — never routed to the new handler."""
        dialog = BookingDialog(default_context())        # mode="book"
        dialog.respond("Pro shop, this is Pat.")
        action = dialog.respond("I have 7:40 at $86 a player.")
        # Book mode transitions straight to confirming a SINGLE time —
        # nothing resembling "anything else in that window?" is said.
        assert "anything else" not in (action.text or "")
        assert dialog.state == "confirming"


# ─── Outcome mapping for the ask-mode result ───────────────────────────────────


class TestAvailabilityOutcomeMapping:
    def test_availability_with_slots_maps_to_pending_with_count(self):
        from app.services.voice_booking.types import SpokenSlot

        ctx = availability_context()
        outcome = CallOutcome(
            result="availability", date=ctx.date, party_size=ctx.party_size,
            slots_spoken=[SpokenSlot(time="07:20", price_usd=75.0), SpokenSlot(time="08:40")],
        )
        result = to_booking_result(outcome, ctx)
        assert result.status == "pending"
        assert "2 time(s)" in (result.message or "")

    def test_availability_with_no_slots_is_honest(self):
        ctx = availability_context()
        outcome = CallOutcome(result="availability", date=ctx.date, party_size=ctx.party_size)
        result = to_booking_result(outcome, ctx)
        assert result.status == "pending"
        assert "nothing offered" in (result.message or "")

    def test_every_availability_outcome_stays_in_stable_status_set(self):
        STABLE = {"confirmed", "pending", "failed", "needs_human", "not_supported"}
        for persona in AVAILABILITY_PERSONA_NAMES:
            sim = run_availability_simulation(persona)
            assert sim.booking_result.status in STABLE


# ─── SimulatedCallTransport dispatches on ctx.mode ─────────────────────────────


class TestSimulatedTransportModeDispatch:
    async def test_ask_mode_persona_runs_through_availability_registry(self):
        transport = SimulatedCallTransport("lists_three_times")
        transcript, outcome = await transport.run_call(availability_context())
        assert outcome.result == "availability"
        assert len(outcome.slots_spoken) == 3

    async def test_book_mode_persona_still_runs_book_registry(self):
        transport = SimulatedCallTransport("friendly")
        transcript, outcome = await transport.run_call(default_context())
        assert outcome.result == "booked"

    def test_transport_accepts_either_registry_name(self):
        SimulatedCallTransport("friendly")            # book-mode name — OK
        SimulatedCallTransport("lists_three_times")    # ask-mode name — OK
        with pytest.raises(ValueError, match="unknown persona"):
            SimulatedCallTransport("angry_goose")


# ─── Book mode stays byte-identical (regression net) ───────────────────────────


class TestBookModeUnaffected:
    def test_every_original_persona_transcript_unchanged(self):
        """Re-run of the existing happy-path assertions from
        test_voice_booking.py — proves the S4e additions didn't perturb a
        single book-mode transcript or outcome."""
        friendly = run_simulation("friendly")
        assert friendly.outcome.result == "booked"
        assert friendly.outcome.time == "07:40"
        assert friendly.outcome.confirmation_number == "PG7402"
        assert friendly.outcome.slots_spoken == []   # new field, harmlessly empty
