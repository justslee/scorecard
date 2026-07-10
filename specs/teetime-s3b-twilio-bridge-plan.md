# Tee Times S3b — Twilio ↔ OpenAI Realtime live-transport bridge — Implementation Plan

Branch: `feat/teetime-s3-caller` (worktree `.claude/worktrees/agent-a594409eae41bedd2`).
Predecessor: S3 rehearsal-call harness (PR #124, `specs/teetime-s3-caller-plan.md`,
`specs/teetime-rehearsal-call-harness.md`). This slice implements the ONE thing S3
deliberately left `NotImplementedError`: `telephony.get_live_transport()` — the live
outbound-dial bridge that makes the rehearsal button actually ring the owner's phone.

## 1. Goal

Implement a `LiveCallTransport` with the SAME transport interface the simulator
implements —

```python
async def run_call(ctx: VoiceBookingContext) -> tuple[list[CallTurn], CallOutcome]
```

— that places a Twilio outbound call to `ctx.phone`, bridges the call audio over a
Twilio Media Streams WebSocket to an OpenAI Realtime (GA, `gpt-realtime`) session which
IS the conversational agent, and returns a text transcript + structured `CallOutcome`.
Consumers (`VoiceCallProvider.book()` in
`backend/app/services/voice_booking/provider.py`, the rehearsal route in
`backend/app/routes/tee_times.py`) do not change: they already call
`telephony.get_live_transport()` and treat `RuntimeError` as a calm
`not_enabled`/`needs_human`.

### Non-goals
- No change to the simulator, `BookingDialog`, compliance gates, or the rehearsal
  route's response shape. The text simulator + `test_rehearsal_call.py` happy path
  remain the higher-level CI test.
- No audio persistence, no recordings, no new frontend work.
- No multi-worker/token-store-in-Redis work (documented single-worker assumption, §7).

## 2. Files to create / modify

CREATE
- `backend/app/services/voice_booking/call_registry.py` — single-use call-token
  registry (`CallTokenRegistry`, `PendingCall`).
- `backend/app/services/voice_booking/media_bridge.py` — the Twilio↔OpenAI bridge
  loop + Realtime session config + agent instructions + `record_booking_outcome` tool.
- `backend/app/routes/voice_booking_ws.py` — the public (token-guarded) media-stream
  WebSocket route.
- `backend/tests/test_telephony_bridge.py` — TwiML, dial construction, registry,
  `get_live_transport` gating.
- `backend/tests/test_media_bridge.py` — bridge forwarding, disclosure-first,
  transcript accumulation, tool→outcome mapping.
- `backend/tests/test_voice_booking_ws.py` — WS-route refusals via TestClient.

MODIFY
- `backend/app/services/voice_booking/telephony.py` — delete the
  `NotImplementedError`; add `build_stream_twiml()`, `LiveCallTransport`, rewrite
  `get_live_transport()`.
- `backend/app/main.py` — mount `voice_booking_ws.router` WITHOUT `_owner_only`
  (deliberate; see §6) with a loud comment.
- `backend/pyproject.toml` — add `twilio>=9.0.0`, `websockets>=12.0`.
- `backend/tests/test_rehearsal_call.py` — update
  `test_not_enabled_when_bridge_unimplemented` (see §8.7 — legitimate behavior change,
  the bridge shipped).
- `backend/tests/test_voice_booking.py` — update
  `TestTelephonyStub::test_enabled_with_creds_is_still_not_implemented` (same reason;
  this second stub-encoding test at tests/test_voice_booking.py:560 was not listed in
  the original ask but exists and will fail otherwise).
- `backend/app/services/voice_booking/__init__.py` — refresh the docstring line that
  says "telephony.py is a stub".

## 3. Architecture (call flow)

```
rehearsal route ──> get_live_transport() ──> LiveCallTransport.run_call(ctx)
                                               │ 1. token = registry.mint(ctx)
                                               │ 2. Twilio REST create call (to=ctx.phone,
                                               │    from_=TWILIO_FROM_NUMBER, twiml=<Connect><Stream
                                               │    url="wss://{PUBLIC_HOST}/api/voice-booking/media-stream/{token}">)
                                               │ 3. await pending.future (timeout)
                                               ▼
owner's phone rings ──> Twilio opens WS ──> /api/voice-booking/media-stream/{token}
                                               │ validate+consume token (else close 1008)
                                               │ open OpenAI Realtime WS (server-side, full OPENAI_API_KEY)
                                               │ session.update: audio/pcmu in+out, instructions, tool
                                               │ on Twilio "start": force disclosure-first greeting
                                               │ bridge: Twilio media → input_audio_buffer.append
                                               │         response.output_audio.delta → Twilio media
                                               │ accumulate TEXT transcript; agent calls
                                               │ record_booking_outcome → CallOutcome
                                               ▼
                              pending.future.set_result((transcript, outcome))
                                               ▼
run_call returns → route logs text turns → to_booking_result → RehearsalCallResponse
```

