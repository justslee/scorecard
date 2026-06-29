"""Unit tests for _parse_scan_response and _extract_text_content in routes/scorecard.py.

Pure function tests — no live Anthropic API, no image upload, no DB required.
Verifies the parser that turns a Claude vision response string into a
ScanScorecardResponse, and the content-block text extractor that handles
non-text (e.g. thinking) blocks.
"""

import json
import types

import pytest

from app.routes.scorecard import (
    HoleScores,
    ScanScorecardResponse,
    _extract_text_content,
    _parse_scan_response,
)


class TestParseScanResponseHappyPaths:
    """Well-formed inputs the parser must accept and structure correctly."""

    def test_minimal_single_hole_single_player(self):
        text = '{"players": ["Alice"], "holes": [{"number": 1, "par": 4, "scores": {"Alice": 5}}]}'
        result = _parse_scan_response(text)
        assert isinstance(result, ScanScorecardResponse)
        assert result.players == ["Alice"]
        assert len(result.holes) == 1
        assert result.holes[0].number == 1
        assert result.holes[0].par == 4
        assert result.holes[0].scores == {"Alice": 5}

    def test_two_players_two_holes(self):
        text = json.dumps(
            {
                "players": ["Alice", "Bob"],
                "holes": [
                    {"number": 1, "par": 4, "scores": {"Alice": 5, "Bob": 4}},
                    {"number": 2, "par": 3, "scores": {"Alice": 3, "Bob": 3}},
                ],
            }
        )
        result = _parse_scan_response(text)
        assert result.players == ["Alice", "Bob"]
        assert result.holes[1].number == 2
        assert result.holes[1].scores["Bob"] == 3

    def test_null_score_cell_preserved_as_none(self):
        """Blank or unreadable cells must survive the round-trip as Python None."""
        text = json.dumps(
            {
                "players": ["Alice"],
                "holes": [{"number": 1, "par": 4, "scores": {"Alice": None}}],
            }
        )
        result = _parse_scan_response(text)
        assert result.holes[0].scores["Alice"] is None

    def test_null_par_preserved_as_none(self):
        """Par is optional — null when not printed on the card."""
        text = json.dumps(
            {
                "players": ["Alice"],
                "holes": [{"number": 1, "par": None, "scores": {"Alice": 5}}],
            }
        )
        result = _parse_scan_response(text)
        assert result.holes[0].par is None

    def test_extra_prose_around_json_is_stripped(self):
        """Model sometimes leaks preamble/postamble — the regex must strip it."""
        text = (
            "Here is the extracted scorecard from the image:\n\n"
            + json.dumps(
                {
                    "players": ["Justin"],
                    "holes": [{"number": 1, "par": 4, "scores": {"Justin": 5}}],
                }
            )
            + "\n\nLet me know if you need anything else."
        )
        result = _parse_scan_response(text)
        assert result.players == ["Justin"]
        assert result.holes[0].scores["Justin"] == 5

    def test_four_players_single_hole(self):
        """Four-ball card — common group size."""
        text = json.dumps(
            {
                "players": ["Alice", "Bob", "Charlie", "Dan"],
                "holes": [
                    {
                        "number": 1,
                        "par": 4,
                        "scores": {
                            "Alice": 5,
                            "Bob": 4,
                            "Charlie": 6,
                            "Dan": None,  # Dan's cell was smudged
                        },
                    }
                ],
            }
        )
        result = _parse_scan_response(text)
        assert len(result.players) == 4
        assert result.holes[0].scores["Charlie"] == 6
        assert result.holes[0].scores["Dan"] is None

    def test_18_hole_grid_with_scattered_nulls(self):
        """Full 18-hole card; every third hole has a null score."""
        holes = [
            {
                "number": i,
                "par": 4,
                "scores": {"A": (i * 2) if i % 3 != 0 else None},
            }
            for i in range(1, 19)
        ]
        text = json.dumps({"players": ["A"], "holes": holes})
        result = _parse_scan_response(text)
        assert len(result.holes) == 18
        # Holes 3, 6, 9, … should be null
        assert result.holes[2].scores["A"] is None  # hole 3
        assert result.holes[5].scores["A"] is None  # hole 6
        assert result.holes[8].scores["A"] is None  # hole 9
        # Hole 1 should be non-null
        assert result.holes[0].scores["A"] == 2

    def test_mixed_null_and_integer_scores_across_players(self):
        """Spot-check that null cells for one player don't affect another's value."""
        text = json.dumps(
            {
                "players": ["P1", "P2"],
                "holes": [
                    {"number": 5, "par": 5, "scores": {"P1": None, "P2": 6}},
                    {"number": 6, "par": 3, "scores": {"P1": 3, "P2": None}},
                ],
            }
        )
        result = _parse_scan_response(text)
        assert result.holes[0].scores["P1"] is None
        assert result.holes[0].scores["P2"] == 6
        assert result.holes[1].scores["P1"] == 3
        assert result.holes[1].scores["P2"] is None

    def test_empty_holes_list_is_valid(self):
        """An edge case: scorecard photo where no holes are readable."""
        text = json.dumps({"players": ["Alice"], "holes": []})
        result = _parse_scan_response(text)
        assert result.players == ["Alice"]
        assert result.holes == []

    def test_returns_correct_pydantic_types(self):
        """Ensure the returned object is the right Pydantic model instances."""
        text = json.dumps(
            {
                "players": ["X"],
                "holes": [{"number": 1, "par": 4, "scores": {"X": 4}}],
            }
        )
        result = _parse_scan_response(text)
        assert isinstance(result, ScanScorecardResponse)
        assert isinstance(result.holes[0], HoleScores)


