"""THE Red-1 acceptance gate — specs/caddie-two-tier-routing-plan.md §11.

Owner incident class ("10th wrong-side recurrence"): Bethpage RED hole 1 has
real trees close on the LEFT off the tee (per `tests/fixtures/
bethpage_red_trees.json`'s already-verified ±5y geodesic ground truth —
`trees L 265-480y` — see `tests/test_tree_span_gap.py`). A cached strategy
guide can correctly NAME that hazard (passing `validate_guide`'s hazard/
side/carry grounding cleanly) and still advise favoring/aiming straight into
it. This is the poison class the read-time verdict gate
(`app.caddie.verdict`) and the verdict-pinned validator
(`strategy.py::validate_strategy_text`) exist to catch.

Offline, fixture-only — no DB, no network, no prod/staging access. The
poisoned guide is a hand-built RECONSTRUCTION (`_provenance: "reconstructed"`
in the fixture file), not fetched from any live source.
"""

from __future__ import annotations

import json
import os
import pathlib

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from app.caddie import strategy as strategy_mod  # noqa: E402
from app.caddie import tools as tools_mod  # noqa: E402
from app.caddie.hazards import extract_hole_hazards  # noqa: E402
from app.caddie.session import RoundSession  # noqa: E402
from app.caddie.strategy_turn import run_strategy_turn  # noqa: E402
from app.caddie.types import HoleIntelligence, HoleStrategyGuide  # noqa: E402

FIXTURES_DIR = pathlib.Path(__file__).parent / "fixtures"
TREES_FIXTURE_PATH = FIXTURES_DIR / "bethpage_red_trees.json"
POISONED_GUIDE_FIXTURE_PATH = FIXTURES_DIR / "bethpage_red1_poisoned_guide.json"

_HOLE1_YARDS = 420
_HOLE1_PAR = 4
_DRIVER_STORED_YARDS = 300


@pytest.fixture(autouse=True)
def _no_db_persist(monkeypatch):
    """`recommend_payload` persists via `sessions.set_recommendation` and
    `player_profile_payload` reads via `memory_mod.get_player_profile` —
    both real DB calls, irrelevant to what this file tests. No-op, mirroring
    `tests/eval/test_strategy_tool.py`'s fixture of the same name."""

    async def _noop_set_recommendation(round_id, recommendation, current_hole):
        return None

    async def _no_profile(user_id):
        return None

    monkeypatch.setattr(tools_mod.sessions, "set_recommendation", _noop_set_recommendation)
    monkeypatch.setattr(tools_mod.memory_mod, "get_player_profile", _no_profile)


@pytest.fixture(autouse=True)
def _clear_strategy_cache():
    strategy_mod._CACHE.clear()
    yield
    strategy_mod._CACHE.clear()


def _build_fc(hole: dict) -> dict:
    """Reconstruction recipe pinned by specs/caddie-tree-span-gap-plan.md
    §4a — identical to `test_tree_span_gap.py::_build_fc` (each tee geometry
    as `featureType: "tee"`, `green_geom` as `"green"`, `hole_line` as a
    `"hole"` LineString, each tree feature with `featureType` = its `ft`)."""
    features: list[dict] = []
    for tee_geom in hole["tees"]:
        features.append({"type": "Feature", "properties": {"featureType": "tee"}, "geometry": tee_geom})
    features.append({"type": "Feature", "properties": {"featureType": "green"}, "geometry": hole["green_geom"]})
    features.append({
        "type": "Feature",
        "properties": {"featureType": "hole"},
        "geometry": {"type": "LineString", "coordinates": hole["hole_line"]},
    })
    for tf in hole["tree_features"]:
        features.append({"type": "Feature", "properties": {"featureType": tf["ft"]}, "geometry": tf["geom"]})
    return {"type": "FeatureCollection", "features": features}


def _hole1_hazards() -> list:
    fixture = json.loads(TREES_FIXTURE_PATH.read_text())
    fc = _build_fc(fixture["1"])
    return [hz for hz in extract_hole_hazards(fc) if hz.type == "trees"]


def _poisoned_guide() -> HoleStrategyGuide:
    data = json.loads(POISONED_GUIDE_FIXTURE_PATH.read_text())
    assert data["_provenance"] == "reconstructed"
    return HoleStrategyGuide(**data["guide"])


