"""Pure consistency-probe extractor (specs/caddie-experience-harness-plan.md
§3, dim 5 "consistency" — owner directive: "same club, same yardages, same
hazards named across repeated questions"). No I/O, no network — lands in the
CI-gated pytest suite via `test_substance_teeth.py`.

`extract_substance` pulls the SUBSTANCE (not the phrasing) out of a caddie
answer: which club, which yardages, which hazard TYPES it named. Sampling the
same scenario `n` times against a live model and comparing `AnswerSubstance`
across samples (`substance_variance`) proves whether the caddie's ADVICE is
stable even when its wording varies turn to turn — the live sampling itself
is GATED (`run_consistency.py`); this module is the pure, always-testable
extraction + diff machinery underneath it.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, ConfigDict

from tests.eval.checks import _CLUB_MENTION_PATTERNS, _parse_mentioned_club


@dataclass(frozen=True)
class AnswerSubstance:
    """The substantive content of one answer, phrasing stripped away."""

    club: Optional[str]              # canonical club key (e.g. "7iron"), or None
    yardages: tuple[int, ...]        # sorted, deduped 2-3 digit numbers named
    hazards: frozenset[str]          # canonical hazard TYPES named (side not tracked)
    # Decision-grounding fidelity (caddie-advice-stability-tee-shot-plan.md
    # §3.5): `club` is the FIRST club mentioned, regardless of advice
    # direction — the 2026-07-15 baseline's 3/2 flip surfaced only by
    # eyeballing because `club` reads "3wood" in BOTH the endorsement and the
    # rejection of the 3-wood. `endorsed_club` is the club the answer
    # actually RECOMMENDS (a falsifiable, cue-anchored extraction), or `None`
    # when no endorsement cue is present.
    endorsed_club: Optional[str]


# Closed hazard lexicon with plural + synonym folding onto a canonical name
# (mirrors the closed-registry philosophy elsewhere in this harness — an
# unrecognized hazard word is simply not counted, never invented).
_HAZARD_LEXICON: dict[str, str] = {
    "bunker": "bunker", "bunkers": "bunker", "sand": "bunker", "trap": "bunker", "traps": "bunker",
    "water": "water", "pond": "water", "ponds": "water", "lake": "water", "lakes": "water",
    "creek": "water", "creeks": "water", "stream": "water",
    "trees": "trees", "tree": "trees", "woods": "trees", "timber": "trees",
    "ob": "ob", "out of bounds": "ob", "out-of-bounds": "ob",
    "fescue": "fescue", "rough": "fescue",
}

# Longest lexicon keys first so multi-word entries ("out of bounds") match
# before a shorter substring could steal the match.
_HAZARD_RE = re.compile(
    r"\b(" + "|".join(re.escape(k) for k in sorted(_HAZARD_LEXICON, key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)

# Standalone 2-3 digit numbers, never immediately followed by another digit
# (already guaranteed by \b) or a percent sign (green-slope percentages, e.g.
# "runs off at 2%" — not a yardage). Deliberately no "yards/y" suffix
# requirement: caddie speech states bare numbers ("152 to the pin") far more
# often than suffixed ones — see README.md's Known limitations for the
# accepted false-positive tradeoff (e.g. a 3-digit wind heading).
_YARDAGE_RE = re.compile(r"\b(\d{2,3})\b(?!%)")

# Sentence splitter — mirrors checks.py's `_SENTENCE_SPLIT_RE` so endorsement
# cues are scanned sentence-by-sentence the same way tier2 checks count
# sentences (one extraction convention, not two that could drift).
_SENTENCE_SPLIT_RE = re.compile(r"[.!?]+(?:\s|$)")

# Closed endorsement-cue lexicon (plan §3.5): falsifiable direction
# measurement — `AnswerSubstance.club` is the FIRST club named regardless of
# whether the answer endorses or rejects it, which is exactly why the
# 2026-07-15 baseline's 3/2 flip only surfaced by eyeballing. A cue-bearing
# sentence names the club the caddie is actually RECOMMENDING; longest cues
# first so a shorter cue can't steal a match inside a longer one.
_ENDORSEMENT_CUES: tuple[str, ...] = (
    "stick with", "stay with", "go with", "take the", "hit the", "pull the",
    "is the call", "is the play", "that's the call", "that's the play",
    "i'd take", "i'd hit", "safe play", "smart play", "your best bet",
)
_ENDORSEMENT_CUE_RE = re.compile(
    "|".join(re.escape(c) for c in sorted(_ENDORSEMENT_CUES, key=len, reverse=True)),
    re.IGNORECASE,
)


def _endorsed_club_in_sentence(sentence: str, club_distances: dict[str, int]) -> Optional[str]:
    """The club mention NEAREST (by character distance) to the first
    endorsement cue in `sentence` — resolves both "stick with driver over the
    3-wood" -> driver and "the 3-wood is the call" -> 3wood. `None` if the
    sentence has no cue, or a cue but no known club mention."""
    cue_match = _ENDORSEMENT_CUE_RE.search(sentence)
    if cue_match is None:
        return None
    cue_pos = (cue_match.start() + cue_match.end()) / 2
    best: Optional[tuple[float, str]] = None
    for key, pattern in _CLUB_MENTION_PATTERNS.items():
        if key not in club_distances:
            continue
        for m in pattern.finditer(sentence):
            club_pos = (m.start() + m.end()) / 2
            distance = abs(club_pos - cue_pos)
            if best is None or distance < best[0]:
                best = (distance, key)
    return best[1] if best else None


def _extract_endorsed_club(answer: str, club_distances: dict[str, int]) -> Optional[str]:
    """First cue-bearing sentence wins; no cue anywhere -> `None`."""
    for sentence in _SENTENCE_SPLIT_RE.split(answer.strip()):
        sentence = sentence.strip()
        if not sentence:
            continue
        endorsed = _endorsed_club_in_sentence(sentence, club_distances)
        if endorsed is not None:
            return endorsed
        if _ENDORSEMENT_CUE_RE.search(sentence) is not None:
            # Cue present but no known club nearby in THIS sentence — still
            # the "first cue-bearing sentence", so stop here rather than
            # falling through to a later, unrelated cue.
            return None
    return None


def extract_substance(answer: str, club_distances: dict[str, int]) -> AnswerSubstance:
    """Pure extraction: no LLM, no I/O. `club_distances` narrows club
    detection to the player's actual bag — reuses `checks._parse_mentioned_club`
    (the SAME club-mention regex family the golden-set tier2_deterministic
    checks already use), so there is exactly one club-extraction code path in
    this harness, not two that could silently drift apart."""
    mention = _parse_mentioned_club(answer, club_distances)
    club = mention[0] if mention else None
    yardages = tuple(sorted({int(m.group(1)) for m in _YARDAGE_RE.finditer(answer)}))
    hazards = frozenset(_HAZARD_LEXICON[m.group(1).lower()] for m in _HAZARD_RE.finditer(answer))
    endorsed_club = _extract_endorsed_club(answer, club_distances)
    return AnswerSubstance(club=club, yardages=yardages, hazards=hazards, endorsed_club=endorsed_club)


@dataclass(frozen=True)
class VarianceReport:
    distinct_clubs: int
    club_agreement_rate: float       # share of samples naming the modal club (1.0 = full agreement)
    hazard_symmetric_diff_max: int   # max pairwise |A ^ B| across all sample pairs
    yardage_spread_max: int          # max - min across every yardage named in ANY sample
    # Decision-grounding fidelity (plan §3.5): distinct RECOMMENDED clubs
    # across samples — this is what actually caught the 2026-07-15 3/2 flip
    # (`club` alone did not, since "3wood" is the first-mentioned club in
    # both the endorsement AND the rejection of the 3-wood). All-`None`
    # (no probe in the set carries an endorsement cue) stays a single
    # distinct value so the two vacuous probes' verdicts are unaffected.
    distinct_endorsements: int
    consistent: bool
    notes: list[str] = field(default_factory=list)


def substance_variance(samples: list[AnswerSubstance], *, yardage_tolerance: int = 5) -> VarianceReport:
    """Thresholds (plan §3): clubs identical, hazard sets identical, yardage
    spread <= tolerance, and recommended-direction identical
    (`distinct_endorsements <= 1`). A sample OMITTING a number others state
    is reported (not failed) — phrasing variance ("about 150" vs "150 to the
    pin, 155 with the wind") is expected; only magnitude DISAGREEMENT
    (`yardage_spread_max`) fails. `club=None` counts as its own distinct
    value (not silently dropped) — a sample that fails to name ANY club when
    others do is a genuine disagreement, not a non-event."""
    if not samples:
        raise ValueError("substance_variance requires at least one sample")

    clubs = [s.club for s in samples]
    distinct_clubs = len(set(clubs))
    known_clubs = [c for c in clubs if c is not None]
    club_agreement_rate = (
        max(known_clubs.count(c) for c in set(known_clubs)) / len(samples) if known_clubs else 1.0
    )

    hazard_sets = [s.hazards for s in samples]
    hazard_symmetric_diff_max = 0
    for i in range(len(hazard_sets)):
        for j in range(i + 1, len(hazard_sets)):
            hazard_symmetric_diff_max = max(hazard_symmetric_diff_max, len(hazard_sets[i] ^ hazard_sets[j]))

    all_yardages = [y for s in samples for y in s.yardages]
    yardage_spread_max = (max(all_yardages) - min(all_yardages)) if all_yardages else 0

    # `endorsed_club`: unlike `club`, `None` is its OWN distinct value only
    # when at least one sample has a non-None endorsement — all-None (a probe
    # with no endorsement cues at all, e.g. the two vacuous probes) stays a
    # single distinct value so their existing True verdicts don't change.
    endorsements = [s.endorsed_club for s in samples]
    known_endorsements = [e for e in endorsements if e is not None]
    distinct_endorsements = len(set(endorsements)) if known_endorsements else (1 if endorsements else 0)

    notes: list[str] = []
    yardage_sets = [set(s.yardages) for s in samples]
    if yardage_sets and not all(ys == yardage_sets[0] for ys in yardage_sets):
        notes.append("yardage sets differ in which numbers are stated across samples (reported, not failed)")

    consistent = (
        distinct_clubs <= 1
        and hazard_symmetric_diff_max == 0
        and yardage_spread_max <= yardage_tolerance
        and distinct_endorsements <= 1
    )
    return VarianceReport(
        distinct_clubs=distinct_clubs,
        club_agreement_rate=club_agreement_rate,
        hazard_symmetric_diff_max=hazard_symmetric_diff_max,
        yardage_spread_max=yardage_spread_max,
        distinct_endorsements=distinct_endorsements,
        consistent=consistent,
        notes=notes,
    )


# ── golden/consistency_probes.jsonl — tiny closed schema ────────────────────


class ConsistencyProbe(BaseModel):
    """One line of `golden/consistency_probes.jsonl` — which existing golden
    scenario to re-sample, how many times, and the yardage tolerance."""

    model_config = ConfigDict(extra="forbid")

    scenario_id: str
    n: int = 5
    yardage_tolerance: int = 5


def load_consistency_probes(path: Path, known_scenario_ids: set[str]) -> list[ConsistencyProbe]:
    """Parse `consistency_probes.jsonl`. An unknown `scenario_id` (one not in
    `known_scenario_ids`, i.e. not present in golden/caddie_advice.jsonl)
    fails LOUDLY at load time — same fail-closed contract as
    `schema.load_golden_set`'s duplicate-id guard."""
    probes: list[ConsistencyProbe] = []
    with open(path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, start=1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(f"{path}:{lineno}: invalid JSON — {e}") from e
            probe = ConsistencyProbe.model_validate(data)
            if probe.scenario_id not in known_scenario_ids:
                raise ValueError(
                    f"{path}:{lineno}: unknown scenario_id {probe.scenario_id!r} — "
                    "must reference an id present in golden/caddie_advice.jsonl"
                )
            probes.append(probe)
    return probes


CONSISTENCY_PROBES_PATH = Path(__file__).parent / "golden" / "consistency_probes.jsonl"
