"""
Tee-time API routes.

GET  /api/tee-times/search   — availability search (provider-backed, TTL-cached)
POST /api/tee-times/book     — book a slot (provider-backed; attempt persisted)
GET  /api/tee-times/bookings — the owner's booking attempts, newest first

The active provider is chosen by the TEETIME_PROVIDER env var (default: "mock").
  TEETIME_PROVIDER=affiliate → AffiliateLinkProvider (real courses, estimated
    windows, booking handed to the course site — Phase 1b)
When a real inventory provider (Chronogolf, GolfNow) has credentials configured,
set TEETIME_PROVIDER accordingly — only the service module needs to change.

TODO(Phase 2): import ChronogolfProvider, wire when CHRONOGOLF_API_KEY is set.
TODO(Phase 3): import GolfNowProvider, wire when GOLFNOW_API_KEY is set.
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.db.engine import async_session
from app.db.models import TeeTimeBooking as TeeTimeBookingORM
from app.services.clerk_auth import current_user_id
from app.services.tee_times.affiliate import AffiliateLinkProvider
from app.services.tee_times.base import (
    BookingDetails as SvcBookingDetails,
    BookingResult as SvcBookingResult,
    TeeTimeQuery as SvcQuery,
    TeeTimeSlot as SvcSlot,
    TeeTimeProvider,
)
from app.services.tee_times.mock import MockTeeTimeProvider
from app.services.tee_times.search_cache import (
    FileSearchCacheStore,
    SearchCacheStore,
    query_cache_key,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tee-times", tags=["tee-times"])


# ─── Provider selection ────────────────────────────────────────────────────────

def _get_provider() -> TeeTimeProvider:
    """
    Return the active provider based on TEETIME_PROVIDER env var.
    Falls back to MockTeeTimeProvider when the env is unset or unknown.

    This is the injection point for real providers:
      TEETIME_PROVIDER=affiliate  → AffiliateLinkProvider (Phase 1b)
      TEETIME_PROVIDER=chronogolf → ChronogolfProvider    (Phase 2)
      TEETIME_PROVIDER=golfnow    → GolfNowProvider       (Phase 3)
    """
    provider_name = os.getenv("TEETIME_PROVIDER", "mock")
    if provider_name == "affiliate":
        return AffiliateLinkProvider()
    # TODO(Phase 2): if provider_name == "chronogolf": return ChronogolfProvider()
    # TODO(Phase 3): if provider_name == "golfnow":    return GolfNowProvider()
    return MockTeeTimeProvider()


# ─── Search cache (15-min TTL; protects the Places/Overpass quota) ────────────
# Module-level so tests can swap in a fake store (injectable-store pattern,
# same idea as services/golfapi_cache.py).

_search_cache: SearchCacheStore = FileSearchCacheStore()


# ─── Response models ───────────────────────────────────────────────────────────

class TeeTimeSlotOut(BaseModel):
    id: str
    courseId: str
    courseName: str
    city: str
    date: str
    time: str
    players: int
    priceUsd: float | None
    cartIncluded: bool
    distanceMiles: float
    rating: float
    designer: str | None
    bookingUrl: str | None
    provider: str
    holes: Literal[9, 18]
    # True when `time` is the requested window start, not verified live
    # availability (affiliate provider) — the UI renders these as "~" estimates.
    estimated: bool = False

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
            estimated=s.estimated,
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


class TeeTimeBookingOut(BaseModel):
    id: str
    ownerId: str
    slotId: str
    courseId: str
    courseName: str
    date: str
    time: str
    partySize: int
    priceUsd: float | None
    status: str
    bookingUrl: str | None
    provider: str
    confirmationCode: str | None
    createdAt: str

    @classmethod
    def from_orm_row(cls, row: TeeTimeBookingORM) -> "TeeTimeBookingOut":
        return cls(
            id=str(row.id),
            ownerId=str(row.owner_id),
            slotId=str(row.slot_id),
            courseId=str(row.course_id),
            courseName=str(row.course_name),
            date=str(row.slot_date),
            time=str(row.slot_time),
            partySize=int(row.party_size),
            priceUsd=float(row.price_usd) if row.price_usd is not None else None,
            status=str(row.status),
            bookingUrl=row.booking_url,
            provider=str(row.provider),
            confirmationCode=row.confirmation_code,
            createdAt=row.created_at.isoformat() if row.created_at else "",
        )


# ─── Routes ───────────────────────────────────────────────────────────────────

@router.get("/search", response_model=SearchResponse)
async def search_tee_times(
    date: str = Query(..., description="ISO date YYYY-MM-DD"),
    timeWindowStart: str = Query(..., description="Start of window HH:MM 24h"),
    timeWindowEnd: str = Query(..., description="End of window HH:MM 24h"),
    partySize: int = Query(..., ge=1, le=4, description="Number of players"),
    area: str | None = Query(None, description="Free-text city / area, or 'lat,lng'"),
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
    echo_query = {
        "date": date,
        "timeWindowStart": timeWindowStart,
        "timeWindowEnd": timeWindowEnd,
        "partySize": partySize,
        "area": area,
        "courseIds": courseIds,
    }

    provider = _get_provider()

    # 15-min TTL cache — identical searches must not re-hit Places/Overpass.
    cache_key = query_cache_key(provider.name, query)
    cached_results = _search_cache.get(cache_key)
    if cached_results is not None:
        return SearchResponse(
            query=echo_query,
            results=[TeeTimeSlotOut(**r) for r in cached_results],
            provider=provider.name,
            cached=True,
        )

    try:
        slots = await provider.search_availability(query)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Provider error: {exc}") from exc

    results = [TeeTimeSlotOut.from_svc(s) for s in slots]
    _search_cache.set(cache_key, [r.model_dump() for r in results])

    return SearchResponse(
        query=echo_query,
        results=results,
        provider=provider.name,
        cached=False,
    )


@router.post("/book", response_model=BookResponse)
async def book_tee_time(req: BookRequest, owner_id: str = Depends(current_user_id)):
    """
    Attempt to book the given slot.

    Mock provider returns status="confirmed" with a mock confirmation number;
    the affiliate provider returns "needs_human" + the course's booking URL.
    Every attempt — including needs_human handoffs — is persisted so the owner
    has a record of what was (or still needs to be) booked.
    """
    slot_data = req.slot
    details_data = req.details

    # Re-hydrate the slot from the request body.
    try:
        price = slot_data.get("priceUsd")
        slot = SvcSlot(
            id=slot_data["id"],
            course_id=slot_data["courseId"],
            course_name=slot_data["courseName"],
            city=slot_data["city"],
            date=slot_data["date"],
            time=slot_data["time"],
            players=int(slot_data["players"]),
            price_usd=float(price) if price is not None else None,
            cart_included=bool(slot_data["cartIncluded"]),
            distance_miles=float(slot_data["distanceMiles"]),
            rating=float(slot_data["rating"]),
            provider=slot_data["provider"],
            holes=int(slot_data["holes"]),  # type: ignore[arg-type]
            designer=slot_data.get("designer"),
            booking_url=slot_data.get("bookingUrl"),
            estimated=bool(slot_data.get("estimated", False)),
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

    # Persist the attempt (best-effort: the provider already answered, so a
    # storage hiccup must not turn a successful handoff into a 5xx).
    try:
        row = TeeTimeBookingORM(
            id=str(uuid.uuid4()),
            owner_id=owner_id,
            slot_id=slot.id,
            course_id=slot.course_id,
            course_name=slot.course_name,
            slot_date=slot.date,
            slot_time=slot.time,
            party_size=details.party_size,
            price_usd=slot.price_usd,
            status=result.status,
            booking_url=result.booking_url or slot.booking_url,
            provider=slot.provider,
            confirmation_code=result.confirmation_number,
        )
        async with async_session() as db:
            db.add(row)
            await db.commit()
    except Exception:
        log.exception("tee_times: failed to persist booking attempt slot=%s", slot.id)

    return BookResponse(
        slotId=slot.id,
        result=BookingResultOut(
            status=result.status,
            confirmationNumber=result.confirmation_number,
            message=result.message,
            bookingUrl=result.booking_url,
        ),
    )


@router.get("/bookings", response_model=list[TeeTimeBookingOut])
async def list_bookings(owner_id: str = Depends(current_user_id)):
    """List the calling owner's booking attempts, newest first."""
    async with async_session() as db:
        result = await db.execute(
            select(TeeTimeBookingORM)
            .where(TeeTimeBookingORM.owner_id == owner_id)
            .order_by(TeeTimeBookingORM.created_at.desc())
        )
        return [TeeTimeBookingOut.from_orm_row(r) for r in result.scalars().all()]
