"""Cycle-4 fix — the bend-cap arms on evidence, not vibes
(specs/caddie-bench-cycle4-plan.md §A).

Owner incident (2026-07-25): "the caddie still recommends a 4 iron on a
clear driver hole." Root cause: the pre-fix arming condition — a mapped
corner + ANY tree hazard within a 60y window of the vertex — carries zero
information about corner SHARPNESS or DANGER. Every mapped tree hazard is
hardcoded ``penalty_severity="moderate"`` (hazards.py), so the severity
filter was vacuously satisfied by every tree, and the discarded lateral
offset meant the cap couldn't tell a 5y-off tree from a 65y-off one. Two
independent fixes close this:

  A1 — CORNER_MIN_DEVIATION_FRACTION (aim_point.py): a corner only arms the
       cap when its chord deviation is >=30% of its own tee-anchored
       distance — i.e. the hole genuinely TURNS there. Empirically separates
       the owner's false positives (0.10-0.19) from every pinned genuine
       corner (0.39-0.52).
  A2 — CORNER_TREE_MAX_LATERAL_YDS (aim_point.py) + Hazard.lateral_yards
       (types.py): corner-guarding tree evidence only counts within 45y of
       the played line — defense-in-depth for REAL mapped tree data, where
       an offset is actually measured (it is always None, hence inert, on
       every hand-built test hazard and every legacy cache entry).
  A4 — _BEND_NEAR_GREEN_EXCLUDE_YDS (hazards.py, extract_hole_bend): a
       candidate bend vertex within 40y of the green describes the green
       surround, not a dogleg — a DELIBERATE GLOBAL correction (HoleBend.
       straight also drives the spoken hole-shape line and the P2 "corner is
       your landing zone" color line, not just club selection).

Attribution note (verified below, part (a)): on the owner's OWN incident
geometry, A1 alone (the fraction gate) is what turns the 4-iron back into
driver — a hand-built hazard's ``lateral_yards`` is always None, so A2's
lateral bound never disqualifies it either way. A2 gets its own dedicated
coverage in part (c), with a REAL measured lateral offset, so that code path
isn't proven only by omission.
"""

from __future__ import annotations

from pathlib import Path

from app.caddie import aim_point, hazards
from app.caddie.aim_point import generate_recommendation
from app.caddie.hazards import extract_hole_bend, format_bend_line
from app.caddie.types import Hazard, HoleBend, HoleIntelligence
from tests.eval.caddie_bench.geometry import load_hole_fixture, hole_intel_from_fixture
from tests.test_hazards import _TEE_LAT, _TEE_LON, _fc, _point_north_east, _square_polygon

_BENCH_HOLES_DIR = Path(__file__).parent / "eval" / "caddie_bench" / "fixtures" / "holes"

# The owner's real bag (hcp 3.0, driver 300 — specs/caddie-yardage-selector-
# p0-plan.md §3.2), matching test_corner_tree_forward_bound.py's _OWNER_BAG
# exactly.
_OWNER_BAG: dict[str, int] = {
    "driver": 300, "3wood": 270, "4iron": 230, "5iron": 215, "6iron": 195,
    "7iron": 180, "8iron": 170, "9iron": 155, "pw": 140, "gw": 127, "sw": 115, "lw": 90,
}


def _inject_corner_tree(
    hole: HoleIntelligence, carry_yards: int, lateral_yards: float | None,
) -> HoleIntelligence:
    """A single moderate corner tree at the mapped bend, at the given lateral
    offset — the "corner tree evidence" the owner's real geometry doesn't
    itself carry (neither Black 4 nor Pebble 3 has a tree within the
    corner-guarding window pre-injection, verified)."""
    tree = Hazard(
        type="trees", side="left", line_side="left",
        carry_yards=carry_yards, penalty_severity="moderate", lateral_yards=lateral_yards,
    )
    return hole.model_copy(update={"hazards": [*hole.hazards, tree]})


# ── (a) The headline proof: the owner's actual incident, on the REAL       ──
#     committed bench fixtures — driver after the fix, 4-iron before it     ──


