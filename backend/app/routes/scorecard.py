"""Scorecard OCR scan route — turns a photo of a paper scorecard into structured scores
via Claude vision. Backend only; the camera→review→import UI is a follow-up."""

import base64
import json
import os
import re
from typing import Optional

import anthropic
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from app.services.clerk_auth import current_user_id

router = APIRouter(prefix="/api/scorecard", tags=["scorecard"])

# 10 MB — generous for a compressed JPEG phone photo; mirrors the audio cap in voice.py
_MAX_IMAGE_BYTES = 10 * 1024 * 1024

# Anthropic vision only accepts these four MIME types.
_ALLOWED_MEDIA_TYPES: frozenset[str] = frozenset(
    {"image/jpeg", "image/png", "image/webp", "image/gif"}
)


# ── Response models (backend-local; mirror to types.ts when the scan UI ships) ──


class HoleScores(BaseModel):
    """Scores for one hole extracted from the scanned scorecard.

    `par` is null when not printed on the card or unreadable.
    `scores` values are null when a cell is blank or unreadable.
    """

    number: int
    par: Optional[int] = None
    scores: dict[str, Optional[int]]


class ScanScorecardResponse(BaseModel):
    """Structured scorecard extracted from a photo by Claude vision."""

    players: list[str]
    holes: list[HoleScores]


# ── Vision prompt ──

_SCAN_PROMPT = """\
You are reading a paper golf scorecard from a photo.

Extract ALL player names (from the row headers) and ALL holes (from the columns).
For each hole record:
- The hole number (integer, 1–18)
- The par value (integer if printed on the card; null if not visible or unreadable)
- Each player's stroke count for that hole (integer; null if the cell is blank, smudged,\
 or unreadable)

Return ONLY valid JSON — no prose, no markdown fences, no explanation — in EXACTLY this shape:

{
  "players": ["Alice", "Bob"],
  "holes": [
    {"number": 1, "par": 4, "scores": {"Alice": 5, "Bob": null}},
    {"number": 2, "par": 3, "scores": {"Alice": 3, "Bob": 4}}
  ]
}

Rules:
- Use the player names exactly as written on the scorecard.
- Use null (not 0, not the string "null") whenever a cell is blank, smudged, or unreadable.
- Include every hole visible on the card, in ascending order by hole number.
- Do NOT include any text outside the JSON object.
"""


# ── Pure helpers — testable without a live API call ──


def _extract_text_content(content) -> str:
    """Return the text of the first text-type block in a Claude message content list.

    Skips non-text blocks (e.g. extended-thinking blocks) that may appear before
    the text block.  Returns an empty string when no text block is found;
    ``_parse_scan_response`` will then raise a clean ValueError("No JSON object
    found") which routes to the 500 error path.
    """
    return next(
        (b.text for b in content if getattr(b, "type", None) == "text"),
        "",
    )


def _parse_scan_response(text: str) -> ScanScorecardResponse:
    """Extract and validate the JSON scorecard from a Claude vision response string.

    This is a pure function with no I/O; unit-test it directly with fixture strings.

    Raises:
        ValueError: if the text contains no JSON object, if the JSON is malformed,
                    if the object is missing required keys, if ``players`` / ``holes``
                    are not lists, or if any hole entry is malformed.
    """
    # Mirror the regex used in voice.py / voice_advanced.py to tolerate fenced blocks
    # or prose wrappers that a model might accidentally emit.
    json_match = re.search(r"\{[\s\S]*\}", text)
    if not json_match:
        raise ValueError(f"No JSON object found in model response: {text!r}")

    try:
        raw = json.loads(json_match.group())
    except json.JSONDecodeError as exc:
        raise ValueError(f"Malformed JSON in model response: {exc}") from exc

    if "players" not in raw or "holes" not in raw:
        raise ValueError(
            "Response JSON missing 'players' or 'holes' keys. "
            f"Got keys: {sorted(raw.keys())}"
        )

    # Validate top-level shapes — a model might emit an object or scalar instead of a list.
    if not isinstance(raw["players"], list):
        raise ValueError(
            f"'players' must be a list; got {type(raw['players']).__name__!r}"
        )
    if not isinstance(raw["holes"], list):
        raise ValueError(
            f"'holes' must be a list; got {type(raw['holes']).__name__!r}"
        )

    holes: list[HoleScores] = []
    for h in raw["holes"]:
        if not isinstance(h, dict):
            raise ValueError(
                f"Each hole entry must be a dict; got {type(h).__name__!r}: {h!r}"
            )
        if "number" not in h:
            raise ValueError(
                f"Hole entry missing required 'number' field: {h!r}"
            )
        holes.append(
            HoleScores(
                number=h["number"],
                par=h.get("par"),
                # Preserve None values — unreadable cells stay null.
                scores={k: v for k, v in h.get("scores", {}).items()},
            )
        )

    return ScanScorecardResponse(
        players=raw["players"],
        holes=holes,
    )