The OpenAI Realtime model IS the agent on this path (the Twilio-blog pattern). The
deterministic `BookingDialog` heuristics are NOT duplicated into the bridge; its rules
are encoded once as session instructions (§5.4) and its terminal contract is reused via
the existing `CallOutcome`/`CallTurn` types and `outcome.to_booking_result`.

## 4. Wire protocols (confirmed 2026-07 against the Twilio outbound-calls blog post,
Twilio Media Streams WebSocket-messages docs, and this repo's GA usage in
`backend/app/services/realtime_relay.py` / `frontend/src/lib/voice/realtime.ts`)

### 4.1 Twilio Media Streams (bidirectional — requires `<Connect><Stream>`)
Twilio → server messages (JSON text frames):
- `{"event": "connected", "protocol": "Call", "version": "1.0.0"}`
- `{"event": "start", "sequenceNumber": "1", "start": {"streamSid": "MZ…", "callSid":
  "CA…", "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1},
  "customParameters": {}}}`
- `{"event": "media", "streamSid": "MZ…", "media": {"track": "inbound", "chunk": "1",
  "timestamp": "5", "payload": "<base64 μ-law>"}}`
- `{"event": "stop", …}` (also `mark`, `dtmf` — ignore).

Server → Twilio (outbound audio): `{"event": "media", "streamSid": "MZ…",
"media": {"payload": "<base64 μ-law>"}}`. Optional barge-in flush:
`{"event": "clear", "streamSid": "MZ…"}`.

### 4.2 OpenAI Realtime GA (NOT the removed beta naming)
- WS URL: `wss://api.openai.com/v1/realtime?model=gpt-realtime`, header
  `Authorization: Bearer $OPENAI_API_KEY`. Model/env names follow
  `realtime_relay.py` (`OPENAI_REALTIME_MODEL`, default `gpt-realtime`).
- `session.update` uses the GA nesting (`session.type: "realtime"`,
  `audio.input` / `audio.output`) exactly like `build_session_payload()`. μ-law is the
  GA format object `{"type": "audio/pcmu"}` on `audio.input.format` and
  `audio.output.format`. ⚠️ Drift note: `g711_ulaw` and `input_audio_format` are the
  REMOVED beta names — do not use them; the fetched Twilio blog (updated for GA)
  confirms `{"type": "audio/pcmu"}` and `response.output_audio.delta`.
- Audio in: `{"type": "input_audio_buffer.append", "audio": "<base64 payload>"}` —
  Twilio's `media.payload` passes through UNTRANSCODED (both sides are 8kHz μ-law).
- Audio out: `{"type": "response.output_audio.delta", "delta": "<base64>"}`.
- Transcripts (same names the frontend already handles in `realtime.ts`):
  agent = `response.output_audio_transcript.done` (`.delta` ignored; `done` carries the
  full utterance) → `CallTurn(speaker="agent", …)`;
  shop = `conversation.item.input_audio_transcription.completed` →
  `CallTurn(speaker="shop", …)`. Input transcription is enabled in the session config
  (`audio.input.transcription: {"model": "gpt-4o-transcribe", "language": "en"}`,
  mirroring `realtime_relay.py`).
- Tool call: `response.function_call_arguments.done` (carries `name`, `call_id`,
  `arguments` JSON string) — same event the frontend dispatches on.
- Greeting forcing: `conversation.item.create` (role `user`, `input_text` content)
  followed by `response.create` — sent once, on Twilio `start`, BEFORE any media is
  forwarded, so the model "goes first".

## 5. Component design

### 5.1 `call_registry.py` — `CallTokenRegistry`
Small, pure-ish, fully unit-testable class with an injectable clock.

```python
@dataclass
class PendingCall:
    ctx: VoiceBookingContext
    future: asyncio.Future            # resolves to (list[CallTurn], CallOutcome)
    transcript: list[CallTurn]        # live accumulator (partial on timeout)
    expires_at: float                 # monotonic deadline for the WS to connect

class CallTokenRegistry:
    def __init__(self, connect_ttl_seconds: float = 120.0, now=time.monotonic): ...
    def mint(self, ctx: VoiceBookingContext) -> tuple[str, PendingCall]: ...
    def consume(self, token: str) -> PendingCall | None: ...   # pop = single-use
    def discard(self, token: str) -> None: ...                 # cleanup on dial failure/timeout
```

