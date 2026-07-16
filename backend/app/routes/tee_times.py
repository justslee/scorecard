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

import asyncio
import logging
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.db.engine import async_session
from app.db.models import GolferProfile as GolferProfileORM
from app.db.models import TeeTimeBooking as TeeTimeBookingORM
from app.services.clerk_auth import current_user_id, require_owner
from app.services.tee_times.availability_call_cache import (
    AvailabilityCallCacheStore,
    AvailabilityCallRecord,
    FileAvailabilityCallCacheStore,
    SpokenSlotRecord,
    availability_cache_key,
)
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
from app.services.voice_booking import telephony
from app.services.voice_booking.caller_voice import (
    ALLOWED_CALLER_VOICES,
    PICKER_VOICES,
    resolve_caller_voice,
)
from app.services.voice_booking.compliance import (
    SuppressionList,
    check_call_allowed,
    disclosure_line,
    normalize_phone,
)
from app.services.voice_booking.outcome import to_booking_result
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
    # S4e (specs/teetime-availability-everywhere-plan.md §6): "live" (default,
    # unchanged) or "pending" (rung-2b in-flight scrape — reserved, S4d).
    status: Literal["live", "pending"] = "live"
    # Provenance for a phone-confirmed slot (provider=="voice_call"): which
    # channel verified this and when. See base.TeeTimeSlot.
    checkedVia: str | None = None
    checkedAt: str | None = None

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
            status=s.status,
            checkedVia=s.checked_via,
            checkedAt=s.checked_at,
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
            status=slot_data.get("status", "live"),
            checked_via=slot_data.get("checkedVia"),
            checked_at=slot_data.get("checkedAt"),
        )
        details = SvcBookingDetails(
            name=details_data["name"],
            party_size=int(details_data["partySize"]),
            email=details_data.get("email"),
            phone=details_data.get("phone"),
            # The golfer's requested search window — lets the AI-call route ask
            # the pro shop for a time when the routed slot itself carries none.
            time_window_start=details_data.get("timeWindowStart"),
            time_window_end=details_data.get("timeWindowEnd"),
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


# ─── Owner rehearsal call — the "call me, I'll be the pro shop" harness ────────
#
# specs/teetime-rehearsal-call-harness.md + specs/teetime-s3-caller-plan.md.
#
# POST /api/tee-times/rehearsal-call places a LIVE outbound call to the OWNER's
# OWN verified number (allowlist of exactly one, from server config — NEVER a
# request value) and bridges it to the REAL booking agent against a TEST course
# ("Rehearsal Pro Shop"), so the owner can role-play a pro shop and validate the
# script before any real course is ever dialed.
#
# DIAL-SAFETY INVARIANT: this endpoint takes no request body; the dialed number
# and the compliance allowlist both come from VOICE_BOOKING_OWNER_NUMBER alone.
# There is no code path by which a request value becomes a dialed number.
#
# HONEST STATUS: the live Twilio↔OpenAI-Realtime bridge has SHIPPED
# (specs/teetime-s3b-twilio-bridge-plan.md) — telephony.get_live_transport()
# constructs a real LiveCallTransport once VOICE_BOOKING_ENABLED=1, full
# Twilio credentials, AND VOICE_BOOKING_PUBLIC_HOST are all configured. Code
# shipping ≠ the owner turning it on: with any of those unset (the CI/default
# state) the owner still gets a structured "not_enabled" reason and nothing
# dials. Fully configured, pressing rehearsal-call places a REAL outbound call
# to the owner's own verified number.
#
# To actually receive a call the owner sets on the backend (all required):
#   VOICE_BOOKING_ENABLED=1
#   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER
#   VOICE_BOOKING_OWNER_NUMBER=+1XXXXXXXXXX   # his own verified E.164 — the
#                                             # ONLY number this endpoint can dial
#   VOICE_BOOKING_PUBLIC_HOST=api.example.com # public TLS host Twilio's media
#                                             # stream connects back to (wss)
# Optional: VOICE_BOOKING_OWNER_NAME (spoken in the disclosure),
#           VOICE_BOOKING_REHEARSAL_TZ (calling-hours time zone).

# Injectable for tests ONLY (a SimulatedCallTransport) — None means the real,
# owner-gated telephony.get_live_transport(). Production NEVER sets this, so the
# sole live-dial gate remains telephony.get_live_transport().
_rehearsal_transport_factory: Callable[[], Any] | None = None
# Injectable clock for the compliance calling-hours gate — None means "real
# now()" (production). Tests set a fixed within-hours datetime for determinism,
# so the suite doesn't flake when it happens to run outside 8am–9pm ET (same
# pattern as `_availability_call_now_override`). Production NEVER sets this.
_rehearsal_call_now_override: datetime | None = None

_REHEARSAL_COURSE_NAME = "Rehearsal Pro Shop"


class RehearsalCallResponse(BaseModel):
    # "completed" — the call ran (or was simulated) end to end;
    # "refused"   — a compliance gate blocked it before any dial;
    # "not_enabled" — live calling is disabled / the bridge isn't shipped yet.
    status: Literal["completed", "refused", "not_enabled"]
    reason: str | None = None            # gate/compliance/gating text when not "completed"
    calleeNumber: str | None = None      # masked (last 4) — which number would ring
    disclosure: str | None = None        # the agent's mandatory first words, previewed
    transcript: list[CallTurnOut] = []
    outcome: CallOutcomeOut | None = None
    result: BookingResultOut | None = None


def _mask_number(e164: str) -> str:
    """"+14155550199" → "+1•••••••0199" (display only; never used to dial)."""
    if len(e164) <= 5:
        return e164
    return e164[:2] + "•" * (len(e164) - 6) + e164[-4:]


def _next_saturday(today: date) -> date:
    """The next Saturday strictly after `today` (weekday() == 5)."""
    days_ahead = (5 - today.weekday()) % 7
    if days_ahead == 0:
        days_ahead = 7
    return today + timedelta(days=days_ahead)


def _build_rehearsal_context(
    owner_number: str,
    owner_name: str,
    tz: str,
    today: date | None = None,
    caller_voice: str | None = None,
) -> VoiceBookingContext:
    """Build the TEST booking context for a rehearsal call. Pure given `today`.

    The callee, the disclosure's callback number, and the compliance allowlist
    are all the owner's own number — a self-call. A concrete sample ask
    (next Saturday morning, 1 player, 7–11am) gives the agent something real
    to say and role-play against.

    `caller_voice`: the owner's saved caller-voice pick (or None), fed through
    to ctx.caller_voice so a rehearsal call audibly reflects the picker
    (routes/tee_times.py's caller-voice endpoints) — resolved to an actual
    Realtime voice name by caller_voice.resolve_caller_voice() in the bridge.
    """
    when = _next_saturday(today or date.today())
    return VoiceBookingContext(
        course_id="rehearsal",
        course_name=_REHEARSAL_COURSE_NAME,
        phone=owner_number,
        golfer_name=owner_name,
        callback_number=owner_number,
        date=when.isoformat(),
        time_window_start="07:00",
        time_window_end="11:00",
        party_size=1,
        max_price_usd=None,
        course_tz=tz,
        caller_voice=caller_voice,
    )


@router.post("/rehearsal-call", response_model=RehearsalCallResponse)
async def rehearsal_call(owner_id: str = Depends(require_owner)) -> RehearsalCallResponse:
    """Place a rehearsal booking call to the OWNER's own verified number.

    Owner-only (router-level require_owner + the explicit dependency here). Takes
    NO request body — the dialed number is exclusively VOICE_BOOKING_OWNER_NUMBER
    (see the dial-safety invariant above). Runs the real compliance gates and
    the real booking dialog; returns the transcript + outcome, or a structured
    reason when a gate blocks it / live calling is not enabled. No audio is ever
    stored (compliance.STORE_AUDIO=False); only the text transcript is logged.
    Suppression is not persisted for a self-call rehearsal.
    """
    owner_number = normalize_phone(os.getenv("VOICE_BOOKING_OWNER_NUMBER"))
    if owner_number is None:
        raise HTTPException(
            status_code=503,
            detail="Rehearsal calling is not configured: set "
            "VOICE_BOOKING_OWNER_NUMBER to the owner's E.164 number.",
        )

    owner_name = os.getenv("VOICE_BOOKING_OWNER_NAME") or "the Looper owner"
    tz = os.getenv("VOICE_BOOKING_REHEARSAL_TZ") or "America/New_York"

    # Feed the owner's saved caller-voice pick through so a rehearsal call
    # audibly reflects the picker (GET/PUT /api/tee-times/caller-voice).
    # Best-effort: a DB hiccup here must not break a working rehearsal call —
    # falls back to None, which resolve_caller_voice() turns into the
    # env/default (same posture as book_tee_time's best-effort persist step).
    saved_caller_voice: str | None = None
    try:
        async with async_session() as db:
            result = await db.execute(
                select(GolferProfileORM).where(GolferProfileORM.user_id == owner_id)
            )
            profile_row = result.scalar_one_or_none()
        saved_caller_voice = profile_row.caller_voice if profile_row else None
    except Exception:
        log.exception("rehearsal-call: failed to read saved caller_voice for owner=%s", owner_id)

    ctx = _build_rehearsal_context(
        owner_number, owner_name, tz, caller_voice=saved_caller_voice
    )
    disclosure = disclosure_line(ctx)
    masked = _mask_number(owner_number)

    # Real compliance gates — allowlist is EXACTLY the owner's own number.
    gate = check_call_allowed(
        ctx,
        verified_lines={owner_number},
        suppression=SuppressionList(),
        now=_rehearsal_call_now_override,
    )
    if not gate.allowed:
        return RehearsalCallResponse(
            status="refused",
            reason=gate.reason,
            calleeNumber=masked,
            disclosure=disclosure,
        )

    # Obtain the call transport. The ONLY production source is the owner-gated
    # telephony.get_live_transport(); tests inject a SimulatedCallTransport via
    # _rehearsal_transport_factory. A disabled gate / unshipped bridge surfaces
    # as an honest "not_enabled" reason, never a 5xx.
    factory = _rehearsal_transport_factory or telephony.get_live_transport
    try:
        transport = factory()
    except (RuntimeError, NotImplementedError) as exc:
        return RehearsalCallResponse(
            status="not_enabled",
            reason=str(exc),
            calleeNumber=masked,
            disclosure=disclosure,
        )

    transcript, outcome = await transport.run_call(ctx)
    for turn in transcript:                      # text-only log; no audio ever
        log.info("rehearsal-call [%s] %s", turn.speaker, turn.text)
    result = to_booking_result(outcome, ctx)

    return RehearsalCallResponse(
        status="completed",
        calleeNumber=masked,
        disclosure=disclosure,
        transcript=[CallTurnOut(speaker=t.speaker, text=t.text) for t in transcript],
        outcome=CallOutcomeOut(
            result=outcome.result,
            date=outcome.date,
            time=outcome.time,
            partySize=outcome.party_size,
            confirmationNumber=outcome.confirmation_number,
            costUsd=outcome.cost_usd,
            detail=outcome.detail,
        ),
        result=BookingResultOut(
            status=result.status,
            confirmationNumber=result.confirmation_number,
            message=result.message,
            bookingUrl=result.booking_url,
        ),
    )


# ─── Caller voice picker — Option B (specs/voice-clone-caller-plan.md §2B/§3) ──
#
# No voice CLONING on the OpenAI Realtime live-call path (no custom voices);
# instead the owner picks the best natural PRESET voice from a calm subset,
# persisted on their golfer_profiles row. Owner-gated (require_owner) — this
# is a single-owner preference, not a per-golfer setting. Values are always
# validated against ALLOWED_CALLER_VOICES; an arbitrary string is never stored
# or passed to the Realtime API.

class CallerVoiceOptionOut(BaseModel):
    voice: str
    label: str


class CallerVoiceResponse(BaseModel):
    # The RESOLVED voice a call would use right now (owner-pref → env →
    # default — see caller_voice.resolve_caller_voice).
    voice: str
    # The raw saved preference, or null if the owner never set one.
    saved: str | None
    options: list[CallerVoiceOptionOut]


class CallerVoiceUpdateRequest(BaseModel):
    voice: str


def _caller_voice_options() -> list[CallerVoiceOptionOut]:
    return [CallerVoiceOptionOut(voice=v["voice"], label=v["label"]) for v in PICKER_VOICES]


@router.get("/caller-voice", response_model=CallerVoiceResponse)
async def get_caller_voice(owner_id: str = Depends(require_owner)) -> CallerVoiceResponse:
    """Return the owner's saved caller-voice pick + the resolved effective
    voice + the picker options. No row / null column → saved=null, voice
    resolves to the env/default (same precedence the live call uses)."""
    async with async_session() as db:
        result = await db.execute(
            select(GolferProfileORM).where(GolferProfileORM.user_id == owner_id)
        )
        row = result.scalar_one_or_none()

    saved = row.caller_voice if row else None
    return CallerVoiceResponse(
        voice=resolve_caller_voice(saved),
        saved=saved,
        options=_caller_voice_options(),
    )


@router.put("/caller-voice", response_model=CallerVoiceResponse)
async def set_caller_voice(
    req: CallerVoiceUpdateRequest, owner_id: str = Depends(require_owner)
) -> CallerVoiceResponse:
    """Persist the owner's caller-voice pick. Rejects anything outside
    ALLOWED_CALLER_VOICES with 422 — never stores/passes an arbitrary string."""
    if req.voice not in ALLOWED_CALLER_VOICES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown voice '{req.voice}' — expected one of {sorted(ALLOWED_CALLER_VOICES)}",
        )

    async with async_session() as db:
        result = await db.execute(
            select(GolferProfileORM).where(GolferProfileORM.user_id == owner_id)
        )
        row = result.scalar_one_or_none()

        if row is None:
            # Minimal upsert row — mirrors routes/profile.py's PUT create path.
            row = GolferProfileORM(
                id=str(uuid.uuid4()),
                user_id=owner_id,
                owner_id=owner_id,
                caller_voice=req.voice,
            )
            db.add(row)
        else:
            row.caller_voice = req.voice
            row.updated_at = datetime.now(timezone.utc)

        await db.commit()

    # req.voice is already allowlist-validated above — no need to re-read the
    # (possibly expired-on-commit) ORM attribute.
    return CallerVoiceResponse(
        voice=resolve_caller_voice(req.voice),
        saved=req.voice,
        options=_caller_voice_options(),
    )