# ── Endpoint ──


@router.post("/scan", response_model=ScanScorecardResponse)
async def scan_scorecard(
    image: UploadFile = File(...),
    user_id: str = Depends(current_user_id),
):
    """OCR a paper scorecard photo into structured scores using Claude vision.

    Auth required — Claude API usage is metered; keeps the key server-side.

    Accepts a multipart form upload (field name ``image``) of a JPEG, PNG, WEBP,
    or GIF image up to 10 MB.  Returns the extracted player names and per-hole
    scores; cells that are blank or unreadable are returned as null.

    Error responses:
    - 400  No/empty image, wrong MIME type, or unsupported format.
    - 401  Invalid Anthropic API key (mirrors voice.py behaviour).
    - 413  Image exceeds the 10 MB cap.
    - 500  ANTHROPIC_API_KEY not configured, or Claude's response could not be
           parsed into a valid scorecard shape (includes the raw model text).
    """
    # Guard: file must be provided with a declared content type
    if not image.filename and not image.content_type:
        raise HTTPException(400, "No image file provided")

    content_type: str = (image.content_type or "").strip()
    if not content_type.startswith("image/"):
        raise HTTPException(
            400,
            f"File must be an image (image/jpeg, image/png, image/webp, image/gif); "
            f"received content-type: {content_type!r}",
        )
    if content_type not in _ALLOWED_MEDIA_TYPES:
        raise HTTPException(
            400,
            f"Unsupported image format {content_type!r}. "
            "Use JPEG, PNG, WEBP, or GIF.",
        )

    body = await image.read()
    if len(body) == 0:
        raise HTTPException(400, "Empty image body")
    if len(body) > _MAX_IMAGE_BYTES:
        raise HTTPException(
            413,
            f"Image too large ({len(body):,} bytes); limit is 10 MB",
        )

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")

    # Use the shared ANTHROPIC_MODEL env var (vision-capable; defaults to opus).
    model = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-20250514")
    client = anthropic.Anthropic(api_key=api_key)
    image_b64 = base64.standard_b64encode(body).decode()

    try:
        message = client.messages.create(
            model=model,
            # 2 048 tokens is comfortable for an 18-hole card with 4 players
            # (the compact JSON is ~800 chars / ~200 tokens; headroom for verbose names).
            max_tokens=2048,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": content_type,
                                "data": image_b64,
                            },
                        },
                        {
                            "type": "text",
                            "text": _SCAN_PROMPT,
                        },
                    ],
                }
            ],
        )

        # Use the helper so that non-text first blocks (e.g. thinking blocks) are
        # skipped safely; an empty result flows into _parse_scan_response's
        # "No JSON object found" ValueError → clean 500 path.
        response_text = _extract_text_content(message.content)
        # Log a preview for server-side debugging without spilling the full image.
        print(f"[scorecard/scan] Claude response ({len(response_text)} chars): "
              f"{response_text[:300]}...")

        return _parse_scan_response(response_text)

    except anthropic.AuthenticationError:
        raise HTTPException(401, "Invalid Anthropic API key")
    except ValueError as exc:
        # Parser could not extract a valid scorecard from the model output.
        raise HTTPException(
            500,
            f"Could not parse scorecard from model response: {exc}",
        )
    except Exception as exc:
        print(f"[scorecard/scan] error: {exc}")
        raise HTTPException(500, str(exc))
