"""Unit tests for the output-language hard contract (Item A of
specs/caddie-detach-and-language-pin-plan.md).

Owner hard contract (2026-07-16): "The caddie should only speak in the user's
desired language which in this case is English. Never any other language."
Pinned via ONE seam (`app.caddie.language.desired_language`) and ONE shared
rule (`app.caddie.voice_prompts.output_language_rule`), wired into: the
realtime instructions, both text-mouth `stable_text` blocks (routes/caddie.py),
the input transcription pin (realtime_relay.py), and documented as N/A for TTS
(openai_tts.py has no language payload field).

No network, no real database — `app.caddie.voice_prompts` transitively imports
`app.db.models` -> `app.db.engine`, which raises at import time when
DATABASE_URL isn't configured, so we stub it first (same pattern as
tests/test_input_grounding_prompt.py / test_epistemic_humility_prompt.py).
"""

import inspect
import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

from app.caddie.hazards import HAZARD_GROUNDING_RULE  # noqa: E402
from app.caddie.language import desired_language  # noqa: E402
from app.caddie.types import CaddiePersonality  # noqa: E402
from app.caddie.voice_prompts import (  # noqa: E402
    build_realtime_instructions,
    output_language_rule,
)
from app.services import openai_tts  # noqa: E402
from app.services.realtime_relay import build_session_payload  # noqa: E402


def _personality(**kwargs) -> CaddiePersonality:
    base = dict(
        id="classic",
        name="Classic Caddie",
        description="A steady, no-nonsense caddie.",
        avatar="⛳",
        system_prompt="You are a steady, experienced caddie.",
    )
    base.update(kwargs)
    return CaddiePersonality(**base)


def test_desired_language_is_english():
    lang = desired_language()
    assert lang.code == "en"
    assert lang.name == "English"


def test_output_language_rule_nonempty_and_defensive():
    rule = output_language_rule()
    assert rule.strip() != ""
    assert "ONLY English" in rule
    # Defensive substrings closing the drift paths an owner has actually hit:
    # ambient/background speech, an explicit switch request, never-mix.
    assert "background voices" in rule
    assert "asks you to switch" in rule
    assert "never mix languages" in rule


def test_output_language_rule_in_realtime_instructions():
    personality = _personality(realtime_instructions="Speak plainly and keep it short.")
    instructions = build_realtime_instructions(personality)

    assert output_language_rule() in instructions


def test_output_language_rule_ordering_first_in_behavior_block():
    """output_language_rule() must land FIRST in the behavior block — right
    after _BASE_BEHAVIOR, before HAZARD_GROUNDING_RULE — so it can't disturb
    the DECISION_GROUNDING_RULE endswith pins in tests/test_voice_stream.py."""
    personality = _personality(realtime_instructions="Speak plainly.")
    instructions = build_realtime_instructions(personality)

    behavior_idx = instructions.index("# Behavior")
    rule_idx = instructions.index(output_language_rule())
    hazard_idx = instructions.index(HAZARD_GROUNDING_RULE)
    assert behavior_idx < rule_idx < hazard_idx


def test_routes_caddie_wires_output_language_rule():
    """Pins the import + BOTH mirrored stable_text interpolations exist (a
    missing import would raise ImportError far away, at request time, not at
    review time — same pattern as test_input_grounding_prompt.py)."""
    from app.routes import caddie as caddie_routes

    assert caddie_routes.output_language_rule is output_language_rule
    source = inspect.getsource(caddie_routes)
    assert source.count("{output_language_rule()}") == 2, (
        "expected output_language_rule() interpolated into BOTH mirrored "
        "text-mouth stable_text blocks (_build_session_voice_prompt and "
        "_build_voice_prompt)"
    )


def test_seam_is_single_source_of_truth(monkeypatch):
    """Monkeypatching the seam changes both the rule text and the composed
    instructions — proves there's exactly one source of truth, not a copy."""
    import app.caddie.voice_prompts as voice_prompts

    from app.caddie.language import DesiredLanguage

    monkeypatch.setattr(
        voice_prompts, "desired_language", lambda: DesiredLanguage("es", "Spanish")
    )

    rule = voice_prompts.output_language_rule()
    assert "Spanish" in rule
    assert "English" not in rule

    personality = _personality(realtime_instructions="Speak plainly.")
    instructions = voice_prompts.build_realtime_instructions(personality)
    assert "Spanish" in instructions


def test_transcription_language_reads_the_seam():
    payload = build_session_payload("instructions", "sage")
    assert (
        payload["session"]["audio"]["input"]["transcription"]["language"]
        == desired_language().code
    )
    # Existing pin (test_realtime_payload.py::test_transcription_language_pinned_to_english)
    # stays green too — today's seam value is literally "en".
    assert payload["session"]["audio"]["input"]["transcription"]["language"] == "en"


def test_tts_payload_has_no_language_key():
    """TTS has no language param on /v1/audio/speech — output language is
    implicit from the (now-pinned) text. Guards against a future out-of-seam
    hardcode of a "language" payload key that doesn't exist on this endpoint."""
    source = inspect.getsource(openai_tts.synthesize_speech)
    payload_source = source.split("payload = {", 1)[1]
    assert '"language"' not in payload_source
