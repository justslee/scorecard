"""Aim point and miss-side analysis engine (DECADE-inspired)."""

import math
from typing import NamedTuple, Optional
from app.caddie import physics
from app.caddie.types import (
    AimPoint,
    MissSide,
    CorridorSample,
    Hazard,
    HoleIntelligence,
    PlayerStatistics,
    CaddieRecommendation,
    TeeShotNumbers,
    WeatherConditions,
)
from app.caddie.club_selection import (
    select_club,
    compute_adjustments,
    normalize_club_distances,
    CLUB_DISPLAY_NAMES,
    DEFAULT_CLUB_DISTANCES,
)
from app.caddie.dispersion import get_dispersion
from app.caddie.hazards import corridor_sample_at
from app.caddie.strokes_gained import (
    expected_strokes,
    personal_lookup,
    approach_expected_strokes,
    _handicap_multiplier,
)
from app.caddie.slope_advice import slope_miss_advice
from app.caddie.shot_line_advice import shot_line_advice
from app.caddie.decade_advice import (
    decade_aim_advice,
    decade_landing_advice,
    drive_zone_hazards,
    cross_hazard_line,
)

# ── Reasoning priority cap ────────────────────────────────────────────────────
#
# The voice caddie reads reasoning lines aloud, so brevity matters.
# Priorities (lower = more important; always shown first):
#   P0 — club/distance fit line       ALWAYS kept, ALWAYS first
#   P1 — safety-critical              pin light (red/yellow), DECADE hazard-aim,
#                                     competition-legal note
#   P2 — slope miss-advice + miss     green-slope advice, player miss tendency
#   P3 — shot-line terrain advice     terrain shape (elevated green, ridge, swale…)
#   P4 — color                        player history, personal-stats note,
#                                     generic distance-adjustment summary
#
MAX_REASONING_ITEMS: int = 4


def prioritize_reasoning(
    items: list[tuple[int, str]],
    max_items: int = MAX_REASONING_ITEMS,
) -> list[str]:
    """Sort reasoning items by priority and cap to *max_items*.

    Args:
        items: Sequence of ``(priority, text)`` tuples.  Lower priority value
               means more important (P0 is always shown first).
        max_items: Maximum number of lines to return.  The P0 club/distance fit
                   line is never dropped even when *max_items* < total items.

    Returns:
        Ordered, trimmed list of text strings — priorities stripped.
    """
    # Stable sort: Python's sort is stable, so same-priority items keep
    # their original insertion order.
    sorted_items = sorted(items, key=lambda x: x[0])

    if len(sorted_items) <= max_items:
        return [text for _, text in sorted_items]

    # Always preserve P0 (the club line) regardless of the cap.
    p0_items = [(p, t) for p, t in sorted_items if p == 0]
    rest = [(p, t) for p, t in sorted_items if p > 0]

    remaining_slots = max_items - len(p0_items)
    trimmed = p0_items + rest[:remaining_slots]
    return [text for _, text in trimmed]


def classify_pin_position(
    hole: HoleIntelligence,
) -> str:
    """Classify pin position using DECADE traffic light system.

    green  = center, no trouble nearby -> go at it
    yellow = near edge, some trouble -> aim between pin and center
    red    = tucked behind hazard, sucker pin -> aim center of green

    Without pin coordinates, we classify based on hazard proximity.
    """
    if not hole.hazards:
        return "green"

    # Count severe hazards close to the green
    severe_close = [
        h for h in hole.hazards
        if h.penalty_severity in ("severe", "death")
        and h.distance_from_green <= 10
    ]

    if len(severe_close) >= 2:
        return "red"
    elif len(severe_close) == 1:
        return "yellow"

    # Any death hazards nearby
    death_hazards = [h for h in hole.hazards if h.penalty_severity == "death"]
    if death_hazards:
        return "yellow"

    return "green"


# ── En-route carry hazards (specs/aim-point-hazard-aware-recommendation-line-
# plan.md) — the LAST flag-only remnant of the caddie-shot-context-
# reachability family. Owner repro: Augusta 12 (155y par-3, water carry 140,
# reachable, pin light "green") said "Aim at the flag — green light, no
# trouble" while the hazards line two lines below named the water. This is
# the tee-anchored `carry_yards` frame — the SAME frame `drive_zone_hazards`
# / `carries_payload` / `format_hazards_line` use.


def en_route_carry_hazards(
    hazards: list[Hazard],
    hole_yards: Optional[int],
    distance_yards: int,
) -> Optional[list[Hazard]]:
    """Hazards between the player and the green in the tee-anchored
    `carry_yards` frame (the SAME frame drive_zone_hazards / carries_payload /
    format_hazards_line use — hazards.py's along-played-line number).

    Returns:
      []    — no carry-frame evidence, or every carry hazard is provably NOT
              between the player and the green (behind the player, or past the
              green). Caller keeps today's behavior verbatim.
      [h..] — the en-route subset (there IS trouble on the way in).
      None  — frame unknown: carry evidence exists but hole_yards is None, so
              the player's tee-offset is unknowable. Caller must neither claim
              "no trouble" nor fabricate a carry (conservative/honest).
    """
    carry_evidence = [h for h in hazards if h.carry_yards > 0]
    if not carry_evidence:
        return []          # green-frame-only hazard sets (carry_yards defaulted 0)
    if hole_yards is None:
        return None        # cannot place the player on the tee->green line
    tee_offset = max(0, hole_yards - distance_yards)   # GPS-behind-tee jitter clamp
    return [h for h in carry_evidence if tee_offset < h.carry_yards < hole_yards]


_HAZARD_NOUNS: dict[str, str] = {
    "water": "water", "bunker": "bunker", "ob": "OB", "trees": "trees", "slope": "slope",
}  # article-free sibling of decade_advice._friendly_hazard_name; fallback "trouble"


def _governing_center_carry(en_route: list[Hazard]) -> Optional[Hazard]:
    """The one carry the spoken line names: among line_side=='center' en-route
    hazards, most severe wins; ties break to the LARGER carry_yards (the deeper
    constraint), then hazard type for full determinism. None when no center
    en-route hazard exists (lateral-only case)."""
    center = [h for h in en_route if h.line_side.lower() == "center"]
    if not center:
        return None
    return max(center, key=lambda h: (_SEVERITY_RANK.get(h.penalty_severity, 0),
                                      h.carry_yards, h.type))


# ── Approach-frame player-relative carries (specs/caddie-approach-solve-
# plan.md §1.1) — the tee-anchored `carry_yards` frame (`en_route_carry_
# hazards` above) is correct for a TEE shot, but on a genuine mid-hole
# approach turn a hazard "at 495" (the tee->hazard distance) is not the
# number a player standing 182y out needs; they need the CARRY FROM THEM.
# `en_route_from_player` wraps the unchanged tee-frame predicate and adds
# the player-relative correction ONLY once the turn is provably approach-
# framed (§0) — every offset-0 pinned test stays on the tee-frame path,
# byte-identical.
class EnRouteFromPlayer(NamedTuple):
    en_route: Optional[list[Hazard]]   # verbatim en_route_carry_hazards result (approach-framed: cleared hazards dropped)
    tee_offset: int                    # 0 when not approach-framed
    approach_framed: bool
    # True only when approach-framed suppression actually DROPPED >=1 hazard
    # the raw tee-frame predicate found ahead of the player (Pebble-3: raw
    # en_route non-empty, from-here < EN_ROUTE_CLEARED_SUPPRESS_YDS). Distinct
    # from "en_route is genuinely empty" (no mapped carry evidence, or every
    # carry hazard is already behind/past per en_route_carry_hazards' own
    # predicate) — that case is a TRUE "no trouble ahead" and must still say
    # so. Callers use this to decide whether resurrecting "green light, no
    # trouble" would be a NEW false claim (suppressed=True) or remains
    # accurate (suppressed=False).
    suppressed: bool = False

    def from_here(self, h: Hazard) -> int:
        """Round-to-5 of (h.carry_yards - tee_offset); == h.carry_yards
        verbatim when the turn is not approach-framed — the honesty label
        (NORTHSTAR: no fake precision) for composing two measurement frames
        (card/tee-geom hole yardage vs live GPS distance)."""
        if not self.approach_framed:
            return h.carry_yards
        return round((h.carry_yards - self.tee_offset) / 5) * 5


def en_route_from_player(hole: HoleIntelligence, distance_yards: int) -> EnRouteFromPlayer:
    """Player-relative view of `en_route_carry_hazards` — the ONE helper both
    the aim-point description (Site A) and the P1 reasoning line (Site B) use
    so they can never disagree about the corrected number (deterministic,
    pure — computing it more than once in a turn always yields the same
    result by construction).

    Below `APPROACH_FRAME_MIN_TEE_OFFSET_YDS` tee_offset (every shipped tee/
    reachable pin — all offset 0) this is a pure pass-through: `tee_offset`
    is 0, `approach_framed` is False, `from_here(h) == h.carry_yards`, and
    the returned list is exactly `en_route_carry_hazards`'s own result —
    byte-identical downstream. Once approach-framed, hazards the player has
    already effectively cleared (from-here carry < `EN_ROUTE_CLEARED_
    SUPPRESS_YDS` — within GPS-jitter/rounding noise of the player's own
    position) are dropped BEFORE `_governing_center_carry` runs, so a
    cleared hazard can never govern the spoken line (Pebble-3 evidence case:
    carry 230, tee_offset ~225 -> from-here 5 -> dropped, the line doesn't
    fire at all).
    """
    en_route = en_route_carry_hazards(hole.hazards, hole.yards, distance_yards)
    tee_offset = max(0, hole.yards - distance_yards) if hole.yards is not None else 0
    approach_framed = hole.yards is not None and tee_offset >= APPROACH_FRAME_MIN_TEE_OFFSET_YDS
    if not approach_framed:
        return EnRouteFromPlayer(en_route=en_route, tee_offset=0, approach_framed=False)
    unfiltered = EnRouteFromPlayer(en_route=en_route, tee_offset=tee_offset, approach_framed=True)
    if not en_route:
        return unfiltered
    filtered = [h for h in en_route if unfiltered.from_here(h) >= EN_ROUTE_CLEARED_SUPPRESS_YDS]
    return EnRouteFromPlayer(
        en_route=filtered, tee_offset=tee_offset, approach_framed=True,
        suppressed=len(filtered) < len(en_route),
    )


