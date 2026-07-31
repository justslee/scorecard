"""Unit tests for wer.py — pure, no network, no audio, no API keys. Runs
anywhere (including this dev machine). Not under backend/tests/ (pytest's
`testpaths`), matching the bench's own opt-in-run posture
(specs/live-transcription-plan.md §7) — run explicitly:
`cd backend && python -m pytest bench/stt_ab/test_wer.py`.
"""

from wer import golf_term_error_rate, normalize_words, word_error_rate


def test_normalize_words_lowercases_strips_punctuation_and_hyphens():
    assert normalize_words("What's the yardage, Dave?") == ["whats", "the", "yardage", "dave"]
    assert normalize_words("3-wood") == ["3", "wood"]


def test_normalize_words_collapses_whitespace():
    assert normalize_words("  hello   world  ") == ["hello", "world"]


def test_wer_identical_transcripts_is_zero():
    assert word_error_rate("what club here", "what club here") == 0.0


def test_wer_case_and_punctuation_insensitive():
    assert word_error_rate("What club here?", "what club here") == 0.0


def test_wer_one_substitution_out_of_three_words():
    # "club" -> "clue": 1 substitution / 3 reference words.
    assert word_error_rate("what club here", "what clue here") == 1 / 3


def test_wer_one_insertion():
    # hypothesis has an extra word not in reference.
    assert word_error_rate("what club", "what club here") == 1 / 2


def test_wer_one_deletion():
    assert word_error_rate("what club here", "what here") == 1 / 3


def test_wer_completely_wrong_caps_at_one():
    assert word_error_rate("fore", "the quick brown fox jumps") == 1.0


def test_wer_empty_reference_and_empty_hypothesis_is_zero():
    assert word_error_rate("", "") == 0.0


def test_wer_empty_reference_nonempty_hypothesis_is_one():
    assert word_error_rate("", "hello") == 1.0


def test_wer_empty_hypothesis_nonempty_reference_is_one():
    assert word_error_rate("what club here", "") == 1.0


def test_wer_known_confusion_pair_stableford_vs_stable_ford():
    # The exact confusion frontend/voice-tests/generators/stt-noise.ts's
    # WORD_SWAPS models: "stableford" heard/transcribed as "stable ford" —
    # a 1-word reference token split into 2 hypothesis tokens costs 2 edits
    # (substitute "stableford"->"stable", insert "ford") over 4 ref words.
    assert word_error_rate("we are playing stableford", "we are playing stable ford") == 0.5


# ── golf_term_error_rate ────────────────────────────────────────────────


def test_golf_term_error_rate_all_terms_correct_is_zero():
    scored = ["stableford", "nassau", "pebble beach"]
    ref = "we are playing stableford at pebble beach"
    hyp = "we are playing stableford at pebble beach"
    assert golf_term_error_rate(ref, hyp, scored) == 0.0


def test_golf_term_error_rate_one_of_two_scored_terms_missed():
    scored = ["stableford", "nassau"]
    ref = "start stableford then switch to nassau"
    hyp = "start stable ford then switch to nassau"  # stableford confused
    assert golf_term_error_rate(ref, hyp, scored) == 0.5


def test_golf_term_error_rate_only_scores_terms_actually_in_the_reference():
    # "nassau" is in the scored list but never spoken in this utterance —
    # must not count against the hypothesis.
    scored = ["stableford", "nassau"]
    ref = "start stableford with the group"
    hyp = "start stableford with the group"
    assert golf_term_error_rate(ref, hyp, scored) == 0.0


def test_golf_term_error_rate_no_scored_terms_present_is_zero():
    scored = ["nassau", "wolf"]
    ref = "what club from 150"
    hyp = "what club from 150"
    assert golf_term_error_rate(ref, hyp, scored) == 0.0


def test_golf_term_error_rate_word_boundary_not_substring():
    # "four" should not match inside "foursome" — word-boundary matched.
    scored = ["four"]
    ref = "we are a foursome today"
    hyp = "we are a foursome today"
    assert golf_term_error_rate(ref, hyp, scored) == 0.0  # "four" not actually IN the reference


def test_golf_term_error_rate_multi_word_term():
    scored = ["pebble beach", "best ball"]
    ref = "playing best ball at pebble beach"
    hyp = "playing bestball at pebble beach"  # "best ball" -> "bestball" confused
    assert golf_term_error_rate(ref, hyp, scored) == 0.5
