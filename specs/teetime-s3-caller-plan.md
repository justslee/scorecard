# Tee-time Slice S3 — AI pro-shop caller wiring + owner rehearsal-call harness

**Implementation plan** · specs: `specs/teetime-real-booking-plan.md` (S3), `specs/teetime-rehearsal-call-harness.md` (primary deliverable), `NORTHSTAR.md`

---

## 0. Honest scope statement (read first)

**Nothing dials today, and this slice does not change that.** `backend/app/services/voice_booking/telephony.py::get_live_transport()` raises `RuntimeError("voice booking disabled")` unless `VOICE_BOOKING_ENABLED=1` + full Twilio creds, and **even then raises `NotImplementedError`** — the Twilio Media-Streams ↔ OpenAI Realtime bridge has not shipped and is explicitly owner-gated (attorney sign-off). **The live bridge is OUT OF SCOPE for this PR.** This slice ships:

1. The **rehearsal endpoint** end-to-end up to the transport boundary — compliance gates run for real, the context is built for real, the transport is requested for real, and when the gate is off (or the bridge is unimplemented) the owner gets a clear structured "not enabled: <exact reason>" response instead of an error.
2. The **router wiring** so a `route=="call"` slot's `book()` flows through `VoiceCallProvider` (compliance-gated, allowlist-empty → always `needs_human`) instead of a plain S0 handoff — proving the wire without a dial.
3. A **frontend trigger** in Settings that fires the rehearsal and calmly renders transcript/outcome or the "not enabled" message.

When the bridge ships (next slice, "S3b"), the rehearsal endpoint works with **zero further changes** — the transport it requests starts returning a real transport instead of raising. Until then, the owner exercising the rehearsal button with full env set will see: *"Live calling is not enabled yet: live voice calls are owner-gated (TCPA attorney review + first supervised test call) — the telephony bridge ships with the live track."* That message is the honest truth and must be shown verbatim, not hidden.

---

## 1. The dial-safety invariant (reviewer checklist item #1)

> **No value from any HTTP request can ever become a dialed phone number.**
>
> - The rehearsal endpoint takes **no request body at all**. There is no field to smuggle a number through.
> - The dialed number AND the allowlist are both derived from exactly one server-side source: `os.getenv("VOICE_BOOKING_OWNER_NUMBER")`, normalized via `compliance.normalize_phone()`. Allowlist = `{that one number}`.
> - The normal `/book` path's numbers come from slots, but its allowlist is **empty** in this slice (`VoiceCallProvider(verified_lines=set())` default) — `is_verified_business_line` refuses every number before a transport is ever requested.
> - `GolferProfile` has **no phone field** (verified: `backend/app/models.py`); `SavedPlayer.phone` is user-editable data and is never read by any voice-booking code path. The harness spec's phrase "from profile" is implemented as *server config* precisely because profile-stored numbers are client-writable.

Tests in §6 assert this invariant mechanically.

---

## 2. Backend — router wiring (the `route=="call"` seam)

### 2.1 Seam decision: `RoutedTeeTimeProvider.book()`, not `RoutingTeeTimeProvider.book()`

Put the delegation in `backend/app/services/tee_times/router_provider.py::RoutedTeeTimeProvider.book()`. Rationale:

- `RoutingTeeTimeProvider` (S0) has a "byte-identical" contract pinned by `test_tee_time_routing.py` — leave that module untouched.
- `RoutedTeeTimeProvider` is the shipped default (`_get_provider()` in `routes/tee_times.py`) and already owns the composition pattern (`foreup_enabled` env-defaulted constructor flag, injected `foreup` provider). The voice route mirrors it exactly.

New dispatch order in `book()`:

```python
async def book(self, slot: TeeTimeSlot, details: BookingDetails) -> BookingResult:
    if slot.provider == "foreup":
        return await self._foreup.book(slot, details)          # unchanged, first
    if self._voice_enabled and slot.route == "call" and slot.phone:
        return await self._voice.book(slot, details)           # NEW
    return await super().book(slot, details)                   # exact S0 handoff
```

