"""P0 field bug repro (owner, 2026-07-18): `frontend/src/lib/caddie/clubs.ts`
`buildClubMap()` emits `hybrid -> 'hy'`, but `_CLUB_ALIASES`
(`backend/app/caddie/club_selection.py`) had NO `'hy'` key (only `'3h'`) —
`canonical_club('hy')` returned `None`, so `normalize_club_distances` silently
DROPPED the hybrid for every hybrid-carrying golfer. Also covers the
heal-on-load fix: `_row_to_session` now runs rehydrated `club_distances`
through the SAME chokepoint (`normalize_club_distances`) instead of a
verbatim `{k: int(v) ...}` copy, so legacy short-code session rows heal the
moment a session loads — not only at `generate_recommendation` time.

specs/caddie-yardage-selector-p0-plan.md §2.3.

No network, no Postgres — pure engine/session-hydrate functions only.
`app.caddie.session` transitively imports `app.db.engine`, which raises at
import without `DATABASE_URL` (the engine itself is lazy — it never
connects at import), so a placeholder env var is set first, matching the
pattern in `test_session_guide_revalidate.py` / `test_club_alias_p0.py`.
"""

from __future__ import annotations

import os
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from app.caddie.aim_point import generate_recommendation  # noqa: E402
from app.caddie.club_selection import canonical_club, normalize_club_distances  # noqa: E402
from app.caddie.session import _row_to_session  # noqa: E402
from app.caddie.types import HoleIntelligence  # noqa: E402

# The owner's real 12-club bag (specs/caddie-yardage-selector-p0-plan.md §3.2)
# — no hybrid/5wood, which is why a phantom mid-band cap lands on a jarring
# iron for him. Used here only to pin that every INPUT SHAPE for the same
# real bag normalizes identically.
_OWNER_CANONICAL = {
    "driver": 300,
    "3wood": 270,
    "4iron": 230,
    "5iron": 215,
    "6iron": 195,
    "7iron": 180,
    "8iron": 170,
    "9iron": 155,
    "pw": 140,
    "gw": 127,
    "sw": 115,
    "lw": 90,
}

# The full legacy short-code vocabulary `buildClubMap()` used to emit
# (pre-fix) — kept pinned forever, since stored rows and old clients depend
# on these aliases surviving even after the frontend goes canonical.
_LEGACY_BUILDCLUBMAP_CODES = [
    "driver", "3w", "5w", "hy", "4i", "5i", "6i", "7i", "8i", "9i",
    "pw", "gw", "sw", "lw",
]


# ── 1. the exact repro ──────────────────────────────────────────────────────


def test_hy_shorthand_is_not_dropped():
    assert normalize_club_distances({"hy": 200}) == {"hybrid": 200}


# ── 2. all three prod-shaped bags collapse to the SAME canonical dict ──────


def test_owner_prod_shapes_all_yield_the_same_12_club_bag():
    camel_case = {
        "driver": 300,
        "threeWood": 270,
        "fourIron": 230,
        "fiveIron": 215,
        "sixIron": 195,
        "sevenIron": 180,
        "eightIron": 170,
        "nineIron": 155,
        "pitchingWedge": 140,
        "gapWedge": 127,
        "sandWedge": 115,
        "lobWedge": 90,
    }
    legacy_short_code = {
        "driver": 300,
        "3w": 270,
        "4i": 230,
        "5i": 215,
        "6i": 195,
        "7i": 180,
        "8i": 170,
        "9i": 155,
        "pw": 140,
        "gw": 127,
        "sw": 115,
        "lw": 90,
    }
    already_normalized = dict(_OWNER_CANONICAL)

    assert normalize_club_distances(camel_case) == _OWNER_CANONICAL
    assert normalize_club_distances(legacy_short_code) == _OWNER_CANONICAL
    assert normalize_club_distances(already_normalized) == _OWNER_CANONICAL  # idempotent


# ── 3. end-to-end recommendation parity for a hybrid-carrying bag ─────────


def test_hybrid_user_recommendation_parity():
    hole = HoleIntelligence(hole_number=4, par=4, yards=200, effective_yards=200)

    rec_shorthand = generate_recommendation(
        hole=hole, distance_yards=200,
        club_distances={"driver": 250, "hy": 200, "7i": 160},
    )
    rec_canonical = generate_recommendation(
        hole=hole, distance_yards=200,
        club_distances={"driver": 250, "hybrid": 200, "7iron": 160},
    )

    assert rec_shorthand.club == rec_canonical.club
    assert rec_shorthand.target_yards == rec_canonical.target_yards
    assert rec_shorthand.raw_yards == rec_canonical.raw_yards


# ── 4. every buildClubMap-emitted code resolves — no silent drop, ever ────


@pytest.mark.parametrize("code", _LEGACY_BUILDCLUBMAP_CODES)
def test_every_buildclubmap_code_resolves(code):
    assert canonical_club(code) is not None, f"{code!r} has no canonical resolution"


def test_full_legacy_bag_normalizes_to_all_14_entries():
    bag = {code: 100 + i for i, code in enumerate(_LEGACY_BUILDCLUBMAP_CODES)}
    normalized = normalize_club_distances(bag)
    assert len(normalized) == len(_LEGACY_BUILDCLUBMAP_CODES) == 14


# ── 5. heal-on-load: _row_to_session normalizes legacy rows on rehydrate ──


def _row(club_distances_blob: dict) -> SimpleNamespace:
    """A CaddieSessionRow stand-in carrying only what `_row_to_session` reads
    (pattern: test_session_guide_revalidate.py)."""
    return SimpleNamespace(
        round_id="r1",
        user_id="u1",
        course_id="c1",
        personality_id="classic",
        created_at=None,
        last_accessed=None,
        weather=None,
        weather_fetched_at=None,
        hole_intel={},
        player_stats=None,
        current_hole=1,
        last_recommendation=None,
        shot_history=[],
        club_distances=club_distances_blob,
        handicap=None,
        realtime_session_id=None,
        status="active",
    )


def test_row_to_session_heals_legacy_bag():
    legacy_row = _row({"driver": 250, "hy": 200, "3w": 230, "7i": 160})

    session = _row_to_session(legacy_row, messages=[])

    assert session.club_distances == {
        "driver": 250,
        "hybrid": 200,
        "3wood": 230,
        "7iron": 160,
    }


def test_row_to_session_normalized_bag_is_idempotent():
    normalized_row = _row(dict(_OWNER_CANONICAL))

    session = _row_to_session(normalized_row, messages=[])

    assert session.club_distances == _OWNER_CANONICAL
