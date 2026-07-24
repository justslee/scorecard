"""The seam driver — `RoundSession`/`HoleIntelligence` assembly + the live
advice seam call (specs/caddie-bench-plan.md §1 harness.py, §3).

Every case runs entirely offline except the ONE OpenAI call inside
`run_strategy_turn` (`synth=None`) — CI/offline callers pass a canned `synth`
stub instead (§1: "synth=None means the REAL synthesize_strategy (LIVE runs);
CI passes a canned-answer stub").

Deterministic pre-checks (§5a) reuse the SAME machinery `app.caddie.strategy.
validate_strategy_text` is built from (`guide_writer._HAZARD_PATTERNS`,
`_has_side_flip`, `GUIDE_INJECTION_PATTERN`, `strategy._PIN_RELATIVE_PATTERN`)
and the SAME club-extraction the golden-set harness uses
(`tests.eval.substance.extract_substance`) — never a second, forked
implementation of any of these.
"""

from __future__ import annotations

import contextlib
import re
import time
from typing import Callable, Optional

from app.caddie import strategy as strategy_mod
from app.caddie import verdict as verdict_mod
from app.caddie.aim_point import (
    APPROACH_FRAME_MIN_TEE_OFFSET_YDS,
    EN_ROUTE_CLEARED_SUPPRESS_YDS,
    generate_recommendation,
)
from app.caddie.club_selection import normalize_club_distances
from app.caddie.guide_writer import GUIDE_INJECTION_PATTERN, _HAZARD_PATTERNS, _has_side_flip
from app.caddie.routing import classify_intent
from app.caddie.session import RoundSession
from app.caddie.strategy import _PIN_RELATIVE_PATTERN
from app.caddie.strategy_turn import run_strategy_turn
from app.caddie.types import CaddieRecommendation, HoleIntelligence, WeatherConditions

from tests.eval import substance as substance_mod
from tests.eval.caddie_bench import geometry as geo
from tests.eval.caddie_bench.schema import (
    BenchCase,
    CaseResult,
    ConditionsId,
    DetCheckName,
    DetCheckResult,
    PlayerBag,
    Phrasing,
    QuestionType,
)

# ── Weather presets (§2: "3 wind presets, deterministic") ──────────────────


def conditions_to_weather(conditions_id: ConditionsId, shot_bearing_deg: float) -> WeatherConditions:
    """`wind_direction` is meteorological (degrees the wind comes FROM) —
    `physics.conditions_from_weather`'s convention: wind_direction ==
    shot_bearing means a HEADwind. CROSS_15 rotates 90 degrees off the shot
    line for a pure crosswind."""
    if conditions_id == ConditionsId.CALM:
        return WeatherConditions(wind_speed_mph=0.0, wind_direction=0)
    if conditions_id == ConditionsId.CROSS_15:
        return WeatherConditions(wind_speed_mph=15.0, wind_direction=round(shot_bearing_deg + 90.0) % 360)
    if conditions_id == ConditionsId.INTO_20:
        return WeatherConditions(wind_speed_mph=20.0, wind_direction=round(shot_bearing_deg) % 360)
    raise AssertionError(f"unhandled ConditionsId {conditions_id!r}")


# ── RoundSession assembly ────────────────────────────────────────────────


def build_session(
    hole_intel: dict[int, HoleIntelligence],
    club_distances: dict[str, int],
    handicap: float,
    weather: WeatherConditions,
    *,
    current_hole: int,
    round_id: str = "bench",
    user_id: str = "bench-user",
) -> RoundSession:
    """B2 fix: prod normalizes the bag through `normalize_club_distances` at
    session load (`app/caddie/session.py::row_to_session`, the "heal-on-load"
    chokepoint) — a non-canonical club key (e.g. a spoken/legacy '3iron',
    which the canonical iron taxonomy starts at 4-iron and doesn't have) is
    DROPPED there before it ever reaches the engine. Without this, the bench
    session would carry a raw bag the LIVE Claude synth can still see and
    recommend, while `generate_recommendation`'s own oracle call (which also
    normalizes internally) never can — a bench session that isn't
    byte-identical to what prod actually builds, and a guaranteed
    `club_matches_engine` det-check RED for every non-canonical club."""
    return RoundSession(
        round_id=round_id, user_id=user_id, hole_intel=hole_intel,
        club_distances=normalize_club_distances(dict(club_distances)),
        handicap=handicap, weather=weather, current_hole=current_hole,
    )