Constructor additions (mirroring the existing `foreup=`/`foreup_enabled=` pattern):

```python
def __init__(self, ..., voice: TeeTimeProvider | None = None,
             voice_enabled: bool | None = None) -> None:
    ...
    self._voice = voice or VoiceCallProvider()   # empty allowlist — refuses all
    self._voice_enabled = (voice_enabled if voice_enabled is not None
                           else os.getenv("VOICE_BOOKING_ENABLED") == "1")
```

**Why gate the delegation on `VOICE_BOOKING_ENABLED` here at all,** given `VoiceCallProvider` degrades gracefully anyway? Two reasons:

- **No behavior change while disabled.** `VoiceCallProvider.book()` returns `needs_human` with a *different message* ("Can't place an AI call (…)") than S0's ("Call or visit {course} to book — no online booking link is available."). With the flag off (the default everywhere today), `/book` on a call-route slot stays **byte-identical** to S0 — existing tests and UX untouched.
- **No network side effect.** `VoiceCallProvider.book()` may call `lookup_course_phone()` (a Google Places HTTP hit). The default book path must not grow a network call for a feature that is off.

**`verified_lines` in the normal path stays empty in this slice.** `VoiceCallProvider()` is constructed with its safe default (`verified_lines or set()` → refuse everything). Even with `VOICE_BOOKING_ENABLED=1`, every real-course book attempt returns `needs_human` with the compliance reason — correct until the owner verifies an actual pro-shop landline. Add a `TODO(S3b): load owner-verified lines from VOICE_BOOKING_VERIFIED_LINES (comma-separated) once a real line is verified + attorney sign-off` comment; do **not** build the loader now.

### 2.2 Fix the `time=""` window hole (the TODO already in `provider.py`)

Routing slots carry `time=""` by design (S0: never fabricate a time), but `VoiceCallProvider.book()` builds `time_window_start=slot.time` and calls `_window_end(slot.time)` — `int("")` raises `ValueError` → the route 502s. The wiring makes this path reachable for the first time, so fix it in this slice:

