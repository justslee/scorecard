"""Voice parsing API routes."""

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, Form
from pydantic import BaseModel
import anthropic
import logging
import os
import json
from typing import Optional
import re

from app.services.deepgram import transcribe_audio, grant_live_token
from app.services.openai_tts import synthesize_speech
from app.services.clerk_auth import current_user_id
from app.caddie.personalities import load_personality

router = APIRouter(prefix="/api/voice", tags=["voice"])


# ── Short-lived Deepgram token for browser-side live WebSocket ──


class LiveTokenResponse(BaseModel):
    access_token: str
    expires_in: int


@router.post("/live-token", response_model=LiveTokenResponse)
async def get_live_token(user_id: str = Depends(current_user_id)):
    """Mint a short-lived Deepgram WebSocket token for the browser live-transcription path.

    Auth required — the API key must stay server-side; the browser gets only a
    time-limited (60-second) token scoped to one streaming session.
    Returns {access_token, expires_in}.
    """
    return await grant_live_token()


# ── One-shot speech-to-text via Deepgram ──


_MAX_AUDIO_BYTES = 10 * 1024 * 1024  # 10MB cap — plenty for a 2 minute voice clip


@router.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    keyterms: Optional[str] = Form(None),
    user_id: str = Depends(current_user_id),
):
    """Transcribe a one-shot recording (e.g. round setup, score entry) via Deepgram Nova-3.

    Auth required — Deepgram is metered against our project key.

    Frontend posts a multipart form with the recorded audio blob (webm/opus, mp4/aac, wav, etc.).
    Returns: {transcript, confidence, duration, model}
    """
    if not audio.filename and not audio.content_type:
        raise HTTPException(400, "No audio file provided")

    body = await audio.read()
    if len(body) == 0:
        raise HTTPException(400, "Empty audio body")
    if len(body) > _MAX_AUDIO_BYTES:
        raise HTTPException(413, f"Audio too large ({len(body)} bytes)")

    # nova-3 keyterm prompting: JSON array of context/golf vocabulary from the
    # client (player names, course names, club terms). Malformed → ignored.
    terms: list[str] = []
    if keyterms:
        try:
            parsed = json.loads(keyterms)
            if isinstance(parsed, list):
                terms = [str(t)[:80] for t in parsed if str(t).strip()][:50]
        except (ValueError, TypeError):
            terms = []

    return await transcribe_audio(
        body, content_type=audio.content_type or "audio/webm", keyterms=terms or None
    )


# ── Spoken caddie replies for the sheets (specs/voice-tts-sheet-replies) ──


class SpeakRequest(BaseModel):
    text: str
    personality_id: str = "classic"


@router.post("/speak")
async def speak(req: SpeakRequest, user_id: str = Depends(current_user_id)):
    """Synthesize a completed caddie reply to speech (mp3), persona-matched.

    Resolves the SAME persona the Realtime orb uses (load_personality) so the
    sheet voice always matches the orb voice for a given persona, including
    custom DB personas. Auth required — the OpenAI key stays server-side.
    """
    persona = await load_personality(req.personality_id)
    audio = await synthesize_speech(req.text, persona.voice_id)
    return Response(content=audio, media_type="audio/mpeg")


class VoiceScoreRequest(BaseModel):
    transcript: str
    playerNames: list[str]
    hole: int
    par: int


class VoiceScoreResponse(BaseModel):
    hole: int
    scores: dict[str, int]
    # Honest derived confidence (0–1).
    # Formula: min(1.0, (players_scored / total_players) * 0.9)
    # Empty parse → 0.2 (show amber warning and "try again" cue).
    confidence: float = 0.5


def _derive_confidence(scores: dict[str, int], player_names: list[str]) -> float:
    """Derive a honest confidence signal from the extraction result.

    Empty scores (nothing parsed) → 0.2.
    Otherwise: (players_scored / total_players) * 0.9, capped at 1.0.
    A full table gets 0.9; a partial parse lands below that proportionally.
    """
    if not scores:
        return 0.2
    total = max(1, len(player_names))
    scored = len(scores)
    return min(1.0, (scored / total) * 0.9)


@router.post("/parse-scores", response_model=VoiceScoreResponse)
async def parse_voice_scores(request: VoiceScoreRequest):
    """Parse voice transcript to extract golf scores using Claude."""

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not configured")

    client = anthropic.Anthropic(api_key=api_key)

    prompt = f"""You are parsing golf scores from a voice transcript.

Players in this round: {', '.join(request.playerNames)}
Current hole: {request.hole}
Par for this hole: {request.par}

Voice transcript: "{request.transcript}"

Parse this and return a JSON object with the scores for each player mentioned.

Rules:
- Match player names flexibly (first name, nickname, partial match)
- "par" = {request.par}, "birdie" = {request.par - 1}, "eagle" = {request.par - 2}, "bogey" = {request.par + 1}, "double bogey" = {request.par + 2}
- "everyone par" means all players get {request.par}
- Numbers can be spoken as words (four, five) or digits
- If a player name sounds similar to one in the list, use that player

Return ONLY valid JSON in this exact format, no other text:
{{"hole": {request.hole}, "scores": {{"PlayerName": score, "PlayerName2": score}}}}

Use the exact player names from the list above in your response."""

    try:
        model = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-20250514")

        message = client.messages.create(
            model=model,
            max_tokens=256,
            messages=[{"role": "user", "content": prompt}]
        )

        response_text = message.content[0].text
        print(f"Claude response: {response_text}")

        # Extract JSON from response
        json_match = re.search(r'\{[\s\S]*\}', response_text)
        if not json_match:
            raise HTTPException(status_code=500, detail=f"Could not parse response: {response_text}")

        parsed = json.loads(json_match.group())
        extracted_scores: dict[str, int] = parsed.get("scores", {})

        return VoiceScoreResponse(
            hole=parsed.get("hole", request.hole),
            scores=extracted_scores,
            confidence=_derive_confidence(extracted_scores, request.playerNames),
        )
    except anthropic.AuthenticationError:
        raise HTTPException(status_code=401, detail="Invalid API key")
    except HTTPException:
        raise
    except Exception:
        logging.getLogger("looper.voice").exception("parse_voice_scores failed")
        raise HTTPException(status_code=500, detail="Couldn't parse that — try saying the scores again.")

# ── Voice telemetry (specs/voice-agent-audit.md P1.4) ────────────────────────
# The iOS live-dictation fallback shipped broken for days because we had zero
# visibility — the OWNER found it. Clients now report transport/fallback/
# latency events; structured log lines make fallback rates greppable
# (journalctl -u scorecard-api | grep voicetel).

_tel_log = logging.getLogger("looper.voicetel")


class VoiceTelemetryEvent(BaseModel):
    surface: str
    event: str
    detail: Optional[str] = None
    ms: Optional[int] = None


class VoiceTelemetryBatch(BaseModel):
    events: list[VoiceTelemetryEvent]


@router.post("/telemetry")
async def voice_telemetry(
    batch: VoiceTelemetryBatch,
    user_id: str = Depends(current_user_id),
):
    """Fire-and-forget client voice events → structured logs. Capped + clamped;
    never fails the client (a telemetry error must not break dictation)."""
    for e in batch.events[:40]:
        _tel_log.info(
            "voicetel surface=%s event=%s detail=%s ms=%s user=%s",
            e.surface[:40],
            e.event[:40],
            (e.detail or "")[:120],
            e.ms if e.ms is not None else "",
            user_id[:12],
        )
    return {"ok": True}
