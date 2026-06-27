"""Unit tests for _safe_json_extract in routes/voice_advanced.py — pure string function."""

from app.routes.voice_advanced import _safe_json_extract


class TestSafeJsonExtract:
    """Extracts valid JSON substring from LLM output; handles various wrapper formats."""

    # ── Happy paths ───────────────────────────────────────────────────────────

    def test_clean_json_object(self):
        text = '{"key": "value", "num": 42}'
        result = _safe_json_extract(text)
        assert result == '{"key": "value", "num": 42}'

    def test_json_in_fenced_block_json_lang(self):
        text = '```json\n{"name": "test"}\n```'
        result = _safe_json_extract(text)
        assert result == '{"name": "test"}'

    def test_json_in_fenced_block_no_lang(self):
        text = '```\n{"name": "test"}\n```'
        result = _safe_json_extract(text)
        assert result == '{"name": "test"}'

    def test_json_wrapped_in_prose(self):
        text = 'Here is the JSON you requested: {"courseName": "Augusta", "players": ["Justin"]} - that should help.'
        result = _safe_json_extract(text)
        assert result == '{"courseName": "Augusta", "players": ["Justin"]}'

    def test_json_after_newlines(self):
        text = "Sure, here's the result:\n\n{\"score\": 72}\n\nLet me know if you need more."
        result = _safe_json_extract(text)
        assert result == '{"score": 72}'

    def test_nested_json_object(self):
        text = '{"outer": {"inner": "value"}, "list": [1, 2, 3]}'
        result = _safe_json_extract(text)
        assert result == '{"outer": {"inner": "value"}, "list": [1, 2, 3]}'

    def test_json_with_escaped_quotes(self):
        text = '{"message": "He said \\"hello\\""}'
        result = _safe_json_extract(text)
        assert result == '{"message": "He said \\"hello\\""}'

    def test_fenced_block_with_whitespace(self):
        text = '```json\n  { "a": 1 }  \n```'
        result = _safe_json_extract(text)
        assert result == '{ "a": 1 }'

    def test_markdown_prose_then_fenced_json(self):
        text = (
            "I'll extract the data for you.\n\n"
            "```json\n"
            '{"players": ["Alice", "Bob"], "course": "Pine Valley"}\n'
            "```\n\n"
            "Let me know if you need anything else."
        )
        result = _safe_json_extract(text)
        assert result == '{"players": ["Alice", "Bob"], "course": "Pine Valley"}'

    # ── Edge / no-JSON cases ──────────────────────────────────────────────────

    def test_no_json_returns_none(self):
        assert _safe_json_extract("No JSON here at all.") is None

    def test_empty_string_returns_none(self):
        assert _safe_json_extract("") is None

    def test_unclosed_brace_returns_none(self):
        # Depth never reaches 0 → falls off the end → None
        assert _safe_json_extract('{"unclosed": "object"') is None

    def test_only_open_brace_returns_none(self):
        assert _safe_json_extract("{") is None

    def test_fenced_block_with_non_json_content_falls_back_to_bare(self):
        # Fenced block content doesn't start with { or [ → fall through to bare extraction
        text = "```\nsome plain text\n```\n{\"key\": \"value\"}"
        result = _safe_json_extract(text)
        # The fenced group doesn't qualify (no { start) → bare extraction finds {"key":"value"}
        assert result == '{"key": "value"}'

    def test_array_in_fenced_block(self):
        # Arrays starting with [ should also be extracted from fenced blocks
        text = "```json\n[1, 2, 3]\n```"
        result = _safe_json_extract(text)
        assert result == "[1, 2, 3]"

    def test_multiple_json_objects_returns_first(self):
        # Bare extraction finds the first { and balances from there
        text = '{"first": 1} {"second": 2}'
        result = _safe_json_extract(text)
        assert result == '{"first": 1}'

    def test_malformed_fenced_valid_bare(self):
        # Fenced block has valid JSON but extraction should still work
        text = "```json\n{\"valid\": true}\n```"
        result = _safe_json_extract(text)
        assert result == '{"valid": true}'

    def test_real_llm_round_setup_output(self):
        text = (
            'Based on the transcript, here is the extracted data:\n\n'
            '```json\n'
            '{\n'
            '  "courseName": "Pebble Beach",\n'
            '  "playerNames": ["Justin", "Dan"],\n'
            '  "teeName": "blue"\n'
            '}\n'
            '```'
        )
        result = _safe_json_extract(text)
        import json
        obj = json.loads(result)
        assert obj["courseName"] == "Pebble Beach"
        assert obj["playerNames"] == ["Justin", "Dan"]
        assert obj["teeName"] == "blue"
