# Headless / Generic Web-Scraping Rung — Tee-Time Availability (build-ready plan)

*Refines `specs/teetime-availability-everywhere-plan.md` §4b (S4d). Fable plan per the standing "plan tee-time on Fable first" directive. Owner ask: "web scraping such that we could at least FETCH tee times easily regardless of the course." This plan researches whether the headless rung has real targets before proposing to build it — and the honest finding is that it largely does not, so the headline recommendation is a pivot.*

## 0. The ceiling, stated plainly (read first)

**Anti-bot is a hard ceiling we do not cross.** The Marine Park EZLinks portal (`marineparkridepp.ezlinksgolf.com`) and the entire NYC EZLinks family (`golfnyc2.ezlinksgolf.com`) sit behind **Cloudflare Turnstile** interactive challenges. A headless Chromium probe (honest UA and default Chrome UA both) sat on "Verify you are human" across repeated polls and **never cleared it**; not a single EZLinks `/api` or `/search` call ever fired (recon captured in `scratchpad/FINDINGS.json` / `scratchpad/xhrs.json`). The owner independently hit the same wall.

**Hard constraint enforced throughout this plan:** we do NOT defeat anti-bot. No CAPTCHA solving, no fingerprint spoofing, no IP/UA rotation to evade a block. **A Cloudflare/Akamai/Turnstile wall ⇒ that course is rung-3 (AI phone call) or partnership, full stop.** Headless Chromium does not change this — a browser that renders the challenge still cannot pass it politely, so "add a browser" buys us nothing against a Turnstile-gated engine. This is the single most important input to the verdict below.

## 1. The crux — does the headless rung even have targets?

The availability ladder: API (rung 1) → widget-XHR-replay httpx (2a) → **headless render (2b, this plan)** → AI-call (3) → honest-empty (4). Rung 2b only earns its ~400 MB Playwright+Chromium infra cost if there exist courses that are **bucket (c)**: a genuinely JS-rendered widget with **no clean replayable XHR AND no anti-bot wall**. Buckets:

- **(a)** reachable by a clean httpx adapter (JSON or server-rendered HTML) we just haven't written yet → that's rung-1/2a adapter work, cheaper, NOT headless.
- **(b)** behind anti-bot → unscrapable politely → rung-3.
- **(c)** truly needs a browser (JS renders availability with no replayable request, and the host is not anti-bot-walled) → the real headless target.

### 1a. Target-bucket research (NY-metro engines, live-probed 2026-07-10)

| Engine | Host pattern | What the widget actually does (probed) | Anti-bot? | Bucket |
|---|---|---|---|---|
| **EZLinks** (Marine Park + NYC munis) | `*.ezlinksgolf.com` | SPA; every path Cloudflare-gated. Turnstile interactive challenge; API `POST /api/search/search` = hard 403 WAF | **YES — Cloudflare Turnstile** | **(b) skip → rung 3** |
| **Club Prophet / CPS** | `*.cps.golf` (`/onlineresweb`) | Angular SPA; availability from an `onlineApi` JSON host resolved at runtime via a server-settings call, guarded by a short-lived token minted with a STATIC public client secret (`env.js`). API host answered plain httpx + honest UA with no interactive challenge. | No interactive wall on browse | **(a) — httpx + token step** |
| **Quick18** | `*.quick18.com/teetimes/searchmatrix?teedate=` | Server-rendered HTML matrix, no JS. Proven by an OSS tool scraping it plain-GET, parse `table.matrixTable`, `a.sexybutton.teebutton` = open slot. | No | **(a) — HTML-lite (bs4/selectolax)** |
| **Teesnap** | `*.teesnap.net` | Laravel app behind CloudFront (not Cloudflare challenge); XSRF-TOKEN + laravel_session cookies; React widget calls a customer JSON API. Needs per-facility subdomain discovery + one capture. | No interactive wall observed | **(a) — httpx + cookie/XSRF step** |
| **ForeTees** | member portals | Login-gated, private clubs | n/a (auth) | **excluded** (never scrape behind auth) |