# ─── Availability-by-call — S4e rung 3 (specs/teetime-availability-everywhere ──
# -plan.md §5, §6): the user-initiated "call the pro shop and ASK what they
# have" trigger. NEVER placed as a side effect of search — only a tap on the
# "No online times — we can call the pro shop" CTA reaches this endpoint.
#
# POST /api/tee-times/availability-call — enqueue an ask-mode call.
# GET  /api/tee-times/availability-call/{id} — poll its status.
#
# DIAL-SAFETY: exactly the rehearsal-call posture. The transport comes from
# `telephony.get_live_transport()` (VOICE_BOOKING_ENABLED + full Twilio
# credentials + VOICE_BOOKING_PUBLIC_HOST) — unset in CI/default, so this
# raises and the endpoint returns an honest "not_enabled" status with NOTHING
# enqueued and NOTHING dialed. Even once the transport is live, the number is
# still gated by `check_call_allowed` against the owner-verified-lines
# allowlist (VOICE_BOOKING_VERIFIED_LINES — empty by default, so every course
# number is refused until the owner explicitly verifies it). A request value
# can influence WHICH course's known number is dialed (that's the point — the
# golfer picked a result), but it can never bypass the allowlist: an
# unverified number is refused before any transport call, same as book().
#
# The call itself is awaited inside a background task created here (never
# inside the request handler) so POST returns immediately with a job id +
# status="pending"; the frontend polls GET until "completed" (or, in the
# same request, "not_enabled" when dark/refused).

