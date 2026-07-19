"""Register-consistency guards for the caddie house voice
(specs/caddie-orb-persona-consistency-plan.md §3.2, persona.md).
DB-free, key-free, offline — no LLM call, no network, no Postgres.

Covers:
1. Adoption pins — `voice_prompts.CADDIE_HOUSE_REGISTER` is imported (never
   re-typed) into every ADOPT surface, and is deliberately ABSENT from the
   one intentionally-distinct written medium (`course_intel_writer`).
2. A static, case-insensitive substring scan of the constants/templates for
   the persona doc's banned-literal list (AI-tells, meta-preamble, SaaS-speak,
   and the two fixed degraded-line regression strings).
3. A pin that the code's banned-literal list can never silently drift from
   the design doc — every entry must appear verbatim in the doc's §2.
4. Cheap required-persona-marker spot checks (static, template-level).

Live-answer banned/required checks (real model output) are Tier-2 and are
NOT implemented here — they may later ride `run_tier2.py` / `run_consistency.py`
behind a keyed env (e.g. `CADDIE_EVAL_LIVE=1`), never a CI gate.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pathlib  # noqa: E402

from app.caddie import course_intel_writer  # noqa: E402
from app.caddie import guide_writer  # noqa: E402
from app.caddie import personalities  # noqa: E402
from app.caddie import strategy as strategy_mod  # noqa: E402
from app.caddie import voice_prompts  # noqa: E402
from app.caddie.decade_advice import (  # noqa: E402
    cross_hazard_line,
    decade_aim_advice,
    decade_landing_advice,
)
from app.caddie.slope_advice import slope_miss_advice
from app.caddie.strategy_turn import compose_degraded_line  # noqa: E402
from app.caddie.types import GreenSlope, Hazard  # noqa: E402
from app.caddie.voice_prompts import CADDIE_HOUSE_REGISTER  # noqa: E402


# ── 1. Adoption pins (imported constant, never re-typed) ───────────────────


def test_house_register_is_non_empty_and_single_line():
    """Shape guard: protects the line-set comparison in
    `test_caddie_caching.py` and the one-line interpolation everywhere."""
    assert CADDIE_HOUSE_REGISTER
    assert "\n" not in CADDIE_HOUSE_REGISTER


def test_house_register_adopted_in_realtime_base_behavior():
    assert CADDIE_HOUSE_REGISTER in voice_prompts._BASE_BEHAVIOR


def test_house_register_adopted_in_strategy_system():
    assert CADDIE_HOUSE_REGISTER in strategy_mod._strategy_system()


def test_house_register_adopted_in_guide_writer():
    assert CADDIE_HOUSE_REGISTER in guide_writer.WRITER_SYSTEM


def test_house_register_absent_from_course_intel_writer():
    """4b's intentional distinctness (persona.md §3 row 4b): the course-intel
    writer is written scene-setting prose, not a live spoken turn, and must
    NOT fold the house register."""
    assert CADDIE_HOUSE_REGISTER not in course_intel_writer.COURSE_WRITER_SYSTEM


# ── 2. Banned-literal static scan ───────────────────────────────────────────

# Persona doc §2's banned list, lowercase substrings. Markdown/emoji
# structural tells are deliberately excluded here — persona `system_prompt`s
# legitimately contain "- " style-guideline bullets, so structural markdown
# checks stay Tier-2 on live ANSWERS via the existing `no_markdown` check.
BANNED_REGISTER_LITERALS = (
    # AI-tells
    "as an ai",
    "i'm just an ai",
    "i am an ai",
    "as a language model",
    "i don't have feelings",
    "i'm not able to",
    # Meta-preamble
    "here's the plan",
    "sure!",
    "certainly!",
    "i'd be happy to",
    "let me help you with that",
    # SaaS-speak
    "leverage",
    "utilize",
    "seamless",
    "optimize your experience",
    "synergy",
    "circle back",
    "unlock",
    "elevate your game",
    # Known-fixed degraded bugs (regression guards)
    "no trouble",
    "the none",
)


def _slope_advice_samples() -> list[str]:
    """All four branch outputs (front-to-back, left-to-right, back-to-front,
    right-to-left) × both advice-producing severities (moderate, severe)."""
    directions = {
        "front-to-back": 0.0,
        "left-to-right": 90.0,
        "back-to-front": 180.0,
        "right-to-left": 270.0,
    }
    outputs: list[str] = []
    for direction in directions.values():
        for severity in ("moderate", "severe"):
            slope = GreenSlope(
                direction=direction, severity=severity, percent_grade=2.0,
                description=f"{severity} slope at {direction}°",
            )
            advice = slope_miss_advice(slope, approach_bearing_deg=0.0)
            assert advice is not None
            outputs.append(advice)
    return outputs


def _decade_advice_samples() -> list[str]:
    outputs: list[str] = []

    aim_hazard = Hazard(type="water", side="left", penalty_severity="death", distance_from_green=5.0)
    aim_advice = decade_aim_advice([aim_hazard], shot_distance_yds=150.0)
    assert aim_advice is not None
    outputs.append(aim_advice)

    landing_hazard = Hazard(type="water", side="left", line_side="left", carry_yards=240, penalty_severity="death")
    landing_advice = decade_landing_advice([landing_hazard], expected_advance_yds=250, leave_yds=150)
    assert landing_advice is not None
    outputs.append(landing_advice)

    center_hazard = Hazard(type="water", side="center", line_side="center", carry_yards=250, penalty_severity="death")
    cross_line = cross_hazard_line([center_hazard], 250.0)
    assert cross_line is not None
    outputs.append(cross_line)

    return outputs


def _compose_degraded_line_sample() -> str:
    """One read-only invocation — `compose_degraded_line` stays KEEP-AS-IS
    (persona.md §3 row 3); this only pins that it doesn't carry banned
    register literals, it is never edited to change its wording."""
    rec = {
        "club": "driver",
        "raw_yards": 400,
        "target_yards": 410,
        "shot_kind": "tee",
        "miss_side": {"preferred": "right"},
    }
    green_read = {"available": False}
    carries = {"carries": []}
    return compose_degraded_line(rec, green_read, carries)


def _scan_targets() -> dict[str, str]:
    """Exactly the surfaces persona.md §2 designates for the deterministic
    slice: the shared constant + every ADOPT/KEEP-AS-IS prompt/template, the
    built-in personas, the DECADE/slope sub-templates, and one degraded-line
    sample."""
    targets: dict[str, str] = {
        "CADDIE_HOUSE_REGISTER": CADDIE_HOUSE_REGISTER,
        "_BASE_BEHAVIOR": voice_prompts._BASE_BEHAVIOR,
        "_strategy_system()": strategy_mod._strategy_system(),
        "WRITER_SYSTEM": guide_writer.WRITER_SYSTEM,
        "COURSE_WRITER_SYSTEM": course_intel_writer.COURSE_WRITER_SYSTEM,
    }
    for persona_id, persona in personalities.PERSONALITIES.items():
        targets[f"personalities[{persona_id}].system_prompt"] = persona.system_prompt
        if persona.realtime_instructions:
            targets[f"personalities[{persona_id}].realtime_instructions"] = persona.realtime_instructions

    for i, sample in enumerate(_slope_advice_samples()):
        targets[f"slope_miss_advice[{i}]"] = sample
    for i, sample in enumerate(_decade_advice_samples()):
        targets[f"decade_advice[{i}]"] = sample
    targets["compose_degraded_line_sample"] = _compose_degraded_line_sample()
    return targets


def test_no_banned_register_literals_in_prompt_surfaces():
    targets = _scan_targets()
    offenders: list[str] = []
    for name, text in targets.items():
        lowered = text.lower()
        for literal in BANNED_REGISTER_LITERALS:
            if literal in lowered:
                offenders.append(f"{name!r} contains banned literal {literal!r}")
    assert not offenders, "\n".join(offenders)


# ── 3. Persona-doc banned-list pin (reference, not re-type) ────────────────


def test_banned_list_matches_persona_doc():
    """Direction of truth: the persona doc is the source. A doc edit that
    renames/removes a banned literal makes this test fail loudly, so the
    code list here can never silently drift from the contract. (Full
    markdown-backtick parsing is deliberately avoided as brittle — this
    containment pin is the documented "reference it" mechanism.)"""
    doc_path = pathlib.Path(__file__).resolve().parents[2] / "specs" / "caddie-orb-persona-consistency-persona.md"
    doc_text = doc_path.read_text()
    missing = [literal for literal in BANNED_REGISTER_LITERALS if literal not in doc_text]
    assert not missing, f"banned literals missing from persona doc §2: {missing}"


# ── 4. Cheap required-persona-marker spot checks (static, per doc §2) ──────


def test_hype_prompts_contain_an_exclamation_mark():
    hype = personalities.PERSONALITIES["hype"]
    assert "!" in hype.system_prompt


def test_professor_prompts_contain_why():
    professor = personalities.PERSONALITIES["professor"]
    assert "why" in professor.system_prompt.lower()


def test_strategist_prompts_contain_a_digit():
    strategist = personalities.PERSONALITIES["strategist"]
    assert any(ch.isdigit() for ch in strategist.system_prompt)


def test_classic_has_no_required_marker():
    """classic IS the baseline — absence of a required marker is a pass, not
    a failure. Nothing to assert; documents the contract."""
    assert "classic" in personalities.PERSONALITIES
