"""Scorecard API - FastAPI backend."""

import os

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from app.services.clerk_auth import _assert_boot_config, require_member
from app.services.secrets import load_secrets_into_env

import logging

# App loggers (looper.*) default to the root WARNING level under uvicorn, so
# INFO telemetry/diagnostic lines never reached the journal (voicetel events
# were arriving but invisible). Configure once, idempotently.
logging.basicConfig(level=logging.INFO)
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
from app.routes import course_reviews  # noqa: E402
from app.routes import scorecard  # noqa: E402
from app.routes import tee_times  # noqa: E402

# Every data router requires a verified Clerk member identity. In the default
# APP_ACCESS_MODE=owner (unset in prod today) require_member is byte-identical
# to the old require_owner gate — only the configured owner passes. Flipping
# APP_ACCESS_MODE=open (a later, deliberate rollout step) admits any verified
# member; per-row scoping isolates their data (see clerk_auth.require_member's
# docstring for the deferred gaps that must close first). A few routes mutate
# GLOBAL state or place real outbound calls and stay require_owner even after
# the flip — see the explicit Depends(require_owner) carve-outs in
# courses_mapped.py's write handlers and tee_times.py's request_availability_
# call. /health and / (defined below) stay open for load-balancer checks.
_member = [Depends(require_member)]

app.include_router(players.router, dependencies=_member)
app.include_router(rounds.router, dependencies=_member)
app.include_router(tournaments.router, dependencies=_member)
app.include_router(profile.router, dependencies=_member)
# Specific /api/courses/* routers MUST be registered before the catch-all
# courses.router (GET /api/courses/{course_id}); Starlette is first-match-wins,
# so otherwise /{course_id} shadows /search, /nearby, /mapped/*.
app.include_router(course_search.router, dependencies=_member)
app.include_router(courses_mapped.router, dependencies=_member)
# Two-segment /api/courses/{course_key}/reviews sub-resource — MUST precede catch-all.
app.include_router(course_reviews.router, dependencies=_member)
app.include_router(course_reviews.reviews_router, dependencies=_member)  # B3 — /api/reviews/mine
app.include_router(courses.router, dependencies=_member)
app.include_router(voice.router, dependencies=_member)
# Migrated from Next.js + new caddie system
app.include_router(golf.router, dependencies=_member)
app.include_router(voice_advanced.router, dependencies=_member)
app.include_router(caddie.router, dependencies=_member)
app.include_router(memory.router, dependencies=_member)
app.include_router(realtime.router, dependencies=_member)
app.include_router(shots.router, dependencies=_member)
app.include_router(pins.router, dependencies=_member)
app.include_router(scorecard.router, dependencies=_member)
app.include_router(tee_times.router, dependencies=_member)

from app.routes import voice_booking_ws  # noqa: E402
# DELIBERATELY NOT _owner_only: Twilio's media stream cannot carry owner auth.
# Sole guard = single-use unguessable call token minted by LiveCallTransport
# (backend/app/services/voice_booking/call_registry.py). See voice_booking_ws.py.
app.include_router(voice_booking_ws.router)


@app.on_event("startup")
async def startup():
    """Start background tasks on startup.

    seed_default_data() has been removed — all domain data (players, rounds,
    tournaments, scoring courses) is now Postgres-backed via Alembic migrations.
    """
    import asyncio
    from app.caddie.session import sessions

    # Refuse to boot in an unsafe auth configuration (APP_ACCESS_MODE=open
    # without JWKS/issuer/authorized-parties pinned). Deliberately NOT called
    # at import time — see _assert_boot_config's docstring.
    _assert_boot_config()

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
        "golfapi": _present("GOLF_API_KEY"),
        "google_places": _present("GOOGLE_PLACES_API_KEY"),
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
