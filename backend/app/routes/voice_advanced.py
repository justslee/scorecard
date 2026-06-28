"""Advanced voice parsing routes (migrated from Next.js /api/parse-voice*)."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import anthropic
import os
import json
import re
from typing import Optional

router = APIRouter(prefix="/api/voice", tags=["voice"])


def _get_client() -> anthropic.Anthropic:
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")
    return anthropic.Anthropic(api_key=api_key)


def _get_model() -> str:
    return os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")


def _safe_json_extract(text: str) -> Optional[str]:
    """Extract JSON from LLM output (handles fenced blocks)."""
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
    if fenced:
        candidate = fenced.group(1).strip()
        if candidate.startswith("{") or candidate.startswith("["):
            return candidate

    start = text.find("{")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        if depth == 0:
            return text[start : i + 1]
    return None


# ── Parse Round Setup ──


class RoundSetupState(BaseModel):
    """What's known about the round so far (carried across conversational turns)."""

    courseName: str = ""
    playerNames: list[str] = []
    teeName: Optional[str] = None


class RoundSetupRequest(BaseModel):
    transcript: str
    # Conversational context: what we already know, and which field this utterance
    # is answering ("course" | "players" | "tee"). Both optional → one-shot parse,
    # so existing callers are unaffected.
    current: Optional[RoundSetupState] = None
    expecting: Optional[str] = None


class RoundSetupResponse(BaseModel):
    courseName: str = ""
    playerNames: list[str] = []
    teeName: Optional[str] = None
    confidence: float = 0.5
    warnings: list[str] = []
    explanations: list[str] = []
    # Agentic fields: what's still required, the caddie's next question, and whether
    # the round can start. complete=True ⇒ followUpQuestion is None.
    missing: list[str] = []
    followUpQuestion: Optional[str] = None
    complete: bool = False


# ── Conversational helpers (pure — unit-tested in tests/test_round_setup_agent.py) ──

# A round needs at minimum a course and ≥1 player to start. Tees are optional
# (the setup screen defaults them), so they never block completion.
def round_setup_missing(course_name: str, player_names: list[str]) -> list[str]:
    """Required fields still absent, in the order we'd ask for them."""
    missing: list[str] = []
    if not (course_name or "").strip():
        missing.append("course")
    if not [n for n in player_names if (n or "").strip()]:
        missing.append("players")
    return missing


def round_setup_question(missing: list[str]) -> Optional[str]:
    """The caddie's next question — one thing at a time, course first.
    Kept short + conversational to match the app's quiet caddie voice."""
    if "course" in missing:
        return "Which course today?"
    if "players" in missing:
        return "Who's playing today?"
    return None


def merge_round_setup(
    current: Optional[RoundSetupState], parsed: RoundSetupResponse
) -> RoundSetupResponse:
    """Layer a new turn's parse over what we already knew. A newly-heard value
    wins; otherwise the prior value is kept, so each answer fills a gap without
    wiping earlier ones. Player names are unioned (order-preserving)."""
    if current is None:
        return parsed
    course = parsed.courseName.strip() or current.courseName
    tee = parsed.teeName or current.teeName
    names: list[str] = []
    for n in [*current.playerNames, *parsed.playerNames]:
        n = (n or "").strip()
        if n and n not in names:
            names.append(n)
    return RoundSetupResponse(
        courseName=course,
        playerNames=names,
        teeName=tee,
        confidence=parsed.confidence,
        warnings=parsed.warnings,
        explanations=parsed.explanations,
    )


