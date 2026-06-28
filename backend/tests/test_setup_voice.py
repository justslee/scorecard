"""Tests for the conversational round-setup tool + instructions (pure, no OpenAI)."""

from app.caddie.setup_voice import (
    SET_ROUND_SETUP_TOOL,
    SETUP_TOOLS,
    build_setup_instructions,
)


class TestSetRoundSetupTool:
    def test_is_a_well_formed_function_tool(self):
        assert SET_ROUND_SETUP_TOOL["type"] == "function"
        assert SET_ROUND_SETUP_TOOL["name"] == "set_round_setup"
        assert SET_ROUND_SETUP_TOOL in SETUP_TOOLS

    def test_requires_course_and_players(self):
        params = SET_ROUND_SETUP_TOOL["parameters"]
        assert set(params["required"]) == {"courseName", "players"}
        assert params["properties"]["courseName"]["type"] == "string"
        assert params["properties"]["players"]["type"] == "array"

    def test_players_support_per_player_tee(self):
        item = SET_ROUND_SETUP_TOOL["parameters"]["properties"]["players"]["items"]
        assert item["properties"]["name"]["type"] == "string"
        assert "tee" in item["properties"]  # per-player tee groups
        assert item["required"] == ["name"]  # tee optional

    def test_has_optional_default_tee_and_game(self):
        props = SET_ROUND_SETUP_TOOL["parameters"]["properties"]
        assert "teeName" in props
        assert "gameFormat" in props
        assert "holes" in props


class TestSetupInstructions:
    def test_mentions_the_tool_and_the_fields_to_collect(self):
        text = build_setup_instructions().lower()
        assert "set_round_setup" in text
        assert "course" in text
        assert "tee" in text
        # Must steer toward asking for what's missing, one thing at a time.
        assert "one" in text and "missing" in text

    def test_is_nonempty_and_concise_guidance(self):
        text = build_setup_instructions()
        assert len(text) > 200