def test_black4_incident_driver_after_fix_4iron_before(monkeypatch):
    """bethpage_black_h4 (par 5, 517y, bend@265 dev51, dev/dist 0.19 — a
    FALSE POSITIVE per specs/caddie-bench-cycle4-plan.md §0): a clear driver
    hole the pre-fix cap was ruining. One injected moderate corner tree at
    ~30y lateral (owner bag, hcp 3.0). RED (pre-fix, reproduced via
    monkeypatching CORNER_MIN_DEVIATION_FRACTION to 0 — the old, information-
    free arming condition) -> 4-iron. GREEN (post-fix) -> driver.

    Attribution: the injected tree's lateral_yards=30.0 is well inside
    CORNER_TREE_MAX_LATERAL_YDS (45) on BOTH sides of this test, so A2 (the
    lateral bound) never fires either way here — this test isolates A1 (the
    fraction gate) alone, which is the actual mechanism that closes the
    owner's incident."""
    fx = load_hole_fixture(_BENCH_HOLES_DIR / "bethpage_black_h4.json")
    assert fx.par == 5 and fx.yards == 517
    hole = hole_intel_from_fixture(fx)
    assert hole.bend is not None and not hole.bend.straight
    assert hole.bend.distance_yards == 265 and hole.bend.deviation_yards == 51
    hole = _inject_corner_tree(hole, carry_yards=hole.bend.distance_yards, lateral_yards=30.0)

    rec_after = generate_recommendation(hole, fx.yards, _OWNER_BAG, handicap=3.0)
    assert rec_after.club == "driver", (
        f"AFTER the fix, Black 4 (a clear driver hole) must recommend driver — got {rec_after.club!r}"
    )

    monkeypatch.setattr(aim_point, "CORNER_MIN_DEVIATION_FRACTION", 0.0)
    rec_before = generate_recommendation(hole, fx.yards, _OWNER_BAG, handicap=3.0)
    assert rec_before.club == "4iron", (
        f"PRE-fix (unconditional arming) must reproduce the owner's exact incident "
        f"(4-iron on a clear driver hole) — got {rec_before.club!r}"
    )


def test_pebble3_incident_driver_after_fix_4iron_before(monkeypatch):
    """pebble_beach_h3 (par 4, 381y, bend@265 dev48, dev/dist 0.18 — a FALSE
    POSITIVE per §0), same shape of proof as Black 4 above."""
    fx = load_hole_fixture(_BENCH_HOLES_DIR / "pebble_beach_h3.json")
    assert fx.par == 4 and fx.yards == 381
    hole = hole_intel_from_fixture(fx)
    assert hole.bend is not None and not hole.bend.straight
    assert hole.bend.distance_yards == 265 and hole.bend.deviation_yards == 48
    hole = _inject_corner_tree(hole, carry_yards=hole.bend.distance_yards, lateral_yards=30.0)

    rec_after = generate_recommendation(hole, fx.yards, _OWNER_BAG, handicap=3.0)
    assert rec_after.club == "driver", (
        f"AFTER the fix, Pebble 3 (a clear driver hole) must recommend driver — got {rec_after.club!r}"
    )

    monkeypatch.setattr(aim_point, "CORNER_MIN_DEVIATION_FRACTION", 0.0)
    rec_before = generate_recommendation(hole, fx.yards, _OWNER_BAG, handicap=3.0)
    assert rec_before.club == "4iron", (
        f"PRE-fix (unconditional arming) must reproduce the owner's exact incident "
        f"(4-iron on a clear driver hole) — got {rec_before.club!r}"
    )


# ── (b) Boundary tests at fraction 0.30 exactly ────────────────────────────

_BOUNDARY_BAG: dict[str, int] = {"driver": 280, "3wood": 240, "5wood": 220, "hybrid": 200, "7iron": 160}


def _hazards_both_sides(carry: int) -> list[Hazard]:
    return [
        Hazard(type="trees", side="left", line_side="left", carry_yards=carry, penalty_severity="moderate"),
        Hazard(type="trees", side="right", line_side="right", carry_yards=carry, penalty_severity="moderate"),
    ]


def test_deviation_fraction_just_below_030_no_cap():
    """deviation_yards=67 at distance_yards=226 -> 67/226 = 0.2965..., just
    BELOW the 0.30 gate — must not arm the cap (driver stands)."""
    bend = HoleBend(straight=False, direction="left", distance_yards=226, deviation_yards=67)
    hole = HoleIntelligence(hole_number=3, par=4, yards=400, hazards=_hazards_both_sides(230), bend=bend)
    rec = generate_recommendation(hole, 400, _BOUNDARY_BAG, handicap=15)
    assert rec.tee_shot_numbers is not None
    assert rec.tee_shot_numbers.club == "driver"