### 1b. Honest finding: bucket (c) is effectively empty

**Every remaining researched NY-metro engine is either bucket (a) (httpx-addable — CPS, Quick18, Teesnap) or bucket (b) (anti-bot-walled — EZLinks → rung 3).** None is a clean bucket-(c) "needs a browser and isn't walled" target:

- CPS *looks* like the classic "JS SPA" headless candidate, but its availability is a replayable JSON API with public token creds — bucket (a) with a token dance, not (c). A browser is not required.
- Quick18 is literally server-rendered HTML — the cheapest possible scrape, no browser.
- Teesnap is a Laravel/React app whose API is cookie/XSRF-gated, not JS-render-gated — bucket (a) once the facility subdomain and JSON path are captured.
- EZLinks is the one that "feels" like it needs a browser, but it is bucket (b): the browser renders the Turnstile challenge and stops. Headless does not rescue it.

**This is the pivot.** The headless rung has no proven target in the NY-metro set. Building Playwright+Chromium now would be headless-for-its-own-sake — exactly what the owner asked us not to do. The right next work is **more httpx adapters (CPS, Quick18, Teesnap) + leaning on the rung-3 AI-call** for the anti-bot tail.

## 2. Extraction approach (documented now, so the deferred build is unambiguous)

**Strongly prefer capture-the-XHR over parse-the-DOM.** When a browser is genuinely required, Playwright loads the booking page and captures the availability JSON the page itself fetches via `page.wait_for_response(<url-pattern>)`, then parses that JSON — making a "scraper test" mostly a JSON-parser test against a saved fixture. DOM scraping is the fragile last resort.

**Generic capture with per-engine hints (recommended) over per-engine parsers.** A single `capture_availability_json(page, hints)` helper: navigate → wait for a response whose URL matches a hint list of availability-path patterns → return the first JSON body that looks like a slot list. Per engine we supply only the URL-pattern hint + a tiny normalizer into the shared day-dict. Fragility: capture-the-XHR + per-engine normalizer = medium-low; generic sniff = medium; DOM parse = high.

## 3. The "regardless of course" generic ambition — honest reliability

`scripts/probe_booking_capability.py` already fingerprints a course website for known engine markers. A generic headless path would: fingerprint → load headless → capture availability JSON. **Honest reliability: moderate for KNOWN engines, low for truly unknown ones.** For a recognized engine we also have (or can cheaply write) an httpx adapter, so headless adds cost without coverage. For a genuinely unknown widget the capture heuristic can't reliably distinguish the availability call from analytics/config; multi-step widgets need per-engine scripting (not generic); anti-bot stops it dead. **A truly "any course" generic browser fetch is not reliable enough to build now; widen the fingerprint→httpx-adapter set instead.**

## 4. Worker architecture (specified, gated, DEFERRED — do not build until a real bucket-(c) target exists)

In-process asyncio worker (no Celery), one shared Chromium, 1–2 contexts, bounded queue, OFF the request path. Request path reads the scrape cache; a miss enqueues a `(platform,ids,date)` job and returns `TeeTimeSlot(status="pending")` (already in `base.py`). Poll endpoint mirrors the S4e availability-call pattern; frontend "Checking live availability…" row mirrors the "Calling the pro shop…" state. Gated behind `TEETIME_SCRAPER_ENABLED` (default off); the ~400 MB Playwright+Chromium dependency rides its OWN deploy slice/image layer — not added until a slice needs it.

## 5. Caching, politeness, ToS (hard rules)

