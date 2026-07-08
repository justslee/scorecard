"""Per-hole strategy guide: compact renderer for BOTH caddie mouths.

Slice 1 (specs/caddie-hole-strategy-guides-plan.md §12) ships ONLY the
deterministic, offline-testable renderer, `format_guide_line`. It composes an
already-persisted, already-validated `HoleStrategyGuide` (see
`app.caddie.types`) into a single compact DATA line, labeled as reference
local knowledge — never as an instruction. No guide -> "" (the caller omits
the line entirely, same convention as `hazards.format_hazards_line`;
[[no-fake-data-fallbacks]]).

Slice 2 will add the research/writer (`research_hole_guide`, Claude +
web_search) and the grounding validation pass (`validate_guide`) to this same
module. Slice 3 wires the BackgroundTasks precompute. Neither exists yet —
Slice 1 is pure storage-shape + read-through + both-mouth injection, driven by
a guide that is naturally absent because no writer runs yet.

Kept dependency-light on purpose (only imports the `HoleStrategyGuide` type)
so `app.caddie.voice_prompts` can import `format_guide_line` without any risk
of a circular import once the writer (which will need `hazards.py`) lands.
"""

from __future__ import annotations

from typing import Optional

from app.caddie.types import HoleStrategyGuide

_MAX_MISTAKES_IN_LINE = 3


def format_guide_line(guide: Optional[HoleStrategyGuide]) -> str:
    """Compact single-line, spoken-style rendering of a strategy guide, e.g.:

        "Local knowledge: aim at the left edge of the fairway bunker; best
        miss is short-right, never long; green runs back-to-front."

    Composes the non-empty `play_line`, `miss_side`, `green_notes`, and up to
    `_MAX_MISTAKES_IN_LINE` `common_mistakes` into ONE lean line, labeled
    "Local knowledge:" so both mouths render it clearly as reference DATA,
    never as an instruction. Returns "" for `None` or a degenerate/empty guide
    (mirrors `hazards.format_hazards_line`'s empty-string convention) — the
    caller should omit the line entirely rather than print a placeholder.

    Pure and deterministic: no network, no randomness, no side effects.
    """
    if guide is None:
        return ""

    fragments: list[str] = []
    if guide.play_line.strip():
        fragments.append(guide.play_line.strip())
    if guide.miss_side.strip():
        fragments.append(guide.miss_side.strip())
    if guide.green_notes.strip():
        fragments.append(guide.green_notes.strip())

    mistakes = [m.strip() for m in guide.common_mistakes if m and m.strip()]
    if mistakes:
        fragments.append("common mistakes: " + "; ".join(mistakes[:_MAX_MISTAKES_IN_LINE]))

    if not fragments:
        return ""

    return "Local knowledge: " + "; ".join(fragments)
