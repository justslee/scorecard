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


class RoundSetupRequest(BaseModel):
    transcript: str
    apiKey: Optional[str] = None


class RoundSetupResponse(BaseModel):
    courseName: str = ""
    playerNames: list[str] = []
    teeName: Optional[str] = None
    confidence: float = 0.5
    warnings: list[str] = []
    explanations: list[str] = []


def _local_parse_round_setup(transcript: str) -> RoundSetupResponse:
    """Fallback local parser when no API key available."""
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

    return RoundSetupResponse(
        courseName=course_name,
        playerNames=list(set(player_names)),
        teeName=tee_name,
        confidence=0.55,
        warnings=["Used local parsing (no API key)."],
    )


@router.post("/parse-round-setup", response_model=RoundSetupResponse)
async def parse_round_setup(request: RoundSetupRequest):
    """Parse voice transcript to extract round setup (course, players, tee)."""
    if not request.transcript:
        raise HTTPException(400, "No transcript provided")

    api_key = request.apiKey or os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return _local_parse_round_setup(request.transcript)

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
            return RoundSetupResponse(
                courseName=obj.get("courseName", ""),
                playerNames=obj.get("playerNames", []),
                teeName=obj.get("teeName"),
                confidence=0.75,
            )
        except json.JSONDecodeError as e:
            last_err = str(e)
        except Exception as e:
            last_err = str(e)

    raise HTTPException(500, "Could not parse transcript")


# ── Parse Voice Transcript (full setup) ──


class VoiceTranscriptRequest(BaseModel):
    transcript: str
    systemPrompt: Optional[str] = None
    knownPlayers: Optional[list[str]] = None
    knownCourses: Optional[list[str]] = None
    apiKey: Optional[str] = None


@router.post("/parse-transcript")
async def parse_voice_transcript(request: VoiceTranscriptRequest):
    """Parse comprehensive voice transcript for round data."""
    if not request.transcript:
        raise HTTPException(400, "No transcript provided")

    api_key = request.apiKey or os.getenv("ANTHROPIC_API_KEY")
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
