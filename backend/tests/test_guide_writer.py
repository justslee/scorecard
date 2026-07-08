"""Unit tests for app/caddie/guide_writer.py — Slice 1 (format_guide_line only).

No network, no database. `HoleStrategyGuide` and `format_guide_line` have zero
DB imports (guide_writer.py depends only on app.caddie.types), so these run
with no env mocking required — same idiom as test_hazards.py.

Slice 1 scope: the guide is ALWAYS absent at runtime (no writer runs yet), so
these tests cover the pure renderer's contract directly: a populated guide
renders a compact single line; None/empty -> "" (omit, never a placeholder).
"""

from app.caddie.guide_writer import format_guide_line
from app.caddie.types import HoleStrategyGuide


def test_populated_guide_renders_compact_line_containing_play_line():
    guide = HoleStrategyGuide(
        play_line="Favor the left half of the fairway off the tee.",
        miss_side="Best miss is short-right; never long.",
        green_notes="Green runs back-to-front with a false front.",
        common_mistakes=["Overclubbing the approach", "Missing long", "Short-siding left"],
        sources=["https://example.com/hole-7"],
        generated_at="2026-07-08T00:00:00Z",
        model="claude-sonnet-5",
        schema_version=1,
    )
    line = format_guide_line(guide)

    assert line != ""
    assert "Favor the left half of the fairway off the tee." in line
    assert line.startswith("Local knowledge: ")
    # Single line — no embedded newlines (spoken-style prompt injection).
    assert "\n" not in line


def test_none_guide_returns_empty_string():
    assert format_guide_line(None) == ""


def test_all_empty_guide_returns_empty_string():
    guide = HoleStrategyGuide()
    assert format_guide_line(guide) == ""


def test_whitespace_only_fields_treated_as_empty():
    guide = HoleStrategyGuide(play_line="   ", miss_side="", green_notes="\t")
    assert format_guide_line(guide) == ""


def test_common_mistakes_capped_at_three():
    guide = HoleStrategyGuide(
        play_line="Aim center.",
        common_mistakes=["one", "two", "three", "four", "five"],
    )
    line = format_guide_line(guide)
    assert "one" in line and "two" in line and "three" in line
    assert "four" not in line and "five" not in line


def test_output_is_single_line_and_scaffolding_has_no_imperative_meta_instructions():
    """format_guide_line is REFERENCE DATA only — its OWN scaffolding (the
    literal text it adds beyond the guide's content fields) must never carry
    imperative/meta instructions like "you must", "ignore", "instructions:"
    (owner's prompt-injection posture, plan §9). The content fields themselves
    are arbitrary future-writer prose and are not this test's concern."""
    guide = HoleStrategyGuide(
        play_line="Favor the left half of the fairway off the tee.",
        miss_side="Best miss is short-right.",
        green_notes="Green runs back-to-front with a false front.",
        common_mistakes=["Overclubbing the approach"],
    )
    line = format_guide_line(guide)
    assert "\n" not in line

    # Scaffolding = the rendered line minus the guide's own content fields.
    scaffolding = line
    for field in (guide.play_line, guide.miss_side, guide.green_notes, *guide.common_mistakes):
        scaffolding = scaffolding.replace(field, "")
    forbidden = ("you must", "ignore", "instructions:", "system:", "always", "never")
    lowered = scaffolding.lower()
    for phrase in forbidden:
        assert phrase not in lowered


def test_degenerate_guide_with_only_empty_list_fields_returns_empty_string():
    guide = HoleStrategyGuide(common_mistakes=[], sources=["https://example.com"])
    assert format_guide_line(guide) == ""
