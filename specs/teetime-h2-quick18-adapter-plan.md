# H2 — Quick18 HTML-lite adapter (rung 2a, cheapest) — plan-lite

*specs/teetime-headless-scraper-plan.md §6/H2, §1a. Backend-only. Built on `integration/next`.*

## Live probe finding (2026-07-10)
- **HTML structure CONFIRMED live** against real Quick18 courses (`northernhills.quick18.com`
  [Rochester MN], `mccormick`, `homestead`): plain GET `…/teetimes/searchmatrix?teedate=YYYYMMDD`
  with honest UA returns server-rendered HTML, `<table class="matrixTable">`, `a.sexybutton.teebutton`
  open-slot links. No JS, no anti-bot wall, HTTP 200.
- **Real parse contract (differs from the plan's hypothesis — the plan's `a.sexybutton.teebutton`
  is right but incomplete):**
  - The availability table is the 2nd `matrixTable` (`<table class="matrixTable" border="1">`);
    the 1st `matrixTable` token is in a `<script>`. `a.sexybutton.teebutton` is ALSO used for the
    Prev/Next-week nav buttons OUTSIDE the table — so parsing MUST be scoped to
    `table.matrixTable > tbody > tr`, never a global button count.
  - `thead > th.matrixHdrSched` = the rate/schedule columns, e.g. "18 Holes", "18 Holes with Cart",
    "9 Holes", "9 Holes with Cart", "$78 Special with Cart" → header holes `[18,18,9,9,None]`.
  - Each `tbody > tr`:
    - `td.mtrxTeeTimes` = `7:28<div class="be_tee_time_ampm">AM</div>` → 24h "07:28".
    - `td.matrixPlayers` = "1 or 2 players" / "2 to 4 players" → min/max party (ints in the string).
    - N `td.matrixsched` cells aligned 1:1 with the header schedule columns. A bookable cell has an
      `a…teebutton` + `div.mtrxPrice` "$39.00"; an unavailable cell is `td.matrixsched.mtrxInactive`
      with `div.mtrxPriceNA` "N/A" and no teebutton.
  - **Empty day** = `matrixTable` present with an EMPTY `<tbody>` (verified live on a past date) →
    `[]` verified-empty. **Missing `matrixTable`** (anti-bot/error page) → `None` + breaker.

## No NY-metro seed target (honest finding)
Extensive web search + probing surfaced only non-NY-metro Quick18 courses (MN/CA/NC/AZ/VT/PA).
Every NY-metro engine is TeeItUp / EZLinks / Chronogolf / foreUP / CPS — matching the plan's note
that "Quick18 was skipped in S4c". **No fabricated NY row is added.** The adapter ships correct and
tested against a REAL Quick18 capture, registered and ready, but with ZERO seed rows — it activates
the instant the coverage flywheel (H6) finds a NY-metro Quick18 course. This makes the item SILENT
(no user-visible course added), not noticeable. No fixture is fabricated; fixtures are real
`northernhills` captures used purely as structure ground-truth.

## Deliverables
1. `backend/app/services/tee_times/adapters/quick18.py` — same contract as `clubprophet.py`:
   `list[TeeTimeSlot]` | `[]` (verified empty) | `None` (couldn't check), NEVER raises. Single plain
   GET (no token dance). Parse via **stdlib `html.parser.HTMLParser`** — NO new dependency (bs4/lxml
   are stray, un-locked; selectolax would add a prod dep for unseeded code — not warranted). Honest
   normalize: real 24h time; `players` = max of the row's party range (ceiling); party filter
   `min <= party <= max`; `price_usd` = cheapest bookable 18-hole rate (fallback 9-hole, else
   unknown-hole cheapest), real or `None`, never $0; `holes` from the chosen column; `provider="quick18"`,
   `route=None`, `booking_url=cap.booking_url`. Schema-guard: no `matrixTable` → `None` + breaker.
   SSRF guard: https + host endswith `.quick18.com` only (curated seed, never user input). Reuse
   `fetch_discipline.py` (limiter/breaker/single-flight/cache) with this engine's OWN singletons.
2. Register `quick18` in `ADAPTERS` (`router_provider.py`). No seed row added (honest finding).
3. Tests `backend/tests/test_tee_time_quick18.py` — parse/normalize/window/party/price/empty/schema-guard/
   SSRF/error-legs/cache/single-flight/breaker, all derived from the REAL fixtures
   (`quick18_searchmatrix_times.html`, `quick18_searchmatrix_empty.html`) via httpx.MockTransport — NO
   live network in CI. S0/S1/S4a/S4c/CPS suites byte-identical (adapter is additive, unseeded).

## Gates
`cd backend && ruff check . && pytest` all SUCCESS on the pushed head. Zero frontend files touched.
