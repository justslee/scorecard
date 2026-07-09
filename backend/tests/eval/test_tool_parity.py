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


def test_tool_schema_identical_between_mouths():
    """For every tool: both mouths expose the same name set, and per-tool
    `description` and `parameters == input_schema` are deep-equal."""
    realtime_by_name = {t["name"]: t for t in realtime_relay.DEFAULT_TOOLS}
    text_by_name = {t["name"]: t for t in tools_mod.TEXT_TOOLS}

    assert set(realtime_by_name) == set(text_by_name)
    assert len(realtime_relay.DEFAULT_TOOLS) == len(tools_mod.TEXT_TOOLS) == len(tools_mod.CADDIE_TOOLS)

    for name, rt in realtime_by_name.items():
        tx = text_by_name[name]
        assert rt["type"] == "function", name
        assert rt["description"] == tx["description"], f"description drift on {name!r}"
        assert rt["parameters"] == tx["input_schema"], f"schema drift on {name!r}"

    # A hand-edit of the relay's DEFAULT_TOOLS (bypassing the registry) fails
    # here: the relay copy must be exactly the registry's realtime rendering.
    assert realtime_relay.DEFAULT_TOOLS == tools_mod.realtime_tools()


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
