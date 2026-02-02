from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import anthropic
import os
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Scorecard API", version="1.0.0")

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "https://scorecard-alpha.vercel.app"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class VoiceScoreRequest(BaseModel):
    transcript: str
    playerNames: list[str]
    hole: int
    par: int


class VoiceScoreResponse(BaseModel):
    hole: int
    scores: dict[str, int]


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/parse-voice-scores", response_model=VoiceScoreResponse)
async def parse_voice_scores(request: VoiceScoreRequest):
    """Parse voice transcript to extract golf scores using Claude."""
    
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY not configured")
    
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

    message = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=256,
        messages=[
            {"role": "user", "content": prompt}
        ]
    )
    
    response_text = message.content[0].text
    print(f"Claude response: {response_text}")
    
    # Extract JSON from response
    import json
    import re
    
    json_match = re.search(r'\{[\s\S]*\}', response_text)
    if not json_match:
        raise ValueError(f"Could not parse response: {response_text}")
    
    parsed = json.loads(json_match.group())
    
    return VoiceScoreResponse(
        hole=parsed.get("hole", request.hole),
        scores=parsed.get("scores", {})
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