def compute_aim_point(
    hole: HoleIntelligence,
    player_stats: Optional[PlayerStatistics],
    handicap: float = 15.0,
    distance_yards: Optional[int] = None,
) -> AimPoint:
    """Compute where to aim based on hazards, green shape, and player tendencies.

    DECADE principles:
    - Green light pin: aim at the flag
    - Yellow light pin: aim between flag and center
    - Red light pin: aim center of green, ignore the flag
    - Always shift aim away from the "death side"

    `distance_yards`, when provided, is the RAW geometric distance
    (`rec.raw_yards`), NEVER `adjusted_yards` — it lets the green-pin arm
    check for en-route carry hazards (tee-anchored `carry_yards` frame) so
    the aim line can never claim "no trouble" while the hazards line two
    lines below names one. `None` (all existing direct callers) → legacy
    byte-identical behavior.
    """
    pin_light = classify_pin_position(hole)
    miss_dir = player_stats.tendencies.miss_direction if player_stats else "balanced"

    if distance_yards is not None:
        erp = en_route_from_player(hole, distance_yards)
    else:
        erp = EnRouteFromPlayer(en_route=[], tee_offset=0, approach_framed=False)   # no positional evidence -> legacy behavior
    en_route = erp.en_route

    if pin_light == "green":
        if en_route is None:
            # Carry evidence exists but the frame is unknown (hole.yards None):
            # neither claim clean nor fabricate a carry we can't anchor.
            description = "Aim at the flag"
        elif not en_route:
            if erp.suppressed:
                # There WAS carry evidence ahead of the player (the raw
                # tee-frame predicate found it) but it's already effectively
                # cleared (Pebble-3: from-here < EN_ROUTE_CLEARED_SUPPRESS_
                # YDS) — claiming "green light, no trouble" would be a NEW
                # false claim never made before this fix; the honest bare
                # form stands instead.
                description = "Aim at the flag"
            else:
                # Genuinely nothing ahead (no carry evidence at all, or every
                # carry hazard is already behind/past per en_route_carry_
                # hazards' own predicate) — "no trouble" remains accurate
                # regardless of frame.
                description = "Aim at the flag — green light, no trouble"   # verbatim today
        else:
            governing = _governing_center_carry(en_route)
            if governing is not None:
                noun = _HAZARD_NOUNS.get(governing.type.lower(), "trouble")
                if erp.approach_framed:
                    description = f"Aim at the flag — carry the {noun} about {erp.from_here(governing)} from you"
                else:
                    description = f"Aim at the flag — carry the {noun} at {governing.carry_yards}"
            else:
                # Lateral-only en-route trouble.
                worst = max(en_route, key=lambda h: (_SEVERITY_RANK.get(h.penalty_severity, 0),
                                                     h.carry_yards, h.type))
                noun = _HAZARD_NOUNS.get(worst.type.lower(), "trouble")
                miss = compute_miss_side(hole, player_stats)
                if miss.preferred in ("left", "right"):
                    safe_side = miss.preferred
                else:
                    safe_side = "right" if worst.line_side.lower() == "left" else "left"
                carry_phrase = (
                    f"about {erp.from_here(worst)} from you" if erp.approach_framed
                    else f"at {worst.carry_yards}"
                )
                if safe_side != worst.line_side.lower():
                    description = (f"Aim at the flag — {noun} {worst.line_side.lower()} "
                                   f"{carry_phrase}, favor the {safe_side} side")
                else:
                    # Miss verdict says the hazard's own side is still the lesser
                    # evil — name the fact, let miss_side carry the verdict, never
                    # a contradicting side instruction.
                    description = (f"Aim at the flag — {noun} {worst.line_side.lower()} "
                                   f"{carry_phrase}")
    elif pin_light == "yellow":
        description = "Aim between the pin and center of green"          # unchanged
    else:
        description = "Aim center of green — sucker pin, don't chase it" # unchanged

    # Shift aim away from death side. Structurally disjoint from the en-route
    # branch above: any `penalty_severity == "death"` hazard forces
    # `classify_pin_position` to return at least "yellow" (lines 107-110), so
    # whenever we're in the `pin_light == "green"` arm above, `death_sides`
    # below is always empty and this append never fires on that arm. The
    # append still composes after the yellow/red strings exactly as today.
    # (If a future refactor ever let it fire after a carry string, it appends
    # grammatically: "Aim at the flag — carry the water at 140. Favor the
    # left side — penalty right".)
    death_sides = [h.side for h in hole.hazards if h.penalty_severity == "death"]
    if "right" in death_sides and miss_dir in ("right", "balanced"):
        description += ". Favor the left side — penalty right"
    elif "left" in death_sides and miss_dir in ("left", "balanced"):
        description += ". Favor the right side — penalty left"

    return AimPoint(description=description)


_SPOKEN_SIDE_WORD: dict[str, str] = {
    "left": "left", "right": "right", "short": "short of the green", "long": "long",
    # `Hazard.side` itself uses "front"/"back" (hazards.py) — `_greenside_
    # hazards_line` reads it RAW, so these must be spoken words too, never
    # "bunker front" verbatim. Same mapping compute_miss_side's own
    # {"short": "front", "long": "back"} lookup uses in reverse.
    "front": "short of the green", "back": "long",
}