# ── DB-seam stubs (mirrors tests/eval/conversation_runner.py's stub
#    approach, at the `app.caddie.tools` import site — §0) ─────────────────


@contextlib.contextmanager
def _stub_db_seams():
    from app.caddie import tools as tools_mod

    orig_set_recommendation = tools_mod.sessions.set_recommendation
    orig_get_player_profile = tools_mod.memory_mod.get_player_profile

    async def _noop_set_recommendation(round_id: str, recommendation, current_hole: int) -> None:
        return None

    async def _no_profile(user_id: str):
        return None

    tools_mod.sessions.set_recommendation = _noop_set_recommendation
    tools_mod.memory_mod.get_player_profile = _no_profile
    try:
        yield
    finally:
        tools_mod.sessions.set_recommendation = orig_set_recommendation
        tools_mod.memory_mod.get_player_profile = orig_get_player_profile


@contextlib.contextmanager
def _stub_synth(synth: Optional[Callable]):
    if synth is None:
        yield
        return
    orig = strategy_mod.synthesize_strategy
    strategy_mod.synthesize_strategy = synth
    try:
        yield
    finally:
        strategy_mod.synthesize_strategy = orig


# ── Deterministic pre-checks (§5a) — reuse, never fork ──────────────────────

_SENTENCE_SPLIT_RE = re.compile(r"[.!?]+(?:\s|$)")
_LENGTH_CAP_CHARS = 600  # mirrors strategy._STRATEGY_MAX_CHARS
_LENGTH_CAP_SENTENCES = 8


def _known_numbers(engine_ref: CaddieRecommendation) -> set[int]:
    known: set[int] = set()
    if engine_ref.raw_yards:
        known.add(int(engine_ref.raw_yards))
    if engine_ref.target_yards:
        known.add(int(engine_ref.target_yards))
    if engine_ref.leave_yards is not None:
        known.add(int(engine_ref.leave_yards))
    tsn = engine_ref.tee_shot_numbers
    if tsn is not None:
        for v in (
            tsn.to_green_yards, tsn.plays_like_yards, tsn.club_stored_yards, tsn.drive_carry_yards,
            tsn.drive_total_yards, tsn.leave_exact_yards, tsn.leave_yards, tsn.leave_plays_like_yards,
            tsn.corridor_pinch_width_yards, tsn.corridor_pinch_distance_yards,
            tsn.corridor_club_window_yards, tsn.corridor_width_yards, tsn.corridor_alt_leave_yards,
            tsn.corridor_alt_total_yards,
        ):
            if v is not None:
                known.add(int(v))
    return known


def check_hazard_only_from_input(
    answer: str, hazards: list[dict], engine_ref: CaddieRecommendation, club_distances: dict[str, int],
) -> DetCheckResult:
    flat = " ".join((answer or "").split()).lower()
    allowed = {hz["type"] for hz in hazards}
    for canonical_type, pattern in _HAZARD_PATTERNS.items():
        if canonical_type not in allowed and pattern.search(flat):
            return DetCheckResult(
                check=DetCheckName.HAZARD_ONLY_FROM_INPUT, passed=False,
                detail=f"named hazard type {canonical_type!r} not in mapped hazards {sorted(allowed)}",
            )
    return DetCheckResult(check=DetCheckName.HAZARD_ONLY_FROM_INPUT, passed=True)


def check_side_flip(
    answer: str, hazards: list[dict], engine_ref: CaddieRecommendation, club_distances: dict[str, int],
) -> DetCheckResult:
    flat = " ".join((answer or "").split())
    hazards_by_type: dict[str, list[tuple[str, int]]] = {}
    for hz in hazards:
        hazards_by_type.setdefault(hz["type"], []).append((hz["line_side"], hz["carry_yards"]))
    flipped = _has_side_flip([flat], hazards_by_type)
    return DetCheckResult(check=DetCheckName.SIDE_FLIP, passed=not flipped, detail="side-flip detected" if flipped else "ok")


def check_injection(
    answer: str, hazards: list[dict], engine_ref: CaddieRecommendation, club_distances: dict[str, int],
) -> DetCheckResult:
    flat = " ".join((answer or "").split())
    hit = GUIDE_INJECTION_PATTERN.search(flat) is not None
    return DetCheckResult(check=DetCheckName.INJECTION, passed=not hit, detail="injection-shaped text found" if hit else "ok")