- Token: `secrets.token_urlsafe(32)` (256 bits — unguessable).
- `consume()` pops the entry (single-use by construction) and returns `None` when the
  token is unknown, already consumed, or `expires_at` has passed (expired entries are
  purged opportunistically on every mint/consume). No background task needed.
- Module-level singleton `registry = CallTokenRegistry()` shared by `telephony.py`
  (mint) and `voice_booking_ws.py` (consume). Tests construct their own instances.
- Resolution guard: whoever resolves calls
  `if not pending.future.done(): pending.future.set_result(...)` — the run_call
  timeout and the WS handler can race.

### 5.2 `telephony.py` — `build_stream_twiml`, `LiveCallTransport`, `get_live_transport`

```python
def build_stream_twiml(public_host: str, call_token: str) -> str:
    # <Response><Connect><Stream url="wss://{host}/api/voice-booking/media-stream/{token}"/></Connect></Response>
```
Pure string builder (plain XML f-string; no twilio import needed). `<Connect>` (not
`<Start>`) — bidirectional media. Strips any scheme/trailing slash from
`public_host`. Contains NO secrets — host + token only.

```python
class LiveCallTransport:
    def __init__(self, *, twilio_client_factory,
                 public_host: str, from_number: str,
                 registry: CallTokenRegistry = registry,
                 call_timeout_seconds: float = 300.0) -> None: ...
    async def run_call(self, ctx) -> tuple[list[CallTurn], CallOutcome]: ...
    def _place_call(self, to_number: str, twiml: str) -> str:   # sync; returns call SID
```

`run_call(ctx)`:
1. `to_number = normalize_phone(ctx.phone)` (from `compliance.py`). If `None`, return
   `([], CallOutcome(result="unclear", detail="no dialable number — refusing to dial"))`
   — never raise mid-call-path, never dial. The transport reads ONLY `ctx.phone`;
   there is no request object anywhere near this class (dial-safety, §6).