def compute_miss_side(
    hole: HoleIntelligence,
    player_stats: Optional[PlayerStatistics],
    *,
    distance_yards: Optional[int] = None,
) -> MissSide:
    """Determine the preferred miss side and what to avoid.

    DECADE principle: identify the "recovery side" vs "death side"

    `distance_yards`, when provided AND the turn is provably approach-framed
    (§0 — the player has advanced tee_offset >= APPROACH_FRAME_MIN_TEE_
    OFFSET_YDS past the tee), enriches `description` with the per-side
    hazard EVIDENCE that drove the pick (DEFECT 2, specs/caddie-approach-
    solve-plan.md §1.3) — it never changes `preferred`/`avoid` SELECTION or
    the `avoid` text's prefix. `None` (every existing direct caller) or a
    tee-framed turn -> today's text verbatim, byte-identical.
    """
    if not hole.hazards:
        return MissSide(
            preferred="short",
            description="No major trouble — miss short for an easy chip",
            avoid="Avoid going long — harder to get up and down",
        )

    approach_framed = (
        hole.yards is not None
        and distance_yards is not None
        and max(0, hole.yards - distance_yards) >= APPROACH_FRAME_MIN_TEE_OFFSET_YDS
    )

    # Classify each side's penalty
    side_severity: dict[str, list[str]] = {
        "left": [],
        "right": [],
        "front": [],
        "back": [],
    }

    for h in hole.hazards:
        if h.side in side_severity and h.distance_from_green <= 20:
            side_severity[h.side].append(h.penalty_severity)

    # Find worst and best sides
    def severity_score(severities: list[str]) -> float:
        scores = {"mild": 1, "moderate": 2, "severe": 3, "death": 5}
        if not severities:
            return 0
        return max(scores.get(s, 0) for s in severities)

    left_score = severity_score(side_severity["left"])
    right_score = severity_score(side_severity["right"])
    front_score = severity_score(side_severity["front"])
    back_score = severity_score(side_severity["back"])

    # Determine preferred miss direction (lowest penalty)
    lr_options = []
    if left_score <= right_score:
        lr_options.append(("left", left_score, right_score))
    else:
        lr_options.append(("right", right_score, left_score))

    fb_options = []
    if front_score <= back_score:
        fb_options.append(("short", front_score, back_score))
    else:
        fb_options.append(("long", back_score, front_score))

    # Pick the best option
    best_lr = lr_options[0]
    best_fb = fb_options[0]

    # Prefer left/right miss preference over short/long
    preferred = best_lr[0] if best_lr[2] > best_fb[2] else best_fb[0]

    # Avoid descriptions
    avoid_map = {
        "left": "right",
        "right": "left",
        "short": "long",
        "long": "short",
    }
    avoid_side = avoid_map.get(preferred, "right")

    # Build descriptions
    def side_hazard_desc(side: str) -> str:
        hazards_on_side = [
            h for h in hole.hazards
            if h.side == side and h.distance_from_green <= 20
        ]
        if not hazards_on_side:
            return "open"
        types = set(h.type for h in hazards_on_side)
        parts = []
        if "water" in types:
            parts.append("water")
        if "bunker" in types:
            parts.append("bunker")
        if "ob" in types:
            parts.append("OB")
        if "trees" in types:
            parts.append("trees")
        return ", ".join(parts) if parts else "trouble"

    preferred_desc_suffix = side_hazard_desc(
        {"short": "front", "long": "back"}.get(preferred, preferred)
    )
    avoid_desc_suffix = side_hazard_desc(
        {"short": "front", "long": "back"}.get(avoid_side, avoid_side)
    )

    pref_label = {"short": "Short", "long": "Long", "left": "Left", "right": "Right"}

    # Article-aware wording for the "{hazard} guards {X}" clause specifically
    # (nit 4, eng-lead review) — `_SPOKEN_SIDE_WORD`'s "short of the green"/
    # "long" already carry their own preposition/no-article convention for
    # the MISS instruction ("miss short of the green"); baking a leading
    # "the" onto them here produced "guards the short of the green" (a
    # doubled/misplaced article). "the front"/"the back" read naturally
    # after "guards" and are still the honest, un-new-claiming Hazard.side
    # vocabulary (hazards.py).
    _guard_side_word: dict[str, str] = {
        "left": "the left", "right": "the right", "short": "the front", "long": "the back",
    }

    # cycle-3 commit 4: `avoid_text` is set explicitly only by the new
    # both-open/approach-framed sub-branch below; every other branch leaves
    # it `None` here and falls through to the SAME generic construction as
    # before this change — byte-identical for every non-approach-framed (or
    # avoid-side-has-evidence) caller.
    avoid_text: Optional[str] = None

    if preferred_desc_suffix == "open":
        if approach_framed and avoid_desc_suffix != "open":
            # Name the evidence that drove the pick: the AVOID side's own
            # hazard, never a new claim (side_hazard_desc is the same
            # grounded lookup used by avoid_text below). Evidence-first
            # phrasing (hazard word immediately followed by its OWN side
            # word) matters here, not just style: `guide_writer._has_side_
            # flip`'s nearest-side-word scan would otherwise anchor the
            # hazard on the earlier "Miss {pref}" side word (the opposite,
            # wrong side) purely by word proximity.
            avoid_word = _guard_side_word.get(avoid_side, avoid_side)
            pref_text = (
                f"{avoid_desc_suffix.capitalize()} guards {avoid_word} — "
                f"miss {preferred}"
            )
        elif approach_framed:
            # cycle-3 commit 4 (Target 2a): BOTH sides open on an
            # approach-framed turn — the "safe side, easy recovery" claim in
            # the `else` branch below is evidence-free (no side's own
            # mapped hazard drove the pick), and on bethpage h18 the map
            # shows short trouble just outside the `distance_from_green <=
            # 20` evidence window, making the claim visibly wrong. Honest
            # degrade (contract option 2): state there is no strong
            # miss-side mapping instead of an unsupported "safe" claim.
            # `preferred`/`avoid` SELECTION is untouched — only these two
            # spoken clauses soften, and only on this sub-branch. Wording is
            # deliberately hazard-noun-free (`_HAZARD_PATTERNS` would
            # false-red a synth that echoes "no water") and side-word-free
            # next to any hazard noun (`_has_side_flip`'s proximity scan —
            # same trap the comment above already documents), with no
            # "safe" claim anywhere.
            pref_text = "No strong miss side mapped — middle of the green, two-putt range"
            avoid_text = "No mapped trouble tight to the green"
        else:
            pref_text = f"Miss {pref_label.get(preferred, preferred).lower()} — safe side, easy recovery"
    else:
        if approach_framed:
            pref_word = _SPOKEN_SIDE_WORD.get(preferred, preferred)
            pref_text = (
                f"Miss {pref_label.get(preferred, preferred).lower()} — "
                f"{preferred_desc_suffix} {pref_word} but manageable"
            )
        else:
            pref_text = f"Miss {pref_label.get(preferred, preferred).lower()} — {preferred_desc_suffix} but manageable"

    if avoid_text is None:
        avoid_text = f"Don't miss {avoid_side} — {avoid_desc_suffix}"

    return MissSide(
        preferred=preferred,
        description=pref_text,
        avoid=avoid_text,
    )


def _greenside_hazards_line(hazards: list[Hazard]) -> Optional[str]:
    """P2 hazard-awareness seed (approach-solve plan §1.3), reachable branch
    only, gated on `approach_framed` by the caller: types+sides only, no
    numbers — reads the exact same greenside population `compute_miss_side`
    does (`distance_from_green <= 20`). `None` when nothing is mapped near
    the green (never a placeholder line)."""
    near = [h for h in hazards if h.distance_from_green <= 20]
    if not near:
        return None
    parts: list[str] = []
    seen: set[tuple[str, str]] = set()
    for h in near:
        noun = _HAZARD_NOUNS.get(h.type.lower(), "trouble")
        side_word = _SPOKEN_SIDE_WORD.get(h.side, h.side)
        key = (noun, side_word)
        if key in seen:
            continue
        seen.add(key)
        parts.append(f"{noun} {side_word}")
    if not parts:
        return None
    return "Around the green: " + ", ".join(parts)


# ── Reachability classification (positioning shots) ────────────────────────
#
# specs/caddie-shot-context-reachability-plan.md §1 (owner incident
# 2026-07-06: "aim 9y left of the flag" on a 400y par-4 tee shot — the green
# was never in reach, so any pin-relative aim was wrong golf reasoning).
# When the best club in the bag can't reach the green (plus a front-edge
# margin), the shot is a POSITIONING shot: the flag doesn't exist for this
# swing — see compute_positioning_aim / compute_positioning_miss_side below.

# Distance-to-green is (nearly always) to the CENTER of the green; a ball
# finishing on the front edge has still reached it. Half a typical green
# depth; overridden by the hole's real measured depth when mapped.
GREEN_REACH_MARGIN_YDS: int = 15

# ── Approach frame (specs/caddie-approach-solve-plan.md §0) ────────────────
#
# A turn only re-frames tee-anchored carry_yards into the player's own frame
# when the player has provably advanced past the tee by more than combined
# GPS jitter + carry rounding. Below this the tee frame stands — which is
# what keeps every shipped reachable/tee test (all offset ~0) byte-identical.
APPROACH_FRAME_MIN_TEE_OFFSET_YDS: int = 25
# A from-here carry below this is "already effectively cleared" (hazards.py
# rounds carries to 5; GPS is a +/-10y-class instrument) — the carry line is
# SUPPRESSED, never spoken as a 5-yard carry (Pebble-3 evidence case).
EN_ROUTE_CLEARED_SUPPRESS_YDS: int = 20


def is_green_reachable(
    adjusted_yards: int,
    clubs: dict[str, int],
    green_depth_yards: Optional[float] = None,
) -> bool:
    """Can ANY club in the bag reach the green on this swing?

    `adjusted_yards` is already the physics plays-like distance
    (`compute_adjustments`, anchored to this player's bag) — the same number
    `select_club` compares against — so wind/elevation move the reachability
    verdict for free, and `get_recommendation` can never disagree with
    itself about it within a turn. Bag fallback is `DEFAULT_CLUB_DISTANCES`,
    the same fallback `select_club` has always used — never a fabricated
    number. Margin = front-edge allowance: `green_depth_yards / 2` when the
    green is mapped, else `GREEN_REACH_MARGIN_YDS`.
    """
    distances = clubs or DEFAULT_CLUB_DISTANCES
    max_reach = max(distances.values())
    margin = (green_depth_yards / 2.0) if green_depth_yards else GREEN_REACH_MARGIN_YDS
    return max_reach + margin >= adjusted_yards


def compute_positioning_miss_side(zone: list[Hazard]) -> MissSide:
    """Sibling of `compute_miss_side`, but over the driving-zone hazards
    (`drive_zone_hazards` — the tee-anchored `carry_yards` frame) instead of
    green-side hazards. Prefers the lateral side with less risk in THIS
    shot's landing window; no in-zone hazard data degrades to an honest
    generic (nothing fabricated).

    Owner incident (Bethpage Black hole 1, specs/caddie-numbers-coherence-plan
    .md §1.4 / §3.1): trees mapped on BOTH sides of the drive zone, equal
    severity — a bare `<=` tie-break spoke a confident "favor the left side"
    when there was no good miss. A true both-sides tie now degrades honestly
    to `preferred="center"` / "no good miss, commit to the fairway" instead
    of picking a side to sound decisive. A clear winner that ALSO has mapped
    trouble says so, rather than a clean "favor X" that hides X's own risk.
    """
    if not zone:
        return MissSide(
            preferred="short",
            description="No mapped trouble in the driving zone — worst case is a longer approach",
            avoid="Don't chase distance you don't need",
        )

    def severity_score(hzds: list[Hazard]) -> float:
        scores = {"mild": 1, "moderate": 2, "severe": 3, "death": 5}
        if not hzds:
            return 0
        return max(scores.get(h.penalty_severity, 0) for h in hzds)

    def types_desc(hzds: list[Hazard]) -> str:
        return ", ".join(sorted({h.type for h in hzds}))

    left = [h for h in zone if h.line_side.lower() == "left"]
    right = [h for h in zone if h.line_side.lower() == "right"]
    left_score = severity_score(left)
    right_score = severity_score(right)

    if left_score > 0 and right_score > 0 and left_score == right_score:
        # Honest both-sides degradation — the Bethpage-1 fix. Never a
        # one-sided preference when the data shows trouble on both sides.
        return MissSide(
            preferred="center",
            description=(
                f"Trouble both sides in the driving zone — {types_desc(left + right)} left "
                "and right. No good miss; commit to the fairway."
            ),
            avoid="Don't favor either side — the fairway is the only safe ground",
        )

    if left_score <= right_score:
        preferred, worst_side, worst_hazards, pref_hazards = "left", "right", right, left
    else:
        preferred, worst_side, worst_hazards, pref_hazards = "right", "left", left, right

    if worst_hazards:
        types_str = types_desc(worst_hazards)
        avoid = f"Don't miss {worst_side} — {types_str}"
        if pref_hazards:
            # The preferred side is the LESSER risk, but it isn't safe —
            # never a clean "favor X" that hides X's own mapped trouble.
            description = (
                f"Favor the {preferred} side — {worst_side} is worse ({types_str}), but "
                f"{types_desc(pref_hazards)} {preferred} are in play too."
            )
        else:
            description = f"Favor the {preferred} side off the tee — {worst_side} has trouble in the driving zone"
    else:
        avoid = f"Don't miss {worst_side}"
        description = f"Favor the {preferred} side off the tee"

    return MissSide(preferred=preferred, description=description, avoid=avoid)


