"""Desired-output-language seam — the ONE source of truth for what language the
caddie speaks (specs/caddie-detach-and-language-pin-plan.md, Item A).

Dependency-free (no `app.db` import) so `app.services.realtime_relay` — which
must stay import-light for the mint path — can import it directly.

Owner hard contract (2026-07-16): "The caddie should only speak in the user's
desired language which in this case is English. Never any other language."
Wired through four call sites, all reading this one function: the realtime
instructions rule, both text-mouth `stable_text` blocks, and the input
transcription pin. See `voice_prompts.output_language_rule()` for the prompt
text and `realtime_relay.build_session_payload` for the transcription pin.
"""

from typing import NamedTuple


class DesiredLanguage(NamedTuple):
    code: str  # "en" — machine-readable, for API fields (e.g. transcription.language)
    name: str  # "English" — human-readable, for prompt text


def desired_language() -> DesiredLanguage:
    """English always, until a per-user language setting ships.

    Owner 2026-07-06 / 2026-07-16: default English; a per-user setting comes
    later (backlog `voice-language-onboarding`). That feature changes ONLY
    this function's return value — every call site downstream stays correct.
    """
    return DesiredLanguage("en", "English")
