# Implementation plan — `caddie-llm-rate-limiting`

Audit item **E (grade F)** from `specs/caddie-excellence-audit.md`: there are **zero** per-user
rate/token/spend limits on the paid LLM endpoints. Today's only guards are auth
(`current_user_id`, and the router-level owner gate) plus a 4000-char input cap. An authed client
bug-loop or abuser can hammer the caddie/voice/realtime endpoints with **no cost ceiling** — the
single biggest cost/scale risk.

**Classification: SILENT.** No success-path wire-shape change. The only new behavior is an error
**status (429)** on limit, carried in the standard FastAPI `{"detail": ...}` body that the frontend
already normalizes to a calm message (see §5). No shared-type change, and — per §5 — **no frontend
change is required** for the 429 to surface calmly.

**No migration.** In-process sliding-window RPM (a per-user deque of timestamps; a restart resetting
it is fine — bug-loops happen within seconds) **plus** a file-backed daily counter modeled exactly
on the proven `FileBudgetStore` in `backend/app/services/golfapi_cache.py`. No DB table, no new
infra, **no Alembic migration**. Nothing in this plan requires one.

---

## 1. Approach & rationale

### Two-tier design (one shared per-user bucket across all protected endpoints)

- **Tier 1 — sliding-window RPM (in-process).** Per `user_id`, a `collections.deque` of request
  timestamps (seconds, from an injectable monotonic clock). On each request: evict timestamps older
  than the window (60 s), then if `len(window) >= RPM` reject with 429, else append `now` and allow.
  Catches **fast bursts** (a bug-loop hammering the endpoint). In-process is correct at
  `--workers 1` (current prod) and a restart harmlessly clears it — a burst loop is a seconds-scale
  event, so nothing durable is needed here.

- **Tier 2 — daily budget (file-backed, survives restarts).** A JSON file keyed by **UTC calendar
  day**, mirroring `FileBudgetStore`, holding per-user request counts (and a coarse estimated-token
  accumulator). On each request: if the user's daily requests `>=` the daily cap → reject with 429;
  else increment and persist. Resets automatically on UTC-day rollover (same pattern as
  `FileBudgetStore._current_month`). Catches a **slow-but-relentless leak** that stays under the RPM
  ceiling but runs for hours (e.g. a retry every few seconds overnight).

The two tiers are complementary: RPM stops fast loops in seconds; the daily cap stops a slow drip
that RPM would never trip. Both share **one bucket per user** spanning every protected endpoint, so
the ceiling is on the user's *total* paid activity, not per-route (a loop that rotates across
`/voice`, `/recommend`, `/course-intel` is still caught).

### Why request-count is an honest spend ceiling (and the token dimension)

Per-request cost is already **bounded**: input is capped at 4000 chars (~1000 tokens) and the caddie
calls use `max_tokens=300`. So `daily_request_cap x worst-case-per-request-cost` is a real,
honest **daily spend ceiling** — the request cap alone bounds spend.

The audit also wants a token dimension. True TPM/post-call accounting is hard without reading
`response.usage` after every call and writing it back. The **simplest honest version** shipped here:
alongside the request count, accumulate a **coarse per-request token estimate**
(`len(transcript)//4 + max_tokens`) into the daily file, and cap it generously
(`CADDIE_RATE_DAILY_TOKENS`, default set high enough that the request cap binds first in normal use;
it exists to catch abnormally large inputs). **Follow-up (noted, not built here):** replace the
estimate with the *real* token totals already available at `_log_caddie_usage(...)` in
`backend/app/routes/caddie.py` (write `usage.input_tokens + usage.output_tokens` back into the daily
store after the call) for true spend accounting. That follow-up needs no migration either but is out
of scope for this item.

### Fail-OPEN