_availability_jobs: dict[str, dict[str, Any]] = {}
_availability_cache_store: AvailabilityCallCacheStore = FileAvailabilityCallCacheStore()

# Injectable for tests ONLY (a SimulatedCallTransport) — same pattern as
# `_rehearsal_transport_factory`. None means the real, owner-gated
# telephony.get_live_transport(). Production NEVER sets this.
_availability_call_transport_factory: Callable[[], Any] | None = None
# Injectable clock for the compliance calling-hours gate — None means "real
# now()" (production). Tests set a fixed datetime for determinism.
_availability_call_now_override: datetime | None = None


def _voice_booking_verified_lines() -> set[str]:
    """Owner-verified pro-shop landlines allowed to be dialed for an
    availability-ask call (VOICE_BOOKING_VERIFIED_LINES, comma-separated).
    Empty by default — every number is refused until the owner explicitly
    verifies it (same posture as VoiceCallProvider's default allowlist)."""
    raw = os.getenv("VOICE_BOOKING_VERIFIED_LINES", "")
    return {n.strip() for n in raw.split(",") if n.strip()}


class AvailabilityCallRequest(BaseModel):
    courseId: str
    courseName: str
    phone: str | None = None
    date: str                        # YYYY-MM-DD
    timeWindowStart: str             # "HH:MM" 24h — the golfer's REQUESTED window
    timeWindowEnd: str
    partySize: int
    # The golfer's own name/callback — spoken in the mandatory AI disclosure
    # ("calling on behalf of <golferName>... reach them at <callbackNumber>").
    # Falls back to the owner's configured identity when unset (matches the
    # rehearsal-call demo posture) — but a real callback number is required
    # by the compliance gate either way; no number -> refused before any dial.
    golferName: str | None = None
    callbackNumber: str | None = None


