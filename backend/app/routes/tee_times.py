"""
Tee-time API routes.

GET  /api/tee-times/search   — availability search (provider-backed, TTL-cached)
POST /api/tee-times/book     — book a slot (provider-backed; attempt persisted)
GET  /api/tee-times/bookings — the owner's booking attempts, newest first
POST /api/tee-times/book-by-call/simulate — run the voice booking agent against
     a scripted pro-shop persona (dev/QA surface; NO real call is ever placed)

The active provider is chosen by the TEETIME_PROVIDER env var (default:
"routing" — real nearby courses, foreUP-real availability where a booking
capability is known (specs/teetime-s1-foreup-plan.md), S0 "no fabricated
time, booking routed to the course site or a phone call" otherwise
(specs/teetime-s0-plan.md)). TEETIME_FOREUP_ENABLED=0 reverts the whole
surface to exact S0 behavior (kill switch). TEETIME_PROVIDER=mock is explicit
opt-in (dev/tests only); "affiliate" is accepted as a legacy alias for
"routing". ANY other/unknown value also lands on the router — never mock —
so a prod env-var typo can never silently serve demo data.
TEETIME_PROVIDER=foreup runs foreUP standalone (debug only — real nearby
courses with a known capability, no S0 fallback for the rest).
When a real inventory provider (Chronogolf, GolfNow) has credentials configured,
set TEETIME_PROVIDER accordingly — only the service module needs to change.

Route-level cache note: the 15-min `_search_cache` below sits ABOVE foreUP's
own 8-min availability cache (foreup.py), so end-to-end staleness of a real
slot is bounded by 15 min; the booking deep-link always shows live truth on
the course's own site. Do not change this route's TTL in the S1 slice — it
also guards the Places/Overpass quota.

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
from app.services.tee_times.foreup import ForeUpProvider
from app.services.tee_times.router_provider import RoutedTeeTimeProvider
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
from app.services.tee_times.selection import resolve_selectors
from app.services.voice_booking.simulator import (
    PERSONA_NAMES,
    default_context,
    run_simulation,
)
from app.services.voice_booking.types import VoiceBookingContext

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tee-times", tags=["tee-times"])


# ─── Provider selection ────────────────────────────────────────────────────────

def _get_provider() -> TeeTimeProvider:
    """
    Return the active provider based on TEETIME_PROVIDER env var.

    Default is the ROUTER (specs/teetime-s1-foreup-plan.md) — real nearby
    courses, real foreUP availability where a booking capability is known,
    S0 "no fabricated time, booking routed to the course site or a phone
    call" for every other course (specs/teetime-s0-plan.md, "kill fake
    data"). TEETIME_FOREUP_ENABLED=0 reverts the whole surface to exact S0
    behavior. TEETIME_PROVIDER=mock is explicit opt-in (dev/tests only).
    "affiliate" is accepted as a legacy alias for "routing" so a prod env
    still carrying TEETIME_PROVIDER=affiliate lands on the real path with
    zero env change. Any OTHER/unknown value also falls to the router — never
    mock — so a typo'd env var can never silently serve demo data.
    TEETIME_PROVIDER=foreup runs foreUP standalone (debug only).

    This is the injection point for real providers:
      TEETIME_PROVIDER=chronogolf → ChronogolfProvider    (Phase 2)
      TEETIME_PROVIDER=golfnow    → GolfNowProvider       (Phase 3)
    """
    provider_name = os.getenv("TEETIME_PROVIDER", "routing")
    if provider_name == "mock":
        return MockTeeTimeProvider()  # dev/tests only — explicit opt-in
    if provider_name == "foreup":
        return ForeUpProvider()  # standalone debug mode — no S0 fallback
    # TODO(Phase 2): if provider_name == "chronogolf": return ChronogolfProvider()
    # TODO(Phase 3): if provider_name == "golfnow":    return GolfNowProvider()
    if provider_name not in ("routing", "affiliate"):  # "affiliate" = legacy alias
        log.warning("Unknown TEETIME_PROVIDER=%r — using router", provider_name)
    return RoutedTeeTimeProvider()


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
    # DEPRECATED (S0): no provider sets this True anymore — see base.TeeTimeSlot.
    estimated: bool = False
    # How this entry gets booked: "book_on_site", "call", or None (real
    # bookable availability — mock and foreup today). See base.TeeTimeSlot.
    route: Literal["book_on_site", "call"] | None = None
    # The pro shop's phone number, when known — powers a real `tel:` link on
    # "call"-route entries. See base.TeeTimeSlot.
    phone: str | None = None

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
            route=s.route,
            phone=s.phone,
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
        course_ids=(
            [c for c in (s.strip() for s in courseIds.split(",")) if c] if courseIds else []
        ),
        max_distance_miles=maxDistanceMiles,
        max_price_usd=maxPriceUsd,
    )
    if query.course_ids:
        query.course_selectors = await resolve_selectors(query.course_ids)
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
    the routing provider returns "needs_human" + the course's booking URL
    (or a call instruction when no website is known).
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
            route=slot_data.get("route"),
            phone=slot_data.get("phone"),
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


# ─── Voice booking agent — simulator (dev/QA surface; NO real calls) ──────────

class SimulateCallRequest(BaseModel):
    persona: str = "friendly"        # see PERSONA_NAMES
    courseName: str | None = None    # optional overrides of the demo context
    golferName: str | None = None
    date: str | None = None          # YYYY-MM-DD
    timeWindowStart: str | None = None   # "HH:MM" 24h
    timeWindowEnd: str | None = None
    partySize: int | None = None
    maxPriceUsd: float | None = None


class CallTurnOut(BaseModel):
    speaker: str                     # "agent" | "shop"
    text: str


class CallOutcomeOut(BaseModel):
    result: str
    date: str | None
    time: str | None
    partySize: int | None
    confirmationNumber: str | None
    costUsd: float | None
    detail: str | None


class SimulateCallResponse(BaseModel):
    persona: str
    transcript: list[CallTurnOut]
    outcome: CallOutcomeOut
    result: BookingResultOut


@router.post("/book-by-call/simulate", response_model=SimulateCallResponse)
async def simulate_book_by_call(
    req: SimulateCallRequest, _owner_id: str = Depends(current_user_id)
):
    """
    Run the voice booking agent against a scripted pro-shop persona and return
    the full transcript + structured outcome + BookingResult.

    This is a dev/QA surface: it exercises the SAME dialog / IVR / compliance /
    outcome code the live telephony bridge will use, but never dials anything.
    The real-call route ships only with the owner-gated launch (TCPA review).
    """
    if req.persona not in PERSONA_NAMES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown persona '{req.persona}' — expected one of {PERSONA_NAMES}",
        )

    base = default_context()
    ctx = VoiceBookingContext(
        course_id=base.course_id,
        course_name=req.courseName or base.course_name,
        phone=base.phone,
        golfer_name=req.golferName or base.golfer_name,
        callback_number=base.callback_number,
        date=req.date or base.date,
        time_window_start=req.timeWindowStart or base.time_window_start,
        time_window_end=req.timeWindowEnd or base.time_window_end,
        party_size=req.partySize or base.party_size,
        max_price_usd=req.maxPriceUsd if req.maxPriceUsd is not None else base.max_price_usd,
    )

    sim = run_simulation(req.persona, ctx)
    return SimulateCallResponse(
        persona=sim.persona,
        transcript=[CallTurnOut(speaker=t.speaker, text=t.text) for t in sim.transcript],
        outcome=CallOutcomeOut(
            result=sim.outcome.result,
            date=sim.outcome.date,
            time=sim.outcome.time,
            partySize=sim.outcome.party_size,
            confirmationNumber=sim.outcome.confirmation_number,
            costUsd=sim.outcome.cost_usd,
            detail=sim.outcome.detail,
        ),
        result=BookingResultOut(
            status=sim.booking_result.status,
            confirmationNumber=sim.booking_result.confirmation_number,
            message=sim.booking_result.message,
            bookingUrl=sim.booking_result.booking_url,
        ),
    )
