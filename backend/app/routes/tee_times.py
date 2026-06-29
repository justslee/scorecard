"""
Tee-time API routes.

GET  /api/tee-times/search  — availability search (provider-backed)
POST /api/tee-times/book    — book a slot (provider-backed; Phase 1 = mock)

The active provider is chosen by the TEETIME_PROVIDER env var (default: "mock").
When a real provider (Chronogolf, GolfNow) has credentials configured, set
TEETIME_PROVIDER=chronogolf or TEETIME_PROVIDER=golfnow and the routes are
unchanged — only the service module needs to change.

TODO(Phase 2): import ChronogolfProvider, wire when CHRONOGOLF_API_KEY is set.
TODO(Phase 3): import GolfNowProvider, wire when GOLFNOW_API_KEY is set.
"""

from __future__ import annotations

import os
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.services.tee_times.base import (
    BookingDetails as SvcBookingDetails,
    BookingResult as SvcBookingResult,
    TeeTimeQuery as SvcQuery,
    TeeTimeSlot as SvcSlot,
    TeeTimeProvider,
)
from app.services.tee_times.mock import MockTeeTimeProvider


router = APIRouter(prefix="/api/tee-times", tags=["tee-times"])


# ─── Provider selection ────────────────────────────────────────────────────────

def _get_provider() -> TeeTimeProvider:
    """
    Return the active provider based on TEETIME_PROVIDER env var.
    Falls back to MockTeeTimeProvider when the env is unset or unknown.

    This is the injection point for real providers:
      TEETIME_PROVIDER=chronogolf → ChronogolfProvider (Phase 2)
      TEETIME_PROVIDER=golfnow   → GolfNowProvider    (Phase 3)
    """
    provider_name = os.getenv("TEETIME_PROVIDER", "mock")
    # TODO(Phase 2): if provider_name == "chronogolf": return ChronogolfProvider()
    # TODO(Phase 3): if provider_name == "golfnow":    return GolfNowProvider()
    del provider_name  # only mock available in Phase 1
    return MockTeeTimeProvider()


# ─── Response models ───────────────────────────────────────────────────────────

class TeeTimeSlotOut(BaseModel):
    id: str
    courseId: str
    courseName: str
    city: str
    date: str
    time: str
    players: int
    priceUsd: float
    cartIncluded: bool
    distanceMiles: float
    rating: float
    designer: str | None
    bookingUrl: str | None
    provider: str
    holes: Literal[9, 18]

    @classmethod
    def from_svc(cls, s: SvcSlot) -> "TeeTimeSlotOut":
        return cls(
            id=s.id,
            courseId=s.course_id,
            courseName=s.course_name,
            city=s.city,
            date=s.date,
            time=s.time,
            players=s.players,
            priceUsd=s.price_usd,
            cartIncluded=s.cart_included,
            distanceMiles=s.distance_miles,
            rating=s.rating,
            designer=s.designer,
            bookingUrl=s.booking_url,
            provider=s.provider,
            holes=s.holes,
        )


class SearchResponse(BaseModel):
    query: dict[str, Any]
    results: list[TeeTimeSlotOut]
    provider: str
    cached: bool = False


class BookingResultOut(BaseModel):
    status: str
    confirmationNumber: str | None
    message: str | None
    bookingUrl: str | None


class BookRequest(BaseModel):
    slot: dict[str, Any]
    details: dict[str, Any]


class BookResponse(BaseModel):
    slotId: str
    result: BookingResultOut


# ─── Routes ───────────────────────────────────────────────────────────────────

@router.get("/search", response_model=SearchResponse)
async def search_tee_times(
    date: str = Query(..., description="ISO date YYYY-MM-DD"),
    timeWindowStart: str = Query(..., description="Start of window HH:MM 24h"),
    timeWindowEnd: str = Query(..., description="End of window HH:MM 24h"),
    partySize: int = Query(..., ge=1, le=4, description="Number of players"),
    area: str | None = Query(None, description="Free-text city / area"),
    courseIds: str | None = Query(None, description="Comma-separated course IDs"),
    maxDistanceMiles: float | None = Query(None, description="Max drive distance in miles"),
    maxPriceUsd: float | None = Query(None, description="Price ceiling in USD"),
):
    """Return available tee times matching the search parameters."""
    query = SvcQuery(
        date=date,
        time_window_start=timeWindowStart,
        time_window_end=timeWindowEnd,
        party_size=partySize,
        area=area,
        course_ids=[c.strip() for c in courseIds.split(",")] if courseIds else [],
        max_distance_miles=maxDistanceMiles,
        max_price_usd=maxPriceUsd,
    )

    provider = _get_provider()
    try:
        slots = await provider.search_availability(query)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Provider error: {exc}") from exc

    return SearchResponse(
        query={
            "date": date,
            "timeWindowStart": timeWindowStart,
            "timeWindowEnd": timeWindowEnd,
            "partySize": partySize,
            "area": area,
            "courseIds": courseIds,
        },
        results=[TeeTimeSlotOut.from_svc(s) for s in slots],
        provider=provider.name,
        cached=False,
    )


@router.post("/book", response_model=BookResponse)
async def book_tee_time(req: BookRequest):
    """
    Attempt to book the given slot.

    Phase 1 (mock provider) always returns status="confirmed" with a mock
    confirmation number.  Real providers (Phase 2+) complete the booking via
    their API and return the live confirmation.
    """
    slot_data = req.slot
    details_data = req.details

    # Re-hydrate the slot from the request body.
    try:
        slot = SvcSlot(
            id=slot_data["id"],
            course_id=slot_data["courseId"],
            course_name=slot_data["courseName"],
            city=slot_data["city"],
            date=slot_data["date"],
            time=slot_data["time"],
            players=int(slot_data["players"]),
            price_usd=float(slot_data["priceUsd"]),
            cart_included=bool(slot_data["cartIncluded"]),
            distance_miles=float(slot_data["distanceMiles"]),
            rating=float(slot_data["rating"]),
            provider=slot_data["provider"],
            holes=int(slot_data["holes"]),  # type: ignore[arg-type]
            designer=slot_data.get("designer"),
            booking_url=slot_data.get("bookingUrl"),
        )
        details = SvcBookingDetails(
            name=details_data["name"],
            party_size=int(details_data["partySize"]),
            email=details_data.get("email"),
            phone=details_data.get("phone"),
        )
    except (KeyError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid slot/details: {exc}") from exc

    provider = _get_provider()
    try:
        result: SvcBookingResult = await provider.book(slot, details)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Provider error: {exc}") from exc

    return BookResponse(
        slotId=slot.id,
        result=BookingResultOut(
            status=result.status,
            confirmationNumber=result.confirmation_number,
            message=result.message,
            bookingUrl=result.booking_url,
        ),
    )