2. `token, pending = self._registry.mint(ctx)`.
3. `twiml = build_stream_twiml(self._public_host, token)`.
4. Twilio's REST client is SYNC → `call_sid = await asyncio.to_thread(self._place_call,
   to_number, twiml)`. `_place_call` does
   `self._twilio_client_factory().calls.create(to=to_number, from_=self._from_number,
   twiml=twiml)` and returns `call.sid`. On exception: `registry.discard(token)`;
   return `([], CallOutcome(result="no_answer", detail="outbound call could not be
   placed"))` — log `type(exc).__name__` only, never the message wholesale into user
   output and NEVER credentials.
5. `try: transcript, outcome = await asyncio.wait_for(pending.future,
   self._call_timeout_seconds)` — the WS handler resolves it.
   `except (asyncio.TimeoutError, asyncio.CancelledError):` → `registry.discard(token)`;
   best-effort hangup `await asyncio.to_thread(lambda:
   client.calls(call_sid).update(status="completed"))` (swallow errors); return
   `(list(pending.transcript), CallOutcome(result="unclear", detail="call timed out"))`
   — partial transcript, honest outcome.
6. Return `(transcript, outcome)`.

`twilio_client_factory` is INJECTED so tests never touch the network. The transport
itself never talks to OpenAI — the OpenAI WS factory is a separate module-level hook in
`voice_booking_ws.py` (`_openai_ws_factory`, §5.4), monkeypatchable in tests the same
way `tee_times._rehearsal_transport_factory` is.

```python
def get_live_transport():
```
New gating ladder (replaces the `NotImplementedError` terminal):
1. `VOICE_BOOKING_ENABLED != "1"` → `RuntimeError("voice booking disabled")`
   (unchanged text — existing tests match on it).
2. Missing any of `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` →
   `RuntimeError("voice booking disabled — missing credentials: …")` (unchanged).
3. Missing `VOICE_BOOKING_PUBLIC_HOST` → NEW
   `RuntimeError("voice booking disabled — missing VOICE_BOOKING_PUBLIC_HOST (public
   TLS host Twilio connects to for the media stream)")`.
4. Else → construct and return
   `LiveCallTransport(twilio_client_factory=<lazy `from twilio.rest import Client`;
   Client(sid, token)>, public_host=…, from_number=…)`.
   Construction performs NO network I/O (twilio's `Client(...)` is offline), so the
   route's `factory()` call stays dial-free; the ONLY dial is inside `run_call`.

The route's existing `except (RuntimeError, NotImplementedError)` in `tee_times.py`
and `provider.py` needs no change (RuntimeError is still caught; keep the tuple as-is).

### 5.3 `media_bridge.py` — session config, instructions, tool, bridge loop

```python
RECORD_BOOKING_OUTCOME_TOOL: dict            # GA tool schema, name="record_booking_outcome"
def build_realtime_call_instructions(ctx: VoiceBookingContext) -> str: ...
def build_call_session_update(ctx: VoiceBookingContext) -> dict: ...
def outcome_from_tool_args(args: dict) -> CallOutcome: ...
async def run_media_bridge(twilio_ws, openai_ws, pending: PendingCall) -> None: ...
```

- `build_call_session_update(ctx)` returns the full `{"type": "session.update",
  "session": {…}}` dict: `type: "realtime"`, `model: OPENAI_REALTIME_MODEL`,
  `output_modalities: ["audio"]`, `audio.input.format {"type": "audio/pcmu"}`,
  `audio.input.transcription {"model": OPENAI_REALTIME_TRANSCRIBE_MODEL, "language": "en"}`,
  `audio.input.turn_detection {"type": "server_vad"}` (defaults; phone audio),
  `audio.output.format {"type": "audio/pcmu"}`, `audio.output.voice`
  (`OPENAI_REALTIME_DEFAULT_VOICE`), `instructions:
  build_realtime_call_instructions(ctx)`, `tools: [RECORD_BOOKING_OUTCOME_TOOL]`,
  `tool_choice: "auto"`. Pure function → unit-testable with zero network.
- `build_realtime_call_instructions(ctx)` REUSES `compliance.disclosure_line(ctx)` and
  encodes the `BookingDialog` rules as prose (single source: the rules list in
  `dialog.py`'s docstring), verbatim requirements:
  1. FIRST words to the human are EXACTLY `disclosure_line(ctx)` — never skipped, never
     paraphrased (the greeting is also force-fed, §5.3 bridge step 3 — belt and braces).
  2. The ask: date `ctx.date`, window `ctx.time_window_start`–`ctx.time_window_end`
    (spoken 12-hour), party of `ctx.party_size`, under `ctx.max_price_usd` per player
    when set.
  3. NEVER provide payment or any card number; if a card is required to hold, offer to
     hold under `ctx.golfer_name` with callback `ctx.callback_number`; if the shop
     insists, end politely and record `card_required`.
  4. Accept a time ONLY inside the window and under the ceiling; ask once for an
     alternative, then end honestly (`no_availability`).
  5. Voicemail → end immediately, record `voicemail` (never leave the booking on a
     machine). Opt-out ("take us off your list") → apologize, end, record with
     `opt_out_requested=true`.
  6. Before hanging up, ALWAYS call `record_booking_outcome` exactly once with the
     structured result. Keep the call short; be polite and honest; invent nothing.
- `RECORD_BOOKING_OUTCOME_TOOL` parameters mirror `CallOutcome` exactly:
  `result` (enum: booked | no_availability | voicemail | no_answer | card_required |
  unclear — the `CallResult` literal), `date`, `time`, `party_size`,
  `confirmation_number`, `cost_usd`, `detail`, `opt_out_requested`. Required: `result`.
- `outcome_from_tool_args(args)` → `CallOutcome`, defensive: unknown `result` values
  coerce to `"unclear"`; extraneous keys dropped; types coerced (int/float/bool).
- `run_media_bridge(twilio_ws, openai_ws, pending)` — the bridge loop, duck-typed on
  both sockets so tests pass fakes (`twilio_ws`: FastAPI WebSocket-ish
  `receive_json()/send_json()`; `openai_ws`: websockets-ish async `send(str)`/`recv()`
  or async-iterator). Behavior contract:
  1. Send `build_call_session_update(pending.ctx)` to OpenAI FIRST.
  2. Consume Twilio events; ignore `connected`; on `start` capture
     `msg["start"]["streamSid"]`.
  3. Immediately after `start` — BEFORE forwarding any media — send the forced
     greeting: `conversation.item.create` (role user, `input_text`: "The call has just
     connected. Speak first. Your first words must be exactly: \"<disclosure_line(ctx)>\"
     — then ask about the tee time.") followed by `{"type": "response.create"}`.
  4. Then run two tasks concurrently (`asyncio.gather` / `TaskGroup`):
     - Twilio→OpenAI: each `media` event →
       `{"type": "input_audio_buffer.append", "audio": payload}`; `stop` event or
       WebSocketDisconnect → finish.
     - OpenAI→Twilio: `response.output_audio.delta` → Twilio `media` message with the
       captured `streamSid`; `response.output_audio_transcript.done` →
       `pending.transcript.append(CallTurn("agent", text))`;
       `conversation.item.input_audio_transcription.completed` →
       `pending.transcript.append(CallTurn("shop", text))`;
       `response.function_call_arguments.done` with `name == "record_booking_outcome"`
       → `outcome_from_tool_args(json.loads(arguments))` stored; then send
       `conversation.item.create` `function_call_output` (`{"ok": true}` with the
       event's `call_id`) + `response.create` so the model can say its goodbye;
       OPTIONAL barge-in: `input_audio_buffer.speech_started` → Twilio
       `{"event": "clear", "streamSid": …}` (nice-to-have, not gating).
  5. `finally`: resolve `pending.future` (guarded on `done()`) with
     `(pending.transcript, recorded_outcome or CallOutcome(result="unclear",
     detail="call ended without a recorded outcome"))`; close the OpenAI WS.
  - NO audio is buffered beyond in-flight frames, NO audio written anywhere
    (`compliance.STORE_AUDIO` stays `False` — reference it in a comment/assert), no
    payload or secret ever logged (log event TYPES at debug only).

### 5.4 `voice_booking_ws.py` — the WS route (public surface; token is the guard)

```python
router = APIRouter()

@router.websocket("/api/voice-booking/media-stream/{call_token}")
async def media_stream(websocket: WebSocket, call_token: str) -> None: ...
```

- ⚠️ SECURITY-SENSITIVE, DELIBERATELY NOT owner-gated: Twilio's media WebSocket cannot
  present the owner's Clerk JWT. The ONLY guard is the single-use, 256-bit, expiring
  `call_token` bound to a call this server itself minted seconds earlier. Every refusal
  path closes without ever relaying audio. This must be stated in a comment block at
  the top of the file AND at the `main.py` mount (reviewer + /security-review will
  check for it).
- Handler order: `await websocket.accept()` (so a policy close code is deliverable) →
  refuse-close `await websocket.close(code=1008)` and return when:
  (a) `os.getenv("VOICE_BOOKING_ENABLED") != "1"` (flag off ⇒ inert even if a stale
  token existed — none can, since minting requires the flag, but check anyway);
  (b) `registry.consume(call_token)` returns `None` (unknown / expired / already
  consumed). Never echo the token or a reason to the peer.
- On success: open the OpenAI WS via the module-level factory
  `_openai_ws_factory: Callable[[], AsyncContextManager] | None` — default
  `_default_openai_ws()` = `websockets.connect("wss://api.openai.com/v1/realtime?model="
  + OPENAI_REALTIME_MODEL, additional_headers={"Authorization": f"Bearer {OPENAI_API_KEY}"})`
  (import `websockets` lazily; monkeypatchable in tests exactly like
  `tee_times._rehearsal_transport_factory`) — then `await run_media_bridge(websocket,
  openai_ws, pending)`.
- Any exception: log `type(exc).__name__` (no payloads), ensure `pending.future` is
  resolved (unclear) so `run_call` never hangs, close both sockets.
- Optional defense-in-depth (note in comments, do NOT block the slice on it): validate
  the `X-Twilio-Signature` handshake header with twilio's `RequestValidator` against
  the wss URL. Signature validation on WS upgrades is fiddly (Twilio signs the URL;
  some proxies rewrite it) — the token remains the load-bearing guard either way.

`main.py` mount (after the tee_times mount, before `startup`):
```python
from app.routes import voice_booking_ws  # noqa: E402
# DELIBERATELY NOT _owner_only: Twilio's media stream cannot carry owner auth.
# Sole guard = single-use unguessable call token minted by LiveCallTransport
# (backend/app/services/voice_booking/call_registry.py). See voice_booking_ws.py.
app.include_router(voice_booking_ws.router)
```

### 5.5 Dependencies (`backend/pyproject.toml`)
Add to `[project].dependencies`: `"twilio>=9.0.0"` (REST client + optional
RequestValidator), `"websockets>=12.0"` (server-side OpenAI Realtime WS client). Both
imported lazily inside factories so tests and cold paths never require network or the
libs at import time of the route module (mirrors the boto3-lazy pattern in
`secrets.py`). Run `uv sync` after editing.

## 6. Security invariants (BLOCKING — /security-review will verify)

1. **No open audio relay.** `/api/voice-booking/media-stream/{token}` accepts ONLY a
   token minted by this process for a call it just placed: unguessable
   (`token_urlsafe(32)`), single-use (popped on consume), short-lived (120s connect
   TTL), bound to the minting ctx. Random/guessed/replayed paths → close 1008, zero
   frames relayed. Flag off → refuse before touching the registry.
2. **Dial-safety end-to-end.** No request value can become a dialed number:
   `LiveCallTransport.run_call` dials ONLY `normalize_phone(ctx.phone)` and refuses
   `None`; the ctx reaches it exclusively from the rehearsal route (hard-coded
   `VOICE_BOOKING_OWNER_NUMBER`, no request body — existing invariant + tests) or
   `VoiceCallProvider.book()` (verified-lines allowlist + compliance gates). The
   transport and the WS route never read a request-supplied number.
3. **Disclosure-first is unbypassable.** The forced greeting (bridge step 3) instructs
   the model to open with exactly `compliance.disclosure_line(ctx)` and is sent before
   any caller audio is forwarded; the instructions repeat it as rule #1.
4. **Secrets hygiene.** `TWILIO_*` come only from Secrets Manager (`looper/prod`) /
   env via `load_secrets_into_env()`; never logged, never in the TwiML, never in any
   URL or response. The wss URL carries host + token only. `OPENAI_API_KEY` stays in
   the server-side `Authorization` header. No audio payloads in logs; text transcript
   logged only by the existing rehearsal-route logger.
5. **Flag-off inertness (CI default).** `VOICE_BOOKING_ENABLED` unset ⇒
   `get_live_transport()` raises the same calm RuntimeError → route returns
   `not_enabled`; no tokens are ever minted; the WS route refuses everything.
6. **No audio storage.** `compliance.STORE_AUDIO` remains `False`; the bridge never
   writes audio to disk/DB; transcription is ephemeral text.

## 7. Edge cases / risks (document in code comments where marked)

- **Single-worker registry (document in `call_registry.py`).** The in-process dict
  assumes the process that mints the token also receives Twilio's WS. uvicorn's
  default is a single worker and the EC2 deploy runs one process — fine for the
  owner-gated rehearsal. Multi-worker deploys would need a shared store (Redis);
  out of scope, noted for the future.
- **OpenAI beta→GA event drift.** Beta names (`g711_ulaw`, `input_audio_format`,
  `response.audio.delta`, `/v1/realtime` beta header) are REMOVED. Use only the GA
  names in §4.2, which match both the fetched Twilio blog and this repo's shipped GA
  usage (`realtime_relay.py`, `frontend/src/lib/voice/realtime.ts`). If OpenAI ever
  renames again, only `media_bridge.py` changes.
- **Sync Twilio client in async context** — every REST call goes through
  `asyncio.to_thread` (create + best-effort hangup).
- **Call timeout** — `run_call` bounds the whole call (default 300s); timeout returns
  the PARTIAL transcript (live accumulator on `PendingCall`) + `unclear`, hangs up the
  Twilio leg best-effort, and discards the token.
- **Twilio never connects** (bad host, blocked wss, unanswered call): the connect TTL
  expires the token and the `run_call` timeout returns `unclear` — the owner sees an
  honest "call didn't resolve" instead of a hang.
- **Model never calls the tool** → fallback `CallOutcome(result="unclear", detail=
  "call ended without a recorded outcome")` (→ `needs_human` via `to_booking_result`).
- **Barge-in** (`clear` on `speech_started`) is optional polish — implement if cheap,
  never a gate.
- **`_clean_env` fixture drift**: `test_rehearsal_call.py`'s autouse fixture must add
  `VOICE_BOOKING_PUBLIC_HOST` to its delenv list, or a dev machine env var leaks into
  tests.

## 8. Tests (all CI-safe: NO live dial EVER — mock Twilio client + mock OpenAI WS)

### `backend/tests/test_telephony_bridge.py`
1. `test_build_stream_twiml_shape` — `build_stream_twiml("api.example.com", "tok123")`
   contains `<Connect>`, `<Stream url="wss://api.example.com/api/voice-booking/media-stream/tok123"`,
   and NO `TWILIO_`/sid/auth-token substrings.
2. `test_place_call_dials_only_ctx_phone` — `LiveCallTransport` with a mock Twilio
   client (records `calls.create` kwargs): drive the placement helper in isolation
   (`_place_call`) → `to` == normalized owner number, `from_` == `TWILIO_FROM_NUMBER`,
   `twiml` contains the minted token's URL. (Isolating `_place_call` avoids awaiting
   the never-resolving future.)
3. `test_run_call_refuses_unnormalizable_phone` — ctx.phone `None`/garbage →
   `("unclear", …)` returned, mock client NEVER called.
4. `test_run_call_timeout_returns_partial_transcript_unclear` — tiny
   `call_timeout_seconds`, future never resolved, a turn pre-appended to
   `pending.transcript` via the registry → result is that partial transcript +
   `result == "unclear"`; token discarded (second consume → None).
5. `CallTokenRegistry` suite: `test_token_valid_once` (consume → PendingCall; second
   consume → None), `test_expired_token_refused` (fake clock past TTL),
   `test_random_token_refused`, `test_token_bound_to_ctx` (consumed PendingCall carries
   the minting ctx).
6. `get_live_transport` gating: `test_disabled_by_default` (unchanged),
   `test_missing_twilio_creds` (unchanged), NEW `test_missing_public_host_named` —
   flag + all TWILIO_* set, no `VOICE_BOOKING_PUBLIC_HOST` → RuntimeError naming
   `VOICE_BOOKING_PUBLIC_HOST`; NEW `test_fully_configured_returns_live_transport` —
   all creds + host + flag → returns a `LiveCallTransport` instance, and the mock/real
   client factory is NOT exercised and `run_call` is never called (construction only,
   zero network, zero dial).

### `backend/tests/test_media_bridge.py`
Fakes: `FakeTwilioWS` (scripted incoming events; records `send_json` calls),
`FakeOpenAIWS` (records sent JSON; yields scripted server events).
1. `test_session_update_sets_ulaw_in_and_out` — first message sent to OpenAI is
   `session.update` with `audio.input.format.type == "audio/pcmu"` and
   `audio.output.format.type == "audio/pcmu"`, instructions non-empty, tool present.
2. `test_greeting_forced_before_any_media` — script: `connected`, `start`, one `media`;
   assert the `conversation.item.create` + `response.create` pair is sent to OpenAI
   BEFORE any `input_audio_buffer.append` (greets-first ordering).
3. `test_disclosure_first_content` — the forced-greeting `input_text` contains EXACTLY
   `compliance.disclosure_line(ctx)`; `build_realtime_call_instructions(ctx)` also
   embeds it verbatim plus the no-payment + in-window rules (substring asserts).
4. `test_twilio_media_forwarded_to_input_audio_buffer` — a Twilio `media` frame with
   payload `"AAAA"` → OpenAI receives `{"type": "input_audio_buffer.append",
   "audio": "AAAA"}` (same payload, untranscoded).
5. `test_openai_audio_delta_forwarded_with_streamsid` — scripted
   `response.output_audio.delta` → Twilio receives `{"event": "media", "streamSid":
   <sid from start>, "media": {"payload": <delta>}}`.
6. `test_transcript_accumulation_both_speakers` —
   `response.output_audio_transcript.done` + `conversation.item.
   input_audio_transcription.completed` → `pending.transcript` has agent + shop
   `CallTurn`s in order.
7. `test_tool_call_resolves_outcome` — scripted `response.function_call_arguments.done`
   (name `record_booking_outcome`, arguments JSON `result=booked`, confirmation etc.)
   then `stop` → future resolves with `CallOutcome(result="booked", …)`;
   `outcome_from_tool_args` unit cases: unknown result → `"unclear"`; opt-out flag
   round-trips; missing optionals → None.
8. `test_no_tool_call_falls_back_to_unclear` — `stop` with no tool call → future
   resolves `result == "unclear"`.

### `backend/tests/test_voice_booking_ws.py`
FastAPI `TestClient.websocket_connect` against a minimal app including
`voice_booking_ws.router`.
1. `test_bad_token_refused` — flag on, random token → connection closes with 1008
   before any bridge activity (`_openai_ws_factory` monkeypatched to an exploding
   factory that must NOT be called).
2. `test_flag_off_refused` — `VOICE_BOOKING_ENABLED` unset + even a VALID minted token
   → refused, token untouched or refused-regardless (assert close, no bridge).
3. `test_token_single_use_via_route` — valid token accepted once (bridge entered with
   both WS fakes), second connect with the same token → 1008.

### `backend/tests/test_rehearsal_call.py` (UPDATE — flag in the PR as a LEGITIMATE
behavior-change edit, NOT test-editing-to-pass: the bridge these tests encoded as
"unshipped" has now shipped)
- REPLACE `test_not_enabled_when_bridge_unimplemented` (it asserts the deleted
  NotImplementedError "owner-gated"/"telephony bridge" text) with
  `test_not_enabled_when_public_host_missing`: creds + flag set,
  `VOICE_BOOKING_PUBLIC_HOST` unset → `status == "not_enabled"` and the reason names
  `VOICE_BOOKING_PUBLIC_HOST`. Still zero network.
- ADD `test_live_transport_constructed_when_fully_configured`: all creds + host +
  flag → `telephony.get_live_transport()` returns a `LiveCallTransport` (construction
  only; `run_call` never called; no dial). Placed here or in
  `test_telephony_bridge.py` — one canonical copy, not both.
- Extend `_clean_env` fixture's delenv list with `VOICE_BOOKING_PUBLIC_HOST`.

### `backend/tests/test_voice_booking.py` (UPDATE — same legitimate-change flag)
- `TestTelephonyStub::test_enabled_with_creds_is_still_not_implemented` (line ~560)
  becomes `test_enabled_with_creds_but_no_public_host` → RuntimeError matching
  `VOICE_BOOKING_PUBLIC_HOST`. Rename the class comment ("Telephony stays a stub" →
  "Telephony gating").

The existing simulator-driven tests (`test_full_rehearsal_via_simulated_transport`,
dial-safety, compliance short-circuit) stay untouched and remain the higher-level CI
coverage of the route.

## 9. Implementation order

1. `pyproject.toml` deps + `uv sync`.
2. `call_registry.py` + its tests (pure; no other file depends yet).
3. `telephony.py` rewrite (`build_stream_twiml`, `LiveCallTransport`,
   `get_live_transport`) + `test_telephony_bridge.py` + the two UPDATED legacy tests
   (§8, test_rehearsal_call.py + test_voice_booking.py) — the suite must be green at
   this point with the bridge still WS-less.
4. `media_bridge.py` (session update → instructions → tool → bridge loop) +
   `test_media_bridge.py`.
5. `voice_booking_ws.py` + `main.py` mount + `test_voice_booking_ws.py`.
6. Docstring refresh (`voice_booking/__init__.py`, stale "stub" comments in
   `provider.py` header + `tee_times.py` rehearsal comment block §"HONEST STATUS").
7. Gates (§10), then `/security-review` + `/code-review` (new public endpoint +
   outbound telephony ⇒ both required before ready).

## 10. Gates

```
cd backend && ruff check .
cd backend && uv run pytest tests/test_rehearsal_call.py tests/test_voice_booking.py tests/test_tee_time_router.py tests/test_telephony_bridge.py tests/test_media_bridge.py tests/test_voice_booking_ws.py
cd frontend && npm run lint && npx tsc --noEmit && npm run build && npx tsx voice-tests/runner.ts --smoke
```

No docker / no local Postgres — all new tests are pure/route-level (mocks +
TestClient). Then `/security-review` + `/code-review` (new public endpoint + outbound
telephony ⇒ required).

## 11. Owner setup (put this verbatim in the PR body)

Exact keys the owner adds to Secrets Manager `looper/prod` (JSON) or backend env:
`VOICE_BOOKING_ENABLED=1`; `TWILIO_ACCOUNT_SID`; `TWILIO_AUTH_TOKEN`;
`TWILIO_FROM_NUMBER` (+1…, a voice-capable Twilio number he provisions);
`VOICE_BOOKING_OWNER_NUMBER` (his verified E.164 — the ONLY dialable number);
`VOICE_BOOKING_PUBLIC_HOST` (public host serving the wss, e.g. api.example.com — the
backend must be reachable over TLS/wss so Twilio can connect); optional
`VOICE_BOOKING_OWNER_NAME`, `VOICE_BOOKING_REHEARSAL_TZ`. `OPENAI_API_KEY` already
present. He must provision a Twilio number and ensure a public wss host. Even fully
configured, live dial is CI-untested by design — he validates by pressing the
rehearsal button after setting creds.

## 12. Shared types / frontend

No `frontend/src/lib/types.ts` or `backend/app/models.py` change: the rehearsal
response shape (`RehearsalCallResponse`) is unchanged — `status`/`reason`/
`calleeNumber`/`disclosure`/`transcript`/`outcome`/`result` all keep their fields; the
only observable difference is the `not_enabled` reason text when the host is missing,
and `completed` once configured. Confirm with the frontend gates (tsc + build) — no
frontend edits expected.

## Critical files for implementation

- backend/app/services/voice_booking/telephony.py
- backend/app/routes/voice_booking_ws.py (new)
- backend/app/services/voice_booking/media_bridge.py (new)
- backend/app/services/voice_booking/call_registry.py (new)
- backend/tests/test_rehearsal_call.py
