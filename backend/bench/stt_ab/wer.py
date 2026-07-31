"""Word-error-rate + golf-term error rate — pure, dependency-free, unit
tested (specs/live-transcription-plan.md §7). No network, no audio — takes
two transcript strings and returns a score. Kept separate from
synthesize.py/run_ab.py (which DO need network + audio deps) so this module
can be imported and tested on any machine, including this one with no API
keys.
"""

from __future__ import annotations

import re


def normalize_words(text: str) -> list[str]:
    """Lowercase, strip punctuation, collapse whitespace, split into words.

    Deliberately simple/ASCII-punctuation-only — good enough for the golf
    vocabulary this bench scores (see README.md's stated limitation: this
    measures vocabulary WER credibly, not full linguistic normalization).
    """
    lowered = text.lower()
    stripped = re.sub(r"[.,!?;:\"'()\[\]]", "", lowered)
    stripped = re.sub(r"-", " ", stripped)
    return [w for w in stripped.split() if w]


def _levenshtein(a: list[str], b: list[str]) -> int:
    """Classic word-level Levenshtein edit distance (substitution = 1,
    insertion = 1, deletion = 1) via the standard O(len(a)*len(b))
    dynamic-programming table."""
    n, m = len(a), len(b)
    if n == 0:
        return m
    if m == 0:
        return n
    # prev/curr rolling rows — O(min(n,m)) memory instead of a full table.
    prev = list(range(m + 1))
    curr = [0] * (m + 1)
    for i in range(1, n + 1):
        curr[0] = i
        for j in range(1, m + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            curr[j] = min(
                prev[j] + 1,  # deletion
                curr[j - 1] + 1,  # insertion
                prev[j - 1] + cost,  # substitution (or match)
            )
        prev, curr = curr, prev
    return prev[m]


def word_error_rate(reference: str, hypothesis: str) -> float:
    """Standard WER: edit_distance(ref_words, hyp_words) / len(ref_words),
    normalized (lowercase, punctuation-stripped) before comparison.

    Returns 0.0 for an empty reference AND empty hypothesis (nothing to get
    wrong); 1.0 for an empty reference with a non-empty hypothesis (every
    hypothesis word is a pure insertion, capped at 1.0 — WER can exceed 1.0
    on heavy insertion in the general case, but this bench caps display at
    1.0 since anything past "completely wrong" doesn't change the verdict).
    """
    ref_words = normalize_words(reference)
    hyp_words = normalize_words(hypothesis)
    if not ref_words:
        return 0.0 if not hyp_words else 1.0
    distance = _levenshtein(ref_words, hyp_words)
    return min(1.0, distance / len(ref_words))


def golf_term_error_rate(reference: str, hypothesis: str, scored_terms: list[str]) -> float:
    """Fraction of `scored_terms` present (as a whole word/phrase, word-
    boundary matched) in the NORMALIZED reference that are ALSO present in
    the normalized hypothesis. 1.0 - that fraction = the error rate.

    Terms absent from the reference are not scored (a term list is shared
    across utterances; only terms actually spoken in THIS utterance count).
    Returns 0.0 (perfect — nothing to get wrong) when no scored term appears
    in the reference at all.
    """
    ref_norm = " ".join(normalize_words(reference))
    hyp_norm = " ".join(normalize_words(hypothesis))

    present_in_ref = [t for t in scored_terms if _contains_term(ref_norm, t)]
    if not present_in_ref:
        return 0.0

    correct = sum(1 for t in present_in_ref if _contains_term(hyp_norm, t))
    return 1.0 - (correct / len(present_in_ref))


def _contains_term(normalized_text: str, term: str) -> bool:
    term_norm = " ".join(normalize_words(term))
    if not term_norm:
        return False
    pattern = r"\b" + re.escape(term_norm) + r"\b"
    return re.search(pattern, normalized_text) is not None