def _hole1_session(*, with_guide: bool) -> RoundSession:
    return RoundSession(
        round_id="round-1",
        user_id="user-1",
        current_hole=1,
        hole_intel={
            1: HoleIntelligence(
                hole_number=1,
                par=_HOLE1_PAR,
                yards=_HOLE1_YARDS,
                hazards=_hole1_hazards(),
                strategy_guide=_poisoned_guide() if with_guide else None,
            )
        },
        club_distances={"driver": _DRIVER_STORED_YARDS},
    )


class _FakeSynth:
    """Counting async stand-in for `strategy_mod.synthesize_strategy` —
    mirrors `tests/eval/test_strategy_tool.py::_FakeSynth`."""

    def __init__(self, *, text: str) -> None:
        self.text = text
        self.calls = 0

    async def __call__(self, ground_truth: str, *, model: str):
        self.calls += 1
        return self.text, {"input_tokens": 500, "output_tokens": 40}


_CLEAN_NARRATIVE = (
    "Hit driver, commit to the fairway, that leaves a comfortable approach into a calm green."
)


async def test_red1_black_tee_ask_produces_favor_right_or_center_never_left_with_poisoned_guide_present(
    monkeypatch,
):
    session = _hole1_session(with_guide=True)

    # 1. The read-time verdict gate must drop the poisoned guide before it
    #    ever reaches the brain payload.
    payload = await strategy_mod.build_strategy_payload(
        session, "round-1", "user-1", 1, hole_yards=_HOLE1_YARDS, yardage_basis="tee-card",
    )
    assert payload["local_knowledge"] == ""

    # 2. The ground truth carries the real left trees in the drive zone
    #    ("trees LEFT from ~265") — the poison's hazard NAMING was correct;
    #    only its favor-side advice was wrong.
    hazards_line = payload["conditions"]["hazards_line"] or ""
    assert "trees L 265" in hazards_line or "trees L 265-480y" in hazards_line
    left_tree_hazards = [h for h in _hole1_hazards() if h.line_side == "left" and h.carry_yards >= 265]
    assert left_tree_hazards, "fixture sanity: hole 1 must have left trees from >= 265y"

    # 3. The engine's own verdict never favors LEFT, and the spoken text
    #    (validated or degraded — synth is monkeypatched to a clean,
    #    non-lateral narrative) never contains a left-favor phrase.
    rec = payload["recommendation"]
    assert rec.get("error") is None
    assert rec["miss_side"]["preferred"] in ("center", "right")

    fake_synth = _FakeSynth(text=_CLEAN_NARRATIVE)
    monkeypatch.setattr(strategy_mod, "synthesize_strategy", fake_synth)

    result = await run_strategy_turn(
        session, "round-1", "user-1", 1, hole_yards=_HOLE1_YARDS, yardage_basis="tee-card",
    )
    spoken = (result["strategy"] or "").lower()
    assert "favor the left" not in spoken
    assert "miss left" not in spoken
    assert "left is the" not in spoken

    # 4. The verdict pin itself would have caught the poison even if the
    #    model had repeated a left-favor narrative verbatim.
    left_favor_narrative = "Hit driver, favor the left side off the tee, commit to the shot."
    assert strategy_mod.validate_strategy_text(
        left_favor_narrative, payload["conditions"]["hazards"] or [], recommendation=rec,
    ) is None


async def test_red1_same_ask_twice_returns_same_club_and_side(monkeypatch):
    session = _hole1_session(with_guide=True)
    fake_synth = _FakeSynth(text=_CLEAN_NARRATIVE)
    monkeypatch.setattr(strategy_mod, "synthesize_strategy", fake_synth)

    first = await run_strategy_turn(
        session, "round-1", "user-1", 1, hole_yards=_HOLE1_YARDS, yardage_basis="tee-card",
    )
    second = await run_strategy_turn(
        session, "round-1", "user-1", 1, hole_yards=_HOLE1_YARDS, yardage_basis="tee-card",
    )

    assert fake_synth.calls == 1  # second call is a cache hit
    assert first["strategy"] == second["strategy"]
    assert first["degraded"] == second["degraded"]