def _local_parse_round_setup(
    transcript: str, expecting: Optional[str] = None
) -> RoundSetupResponse:
    """Fallback local parser when no API key available.

    `expecting` biases a short follow-up answer: when we just asked "which
    course?" a bare "Pebble Beach" has no "at" cue, so we take the whole utterance
    as the course; likewise a bare "Dan and Matt" answer to "who's playing?"."""
    text = transcript

    player_names: list[str] = []
    with_pattern = re.compile(
        r"(?:with|players?:?)\s+([A-Z][a-z]+(?:\s*,?\s*(?:and\s+)?[A-Z][a-z]+)*)",
        re.IGNORECASE,
    )
    for match in with_pattern.finditer(text):
        names_raw = re.split(r",|\s+and\s+", match.group(1))
        for n in names_raw:
            n = n.strip()
            if n:
                player_names.append(n)

    course_name = ""
    at_match = re.search(
        r"(?:at|playing)\s+([A-Z][A-Za-z\s]+?)(?:\s+(?:golf|course|with|today|everyone)|\s*$|,)",
        text,
        re.IGNORECASE,
    )
    if at_match:
        course_name = at_match.group(1).strip()

    tee_name = None
    tee_match = re.search(r"(?:from\s+(?:the\s+)?)?(\w+)\s+tees?", text, re.IGNORECASE)
    if tee_match:
        tee_name = tee_match.group(1)

    # Follow-up bias: interpret a bare answer as the field we asked for.
    cleaned = transcript.strip().rstrip(".!?")
    if expecting == "course" and not course_name and cleaned:
        course_name = cleaned
    elif expecting == "players" and not player_names and cleaned:
        for n in re.split(r",|\s+and\s+|\s+", cleaned):
            n = n.strip()
            if n:
                player_names.append(n)

    # De-dup players, preserving order.
    seen: list[str] = []
    for n in player_names:
        if n not in seen:
            seen.append(n)

    return RoundSetupResponse(
        courseName=course_name,
        playerNames=seen,
        teeName=tee_name,
        confidence=0.55,
        warnings=["Used local parsing (no API key)."],
    )


def _finalize_round_setup(
    parsed: RoundSetupResponse, current: Optional[RoundSetupState]
) -> RoundSetupResponse:
    """Merge this turn over prior state, then attach the agentic status (what's
    still missing, the caddie's next question, whether we can start)."""
    merged = merge_round_setup(current, parsed)
    missing = round_setup_missing(merged.courseName, merged.playerNames)
    merged.missing = missing
    merged.complete = not missing
    merged.followUpQuestion = round_setup_question(missing)
    return merged


@router.post("/parse-round-setup", response_model=RoundSetupResponse)
async def parse_round_setup(request: RoundSetupRequest):
    """Parse a voice transcript into a round setup, conversationally.

    Merges this turn over any `current` state and returns `missing` /
    `followUpQuestion` / `complete` so the client can ask the golfer for whatever
    is still needed (course, players) instead of dead-ending on a partial parse.
    """
    if not request.transcript:
        raise HTTPException(400, "No transcript provided")

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        parsed = _local_parse_round_setup(request.transcript, request.expecting)
        return _finalize_round_setup(parsed, request.current)

    client = anthropic.Anthropic(api_key=api_key)
    model = _get_model()

    system = """You extract a golf round setup from voice transcription and must return ONLY valid JSON.

Schema:
{
  "courseName": string,
  "playerNames": string[],
  "teeName": string | null
}

Rules:
- Split players into individual names ("Dan Justin Matt" -> ["Dan","Justin","Matt"]).
- courseName should be the course mentioned if any.
- teeName should be tee color/name if mentioned; otherwise null.
- Return only JSON, no extra text."""

    # Conversational steering: if this utterance answers a specific question, the
    # answer may be bare (e.g. just a course name) — tell the model what to expect.
    if request.expecting == "course":
        system += '\n- This utterance answers "which course?" — treat it as the courseName even with no "at"/"playing" cue.'
    elif request.expecting == "players":
        system += '\n- This utterance answers "who is playing?" — treat the names as playerNames.'

    user_msg = f'Transcript: "{request.transcript}"'

    last_err = None
    for attempt in range(3):
        try:
            sys_prompt = system
            if attempt > 0 and last_err:
                sys_prompt += f"\n\nYour previous output was invalid. Fix it. Error: {last_err}"

            message = client.messages.create(
                model=model,
                max_tokens=300,
                temperature=0,
                system=sys_prompt,
                messages=[{"role": "user", "content": user_msg}],
            )
            text = message.content[0].text
            json_text = _safe_json_extract(text)
            if not json_text:
                last_err = "No JSON found"
                continue

            obj = json.loads(json_text)
            parsed = RoundSetupResponse(
                courseName=obj.get("courseName", ""),
                playerNames=obj.get("playerNames", []),
                teeName=obj.get("teeName"),
                confidence=0.75,
            )
            return _finalize_round_setup(parsed, request.current)
        except json.JSONDecodeError as e:
            last_err = str(e)
        except Exception as e:
            last_err = str(e)

    raise HTTPException(500, "Could not parse transcript")