def test_deviation_fraction_at_030_caps():
    """deviation_yards=68 at distance_yards=226 -> 68/226 = 0.3009..., AT/
    just above the 0.30 gate — must arm the cap (off an off-by-one)."""
    bend = HoleBend(straight=False, direction="left", distance_yards=226, deviation_yards=68)
    hole = HoleIntelligence(hole_number=3, par=4, yards=400, hazards=_hazards_both_sides(230), bend=bend)
    rec = generate_recommendation(hole, 400, _BOUNDARY_BAG, handicap=15)
    assert rec.tee_shot_numbers is not None
    assert rec.tee_shot_numbers.club != "driver"


# ── (c) The lateral bound (A2), with a REAL measured offset — dedicated    ──
#     coverage so this code path is proven, not merely inert by omission    ──

_LATERAL_BEND = HoleBend(straight=False, direction="left", distance_yards=226, deviation_yards=88)  # 0.389, well above 0.30


def _hole_with_lateral_tree(lateral_yards: float | None) -> HoleIntelligence:
    tree = Hazard(
        type="trees", side="left", line_side="left",
        carry_yards=_LATERAL_BEND.distance_yards, penalty_severity="moderate", lateral_yards=lateral_yards,
    )
    return HoleIntelligence(hole_number=3, par=4, yards=400, hazards=[tree], bend=_LATERAL_BEND)


def test_corner_tree_44y_lateral_still_caps():
    """Just INSIDE CORNER_TREE_MAX_LATERAL_YDS (45) — still guards the corner."""
    hole = _hole_with_lateral_tree(44.0)
    rec = generate_recommendation(hole, 400, _BOUNDARY_BAG, handicap=15)
    assert rec.tee_shot_numbers is not None
    assert rec.tee_shot_numbers.club != "driver"
    assert any("runs through the corner" in line for line in rec.reasoning)


def test_corner_tree_46y_lateral_no_longer_caps():
    """Just OUTSIDE the 45y bound — a tree edge that far off the line is
    ~2.6 sigma for a hcp-15 driver cone, not "guarding" — must not cap."""
    hole = _hole_with_lateral_tree(46.0)
    rec = generate_recommendation(hole, 400, _BOUNDARY_BAG, handicap=15)
    assert rec.tee_shot_numbers is not None
    assert rec.tee_shot_numbers.club == "driver"


def test_corner_tree_unknown_lateral_never_disqualifies():
    """`lateral_yards=None` (legacy cache / hand-built fixture — unknown is
    unknown, [[no-fake-data-fallbacks]]) must NEVER disqualify — still caps."""
    hole = _hole_with_lateral_tree(None)
    rec = generate_recommendation(hole, 400, _BOUNDARY_BAG, handicap=15)
    assert rec.tee_shot_numbers is not None
    assert rec.tee_shot_numbers.club != "driver"


# ── (d) A4 — near-green vertex exclusion in extract_hole_bend ─────────────
#     A DELIBERATE GLOBAL fix (not cap-local): also pins the spoken-line     ──
#     consumers (format_bend_line, the P2 "landing zone" reasoning line).   ──