def compute_positioning_aim(
    leave_yards: int,
    landing_advice: Optional[str] = None,
) -> AimPoint:
    """Composes the positioning-shot AimPoint description shown in
    CaddiePanel and spoken via the "Last recommendation" prompt lines.

    `landing_advice` is the (already-computed, possibly `None`)
    `decade_landing_advice` string — passed in rather than recomputed so the
    optimizer runs exactly once per recommendation. Only the directional
    clause ("favor the right half of the fairway") is folded into the aim
    description; the hazard specifics ride along separately as their own
    P1 reasoning line. `lat`/`lng`/`bearing` stay `None`, same as today's
    reachable path.
    """
    if landing_advice:
        side_clause = landing_advice.split(" — ", 1)[0]
        side_clause = side_clause[0].lower() + side_clause[1:]
    else:
        side_clause = "middle of the fairway"
    description = f"Positioning shot — green's out of reach. {side_clause}; leaves about {leave_yards} in."
    return AimPoint(description=description)


# ── Tee-shot numbers (specs/caddie-numbers-coherence-plan.md §2.2) ─────────
#
# Owner incident (2026-07, Bethpage Black hole 1, 466y par 4): the caddie
# spoke a leave of 125, a raw driver of 300, and a physics total of 280 —
# three numbers from three unconnected sources that never had to agree. This
# is the ONE place a positioning shot's numbers are computed, so every mouth
# speaks the same closing arithmetic.


def physics_drive_total(
    hole: HoleIntelligence,
    club: str,
    club_dist: int,
    weather: Optional[WeatherConditions],
    shot_bearing: float,
    competition_legal: bool,
) -> tuple[Optional[int], int]:
    """The physics-delivered drive for `club` in today's conditions.

    Returns `(drive_carry_yards, drive_total_yards)` through the EXACT SAME
    call shape as the `get_shot_distance` tool
    (`tools.py::shot_distance_payload`) — the single source of truth for a
    club's drive total. Every caller (reachability classification,
    `compute_tee_shot_numbers`) goes through THIS function so the numbers
    can never diverge from a second, independently-rounded physics call
    (specs/caddie-numbers-coherence-plan.md §2.2 — a downhill-short-hole
    frame mismatch between the reachability check and the drive-total
    calculation was the exact confabulation trigger this closes).
    """
    if competition_legal:
        # USGA-conforming: no environmental physics anywhere in the block —
        # the drive total IS the stored number, still closes exactly.
        return None, club_dist

    cond, _ = physics.conditions_from_weather(
        weather, shot_bearing,
        elevation_delta_ft=hole.elevation_change_ft,
        carry_hint_yards=float(club_dist),
    )
    result = physics.shot_distance_for_club(club, float(club_dist), cond)
    return round(result.carry_yards), round(result.total_yards)


def compute_tee_shot_numbers(
    hole: HoleIntelligence,
    distance_yards: int,
    adjusted_yards: int,
    club: str,
    club_dist: int,
    weather: Optional[WeatherConditions],
    shot_bearing: float,
    competition_legal: bool,
    yardage_basis: Optional[str] = None,
    drive_yards: Optional[tuple[Optional[int], int]] = None,
) -> "TeeShotNumbers":
    """The one authoritative numbers block for a positioning/tee shot.

    Drive physics run through `physics_drive_total` — the EXACT SAME call
    shape as the `get_shot_distance` tool — physics parity by construction,
    not convention. `drive_yards`, when provided, is the ALREADY-COMPUTED
    `(carry, total)` pair from the reachability check upstream in
    `generate_recommendation` — reused verbatim rather than recomputed, so
    the drive numbers this block prints are byte-identical to the ones that
    decided reachability (never a second, independently-rounded call that
    could diverge). `leave_exact_yards` is the raw closing arithmetic
    (`to_green_yards - drive_total_yards`, SIGNED — may be <= 0 on a
    residual sub-boundary case); `leave_yards` is its round-to-5, floored-at-
    0 spoken form. `leave_plays_like_yards` keeps today's plays-like-frame
    number as a labeled extra, never the primary leave
    (specs/caddie-numbers-coherence-plan.md §2.2's documented leave-frame
    redefinition — the raw frame is what the golfer's own arithmetic checks,
    so it's the frame the caddie now speaks).
    """
    if drive_yards is not None:
        drive_carry_yards, drive_total_yards = drive_yards
    else:
        drive_carry_yards, drive_total_yards = physics_drive_total(
            hole, club, club_dist, weather, shot_bearing, competition_legal,
        )

    leave_exact_yards = distance_yards - drive_total_yards
    leave_yards = round(max(0, leave_exact_yards) / 5) * 5
    leave_plays_like_yards = round(max(0, adjusted_yards - club_dist) / 5) * 5

    return TeeShotNumbers(
        hole_number=hole.hole_number,
        to_green_yards=distance_yards,
        yardage_basis=yardage_basis,
        plays_like_yards=adjusted_yards,
        club=club,
        club_stored_yards=club_dist,
        drive_carry_yards=drive_carry_yards,
        drive_total_yards=drive_total_yards,
        leave_exact_yards=leave_exact_yards,
        leave_yards=leave_yards,
        leave_plays_like_yards=leave_plays_like_yards,
    )


# ── Corridor v1 — bend-aware club cap (specs/caddie-numbers-coherence-plan.md
# §4.1). Bend-cap ONLY: full corridor-width club selection (§4.4) is a
# fully-specified follow-up, not built here. Owner incident (Bethpage RED 3):
# "driver by default" flew through a mapped corner into trees the engine
# already knew about (HoleIntelligence.bend) but never consulted for club.

# Tolerance before a drive is judged to "overshoot" a mapped corner — small
# enough to still catch a real fly-through, generous enough that a drive
# landing essentially AT the corner doesn't false-positive.
CORNER_OVERSHOOT_TOLERANCE_YDS: int = 10

# A corridor cap never fires on a corner mapped closer than this — inside
# this range the whole "which club reaches the corner" question is moot
# (every club in a normal bag lands short of it anyway).
CORNER_MIN_DISTANCE_YDS: int = 120

# Tree evidence must sit within this many yards SHORT of the mapped corner to
# count as "guarding" it — a stand well short of the corner isn't the hazard
# that punishes flying through the bend itself.
CORNER_TREE_LOOKBACK_YDS: int = 20

# Tree evidence must ALSO sit within this many yards PAST the mapped corner
# to count as "guarding" it (all-courses audit, specs/caddie-yardage-
# selector-p0-plan.md §3.5 Class A, 2026-07-18: the filter below had NO
# upper bound on `h.carry_yards` — ANY tree hazard anywhere past
# `bend.distance_yards - CORNER_TREE_LOOKBACK_YDS`, even one clustered near
# or past the GREEN, silently counted as "guarding" the corner. The audit's
# prod sweep (166 par-4/5 holes, 12 mapped courses) convicted this exact
# mechanism: every bogus bend-cap FLAG had its nearest qualifying tree
# 60-280y PAST the corner (i.e. greenside, unrelated to the dogleg) while
# every legit cap had a tree within ~30y of the corner in EITHER direction —
# deviation_yards did NOT separate the two classes (the bogus holes' bends
# were real, substantial doglegs; a deviation threshold alone would not have
# caught them). This constant closes that gap at the evidence-qualification
# layer, never touching the E-model or water costs.
CORNER_TREE_FORWARD_YDS: int = 40

_SEVERITY_RANK: dict[str, int] = {"mild": 1, "moderate": 2, "severe": 3, "death": 5}
_MODERATE_RANK: int = _SEVERITY_RANK["moderate"]


def _select_club_capped_at(
    clubs: dict[str, int],
    max_total_yards: float,
    weather: Optional[WeatherConditions],
    shot_bearing: float,
    elevation_change_ft: float,
    competition_legal: bool,
) -> Optional[tuple[str, int]]:
    """Longest club in the bag whose CONDITIONS TOTAL lands short of
    `max_total_yards` — walks the bag descending, re-running
    `shot_distance_for_club` per candidate (competition_legal walks stored
    numbers, same USGA-conforming rule `compute_tee_shot_numbers` follows).
    `None` when even the shortest club in the bag overshoots — no club helps,
    so the caller keeps today's recommendation rather than fabricate a cap.
    """
    bag = clubs or DEFAULT_CLUB_DISTANCES
    for candidate, dist in sorted(bag.items(), key=lambda x: x[1], reverse=True):
        if competition_legal:
            total = float(dist)
        else:
            cond, _ = physics.conditions_from_weather(
                weather, shot_bearing,
                elevation_delta_ft=elevation_change_ft,
                carry_hint_yards=float(dist),
            )
            total = physics.shot_distance_for_club(candidate, float(dist), cond).total_yards
        if total <= max_total_yards:
            return candidate, dist
    return None


