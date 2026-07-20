"""Course-level Augusta-styled description: grounded writer + fail-CLOSED
validator, for course DISCOVERY (map tap-sheet + course detail page).

NOT `app.caddie.course_intel` — that module is the LIVE per-hole caddie
intelligence builder (`build_hole_intelligence`), a distinct, pre-existing
system. See that module's docstring for the reciprocal note. This module
never imports `app.caddie.course_intel`.

Mirrors `guide_writer.py`'s writer+validator split at COURSE scope instead of
per-hole scope:
  - `build_course_ground_truth_block` — plain-text authoritative block built
    ONLY from our own stored geometry (par, yardage, hole count, aggregate
    hazard/terrain profile via `hazards.extract_hole_hazards`, elevation
    range). Pure, deterministic, no network.
  - `COURSE_WRITER_SYSTEM` — the writer's system prompt (WRITER-not-knower
    framing, same spirit as `guide_writer.WRITER_SYSTEM`), embedding the two
    fixed few-shot anchors VERBATIM (specs/course-discovery-intel-plan.md
    §3a — prompt drift is the #1 quality risk, so these are string constants,
    never paraphrased).
  - `write_course_description` — the ONLY networked function in this module:
    Claude + structured output (`messages.parse`), NO tools (no web_search —
    the writer uses parametric knowledge only, per the owner's wording; zero
    injection surface from the network, zero per-search cost, one bounded
    call per course, no `pause_turn` loop needed). May raise; the precompute
    job (`app.services.course_intel`) catches and logs.
  - `validate_course_description` — deterministic, no-LLM, fail-CLOSED (§3b):
    rejects the WHOLE draft on injection patterns, structural failure, a
    fact leaking into the unconditional `landscape` field, or a wrong
    course-par claim; drops (never rejects) an individual fact sentence
    whose self-reported confidence isn't exactly "high". Composes the final
    `description` patch on PASS.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

import anthropic
from pydantic import BaseModel

from app.caddie.guide_writer import GUIDE_INJECTION_PATTERN
from app.caddie.hazards import extract_hole_hazards

log = logging.getLogger("looper.course_intel_writer")

# Preferred tee-set order for the "longest tee" yardage total — same priority
# as course_guides.py's per-hole `_TEE_PRIORITY` (longest/back tee first).
_TEE_PRIORITY: tuple[str, ...] = ("Black", "Blue", "White", "Red")


# ── Ground-truth geometry block (§3a) ──────────────────────────────────────


def _real_holes(course: dict) -> list[dict]:
    """Holes with actual mapped data — filters out `courses_mapped.get_course`'s
    18-hole default-fill par-4 placeholders (courses_mapped.py:302-316), which
    would otherwise fabricate a par-72 course out of a 3-hole-mapped one.
    A hole counts as real iff it has a non-empty feature collection or at
    least one non-zero stored yardage — the same test `upsert_course` uses to
    decide whether a hole was ever actually touched (courses_mapped.py:395)."""
    holes = course.get("holes") or []
    real: list[dict] = []
    for h in holes:
        feats = ((h.get("features") or {}).get("features")) or []
        yardages = h.get("yardages") or {}
        if feats or any(v for v in yardages.values()):
            real.append(h)
    return real


def _longest_tee_yardage(course: dict, real_holes: list[dict]) -> tuple[Optional[str], int]:
    """One representative tee's total yardage over the REAL mapped holes only
    — the longest/back tee available, `_TEE_PRIORITY` order, falling back to
    whichever tee set is stored first. `(None, 0)` when the course has no tee
    sets at all (never fabricated)."""
    tee_names = [ts.get("name") for ts in (course.get("teeSets") or []) if ts.get("name")]
    if not tee_names:
        return None, 0
    chosen = next((t for t in _TEE_PRIORITY if t in tee_names), tee_names[0])
    total = sum((h.get("yardages") or {}).get(chosen) or 0 for h in real_holes)
    return chosen, total


def _green_delta_ft(hole: dict) -> Optional[float]:
    """The green feature's persisted `delta_ft` (net elevation change,
    tee->green) for one stored hole, or None when unknown/unmapped — never
    fabricated (matches `course_guides._green_properties`'s idiom, kept as a
    small local helper rather than a cross-module import to avoid coupling
    this module's ground-truth builder to the per-hole guide precompute)."""
    feats = ((hole.get("features") or {}).get("features")) or []
    for f in feats:
        props = f.get("properties") or {}
        if props.get("featureType") == "green" and props.get("delta_ft") is not None:
            return props.get("delta_ft")
    return None


def build_course_ground_truth_block(course: dict) -> str:
    """Plain-text authoritative block derived ONLY from our stored geometry —
    the course-scope analogue of `guide_writer.build_ground_truth_block`.

    Input is `courses_mapped.get_course(...)` output. Derives ONLY from real
    mapped holes (`_real_holes`) — never the 18-hole default-fill. Unknown
    yardage/hazard/elevation facts are OMITTED, never fabricated
    ([[no-fake-data-fallbacks]]).

    Pure and deterministic: no network, no randomness, no side effects.
    """
    name = course.get("name") or "This course"
    real_holes = _real_holes(course)
    holes_mapped = len(real_holes)
    par_total = sum(h.get("par") or 0 for h in real_holes)
    par3 = sum(1 for h in real_holes if h.get("par") == 3)
    par4 = sum(1 for h in real_holes if h.get("par") == 4)
    par5 = sum(1 for h in real_holes if h.get("par") == 5)

    lines = [
        "GROUND TRUTH (authoritative — our surveyed geometry). Treat every fact below as fixed.",
        f"{name}: {holes_mapped} holes mapped, total par {par_total} over those holes "
        f"({par3} par-3s, {par4} par-4s, {par5} par-5s).",
    ]

    tee_name, total_yards = _longest_tee_yardage(course, real_holes)
    if tee_name and total_yards:
        lines.append(f"Longest tee ({tee_name}): {total_yards} yards total over the mapped holes.")

    water_holes = ob_holes = tree_holes = 0
    bunker_count = 0
    for h in real_holes:
        hazards = extract_hole_hazards(h.get("features"), tee=h.get("tee"), green=h.get("green"))
        types = [hz.type for hz in hazards]
        if "water" in types:
            water_holes += 1
        if "ob" in types:
            ob_holes += 1
        if "trees" in types:
            tree_holes += 1
        bunker_count += types.count("bunker")

    if water_holes or bunker_count or ob_holes or tree_holes:
        lines.append(
            "Hazard/terrain profile across the mapped holes (the COMPLETE picture — there "
            "are NO others):"
        )
        lines.append(f"  - water in play on {water_holes} of {holes_mapped} holes")
        lines.append(f"  - {bunker_count} bunkers total")
        if ob_holes:
            lines.append(f"  - out-of-bounds in play on {ob_holes} holes")
        if tree_holes:
            lines.append(f"  - trees/woods bordering {tree_holes} holes")
    else:
        lines.append("Hazard/terrain profile: NONE mapped. Do not name any specific hazard.")

    deltas = [d for d in (_green_delta_ft(h) for h in real_holes) if d is not None]
    if deltas:
        lo, hi = min(deltas), max(deltas)
        lines.append(f"Elevation change across holes (tee to green): {round(lo)}ft to {round(hi)}ft.")

    return "\n".join(lines)


# ── The writer prompt (§3a) — two fixed few-shot anchors, VERBATIM ─────────

# INTENTIONALLY DISTINCT register (specs/caddie-orb-persona-consistency-
# persona.md §3 row 4b / §5): this is WRITTEN scene-setting prose in the
# Augusta-broadcast voice, not a live spoken turn — it does NOT fold
# voice_prompts.CADDIE_HOUSE_REGISTER, and must not. It still owes rules
# 5/6 (never robotic, never invent) — pinned by
# tests/test_caddie_register_consistency.py's banned-literal scan and its
# register-absence assertion.
COURSE_WRITER_SYSTEM = """You are a WRITER, not a knower. Your job is to write a short, evocative
passage about a golf course, using ONLY two things:

1. The GROUND TRUTH block in the user message — our own surveyed geometry. It is authoritative
   for everything physical: holes, par, yardage, water, bunkers, out-of-bounds, trees, elevation.
   Treat every fact in it as fixed and correct; never contradict or extend it.
2. Your own general knowledge about this specific, named golf course — used ONLY for the optional
   fact sentences below, never for the geometry.

`landscape` is ALWAYS required: 3-5 sentences in an Augusta-broadcast-register scene-setting
voice — routing, terrain, character. It must contain NO architect name, NO year, NO tournament or
championship name, and NO other proper-noun history claim; ground it strictly in the GROUND TRUTH
block's geometry, nothing else.

Separately, in `architect_sentence` / `year_built_sentence` / `style_sentence` / `history_sentence`,
write ONE plain sentence each (or leave it empty) drawing on your own knowledge of this course —
NOT the GROUND TRUTH block, which has no such facts. For each, report your own honest confidence
in the matching `*_confidence` field as exactly one of "high", "medium", "low", or "unknown".
When in doubt, say "low" — a dropped fact costs nothing, a wrong fact is worse than none.

Formatting: each field is ONE plain sentence, single line, no markdown, no bullet points, no
headers, no URLs, no internal newlines.

Exemplar (target register, shown as a decomposed example — landscape sentences plus an architect
sentence and a history sentence woven to read as one paragraph):

"Bethpage Black climbs out of the Long Island pines the moment you leave the first tee, and it
does not come back down until the 18th green. A.W. Tillinghast built it broad-shouldered —
brawny, uphill par-4s, fairways pinched by rough, greens set behind bunkers deep enough to
swallow a stance. It has stood up to two U.S. Opens and a PGA Championship without softening a
line, and the tee sign that warns off the ordinary golfer is no idle boast. There is little room
for a loose swing here, and no shortcut through the closing holes, which rise steadily toward the
clubhouse for a finish that feels earned rather than given. It is a public course built to
championship scale — honest, demanding, and unmistakably itself."

Low-confidence fallback anchor (what `landscape`-only must read like — geometry only):

"The Black plays broad-shouldered from the first tee, uphill and demanding a full swing to reach
fairways pinched tight by rough. Bunkers sit deep enough to swallow a stance, guarding greens
that give no easy line in. The finishing holes keep climbing, right up to the clubhouse, so the
round never really eases off. It is a course built to full scale — nothing here plays short, and
nothing plays soft."
"""

_WRITER_MAX_TOKENS = 3000


class _CourseWriterOutput(BaseModel):
    """Structured-output schema for the writer LLM call — content fields
    ONLY. Provenance/version fields (`generated_at`, `model`,
    `schema_version`) are stamped by `write_course_description` itself,
    never asked of the model (mirrors `guide_writer._WriterOutput` /
    `HoleStrategyGuide`)."""

    landscape: str = ""
    architect_sentence: str = ""
    architect_confidence: str = "unknown"
    year_built_sentence: str = ""
    year_built_confidence: str = "unknown"
    style_sentence: str = ""
    style_confidence: str = "unknown"
    history_sentence: str = ""
    history_confidence: str = "unknown"


class CourseDescriptionDraft(_CourseWriterOutput):
    """The full draft passed to `validate_course_description` — the writer's
    content fields (inherited) plus stamped provenance. Offline-constructable
    (all fields defaulted) so tests exercise the validator with zero
    network/DB, exactly like `HoleStrategyGuide` in guide_writer.py's tests."""

    generated_at: Optional[str] = None
    model: Optional[str] = None
    schema_version: int = 1


async def write_course_description(
    course_name: str, address: Optional[str], ground_truth: str
) -> CourseDescriptionDraft:
    """The ONLY networked function in this module. Writes a course-level
    Augusta-styled description — Claude + structured output, parametric
    knowledge only (NO `web_search` tool: no untrusted web content to defend
    against, no per-search cost, a single cheap bounded call per course; see
    the module/plan for why this differs from `guide_writer.research_hole_guide`).

    Model: `COURSE_INTEL_MODEL` (default `claude-sonnet-5`) — a dedicated env,
    mirroring `GUIDE_WRITER_MODEL`, because the runtime caddie's
    `ANTHROPIC_MODEL` (Sonnet 4.5) does not support `messages.parse`
    structured outputs. Adaptive thinking only, no tools, so no `pause_turn`
    continuation loop is needed (unlike the hole-guide writer).

    May raise (missing API key, network/SDK errors, no parsed output) — the
    precompute job catches and logs; this function never fabricates a draft
    on failure. It is the CALLER's job to run `validate_course_description` on
    the result before persisting anything.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not configured")

    location_line = f" ({address})" if address else ""
    user_prompt = (
        f"{ground_truth}\n\n"
        f"Course: {course_name}{location_line}\n\n"
        "Write the landscape passage and, where you have HIGH confidence, the architect / "
        "year-built / style / history sentences, following the instructions and register above."
    )

    client = anthropic.AsyncAnthropic(api_key=api_key)
    model = os.getenv("COURSE_INTEL_MODEL", "claude-sonnet-5")

    result = await client.messages.parse(
        model=model,
        max_tokens=_WRITER_MAX_TOKENS,
        system=COURSE_WRITER_SYSTEM,
        messages=[{"role": "user", "content": user_prompt}],
        thinking={"type": "adaptive"},
        output_format=_CourseWriterOutput,
    )

    # Cost-guard logging (owner approved <$0.03/course, ~$0.10 for the 3-course
    # seed — see the plan §2), auditable straight off the response `usage`.
    usage = getattr(result, "usage", None)
    input_tokens = (getattr(usage, "input_tokens", 0) or 0) if usage is not None else 0
    output_tokens = (getattr(usage, "output_tokens", 0) or 0) if usage is not None else 0
    log.info(
        "course intel writer course=%r model=%s input_tokens=%d output_tokens=%d",
        course_name, model, input_tokens, output_tokens,
    )

    parsed = result.parsed_output if result is not None else None
    if parsed is None:
        raise RuntimeError(f"course intel writer returned no structured output for {course_name!r}")

    return CourseDescriptionDraft(
        **parsed.model_dump(),
        generated_at=datetime.now(timezone.utc).isoformat(),
        model=model,
        schema_version=1,
    )


# ── Validator (§3b) ─────────────────────────────────────────────────────────

# Structural sanity bounds — NOT anti-fabrication gates (those are the
# injection / fact-leak / confidence / par-claim rules below, all untouched by
# these numbers). They exist only to reject runaway output. The original 700
# cap was too tight for the writer's OWN instructed register ("3-5 sentences in
# an Augusta-broadcast register"), which naturally runs 700-830 chars: it
# reject-ALL'd clean, geometry-grounded landscapes for Bethpage Red (794) and
# Pebble Beach Golf Links (727) at the v1.1.13 seed while Bethpage Black passed
# only by luck of fitting under 700 (a Red-1-class false positive). Raised to
# fit a genuine 5-sentence landscape with margin; composed lifted in step so a
# near-max landscape plus surviving high-confidence facts can't trip a new
# length false-positive of the same class. See the regression tests pinning the
# two exact rejected drafts to PASS.
_MAX_LANDSCAPE_CHARS = 950
_MAX_FACT_SENTENCE_CHARS = 220
_MAX_COMPOSED_CHARS = 1600

# Fact-leak scan on `landscape` (rule 3): the confidence gate on the four
# optional fact fields is worthless if a fact simply leaks into the
# unconditional `landscape` field instead. Fail-closed — we cannot
# deterministically scrub prose, so any hit rejects the WHOLE draft.
_FACT_LEAK_PATTERN = re.compile(
    r"\b(?:1[89]\d{2}|20[0-2]\d)\b"           # a plausible 4-digit year
    r"|\barchitect\b|\bdesigned\b|\bredesign\b|\bchampion\b"
    r"|u\.?s\.?\s*open|\bpga\b|\bryder\b|\bwalker cup\b|\bhost(?:ed)?\b",
    re.IGNORECASE,
)

# Course-par claim check (rule 5): any standalone "par NN" claim in surviving
# text must equal the real, known par_total — catches the classic wrong
# "par 72" on a course whose real total is different.
_PAR_CLAIM_PATTERN = re.compile(r"\bpar\s*(6\d|7\d)\b", re.IGNORECASE)


def _has_markdown_markers(text: str) -> bool:
    """`#`, backtick, or `*` anywhere, or a `- ` bullet marker at the start —
    this text is rendered directly as plain prose, never treated as markdown
    or an instruction (same MED-1 rationale as guide_writer.py:966-973)."""
    if any(ch in text for ch in ("#", "`", "*")):
        return True
    return text.lstrip().startswith("- ")


def validate_course_description(
    draft: CourseDescriptionDraft, par_total: Optional[int]
) -> Optional[dict]:
    """Deterministic, no-LLM, fail-CLOSED grounding pass (§3b) — the
    correctness crux. Returns the composed description dict (the exact shape
    merged into `courses.course_intel.description`) on PASS, `None` on
    REJECT — the caller writes only the negative-cache marker
    ([[no-fake-data-fallbacks]]: nothing is shown for a rejected draft).

    Rules, in order (see the module/plan docstring for the full rationale):
      1. Injection scan, every field -> REJECT ALL.
      2. Landscape structural (empty / newline / length / markdown) -> REJECT ALL.
      3. Fact-leak scan on `landscape` only -> REJECT ALL.
      4. Confidence gate per fact (keep iff EXACTLY "high" and structurally
         valid) -> DROP that fact only, never reject-all.
      5. Course-par claim check over all SURVIVING text -> REJECT ALL on a
         mismatch against the real, known `par_total` (skipped when
         `par_total` is unknown — the precompute job never calls this
         without real geometry in practice, but the check degrades safely).
      6. Compose `text`, `provenance`, `facts_used`; a composed length over
         `_MAX_COMPOSED_CHARS` -> REJECT ALL.
    """
    landscape = draft.landscape or ""
    fact_specs: tuple[tuple[str, str, str], ...] = (
        ("architect", draft.architect_sentence, draft.architect_confidence),
        ("year_built", draft.year_built_sentence, draft.year_built_confidence),
        ("style_notes", draft.style_sentence, draft.style_confidence),
        ("notable_history", draft.history_sentence, draft.history_confidence),
    )

    # 1. Injection scan — every field, reject-all (defense-in-depth: this is
    # DATA — a field that reads like an instruction is not a course
    # description). Reuses `guide_writer.GUIDE_INJECTION_PATTERN` verbatim so
    # the two validators never drift apart.
    all_text_fields = [landscape, *[s for _, s, _ in fact_specs]]
    for field_text in all_text_fields:
        if GUIDE_INJECTION_PATTERN.search(field_text or ""):
            return None

    # 2. Landscape structural — reject-all.
    if not landscape.strip():
        return None
    if "\n" in landscape or "\r" in landscape:
        return None
    if len(landscape) > _MAX_LANDSCAPE_CHARS:
        return None
    if _has_markdown_markers(landscape):
        return None

    # 3. Fact-leak scan on landscape ONLY — reject-all.
    if _FACT_LEAK_PATTERN.search(landscape):
        return None

    # 4. Confidence gate per fact — drop only, never reject-all. Strict
    # "high"-only: there is no independent grounding for architect/year/style/
    # history (unlike hazards, we don't store these facts to check against),
    # so self-reported confidence is the only signal and the default on
    # ambiguity is to drop.
    survivors: dict[str, str] = {}
    for name, sentence, confidence in fact_specs:
        if confidence != "high":
            continue
        s = (sentence or "").strip()
        if not s:
            continue
        if "\n" in sentence or "\r" in sentence:
            continue
        if len(sentence) > _MAX_FACT_SENTENCE_CHARS:
            continue
        survivors[name] = s

    # 5. Course-par claim check over all surviving text — reject-all on
    # mismatch. Runs after the confidence gate so a dropped fact's own
    # (possibly wrong) par claim can never sink the draft.
    if par_total is not None:
        for text in (landscape, *survivors.values()):
            for m in _PAR_CLAIM_PATTERN.finditer(text):
                if int(m.group(1)) != par_total:
                    return None

    # 6. Compose.
    text = " ".join([landscape.strip(), *survivors.values()]).strip()
    if len(text) > _MAX_COMPOSED_CHARS:
        return None

    return {
        "text": text,
        "provenance": "enriched" if survivors else "landscape",
        "facts_used": list(survivors.keys()),
        "generated_at": draft.generated_at,
        "model": draft.model,
        "schema_version": draft.schema_version,
    }