class SpokenSlotOut(BaseModel):
    time: str
    priceUsd: float | None = None


class AvailabilityCallStatusOut(BaseModel):
    id: str
    # "pending" — the call is in flight; "completed" — it resolved (see
    # outcome/slotsSpoken); "not_enabled" — live calling is disabled/
    # unconfigured, OR the compliance gate refused the number. Nothing was
    # dialed in the "not_enabled" case.
    status: Literal["pending", "completed", "not_enabled"]
    reason: str | None = None
    outcome: str | None = None       # CallOutcome.result once completed
    slotsSpoken: list[SpokenSlotOut] = []
    calledAt: str | None = None


async def _run_availability_call(job_id: str, transport: Any, ctx: VoiceBookingContext) -> None:
    """Runs the ask-mode call against `transport`, stores the terminal status
    for GET to read, and writes the availability_by_call cache record (plan
    §5) so the NEXT search renders these times without re-dialing. Never
    raises out to the caller — a transport failure resolves to an honest
    "unclear" status rather than leaving the job stuck at "pending" forever."""
    try:
        transcript, outcome = await transport.run_call(ctx)
    except Exception:
        log.exception("availability-call: transport raised for job=%s", job_id)
        _availability_jobs[job_id] = {
            "status": "completed", "outcome": "unclear",
            "reason": "the call failed unexpectedly", "slotsSpoken": [], "calledAt": None,
        }
        return

    for turn in transcript:                      # text-only log; no audio ever
        log.info("availability-call [%s] %s", turn.speaker, turn.text)

    called_at = datetime.now(timezone.utc).isoformat()
    slots_out = [
        {"time": s.time, "priceUsd": s.price_usd} for s in outcome.slots_spoken
    ]
    record = AvailabilityCallRecord(
        course_id=ctx.course_id,
        course_name=ctx.course_name,
        date=ctx.date,
        window_start=ctx.time_window_start,
        window_end=ctx.time_window_end,
        party_size=ctx.party_size,
        outcome=outcome.result,          # type: ignore[arg-type]
        slots_spoken=tuple(
            SpokenSlotRecord(time=s.time, price_usd=s.price_usd) for s in outcome.slots_spoken
        ),
        transcript_ref=job_id,
        called_at=called_at,
    )
    key = availability_cache_key(
        ctx.course_id, ctx.date, ctx.time_window_start, ctx.time_window_end, ctx.party_size,
    )
    try:
        _availability_cache_store.set(key, record)
    except Exception:
        log.exception("availability-call: cache write failed for job=%s", job_id)

    _availability_jobs[job_id] = {
        "status": "completed", "outcome": outcome.result,
        "slotsSpoken": slots_out, "calledAt": called_at,
    }