1. **`backend/app/services/tee_times/base.py`** — extend `BookingDetails` with optional window fields (the golfer's *requested* window from the search, honest data, not fabrication):
   ```python
   time_window_start: str | None = None   # "HH:MM" 24h — from the search query
   time_window_end: str | None = None
   ```
2. **`backend/app/services/voice_booking/provider.py::book()`**:
   - Prefer the slot's already-discovered phone over a fresh Places hit: `phone = slot.phone or await self._phone_lookup(slot.course_name, slot.city or None)`.
   - Window resolution: `start = slot.time or details.time_window_start or ""`; `end = (_window_end(slot.time) if slot.time else (details.time_window_end or ""))`. **If `start` is empty, refuse before the gates**: return `needs_human` with message "No requested time window for a phone booking — call {course} to book." (never guess a time; guard placed before `_window_end` so it can never see `""`). Delete/resolve the existing `TODO(S3)` comment.
3. **`backend/app/routes/tee_times.py::book_tee_time`** — parse the two optional fields from `details_data` into `SvcBookingDetails`.
4. **Frontend sync** (§4.3): `BookingDetails` in `frontend/src/lib/teetime/types.ts` gains `timeWindowStart?/timeWindowEnd?`; the tee-time page passes the searched window when booking. (Wire format: the backend reads `details_data.get("timeWindowStart")` — keep camelCase on the wire like every other `details` field.)

---

## 3. Backend — the rehearsal endpoint (primary deliverable)

### 3.1 Endpoint

**`POST /api/tee-times/rehearsal-call`** in `backend/app/routes/tee_times.py`.

- **No request body.** (See invariant §1. A POST with an empty body is valid.)
- **Auth:** the router is already registered owner-only (`main.py` — `app.include_router(tee_times.router, dependencies=_owner_only)`), **and** the endpoint declares `owner_id: str = Depends(require_owner)` explicitly (import `require_owner` from `app.services.clerk_auth`) — defense in depth, and it documents intent at the endpoint.

```python
@router.post("/rehearsal-call", response_model=RehearsalCallResponse)
async def rehearsal_call(owner_id: str = Depends(require_owner)) -> RehearsalCallResponse:
```

### 3.2 Config source

- `VOICE_BOOKING_OWNER_NUMBER` — the owner's own E.164 number. Read with `os.getenv` **at request time** (monkeypatch-friendly, matches `_get_provider()`'s style), normalized via `normalize_phone()`.
  - Unset **or** fails normalization → `raise HTTPException(503, "Rehearsal calling is not configured: set VOICE_BOOKING_OWNER_NUMBER to the owner's E.164 number.")` (503-for-unconfigured matches `clerk_auth.py`'s convention).
- `VOICE_BOOKING_OWNER_NAME` — optional, default `"the Looper owner"`; only feeds `golfer_name` in the disclosure line ("calling on behalf of …"). Cosmetic, never dialed.
- `VOICE_BOOKING_REHEARSAL_TZ` — optional, default `"America/New_York"`; feeds `course_tz` so the 8am–9pm calling-hours gate runs against the owner's local clock.

### 3.3 Context construction (pure helper, unit-testable)

Module-level pure function in `routes/tee_times.py` (prefer the route file to keep the surface in one place, matching how `simulate_book_by_call` lives there):

```python
def _build_rehearsal_context(owner_number: str, owner_name: str, tz: str,
                             today: date | None = None) -> VoiceBookingContext:
```

Returns:
- `course_id="rehearsal"`, `course_name="Rehearsal Pro Shop"`
- `phone=owner_number` **and** `callback_number=owner_number` (the disclosure honestly names the owner's own number)
- `golfer_name=owner_name`
- `date` = next Saturday strictly after `today` (computed in `tz`; pure given `today`, so tests pin it)
- `time_window_start="09:00"`, `time_window_end="11:00"`, `party_size=1`, `max_price_usd=None`, `course_tz=tz`

### 3.4 Flow

```
owner_number = normalize_phone(os.getenv("VOICE_BOOKING_OWNER_NUMBER"))
  → None → 503 (clear message)
ctx = _build_rehearsal_context(owner_number, owner_name, tz)
gate = check_call_allowed(ctx, verified_lines={owner_number},
                          suppression=SuppressionList(), now=None)
  → not allowed → 200 {status:"refused", reason: gate.reason, transcript:[], …}
transport = (_rehearsal_transport_factory or telephony.get_live_transport)()
  → RuntimeError / NotImplementedError as exc
    → 200 {status:"not_enabled", reason: str(exc), transcript:[], …}
transcript, outcome = await transport.run_call(ctx)
log the transcript (log.info, one line per turn, speaker-tagged)  # text only — STORE_AUDIO stays False; no audio ever persisted
result = to_booking_result(outcome, ctx)
→ 200 {status:"completed", transcript, outcome, result}
```

Notes:
- **Refusals and the disabled gate are `200` with a structured status, not 4xx/5xx** — they are honest, expected outcomes the UI renders calmly (mirrors how `VoiceCallProvider` folds them into `BookingResult` instead of raising).
- **Testability seam:** module-level injectable, same pattern as `_search_cache`:
  ```python
  # Injectable for tests (SimulatedCallTransport) — None means the real,
  # owner-gated telephony.get_live_transport(). NEVER set in production code.
  _rehearsal_transport_factory: Callable[[], object] | None = None
  ```
  Tests do `monkeypatch.setattr(route_mod, "_rehearsal_transport_factory", lambda: SimulatedCallTransport("friendly"))`. Production never sets it, so the ONLY live-dial gate remains `telephony.get_live_transport()`.
- **Persistence: none in this slice.** Do **not** write a `TeeTimeBooking` row — a rehearsal is not a booking attempt against a course, and rows named "Rehearsal Pro Shop" would pollute `/bookings` (and the calm UI) with test noise. The spec's "captured and shown" is satisfied by: full transcript + outcome in the response, plus the server log line. If durable rehearsal history is ever wanted, that's a separate `voice_call_attempts` table decision — flag, don't build.
- **Suppression** is a fresh empty `SuppressionList()` per request (there is no persistent store yet — same as `VoiceCallProvider`'s default). If the owner role-plays "don't call me again", `outcome.opt_out_requested` comes back and is **included in the response** (`outcome.detail`/flag) but does not persist — acceptable for a self-call rehearsal; note it in the endpoint docstring.

### 3.5 Request/response models (add near the existing simulate models; **reuse** `CallTurnOut`, `CallOutcomeOut`, `BookingResultOut`)

```python
class RehearsalCallResponse(BaseModel):
    status: Literal["completed", "refused", "not_enabled"]
    reason: str | None = None            # gate/compliance text when not "completed"
    calleeNumber: str | None = None      # masked, e.g. "+1•••••••0199" — display only
    disclosure: str | None = None        # compliance.disclosure_line(ctx) preview
    transcript: list[CallTurnOut] = []
    outcome: CallOutcomeOut | None = None
    result: BookingResultOut | None = None
```

`calleeNumber` is masked (last 4 digits) purely so the owner can confirm *which* number would ring; include `disclosure` in every response (even `not_enabled`) so the owner can read exactly what the agent will say first — a nice, cheap confidence artifact.

---

## 4. Frontend — the owner trigger

### 4.1 Placement: Settings, not the tee-time page

`frontend/src/app/settings/page.tsx` already has quiet titled sections (Account / About / Local Cache). Add a **"Rehearsal call"** section there. Rationale (NORTHSTAR): the tee-time page is a golfer surface and must stay calm; a rehearsal is an owner/dev confidence check — Settings is the established quiet home for that. One serif section title, two sentences of explanation copy, a single understated button ("Place a rehearsal call"), and a results area. No dashboards, no new component libraries — reuse the existing section markup pattern in that file.

### 4.2 Behavior

- Button → `POST /api/tee-times/rehearsal-call` (via `fetchAPI`, which attaches the Clerk bearer) → pending state ("Calling…") → render by `status`:
  - `not_enabled` / `refused` → show `reason` verbatim as quiet body text (e.g. "Live calling is not enabled yet: …"). **This is the state every owner sees today** — it must read as informative, not broken.
  - `completed` → show the `disclosure` line, then the transcript as a simple two-voice list (small-caps "AGENT"/"SHOP" labels, plain text — printed-transcript feel, matches the yardage-book aesthetic), then the outcome sentence from `result.message`.
  - HTTP 503 (unconfigured) → show the error detail ("set VOICE_BOOKING_OWNER_NUMBER…").
- Degrades gracefully offline: `fetchAPI` failure → one quiet error line.

### 4.3 Files

- `frontend/src/lib/teetime/types.ts` — add `RehearsalCallResponse`, `RehearsalCallTurn`, `RehearsalCallOutcome` interfaces (mirror §3.5, camelCase — flag: **shared-type sync** with the backend Pydantic models; also add `timeWindowStart?/timeWindowEnd?` to `BookingDetails` per §2.2).
- `frontend/src/lib/teetime/client.ts` — add `export async function placeRehearsalCall(): Promise<RehearsalCallResponse>` (POST, no body, no mock fallback — rethrow on failure, honest miss).
- `frontend/src/app/settings/page.tsx` — the section + a small local component for the transcript list (inline in the file, matching its existing style).
- `frontend/src/app/tee-time/page.tsx` — only the §2.2 detail-passing change (add the searched window to the `BookingDetails` it sends). No rehearsal UI here.

---

## 5. Safety wiring summary (wire, never weaken)

| Rail | Where | This slice |
|---|---|---|
| Live-dial gate | `telephony.get_live_transport()` (VOICE_BOOKING_ENABLED + Twilio creds; NotImplemented until bridge) | Untouched — remains the ONE place a live transport can come from |
| Owner-only trigger | `main.py` router-level `require_owner` + explicit endpoint `Depends(require_owner)` | Doubled, not moved |
| Allowlist | `check_call_allowed` / `is_verified_business_line` | Rehearsal: `{owner env number}` exactly; normal book path: empty set (refuse all) |
| Disclosure-first | `dialog.py` (enforced) + `disclosure_line` | Untouched; previewed in the response |
| Calling hours + suppression | `compliance.check_call_allowed` | Runs on every rehearsal (`course_tz` = owner's tz) |
| No card capture | `dialog.py` (refuses; `card_required` → needs_human) | Untouched |
| No audio storage | `STORE_AUDIO=False` constant | Untouched; rehearsal logs TEXT transcript only |
| CI-safe simulator | `/book-by-call/simulate` | Untouched — stays the CI test surface |

Per `CLAUDE.md`, this adds a new endpoint → run `/security-review` (and `/code-review`) before the PR is ready.

---

## 6. Tests (all CI-safe; NEVER live-dial — mechanism stated per test)

New file `backend/tests/test_rehearsal_call.py` + additions to `backend/tests/test_tee_time_router.py`. No Postgres anywhere (the endpoint touches no DB). Two harness styles, both already established in this repo:

- **Direct route-function calls + `monkeypatch` on module attrs** — the pattern of `test_tee_time_provider_default.py`.
- **ASGI client with `app.dependency_overrides[current_user_id]`** — only for the auth test (pattern exists in `test_voice_stream.py` / `test_course_search.py`).

### Rehearsal endpoint

1. **Owner-auth enforced** — ASGI client against `app.main.app`; `monkeypatch.setattr(clerk_auth, "OWNER_CLERK_USER_ID", "owner_1")`; `app.dependency_overrides[current_user_id] = lambda: "intruder"` → `POST /api/tee-times/rehearsal-call` → **403**. No telephony: rejected before the handler body runs.
2. **Unconfigured refusal** — `monkeypatch.delenv("VOICE_BOOKING_OWNER_NUMBER", raising=False)`; call `rehearsal_call(owner_id="owner_1")` directly → `HTTPException 503`, detail names the env var. Also set `_rehearsal_transport_factory` to a sentinel that raises `AssertionError` if called → proves no transport is even requested.
3. **Dial-safety invariant** — set `VOICE_BOOKING_OWNER_NUMBER="+1 (415) 555-0199"`; inject a capturing fake transport (`run_call` records `ctx`, returns `([], CallOutcome(result="unclear"))`). Assert `ctx.phone == "+14155550199"` and `ctx.callback_number == "+14155550199"`. Companion static assertions: the endpoint signature takes **no request model** (`inspect.signature` has only the auth dependency), and via the ASGI client, POSTing a hostile body `{"phone": "+19998887777", "calleeNumber": "+19998887777"}` still yields `ctx.phone == owner number` (body ignored). No telephony: injected transport.
4. **Compliance actually gates** — env number set; `monkeypatch.setattr(route_mod, "check_call_allowed", lambda *a, **k: ComplianceCheck(False, "test reason"))` → `status=="refused"`, `reason=="test reason"`, transcript empty, factory-sentinel not called. Plus one real-gate case: `VOICE_BOOKING_OWNER_NUMBER="123"` (unnormalizable) → 503.
5. **Gated response, disabled** — env number set; `_rehearsal_transport_factory` left `None`; `monkeypatch.delenv("VOICE_BOOKING_ENABLED", …)` → `status=="not_enabled"`, reason contains "voice booking disabled". Exercises the **real** `get_live_transport()` `RuntimeError` path.
6. **Gated response, enabled-but-unshipped bridge** — set `VOICE_BOOKING_ENABLED=1` + dummy `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER` → `status=="not_enabled"`, reason contains "owner-gated"/"telephony bridge". Exercises the real `NotImplementedError` path — still zero network.
7. **Full happy path via simulator** — env number set; `_rehearsal_transport_factory = lambda: SimulatedCallTransport("friendly")` → `status=="completed"`; first **agent** turn in the transcript contains "automated AI assistant" (disclosure-first); `outcome.result=="booked"`; `result.status=="confirmed"`; `disclosure` and masked `calleeNumber` present. No telephony: simulated transport end-to-end.
8. **`_build_rehearsal_context` purity** — pinned `today` → next-Saturday date math (incl. "today is Saturday" → next week), tz default, party of 1.

### Router wiring (`test_tee_time_router.py` additions)

9. **Disabled = byte-identical S0** — `RoutedTeeTimeProvider(voice_enabled=False)` (and default env-off), `route=="call"` slot with phone → `book()` returns the exact S0 message ("Call or visit … no online booking link is available."). Proves the honest-handoff default is unchanged.
10. **Enabled + empty allowlist = needs_human without a dial** — `RoutedTeeTimeProvider(voice_enabled=True, voice=VoiceCallProvider(transport=_ExplodingTransport(), verified_lines=set()))` where `_ExplodingTransport.run_call` raises `AssertionError` → result `needs_human`, message contains "not an owner-verified business landline", transport **never invoked**. No telephony: gates refuse before any transport use; slot carries a phone so `lookup_course_phone` is never hit (assert via a phone_lookup fake that raises).
11. **Dispatch precedence** — foreup slot still → `foreup.book`; `route=="book_on_site"` slot with `voice_enabled=True` still → S0 super().
12. **Window derivation (`VoiceCallProvider`, in `test_voice_booking.py`)** — `slot.time=""` + `details.time_window_start/end` set → ctx window from details (use a verified line + fake transport to reach ctx capture); `slot.time=""` + no details window → `needs_human` "no requested time window", no gate/transport touched; `slot.phone` present → injected `phone_lookup` (raising fake) not called.
13. **Existing suites stay green** — `test_voice_booking.py`, `test_tee_time_routing.py`, `test_tee_time_router.py`, `test_tee_time_provider_default.py` unmodified assertions all pass.

---

## 7. Gates (run before "done")

```
cd backend && ruff check .
cd backend && uv run pytest tests/test_rehearsal_call.py tests/test_voice_booking.py \
    tests/test_tee_time_router.py tests/test_tee_time_routing.py \
    tests/test_tee_time_provider_default.py
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npx tsx voice-tests/runner.ts --smoke
```

No docker / no local Postgres — every backend test above is pure/route-level (monkeypatch + dependency_overrides). DB-backed suites run in CI as usual. Then `/security-review` + `/code-review` (new endpoint ⇒ required by CLAUDE.md).

---

## 8. Owner setup note (put verbatim in the PR description / endpoint docstring)

To receive a real rehearsal call, the owner sets on the backend:

```
VOICE_BOOKING_ENABLED=1
TWILIO_ACCOUNT_SID=…       TWILIO_AUTH_TOKEN=…       TWILIO_FROM_NUMBER=+1…
VOICE_BOOKING_OWNER_NUMBER=+1XXXXXXXXXX     # his own verified E.164 — the ONLY dialable number
VOICE_BOOKING_OWNER_NAME="Justin"           # optional, spoken in the disclosure
VOICE_BOOKING_REHEARSAL_TZ=America/New_York # optional
```

**However — honest status:** even fully configured, the phone will **not ring after this PR**, because the Twilio↔Realtime bridge in `telephony.py` is deliberately `NotImplementedError` (owner-gated live track). The rehearsal button will return the exact owner-gated message explaining that. Shipping the bridge (Twilio Media Streams ↔ realtime agent, honoring `STORE_AUDIO=False`, reusing the caddie's realtime relay) is the follow-up slice **S3b**; when it lands, this harness rings the owner's phone with zero endpoint changes. Rehearsal-to-self needs no attorney sign-off (allowlist of one, self-consented); dialing any real pro shop still does.

## 9. Implementation order

1. `base.py` `BookingDetails` window fields → `provider.py` (slot-phone preference, window resolution, empty-window refusal, drop the TODO) + `test_voice_booking.py` additions.
2. `router_provider.py` voice seam + `test_tee_time_router.py` additions.
3. `routes/tee_times.py` rehearsal endpoint (+ `_build_rehearsal_context`, `_rehearsal_transport_factory`, models, book-route window parsing) + `test_rehearsal_call.py`.
4. Frontend: `types.ts` sync → `client.ts` → settings section → tee-time page detail-passing.
5. Gates, `/security-review`, `/code-review`.
