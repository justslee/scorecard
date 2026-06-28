"""Scorecard API - FastAPI backend."""

import os

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from app.services.clerk_auth import require_owner
from app.services.secrets import load_secrets_into_env

load_dotenv()
# Pull prod API keys (Deepgram/OpenAI/Anthropic/…) from AWS Secrets Manager into
# the env BEFORE routes import (they read os.getenv at import time). No-op locally
# (no AWS creds) and never overrides an explicit env var / .env value.
load_secrets_into_env()


def _allowed_origins() -> list[str]:
    """Locked-down CORS origins. The native iOS WebView origin is
    https://localhost (Capacitor iosScheme: "https" — see frontend/capacitor.config.ts);
    capacitor://localhost is kept for older installs during the transition; local
    web dev uses localhost:3000; an optional ALLOWED_ORIGIN env (comma-separated)
    adds the production web/app origin."""
    origins = ["https://localhost", "capacitor://localhost", "http://localhost:3000"]
    extra = os.getenv("ALLOWED_ORIGIN")
    if extra:
        origins.extend(o.strip() for o in extra.split(",") if o.strip())
    return origins

app = FastAPI(
    title="Scorecard API",
    description="Backend API for the Scorecard golf scoring app",
    version="1.0.0"
)

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)

# Import and include routers
from app.routes import players, rounds, tournaments, courses, voice  # noqa: E402  (after load_dotenv: routes read env at import)
from app.routes import golf, course_search, courses_mapped, voice_advanced, caddie, memory, realtime, shots, pins  # noqa: E402
from app.routes import profile  # noqa: E402

# Every data router is owner-only: require the configured owner's verified Clerk
# identity. /health and / (defined below) stay open for load-balancer checks.
_owner_only = [Depends(require_owner)]

app.include_router(players.router, dependencies=_owner_only)
app.include_router(rounds.router, dependencies=_owner_only)
app.include_router(tournaments.router, dependencies=_owner_only)
app.include_router(profile.router, dependencies=_owner_only)
# Specific /api/courses/* routers MUST be registered before the catch-all
# courses.router (GET /api/courses/{course_id}); Starlette is first-match-wins,
# so otherwise /{course_id} shadows /search, /nearby, /mapped/*.
app.include_router(course_search.router, dependencies=_owner_only)
app.include_router(courses_mapped.router, dependencies=_owner_only)
app.include_router(courses.router, dependencies=_owner_only)
app.include_router(voice.router, dependencies=_owner_only)
# Migrated from Next.js + new caddie system
app.include_router(golf.router, dependencies=_owner_only)
app.include_router(voice_advanced.router, dependencies=_owner_only)
app.include_router(caddie.router, dependencies=_owner_only)
app.include_router(memory.router, dependencies=_owner_only)
app.include_router(realtime.router, dependencies=_owner_only)
app.include_router(shots.router, dependencies=_owner_only)
app.include_router(pins.router, dependencies=_owner_only)


@app.on_event("startup")
async def startup():
    """Start background tasks on startup.

    seed_default_data() has been removed — all domain data (players, rounds,
    tournaments, scoring courses) is now Postgres-backed via Alembic migrations.
    """
    import asyncio
    from app.caddie.session import sessions

    # Periodic cleanup of expired round sessions (every 30 min)
    async def cleanup_loop():
        while True:
            await asyncio.sleep(30 * 60)
            try:
                await sessions.cleanup_expired()
            except Exception:
                pass

    asyncio.create_task(cleanup_loop())


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/api/config-status")
async def config_status():
    """Public: which server-side API keys are configured (presence ONLY, never
    values). Lets us verify the Secrets Manager loader populated the env without
    needing prod shell access. No auth so it can be probed directly."""
    def _present(*keys: str) -> bool:
        return any(bool(os.getenv(k)) for k in keys)

    return {
        "deepgram": _present("DEEPGRAM_API_KEY"),
        "openai": _present("OPENAI_API_KEY"),
        "anthropic": _present("ANTHROPIC_API_KEY"),
        "mapbox": _present("NEXT_PUBLIC_MAPBOX_TOKEN", "MAPBOX_TOKEN"),
    }


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