@router.post("/availability-call", response_model=AvailabilityCallStatusOut)
async def request_availability_call(
    req: AvailabilityCallRequest, _owner_id: str = Depends(require_owner)
) -> AvailabilityCallStatusOut:
    """User-initiated ONLY — a search never reaches this endpoint. Ships dark:
    with no Twilio keys / VOICE_BOOKING_ENABLED (the CI/default state) this
    returns status="not_enabled" immediately and enqueues nothing.

    CARVE-OUT (multi-user P0 slice 1): owner-only even after the require_member
    flip — this places a real outbound Twilio call that can speak the OWNER's
    VOICE_BOOKING_OWNER_NUMBER (see the dial-safety invariant above). The
    per-user-callback genericization needed to open this to every member is a
    later slice.
    """
    factory = _availability_call_transport_factory or telephony.get_live_transport
    try:
        transport = factory()
    except (RuntimeError, NotImplementedError) as exc:
        return AvailabilityCallStatusOut(id="", status="not_enabled", reason=str(exc))

    ctx = VoiceBookingContext(
        course_id=req.courseId,
        course_name=req.courseName,
        phone=req.phone,
        golfer_name=req.golferName or os.getenv("VOICE_BOOKING_OWNER_NAME") or "the golfer",
        callback_number=(
            req.callbackNumber or os.getenv("VOICE_BOOKING_OWNER_NUMBER") or ""
        ),
        date=req.date,
        time_window_start=req.timeWindowStart,
        time_window_end=req.timeWindowEnd,
        party_size=req.partySize,
        mode="availability",
    )

    # Reuse the SAME compliance gates as every other outbound call (dial-
    # safety invariant): a request value (course phone, window, party) can
    # never itself become a dial — the number must ALSO be on the
    # owner-verified-lines allowlist (empty by default -> refused).
    gate = check_call_allowed(
        ctx,
        verified_lines=_voice_booking_verified_lines(),
        suppression=SuppressionList(),
        now=_availability_call_now_override,
    )
    if not gate.allowed:
        return AvailabilityCallStatusOut(id="", status="not_enabled", reason=gate.reason)

    job_id = str(uuid.uuid4())
    _availability_jobs[job_id] = {"status": "pending"}
    # `_task` is a private bookkeeping key (never surfaced in the response
    # model) — tests await it directly for determinism instead of polling.
    _availability_jobs[job_id]["_task"] = asyncio.ensure_future(
        _run_availability_call(job_id, transport, ctx)
    )
    return AvailabilityCallStatusOut(id=job_id, status="pending")


@router.get("/availability-call/{job_id}", response_model=AvailabilityCallStatusOut)
async def get_availability_call(
    job_id: str, _owner_id: str = Depends(current_user_id)
) -> AvailabilityCallStatusOut:
    job = _availability_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown availability-call job")
    return AvailabilityCallStatusOut(
        id=job_id,
        status=job["status"],
        reason=job.get("reason"),
        outcome=job.get("outcome"),
        slotsSpoken=[SpokenSlotOut(**s) for s in job.get("slotsSpoken", [])],
        calledAt=job.get("calledAt"),
    )
