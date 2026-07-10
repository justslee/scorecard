"""MED-2 (2026-07-10 security review): persisted strategy guides are cached
FOREVER in the green feature's JSONB (types.py) and were validated ONLY at
WRITE time. A guide persisted by an older/weaker validator — before the
side-flip + synonym fail-closed hardening (2026-07-08/09) — was therefore
served verbatim on every read, missing today's grounding checks.

`/course-intel` now re-validates the persisted guide at READ time against the
SAME hazards the caddie will state (`intel.hazards`). Both caddie mouths — the
text mouth (routes/caddie.py `_build_*` prompt) and the realtime/voice mouth
(voice_prompts.py `_situation_block`) — read from `session.hole_intel`, which
is populated from this route's loop, so sanitizing here covers BOTH.

No network, no Postgres — the route is called directly with its module-level
dependencies monkeypatched (mirrors test_caddie_caching.py's direct-call
pattern).
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

from types import SimpleNamespace

import pytest  # noqa: E402

from app.caddie.types import (  # noqa: E402
    CourseIntelRequest,
    Hazard,
    HoleIntelligence,
    HoleStrategyGuide,
    WeatherConditions,
)
from app.routes import caddie as caddie_routes  # noqa: E402


# A green feature carrying a persisted guide — enough shape for
# _green_persisted_guide() to pull the blob and for the stored-features branch
# (which recomputes hazards) to run.
def _stored_hole_with_guide(guide: HoleStrategyGuide) -> dict:
    return {
        "number": 1,
        "features": {
            "features": [
                {
                    "properties": {
                        "featureType": "green",
                        "strategy_guide": guide.model_dump(),
                    }
                }
            ]
        },
    }


def _patch_route(monkeypatch, *, stored_hole: dict, extracted_hazards: list[Hazard],
                 returned_guide: HoleStrategyGuide):
    """Wire the route's deps so exactly the READ-time re-validation is exercised."""
    captured: dict = {}

    async def _fake_weather(lat, lng):
        return WeatherConditions()

    async def _fake_get(round_id):
        return SimpleNamespace(user_id="u1", course_id="c1")

    async def _fake_get_course(course_id):
        return {"holes": [stored_hole]}

    async def _fake_build_intel(**kwargs):
        # Parses/returns the persisted guide (as the real function does) with
        # hazards=[] — the route sets real hazards just after via extract_*.
        return HoleIntelligence(hole_number=1, par=4, yards=410,
                                strategy_guide=returned_guide, hazards=[])

    def _fake_extract_hazards(features, tee=None, green=None):
        return list(extracted_hazards)

    def _fake_extract_bend(features, tee=None, green=None):
        return None

    async def _fake_set_hole_intel(round_id, hole_intel_map, weather=None):
        captured["map"] = hole_intel_map

    monkeypatch.setattr(caddie_routes, "build_weather_conditions", _fake_weather)
    monkeypatch.setattr(caddie_routes.sessions, "get", _fake_get)
    monkeypatch.setattr(caddie_routes.courses_mapped, "get_course", _fake_get_course)
    monkeypatch.setattr(caddie_routes, "build_hole_intelligence", _fake_build_intel)
    monkeypatch.setattr(caddie_routes, "extract_hole_hazards", _fake_extract_hazards)
    monkeypatch.setattr(caddie_routes, "extract_hole_bend", _fake_extract_bend)
    monkeypatch.setattr(caddie_routes.sessions, "set_hole_intel", _fake_set_hole_intel)
    return captured


def _request() -> CourseIntelRequest:
    return CourseIntelRequest(
        hole_coordinates=[{"holeNumber": 1, "green": {"lat": 40.0, "lng": -73.0}}],
        course_lat=40.0,
        course_lng=-73.0,
    )


@pytest.mark.asyncio
async def test_persisted_guide_with_ungrounded_hazard_is_dropped_on_read(monkeypatch):
    """A persisted guide asserting a hazard our geometry does NOT contain is
    DROPPED at read (never reaches EITHER caddie mouth). Pre-fix the route did
    no read-time validation, so the guide survived into `session.hole_intel`
    and both the returned `holes` payload and both mouths injected it — this
    assertion went RED before the fix."""
    bad_guide = HoleStrategyGuide(
        play_line="Favor center; carry the water hazard fronting the green.",
    )
    captured = _patch_route(
        monkeypatch,
        stored_hole=_stored_hole_with_guide(bad_guide),
        extracted_hazards=[],  # clean hole — no mapped hazards
        returned_guide=bad_guide,
    )

    result = await caddie_routes.get_course_intel(_request(), round_id="r1", user_id="u1")

    # Dropped from the session cache both mouths read from...
    assert captured["map"][1].strategy_guide is None
    # ...and from the API response payload.
    assert result["holes"][0]["strategy_guide"] is None


@pytest.mark.asyncio
async def test_persisted_guide_with_side_flipped_hazard_is_dropped_on_read(monkeypatch):
    """The genuinely-newer check (side-flip, hardened 2026-07-08): a guide that
    names the RIGHT hazard type but the WRONG side vs our surveyed geometry —
    the shape an OLDER validator would have persisted — is now caught on read."""
    flipped = HoleStrategyGuide(
        play_line="Aim center; the fairway bunker sits well right off the tee.",
    )
    captured = _patch_route(
        monkeypatch,
        stored_hole=_stored_hole_with_guide(flipped),
        extracted_hazards=[Hazard(type="bunker", side="left", line_side="left", carry_yards=240)],
        returned_guide=flipped,
    )

    result = await caddie_routes.get_course_intel(_request(), round_id="r1", user_id="u1")

    assert captured["map"][1].strategy_guide is None
    assert result["holes"][0]["strategy_guide"] is None


@pytest.mark.asyncio
async def test_valid_persisted_guide_survives_read_revalidation_unchanged(monkeypatch):
    """Write-time behavior is preserved for VALID guides: a guide grounded in
    the real geometry passes read re-validation and still reaches both mouths.
    Guards against the re-validation over-rejecting good guides."""
    good = HoleStrategyGuide(
        play_line="Aim center-left; the fairway bunker is on the left at 240.",
        miss_side="Best miss is short-right.",
    )
    captured = _patch_route(
        monkeypatch,
        stored_hole=_stored_hole_with_guide(good),
        extracted_hazards=[Hazard(type="bunker", side="left", line_side="left", carry_yards=240)],
        returned_guide=good,
    )

    result = await caddie_routes.get_course_intel(_request(), round_id="r1", user_id="u1")

    assert captured["map"][1].strategy_guide is not None
    assert captured["map"][1].strategy_guide.play_line == good.play_line
    assert result["holes"][0]["strategy_guide"] is not None
