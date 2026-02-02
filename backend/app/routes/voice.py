"""Voice parsing API routes."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import anthropic
import os
import json
import re

router = APIRouter(prefix="/api/voice", tags=["voice"])


class VoiceScoreRequest(BaseModel):
    transcript: str
    playerNames: list[str]
    hole: int
    par: int


class VoiceScoreResponse(BaseModel):
    hole: int
    scores: dict[str, int]


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
        message = client.messages.create(
            model="claude-sonnet-4-20250514",
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
        
        return VoiceScoreResponse(
            hole=parsed.get("hole", request.hole),
            scores=parsed.get("scores", {})
        )
    except anthropic.AuthenticationError as e:
        raise HTTPException(status_code=401, detail="Invalid API key")
    except Exception as e:
        print(f"Voice parse error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
