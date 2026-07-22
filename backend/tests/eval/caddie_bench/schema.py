"""Pydantic schema for the caddie bench — every shape, `extra='forbid'`, closed
enums (specs/caddie-bench-plan.md §1). Mirrors `tests/eval/schema.py`'s
"toothlessness guard" philosophy: a typo'd enum value or missing required
field fails LOAD time, never silently no-ops.

This module is pure — no I/O beyond the `load_*` functions, which raise
loudly on the first malformed line (same fail-closed contract as
`tests.eval.schema.load_golden_set`).
"""

from __future__ import annotations

import json
from enum import Enum
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ── Closed enums (§1) ────────────────────────────────────────────────────────


class LieCategory(str, Enum):
    TEE = "tee"
    FAIRWAY = "fairway"
    ROUGH = "rough"
    BUNKER = "bunker"
    RECOVERY_TREES = "recovery_trees"
    GREENSIDE = "greenside"


class QuestionType(str, Enum):
    TEE_STRATEGY = "tee_strategy"
    CLUB_SELECTION = "club_selection"
    LAYUP_VS_GO = "layup_vs_go"
    MISS_SIDE_BAIL = "miss_side_bail"
    CARRY_QUESTION = "carry_question"
    WIND_ADJUST = "wind_adjust"
    APPROACH_GREEN = "approach_green"
    RECOVERY = "recovery"
    CHALLENGE_WHY = "challenge_why"
    FACT_DISTANCE = "fact_distance"  # FACT-class tier


class ConditionsId(str, Enum):
    CALM = "calm"
    CROSS_15 = "cross_15"
    INTO_20 = "into_20"


class BagId(str, Enum):
    OWNER = "owner"
    SHORT_HITTER = "short_hitter"
    BOMBER = "bomber"


class FailureClass(str, Enum):
    """CLOSED taxonomy — the judge must pick exactly one (§5b)."""

    WRONG_SIDE = "wrong_side"
    BAD_CLUB = "bad_club"
    MISSED_HAZARD = "missed_hazard"
    IGNORED_WIND = "ignored_wind"
    WRONG_NUMBERS = "wrong_numbers"
    VAGUE = "vague"
    FABRICATED = "fabricated"
    NOT_ANSWERED = "not_answered"
    GOOD = "good"


class JudgeDimension(str, Enum):
    """§5b rubric — the 10 judged dimensions, 0=fail/1=partial/2=pass each."""

    NUMBERS_COHERENCE = "numbers_coherence"
    SHOT_REACHABILITY = "shot_reachability"
    MISS_SIDE_EVIDENCE = "miss_side_evidence"
    CLUB_CORRIDOR = "club_corridor"
    HAZARD_AWARENESS = "hazard_awareness"
    WIND_AWARENESS = "wind_awareness"
    ANSWERS_THE_QUESTION = "answers_the_question"
    STRATEGIC_DEPTH = "strategic_depth"
    NATURAL_SPEECH = "natural_speech"
    NON_REPETITIVE = "non_repetitive"


# Correctness axes weighted 2x in the headline score (§5b) — drawn from the
# owner's known caddie failure memories.
CORRECTNESS_DIMENSIONS: frozenset[JudgeDimension] = frozenset({
    JudgeDimension.NUMBERS_COHERENCE, JudgeDimension.SHOT_REACHABILITY,
    JudgeDimension.MISS_SIDE_EVIDENCE, JudgeDimension.CLUB_CORRIDOR,
    JudgeDimension.HAZARD_AWARENESS, JudgeDimension.WIND_AWARENESS,
})

DET_CHECK_WEIGHT = 2  # matches CORRECTNESS_DIMENSIONS weighting in report.py


class DetCheckName(str, Enum):
    """Closed registry of deterministic (never-judge) checks (§5a)."""

    HAZARD_ONLY_FROM_INPUT = "hazard_only_from_input"
    SIDE_FLIP = "side_flip"
    INJECTION = "injection"
    CLUB_MATCHES_ENGINE = "club_matches_engine"
    NUMBERS_CLOSE = "numbers_close"
    POSITIONING_NO_PIN_LANGUAGE = "positioning_no_pin_language"
    LENGTH_CAPS = "length_caps"


# ── Position / case / result shapes (§1) ─────────────────────────────────────


class PositionSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lie: LieCategory
    along_pct: Optional[float] = None  # 0..1 fraction of tee->green centerline; None = lie-default
    seed: int = 0

    @model_validator(mode="after")
    def _along_pct_in_range(self) -> "PositionSpec":
        if self.along_pct is not None and not (0.0 <= self.along_pct <= 1.0):
            raise ValueError(f"along_pct must be in [0, 1], got {self.along_pct}")
        return self