Availability over strictness for a golf app (NORTHSTAR: calm, fail-to-honest-state). If the
limiter's own storage or logic raises for **any** reason (file unreadable, JSON corrupt, unexpected
bug), the limiter **allows the request and logs loudly** at `WARNING`/`ERROR`. The only exception it
ever raises is the intentional `HTTPException(429)`. A golfer mid-round is never blocked by the
limiter's own failure.

### Chosen limits + env vars (exact numbers + reasoning)

All configurable via env with sane defaults, read once at import (same pattern as
`clerk_auth.py` / `golfapi_cache.py`):

| Env var | Default | Meaning |
|---|---|---|
| `CADDIE_RATE_RPM` | `30` | Max requests per rolling 60 s per user (Tier 1) |
| `CADDIE_RATE_WINDOW_S` | `60` | Sliding-window length in seconds |
| `CADDIE_RATE_DAILY_REQUESTS` | `1500` | Max protected requests per UTC day per user (Tier 2) |
| `CADDIE_RATE_DAILY_TOKENS` | `4000000` | Coarse est-token ceiling per UTC day per user (secondary) |
| `CADDIE_RATE_OWNER_MULTIPLIER` | `1.0` | Ceiling multiplier applied to the owner id (see §"owner") |
| `CADDIE_RATE_ENABLED` | `1` | Master kill-switch (`0` = allow all, still logs) |

**RPM = 30 / 60 s.** A single on-course decision realistically costs up to ~3 requests
(`/course-intel` on hole load + `/session/recommend` + one voice turn). A chatty golfer firing
several questions in a minute, where the voice **ladder** can fall through up to 3 tiers per question
(session-stream -> stateless-stream -> non-stream fallback, see `frontend/src/lib/caddie/api.ts`),
lands around ~15-18 requests in the worst realistic minute. **30** gives ~2x headroom — a real round
NEVER hits it. A bug-loop doing even 10 req/s trips it in ~3 seconds.

**Daily = 1500 requests / UTC day.** A pathological real day (two very chatty 18-hole rounds, each
hole with ~8 interactions x the 3-tier ladder + per-hole intel/recommend) totals under ~1000. **1500**
never trips for a real human, yet an overnight slow loop (30/min x 8 h = 14,400) blows past it many
times over. The audit's "a few hundred caddie turns/day" sits comfortably below.

**Token ceiling default 4,000,000 est/day** is deliberately loose so the request cap binds first in
normal use; it only fires on abnormally large sustained input volume. It is the honest-but-coarse
placeholder for the real-usage follow-up above.

These are ceilings for **bug-loops and abuse, not users.**

---

## 2. Critical files to touch (and the shape of each change)

### NEW — `backend/app/services/rate_limit.py`