# ── Parse Scorecard Image (OCR) ──


class ScorecardRequest(BaseModel):
    imageBase64: str
    existingPlayerNames: Optional[list[str]] = None


class ScorecardPlayer(BaseModel):
    name: str
    scores: list[Optional[int]] = []


class ScorecardResponse(BaseModel):
    players: list[ScorecardPlayer] = []
    confidence: float = 0.0
    rawText: Optional[str] = None


@router.post("/parse-scorecard", response_model=ScorecardResponse)
async def parse_scorecard(request: ScorecardRequest):
    """OCR a golf scorecard photo into per-player hole scores.

    Server-side only: the Anthropic key never leaves the backend. Replaces the old
    browser-side Anthropic call that lived in frontend/src/lib/ocr.ts.
    """
    if not request.imageBase64:
        raise HTTPException(400, "No image provided")

    # Accept either a raw base64 string or a data: URL.
    media_type = "image/jpeg"
    data = request.imageBase64
    m = re.match(r"^data:([^;]+);base64,(.+)$", data)
    if m:
        media_type = m.group(1)
        data = m.group(2)

    client = _get_client()
    model = _get_model()

    hint = ""
    if request.existingPlayerNames:
        hint = "\nExpected player names might include: " + ", ".join(request.existingPlayerNames)

    prompt = (
        "Analyze this golf scorecard image and extract the scores.\n"
        'Return ONLY JSON: {"players":[{"name":string,"scores":[18 ints or null]}],"confidence":0-1}.\n'
        "- scores must have exactly 18 elements (holes 1-18), null for blank/unreadable.\n"
        "- If the card is unreadable, return an empty players array with low confidence." + hint
    )

    try:
        message = client.messages.create(
            model=model,
            max_tokens=1024,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": media_type, "data": data},
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        )
        text = message.content[0].text
        json_text = _safe_json_extract(text)
        if not json_text:
            raise HTTPException(422, "Could not read the scorecard")
        obj = json.loads(json_text)
        return ScorecardResponse(
            players=[
                ScorecardPlayer(name=p.get("name", ""), scores=p.get("scores", []))
                for p in obj.get("players", [])
            ],
            confidence=float(obj.get("confidence", 0.0)),
            rawText=text,
        )
    except json.JSONDecodeError:
        raise HTTPException(422, "Could not read the scorecard")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Scorecard OCR failed: {e}")


# ── Parse Voice Transcript (full setup) ──


class VoiceTranscriptRequest(BaseModel):
    transcript: str
    systemPrompt: Optional[str] = None
    knownPlayers: Optional[list[str]] = None
    knownCourses: Optional[list[str]] = None


@router.post("/parse-transcript")
async def parse_voice_transcript(request: VoiceTranscriptRequest):
    """Parse comprehensive voice transcript for round data."""
    if not request.transcript:
        raise HTTPException(400, "No transcript provided")

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "No API key configured")

    client = anthropic.Anthropic(api_key=api_key)
    model = _get_model()

    system = request.systemPrompt or """You are a parser that extracts golf round information from voice transcription.
Return ONLY valid JSON with the following structure:
{
  "format": "skins" | "nassau" | "bestBall" | "scramble" | "matchPlay" | "stableford" | "wolf" | "threePoint" | null,
  "courseName": string | null,
  "playerNames": string[],
  "teams": [[string, string], [string, string]] | null,
  "handicapped": boolean,
  "pointValue": number | null,
  "confidence": number
}"""

    context_parts = []
    if request.knownPlayers:
        context_parts.append(f"Known players: {', '.join(request.knownPlayers)}")
    if request.knownCourses:
        context_parts.append(f"Known courses: {', '.join(request.knownCourses)}")

    user_msg = f'Transcript: "{request.transcript}"'
    if context_parts:
        user_msg += "\n" + "\n".join(context_parts)

    try:
        message = client.messages.create(
            model=model,
            max_tokens=600,
            temperature=0,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        text = message.content[0].text
        json_text = _safe_json_extract(text)
        if json_text:
            return json.loads(json_text)
        return {"error": "Could not parse", "raw": text}
    except Exception as e:
        raise HTTPException(500, str(e))