class TestParseScanResponseErrorPaths:
    """Inputs that must raise ValueError with informative messages."""

    def test_no_json_raises_value_error(self):
        with pytest.raises(ValueError, match="No JSON object found"):
            _parse_scan_response("I cannot read this scorecard.")

    def test_empty_string_raises_value_error(self):
        with pytest.raises(ValueError, match="No JSON object found"):
            _parse_scan_response("")

    def test_only_prose_no_braces_raises_value_error(self):
        with pytest.raises(ValueError, match="No JSON object found"):
            _parse_scan_response("The scorecard shows 4 players across 18 holes.")

    def test_malformed_json_raises_value_error(self):
        # Missing closing brace and misplaced quote
        with pytest.raises(ValueError, match="Malformed JSON"):
            _parse_scan_response('{"players": ["Alice" "holes": []}')

    def test_truncated_json_raises_value_error(self):
        # The input has no closing brace so the greedy `{...}` regex finds nothing.
        # The error is "No JSON object found" (not "Malformed JSON") in this case.
        with pytest.raises(ValueError, match="No JSON object found"):
            _parse_scan_response('{"players": ["Alice"')

    def test_missing_players_key_raises_value_error(self):
        with pytest.raises(ValueError, match="missing 'players' or 'holes'"):
            _parse_scan_response('{"holes": []}')

    def test_missing_holes_key_raises_value_error(self):
        with pytest.raises(ValueError, match="missing 'players' or 'holes'"):
            _parse_scan_response('{"players": ["Alice"]}')

    def test_wrong_json_shape_voice_format_raises_value_error(self):
        """Voice parse response shape must NOT be accepted as a scorecard."""
        with pytest.raises(ValueError, match="missing 'players' or 'holes'"):
            _parse_scan_response('{"hole": 1, "scores": {"Alice": 5}}')

    def test_entirely_wrong_json_raises_value_error(self):
        with pytest.raises(ValueError, match="missing 'players' or 'holes'"):
            _parse_scan_response('{"courseName": "Augusta", "par": 72}')

    # ── FIX 2: shape validation ──────────────────────────────────────────────

    def test_players_is_dict_not_list_raises_value_error(self):
        """Model emits an object instead of a list for 'players'."""
        text = json.dumps(
            {"players": {"0": "Alice"}, "holes": []}
        )
        with pytest.raises(ValueError, match="'players' must be a list"):
            _parse_scan_response(text)

    def test_holes_is_not_a_list_raises_value_error(self):
        """Model emits a non-list value for 'holes'."""
        text = json.dumps(
            {"players": ["Alice"], "holes": "all 18 holes were great"}
        )
        with pytest.raises(ValueError, match="'holes' must be a list"):
            _parse_scan_response(text)

    def test_hole_entry_missing_number_raises_value_error(self):
        """A hole dict that lacks the required 'number' field must be rejected."""
        text = json.dumps(
            {
                "players": ["Alice"],
                "holes": [{"par": 4, "scores": {"Alice": 5}}],
            }
        )
        with pytest.raises(ValueError, match="missing required 'number' field"):
            _parse_scan_response(text)

    def test_hole_entry_is_string_not_dict_raises_value_error(self):
        """A holes list entry that is a plain string must be rejected."""
        text = json.dumps(
            {"players": ["Alice"], "holes": ["hole 1 par 4"]}
        )
        with pytest.raises(ValueError, match="Each hole entry must be a dict"):
            _parse_scan_response(text)


class TestExtractTextContent:
    """Unit tests for _extract_text_content — the content-block helper."""

    @staticmethod
    def _block(type_name: str, text: str | None = None):
        """Build a minimal mock content block using SimpleNamespace."""
        obj = types.SimpleNamespace(type=type_name)
        if text is not None:
            obj.text = text
        return obj

    def test_text_only_block_returns_text(self):
        blocks = [self._block("text", "hello")]
        assert _extract_text_content(blocks) == "hello"

    def test_thinking_block_before_text_block_returns_text(self):
        """When a thinking block precedes the text block, the text block is found."""
        payload = json.dumps(
            {
                "players": ["Alice"],
                "holes": [{"number": 1, "par": 4, "scores": {"Alice": 5}}],
            }
        )
        blocks = [
            self._block("thinking"),   # no .text — simulates extended-thinking
            self._block("text", payload),
        ]
        text = _extract_text_content(blocks)
        # Confirm the extracted text parses successfully end-to-end.
        result = _parse_scan_response(text)
        assert result.players == ["Alice"]
        assert result.holes[0].scores["Alice"] == 5

    def test_multiple_non_text_blocks_then_text(self):
        """Multiple non-text blocks before the text block — still finds text."""
        blocks = [
            self._block("thinking"),
            self._block("tool_use"),
            self._block("text", '{"players": ["Bob"], "holes": []}'),
        ]
        text = _extract_text_content(blocks)
        result = _parse_scan_response(text)
        assert result.players == ["Bob"]

    def test_no_text_block_returns_empty_string(self):
        """No text block → empty string → _parse_scan_response raises ValueError."""
        blocks = [self._block("thinking")]
        result = _extract_text_content(blocks)
        assert result == ""
        # Verify the empty string flows into the clean error path.
        with pytest.raises(ValueError, match="No JSON object found"):
            _parse_scan_response(result)

    def test_empty_content_list_returns_empty_string(self):
        assert _extract_text_content([]) == ""
