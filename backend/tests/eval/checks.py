"""Deterministic check implementations shared by the Tier-1 pytest suite
(`test_golden_tier1.py`) AND the on-demand Tier-2 live runner (`run_tier2.py`).

Two registries (specs/caddie-advice-eval-plan.md §4):
  - `TIER1_CHECKS` — asserts properties of the ASSEMBLED PROMPT/CONTEXT
    (never calls a model). `test_golden_tier1.py` builds a `Tier1Context`
    per scenario (via the real, monkeypatched `_build_session_voice_prompt`
    + `build_realtime_instructions`) and dispatches into this registry.
  - `TIER2_DETERMINISTIC` — asserts properties of a LIVE model ANSWER
    (sentence count, markdown, club selection, forbidden/required phrases).
    Pure string checks; no judge needed, cannot flake.

Every check returns a `CheckResult(passed, detail)` — `detail` explains a
failure so a red run tells you WHY, not just that it failed.

Rule (plan §2): assertions about the RULES reference the imported constants
(`HAZARD_GROUNDING_RULE`, `OBSERVED_REALITY_RULE`), never copied strings, so
prompt-wording edits don't rot the eval.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Optional

from app.caddie.club_selection import CLUB_DISPLAY_NAMES
from app.caddie.guide_writer import build_ground_truth_block, validate_guide
from app.caddie.green_geometry import GREEN_GROUNDING_RULE
from app.caddie.hazards import HAZARD_GROUNDING_RULE, extract_hole_hazards, format_hazards_line
from app.caddie.physics import PHYSICS_GROUNDING_RULE, elevation_only_plays_like
from app.caddie.session import RoundSession
from app.caddie.tools import carries_payload, shot_distance_payload
from app.caddie.types import GreenSlope, Hazard, HoleIntelligence, HoleStrategyGuide, WeatherConditions
from app.caddie.voice_prompts import OBSERVED_REALITY_RULE

from tests.eval.schema import HoleSituation, Scenario, Tier1Check, Tier1CheckName, Tier2DeterministicCheck, Tier2DeterministicCheckName


@dataclass
class CheckResult:
    passed: bool
    detail: str = "ok"


# ── Shared fixtures: Situation -> production objects ────────────────────────

_SIDE_ABBREV: dict[str, str] = {"left": "L", "right": "R", "center": "C"}


def resolve_hazards(hole: HoleSituation) -> list[Hazard]:
    """The hole's `Hazard` list, from either `features` (run through the
    REAL `extract_hole_hazards` geometry — exercises polyline/chord/dogleg
    classification) or a pre-built `hazards` list. `features` wins when both
    are given. Neither -> `[]` (honest empty, same convention as the app)."""
    if hole.features is not None:
        return extract_hole_hazards(hole.features)
    if hole.hazards:
        out: list[Hazard] = []
        for h in hole.hazards:
            side = h.get("line_side") or h.get("side") or "center"
            out.append(
                Hazard(
                    type=h["type"],
                    side=side,
                    line_side=side,
                    carry_yards=int(h.get("carry_yards", h.get("carry", 0)) or 0),
                    distance_from_green=float(h.get("distance_from_green", 0.0) or 0.0),
                    penalty_severity=h.get("penalty_severity", "moderate"),
                )
            )
        return out
    return []


def build_round_session(scenario: Scenario) -> RoundSession:
    """A synthetic `RoundSession` from a golden `Scenario` — the same shape
    `build_realtime_instructions`/`_build_session_voice_prompt` consume in
    production. Effective yardage uses the identical physics elevation-only
    plays-like `build_hole_intelligence` and `build_ground_truth_block` use
    (`physics.elevation_only_plays_like`, plan step 9), so the two mouths'
    "plays uphill" numbers always agree with each other, with the ground-truth
    block, and with production."""
    hole = scenario.situation.hole
    hazards = resolve_hazards(hole)
    effective_yards: Optional[int] = None
    if hole.yards is not None:
        effective_yards = elevation_only_plays_like(hole.yards, hole.elevation_change_ft)
    guide = HoleStrategyGuide(**scenario.situation.strategy_guide) if scenario.situation.strategy_guide else None
    green_slope = GreenSlope(**hole.green_slope) if hole.green_slope else None
    intel = HoleIntelligence(
        hole_number=hole.number,
        par=hole.par,
        yards=hole.yards,
        elevation_change_ft=hole.elevation_change_ft,
        effective_yards=effective_yards,
        hazards=hazards,
        strategy_guide=guide,
        green_slope=green_slope,
    )
    weather = (
        WeatherConditions(**scenario.situation.weather.model_dump())
        if scenario.situation.weather else None
    )
    return RoundSession(
        round_id="eval",
        user_id="eval-user",
        current_hole=hole.number,
        handicap=scenario.situation.player.handicap,
        club_distances=dict(scenario.situation.player.club_distances),
        weather=weather,
        hole_intel={hole.number: intel},
    )


def ground_truth_block_for(scenario: Scenario, hazards: list[Hazard]) -> str:
    hole = scenario.situation.hole
    return build_ground_truth_block(
        hole.number, hole.par, hole.yards, hole.green_slope, hole.elevation_change_ft, hazards,
    )


# ── Tier-1 context (prompts assembled by the caller, everything else here) ──


@dataclass
class Tier1Context:
    hazards: list[Hazard]
    hazards_line: str
    ground_truth_block: str
    text_prompt: str            # full text-mouth system prompt (BLOCK0 + BLOCK1)
    text_situation_block: str   # BLOCK1 only ("--- CURRENT SITUATION ---" section)
    realtime_prompt: str        # build_realtime_instructions() output
    # The scenario itself, for checks that exercise session-derived tool
    # payloads (carries_tool_matches_hazards builds the RoundSession from it).
    # Optional so hand-built contexts in the teeth tests stay valid.
    scenario: Optional[Scenario] = None


def build_tier1_context(
    scenario: Scenario, *, text_prompt: str, text_situation_block: str, realtime_prompt: str,
) -> Tier1Context:
    """Assembles the pure half of the context (hazards/ground-truth block).
    The caller supplies the two prompt strings because building them
    requires the DB-touching (monkeypatched) `_build_session_voice_prompt` —
    this module stays free of any pytest/monkeypatch concern."""
    hazards = resolve_hazards(scenario.situation.hole)
    hazards_line = format_hazards_line(scenario.situation.hole.number, hazards)
    return Tier1Context(
        hazards=hazards,
        hazards_line=hazards_line,
        ground_truth_block=ground_truth_block_for(scenario, hazards),
        text_prompt=text_prompt,
        text_situation_block=text_situation_block,
        realtime_prompt=realtime_prompt,
        scenario=scenario,
    )


# ── Tier-1 check implementations ─────────────────────────────────────────────

_RULE_TEXT: dict[str, str] = {
    "HAZARD_GROUNDING_RULE": HAZARD_GROUNDING_RULE,
    "OBSERVED_REALITY_RULE": OBSERVED_REALITY_RULE,
    "PHYSICS_GROUNDING_RULE": PHYSICS_GROUNDING_RULE,
    "GREEN_GROUNDING_RULE": GREEN_GROUNDING_RULE,
}


def _mouth_text(ctx: Tier1Context, mouth: str) -> str:
    return ctx.text_prompt if mouth == "text" else ctx.realtime_prompt


def check_prompt_contains_rule(ctx: Tier1Context, check: Tier1Check) -> CheckResult:
    rule_text = _RULE_TEXT[check.rule]
    # Guard the toothlessness vector: an emptied/whitespace rule constant would make
    # `rule_text in prompt` trivially True. A grounding rule that shrank to nothing is a
    # regression, not a pass — fail loudly instead of masking it.
    if not rule_text.strip():
        return CheckResult(False, f"{check.rule} is empty — a grounding rule must not vanish")
    missing = [m for m in check.mouths if rule_text not in _mouth_text(ctx, m)]
    return CheckResult(not missing, f"{check.rule} missing from mouth(s): {missing}" if missing else "ok")


def check_prompt_contains_literal(ctx: Tier1Context, check: Tier1Check) -> CheckResult:
    # Same guard: an empty literal is `"" in prompt` == always True (toothless).
    if not check.literal.strip():
        return CheckResult(False, "literal is empty — cannot assert an empty contract phrase")
    missing = [m for m in check.mouths if check.literal not in _mouth_text(ctx, m)]
    return CheckResult(not missing, f"{check.literal!r} missing from mouth(s): {missing}" if missing else "ok")


# Parses tokens like "bunker L 245y" or "water R 190-230y" out of a
# `format_hazards_line` string. Only single-letter L/R/C side tokens match —
# ordinary prose never contains a bare L/R/C token immediately followed by a
# yardage, so this can't false-positive on the "Hole N hazards:" prefix.
_HAZARD_TOKEN_RE = re.compile(r"\b(\w+)\s+([LRC])\s+(\d+)(?:-(\d+))?y\b")


def hazards_line_only_from_input(hazards: list[Hazard], hazards_line: str) -> CheckResult:
    """Every (type, side) token the formatted line DECLARES must be present
    in the input hazard list — guards against a formatter that "helpfully"
    merges in a stale/cached/invented hazard not present in the input
    (§7 teeth mutant #2)."""
    if not hazards_line:
        return CheckResult(True, "empty line — trivially has no invented tokens")
    input_pairs = {(hz.type, _SIDE_ABBREV.get(hz.line_side, hz.line_side[:1].upper())) for hz in hazards}
    tokens = [(m.group(1), m.group(2)) for m in _HAZARD_TOKEN_RE.finditer(hazards_line)]
    unknown = [t for t in tokens if t not in input_pairs]
    return CheckResult(not unknown, f"hazards line contains token(s) absent from input: {unknown}" if unknown else "ok")


def hazards_line_empty_when_no_hazards(hazards: list[Hazard], hazards_line: str) -> CheckResult:
    """Honest empty state: a zero-hazard hole's formatted line must be `""`,
    never a fabricated placeholder line (§7 teeth mutant #4)."""
    if hazards:
        return CheckResult(True, "hazards present — check not applicable")
    return CheckResult(
        hazards_line == "",
        f"expected an empty hazards line for a zero-hazard hole, got {hazards_line!r}",
    )


def check_hazards_line_only_from_input(ctx: Tier1Context, check: Tier1Check) -> CheckResult:
    return hazards_line_only_from_input(ctx.hazards, ctx.hazards_line)


def check_hazards_line_empty_when_no_hazards(ctx: Tier1Context, check: Tier1Check) -> CheckResult:
    return hazards_line_empty_when_no_hazards(ctx.hazards, ctx.hazards_line)


def context_hazards_match(hazards_line: str, expected: list[dict]) -> CheckResult:
    """Every expected `{type, side, carry?}` entry must appear in the
    formatted hazards line; `carry` (if given) must land within 15y of the
    line's stated range — the same along-path-vs-chord slack the real
    Bethpage-4 fixture carries (test_bethpage_validation.py)."""
    for e in expected:
        etype, eside = e["type"], e["side"]
        ecarry = e.get("carry")
        pattern = re.compile(rf"\b{re.escape(etype)}\s+{re.escape(eside)}\s+(\d+)(?:-(\d+))?y\b")
        m = pattern.search(hazards_line)
        if not m:
            return CheckResult(False, f"expected {etype!r} {eside!r} not found in hazards line: {hazards_line!r}")
        if ecarry is not None:
            lo = int(m.group(1))
            hi = int(m.group(2)) if m.group(2) else lo
            if not (lo - 15 <= ecarry <= hi + 15):
                return CheckResult(False, f"expected carry ~{ecarry}y, hazards line has {lo}-{hi}y")
    return CheckResult(True, "ok")


def check_context_hazards_match(ctx: Tier1Context, check: Tier1Check) -> CheckResult:
    return context_hazards_match(ctx.hazards_line, check.hazards or [])


def check_validate_guide_rejects(ctx: Tier1Context, check: Tier1Check) -> CheckResult:
    guide = HoleStrategyGuide(**(check.guide or {}))
    result = validate_guide(guide, ctx.hazards)
    return CheckResult(
        result is None,
        "validate_guide ACCEPTED a guide expected to be REJECTED" if result is not None else "ok",
    )


def check_validate_guide_accepts(ctx: Tier1Context, check: Tier1Check) -> CheckResult:
    guide = HoleStrategyGuide(**(check.guide or {}))
    result = validate_guide(guide, ctx.hazards)
    return CheckResult(
        result is not None,
        "validate_guide REJECTED a guide expected to be ACCEPTED" if result is None else "ok",
    )


def check_ground_truth_block_complete(ctx: Tier1Context, check: Tier1Check) -> CheckResult:
    if ctx.hazards:
        ok = "the COMPLETE list — there are NO others" in ctx.ground_truth_block
        return CheckResult(ok, "missing the COMPLETE-list phrase with hazards present" if not ok else "ok")
    ok = "NONE mapped" in ctx.ground_truth_block
    return CheckResult(ok, "missing the NONE-mapped phrase with no hazards" if not ok else "ok")


def check_context_contains(ctx: Tier1Context, check: Tier1Check) -> CheckResult:
    ok = check.literal in ctx.text_situation_block
    return CheckResult(ok, f"{check.literal!r} not found in the CURRENT SITUATION block" if not ok else "ok")


def check_carries_tool_matches_hazards(ctx: Tier1Context, check: Tier1Check) -> CheckResult:
    """`get_carries` (both mouths resolve through `app.caddie.tools.
    carries_payload`) must report EXACTLY the scenario's mapped along-path
    carries — no invented numbers, none dropped — and follow the D3
    honest-empty contract (caddie-tool-loop-parity): a mapped hole is
    available (with a note when genuinely hazard-free), an UNMAPPED hole is
    available:false with a reason, never a fabricated carry."""
    if ctx.scenario is None:
        return CheckResult(False, "context carries no scenario — cannot build the RoundSession")
    hole = ctx.scenario.situation.hole
    session = build_round_session(ctx.scenario)

    payload = carries_payload(session, hole.number)
    if payload.get("available") is not True:
        return CheckResult(False, f"carries unavailable for a hole WITH intel: {payload!r}")
    expected = sorted(hz.carry_yards for hz in ctx.hazards if hz.carry_yards > 0)
    got = sorted(c["carry_yards"] for c in payload.get("carries") or [])
    if got != expected:
        return CheckResult(False, f"carry set mismatch: tool says {got}, mapped hazards say {expected}")
    if not expected and not payload.get("note"):
        return CheckResult(False, "hazard-free hole must carry the explicit 'no mapped bunkers' note")

    # Honest-empty flag: a hole with NO intel must be available:false + reason.
    unmapped = carries_payload(session, hole.number + 1)
    if unmapped.get("available") is not False or not unmapped.get("reason"):
        return CheckResult(False, f"unmapped hole must be available:false with a reason, got {unmapped!r}")
    return CheckResult(True, "ok")


def check_shot_distance_in_band(ctx: Tier1Context, check: Tier1Check) -> CheckResult:
    """Runs the REAL `get_shot_distance` machinery (`tools.shot_distance_payload`
    → the RK4 physics engine) against the scenario's situation — offline,
    deterministic, CI-gated. Asserts the number the tool would hand the model
    lands inside `band`: `total_yards` when a `club` is given, `plays_like_yards`
    when a `target_yards` is given. This is the eval tooth for the 2026-07-09
    incident: a 300y drive, 4mph tail, 38ft down must total 315-330 — the
    pre-physics behavior ('total around 390') is structurally out of band."""
    if ctx.scenario is None:
        return CheckResult(False, "context carries no scenario — cannot build the RoundSession")
    hole = ctx.scenario.situation.hole
    session = build_round_session(ctx.scenario)

    payload = shot_distance_payload(
        session, hole_number=hole.number, club=check.club, target_yards=check.target_yards,
    )
    if payload.get("available") is not True:
        return CheckResult(False, f"shot distance unavailable for a fully-specified scenario: {payload!r}")
    field = "total_yards" if check.club else "plays_like_yards"
    value = payload.get(field)
    if value is None:
        return CheckResult(False, f"payload carries no {field}: {payload!r}")
    lo, hi = check.band
    ok = lo <= value <= hi
    return CheckResult(ok, f"{field}={value} outside physics band [{lo}, {hi}]" if not ok else "ok")


TIER1_CHECKS: dict[str, Callable[[Tier1Context, Tier1Check], CheckResult]] = {
    Tier1CheckName.PROMPT_CONTAINS_RULE.value: check_prompt_contains_rule,
    Tier1CheckName.PROMPT_CONTAINS_LITERAL.value: check_prompt_contains_literal,
    Tier1CheckName.HAZARDS_LINE_ONLY_FROM_INPUT.value: check_hazards_line_only_from_input,
    Tier1CheckName.HAZARDS_LINE_EMPTY_WHEN_NO_HAZARDS.value: check_hazards_line_empty_when_no_hazards,
    Tier1CheckName.CONTEXT_HAZARDS_MATCH.value: check_context_hazards_match,
    Tier1CheckName.VALIDATE_GUIDE_REJECTS.value: check_validate_guide_rejects,
    Tier1CheckName.VALIDATE_GUIDE_ACCEPTS.value: check_validate_guide_accepts,
    Tier1CheckName.GROUND_TRUTH_BLOCK_COMPLETE.value: check_ground_truth_block_complete,
    Tier1CheckName.CONTEXT_CONTAINS.value: check_context_contains,
    Tier1CheckName.CARRIES_TOOL_MATCHES_HAZARDS.value: check_carries_tool_matches_hazards,
    Tier1CheckName.SHOT_DISTANCE_IN_BAND.value: check_shot_distance_in_band,
}


# ── Tier-2 deterministic check implementations (operate on a LIVE answer) ───

_SENTENCE_SPLIT_RE = re.compile(r"[.!?]+(?:\s|$)")
_EMOJI_RE = re.compile("[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF]")


def max_sentences(answer: str, n: int) -> CheckResult:
    sentences = [s for s in _SENTENCE_SPLIT_RE.split(answer.strip()) if s.strip()]
    ok = len(sentences) <= n
    return CheckResult(ok, f"answer has {len(sentences)} sentence(s), max is {n}: {answer!r}")


def no_markdown(answer: str) -> CheckResult:
    bad_chars = [c for c in ("*", "#", "`") if c in answer]
    if bad_chars:
        return CheckResult(False, f"answer contains markdown character(s) {bad_chars}: {answer!r}")
    if re.search(r"(?m)^\s*[-•]\s", answer):
        return CheckResult(False, f"answer contains a bullet-list marker: {answer!r}")
    if re.search(r"(?m)^\s*\d+\.\s", answer):
        return CheckResult(False, f"answer contains a numbered-list marker: {answer!r}")
    if _EMOJI_RE.search(answer):
        return CheckResult(False, f"answer contains emoji: {answer!r}")
    return CheckResult(True, "ok")


def _build_club_mention_patterns() -> dict[str, "re.Pattern[str]"]:
    patterns: dict[str, re.Pattern] = {}
    for key, display in CLUB_DISPLAY_NAMES.items():
        words = display.lower().split()
        alts = [re.escape(display.lower())]
        if len(words) == 2 and words[1] == "iron":
            digit = words[0]
            alts += [re.escape(f"{digit}i"), re.escape(f"{digit}-iron"), re.escape(f"{digit}iron")]
        if len(words) == 2 and words[1] == "wood":
            digit = words[0]
            alts += [re.escape(f"{digit}w"), re.escape(f"{digit}-wood"), re.escape(f"{digit}wood")]
        patterns[key] = re.compile(r"\b(?:" + "|".join(alts) + r")\b", re.IGNORECASE)
    return patterns


_CLUB_MENTION_PATTERNS = _build_club_mention_patterns()
_CLUB_WITHIN_ONE_TOLERANCE_YARDS = 10


def _parse_mentioned_club(answer: str, club_distances: dict[str, int]) -> Optional[tuple[str, int]]:
    """The first (earliest-position) club named in `answer` whose canonical
    key is present in `club_distances`. Returns `(club_key, distance_yards)`
    or `None` if no known club is mentioned."""
    best: Optional[tuple[int, str, int]] = None
    for key, pattern in _CLUB_MENTION_PATTERNS.items():
        if key not in club_distances:
            continue
        m = pattern.search(answer)
        if m and (best is None or m.start() < best[0]):
            best = (m.start(), key, club_distances[key])
    if best is None:
        return None
    return best[1], best[2]


def club_within_one(answer: str, target_yards: int, club_distances: dict[str, int]) -> CheckResult:
    """PASS if the first club named in the answer (that's in the player's
    bag) lands within `_CLUB_WITHIN_ONE_TOLERANCE_YARDS` of `target_yards` —
    a deliberately generous stand-in for "within one club" (adjacent clubs
    in a typical bag run ~10-15y apart)."""
    mention = _parse_mentioned_club(answer, club_distances)
    if mention is None:
        return CheckResult(False, f"no club from {sorted(club_distances)} found in answer: {answer!r}")
    club, distance = mention
    delta = abs(distance - target_yards)
    ok = delta <= _CLUB_WITHIN_ONE_TOLERANCE_YARDS
    return CheckResult(
        ok,
        f"answer names {club} ({distance}y), {delta}y from target {target_yards}y "
        f"(tolerance {_CLUB_WITHIN_ONE_TOLERANCE_YARDS}y)",
    )


def must_not_mention(answer: str, phrases: list[str]) -> CheckResult:
    lowered = answer.lower()
    found = [p for p in phrases if p.lower() in lowered]
    return CheckResult(not found, f"answer contains forbidden phrase(s) {found}: {answer!r}" if found else "ok")


def must_mention_any(answer: str, phrases: list[str]) -> CheckResult:
    lowered = answer.lower()
    found = [p for p in phrases if p.lower() in lowered]
    return CheckResult(bool(found), f"answer contains none of {phrases}: {answer!r}" if not found else "ok")


def _t2_club_within_one(answer: str, check: Tier2DeterministicCheck, scenario: Scenario) -> CheckResult:
    return club_within_one(answer, check.target_yards, scenario.situation.player.club_distances)


def _t2_max_sentences(answer: str, check: Tier2DeterministicCheck, scenario: Scenario) -> CheckResult:
    return max_sentences(answer, check.n)


def _t2_no_markdown(answer: str, check: Tier2DeterministicCheck, scenario: Scenario) -> CheckResult:
    return no_markdown(answer)


def _t2_must_not_mention(answer: str, check: Tier2DeterministicCheck, scenario: Scenario) -> CheckResult:
    return must_not_mention(answer, check.phrases or [])


def _t2_must_mention_any(answer: str, check: Tier2DeterministicCheck, scenario: Scenario) -> CheckResult:
    return must_mention_any(answer, check.phrases or [])


TIER2_DETERMINISTIC: dict[str, Callable[[str, Tier2DeterministicCheck, Scenario], CheckResult]] = {
    Tier2DeterministicCheckName.CLUB_WITHIN_ONE.value: _t2_club_within_one,
    Tier2DeterministicCheckName.MAX_SENTENCES.value: _t2_max_sentences,
    Tier2DeterministicCheckName.NO_MARKDOWN.value: _t2_no_markdown,
    Tier2DeterministicCheckName.MUST_NOT_MENTION.value: _t2_must_not_mention,
    Tier2DeterministicCheckName.MUST_MENTION_ANY.value: _t2_must_mention_any,
}
