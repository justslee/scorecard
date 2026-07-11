"""
Quick18Provider — H2 rung-2a Quick18 (now Sagacity Golf) availability
(specs/teetime-headless-scraper-plan.md §6/H2, §1a).

Read-only availability display against a Quick18 course's OWN public,
unauthenticated server-rendered tee-sheet — the same page the course's
`*.quick18.com/teetimes/searchmatrix?teedate=` booking widget serves on every
search. Quick18 is the cheapest rung in the epic: plain HTML, no JS render, no
token dance, no anti-bot wall (LIVE-VERIFIED 2026-07-10, honest UA, no login).

GROUND TRUTH — the parse contract was RE-VERIFIED against real live captures
(NOT taken on faith from the plan draft, whose `a.sexybutton.teebutton = open
slot` hypothesis was correct but incomplete). Captured HTML lives in
`backend/tests/fixtures/quick18_searchmatrix_{times,empty}.html`:

  Request: a single plain `GET {https://<host>/teetimes/searchmatrix?teedate=
  YYYYMMDD}` (the date is DASH-STRIPPED — Quick18 wants `20260714`, not
  `2026-07-14`). Honest UA, no cookies, no login.

  Response: server-rendered HTML. The availability table is
  `<table class="matrixTable">` (there is an EARLIER `matrixTable` token inside
  a `<script>` — we bind only to the real `<table>` element). Structure:
    - `thead > th.matrixHdrSched` are the rate/schedule columns, in order, e.g.
      "18 Holes", "18 Holes with Cart", "9 Holes", "9 Holes with Cart",
      "$78 Special with Cart" → header holes `[18, 18, 9, 9, None]`. We read the
      hole count from each header ("18 hole" ⇒ 18, "9 hole" ⇒ 9, else unknown).
    - each `tbody > tr` is one tee time:
      · `td.mtrxTeeTimes` = `7:28<div class="be_tee_time_ampm">AM</div>` → 24h
        "07:28".
      · `td.matrixPlayers` = "1 or 2 players" / "2 to 4 players" — a party
        RANGE; we read min/max ints from the text. `players` we report is the
        MAX (the real remaining-capacity ceiling, like clubprophet's maxPlayer),
        never fabricated; a row is bookable for a party iff `min <= party <=
        max`. A row with no parseable party ints is OMITTED (no fake capacity).
      · N `td.matrixsched` cells, ALIGNED 1:1 with the header schedule columns.
        A BOOKABLE cell contains `a.sexybutton.teebutton` (the open-slot link)
        plus `div.mtrxPrice` "$39.00". An unavailable cell is
        `td.matrixsched.mtrxInactive` with `div.mtrxPriceNA` "N/A" and NO
        teebutton. NOTE: `a.sexybutton.teebutton` is ALSO used for the
        Prev/Next-week nav links OUTSIDE the table — so parsing is SCOPED to
        `table.matrixTable > tbody > tr`, never a global button count.

KEY SEMANTICS — read carefully:

- Time is already course-LOCAL wall-clock (no timezone); like clubprophet we do
  not convert — we window-filter the local "HH:MM".
- Open spots: `players = max(party range)`. Bookable iff `min <= party <= max`.
- Price: the CHEAPEST bookable 18-hole rate (a real greens fee, in DOLLARS,
  never divided). If the row has no bookable 18-hole cell we fall back to the
  cheapest bookable 9-hole rate (and report `holes=9`); if neither, the cheapest
  bookable unknown-hole rate (report `holes=18`). `price_usd=None` when no
  bookable cell carries a positive parseable fee — NEVER fabricated as $0.
- A row is OPEN only if it has ≥1 bookable (teebutton) cell; an all-`N/A` row is
  skipped (nothing to book).

EMPTY / DRIFT DECISION (plan §5 schema-drift-canary rule):
  - `matrixTable` present with an empty `<tbody>` (or only unbookable rows) ⇒ a
    REAL verified-empty day (`[]`) — LIVE-VERIFIED on a past date.
  - `matrixTable` ABSENT (an anti-bot interstitial, an error page, or a
    structural redesign) ⇒ "couldn't check" (`None`) + a breaker failure — NEVER
    a silent fake empty.
  - Non-200 / transport error / any parse exception ⇒ `None` + breaker failure.

We identify honestly (`Looper/1.0` UA), reuse the extracted politeness stack
(fetch_discipline.py) with our OWN per-host limiter/breaker/single-flight/cache
(never shared with another engine), never log in, never solve CAPTCHAs, never
book or charge. Never raises — every external call sits under a catch-all that
returns `None` ("couldn't check").

STATUS: no NY-metro Quick18 course exists (every NY-metro engine is
TeeItUp/EZLinks/Chronogolf/foreUP/CPS — Quick18 was skipped in S4c). This
adapter therefore ships REGISTERED but UNSEEDED (zero capability rows) —
correct, tested against a real capture, and ready to activate the instant the
coverage flywheel (plan §6/H6) surfaces a NY-metro Quick18 course. No row is
fabricated.
"""

