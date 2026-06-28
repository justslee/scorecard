"""Pure-logic tests for the conversational (agentic) round-setup helpers.

No API key / DB needed — these cover the merge + missing-field + follow-up-question
logic that lets the caddie ask for what's missing instead of dead-ending.
"""

from app.routes.voice_advanced import (
    RoundSetupResponse,
    RoundSetupState,
    _finalize_round_setup,
    _local_parse_round_setup,
    merge_round_setup,
    round_setup_missing,
    round_setup_question,
)


class TestMissingAndQuestion:
    def test_nothing_known_misses_course_then_players(self):
        assert round_setup_missing("", []) == ["course", "players"]

    def test_course_only_still_needs_players(self):
        assert round_setup_missing("Pebble Beach", []) == ["players"]

    def test_players_only_still_needs_course(self):
        assert round_setup_missing("", ["Dan"]) == ["course"]

    def test_complete_when_course_and_a_player(self):
        assert round_setup_missing("Pebble Beach", ["Dan"]) == []

    def test_blank_names_do_not_count_as_players(self):
        assert "players" in round_setup_missing("Pebble Beach", ["", "  "])

    def test_question_asks_for_course_first(self):
        assert round_setup_question(["course", "players"]) == "Which course today?"

    def test_question_asks_players_when_only_players_missing(self):
        assert round_setup_question(["players"]) == "Who's playing today?"

    def test_no_question_when_complete(self):
        assert round_setup_question([]) is None


class TestMerge:
    def test_no_current_returns_parsed(self):
        parsed = RoundSetupResponse(courseName="Pebble", playerNames=["Dan"])
        assert merge_round_setup(None, parsed) is parsed

    def test_new_course_fills_gap_without_wiping_players(self):
        current = RoundSetupState(playerNames=["Dan", "Matt"])
        parsed = RoundSetupResponse(courseName="Pebble Beach")
        merged = merge_round_setup(current, parsed)
        assert merged.courseName == "Pebble Beach"
        assert merged.playerNames == ["Dan", "Matt"]

    def test_players_union_is_order_preserving_and_deduped(self):
        current = RoundSetupState(courseName="Pebble", playerNames=["Dan"])
        parsed = RoundSetupResponse(playerNames=["Dan", "Matt"])
        merged = merge_round_setup(current, parsed)
        assert merged.playerNames == ["Dan", "Matt"]

    def test_keeps_prior_course_when_new_turn_has_none(self):
        current = RoundSetupState(courseName="Pebble")
        parsed = RoundSetupResponse(playerNames=["Dan"])
        merged = merge_round_setup(current, parsed)
        assert merged.courseName == "Pebble"


class TestFinalize:
    def test_finalize_attaches_status_and_question(self):
        parsed = RoundSetupResponse(playerNames=["Dan"])  # course missing
        out = _finalize_round_setup(parsed, None)
        assert out.missing == ["course"]
        assert out.complete is False
        assert out.followUpQuestion == "Which course today?"

    def test_finalize_complete_clears_question(self):
        parsed = RoundSetupResponse(courseName="Pebble", playerNames=["Dan"])
        out = _finalize_round_setup(parsed, None)
        assert out.complete is True
        assert out.followUpQuestion is None
        assert out.missing == []

    def test_conversational_two_turns_reach_complete(self):
        # Turn 1: only players heard → asks for course.
        t1 = _finalize_round_setup(RoundSetupResponse(playerNames=["Dan", "Matt"]), None)
        assert t1.followUpQuestion == "Which course today?"
        # Turn 2: the bare answer "Pebble Beach" while expecting course.
        parsed2 = _local_parse_round_setup("Pebble Beach", expecting="course")
        t2 = _finalize_round_setup(
            parsed2,
            RoundSetupState(courseName=t1.courseName, playerNames=t1.playerNames),
        )
        assert t2.courseName == "Pebble Beach"
        assert t2.playerNames == ["Dan", "Matt"]
        assert t2.complete is True


class TestLocalParseExpecting:
    def test_bare_course_answer_is_taken_as_course(self):
        out = _local_parse_round_setup("Torrey Pines", expecting="course")
        assert out.courseName == "Torrey Pines"

    def test_bare_players_answer_is_split_into_names(self):
        out = _local_parse_round_setup("Dan and Matt", expecting="players")
        assert out.playerNames == ["Dan", "Matt"]

    def test_without_expecting_bare_text_is_not_forced(self):
        # No cue and no expecting → don't invent a course from arbitrary words.
        out = _local_parse_round_setup("just testing")
        assert out.courseName == ""