def check_club_matches_engine(
    answer: str, hazards: list[dict], engine_ref: CaddieRecommendation, club_distances: dict[str, int],
) -> DetCheckResult:
    substance = substance_mod.extract_substance(answer, club_distances)
    mentioned = substance.endorsed_club or substance.club
    if mentioned is None:
        return DetCheckResult(check=DetCheckName.CLUB_MATCHES_ENGINE, passed=False, detail="no recognizable club named in the answer")
    if mentioned != engine_ref.club:
        return DetCheckResult(
            check=DetCheckName.CLUB_MATCHES_ENGINE, passed=False,
            detail=f"answer named {mentioned!r}, engine recommends {engine_ref.club!r}",
        )
    return DetCheckResult(check=DetCheckName.CLUB_MATCHES_ENGINE, passed=True)


def check_numbers_close(
    answer: str, hazards: list[dict], engine_ref: CaddieRecommendation, club_distances: dict[str, int],
    *, tolerance: int = 5, hole_yards: Optional[int] = None,
) -> DetCheckResult:
    substance = substance_mod.extract_substance(answer, club_distances)
    known = _known_numbers(engine_ref)

    # Frame correction (approach-solve plan §4.1, B1 fix — fable/eng-lead
    # review). The ground-truth CARRIES section (`tools.carries_payload`)
    # re-frames to from-you carries on PURE GEOMETRY — tee_offset >=
    # APPROACH_FRAME_MIN_TEE_OFFSET_YDS — for ANY shot_kind, approach OR
    # positioning (a from-you carry is the correct, honest number mid-hole
    # regardless of reachability). The validator's frame-learning must key
    # off that SAME geometric predicate, never `shot_kind == "approach"`
    # alone — gating on shot_kind let a faithful positioning-turn from-you
    # answer (e.g. "about 120 from you") go falsely RED (repro: 600y hole,
    # 320y out -> positioning, water carry 400 -> ground truth renders
    # "about 120y from you to carry"). `hole_yards is None` or offset < 25:
    # no-op, byte-identical known set — never looser on a tee turn.
    offset = (hole_yards - engine_ref.raw_yards) if hole_yards is not None else None
    approach_framed = offset is not None and offset >= APPROACH_FRAME_MIN_TEE_OFFSET_YDS

    en_route_carry_yards: set[int] = set()
    if approach_framed:
        for hz in hazards:
            carry = hz.get("carry_yards")
            if not carry:
                continue
            carry = int(carry)
            if offset < carry < hole_yards:
                from_here = carry - offset
                # Nit 3: a hazard the engine SUPPRESSES (from-here < EN_
                # ROUTE_CLEARED_SUPPRESS_YDS) is never spoken as a from-you
                # number at all (tools.carries_payload drops it outright,
                # same as aim_point's en_route_from_player) — learning it
                # here would let a confabulated "about 5" pass.
                if from_here < EN_ROUTE_CLEARED_SUPPRESS_YDS:
                    continue
                known.add(from_here)
                known.add(round(from_here / 5) * 5)
                en_route_carry_yards.add(carry)

    # The degraded-line composer (compose_degraded_line) also states hazard
    # carry yards from the hole's full mapped hazard list (not just the
    # recommendation's own carries) — those are equally "bound to the
    # per-turn engine solve" (they come straight off intel.hazards).
    #
    # Raw tee-frame carries of en-route hazards are REMOVED from the known
    # set ONLY on approach-framed APPROACH turns: the reachable path (aim_
    # point.py Site A/B + the CARRIES section) never legitimately speaks the
    # raw tee-frame number anymore once approach-framed, so parroting it
    # (e.g. 495 on a 182y shot) must now FAIL. On POSITIONING turns the raw
    # number is STILL legitimately spoken elsewhere — `cross_hazard_line`/
    # `decade_landing_advice` (decade_advice.py, untouched by this plan)
    # read `drive_zone_hazards`' tee-anchored `carry_yards` directly (e.g.
    # "Water crosses at ~400 — driver brings it in play") — so removing it
    # there would false-red an honest positioning answer (B1's exact bug
    # class). Positioning turns therefore only ever ADD the from-here number
    # above; the raw number is never removed from the known set for them.
    strict_removal = approach_framed and engine_ref.shot_kind == "approach"
    for hz in hazards:
        carry = hz.get("carry_yards")
        if not carry:
            continue
        carry = int(carry)
        if strict_removal and carry in en_route_carry_yards:
            continue
        known.add(carry)

    if not known:
        return DetCheckResult(check=DetCheckName.NUMBERS_CLOSE, passed=True, detail="engine has no reference numbers to bind to")
    bad = [y for y in substance.yardages if min(abs(y - k) for k in known) > tolerance]
    if bad:
        return DetCheckResult(
            check=DetCheckName.NUMBERS_CLOSE, passed=False,
            detail=f"answer number(s) {bad} not within {tolerance}y of any engine number {sorted(known)}",
        )
    return DetCheckResult(check=DetCheckName.NUMBERS_CLOSE, passed=True)


