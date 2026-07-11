"""Pydantic schema for `golden/caddie_advice.jsonl` — the golden set of
caddie advice-quality scenarios (specs/caddie-advice-eval-plan.md §4).

Each line of the JSONL is one `Scenario`: a hole/player/question situation
plus `expected` properties, split into three lists:

  - `tier1`               — deterministic, offline, runs in CI (`checks.py::TIER1_CHECKS`)
  - `tier2_deterministic` — deterministic, but computed on a LIVE model answer
                            (`checks.py::TIER2_DETERMINISTIC`), on-demand only
  - `tier2_judge`         — soft properties, LLM-judged, on-demand only

Toothlessness guard (audit warning: "an eval that can't fail is worse than
none"): every check name is drawn from a CLOSED enum. An unknown/typo'd check
name fails Pydantic validation at LOAD time — a scenario can never silently
reference a check that doesn't exist and no-op.
"""

from __future__ import annotations

import json
from enum import Enum
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ── Closed check-name registries ────────────────────────────────────────────


class Tier1CheckName(str, Enum):
    PROMPT_CONTAINS_RULE = "prompt_contains_rule"
    PROMPT_CONTAINS_LITERAL = "prompt_contains_literal"
    HAZARDS_LINE_ONLY_FROM_INPUT = "hazards_line_only_from_input"
    HAZARDS_LINE_EMPTY_WHEN_NO_HAZARDS = "hazards_line_empty_when_no_hazards"
    CONTEXT_HAZARDS_MATCH = "context_hazards_match"
    VALIDATE_GUIDE_REJECTS = "validate_guide_rejects"
    VALIDATE_GUIDE_ACCEPTS = "validate_guide_accepts"
    GROUND_TRUTH_BLOCK_COMPLETE = "ground_truth_block_complete"
    CONTEXT_CONTAINS = "context_contains"
    CARRIES_TOOL_MATCHES_HAZARDS = "carries_tool_matches_hazards"
    SHOT_DISTANCE_IN_BAND = "shot_distance_in_band"


class Tier2DeterministicCheckName(str, Enum):
    CLUB_WITHIN_ONE = "club_within_one"
    MAX_SENTENCES = "max_sentences"
    NO_MARKDOWN = "no_markdown"
    MUST_NOT_MENTION = "must_not_mention"
    MUST_MENTION_ANY = "must_mention_any"


class Tier2JudgeProperty(str, Enum):
    GROUNDED_IN_HOLE = "grounded_in_hole"
    RESPECTS_PLAYS_LIKE = "respects_plays_like"
    DEFERS_TO_OBSERVED_REALITY = "defers_to_observed_reality"
    APPROPRIATELY_CONCISE_AND_CALM = "appropriately_concise_and_calm"
    ASKS_TO_REPEAT_ON_UNINTELLIGIBLE = "asks_to_repeat_on_unintelligible"


# Which extra params each check name requires — enforced at load time so a
# scenario missing a required param (e.g. `context_contains` with no
# `literal`) fails loudly instead of silently checking nothing.
_TIER1_REQUIRED_FIELDS: dict[Tier1CheckName, tuple[str, ...]] = {
    Tier1CheckName.PROMPT_CONTAINS_RULE: ("rule",),
    Tier1CheckName.PROMPT_CONTAINS_LITERAL: ("literal",),
    Tier1CheckName.HAZARDS_LINE_ONLY_FROM_INPUT: (),
    Tier1CheckName.HAZARDS_LINE_EMPTY_WHEN_NO_HAZARDS: (),
    Tier1CheckName.CONTEXT_HAZARDS_MATCH: ("hazards",),
    Tier1CheckName.VALIDATE_GUIDE_REJECTS: ("guide",),
    Tier1CheckName.VALIDATE_GUIDE_ACCEPTS: ("guide",),
    Tier1CheckName.GROUND_TRUTH_BLOCK_COMPLETE: (),
    Tier1CheckName.CONTEXT_CONTAINS: ("literal",),
    Tier1CheckName.CARRIES_TOOL_MATCHES_HAZARDS: (),
    # band is universally required; the club-vs-target_yards either/or is
    # enforced by the model validator below (exactly one must be set).
    Tier1CheckName.SHOT_DISTANCE_IN_BAND: ("band",),
}

_TIER2_DET_REQUIRED_FIELDS: dict[Tier2DeterministicCheckName, tuple[str, ...]] = {
    Tier2DeterministicCheckName.CLUB_WITHIN_ONE: ("target_yards",),
    Tier2DeterministicCheckName.MAX_SENTENCES: ("n",),
    Tier2DeterministicCheckName.NO_MARKDOWN: (),
    Tier2DeterministicCheckName.MUST_NOT_MENTION: ("phrases",),
    Tier2DeterministicCheckName.MUST_MENTION_ANY: ("phrases",),
}

_VALID_RULE_NAMES = {
    "HAZARD_GROUNDING_RULE", "OBSERVED_REALITY_RULE", "PHYSICS_GROUNDING_RULE",
    "GREEN_GROUNDING_RULE", "BEND_GROUNDING_RULE", "INPUT_GROUNDING_RULE",
    "YARDAGE_GROUNDING_RULE", "POSITIONING_SHOT_RULE",
}
_VALID_MOUTHS = {"text", "realtime"}


# ── Situation (hole / player / weather / guide / question) ─────────────────