def test_h18_near_green_vertex_excluded_demotes_to_the_real_minor_wobble(monkeypatch):
    """bethpage_black_h18 (par 4, 411y, plays dead straight per the owner).

    MEASURED FINDING that diverges from the plan's own prediction ("Result:
    h18 -> straight=True (remaining candidates deviate < 15y)") — flagged
    here rather than silently forced true, per this session's ground rules
    (never fabricate an assertion to match a spec's unverified prediction).
    h18 actually has TWO candidate bend vertices, not one:
      - along ~396y, dev ~41y, remaining-to-green ~18y — the green-surround
        artifact this fix targets (excluded by A4, correctly).
      - along ~276y, dev ~24y, remaining-to-green ~139y — a real, mapped,
        MUCH gentler wobble (dev/dist ~0.087) that was previously masked
        because the near-green artifact's larger deviation always won the
        argmax. A4 excludes only the near-green candidate; it does not
        (and per the plan's stated mechanism, was never designed to)
        re-evaluate whether what's LEFT still clears the independent 15y
        "straight" threshold (_BEND_MIN_DEVIATION_YARDS, unrelated to A4).

    So post-fix, Black 18 is measurably LESS wrong (the spoken/P2 bend line
    now cites ~275y and a much gentler shape, not the phantom ~395y
    green-surround artifact) but not silent for every bag — a driver in the
    220-340y corridor-note window (e.g. 280-300y, the common case) still
    reports "Fairway bends left at ~275" in the P2 color line. This is
    orthogonal to the owner's actual reported incident (club selection):
    dev/dist 0.087 is far below CORNER_MIN_DEVIATION_FRACTION (0.30) either
    way, so the corridor bend-cap NEVER arms on this hole, before or after
    A4 — verified below alongside the near-green exclusion itself."""
    fx = load_hole_fixture(_BENCH_HOLES_DIR / "bethpage_black_h18.json")
    assert fx.par == 4 and fx.yards == 411

    hole_after = hole_intel_from_fixture(fx)
    assert hole_after.bend is not None and hole_after.bend.straight is False
    assert hole_after.bend.distance_yards == 275 and hole_after.bend.deviation_yards == 24
    assert hole_after.bend.deviation_yards < aim_point.CORNER_MIN_DEVIATION_FRACTION * hole_after.bend.distance_yards, (
        "sanity: the demoted wobble must sit well below the arming fraction — "
        "the cap must never fire on this hole regardless of the spoken-line residual"
    )
    assert format_bend_line(18, hole_after.bend) == "Hole 18 shape: doglegs left at ~275y"
    # The corridor bend-cap never arms here (fraction gate blocks it) for a
    # representative bag, even with a driver overshooting the vertex.
    rec_after = generate_recommendation(hole_after, fx.yards, {"driver": 280, "3wood": 230}, handicap=15)
    assert rec_after.club == "driver"
    assert not any("runs through the corner" in line for line in rec_after.reasoning)

    # Pre-fix repro (monkeypatch _BEND_NEAR_GREEN_EXCLUDE_YDS to 0 — the old
    # behavior): the near-green artifact wins the argmax outright and speaks
    # the WORSE, phantom ~395y bend.
    monkeypatch.setattr(hazards, "_BEND_NEAR_GREEN_EXCLUDE_YDS", 0.0)
    hole_before = hole_intel_from_fixture(fx)
    assert hole_before.bend is not None and hole_before.bend.straight is False
    assert hole_before.bend.distance_yards == 395
    assert format_bend_line(18, hole_before.bend) == "Hole 18 shape: doglegs left at ~395y"
    bag = {"driver": 350, "3wood": 300}  # driver window (290-410) brackets the phantom 395y vertex
    rec_before = generate_recommendation(hole_before, fx.yards, bag, handicap=15)
    assert any("bends left at ~395" in line for line in rec_before.reasoning), (
        f"pre-fix repro must reproduce the phantom bend line — reasoning: {rec_before.reasoning}"
    )


def _hole_way_with_vertex(green_lonlat: tuple[float, float], north: float, lateral: float) -> dict:
    v_lon, v_lat = _point_north_east(_TEE_LON, _TEE_LAT, north, lateral)
    green_lon, green_lat = green_lonlat
    return {
        "type": "Feature", "properties": {"featureType": "hole"},
        "geometry": {"type": "LineString", "coordinates": [
            [_TEE_LON, _TEE_LAT], [v_lon, v_lat], [green_lon, green_lat],
        ]},
    }


def test_near_green_exclusion_boundary_synthetic():
    """A synthetic control on the exact boundary of _BEND_NEAR_GREEN_EXCLUDE_
    YDS (40y): a genuinely sharp corner (30y lateral, well above the 15y
    straight threshold) 17y from the green (the Black-18 shape) is excluded
    -> straight; the SAME corner 41y from the green is NOT excluded -> a
    real, measured bend. Proves the exclusion is a near-green boundary rule,
    not a blanket "ignore late bends" rule."""
    green_lon, green_lat = _point_north_east(_TEE_LON, _TEE_LAT, 400, 0)
    tee_feat = _square_polygon("tee", _TEE_LON, _TEE_LAT)
    green_feat = _square_polygon("green", green_lon, green_lat)

    # Vertex 17y short of the green (remaining < 40y) — excluded.
    inside_way = _hole_way_with_vertex((green_lon, green_lat), north=383, lateral=-30)
    bend_inside = extract_hole_bend(_fc(tee_feat, green_feat, inside_way))
    assert bend_inside is not None
    assert bend_inside.straight is True, f"a vertex 17y from the green must be excluded, got {bend_inside}"

    # Same corner, 41y short of the green (remaining >= 40y) — NOT excluded.
    outside_way = _hole_way_with_vertex((green_lon, green_lat), north=359, lateral=-30)
    bend_outside = extract_hole_bend(_fc(tee_feat, green_feat, outside_way))
    assert bend_outside is not None
    assert bend_outside.straight is False, f"a vertex 41y from the green must NOT be excluded, got {bend_outside}"
    assert abs(bend_outside.distance_yards - 359) <= 5