def check_approach_miss_side_pin(
    answer: str, hazards: list[dict], engine_ref: CaddieRecommendation, club_distances: dict[str, int],
    *, hole_yards: Optional[int] = None,
) -> DetCheckResult:
    """approach-solve plan §4.2 — on an approach shot the spoken favor/miss
    side (reused, never forked: `app.caddie.verdict.extract_favor_side`, the
    same discipline as the existing verdict-pin machinery in `app.caddie.
    strategy._verdict_pin_reject_reason`) must be None (no lateral claim) or
    agree with the engine's own `miss_side.preferred`."""
    if engine_ref.shot_kind != "approach":
        return DetCheckResult(check=DetCheckName.APPROACH_MISS_SIDE_PIN, passed=True, detail="not an approach shot")
    flat = " ".join((answer or "").split())
    spoken = verdict_mod.extract_favor_side(flat)
    engine_side = engine_ref.miss_side.preferred if engine_ref.miss_side else None
    if spoken is None or spoken == engine_side:
        return DetCheckResult(check=DetCheckName.APPROACH_MISS_SIDE_PIN, passed=True)
    return DetCheckResult(
        check=DetCheckName.APPROACH_MISS_SIDE_PIN, passed=False,
        detail=f"answer favors {spoken!r}, engine miss_side.preferred={engine_side!r}",
    )


def check_positioning_no_pin_language(
    answer: str, hazards: list[dict], engine_ref: CaddieRecommendation, club_distances: dict[str, int],
) -> DetCheckResult:
    if engine_ref.shot_kind != "positioning":
        return DetCheckResult(check=DetCheckName.POSITIONING_NO_PIN_LANGUAGE, passed=True, detail="not a positioning shot")
    flat = " ".join((answer or "").split()).lower()
    hit = _PIN_RELATIVE_PATTERN.search(flat) is not None
    return DetCheckResult(
        check=DetCheckName.POSITIONING_NO_PIN_LANGUAGE, passed=not hit,
        detail="flag-relative aim language on an out-of-reach (positioning) shot" if hit else "ok",
    )


def check_length_caps(
    answer: str, hazards: list[dict], engine_ref: CaddieRecommendation, club_distances: dict[str, int],
) -> DetCheckResult:
    flat = " ".join((answer or "").split())
    n_sentences = len([s for s in _SENTENCE_SPLIT_RE.split(flat) if s.strip()])
    if len(flat) > _LENGTH_CAP_CHARS:
        return DetCheckResult(check=DetCheckName.LENGTH_CAPS, passed=False, detail=f"{len(flat)} chars > cap {_LENGTH_CAP_CHARS}")
    if n_sentences > _LENGTH_CAP_SENTENCES:
        return DetCheckResult(check=DetCheckName.LENGTH_CAPS, passed=False, detail=f"{n_sentences} sentences > cap {_LENGTH_CAP_SENTENCES}")
    return DetCheckResult(check=DetCheckName.LENGTH_CAPS, passed=True)


_DET_CHECK_FNS: dict[DetCheckName, Callable[[str, list[dict], CaddieRecommendation, dict[str, int]], DetCheckResult]] = {
    DetCheckName.HAZARD_ONLY_FROM_INPUT: check_hazard_only_from_input,
    DetCheckName.SIDE_FLIP: check_side_flip,
    DetCheckName.INJECTION: check_injection,
    DetCheckName.CLUB_MATCHES_ENGINE: check_club_matches_engine,
    DetCheckName.NUMBERS_CLOSE: check_numbers_close,
    DetCheckName.POSITIONING_NO_PIN_LANGUAGE: check_positioning_no_pin_language,
    DetCheckName.LENGTH_CAPS: check_length_caps,
    DetCheckName.APPROACH_MISS_SIDE_PIN: check_approach_miss_side_pin,
}