class HoleSituation(BaseModel):
    """Hole context. Hazards can be given two ways (mirrors §4's `//OR`):

    - `features`: a real GeoJSON FeatureCollection — hazards are derived by
      running the production `extract_hole_hazards` geometry (exercises the
      polyline-vs-chord dogleg classification).
    - `hazards`: a pre-built list of `{type, line_side, carry_yards, ...}`
      dicts — used when the geometry pipeline itself isn't the point.

    Exactly one of the two (or neither, meaning "no hazards on this hole")
    should be set; both may coexist only if a scenario intentionally wants
    `features` to win (checks.py always prefers `features` when present).
    """

    model_config = ConfigDict(extra="forbid")

    number: int
    par: int
    yards: Optional[int] = None
    elevation_change_ft: float = 0.0
    features: Optional[dict] = None
    hazards: Optional[list[dict]] = None
    green_slope: Optional[dict] = None


class PlayerSituation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    handicap: Optional[float] = None
    club_distances: dict[str, int] = Field(default_factory=dict)


class WeatherSituation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    temperature_f: float = 70.0
    wind_speed_mph: float = 0.0
    wind_direction: int = 0
    humidity: float = 50.0


class Situation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hole: HoleSituation
    player: PlayerSituation = Field(default_factory=PlayerSituation)
    weather: Optional[WeatherSituation] = None
    strategy_guide: Optional[dict] = None  # HoleStrategyGuide-shaped, or None
    question: str
    # Consumed by Tier 2's live transcript assembly only (not by any Tier 1
    # check — the prompt-assembly checks don't depend on question content).
    player_observation: Optional[str] = None


# ── Expected checks ──────────────────────────────────────────────────────────


class Tier1Check(BaseModel):
    model_config = ConfigDict(extra="forbid")

    check: Tier1CheckName
    rule: Optional[str] = None
    mouths: list[str] = Field(default_factory=lambda: ["text", "realtime"])
    literal: Optional[str] = None
    hazards: Optional[list[dict]] = None
    guide: Optional[dict] = None
    # shot_distance_in_band: exactly one of club/target_yards, plus band=[lo, hi].
    club: Optional[str] = None
    target_yards: Optional[int] = None
    band: Optional[list[float]] = None

    @model_validator(mode="after")
    def _required_fields_present(self) -> "Tier1Check":
        missing = [
            f for f in _TIER1_REQUIRED_FIELDS[self.check]
            if getattr(self, f) is None
        ]
        if missing:
            raise ValueError(f"tier1 check {self.check.value!r} missing required field(s): {missing}")
        if self.check == Tier1CheckName.PROMPT_CONTAINS_RULE and self.rule not in _VALID_RULE_NAMES:
            raise ValueError(f"unknown rule name {self.rule!r} — expected one of {_VALID_RULE_NAMES}")
        if not set(self.mouths) <= _VALID_MOUTHS:
            raise ValueError(f"unknown mouth(s) {set(self.mouths) - _VALID_MOUTHS} — expected {_VALID_MOUTHS}")
        if self.check == Tier1CheckName.SHOT_DISTANCE_IN_BAND:
            if (self.club is None) == (self.target_yards is None):
                raise ValueError(
                    "shot_distance_in_band requires exactly one of club / target_yards"
                )
            if len(self.band or []) != 2 or self.band[0] > self.band[1]:
                raise ValueError(f"band must be [lo, hi] with lo <= hi, got {self.band!r}")
        return self


class Tier2DeterministicCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    check: Tier2DeterministicCheckName
    target_yards: Optional[int] = None
    n: Optional[int] = None
    phrases: Optional[list[str]] = None

    @model_validator(mode="after")
    def _required_fields_present(self) -> "Tier2DeterministicCheck":
        missing = [
            f for f in _TIER2_DET_REQUIRED_FIELDS[self.check]
            if getattr(self, f) is None
        ]
        if missing:
            raise ValueError(f"tier2_deterministic check {self.check.value!r} missing required field(s): {missing}")
        return self


class Tier2JudgeCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    property: Tier2JudgeProperty
    description: str


class Expected(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tier1: list[Tier1Check] = Field(default_factory=list)
    tier2_deterministic: list[Tier2DeterministicCheck] = Field(default_factory=list)
    tier2_judge: list[Tier2JudgeCheck] = Field(default_factory=list)


# ── Scenario (one JSONL line) ───────────────────────────────────────────────


class Scenario(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    source: str
    notes: str = ""
    situation: Situation
    expected: Expected


def load_golden_set(path: Path) -> list[Scenario]:
    """Parse `golden/caddie_advice.jsonl` into a list of validated `Scenario`s.

    Raises `pydantic.ValidationError` (or `json.JSONDecodeError`) on the
    first malformed line — a bad scenario fails the whole load rather than
    being silently skipped (same fail-closed spirit as `validate_guide`).
    """
    scenarios: list[Scenario] = []
    with open(path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, start=1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(f"{path}:{lineno}: invalid JSON — {e}") from e
            try:
                scenarios.append(Scenario.model_validate(data))
            except Exception as e:
                raise ValueError(f"{path}:{lineno}: scenario {data.get('id', '?')!r} failed validation — {e}") from e

    ids = [s.id for s in scenarios]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise ValueError(f"{path}: duplicate scenario id(s): {dupes}")

    return scenarios


GOLDEN_SET_PATH = Path(__file__).parent / "golden" / "caddie_advice.jsonl"
