"""Unit tests for the shared tool payload helpers + server-side dispatcher
(app/caddie/tools.py — specs/caddie-tool-loop-parity-plan.md D2/D3).

No network, no Postgres. Focus: the `carries_payload` honest-empty matrix
([[no-fake-data-fallbacks]] — a carry is either the real mapped along-path
number or an explicit unavailable/empty, never fabricated) and the
`resolve_tool` contract the text tool loop depends on.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from app.caddie import tools as tools_mod  # noqa: E402
from app.caddie.session import RoundSession  # noqa: E402
from app.caddie.types import GreenSlope, Hazard, HoleIntelligence  # noqa: E402
from app.caddie.tools import (  # noqa: E402
    ToolContext,
    carries_payload,
    green_read_payload,
    resolve_tool,
    session_status_payload,
)


def _session(hole_intel=None, club_distances=None) -> RoundSession:
    return RoundSession(
        round_id="round-1",
        user_id="user-1",
        current_hole=4,
        hole_intel=hole_intel or {},
        club_distances=club_distances or {},
    )


def _hole4_intel(hazards) -> dict[int, HoleIntelligence]:
    return {4: HoleIntelligence(hole_number=4, par=4, yards=400, hazards=hazards)}


# ── carries_payload: the honest-empty matrix (plan D3) ──────────────────────


def test_carries_unmapped_hole_is_honestly_unavailable():
    """No hole_intel (course unmapped / intel not fetched) → available:false
    + reason — the tool description's contract; never an invented carry."""
    payload = carries_payload(_session(), 4)
    assert payload == {
        "round_id": "round-1",
        "hole_number": 4,
        "available": False,
        "reason": "No mapped hazard data for this hole.",
    }


def test_carries_mapped_hole_with_no_hazards_is_available_and_empty_with_note():
    """Intel present but zero hazards → a TRUE empty (distinct from
    'unknown'): available:true, carries:[], explicit note."""
    payload = carries_payload(_session(hole_intel=_hole4_intel([])), 4)
    assert payload["available"] is True
    assert payload["carries"] == []
    assert payload["note"] == "No mapped bunkers or water in play on this hole."


def test_carries_zero_carry_entries_are_filtered_out():
    """carry_yards == 0 (degenerate chord/polyline projection) is placeholder
    noise, not a number to speak — filtered, never returned."""
    hazards = [
        Hazard(type="bunker", side="left", line_side="left", carry_yards=0),
        Hazard(type="water", side="right", line_side="right", carry_yards=190),
    ]
    payload = carries_payload(_session(hole_intel=_hole4_intel(hazards)), 4)
    assert [c["carry_yards"] for c in payload["carries"]] == [190]
    assert payload["note"] is None


def test_carries_all_zero_carries_yields_empty_with_note():
    hazards = [Hazard(type="bunker", side="left", line_side="left", carry_yards=0)]
    payload = carries_payload(_session(hole_intel=_hole4_intel(hazards)), 4)
    assert payload["available"] is True
    assert payload["carries"] == []
    assert payload["note"] == "No mapped bunkers or water in play on this hole."


def test_carries_combines_real_carries_with_player_club_distances():
    hazards = [
        Hazard(type="bunker", side="left", line_side="left", carry_yards=245),
        Hazard(type="water", side="right", line_side="right", carry_yards=190),
    ]
    clubs = {"driver": 260, "3wood": 235, "5iron": 185, "7iron": 160, "9iron": 140}
    payload = carries_payload(_session(hole_intel=_hole4_intel(hazards), club_distances=clubs), 4)

    assert payload["available"] is True
    # Sorted by carry ascending; sides are the along-path line_side.
    assert [(c["type"], c["side"], c["carry_yards"]) for c in payload["carries"]] == [
        ("water", "right", 190),
        ("bunker", "left", 245),
    ]
    bunker = payload["carries"][1]
    assert bunker["clubs_that_clear"] == ["Driver"]
    # Nearest-below first, capped at 3.
    assert bunker["clubs_short_of_it"] == ["3 Wood", "5 Iron", "7 Iron"]
    # Display-named distances ride along for the model's own reasoning.
    assert payload["club_distances"]["Driver"] == 260


def test_carries_without_club_distances_omits_club_lists_never_infers():
    hazards = [Hazard(type="bunker", side="left", line_side="left", carry_yards=245)]
    payload = carries_payload(_session(hole_intel=_hole4_intel(hazards)), 4)
    entry = payload["carries"][0]
    assert entry["clubs_that_clear"] is None
    assert entry["clubs_short_of_it"] is None
    assert payload["club_distances"] == {}


# ── resolve_tool: the dispatcher contract the tool loop depends on ──────────


async def test_resolve_tool_unknown_name_mirrors_frontend_contract():
    ctx = ToolContext(session=_session(), round_id="round-1", user_id="user-1")
    out = await resolve_tool("summon_helicopter", {}, ctx)
    assert out == {"error": "Unknown tool: summon_helicopter"}