# FACT-class cases get a reduced rubric (§3: "FACT answers judged with a
# reduced rubric") — club/side/positioning checks don't apply to a pure
# distance readout. APPROACH_MISS_SIDE_PIN is likewise skipped: a FACT
# distance readout makes no favor/miss claim to pin.
_REDUCED_DET_CHECKS: tuple[DetCheckName, ...] = (
    DetCheckName.INJECTION, DetCheckName.NUMBERS_CLOSE, DetCheckName.LENGTH_CAPS,
)

# Check names that need the hole's yardage (approach-frame math) in addition
# to the standard (answer, hazards, engine_ref, club_distances) signature —
# every other check ignores it, so this stays a small special case rather
# than forcing a `hole_yards` kwarg onto every registered check fn.
_NEEDS_HOLE_YARDS: frozenset[DetCheckName] = frozenset({
    DetCheckName.NUMBERS_CLOSE, DetCheckName.APPROACH_MISS_SIDE_PIN,
})


def run_det_checks(
    answer: str, hazards: list[dict], engine_ref: CaddieRecommendation, club_distances: dict[str, int],
    *, reduced: bool = False, hole_yards: Optional[int] = None,
) -> list[DetCheckResult]:
    names = _REDUCED_DET_CHECKS if reduced else tuple(_DET_CHECK_FNS)
    results = []
    for name in names:
        fn = _DET_CHECK_FNS[name]
        if name in _NEEDS_HOLE_YARDS:
            results.append(fn(answer, hazards, engine_ref, club_distances, hole_yards=hole_yards))
        else:
            results.append(fn(answer, hazards, engine_ref, club_distances))
    return results


# ── The seam driver ──────────────────────────────────────────────────────


async def run_case(
    case: BenchCase, fx: geo.HoleFixture, phrasing: Phrasing, bag: PlayerBag, *, synth: Optional[Callable] = None,
) -> CaseResult:
    """Runs ONE bench case end to end (§3 offline construction). `synth=None`
    means the REAL `synthesize_strategy` (a LIVE call — only reached when the
    caller has already gated a live run); tests always pass a canned stub."""
    strategy_mod._CACHE.clear()

    intel = geo.hole_intel_from_fixture(fx)
    resolved = geo.sample_position(fx, case.position)
    weather = conditions_to_weather(case.conditions, resolved.shot_bearing_deg)
    session = build_session(
        {fx.hole_number: intel}, bag.clubs, bag.handicap, weather, current_hole=fx.hole_number,
    )

    text = phrasing.text
    intent = classify_intent(text)
    distance = round(resolved.distance_to_green_yards)

    engine_ref = generate_recommendation(
        hole=intel, distance_yards=distance, club_distances=bag.clubs, handicap=bag.handicap,
        weather=weather, shot_bearing=resolved.shot_bearing_deg,
    )
    hazards_payload = [h.model_dump() for h in intel.hazards]

    cost_usd = 0.0
    latency_ms = 0.0
    reduced_checks = False

    if case.canary:
        answer = case.canary_answer or ""
        degraded = False
    elif case.question_type == QuestionType.FACT_DISTANCE:
        # FACT (pilot): routing recorded only; the Claude tool loop is
        # STUBBED — a canned, engine-grounded distance readout (live-FACT is
        # a follow-up per the plan).
        answer = f"You've got {distance} to the green."
        degraded = False
        reduced_checks = True
    else:
        start = time.monotonic()
        with _stub_db_seams(), _stub_synth(synth):
            result = await run_strategy_turn(
                session, "bench", "bench-user", fx.hole_number,
                distance_to_green_yards=distance, yardage_basis=None,
                # caddie-bench-cycle2-plan.md §2.2: thread the SAME bearing
                # engine_ref above solved with, so the live-path solve and
                # the bench oracle agree by construction on windy holes.
                shot_bearing_deg=resolved.shot_bearing_deg,
            )
        latency_ms = (time.monotonic() - start) * 1000
        answer = result.get("strategy") or ""
        degraded = bool(result.get("degraded"))
        cost_usd = float(getattr(synth, "last_cost_usd", 0.0) or 0.0)

    det_checks = run_det_checks(
        answer, hazards_payload, engine_ref, bag.clubs, reduced=reduced_checks, hole_yards=intel.yards,
    )

    return CaseResult(
        case_id=case.id, resolved=resolved, intent=intent.value, answer=answer, degraded=degraded,
        engine_ref=engine_ref.model_dump(), det_checks=det_checks, cost_usd=cost_usd, latency_ms=latency_ms,
    )