from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable

import httpx

from app.services.rate_limit import SlidingWindowLimiter

from ..base import (
    BookingDetails,
    BookingResult,
    TeeTimeProvider,
    TeeTimeQuery,
    TeeTimeSlot,
)
from ..capability_store import CourseBookingCapability, load_all_capabilities
from ..fetch_discipline import (
    AVAILABILITY_CACHE_TTL_S,
    REQUEST_TIMEOUT_S,
    USER_AGENT,
    CircuitBreaker,
    SingleFlight,
    _as_price,
    _format_time12h,
)
from ..routing import _haversine_miles, _parse_latlng
from ..search_cache import FileSearchCacheStore, SearchCacheStore

log = logging.getLogger(__name__)

# ─── Module constants ───────────────────────────────────────────────────────────

QUICK18_CACHE_TTL_S = AVAILABILITY_CACHE_TTL_S   # 8 min, same band as every adapter
QUICK18_RPM = 10                                 # per-host, 60s window
MAX_SLOTS_PER_COURSE = 6                          # earliest N inside the window — calm, scannable

_SEARCHMATRIX_PATH = "/teetimes/searchmatrix"

# All Quick18 hosts live under this domain. A pre-resolved capability host is
# asserted to sit on it before any request — defense-in-depth SSRF guard against
# a poisoned seed. Hosts are curated seed strings, never user input.
_QUICK18_DOMAIN_SUFFIX = ".quick18.com"

_DATA_DIR = Path(__file__).parent.parent.parent.parent.parent / "data"

_INT_RE = re.compile(r"\d+")
_PRICE_RE = re.compile(r"([\d,]+\.?\d*)")


# ─── HTML parse (stdlib html.parser — NO new dependency) ────────────────────────

