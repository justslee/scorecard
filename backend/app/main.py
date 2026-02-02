"""Scorecard API - FastAPI backend."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(
    title="Scorecard API",
    description="Backend API for the Scorecard golf scoring app",
    version="1.0.0"
)

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://scorecard-alpha.vercel.app",
        "https://*.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import and include routers
from app.routes import players, rounds, tournaments, courses, voice

app.include_router(players.router)
app.include_router(rounds.router)
app.include_router(tournaments.router)
app.include_router(courses.router)
app.include_router(voice.router)


@app.on_event("startup")
async def startup():
    """Seed default data on startup."""
    from app.storage import seed_default_data
    seed_default_data()


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "name": "Scorecard API",
        "version": "1.0.0",
        "docs": "/docs",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