# ── Expected-strokes club selection (specs/caddie-tee-club-expected-strokes-
# plan.md, P0 fix for the corridor-width hard fit-wall above). Owner field
# report: "The caddie is extremely conservative. Tells me to hit 7 iron
# instead of driver." The width-fit rule (`_club_fit_window_yds`, retired)
# was a hard corridor constraint with no expected-strokes tradeoff — it
# rejected driver as a WALL the instant its ±1.5σ dispersion window exceeded
# an ordinary tree-lined corridor's danger-to-danger width, regardless of (a)
# distance sacrificed, (b) actual trouble PROBABILITY (a wide cone over a
# narrower corridor only clips the cone's tails), (c) hazard severity. This
# block replaces it with an honest expected-strokes tradeoff: for each
# candidate club, E = (expected strokes to hole out from the leave) + (per-
# side trouble probability × per-side hazard-severity cost). Pick the
# strict-min E; ties within 0.02 strokes go to the LONGER club (plan §3).
#
# Precedence unchanged: runs AFTER the v1 bend-cap block, ceiling = the
# (possibly already-capped) club's drive_total_yards — it can only shorten
# further, never relax the bend-cap (take-the-shorter composition).

# Severity cost of finishing in trouble on one side, in SCRATCH strokes (plan
# §3.3): trees ≈ a punch-out (~1 stroke) minus the value of the yardage
# advanced (~0.65-0.7 net); water ≈ stroke-and-distance/lateral drop
# (~1.2-1.4, biased honestly toward avoiding it). Unknown/other source falls
# back to the trees-level generic (never the harsher water number on
# unlabeled evidence).
#
# HANDICAP-SCALED at the point of use (reviewer B2, blocking): every
# `approach_expected_strokes` term IS handicap-multiplied (×1.22 at hcp 15,
# up to ×1.55 at hcp 30), so a FLAT cost here inflates the value of distance
# relative to the cost of trouble by that same 22-55% for every handicap
# above scratch — on the plan's own canonical water pinch this kept driver
# at ~39-52% water-landing probability with a "nothing shorter beats that
# trade" note, the plan's own definition of the wrong pick. Multiplying by
# the SAME `_handicap_multiplier` the approach term already carries restores
# the two terms to a commensurate scale for every handicap, not just
# scratch — see `_select_club_expected_strokes` for the multiplication.
_PENALTY_COST: dict[str, float] = {"trees": 0.7, "water": 1.4}
_DEFAULT_PENALTY_COST: float = 0.7

# Backstop floor (plan §3.5): never lay back more than this many yards off
# the longest surviving (ceiling-permitted) club on trouble alone — the
# extended approach-strokes math already makes a >1-club layback strokes-
# negative for trees; this is a hard guardrail, not the thing doing the
# normal-play work. The bend-cap's own ceiling is a different, through-the-
# corner mechanism and is exempt (it already ran before this block).
_LAYBACK_FLOOR_YDS: int = 100

# Tie tolerance (plan §3): a strict-min E rule with no tolerance would swap
# clubs on rounding noise; within this many strokes, the LONGER club wins.
_E_TIE_TOLERANCE: float = 0.02

# ── Trouble ceiling (backlog `caddie-tee-club-tree-severity-calibration`,
# fable-review non-blocker follow-up to the P0 fix) ─────────────────────────
#
# Observed: a hcp-30 player on a genuinely tight (~20y) tree chute still gets
# driver even after the handicap-scaled `_PENALTY_COST` fix above (reviewer
# B2) — driver carries ~72% combined trouble probability there and the
# E-model STILL prefers it. Verified numerically this is NOT fixable by
# raising the flat/handicap-scaled cost further: on the reported bag
# (driver/3wood/5wood/hybrid/7iron), the next-shortest club that clears the
# floor (hybrid) only drops P by ~0.06 versus driver while costing ~0.63
# strokes more approach distance — flipping the E-ordering via cost alone
# needs a >10x multiplier on `_PENALTY_COST["trees"]` (a "trees" miss costing
# more strokes than the water constant, i.e. worse than a plain penalty
# drop), which is not a believable severity number. A dispersion-width
# super-linear cost was also tried: the long clubs' dispersion widths cluster
# too closely at high handicap (driver 110y vs hybrid 90y at hcp 30) to
# produce enough differentiation either.
#
# The lever that DOES work, and the one the fable follow-up explicitly named
# as a candidate: an absolute P(trouble) ceiling — a risk tolerance that
# tightens with handicap, modeling that a weaker player should refuse a
# near-coin-flip tee shot regardless of what the raw expected-strokes math
# says (variance a poor player can't afford, not captured by a pure E[strokes]
# average). Implementation: among the bend-cap/floor survivors, prefer the
# E-min club whose OWN combined trouble probability is <= this ceiling; if
# NONE clear the ceiling, fall back to plain E-min over all survivors
# (today's contract — "no club helps, don't fabricate one").
#
# Calibrated to be a NO-OP at/below handicap 15 (0.95 comfortably exceeds the
# worst combined P seen anywhere in the pinned regression battery — 0.9151 in
# `test_corridor_width_selection.py::test_04`'s deliberately pathological 5y
# blanket-narrow corridor, which explicitly pins "driver still wins, no
# fallback" at hcp 15) — every hcp<=15 shipped test is therefore provably
# byte-identical. Tightens above 15 so a hcp-30 player on the reported 20y
# chute (driver P~0.716) is pushed down to the longest club that clears the
# bar (hybrid, P~0.657 there) while a 40y+ corridor (driver P<=0.47 at hcp
# 30) or a scratch/mid-handicap player on the same 20y chute (driver
# P<=0.59) never trips it.
_TROUBLE_CEILING_BY_HANDICAP: dict[int, float] = {
    0: 1.00,
    15: 0.95,
    20: 0.85,
    25: 0.75,
    30: 0.68,
    36: 0.62,
}


def _trouble_ceiling(handicap: float) -> float:
    """Interpolate the handicap-scaled trouble-probability ceiling (same
    piecewise-linear-between-breakpoints style as `_handicap_multiplier` /
    `dispersion._interpolate_handicap`)."""
    hcp = max(0.0, min(36.0, handicap))
    keys = sorted(_TROUBLE_CEILING_BY_HANDICAP.keys())

    if hcp <= keys[0]:
        return _TROUBLE_CEILING_BY_HANDICAP[keys[0]]
    if hcp >= keys[-1]:
        return _TROUBLE_CEILING_BY_HANDICAP[keys[-1]]

    for i in range(len(keys) - 1):
        k1, k2 = keys[i], keys[i + 1]
        if k1 <= hcp <= k2:
            t = (hcp - k1) / (k2 - k1)
            v1 = _TROUBLE_CEILING_BY_HANDICAP[k1]
            v2 = _TROUBLE_CEILING_BY_HANDICAP[k2]
            return v1 + t * (v2 - v1)

    return _TROUBLE_CEILING_BY_HANDICAP[keys[-1]]