Honest UA `Looper/1.0 (golf tee-time availability)`; respect robots.txt (disallow ⇒ rung 3); reuse `fetch_discipline.py` (≤10 rpm/host limiter, breaker, single-flight, 8-min TTL). **The bright line: never log in, never solve CAPTCHAs, never rotate IPs/fingerprints to evade a block — a block ⇒ breaker opens, capability flips to `channel="call"`, move on.** ToS posture: public availability *facts*, read-only, drives booking traffic to the course; browse-wrap ToS gray area (hiQ v. LinkedIn — public scraping isn't CFAA, but breach-of-contract survives); risk low-but-nonzero, stated. Any block/C&D ⇒ comply immediately. Keep partnership applications filed.

## 6. Sequencing — the honest pivot (cheaper httpx first; headless deferred)

Each slice fixture-tested, no live hits in CI.

- **H1 — Club Prophet (CPS) httpx adapter (rung 2a, highest value).** Token dance from the live bundle (`connect/token/short` w/ public `env.js` creds → resolve `onlineApi` host → `SearchTeetimes`), capture fixture, `adapters/clubprophet.py` under `fetch_discipline.py`, 1–2 NY-metro seed rows, register in `ADAPTERS`. Brittle part = token/config indirection; schema-guard + breaker handle drift. *Cycle-sized; biggest real coverage win.*
- **H2 — Quick18 HTML-lite adapter (rung 2a, cheapest).** Plain GET `searchmatrix?teedate=` + `selectolax`/`bs4` parse of `table.matrixTable`, fixture-tested. *Half-cycle.*
- **H3 — Teesnap httpx adapter (rung 2a, conditional).** Capture one live facility's availability JSON + confirm XSRF/cookie replay over httpx. If a real bot-block appears → reclassify to rung 3, no headless. *Cycle-sized, gated on capture.*
- **H4 — rung-3 coverage for the anti-bot tail (wiring only).** EZLinks/Marine Park + any Turnstile-walled course recorded `channel="call"` → lands on the S4e availability-call CTA (built, dark until Twilio).
- **H5 (DEFERRED, do not start) — headless worker (§4).** Only if a concrete bucket-(c) target is discovered. Trigger: coverage-flywheel telemetry surfaces a searched course whose engine is fingerprinted-but-unreachable-by-httpx AND confirmed not anti-bot-walled.
- **H6 — coverage flywheel (bundle-rider).** Log searched courses with no capability/honest-empty → feed the probe; "% of searched courses returning real availability"; monthly re-probe; schema-drift canary (live fetch per engine, diff vs fixture) — a parse-guard violation ⇒ `None` + breaker + `probe_status="stale"`, never a silent empty.

## 7. Verdict

**Do not build the Playwright/Chromium headless rung now.** Among NY-metro engines there is no proven bucket-(c) target. Every remaining course is either httpx-addable (Club Prophet, Quick18, Teesnap) or anti-bot-walled (EZLinks family — permanently rung-3, browser doesn't change it). A ~400 MB image + browser-worker to fetch *zero* additional courses is headless-for-its-own-sake.

**The right outcome for "fetch tee times easily regardless of the course" is the cheaper path:** ship the CPS + Quick18 + Teesnap httpx adapters (H1–H3), where the real remaining NY-metro availability lives, and lean on the already-built rung-3 AI-call for the anti-bot tail. Keep the headless worker fully specified and gated (§4) so a genuine bucket-(c) engine is later a small known slice, not a research project — but don't carry its infra cost until then. Maximize real availability *breadth*, not scraper sophistication.

### Critical Files
- `backend/app/services/tee_times/router_provider.py` — `_slots_for_course` ladder; new rung-2a adapter branches
- `backend/app/services/tee_times/fetch_discipline.py` — shared limiter/breaker/single-flight/cache each adapter reuses
- `backend/app/services/tee_times/adapters/teeitup.py` — reference pattern for `clubprophet.py`/`quick18.py`/`teesnap.py`
- `backend/scripts/probe_booking_capability.py` — fingerprint + `--capture-fixture`; extend for CPS token dance, Quick18 HTML, Teesnap XSRF
- `backend/app/services/tee_times/capability_store.py` — CPS/Quick18/Teesnap seed rows