@pytest.mark.parametrize("name", sorted(t["name"] for t in tools_mod.CADDIE_TOOLS))
async def test_resolve_tool_stateless_ctx_answers_honestly_for_every_tool(name):
    """The stateless mouth (session=None): every tool says live numbers are
    unavailable — the model reports that instead of hallucinating them."""
    ctx = ToolContext(session=None, round_id=None, user_id="user-1", default_hole=3)
    out = await resolve_tool(name, {"hole_number": 3}, ctx)
    assert out["available"] is False
    assert "No active round session" in out["reason"]


async def test_resolve_tool_get_carries_falls_back_to_default_hole():
    hazards = [Hazard(type="water", side="right", line_side="right", carry_yards=190)]
    ctx = ToolContext(
        session=_session(hole_intel=_hole4_intel(hazards)),
        round_id="round-1", user_id="user-1", default_hole=4,
    )
    out = await resolve_tool("get_carries", {}, ctx)  # model omitted hole_number
    assert out["available"] is True
    assert [c["carry_yards"] for c in out["carries"]] == [190]


async def test_resolve_tool_get_carries_junk_args_and_no_default_is_a_calm_error():
    ctx = ToolContext(session=_session(), round_id="round-1", user_id="user-1", default_hole=None)
    out = await resolve_tool("get_carries", {"hole_number": "not-a-number"}, ctx)
    assert out == {"error": "get_carries requires hole_number"}


async def test_resolve_tool_record_shot_validates_args():
    ctx = ToolContext(session=_session(), round_id="round-1", user_id="user-1", default_hole=4)
    out = await resolve_tool("record_shot", {"club": "7iron"}, ctx)  # no distance
    assert out == {"error": "record_shot requires hole_number, club, and distance_yards"}


async def test_resolve_tool_get_session_status_reads_the_session():
    session = _session()
    ctx = ToolContext(session=session, round_id="round-1", user_id="user-1")
    out = await resolve_tool("get_session_status", {}, ctx)
    assert out == session_status_payload(session)
    assert out["round_id"] == "round-1"


# ── get_shot_distance: the physics tool flows through the SHARED machinery ──
# (specs/caddie-shot-physics-engine-plan.md step 6 — tool_loop.py needed ZERO
# changes: the registry renders it into TEXT_TOOLS and resolve_tool serves it.)


def test_shot_distance_tool_is_in_text_tools_registry():
    """The new tool reaches the text mouths automatically via TEXT_TOOLS —
    proof the loop needed no changes (it always passes the whole registry)."""
    names = [t["name"] for t in tools_mod.TEXT_TOOLS]
    assert "get_shot_distance" in names
    assert names == sorted(names)  # still name-sorted (prompt-cache guard)


async def test_resolve_tool_shot_distance_club_mode_runs_the_engine():
    """Club mode: the resolver pulls session club distances + weather + hole
    elevation and returns real integrated numbers (driver 300 in still air
    round-trips its stored total — the engine's pinned neutral behavior)."""
    ctx = ToolContext(
        session=_session(hole_intel=_hole4_intel([]), club_distances={"driver": 300}),
        round_id="round-1", user_id="user-1", default_hole=4,
    )
    out = await resolve_tool("get_shot_distance", {"club": "driver"}, ctx)
    assert out["available"] is True
    assert out["mode"] == "club"
    assert out["club"] == "driver"
    assert 296 <= out["total_yards"] <= 302  # neutral ≈ stored total (±2 + rounding)
    assert out["carry_yards"] + out["roll_yards"] == pytest.approx(out["total_yards"], abs=1)
    assert out["assumptions"]  # simplifications are always surfaced


async def test_resolve_tool_shot_distance_target_mode_solves_plays_like():
    clubs = {"8iron": 150, "7iron": 160, "6iron": 170}
    ctx = ToolContext(
        session=_session(hole_intel=_hole4_intel([]), club_distances=clubs),
        round_id="round-1", user_id="user-1", default_hole=4,
    )
    out = await resolve_tool("get_shot_distance", {"target_yards": 150}, ctx)
    assert out["available"] is True
    assert out["mode"] == "target"
    # Still air, flat hole → a target plays like itself (neutral identity).
    assert out["plays_like_yards"] == 150
    assert out["suggested_club"] in clubs


async def test_resolve_tool_shot_distance_no_stored_distance_is_honest():
    """[[no-fake-data-fallbacks]]: no stored 3-wood distance → available:false
    + reason, never a tour-average stand-in for the PLAYER's number."""
    ctx = ToolContext(
        session=_session(club_distances={"driver": 300}),
        round_id="round-1", user_id="user-1", default_hole=4,
    )
    out = await resolve_tool("get_shot_distance", {"club": "3wood"}, ctx)
    assert out["available"] is False
    assert "No stored distance" in out["reason"]


async def test_resolve_tool_shot_distance_requires_club_or_target():
    ctx = ToolContext(session=_session(), round_id="round-1", user_id="user-1", default_hole=4)
    out = await resolve_tool("get_shot_distance", {}, ctx)
    assert out == {"error": "get_shot_distance requires club and/or target_yards"}