def _phi(x: float) -> float:
    """Standard normal CDF via stdlib `math.erf` — Φ(x) = P(Z <= x)."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2)))


def _trouble_probability(
    sample: Optional[CorridorSample],
    club: str,
    handicap: float,
) -> tuple[float, float]:
    """Per-side tail probability `(P_left, P_right)` of finishing in trouble,
    aiming at the CENTERLINE (the honest default when no aim instruction is
    emitted — plan §3.2 reviewer follow-up NB1). σ = this club's dispersion
    `width_yards` / 4 (the table's ±2σ lateral spread).

    Each side's clearance is that side's OWN measured danger-edge offset
    (`sample.left_yards` / `sample.right_yards`) — `P_side = 1 -
    Φ(offset/σ)`. This is byte-identical to a symmetric corridor (where
    `left_yards == right_yards == width/2`, the old midpoint-aim formula) but
    honest on an ASYMMETRIC one: a corridor with water 10y right / trees 40y
    left no longer understates the tight side by averaging it into a
    width/2-from-the-midpoint aim that was never actually spoken as an
    instruction. An unknown edge on a side contributes 0 — never penalize
    missing data ([[no-fake-data-fallbacks]]). `sample is None` (no evidence
    at this landing distance) -> `(0.0, 0.0)`.
    """
    if sample is None:
        return 0.0, 0.0

    dispersion_width = get_dispersion(club, handicap)["width_yards"]
    if dispersion_width <= 0:
        return 0.0, 0.0
    sigma = dispersion_width / 4.0

    p_left = 1.0 - _phi(sample.left_yards / sigma) if sample.left_yards is not None else 0.0
    p_right = 1.0 - _phi(sample.right_yards / sigma) if sample.right_yards is not None else 0.0
    return p_left, p_right


def _trouble_words(sample: Optional[CorridorSample]) -> tuple[str, str, str]:
    """Wording for the `corridor_note`, justified by the SAME sample's own
    source fields, never a new claim. Returns `(risk_noun, pinch_noun,
    swap_adjective)` — e.g. `("tree risk", "tree", "in the trees")` or
    `("water risk", "water", "wet")`. Water wins when both sources are
    present (the more severe, more speakable warning); falls back to the
    generic "trouble" when the sample carries no source at all."""
    if sample is None:
        return "trouble", "trouble", "in trouble"
    sources = {s for s in (sample.left_source, sample.right_source) if s}
    if "water" in sources:
        return "water risk", "water", "wet"
    if "trees" in sources:
        return "tree risk", "tree", "in the trees"
    return "trouble", "trouble", "in trouble"


class ExpectedStrokesFit(NamedTuple):
    club: str
    dist: int
    total: int
    sample: Optional[CorridorSample]
    p_left: float
    p_right: float
    e_total: float
    leave: int
    # Best-rejected-LONGER club considered (the longest ceiling/floor-
    # surviving candidate, when it lost to a shorter club) — None when the
    # chosen club IS that longest candidate (no swap happened).
    alt_club: Optional[str]
    alt_total: Optional[int]
    alt_sample: Optional[CorridorSample]
    alt_p_left: Optional[float]
    alt_p_right: Optional[float]
    alt_e_total: Optional[float]
    alt_leave: Optional[int]


def _select_club_expected_strokes(
    clubs: dict[str, int],
    corridor: list[CorridorSample],
    to_green_yards: int,
    handicap: float,
    weather: Optional[WeatherConditions],
    shot_bearing: float,
    elevation_change_ft: float,
    competition_legal: bool,
    ceiling_total_yards: float,
) -> Optional[ExpectedStrokesFit]:
    """Walks the bag descending (same per-candidate `physics.
    shot_distance_for_club` call shape as `_select_club_capped_at`), skips
    candidates whose rounded conditions total exceeds `ceiling_total_yards`
    (never undoes the bend-cap — take-the-shorter composition, unchanged),
    excludes candidates more than `_LAYBACK_FLOOR_YDS` short of the longest
    ceiling-surviving candidate (the floor; the bend-cap's own ceiling
    already ran and is exempt from this second cut), computes each
    survivor's expected strokes `E = approach_expected_strokes(leave,
    handicap) + P_left*cost(left_source) + P_right*cost(right_source)`, and
    picks the STRICT min E — ties within `_E_TIE_TOLERANCE` strokes go to the
    LONGER club (plan §3). `None` when the bag is empty or every candidate
    exceeds the ceiling — caller keeps today's club, same "no club helps,
    don't fabricate a cap" contract as `_select_club_capped_at`/
    `_select_club_fitting_corridor` before it.

    `_PENALTY_COST` is HANDICAP-SCALED here (reviewer B2, blocking) by the
    SAME `_handicap_multiplier` `approach_expected_strokes` already applies
    to the approach term — without it the flat cost understates trouble
    relative to distance for every handicap above scratch.

    Among the survivors, the pick additionally prefers the E-min club whose
    own combined P(trouble) clears `_trouble_ceiling(handicap)` (calibration
    follow-up, see that constant's note) — a no-op at/below handicap 15.
    """
    bag = clubs or DEFAULT_CLUB_DISTANCES
    hcp_mult = _handicap_multiplier(handicap)
    survivors: list[tuple[str, int, int, Optional[CorridorSample], float, float, float, int]] = []
    longest_total: Optional[int] = None

    for candidate, dist in sorted(bag.items(), key=lambda x: x[1], reverse=True):
        if competition_legal:
            total = float(dist)
        else:
            cond, _ = physics.conditions_from_weather(
                weather, shot_bearing,
                elevation_delta_ft=elevation_change_ft,
                carry_hint_yards=float(dist),
            )
            total = physics.shot_distance_for_club(candidate, float(dist), cond).total_yards
        # Round before the ceiling comparison — see _select_club_capped_at's
        # sibling note: `ceiling_total_yards` is itself a rounded physics
        # total, so comparing unrounded totals against it can spuriously
        # exclude the very club that produced the ceiling.
        total = round(total)
        if total > ceiling_total_yards:
            continue  # never undo the bend-cap

        if longest_total is None:
            longest_total = total
        elif total < longest_total - _LAYBACK_FLOOR_YDS:
            continue  # floor — trees/water alone can't justify more than this

        leave = max(0, to_green_yards - total)
        e_ap = approach_expected_strokes(leave, handicap)
        sample = corridor_sample_at(corridor, total)
        p_left, p_right = _trouble_probability(sample, candidate, handicap)
        cost_left = (_PENALTY_COST.get(sample.left_source, _DEFAULT_PENALTY_COST) * hcp_mult) if sample is not None else 0.0
        cost_right = (_PENALTY_COST.get(sample.right_source, _DEFAULT_PENALTY_COST) * hcp_mult) if sample is not None else 0.0
        e_total = e_ap + p_left * cost_left + p_right * cost_right

        survivors.append((candidate, dist, total, sample, p_left, p_right, e_total, leave))

    if not survivors:
        return None

    longest = survivors[0]

    # Trouble ceiling (calibration follow-up, see the constant's own note
    # above): prefer the E-min club whose OWN combined P(trouble) clears the
    # handicap-scaled bar; if none do, fall back to plain E-min over every
    # survivor (today's untouched contract). `pool` keeps `survivors`'
    # longest-to-shortest order, so `pool[0]` is the longest CONTROLLABLE
    # candidate when the ceiling actually excludes something.
    ceiling = _trouble_ceiling(handicap)
    qualifying = [s for s in survivors if (s[4] + s[5]) <= ceiling]
    pool = qualifying if qualifying else survivors

    best = pool[0]
    for s in pool[1:]:
        if s[6] < best[6] - _E_TIE_TOLERANCE:
            best = s

    alt = longest if best is not longest else None

    return ExpectedStrokesFit(
        club=best[0], dist=best[1], total=best[2], sample=best[3],
        p_left=best[4], p_right=best[5], e_total=best[6], leave=best[7],
        alt_club=alt[0] if alt else None,
        alt_total=alt[2] if alt else None,
        alt_sample=alt[3] if alt else None,
        alt_p_left=alt[4] if alt else None,
        alt_p_right=alt[5] if alt else None,
        alt_e_total=alt[6] if alt else None,
        alt_leave=alt[7] if alt else None,
    )


def generate_recommendation(
    hole: HoleIntelligence,
    distance_yards: int,
    club_distances: dict[str, int],
    handicap: float = 15.0,
    weather: Optional[WeatherConditions] = None,
    player_stats: Optional[PlayerStatistics] = None,
    shot_bearing: float = 0.0,
    competition_legal: bool = False,
    yardage_basis: Optional[str] = None,
) -> CaddieRecommendation:
    """Generate a complete caddie recommendation for a shot.

    This is the main orchestrator that combines all engines.

    When ``competition_legal`` is True the recommendation is USGA-conforming:
    no environmental distance adjustments are applied (target_yards == raw_yards,
    adjustments list is empty).  Aim/miss-side/strategy logic is unchanged —
    only the yardage calculation is locked to raw geometric distance.
    """
    # Normalize club distances
    clubs = normalize_club_distances(club_distances) if club_distances else {}

    # Compute adjusted distance.
    # Competition-legal mode: skip ALL environmental adjustments so the yardage
    # the golfer uses is pure geometric distance — the only number permitted by
    # the USGA for distance-measuring devices in competition.
    if competition_legal:
        adjusted_yards = distance_yards
        adjustments = []
    else:
        adjusted_yards, adjustments = compute_adjustments(
            raw_distance=distance_yards,
            elevation_change_ft=hole.elevation_change_ft,
            weather=weather,
            shot_bearing=shot_bearing,
            club_distances=clubs,  # anchors the physics solve to the player's bag
        )

    # Select club
    # DECADE bias: conservative for approach shots, moderate for tee shots.
    # hole.yards is None when yardage is unknown (no fake fallback) — treat
    # as an approach shot (conservative) rather than crashing on None * 0.85.
    is_tee_shot = hole.yards is not None and distance_yards >= hole.yards * 0.85
    bias = "moderate" if is_tee_shot else "conservative"
    club, club_dist = select_club(adjusted_yards, clubs, bias=bias)

    # Reachability classification (specs/caddie-shot-context-reachability-plan.md,
    # specs/caddie-numbers-coherence-plan.md §2.2 frame-alignment fix).
    # Reachable → today's flag-relative path, byte-identical. Not reachable →
    # positioning shot: the flag doesn't exist for this swing, landing-zone
    # advice instead (owner incident 2026-07-06: pin-relative aim on an
    # unreachable 400y tee shot).
    #
    # A drive whose PHYSICS total reaches the raw to-green distance is
    # reachable even when the still-air plays-like frame (`is_green_reachable`)
    # says otherwise — e.g. a steep-downhill short hole where the physics
    # elevation boost carries the selected club's drive past the green while
    # the still-air check (which never sees elevation) still fails it. The
    # physics frame is the truthful one: it's the same number the drive-total
    # equation prints, so the two can never disagree about whether the hole
    # is drivable (the exact confabulation trigger this closes — a drive
    # total >= the hole with a printed "leaves 0" positioning block).
    # Computed ONCE here and reused verbatim in `compute_tee_shot_numbers`
    # below so the drive numbers stay parity-identical — never a second,
    # independently-rounded physics call that could diverge.
    selected_drive_yards = physics_drive_total(
        hole, club, club_dist, weather, shot_bearing, competition_legal,
    )
    reachable = (
        is_green_reachable(adjusted_yards, clubs, hole.green_depth_yards)
        or selected_drive_yards[1] >= distance_yards
    )
    max_reach = max((clubs or DEFAULT_CLUB_DISTANCES).values())
    leave_yards: Optional[int] = None
    tee_shot_numbers: Optional[TeeShotNumbers] = None
    corridor_note: Optional[str] = None

    # Aim point / miss side / pin light — branch on reachability.
    zone: list[Hazard] = []
    landing_advice: Optional[str] = None
    pin_light: Optional[str] = None
    if reachable:
        aim = compute_aim_point(hole, player_stats, handicap, distance_yards=distance_yards)
        miss = compute_miss_side(hole, player_stats, distance_yards=distance_yards)
        pin_light = classify_pin_position(hole)
        # ONE en-route/approach-frame solve for the whole reachable branch
        # (approach-solve plan §1.1) — the P1 hazard-carry reasoning line, the
        # wind-binding P1 line, and the greenside P2 line all key off this
        # SAME computation so they can never disagree within a turn.
        erp = en_route_from_player(hole, distance_yards)
    else:
        # ONE authoritative numbers block (specs/caddie-numbers-coherence-plan
        # .md §2.2) — everything downstream (leave, aim, landing advice, the
        # P0/P1 reasoning lines) speaks THIS block's leave, never a
        # separately-derived number. `drive_yards` reuses the exact physics
        # call that decided reachability above — same club, same conditions.
        tee_shot_numbers = compute_tee_shot_numbers(
            hole, distance_yards, adjusted_yards, club, club_dist,
            weather, shot_bearing, competition_legal, yardage_basis,
            drive_yards=selected_drive_yards,
        )

        # Corridor v1 — bend-aware club cap (§4.1, bend-cap only; the full
        # corridor-width follow-up is §4.4, not built here). A mapped corner
        # with tree evidence guarding it, that this club's drive would fly
        # through, caps the club to one that lands short of the corner —
        # "driver by default" dies structurally for mapped corners.
        bend = hole.bend
        if (
            bend is not None
            and not bend.straight
            and bend.distance_yards is not None
            and bend.distance_yards >= CORNER_MIN_DISTANCE_YDS
            and tee_shot_numbers.drive_total_yards > bend.distance_yards + CORNER_OVERSHOOT_TOLERANCE_YDS
        ):
            corner_trees = [
                h for h in hole.hazards
                if h.type == "trees"
                and bend.distance_yards - CORNER_TREE_LOOKBACK_YDS
                    <= h.carry_yards
                    <= bend.distance_yards + CORNER_TREE_FORWARD_YDS
                and _SEVERITY_RANK.get(h.penalty_severity, 0) >= _MODERATE_RANK
            ]
            if corner_trees:
                capped = _select_club_capped_at(
                    clubs, float(bend.distance_yards - 5),
                    weather, shot_bearing, hole.elevation_change_ft, competition_legal,
                )
                if capped is not None and capped[0] != club:
                    old_club_display = CLUB_DISPLAY_NAMES.get(club, club)
                    club, club_dist = capped
                    new_club_display = CLUB_DISPLAY_NAMES.get(club, club)
                    tee_shot_numbers = compute_tee_shot_numbers(
                        hole, distance_yards, adjusted_yards, club, club_dist,
                        weather, shot_bearing, competition_legal, yardage_basis,
                    )
                    corridor_note = (
                        f"{old_club_display} runs through the corner at ~{bend.distance_yards} "
                        f"into the trees — {new_club_display} keeps you short of it, leaves "
                        f"about {tee_shot_numbers.leave_yards}."
                    )

        # Expected-strokes club selection (specs/caddie-tee-club-expected-
        # strokes-plan.md, P0 fix — replaces the hard corridor-width fit-wall
        # that used to live here). Runs AFTER v1 bend-cap, ceiling = the
        # (possibly already bend-capped) club's drive_total_yards, so it can
        # only shorten further (take-the-shorter composition, plan §1).
        # `hole.corridor` falsy (None or `[]`) -> this entire block is
        # skipped -> byte-identical v1 payload (the only difference: the new
        # corridor_* keys stay `None`).
        if hole.corridor:
            fit = _select_club_expected_strokes(
                clubs, hole.corridor, distance_yards, handicap, weather, shot_bearing,
                hole.elevation_change_ft, competition_legal,
                ceiling_total_yards=tee_shot_numbers.drive_total_yards,
            )
            if fit is not None:
                # A rounding-tie candidate (`fit.club != club` but
                # `fit.alt_club is None`) is NOT a genuine trade-off decision
                # — `best` only differs from `club` because the walk's own
                # "longest ceiling-surviving candidate" landed on a
                # DIFFERENT club than the pre-existing (bend-cap-chosen)
                # `club` on a sub-yard physics rounding boundary alone (the
                # exact failure mode `_select_club_fitting_corridor`'s
                # `test_07` pinned). Only apply the swap when a real LONGER
                # candidate was actually out-traded on expected strokes
                # (`fit.alt_club is not None`) — otherwise keep today's
                # (bend-cap) club and note untouched.
                genuine_swap = fit.club != club and fit.alt_club is not None
                if genuine_swap:
                    club, club_dist = fit.club, fit.dist
                    tee_shot_numbers = compute_tee_shot_numbers(
                        hole, distance_yards, adjusted_yards, club, club_dist,
                        weather, shot_bearing, competition_legal, yardage_basis,
                    )

                if fit.club == club and (fit.sample is not None or fit.alt_sample is not None):
                    club_display = CLUB_DISPLAY_NAMES.get(club, club)
                    trouble_pct = round((fit.p_left + fit.p_right) * 100)
                    tee_shot_numbers.corridor_trouble_pct = trouble_pct
                    # NB3 (reviewer): repopulate the grounding width number
                    # (kept in the schema for cache compat) from the CHOSEN
                    # club's own sample — never fabricated, only when the
                    # danger-to-danger width at this landing distance is
                    # actually known (both edges known -> width_yards set).
                    if fit.sample is not None and fit.sample.width_yards is not None:
                        tee_shot_numbers.corridor_width_yards = fit.sample.width_yards

                    if fit.alt_club is not None:
                        # NB2 (reviewer): the "at Z" PINCH LOCATION names what
                        # the ALT (rejected-longer) club is being laid back
                        # from — its own sample. But the "{pct}% {adj}"
                        # attached to the CHOSEN club's OWN number must be
                        # labeled from the CHOSEN club's OWN sample, never the
                        # alt's — the two landing spots can carry different
                        # hazards (e.g. the layup club is still in a tree
                        # section while the alt reaches the water pinch), and
                        # mislabeling the chosen club's tree-risk number as
                        # "wet" misattributes it even though the digit itself
                        # is payload-true.
                        _, pinch_noun, _ = _trouble_words(fit.alt_sample)
                        _, _, chosen_adj = _trouble_words(fit.sample)
                        alt_display = CLUB_DISPLAY_NAMES.get(fit.alt_club, fit.alt_club)
                        alt_pct = round(((fit.alt_p_left or 0.0) + (fit.alt_p_right or 0.0)) * 100)
                        tee_shot_numbers.corridor_alt_club = fit.alt_club
                        tee_shot_numbers.corridor_alt_trouble_pct = alt_pct
                        tee_shot_numbers.corridor_alt_leave_yards = fit.alt_leave
                        tee_shot_numbers.corridor_alt_total_yards = fit.alt_total
                        # A real longer club lost the trade — this explains
                        # the FINAL club and REPLACES any earlier (e.g.
                        # bend-cap) note, same convention as v1's width note.
                        corridor_note = (
                            f"{club_display} lays back short of the {pinch_noun} pinch at "
                            f"{fit.alt_total} — about {trouble_pct}% {chosen_adj} versus "
                            f"{alt_pct}% with {alt_display}, leaves about {tee_shot_numbers.leave_yards}."
                        )
                    elif corridor_note is None:
                        # No swap: state the club's own risk (its OWN sample
                        # is the operative evidence here) so the caddie can
                        # narrate confidence WITH numbers instead of hedging
                        # without them (plan §8's DECISION_GROUNDING
                        # nuance). Never overwrite an existing note (e.g. the
                        # bend-cap's own) that already explains this club.
                        risk_noun, _, _ = _trouble_words(fit.sample)
                        corridor_note = (
                            f"{club_display} leaves about {tee_shot_numbers.leave_yards} with "
                            f"roughly {trouble_pct}% {risk_noun} — nothing shorter beats that trade."
                        )

        leave_yards = tee_shot_numbers.leave_yards

        # Driving-zone window around THIS shot's expected advance — not the
        # green-side frame. classify_pin_position is skipped: pin light is a
        # green concept and doesn't apply when the green isn't in play.
        # max_reach_yds caps the window at the player's own one-solve drive
        # total (`tee_shot_numbers.drive_total_yards`, computed once above
        # and already reused for reachability/the printed numbers — parity
        # by construction) so an out-of-reach hazard (e.g. a greenside
        # bunker) can never enter the tee-shot window (Finding C fix,
        # specs/caddie-hazard-side-reach-plan.md §4).
        max_reach_yds = float(tee_shot_numbers.drive_total_yards)
        zone = drive_zone_hazards(hole.hazards, float(club_dist), max_reach_yds=max_reach_yds)
        miss = compute_positioning_miss_side(zone)
        landing_advice = decade_landing_advice(
            hole.hazards, float(club_dist), float(leave_yards), handicap=handicap,
            max_reach_yds=max_reach_yds,
        )
        # Aim/miss coherence guard (§3.1): a "no good miss, commit to the
        # fairway" verdict can never be undercut by a lateral landing-advice
        # clause pointing to one side — aim and miss must never disagree.
        if miss.preferred == "center":
            landing_advice = None
        aim = compute_positioning_aim(leave_yards, landing_advice)

    # Build reasoning as (priority, text) tuples; see prioritize_reasoning for
    # the full priority scheme.  Order of appends within a priority is preserved
    # (stable sort), so add items in the order you want them to appear when two
    # items share a priority level.
    _r: list[tuple[int, str]] = []

    # Distance context: P1 for competition-legal (safety-critical), P4 otherwise (color)
    if competition_legal:
        _r.append((1, "Competition-legal mode: distance adjustments disabled (USGA conforming)"))
    elif adjustments:
        adj_summary = ", ".join(
            f"{a.type}: {'+' if a.yards > 0 else ''}{a.yards}y"
            for a in adjustments
        )
        _r.append((4, f"Distance adjustments: {adj_summary}"))

    # P4 — adjusted distance note (color; the club line already shows the adjusted yards)
    if adjusted_yards != distance_yards:
        _r.append((4, f"Plays {adjusted_yards} yards (raw {distance_yards})"))

    # P0 — club/distance fit line (ALWAYS kept, ALWAYS first)
    display_name = CLUB_DISPLAY_NAMES.get(club, club)
    _r.append((0, f"{display_name} ({club_dist}y) — best fit for {adjusted_yards}y"))

    if reachable:
        # P1 — safety-critical: pin traffic-light warning
        if pin_light == "red":
            _r.append((1, "Red light pin — play to the center, don't short-side yourself"))
        elif pin_light == "yellow":
            _r.append((1, "Yellow light pin — aim between pin and center"))
        elif pin_light == "green":
            governing = _governing_center_carry(erp.en_route) if erp.en_route else None
            if governing is not None:
                noun = _HAZARD_NOUNS.get(governing.type.lower(), "trouble")
                if erp.approach_framed:
                    _r.append((1, f"{noun.capitalize()} about {erp.from_here(governing)} out between you "
                                  f"and the green — take enough club to carry it"))
                else:
                    _r.append((1, f"{noun.capitalize()} at {governing.carry_yards} between you and "
                                  f"the green — take enough club to carry it"))
        # P1 — approach-framed wind binding (DEFECT 3, approach-solve plan
        # §1.4): the plays-like number is already IN adjusted_yards/
        # adjustments, but on an approach turn it never surfaced prominently
        # enough for the caddie's mouth. Competition-legal turns have
        # `adjustments == []` -> structurally can't fire (test_competition_
        # legal.py stays green).
        if erp.approach_framed:
            wind_adj = next((a for a in adjustments if a.type == "wind"), None)
            if wind_adj is not None and abs(wind_adj.yards) >= 10:
                _r.append((
                    1,
                    f"Wind is real here: plays about {adjusted_yards}, not "
                    f"{distance_yards} — {wind_adj.description}",
                ))
    else:
        # P1 — positioning-shot call-out (the fix for the incident: never a
        # pin-relative aim when the green is out of reach on this swing).
        _r.append((
            1,
            f"Green's out of reach ({adjusted_yards}y; your longest club is {max_reach}y)"
            f" — positioning shot, leaves about {leave_yards} in",
        ))
        # P1 — corridor v1 bend-cap explanation (§4.1) — the club change and
        # WHY, so the caddie never just silently plays a shorter club.
        if corridor_note:
            _r.append((1, corridor_note))
        # P1 — driving-zone DECADE landing advice + any dead-ahead cross hazard.
        if landing_advice:
            _r.append((1, landing_advice))
        cross_line = cross_hazard_line(zone, float(club_dist), CLUB_DISPLAY_NAMES.get(club, club))
        if cross_line:
            _r.append((1, cross_line))
        # P2 — fairway-bend-in-window line (honest reuse of HoleBend; omitted
        # when bend is None, per the unmapped-vs-straight discipline in
        # hazards.py — and omitted when the corridor note above already named
        # this exact corner, so the two lines don't repeat each other).
        bend = hole.bend
        if (
            corridor_note is None
            and bend is not None
            and not bend.straight
            and bend.distance_yards is not None
            and (club_dist - 60) <= bend.distance_yards <= (club_dist + 60)
        ):
            _r.append((
                2,
                f"Fairway bends {bend.direction} at ~{bend.distance_yards}"
                " — that corner is your landing zone",
            ))

    # P2 — miss-tendency note (directly affects where to aim)
    if player_stats and player_stats.tendencies.miss_direction != "balanced":
        _r.append((
            2,
            f"Your miss tendency is {player_stats.tendencies.miss_direction}"
            " — aim point accounts for this",
        ))

    # P2 — greenside hazard-awareness seed (DEFECT 2 continued, approach-solve
    # plan §1.3): reachable + approach-framed only — types+sides, no numbers.
    # Gating on `approach_framed` keeps every par-3-tee/positioning pin
    # byte-identical (all offset 0) and avoids reasoning-cap eviction there.
    if reachable and erp.approach_framed:
        greenside_line = _greenside_hazards_line(hole.hazards)
        if greenside_line:
            _r.append((2, greenside_line))

    # P4 — player history on this hole (color / motivational)
    if hole.player_history and hole.player_history.times_played >= 3:
        h = hole.player_history
        _r.append((
            4,
            f"Your history: avg {h.avg_score:.1f} (best {h.best_score})"
            f" in {h.times_played} rounds",
        ))

    if reachable:
        # P2 — green-slope tactical advice (affects where to miss). Slope is a
        # green-frame concept — skipped on the positioning path.
        # Additive only; does NOT affect club, target, or miss_side.
        slope_advice = slope_miss_advice(hole.green_slope, shot_bearing)
        if slope_advice:
            _r.append((2, slope_advice))

        # P3 — shot-line terrain advice (terrain SHAPE color)
        # Fires only when a pre-sampled elevation profile is attached (via
        # hole.shot_line_profile_ft, populated by the route handler). Terminal
        # terrain/green color — skipped on the positioning path so the
        # "zero flag/green-frame reference" gate stays clean.
        # Additive only; does NOT affect club, target, or miss_side.
        sl_advice = shot_line_advice(hole.shot_line_profile_ft or [], distance_yards)
        if sl_advice:
            _r.append((3, sl_advice))

        # P1 — DECADE expected-strokes aim advice (safety-critical lateral shift)
        # Additive only; does NOT affect club, target, aim_point, or miss_side.
        # Handicap forwarded so dispersion is personalised. This is the
        # incident sentence class ("aim ~9y left of the flag") — never fires
        # on the positioning path (the landing-zone advice above replaces it).
        d_advice = decade_aim_advice(hole.hazards, float(distance_yards), handicap=handicap)
        if d_advice:
            _r.append((1, d_advice))

    # Expected score — pulls from personal_sg first, falls back to PGA baseline.
    # Gate the reasoning text on the actual lookup outcome rather than the
    # dict shape, so we don't claim "personal stats" when the personal table
    # has empty buckets or no `mean_strokes` and the value silently came from
    # the PGA fallback.
    personal_sg = player_stats.personal_sg if player_stats else None
    personal_value = personal_lookup(distance_yards, "fairway", personal_sg)
    if personal_value is not None:
        exp_score = personal_value
        sample_count = sum(
            b.get("samples", 0)
            for b in (personal_sg.get("fairway") or {}).values()
            if isinstance(b, dict) and b.get("mean_strokes") is not None
        )
        if sample_count > 0:
            # P4 — personal-stats note (color; useful but not safety-critical)
            _r.append((
                4,
                f"Expected score uses your personal stats ({sample_count} fairway shots logged)",
            ))
    else:
        exp_score = expected_strokes(distance_yards, "fairway", handicap)

    # P4 — honesty note when the player has no stored bag at all (§4.2): every
    # number above came from DEFAULT_CLUB_DISTANCES, not this player's clubs.
    if not clubs:
        _r.append((4, "Using standard club distances — set up your bag in Profile for your own numbers"))

    # Apply priority sort + cap → final reasoning list (calm, voice-readable)
    reasoning = prioritize_reasoning(_r)

    # Aggressiveness
    if reachable:
        if pin_light == "red" or len([h for h in hole.hazards if h.penalty_severity == "death"]) >= 2:
            aggressiveness = "conservative"
        elif pin_light == "green" and not hole.hazards:
            aggressiveness = "aggressive"
        else:
            aggressiveness = "moderate"
    else:
        aggressiveness = "conservative" if any(h.penalty_severity == "death" for h in zone) else "moderate"

    # Confidence based on data quality
    confidence = 0.5
    if weather:
        confidence += 0.15
    if hole.elevation_change_ft != 0:
        confidence += 0.1
    if player_stats and player_stats.rounds_analyzed > 5:
        confidence += 0.15
    if hole.hazards:
        confidence += 0.1
    confidence = min(confidence, 0.95)

    return CaddieRecommendation(
        club=club,
        target_yards=adjusted_yards,
        raw_yards=distance_yards,
        aim_point=aim,
        reasoning=reasoning,
        miss_side=miss,
        adjustments=adjustments,
        confidence=confidence,
        aggressiveness=aggressiveness,
        expected_score=round(exp_score, 2),
        competition_legal=competition_legal,
        shot_kind="positioning" if not reachable else "approach",
        leave_yards=leave_yards if not reachable else None,
        tee_shot_numbers=tee_shot_numbers,
    )
