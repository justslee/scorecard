"""Persona-inventory parity guard (specs/caddie-orb-persona-consistency-persona.md
§3 row 6a — backlog `caddie-persona-inventory-frontend-backend-mismatch`).

The frontend used to ship TWO persona lists: `frontend/src/lib/caddie/persona.ts`
(the live, backend-driven `BUILTIN_PERSONAS`, already pinned 1:1 to this module
by `persona.test.ts`'s "mirrors the four backend built-in ids exactly" case) and
a second, dead `frontend/src/lib/caddie/personalities.ts` with four EXTRA
client-only ids (veteran-looper, hard-edge, course-historian, trash-talker)
that had no backend row — selecting one silently fell back to 'classic'
(`load_personality`). That file had zero importers and has been deleted; the
frontend's `BUILTIN_PERSONAS` is now the single client-side list, generated to
mirror this dict.

This test pins the OTHER half of that seam: the backend's built-in persona
inventory itself can't silently grow (or shrink) without a deliberate,
matching frontend update — a new backend-only builtin would again be
selectable-but-invisible (or the reverse: client-only-but-dead) if the two
sides aren't touched together. DB-free, no network — mirrors the pattern in
test_caddie_register_consistency.py.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

from app.caddie import personalities  # noqa: E402

# The frozen, intended user-facing built-in set (persona.md §3 row 6a; mirrored
# by frontend/src/lib/caddie/persona.ts's BUILTIN_PERSONAS and asserted there
# by persona.test.ts). Any addition/removal here MUST land alongside a
# matching BUILTIN_PERSONAS update in the same change.
INTENDED_USER_FACING_PERSONA_IDS = frozenset({"classic", "strategist", "hype", "professor"})


def test_builtin_personalities_match_the_intended_user_facing_set():
    assert set(personalities.PERSONALITIES.keys()) == INTENDED_USER_FACING_PERSONA_IDS


def test_default_personality_is_a_member_of_the_builtin_set():
    assert personalities.DEFAULT_PERSONALITY_ID in personalities.PERSONALITIES
