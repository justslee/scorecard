"""Tool-schema drift test (specs/caddie-tool-loop-parity-plan.md D8c) —
DB-free, offline, runs in the ordinary backend CI gate.

Parity is BY CONSTRUCTION (one registry in app/caddie/tools.py rendered two
ways); these tests are the tripwire that keeps it that way — a hand-edit of
the relay's copy, a conditionally-varying tool list, or an order shuffle
(which would thrash the Anthropic prompt cache) all fail here.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import json  # noqa: E402

from app.caddie import tools as tools_mod  # noqa: E402
from app.services import realtime_relay  # noqa: E402


def test_text_tools_are_a_schema_equal_subset_of_realtime():
    """Amended contract (specs/caddie-smart-strategy-tool-plan.md §6.1,
    extended by specs/caddie-two-tier-routing-plan.md §9 for record_scores):
    the realtime mouth now carries realtime-only extras (get_strategy,
    record_scores) the text mouth never sees (nested-LLM circularity + the 6s
    tool-resolve timeout + prompt-cache stability — plan §1.1/§7; record_
    scores is dispatched client-side only, the server text loop can't reach
    it). Every TEXT_TOOLS entry must still be a byte-identical subset of the
    realtime rendering, and any new extra must be a CONSCIOUS, enumerated
    edit here — never a silent drift."""
    realtime_by_name = {t["name"]: t for t in realtime_relay.DEFAULT_TOOLS}
    text_by_name = {t["name"]: t for t in tools_mod.TEXT_TOOLS}

    assert set(text_by_name) <= set(realtime_by_name)
    for name, tx in text_by_name.items():
        rt = realtime_by_name[name]
        assert rt["type"] == "function", name
        assert rt["description"] == tx["description"], f"description drift on {name!r}"
        assert rt["parameters"] == tx["input_schema"], f"schema drift on {name!r}"

    # Realtime EXTRAS explicitly enumerated — a new extra must be added here consciously.
    assert set(realtime_by_name) - set(text_by_name) == {"get_strategy", "record_scores"}
    assert len(realtime_relay.DEFAULT_TOOLS) == len(tools_mod.CADDIE_TOOLS) + len(tools_mod.REALTIME_ONLY_TOOLS)

    # A hand-edit of the relay's DEFAULT_TOOLS (bypassing the registry) fails
    # here: the relay copy must be exactly the registry's realtime rendering.
    assert realtime_relay.DEFAULT_TOOLS == tools_mod.realtime_tools()


def test_realtime_tools_are_deterministically_ordered():
    """Prompt-cache-adjacent guard: the realtime tool list (CADDIE_TOOLS +
    REALTIME_ONLY_TOOLS) stays sorted by name and duplicate-free — an order
    shuffle or a name collision both fail here."""
    names = [t["name"] for t in tools_mod.realtime_tools()]
    assert names == sorted(names)
    assert len(set(names)) == len(names)


def test_text_tools_are_deterministically_ordered():
    """Prompt-cache guard (plan D7): TEXT_TOOLS is a module-level constant,
    sorted by name, serialized deterministically — it must never vary per
    request or mid-round."""
    names = [t["name"] for t in tools_mod.TEXT_TOOLS]
    assert names == sorted(names), "TEXT_TOOLS must be sorted by name"
    assert len(set(names)) == len(names), "duplicate tool names"

    # Two independent renderings serialize byte-identically.
    assert (
        json.dumps(tools_mod.TEXT_TOOLS, sort_keys=True)
        == json.dumps(tools_mod.anthropic_tools(), sort_keys=True)
    )
    assert tools_mod.TEXT_TOOLS == tools_mod.anthropic_tools()