async def test_resolve_tool_shot_distance_spoken_club_names_resolve():
    """The model says '7 iron', not '7iron' — aliases must resolve."""
    ctx = ToolContext(
        session=_session(club_distances={"7iron": 160}),
        round_id="round-1", user_id="user-1", default_hole=4,
    )
    out = await resolve_tool("get_shot_distance", {"club": "7 Iron"}, ctx)
    assert out["available"] is True
    assert out["club"] == "7iron"
    assert out["carry_yards"] == 160  # stored iron distances are carries


# ── get_green_read: honest-fallback matrix + the rotation engine ────────────
# (specs/caddie-green-slope-spatial-plan.md — flows through the SAME shared
# machinery pattern as get_shot_distance above.)


def test_green_read_tool_is_in_text_tools_registry():
    names = [t["name"] for t in tools_mod.TEXT_TOOLS]
    assert "get_green_read" in names
    assert names == sorted(names)  # still name-sorted (prompt-cache guard)


def test_green_read_payload_no_intel_is_honestly_unavailable():
    session = _session()
    out = green_read_payload(session, hole_number=4)
    assert out["available"] is False
    assert "No green slope mapped" in out["reason"]


def test_green_read_payload_intel_without_green_slope_is_honestly_unavailable():
    session = _session(hole_intel={4: HoleIntelligence(hole_number=4, par=4, yards=400)})
    out = green_read_payload(session, hole_number=4)
    assert out["available"] is False
    assert "No green slope mapped" in out["reason"]


def test_green_read_payload_slope_without_bearing_is_honestly_unavailable():
    """[[no-fake-data-fallbacks]]: a slope is mapped but the tee position (so
    the approach bearing) isn't known — available:false with a DISTINCT
    reason from the no-slope-mapped case, and the compass description is
    still surfaced, clearly labeled, so the model has something honest to
    say without being asked to translate it to a side itself."""
    session = _session(
        hole_intel={
            4: HoleIntelligence(
                hole_number=4, par=4, yards=400,
                green_slope=GreenSlope(
                    direction=270.0, severity="moderate", percent_grade=3.0,
                    description="Green slopes moderately toward the west",
                ),
                approach_bearing_deg=None,
            )
        }
    )
    out = green_read_payload(session, hole_number=4)
    assert out["available"] is False
    assert "can't orient the slope to your line" in out["reason"]
    assert out["reason"] != "No green slope mapped for this hole."
    assert out["slope_compass"] == "Green slopes moderately toward the west"


def test_green_read_payload_happy_path_matches_the_owner_golden_case():
    """β=0 (approach due north), α=270 (slopes west) -> uphill_leave_side
    "left" — the exact owner chain, end to end through the payload."""
    session = _session(
        hole_intel={
            4: HoleIntelligence(
                hole_number=4, par=4, yards=400,
                green_slope=GreenSlope(
                    direction=270.0, severity="moderate", percent_grade=3.0,
                    description="Green slopes moderately toward the west",
                ),
                approach_bearing_deg=0.0,
            )
        }
    )
    out = green_read_payload(session, hole_number=4)
    assert out["available"] is True
    assert out["fall_side"] == "left"
    assert out["high_side"] == "right"
    assert out["uphill_leave_side"] == "left"
    assert out["downhill_leave_side"] == "right"
    assert out["confidence"] == "high"
    assert "left" in out["read_line"].lower()
    assert out["assumptions"]  # tee->green approach frame is surfaced, never silent


async def test_resolve_tool_green_read_falls_back_to_default_hole():
    session = _session(
        hole_intel={
            4: HoleIntelligence(
                hole_number=4, par=4, yards=400,
                green_slope=GreenSlope(
                    direction=90.0, severity="moderate", percent_grade=3.0,
                    description="Green slopes moderately toward the east",
                ),
                approach_bearing_deg=0.0,
            )
        }
    )
    ctx = ToolContext(session=session, round_id="round-1", user_id="user-1", default_hole=4)
    out = await resolve_tool("get_green_read", {}, ctx)
    assert out["available"] is True
    assert out["hole_number"] == 4
    assert out["fall_side"] == "right"


async def test_resolve_tool_green_read_uses_explicit_hole_number():
    session = _session(
        hole_intel={
            9: HoleIntelligence(
                hole_number=9, par=3, yards=160,
                green_slope=GreenSlope(
                    direction=225.0, severity="severe", percent_grade=6.0,
                    description="Green slopes severely toward the southwest",
                ),
                approach_bearing_deg=0.0,
            )
        }
    )
    ctx = ToolContext(session=session, round_id="round-1", user_id="user-1", default_hole=4)
    out = await resolve_tool("get_green_read", {"hole_number": 9}, ctx)
    assert out["available"] is True
    assert out["hole_number"] == 9
    assert out["fall_side"] == "left"
