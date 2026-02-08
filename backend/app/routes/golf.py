"""GolfAPI.io proxy routes (migrated from Next.js /api/golf)."""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
import httpx
import os

router = APIRouter(prefix="/api/golf", tags=["golf"])

GOLF_API_BASE = "https://www.golfapi.io/api/v2.3"


def _api_headers() -> dict:
    key = os.getenv("GOLF_API_KEY", "")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


@router.get("")
async def golf_proxy(
    action: str = Query(..., description="search, club, or course"),
    q: str = Query(None),
    id: str = Query(None),
):
    """Proxy GolfAPI.io requests, keeping API key server-side."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            if action == "search":
                if not q:
                    raise HTTPException(400, "Missing q parameter")
                resp = await client.get(
                    f"{GOLF_API_BASE}/clubs",
                    params={"q": q},
                    headers=_api_headers(),
                )
            elif action == "club":
                if not id:
                    raise HTTPException(400, "Missing id parameter")
                resp = await client.get(
                    f"{GOLF_API_BASE}/clubs/{id}",
                    headers=_api_headers(),
                )
            elif action == "course":
                if not id:
                    raise HTTPException(400, "Missing id parameter")
                resp = await client.get(
                    f"{GOLF_API_BASE}/courses/{id}",
                    headers=_api_headers(),
                )
            elif action == "coordinates":
                if not id:
                    raise HTTPException(400, "Missing id parameter")
                resp = await client.get(
                    f"{GOLF_API_BASE}/coordinates/{id}",
                    headers=_api_headers(),
                )
            else:
                raise HTTPException(400, f"Unknown action: {action}")

        if not resp.is_success:
            raise HTTPException(resp.status_code, f"GolfAPI error: {resp.status_code}")

        cache_time = 3600 if action == "search" else 86400
        return JSONResponse(
            content=resp.json(),
            headers={"Cache-Control": f"public, max-age={cache_time}"},
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Golf API request failed: {e}")
