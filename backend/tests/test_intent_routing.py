"""The routing matrix — the test contract for `app.caddie.routing.classify_
intent` (specs/caddie-two-tier-routing-plan.md §1/§11). Pure, offline, no DB,
no network: `classify_intent` is a stdlib-only regex router.
"""

from __future__ import annotations

import pytest

from app.caddie.routing import Intent, classify_intent


# The routing matrix (plan §1) — each row is one parametrized case.
_MATRIX: list[tuple[str, Intent]] = [
    ("How far to the green?", Intent.FACT),
    ("What's the carry over the left bunker?", Intent.FACT),
    ("How's the wind?", Intent.FACT),
    ("What does 150 play like right now?", Intent.FACT),
    ("How deep is the green?", Intent.FACT),
    ("What's the front number?", Intent.FACT),
    ("What do I need to shoot par on the back nine?", Intent.FACT),
    ("What should I hit off this tee?", Intent.ADVICE),
    ("Driver or 3-wood here?", Intent.ADVICE),
    ("How do I play this hole?", Intent.ADVICE),
    ("Where's the miss here?", Intent.ADVICE),
    ("Which side do I bail?", Intent.ADVICE),
    ("Should I go for it in two?", Intent.ADVICE),
    ("Can I take on the corner?", Intent.ADVICE),
    ("Where should I lay up?", Intent.ADVICE),
    ("What's the play — attack this pin or play safe?", Intent.ADVICE),
    ("I made a 5", Intent.SCORE),
    ("Put me down for a 5, par for Mike", Intent.SCORE),
    ("Bogey for me", Intent.SCORE),
    ("Say that again?", Intent.OTHER),
    ("Thanks, that was a great call", Intent.OTHER),
    # Terse on-course forms (eng-lead review fold-in, 2026-07-17) — common
    # short asks that were falling through to OTHER/Claude instead of ADVICE.
    ("Driver here?", Intent.ADVICE),
    ("Go for it?", Intent.ADVICE),
    ("Send it?", Intent.ADVICE),
    ("Left or right off this tee?", Intent.ADVICE),
    ("What's the smart play?", Intent.ADVICE),
    ("How much can I bite off?", Intent.ADVICE),
    # Putts guard (eng-lead review fold-in) — a putting-stats statement, not
    # a hole score; must never write via record_scores.
    ("I had 3 putts", Intent.OTHER),
]


@pytest.mark.parametrize("transcript,expected", _MATRIX)
def test_routing_matrix(transcript: str, expected: Intent) -> None:
    assert classify_intent(transcript) is expected, transcript


def test_need_to_shoot_is_fact_not_score() -> None:
    """Row 7 discriminator, pinned on its own: 'shoot'/'par' read like a
    score utterance, but this is a target-computation FACT question, never a
    statement of strokes taken."""
    assert classify_intent("What do I need to shoot par on the back nine?") is Intent.FACT


def test_i_made_a_five_is_score() -> None:
    assert classify_intent("I made a 5") is Intent.SCORE


def test_multiplayer_score_utterance_is_score() -> None:
    assert classify_intent("Put me down for a 5, par for Mike") is Intent.SCORE


def test_club_vs_club_is_advice_even_with_fact_words() -> None:
    """Fail-toward-ADVICE: a club-vs-club ask classifies ADVICE even mixed
    with fact-sounding words like 'here' or a yardage number."""
    assert classify_intent("Driver or 3-wood here, it's playing 165?") is Intent.ADVICE


def test_putts_count_is_not_score() -> None:
    """Eng-lead review fold-in: 'I had 3 putts' matches the person+stroke
    SCORE shape (i had + a bare number), but a putts count is NOT a hole
    score — writing it via record_scores would put the wrong number on the
    card. Only an explicit hole-score verb (made/shot/scored) rescues a
    putts-mentioning utterance back into SCORE."""
    assert classify_intent("I had 3 putts") is not Intent.SCORE


def test_explicit_score_verb_with_putts_word_still_pinned_correctly() -> None:
    """The putts guard is scoped to the ambiguous verbs (had/got/took) —
    it must never swallow a genuine score statement that happens to also
    mention putts in the same breath."""
    assert classify_intent("I made a 5, three putts on that green") is Intent.SCORE


def test_intent_enum_is_extensible_without_dispatch_rewrite(monkeypatch) -> None:
    """Seam proof (plan §1 'extensibility, proved not built'): registering a
    brand-new routing class is ONE predicate + ONE appended rule — no edit to
    `classify_intent` itself. Demonstrated with a reserved future name
    (TEE_TIME) that isn't (and never needs to be) a real `Intent` member."""
    from app.caddie import routing as routing_mod

    def _is_tee_time(text: str) -> bool:
        return "book a tee time" in text

    new_rules = [("tee_time", _is_tee_time)] + routing_mod._RULES
    monkeypatch.setattr(routing_mod, "_RULES", new_rules)

    assert classify_intent("Can you book a tee time for Saturday?") == "tee_time"
    # Existing classes are untouched by the seam.
    assert classify_intent("How far to the green?") is Intent.FACT
