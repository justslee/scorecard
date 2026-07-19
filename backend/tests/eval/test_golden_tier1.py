"""Tier 1 — deterministic, offline eval over `golden/caddie_advice.jsonl`
(specs/caddie-advice-eval-plan.md §1, §4). Runs in the ordinary backend CI
gate: no LLM call, no network, no API key, no Postgres, no docker.

Same DB-free pattern as `test_epistemic_humility_prompt.py` /
`test_realtime_grounding.py` / `test_caddie_caching.py`: stub `DATABASE_URL`
+ `LOOPER_SECRETS_DISABLED` before any app import, then monkeypatch the four
DB-touching dependencies of `_build_session_voice_prompt` exactly the way
`test_caddie_caching.py` does. `build_realtime_instructions` needs no
patching at all — it's pure.

For each scenario, both mouths are assembled from a synthetic `RoundSession`
built from the scenario's `situation` (`checks.resolve_hazards` /
`checks.build_round_session`), then every `tier1` check is run through the
`TIER1_CHECKS` registry.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from app.caddie.types import CaddiePersonality  # noqa: E402
from app.caddie.voice_prompts import build_realtime_instructions  # noqa: E402
from app.routes import caddie as caddie_routes  # noqa: E402

from tests.eval import checks as checks_mod  # noqa: E402
from tests.eval.schema import GOLDEN_SET_PATH, Scenario, Tier1CheckName, load_golden_set  # noqa: E402


SCENARIOS: list[Scenario] = load_golden_set(GOLDEN_SET_PATH)


def _classic_personality() -> CaddiePersonality:
    return CaddiePersonality(
        id="classic", name="Classic Caddie", description="A steady, experienced caddie.",
        avatar="⛳", system_prompt="You are a steady, experienced caddie.",
    )


async def _fake_personality_visible_always(persona_id, user_id=None):
    return True


async def _fake_load_personality_classic(persona_id, user_id=None):
    return _classic_personality()


async def _noop_set_current_hole(round_id, hole_number):
    return None


async def _no_memories(user_id):
    return []


def _patch_session_builder_deps(monkeypatch, session):
    async def _fake_get_owned_session(round_id, user_id):
        return session

    monkeypatch.setattr(caddie_routes, "get_owned_session", _fake_get_owned_session)
    monkeypatch.setattr(caddie_routes, "personality_visible", _fake_personality_visible_always)
    monkeypatch.setattr(caddie_routes, "load_personality", _fake_load_personality_classic)
    monkeypatch.setattr(caddie_routes.sessions, "set_current_hole", _noop_set_current_hole)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _no_memories)


async def _build_prompts(scenario: Scenario, monkeypatch):
    session = checks_mod.build_round_session(scenario)
    _patch_session_builder_deps(monkeypatch, session)

    # specs/caddie-yardage-gps-selected-tee-plan.md §2.4: the yardage-context
    # line is now driven by the request (hole_yards/yardage_basis), not
    # hole_intel.yards — mirror what a real caller sends post-fix so the
    # golden set's "150 yards"/"186" literal checks still see the number.
    # 'card' is the closest analog to these flat synthetic scenarios (a bare
    # scorecard yardage, no live GPS/selected-tee signal in play).
    hole_yards = scenario.situation.hole.yards
    request = caddie_routes.SessionVoiceRequest(
        round_id="eval", transcript=scenario.situation.question,
        personality_id="classic", hole_number=scenario.situation.hole.number,
        hole_yards=hole_yards,
        yardage_basis="card" if hole_yards is not None else None,
    )
    system_blocks, messages, _persona_id = await caddie_routes._build_session_voice_prompt(request, "eval-user")
    text_prompt = system_blocks[0]["text"] + "\n\n" + system_blocks[1]["text"]
    text_situation_block = system_blocks[1]["text"]

    realtime_prompt = build_realtime_instructions(_classic_personality(), session=session)

    return checks_mod.build_tier1_context(
        scenario, text_prompt=text_prompt, text_situation_block=text_situation_block,
        realtime_prompt=realtime_prompt, text_messages=messages,
    )


# ── Registry closure (plan §7 item 6 / §8 fixture-drift risk) ──────────────


def test_check_names_registry_is_exhaustive():
    """Every `Tier1CheckName` enum member has a registered implementation,
    and vice versa — a check declared in the closed enum but never wired up
    (or a registry entry with no enum backing it) is a dead/orphaned check."""
    enum_values = {c.value for c in Tier1CheckName}
    assert enum_values == set(checks_mod.TIER1_CHECKS.keys())
    assert enum_values  # non-empty


def test_every_golden_check_name_is_registered():
    """Belt-and-suspenders on top of the pydantic enum: every tier1 check
    name actually used anywhere in the golden set resolves in the registry."""
    used = {check.check.value for s in SCENARIOS for check in s.expected.tier1}
    assert used <= set(checks_mod.TIER1_CHECKS.keys())
    assert used, "golden set exercises zero tier1 checks — likely a load-path bug"


def test_every_registered_check_is_exercised_by_at_least_one_scenario_or_teeth_test():
    """No dead checks (plan §7 item 6): a registry entry with zero coverage
    anywhere is untested machinery. Teeth-test coverage is verified
    separately in test_harness_has_teeth.py; this only checks the golden
    set's own usage, so a check exercised ONLY by teeth tests still needs
    its corresponding entry there (see that file's registry-closure test)."""
    used_in_golden = {check.check.value for s in SCENARIOS for check in s.expected.tier1}
    from tests.eval import test_harness_has_teeth as teeth

    used_in_teeth = teeth.TIER1_CHECKS_EXERCISED_BY_TEETH
    uncovered = set(checks_mod.TIER1_CHECKS.keys()) - used_in_golden - used_in_teeth
    assert not uncovered, f"tier1 check(s) with zero coverage in golden set AND teeth tests: {uncovered}"


def test_golden_set_has_the_five_required_seed_scenarios():
    required_ids = {
        "hole4-no-left-bunker-hallucination",
        "hole4-observed-reality-gaslight",
        "hole4-side-flip-guide",
        "no-hazard-data-honest-empty",
        "plays-like-uphill-club-call",
    }
    ids = {s.id for s in SCENARIOS}
    assert required_ids <= ids, f"missing required seed scenario(s): {required_ids - ids}"


def test_golden_set_is_nonempty():
    assert len(SCENARIOS) >= 5


# ── The actual scenario checks ──────────────────────────────────────────────


@pytest.mark.parametrize("scenario", SCENARIOS, ids=[s.id for s in SCENARIOS])
async def test_scenario_tier1_checks_pass(scenario: Scenario, monkeypatch):
    ctx = await _build_prompts(scenario, monkeypatch)

    failures = []
    for check in scenario.expected.tier1:
        fn = checks_mod.TIER1_CHECKS[check.check.value]
        result = fn(ctx, check)
        if not result.passed:
            failures.append(f"{check.check.value}: {result.detail}")

    assert not failures, f"scenario {scenario.id!r} failed tier1 check(s):\n" + "\n".join(failures)