class BenchCase(BaseModel):
    """POSITION × HOLE × PLAYER × CONDITIONS × QTYPE × PHRASING (§1)."""

    model_config = ConfigDict(extra="forbid")

    id: str
    hole_fixture: str
    bag: BagId
    conditions: ConditionsId
    position: PositionSpec
    question_type: QuestionType
    phrasing_id: str
    canary: bool = False  # poison-pill case: judge MUST score it bad (§5c anti-gaming)
    canary_answer: Optional[str] = None  # deliberately bad canned answer, canary cases only

    @model_validator(mode="after")
    def _canary_requires_answer(self) -> "BenchCase":
        if self.canary and not self.canary_answer:
            raise ValueError(f"canary case {self.id!r} must set canary_answer")
        if not self.canary and self.canary_answer is not None:
            raise ValueError(f"non-canary case {self.id!r} must not set canary_answer")
        return self


class ResolvedPosition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lat: float
    lng: float
    lie: LieCategory
    distance_to_green_yards: float
    shot_bearing_deg: float


class DetCheckResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    check: DetCheckName
    passed: bool
    detail: str = "ok"


class JudgeScores(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scores: dict[JudgeDimension, int]  # 0=fail 1=partial 2=pass
    confidence: dict[JudgeDimension, float]
    failure_class: FailureClass
    engine_looks_wrong: bool = False
    reason: str = ""

    @model_validator(mode="after")
    def _scores_in_range(self) -> "JudgeScores":
        for dim, v in self.scores.items():
            if v not in (0, 1, 2):
                raise ValueError(f"score for {dim.value!r} must be 0/1/2, got {v}")
        for dim, c in self.confidence.items():
            if not (0.0 <= c <= 1.0):
                raise ValueError(f"confidence for {dim.value!r} must be in [0,1], got {c}")
        return self


class CaseResult(BaseModel):
    """One JSONL line per case in `runs/<run_id>/results.jsonl`."""

    model_config = ConfigDict(extra="forbid")

    case_id: str
    resolved: ResolvedPosition
    intent: str
    answer: str
    degraded: bool
    engine_ref: dict
    det_checks: list[DetCheckResult] = Field(default_factory=list)
    judge: Optional[JudgeScores] = None
    judge_second: Optional[JudgeScores] = None
    contested: bool = False
    cost_usd: float = 0.0
    latency_ms: float = 0.0


# ── Question bank (questions_v1.jsonl) ───────────────────────────────────────


class Phrasing(BaseModel):
    """One line of `fixtures/questions_v1.jsonl`."""

    model_config = ConfigDict(extra="forbid")

    phrasing_id: str
    question_type: QuestionType
    text: str
    # Lie categories this phrasing makes sense from; [] = compatible with any
    # lie (a generic ask like "what's the play here?").
    lie_constraint: list[LieCategory] = Field(default_factory=list)


def load_question_bank(path: Path) -> list[Phrasing]:
    """Parse + validate `questions_v1.jsonl`. Refuses (raises) a phrasing
    whose `question_type` isn't a real enum member (pydantic does this at
    parse time) and refuses a duplicate normalized `text` — dedupe is
    enforced at LOAD, not just at generation time (§1)."""
    phrasings: list[Phrasing] = []
    seen_ids: set[str] = set()
    seen_texts: set[str] = set()
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
                phrasing = Phrasing.model_validate(data)
            except Exception as e:
                raise ValueError(f"{path}:{lineno}: phrasing failed validation — {e}") from e
            if phrasing.phrasing_id in seen_ids:
                raise ValueError(f"{path}:{lineno}: duplicate phrasing_id {phrasing.phrasing_id!r}")
            seen_ids.add(phrasing.phrasing_id)
            normalized = " ".join(phrasing.text.lower().split())
            if normalized in seen_texts:
                raise ValueError(f"{path}:{lineno}: duplicate phrasing text (normalized): {phrasing.text!r}")
            seen_texts.add(normalized)
            phrasings.append(phrasing)
    return phrasings


# ── Player bags (bags.json) ──────────────────────────────────────────────────


class PlayerBag(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: BagId
    handicap: float
    clubs: dict[str, int]


def load_bags(path: Path) -> dict[BagId, PlayerBag]:
    raw = json.loads(path.read_text())
    bags: dict[BagId, PlayerBag] = {}
    for key, value in raw.items():
        bag = PlayerBag.model_validate({"id": key, **value})
        if bag.id.value != key:
            raise ValueError(f"{path}: bag key {key!r} doesn't match its own id {bag.id.value!r}")
        bags[bag.id] = bag
    missing = set(BagId) - set(bags)
    if missing:
        raise ValueError(f"{path}: missing bag(s): {sorted(m.value for m in missing)}")
    return bags


# ── Paths ─────────────────────────────────────────────────────────────────

FIXTURES_DIR = Path(__file__).parent / "fixtures"
HOLES_DIR = FIXTURES_DIR / "holes"
QUESTIONS_V1_PATH = FIXTURES_DIR / "questions_v1.jsonl"
BAGS_PATH = FIXTURES_DIR / "bags.json"
RUNS_DIR = Path(__file__).parent / "runs"  # gitignored