The whole limiter lives here, structured for deterministic unit testing (injectable clock +
injectable store, mirroring `golfapi_cache.py`'s ABC-injection pattern).

- **`DailyBudgetStore` (ABC)** — `get(user_id) -> dict{"requests": int, "est_tokens": int}` and
  `add(user_id, *, requests: int, est_tokens: int) -> dict`. Abstract so tests inject a fake (and a
  raising fake for the fail-open test).
- **`FileDailyBudgetStore(DailyBudgetStore)`** — JSON file at
  `backend/data/caddie_rate_limit.json`, modeled line-for-line on `FileBudgetStore`:
  - Path injectable via constructor (`path: Optional[Path] = None`, default `_DATA_DIR / "caddie_rate_limit.json"`).
  - `_load()`/`_save()` identical to `FileBudgetStore` (best-effort read; `mkdir(parents=True, exist_ok=True)` on write; `json.dumps(..., indent=2)`).
  - **UTC day** boundary via an injectable `now` callable defaulting to `datetime.datetime.utcnow`
    (mirrors `FileBudgetStore._current_month`, which uses `utcnow().strftime`). File shape:
    ```json
    {"day": "2026-07-08", "users": {"user_abc": {"requests": 12, "est_tokens": 15840}}}
    ```
    On `get`/`add`, if stored `day != current UTC day` the whole `users` map resets — automatic
    daily rollover, no cron, no migration. **DST-safe by construction** because the boundary is UTC,
    not local.
- **`SlidingWindowLimiter`** — holds `dict[str, deque[float]]`, `rpm`, `window_s`, and an injectable
  `clock: Callable[[], float]` (default `time.monotonic`). Method `check(user_id) -> Optional[float]`
  returns `None` when allowed (after appending `now`), or the **Retry-After seconds** (float) when
  the window is full: `retry = window_s - (now - window[0])`. Includes eviction (see §6).
- **`CaddieRateLimiter`** — composes the two tiers; reads env in a `from_env()` classmethod but
  accepts injected `window_limiter` + `daily_store` + `owner_id` for tests. Public
  `async def enforce(user_id: str) -> None`:
  1. If disabled -> return (allow).
  2. Wrap everything in `try/except Exception` -> on any internal error, **log loudly and return**
     (fail-open). The intentional `HTTPException(429)` is raised *outside* / re-raised past this
     guard (catch `HTTPException` and re-raise; only swallow non-HTTP exceptions).
  3. Tier 1 (RPM): `retry = window.check(user_id)`; if not None -> `_reject("rpm", retry, ...)`.
  4. Tier 2 (daily): read store; if over the request cap or token cap ->
     `_reject("daily", seconds_to_utc_midnight, ...)`; else `store.add(...)`.
  5. Owner multiplier applied to both ceilings when `user_id == OWNER_CLERK_USER_ID` (default 1.0 =
     no change).
- **`_reject(tier, retry_after, user_id, count, limit)`** — logs loudly (§7) then raises
  `HTTPException(status_code=429, detail=_CALM_429_DETAIL, headers={"Retry-After": str(max(1, ceil(retry_after)))})`.
  `_CALM_429_DETAIL = "Easy — too many at once. Give me a sec and ask again."` (short, in-character,
  no machine markers).
- **Module singleton + dependency factory:**
  ```python
  _limiter = CaddieRateLimiter.from_env()

  async def caddie_rate_limited_user(user_id: str = Depends(current_user_id)) -> str:
      await _limiter.enforce(user_id)
      return user_id
  ```
  This composes with auth (it `Depends(current_user_id)`) and **yields the user id**, so endpoints
  swap `Depends(current_user_id)` -> `Depends(caddie_rate_limited_user)` with **no double-auth** and
  no other change to their signature.

### EDIT — `backend/app/routes/caddie.py`

Import `caddie_rate_limited_user` from `app.services.rate_limit`. On these handlers **only**, change
the `user_id` param dependency from `Depends(current_user_id)` to `Depends(caddie_rate_limited_user)`:
`session_voice`, `session_voice_stream`, `voice_caddie`, `voice_caddie_stream`, `session_recommend`,
`get_recommendation`, `get_course_intel`. (Leave everything else — start/end/status/shot/conditions/
player-profile/message/weather/personalities/profile/player-stats — untouched.) No other logic
changes; the limiter runs during dependency resolution, i.e. before the handler body and, for the
streaming handlers, **before** the `StreamingResponse` is constructed — so a 429 is a normal JSON
error with headers not yet sent, exactly like the existing "ANTHROPIC_API_KEY not configured" 500.

### EDIT — `backend/app/routes/realtime.py`

Same swap on `start_realtime_session` (POST `/api/realtime/session`) and `start_setup_session`
(POST `/api/realtime/setup-session`) — the paid orb-session mints.

### EDIT — `backend/app/routes/voice.py`

- `speak` (POST `/api/voice/speak`, OpenAI TTS — explicitly named): swap the dep.
- `parse_voice_scores` (POST `/api/voice/parse-scores`, Claude): **currently takes no `user_id` and
  no per-user auth** (relies only on the router-level owner gate). Add
  `user_id: str = Depends(caddie_rate_limited_user)` — this both binds it per-user and limits it.
- Leave `live-token`, `transcribe`, `telemetry` unlimited (see §"scope" below).

### EDIT — `backend/app/routes/voice_advanced.py`

`parse_round_setup`, `parse_scorecard`, `parse_transcript` are all Claude (`_get_client`) and
currently take no per-user auth. Add `user_id: str = Depends(caddie_rate_limited_user)` to each so
the paid LLM parse endpoints share the same per-user bucket. (These are low-frequency in real use —
round setup / scorecard scan / score entry — so they never crowd the budget, but a bug-loop on them
is equally costly.)

### EDIT — `backend/.env.example`

Add the six env vars from §1 with their defaults and a one-line comment each.

### EDIT — `backend/data/.gitignore` (or repo `.gitignore`)

Add `caddie_rate_limit.json` so the runtime counter file is not committed (matches how the other
`backend/data/*.json` runtime files are treated). Minor; confirm the existing ignore pattern first.

### NEW — `backend/tests/test_rate_limit.py`

See §8.

---

## 3. Exact endpoint list (what gets the limiter, what does NOT)

**Protected (share one per-user bucket):**

| Endpoint | Handler | Why |
|---|---|---|
| POST `/api/caddie/session/voice` | `session_voice` | Claude (paid) |
| POST `/api/caddie/session/voice/stream` | `session_voice_stream` | Claude (paid) |
| POST `/api/caddie/voice` | `voice_caddie` | Claude (paid) |
| POST `/api/caddie/voice/stream` | `voice_caddie_stream` | Claude (paid) |
| POST `/api/caddie/course-intel` | `get_course_intel` | heavy fan-out (USGS/Open-Meteo/OSM), named in audit |
| POST `/api/caddie/session/recommend` | `session_recommend` | deterministic engine (NOT LLM) — included as compute-abuse defense; named in audit |
| POST `/api/caddie/recommend` | `get_recommendation` | deterministic engine (NOT LLM) — same |
| POST `/api/realtime/session` | `start_realtime_session` | paid orb-session mint |
| POST `/api/realtime/setup-session` | `start_setup_session` | paid orb-session mint |
| POST `/api/voice/speak` | `speak` | OpenAI TTS (paid), explicitly named |
| POST `/api/voice/parse-scores` | `parse_voice_scores` | Claude (paid) |
| POST `/api/voice/parse-round-setup` | `parse_round_setup` | Claude (paid) |
| POST `/api/voice/parse-scorecard` | `parse_scorecard` | Claude (paid) |
| POST `/api/voice/parse-transcript` | `parse_transcript` | Claude (paid) |

Note `/session/recommend` and `/recommend` are the **deterministic** engine (`generate_recommendation`
in `app/caddie/aim_point.py` — verified: no `anthropic`/Claude usage), not paid LLM. They are
included because the audit names them and a recommend bug-loop is a real CPU/DoS risk; sharing the
same generous bucket costs real golf nothing (recommend fires ~1/decision, already counted in the
RPM sizing).

**NOT limited (cheap/free — deliberately excluded):**
`/api/caddie/session/start`, `/session/end`, `/session/{id}` (status), `/session/shot`,
`/session/{id}/conditions`, `/session/{id}/player-profile`, `/session/message`, `/weather`
(free Open-Meteo), `/personalities` (GET/POST), `/profile` (GET/PUT), `/player-stats`
(deterministic), `/api/voice/telemetry`, `/api/voice/live-token`, `/api/voice/transcribe`.

**Follow-up (out of scope, note only):** `/api/voice/transcribe` (Deepgram STT) and
`/api/voice/live-token` are paid but on the critical per-utterance dictation path and not named in
this item; a Deepgram-spend limiter is a separate follow-up.

---

## 4. `current_user_id` composition (how the dep wires cleanly)

`backend/app/services/clerk_auth.py::current_user_id` is a FastAPI dependency that verifies the Clerk
JWT and returns the `sub` (user id), 401-ing on a bad/missing token when JWKS is configured. The
limiter dependency `caddie_rate_limited_user` itself `Depends(current_user_id)`, enforces the limit,
and returns that same id. Endpoints that previously wrote `user_id: str = Depends(current_user_id)`
simply switch to `Depends(caddie_rate_limited_user)` — the id they receive is identical, auth runs
exactly once (FastAPI caches the sub-dependency within a request), and no handler body changes.

Router-level `require_owner` (in `app/main.py`, `dependencies=_owner_only`) still runs — it also
depends on `current_user_id`, which FastAPI resolves once per request and shares. The limiter layers
cleanly beneath it.

---

## 5. The 429 response contract + frontend verification

**Contract:**
- **Status:** `429 Too Many Requests`.
- **Header:** `Retry-After: <int seconds>` — for an RPM rejection, `ceil(window_s - (now - oldest_ts))`
  (a few seconds); for a daily rejection, `ceil(seconds until next UTC midnight)`. Always `>= 1`.
- **Body:** standard FastAPI error object: `{"detail": "Easy — too many at once. Give me a sec and ask again."}`
  — short (<90 chars), in-character, no machine markers, no traceback/exception string.

**Frontend verification (read, confirmed):**

- `frontend/src/lib/api.ts::fetchAPI` on a non-2xx does `throw new Error(await res.text())` — i.e.
  the thrown message is the **raw JSON string** `{"detail":"..."}`.
- `frontend/src/lib/caddie/api.ts::postWithTimeout` treats only timeouts / `TypeError` as transient;
  a 429 is neither, so it re-throws the raw error to be judged by the humanizer.
- `frontend/src/lib/caddie/api.ts::streamCaddieReply` on `!res.ok` reads the body text and throws
  `BeforeFirstByteError(text)` — which is fallback-eligible, so the CaddieSheet ladder advances
  through its tiers (each also 429s), landing on the terminal non-stream call.
- `frontend/src/lib/caddie/dictation.ts::humanizeVoiceError` classifies any string that
  `startsWith("{")` **or** includes `"detail"` (or looks like a traceback, or is >90 chars) as
  "raw machine output" and returns the calm **fallback** instead.
- `frontend/src/components/CaddieSheet.tsx` (lines ~727, ~1013, ~1109) wraps every caddie error in
  `humanizeVoiceError(err.message, "<calm fallback>")`.

**Conclusion:** a 429's `{"detail":...}` body is caught by the `startsWith("{")` / `"detail"` guard
and rendered as the existing **calm fallback** ("Caddie unavailable — try again." on the sheet). The
golfer therefore already sees a calm, in-character-adjacent message and **never** the raw JSON or an
exception string. **No frontend change is required** — this keeps the item SILENT. The calm
`detail` string still lives in logs / curl / the future FE tweak.

**Optional (NOT recommended for this item; would make it non-silent):** if the owner later wants the
*specific* 429 copy to surface (instead of the generic fallback), the minimal tweak is to have the
error path parse a `{"detail": string}` body and pass `detail` (a short human sentence) to
`humanizeVoiceError` — which would then pass it through as-is. That touches `fetchAPI`/`postWithTimeout`/
`streamCaddieReply` and pulls in the frontend gates (§8); deferring it keeps this backend-only.

**Ladder note:** when rate-limited, the CaddieSheet ladder will fire up to 3 requests per question
(all rejected fast, no LLM call) before showing the calm fallback. Harmless (these are exactly the
requests being throttled and each is a cheap 429), but worth knowing.

---

## 6. Edge cases & risks

- **Unbounded memory (RPM dict).** `dict[user_id, deque]` grows one entry per distinct authenticated
  user; each deque holds at most `RPM` floats (<=30) within a 60 s window (tiny). Mitigations:
  (a) evict stale timestamps on every `check`; (b) after eviction, if a user's deque is empty, delete
  the key; (c) a soft cap `MAX_TRACKED_USERS` (e.g. 10,000) — when exceeded, sweep and drop users
  whose newest timestamp is older than `window_s`. User ids are authenticated Clerk subs (cannot be
  spoofed to inflate the map), so growth is bounded by real users. Even 10k users ~ a few MB.
- **Async-safety / locks.** All handlers are `async`. The RPM `check` is **fully synchronous**
  (no `await`) so it is atomic under the single-threaded event loop — no lock needed. The daily-store
  read-modify-write is also synchronous (small-file `_load`/`_save`, mirroring `FileBudgetStore`), so
  it too is atomic between awaits; for defense-in-depth against interleaved partial file writes,
  guard the daily RMW with a module-level `asyncio.Lock` held only for the microsecond-scale sync
  RMW — **never** across an `await`, network, or LLM call, so there is **no lock-contention DoS
  pivot**.
- **Fail-open paths.** Every internal exception (file unreadable, corrupt JSON, unexpected bug) ->
  log loudly + allow. Only `HTTPException(429)` escapes. `CADDIE_RATE_ENABLED=0` is a full
  kill-switch that still logs. A fresh container/deploy starts with an empty daily file (counter
  effectively resets) — acceptable: RPM still catches bursts, and a within-day loop is still caught.
- **Owner never silently degraded / owner exemption.** During the private beta the router-level
  `require_owner` means **the owner is the only user who can reach any endpoint at all** — so the
  only real bug-loop source *is* the owner's own client. **Recommendation: do NOT exempt the owner**
  (exempting = zero protection today). Instead expose `CADDIE_RATE_OWNER_MULTIPLIER` (default `1.0`,
  i.e. no special treatment) so the owner ceiling can be raised later without a code change, and
  **always log owner limit-hits at WARNING** so a triggered limit is visible (§7). This answers the
  "propose, don't assume" ask explicitly.
- **Clock / DST / "daily" boundary.** RPM uses `time.monotonic` (immune to wall-clock jumps/NTP/DST).
  The daily boundary is the **UTC calendar day** (mirrors `FileBudgetStore`), so DST transitions
  never double-count or skip a reset.
- **Multi-worker caveat (known limitation, do NOT build for it).** In-process RPM state is per-worker
  and the single JSON file has no cross-process lock. At `--workers 1` (current prod) this is
  **correct**. With `>= 2` workers the effective RPM becomes `RPM x workers` and the daily file can
  lose updates across processes. The `caddie-multiworker` item (audit P2 #10) must move to a shared
  store (Redis) before running `>= 2` workers. State it; do not build the shared path now.

---

## 7. Loud logging (owner-visible, voicetel/`_log_caddie_usage` style)

On **every** limit hit, log at `WARNING` via a dedicated logger (e.g.
`logging.getLogger("looper.ratelimit")`) with a greppable structured line, mirroring the
`_log_caddie_usage` / `voicetel` conventions in `backend/app/routes/caddie.py` and
`backend/app/routes/voice.py`:

```
log.warning(
    "ratelimit hit tier=%s user=%s count=%d limit=%d retry_after=%ds owner=%s",
    tier, user_id[:12], count, limit, retry_after, is_owner,
)
```

Fail-open events log at `ERROR` (`log.exception("ratelimit fail-open ...")`) so a broken limiter is
never silent. This guarantees a triggered limit is VISIBLE (`journalctl -u scorecard-api | grep
ratelimit`) — the owner is never silently degraded. Logging is wrapped so it can never break a
reply (same discipline as `_log_caddie_usage`).

---

## 8. Shared-types note

**Backend-only.** The 429 body is the standard FastAPI `{"detail": string}` error shape, already
handled generically by `frontend/src/lib/api.ts` and normalized calm by `humanizeVoiceError`. There
is **no `types.ts` <-> `models.py` change** and no new success-path field. The `Retry-After` header
is not consumed by the frontend today (available for a future backoff tweak). Confirmed: no shared
type touched, and no frontend file changes with the recommended (calm-fallback) approach.

---

## 9. Gates (exact) — all offline, no Postgres, no network

New `backend/tests/test_rate_limit.py`, using `tmp_path` for the file store, an **injectable clock**
(`Callable[[], float]`) and **injectable `now`** (`Callable[[], datetime]`) — no `time.sleep`, no DB,
no httpx. Mirrors the offline/injectable style of `tests/test_golfapi_cache.py`:

1. **RPM window boundary (deterministic):** with `RPM=N` and a fake clock, the Nth request in the
   window is allowed and the (N+1)th raises `HTTPException(429)`.
2. **Sliding-window recovery:** advance the fake clock past `window_s`; the next request is allowed
   again. Partial-expiry case: with some timestamps still inside the window, capacity is exactly
   `RPM - (still-in-window)`.
3. **429 shape + Retry-After:** the raised `HTTPException` has `status_code == 429`,
   `detail == _CALM_429_DETAIL` (short, no `{`/`"detail"`/traceback markers), and
   `headers["Retry-After"]` is a positive integer string (`<= window_s` for RPM;
   `<= 86400` for daily).
4. **Per-user isolation:** user A exhausting the window/day does not affect user B.
5. **Daily-budget cap + UTC rollover:** with an injectable `now`, hitting `CADDIE_RATE_DAILY_REQUESTS`
   raises 429; advancing `now` to the next UTC day resets the counter (allowed again). Round-trip:
   a fresh `FileDailyBudgetStore` pointed at the same `tmp_path` reads back the persisted count
   (survives "restart").
6. **Est-token cap:** accumulating past `CADDIE_RATE_DAILY_TOKENS` raises 429 independently of the
   request count.
7. **Fail-OPEN:** inject a `DailyBudgetStore` fake whose `get`/`add` raise -> `enforce` does **not**
   raise (request allowed) and logs (assert via `caplog`).
8. **Kill-switch:** `CADDIE_RATE_ENABLED=0` -> always allowed.
9. **Memory eviction:** after the window passes, a user's empty deque key is removed;
   `MAX_TRACKED_USERS` sweep drops stale users.
10. **Owner multiplier:** with `CADDIE_RATE_OWNER_MULTIPLIER=2.0`, the owner id gets 2x the ceiling;
    a non-owner still gets 1x.

Command gates:
- `cd backend && uv run pytest tests/test_rate_limit.py -q` (and the full `uv run pytest` to prove no
  regression — no DB needed for the limiter tests specifically).
- `cd backend && uv run ruff check .`

**Frontend gate:** none required — no frontend file changes in the recommended approach. (Only if the
owner opts into the optional §5 tweak: `npm run lint && npx tsc --noEmit && npx vitest run` covering
`src/lib/caddie/api.*.test.ts` and `src/components/CaddieSheet.*.test.tsx`, plus the voice-tests
smoke.)

---

## 10. Sequencing

1. Write `backend/app/services/rate_limit.py` (limiter + stores + dependency).
2. Write `backend/tests/test_rate_limit.py`; get all §9 unit gates green.
3. Wire `Depends(caddie_rate_limited_user)` into the §3 endpoints across
   `caddie.py` / `realtime.py` / `voice.py` / `voice_advanced.py`.
4. Add env vars to `backend/.env.example`; add `caddie_rate_limit.json` to gitignore.
5. Run `uv run ruff check .` and full `uv run pytest`.
6. Manual smoke (optional): set `CADDIE_RATE_RPM=2`, curl `/api/caddie/recommend` three times, confirm
   the 3rd returns 429 with `Retry-After`, and confirm the CaddieSheet shows the calm fallback.

## 11. Migration confirmation

**No Alembic migration is required or designed.** The daily counter survives restarts via a JSON file
modeled on `FileBudgetStore` (`backend/data/caddie_rate_limit.json`); the RPM state is intentionally
in-process. No new table, no schema change. Every part of this plan is implementable without touching
the guarded migrations directory.