class _MatrixParser(HTMLParser):
    """Extracts the Quick18 searchmatrix availability table into raw row dicts.

    Scoped strictly to the real `<table class="matrixTable">` element (NOT the
    earlier same-named token in a <script>, and NOT the Prev/Next nav teebuttons
    outside the table). Sets `saw_table` so the caller can distinguish a real
    empty day (table present, zero bookable rows) from schema drift / an
    anti-bot page (table absent). Never raises on malformed markup — HTMLParser
    tolerates it and we simply extract what we can.

    Each collected row dict: `{"time": str, "ampm": str, "players": str,
    "sched": [{"book": bool, "inactive": bool, "price": str}, ...]}` — one
    `sched` entry per `td.matrixsched`, positionally aligned with `sched_holes`.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.saw_table = False
        self.sched_holes: list[int | None] = []   # holes per header schedule column
        self.rows: list[dict] = []

        self._in_table = False
        self._in_thead = False
        self._in_tbody = False
        self._th_buf: list[str] | None = None
        self._row: dict | None = None
        # Active cell state: ("time"|"players"|"sched", capturing_flag)
        self._cell_kind: str | None = None
        self._capture_ampm = False
        self._capture_price = False

    @staticmethod
    def _classes(attrs: list[tuple[str, str | None]]) -> set[str]:
        for k, v in attrs:
            if k == "class" and v:
                return set(v.split())
        return set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        cls = self._classes(attrs)
        if tag == "table" and "matrixTable" in cls:
            self._in_table = True
            self.saw_table = True
            return
        if not self._in_table:
            return

        if tag == "thead":
            self._in_thead = True
        elif tag == "tbody":
            self._in_tbody = True
        elif tag == "th" and self._in_thead and "matrixHdrSched" in cls:
            self._th_buf = []
        elif tag == "tr" and self._in_tbody:
            self._row = {"time": "", "ampm": "", "players": "", "sched": []}
        elif tag == "td" and self._row is not None:
            if "mtrxTeeTimes" in cls:
                self._cell_kind = "time"
            elif "matrixPlayers" in cls:
                self._cell_kind = "players"
            elif "matrixsched" in cls:
                self._cell_kind = "sched"
                self._row["sched"].append(
                    {"book": False, "inactive": "mtrxInactive" in cls, "price": ""}
                )
        elif tag == "div" and self._cell_kind == "time" and "be_tee_time_ampm" in cls:
            self._capture_ampm = True
        elif tag == "div" and self._cell_kind == "sched" and "mtrxPrice" in cls and "mtrxPriceNA" not in cls:
            self._capture_price = True
        elif tag == "a" and self._cell_kind == "sched" and "teebutton" in cls and self._row is not None and self._row["sched"]:
            self._row["sched"][-1]["book"] = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "table" and self._in_table:
            self._in_table = False
            return
        if not self._in_table:
            return
        if tag == "thead":
            self._in_thead = False
        elif tag == "tbody":
            self._in_tbody = False
        elif tag == "th" and self._th_buf is not None:
            text = "".join(self._th_buf).strip().lower()
            holes = 18 if "18 hole" in text else (9 if "9 hole" in text else None)
            self.sched_holes.append(holes)
            self._th_buf = None
        elif tag == "td":
            self._cell_kind = None
            self._capture_ampm = False
            self._capture_price = False
        elif tag == "div":
            # ampm/price divs are leaf; close their capture on the div end so
            # trailing whitespace in the cell isn't misattributed.
            self._capture_ampm = False
            self._capture_price = False
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None

    def handle_data(self, data: str) -> None:
        if self._th_buf is not None:
            self._th_buf.append(data)
            return
        if self._row is None or self._cell_kind is None:
            return
        if self._cell_kind == "time":
            if self._capture_ampm:
                self._row["ampm"] += data
            else:
                self._row["time"] += data
        elif self._cell_kind == "players":
            self._row["players"] += data
        elif self._cell_kind == "sched" and self._capture_price and self._row["sched"]:
            self._row["sched"][-1]["price"] += data


# ─── Field extraction helpers ───────────────────────────────────────────────────

def _to_24h(raw_time: str, raw_ampm: str) -> str | None:
    """"7:28" + "AM" → "07:28". None if unparseable."""
    t = raw_time.strip()
    ampm = raw_ampm.strip().upper()
    m = re.match(r"^(\d{1,2}):(\d{2})$", t)
    if not m:
        return None
    hh, mm = int(m.group(1)), m.group(2)
    if hh > 23:
        return None
    if ampm.startswith("PM") and hh != 12:
        hh += 12
    elif ampm.startswith("AM") and hh == 12:
        hh = 0
    return f"{hh:02d}:{mm}"


def _player_bounds(text: str) -> tuple[int, int] | None:
    """"1 or 2 players" → (1, 2); "2 to 4 players" → (2, 4); "1 player" → (1, 1).
    None when no ints present (capacity unknown ⇒ caller omits the row)."""
    nums = [int(n) for n in _INT_RE.findall(text)]
    if not nums:
        return None
    return min(nums), max(nums)


def _cell_price(price_text: str) -> float | None:
    """"$39.00" → 39.0; unparseable/0/negative ⇒ None (never fabricated)."""
    m = _PRICE_RE.search(price_text.replace(",", ""))
    if not m:
        return None
    return _as_price(m.group(1))


def _pick_price_and_holes(
    bookable: list[tuple[int | None, float | None]],
) -> tuple[float | None, int]:
    """From a row's bookable (holes, price) cells choose the displayed
    price/holes: prefer the cheapest 18-hole rate, else cheapest 9-hole (holes
    9), else cheapest unknown-hole (holes 18 default). Price is None when no
    chosen tier has a positive fee — never fabricated."""
    def cheapest(pred: Callable[[int | None], bool]) -> float | None:
        prices = [p for h, p in bookable if pred(h) and p is not None]
        return min(prices) if prices else None

    if any(h == 18 for h, _ in bookable):
        return cheapest(lambda h: h == 18), 18
    if any(h == 9 for h, _ in bookable):
        return cheapest(lambda h: h == 9), 9
    return cheapest(lambda h: True), 18


# ─── Parse + normalize ──────────────────────────────────────────────────────────

def _parse_matrix(html_text: str) -> list[dict] | None:
    """Parse the searchmatrix HTML into cache-safe day dicts
    (`{"time": "HH:MM", "min_players": int, "max_players": int,
    "price_usd": x|None, "holes": 9|18}`). Returns `None` when the availability
    table is ABSENT (schema drift / anti-bot page) — the caller records a breaker
    failure. An empty list is a REAL verified-empty day (table present, no
    bookable rows). Never raises."""
    parser = _MatrixParser()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception:
        log.warning("quick18: HTML parse raised — treating as couldn't-check")
        return None

    if not parser.saw_table:
        return None  # no matrixTable — schema drift / interstitial, not "empty"

    out: list[dict] = []
    for row in parser.rows:
        hhmm = _to_24h(row["time"], row["ampm"])
        if hhmm is None:
            continue
        bounds = _player_bounds(row["players"])
        if bounds is None:
            continue  # capacity unknown — omit, never assume bookable
        min_players, max_players = bounds

        bookable: list[tuple[int | None, float | None]] = []
        for i, cell in enumerate(row["sched"]):
            if not cell["book"]:
                continue
            holes = parser.sched_holes[i] if i < len(parser.sched_holes) else None
            bookable.append((holes, _cell_price(cell["price"])))
        if not bookable:
            continue  # no open (teebutton) rate — nothing to book

        price, holes = _pick_price_and_holes(bookable)
        out.append({
            "time": hhmm,
            "min_players": min_players,
            "max_players": max_players,
            "price_usd": price,
            "holes": holes,
        })
    return out


def _emit_slots(
    day_slots: list[dict],
    cap: CourseBookingCapability,
    query: TeeTimeQuery,
    *,
    distance_miles: float,
    course: dict | None,
) -> list[TeeTimeSlot] | None:
    """Apply the post-cache filters (window, party range, price) + sort +
    truncate, and build the TeeTimeSlot list. Returns `None` on a malformed
    window (never raises); `[]` is a valid verified-empty result."""
    try:
        window_start = datetime.strptime(query.time_window_start, "%H:%M").time()
        window_end = datetime.strptime(query.time_window_end, "%H:%M").time()
    except (ValueError, TypeError):
        return None

    filtered: list[dict] = []
    for d in day_slots:
        try:
            t = datetime.strptime(d["time"], "%H:%M").time()
        except (ValueError, TypeError):
            continue
        if not (window_start <= t <= window_end):
            continue
        # party must fit the slot's real min..max range
        if not (d["min_players"] <= query.party_size <= d["max_players"]):
            continue
        if (
            query.max_price_usd is not None
            and d["price_usd"] is not None
            and d["price_usd"] > query.max_price_usd
        ):
            continue
        filtered.append(d)

    filtered.sort(key=lambda d: d["time"])
    filtered = filtered[:MAX_SLOTS_PER_COURSE]

    host = cap.platform_ids.get("host", "")
    course_id = f"quick18-{host}"
    city = (course or {}).get("address") or ""
    rating = (course or {}).get("rating")

    slots: list[TeeTimeSlot] = []
    for i, d in enumerate(filtered):
        slots.append(TeeTimeSlot(
            id=f"{course_id}-{query.date}-{d['time']}-{i}",
            course_id=course_id,
            course_name=cap.name,
            city=city,
            date=query.date,
            time=d["time"],
            players=d["max_players"],   # real remaining-capacity ceiling
            price_usd=d["price_usd"],
            cart_included=False,
            distance_miles=distance_miles,
            rating=float(rating) if rating is not None else 0.0,
            designer=None,
            provider="quick18",
            holes=d["holes"],  # type: ignore[arg-type]
            booking_url=cap.booking_url,
            estimated=False,
            route=None,   # Quick18 knows real availability — route=None per base.py.
            phone=cap.phone,
        ))
    return slots


def _cache_key(cap: CourseBookingCapability, query: TeeTimeQuery) -> str:
    """Deterministic cache key: `(host, date)`. Party size is NOT in the key —
    the searchmatrix GET fetches the whole day's matrix regardless of party, and
    the party-range filter is applied post-cache in `_emit_slots`."""
    return json.dumps({
        "v": 1,
        "host": cap.platform_ids.get("host"),
        "date": query.date,
    }, sort_keys=True)


def _valid_quick18_host(host: object) -> bool:
    """Defense-in-depth SSRF guard: a capability host must be a bare hostname
    under `.quick18.com` (no scheme/slashes/port). Rejects a poisoned/malformed
    seed before any request leaves the process."""
    if not isinstance(host, str) or not host:
        return False
    if "/" in host or ":" in host or " " in host:
        return False
    return host.lower().endswith(_QUICK18_DOMAIN_SUFFIX)


def _searchmatrix_url(host: str, date_yyyy_mm_dd: str) -> str:
    """`https://<host>/teetimes/searchmatrix?teedate=YYYYMMDD` (dashes stripped
    — Quick18 wants the compact date)."""
    teedate = date_yyyy_mm_dd.replace("-", "")
    return f"https://{host}{_SEARCHMATRIX_PATH}?teedate={teedate}"


# ─── Module singletons (this engine's own host — never shared) ─────────────────

_limiter = SlidingWindowLimiter(rpm=QUICK18_RPM, window_s=60.0)
_breaker = CircuitBreaker()


# ─── Provider ──────────────────────────────────────────────────────────────────

class Quick18Provider(TeeTimeProvider):
    """Real Quick18 tee-time availability for courses with a known booking
    capability (platform=="quick18"). Currently UNSEEDED — no NY-metro Quick18
    course exists (see module docstring); registered and ready for the coverage
    flywheel."""

    def __init__(
        self,
        capabilities: Callable[[], tuple[CourseBookingCapability, ...]] = load_all_capabilities,
        cache: SearchCacheStore | None = None,
        limiter: SlidingWindowLimiter | None = None,
        breaker: CircuitBreaker | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._capabilities = capabilities
        self._cache = cache or FileSearchCacheStore(
            path=_DATA_DIR / "quick18_availability_cache.json",
            ttl_seconds=QUICK18_CACHE_TTL_S,
        )
        self._limiter = limiter or _limiter
        self._breaker = breaker or _breaker
        self._transport = transport
        self._clock = clock
        self._singleflight = SingleFlight()

    @property
    def name(self) -> str:
        return "quick18"

    # ── Router-facing entry point ───────────────────────────────────────────

    async def slots_for_capability(
        self,
        cap: CourseBookingCapability,
        query: TeeTimeQuery,
        *,
        distance_miles: float = 0.0,
        course: dict | None = None,
    ) -> list[TeeTimeSlot] | None:
        """`None` = couldn't check (breaker open / rate-limited / HTTP or parse
        failure / missing-or-untrusted host). `[]` = verified: nothing
        available. Never raises."""
        try:
            datetime.strptime(query.date, "%Y-%m-%d")
        except (ValueError, TypeError):
            return None

        host = cap.platform_ids.get("host")
        if not _valid_quick18_host(host):
            log.warning("quick18: capability host missing/untrusted — refusing")
            return None

        try:
            cache_key = _cache_key(cap, query)
            day_slots = self._cache.get(cache_key)
            if day_slots is None:
                day_slots = await self._fetch_day(cache_key, host, query.date)
                if day_slots is None:
                    return None  # couldn't check

            return _emit_slots(
                day_slots, cap, query, distance_miles=distance_miles, course=course
            )
        except Exception:
            log.warning("quick18: slots_for_capability failed unexpectedly", exc_info=True)
            return None

    # ── Fetch path: single-flight -> rate limiter -> breaker -> HTTP ───────

    async def _fetch_day(self, cache_key: str, host: str, query_date: str) -> list[dict] | None:
        async def _do() -> list[dict] | None:
            cached = self._cache.get(cache_key)
            if cached is not None:
                return cached
            result = await self._do_fetch(host, query_date)
            if result is not None:
                self._cache.set(cache_key, result)
            return result

        return await self._singleflight.run(cache_key, _do)

    async def _do_fetch(self, host: str, query_date: str) -> list[dict] | None:
        # Rate limiter first — self-throttling is not an upstream signal, so it
        # never counts a breaker failure.
        retry_after = self._limiter.check(host)
        if retry_after is not None:
            log.info("quick18: rate-limited host=%s retry_after=%.1fs", host, retry_after)
            return None

        if not self._breaker.allow():
            return None

        url = _searchmatrix_url(host, query_date)
        headers = {"User-Agent": USER_AGENT, "Accept": "text/html"}
        async with httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT_S, transport=self._transport, follow_redirects=True
        ) as client:
            try:
                resp = await client.get(url, headers=headers)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                log.warning("quick18: request error host=%s exc=%r", host, exc)
                self._breaker.record_failure(reason="request-error")
                return None
            except Exception as exc:
                log.warning("quick18: unexpected request error host=%s exc=%r", host, exc)
                self._breaker.record_failure(reason="request-error")
                return None

        if resp.status_code != 200:
            log.warning("quick18: non-200 status=%d host=%s", resp.status_code, host)
            self._breaker.record_failure(reason=str(resp.status_code))
            return None

        day = _parse_matrix(resp.text)
        if day is None:
            # matrixTable absent / parse blew up — schema drift, NOT empty.
            log.warning("quick18: availability table missing/unparseable host=%s", host)
            self._breaker.record_failure(reason="no-matrix-table")
            return None
        self._breaker.record_success()
        return day

    # ── Standalone provider mode (debug only, mirrors ClubProphetProvider) ──

    async def search_availability(self, query: TeeTimeQuery) -> list[TeeTimeSlot]:
        try:
            origin = _parse_latlng(query.area)
            if origin is None:
                return []
            max_dist = query.max_distance_miles if query.max_distance_miles is not None else 15.0

            results: list[TeeTimeSlot] = []
            for cap in self._capabilities():
                if cap.platform != "quick18" or cap.is_private:
                    continue
                dist = round(_haversine_miles(origin[0], origin[1], cap.lat, cap.lng), 1)
                if dist > max_dist:
                    continue
                slots = await self.slots_for_capability(cap, query, distance_miles=dist)
                if slots:
                    results.extend(slots)

            results.sort(key=lambda s: (s.distance_miles, s.course_name, s.time))
            return results
        except Exception:
            log.exception("quick18: search_availability failed — returning empty")
            return []

    async def book(self, slot: TeeTimeSlot, _details: BookingDetails) -> BookingResult:
        """ALWAYS needs_human — never book programmatically. Never a
        confirmation number (same S2 invariant as every adapter)."""
        time12 = _format_time12h(slot.time) if slot.time else slot.time
        message = (
            f"{time12} at {slot.course_name} is open — finish booking on the "
            "course's site. They take the reservation."
        )
        return BookingResult(
            status="needs_human",
            confirmation_number=None,
            message=message,
            booking_url=slot.booking_url,
        )
