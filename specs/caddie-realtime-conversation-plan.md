# Caddie Realtime Conversation — Implementation Plan

Backlog id: `caddie-realtime-conversation` · P1 · major · **high risk (transport migration)**
Status: PLAN. This document is the contract handed to the builder.

## Owner directive (verbatim, stated twice)
> "the caddie still requires me to click before and after I'm talking instead of
> following the start round model where it detects for me."

Root cause: the in-round **Ask Caddie sheet** (`CaddieSheet.tsx`) runs a Deepgram
STT + Claude-text path. The live Deepgram socket keeps failing on the owner's
iPhone; the fallback `VoiceRecorder` has **no server VAD**, so he must tap to
start AND tap to stop every utterance. Round **setup** does not have this problem
because it runs on the **OpenAI Realtime** session (server-side VAD, native
barge-in). Direction: route the in-round conversation through the same Realtime
engine the setup flow and the round-page orb already use.

---

## 1. Approach & architecture decision

### 1.1 The two engines today
- **Realtime (WebRTC, server VAD)** — `lib/voice/realtime.ts` (`RealtimeCaddieClient`),
  minted by `POST /api/realtime/session` (`routes/realtime.py` → `services/realtime_relay.py`).
  Continuous listening, native barge-in, the caddie's own audio out. Used by:
  - round **setup** sheet (`VoiceRoundSetupRealtime.tsx`, `mode:'setup'`),
  - round-page **orb** (`hooks/useVoiceCaddie.ts`, `mode:'caddie'`, hold-to-talk).
  Both adopt a preloaded, mic-withheld session from the shared
  `warmSession` manager (`lib/voice/warm-session.ts`).
- **Deepgram + Claude text (tap-to-talk)** — the current `CaddieSheet.tsx`: a
  3-tier SSE ladder (`sessionVoiceStream` → `talkToCaddieStream` → `talkToCaddie`)
  driven by `VoiceRecorder`/`DeepgramLiveTranscriber`. This is the path with no
  server VAD — the source of the owner's pain.

### 1.2 Decision — transport/session (resolves requirement #1)
**Reuse the shared warm POOL; run a fresh continuous-listen Realtime client per
sheet-open. Do NOT hand the orb's live hold-to-talk client to the sheet.**

Concretely, `CaddieSheet` (in its new "live" mode) does exactly what
`VoiceRoundSetupRealtime` does:
1. On open: `warmSession.takeWarm({ kind:'caddie', roundId, personalityId })`.
2. If a warm client is returned: `setEvents()` → `emitCurrentStatus()` → `attachMic()`.
3. If `null` (nothing warm, or the orb already consumed it): construct a fresh
   `new RealtimeCaddieClient({ mode:'caddie', roundId, personalityId })` and `start()`.

**Why the warm pool, not a literal shared live client:**
- There is exactly **one** warm client (single `warmSession` instance) and a hard
  **one-connection cap** (`activeRealtimeClient` in `realtime.ts`). Orb and sheet
  are **mutually exclusive** surfaces — you are either holding the orb or you have
  the sheet open — so a single owner-at-a-time model is the honest fit.
- The orb's client is driven by `useVoiceCaddie` with **hold-to-talk mute
  semantics** (press = unmute, release = mute) and handlers bound to that hook.
  Adopting it live into the sheet would mean re-plumbing mute from hold-to-talk to
  continuous, mid-flight — fragile. The warm-pool adoption seam
  (`takeWarm` → `attachMic`) is the **tested** path that both existing surfaces
  already use; the sheet becomes a third consumer of the identical seam.
- The one-connection cap means opening the sheet's client cleanly stops any live
  orb burst (RoundPageClient already enforces "one mic at a time" before opening
  a surface). No dual-audio, no double billing.

**Tradeoff (stated explicitly):** reusing the warm pool makes the common open
fast (< ~500ms) but means the sheet's session is a **new conversation context**
on the OpenAI side — it does **not** inherit the orb's in-session dialogue. We
recover full continuity by grounding the mint with the **shared round ledger**
(caddie_messages) — see §2 Slice A. The alternative (one persistent live client
shared across orb+sheet for the whole round) was rejected: it fights the
hold-to-talk/continuous mismatch, the 90s idle-disconnect cost policy, and every
warm-path pinning test. Cost & continuity are better served by short, well-grounded
bursts than one long-lived socket.

### 1.3 The opening recommendation as the first spoken turn (resolves #1, composes with `caddie-opening-reco-from-tee`)
Today `CaddieSheet` fires an auto opening turn as **text** (`askCaddie(q)` with a
GPS distance) via `resolveOpeningShot`. In live mode this becomes a **spoken**
first turn:
1. On open, once status is `connected` and `attachMic()` has resolved, call
   `resolveOpeningShot()` (parent already provides it, GPS-owned, honest-idle on
   no fix).
2. If a distance resolves, inject it with the existing public seam
   `client.sendText("I'm about N yards from the pin. What should I hit or do on
   this next shot?")` — `sendText` already does `conversation.item.create` +
   `response.create` and surfaces the line as a user bubble (transparency
   preserved). The caddie then **speaks** the recommendation as turn one; server
   VAD lets the golfer barge in immediately.
3. On no GPS fix / no session / implausible distance: **do not** inject — the
   sheet opens live and simply listens (honest idle), exactly as the text path
   stays idle today.

This is the natural composition point for the queued
`caddie-opening-reco-from-tee` item: that item decides *what* the opening prompt
says; this plan only decides that it is delivered as the first Realtime turn via
`sendText`. Keep the opening-turn text builder in one place so the two items don't
drift.

---

## 2. Grounding parity — full inventory (resolves #2)

The Realtime conversational caddie must know **everything** the current sheet
session path knows. The sheet's richest brain is
`_build_session_voice_prompt` (`routes/caddie.py` ~:524-634), consumed by
`/caddie/session/voice[/stream]`. Below is the inventory and the exact gaps.

### 2.1 What the sheet session prompt sends TODAY (`_build_session_voice_prompt`)
| Context | Source |
|---|---|
| Current hole # | `session.current_hole` |
| Par / yards / **effective (plays-like)** yards | `session.hole_intel[h]` |
| **Real mapped hazards** (HAZARD_GROUNDING_RULE) | `format_hazards_line(...)` |
| **Green slope** description | `hole_intel.green_slope` |
| Weather (temp, wind speed+dir, humidity) | `session.weather` |
| Handicap | `session.handicap` |
| Club distances | `session.club_distances` |
| **Last recommendation** (club, target, aim, miss) | `session.last_recommendation` |
| **Recent shots** (last 5) | `session.shot_history[-5:]` |
| **Full round conversation history** (last 20) | `session.conversation_history` |
| Cross-round **player memory** | `memory.get_top_memories` → `render_memories_for_prompt` |

### 2.2 What the Realtime session gives today
Mint-time instructions (`build_realtime_instructions`, `voice_prompts.py`):
persona · player memory · **situation block** (handicap, clubs, weather, current
hole, current-hole hazards) · behavior + HAZARD_GROUNDING_RULE.

Live **tools** (`DEFAULT_TOOLS`, `realtime_relay.py`; dispatched in `realtime.ts`):
`get_recommendation` (DECADE via `sessionRecommend`), `record_shot` (dual-write),
`get_session_status`, `get_conditions` (weather + plays-like + **hazards, honest**),
`get_player_profile` (handicap, clubs, **tendencies**: miss dir/short%, 3-putts,
par5 bogey rate), `get_carries` (honest `available:false` stub).

### 2.3 The gaps to close (Slice A — backend only, NO transport, NO invariants)
1. **Conversation history** — the biggest gap. A fresh Realtime mint starts with
   an empty dialogue; it does not know what was discussed earlier this round
   (prior sheet opens, prior orb turns — all recorded in the shared
   `caddie_messages` ledger and hydrated into `session.conversation_history`).
   Inject a compact recent-history block (last ~20 turns) into
   `build_realtime_instructions` — mirroring `_build_session_voice_prompt`.
2. **Green slope** — add `green_slope.description` to the situation block and to
   the `get_conditions` tool payload.
3. **Last recommendation** — add to the situation block (and it is already in
   `get_session_status`; keep both honest).
4. **Recent shots (last 5)** — add to the situation block (also expose in
   `get_session_status` if not present).
5. Tendencies/miss profile are already reachable via `get_player_profile` — no gap.

**Constraints:** obey `HAZARD_GROUNDING_RULE` — only real mapped hazard geometry,
never an invented hazard or carry (`get_carries` stays `available:false`). Every
added block is guarded (`if present`) so a memory-less / intel-less user's prompt
is byte-identical to today. This mirrors the cycle-7 **Looper brain parity**
(Bundle #105) discipline (`specs/looper-brain-parity-plan.md`): grounding rides in
on the existing authenticated `round_id`/`user_id`, defensively, no schema change.

Slice A **also improves the orb Realtime session in production immediately** (the
orb already runs Realtime), so it is real value independent of the sheet migration.

---

## 3. Warm-path invariants — exact seams (resolves #3)

The silent-placeholder / `withholdMic` / `attachMic` / transcript-gating (`opened`
flag) machinery in `realtime.ts` is **UNTOUCHABLE** except by extending its pinning
tests. **This migration is designed to require ZERO changes to that machinery** —
the sheet only *consumes* the existing public seams, exactly as
`VoiceRoundSetupRealtime` does:

Seams consumed (all already public + pinned):
- `warmSession.takeWarm({kind:'caddie',...})` — pinned in `warm-session.test.ts`
  ("WARM/WARMING matching intent", "MISMATCHED returns null", "cancels deadline").
- `client.setEvents()` / `emitCurrentStatus()` — pinned in `realtime-warm.test.ts`
  ("setEvents rebinds handlers", "emitCurrentStatus re-emits current status").
- `client.attachMic()` — pinned in `realtime-warm.test.ts` (getUserMedia-once,
  replaceTrack, idempotent, in-flight-start wait, throws-on-no-transceiver, and
  the transcript-gating "forbidden-shortcut guard").
- `client.sendText()` / `setMuted()` / `stop()` — existing.
- Tool dispatch (`dispatchTool`) — pinned in `realtime-dispatch.test.ts`.

**If — and only if — a change to `realtime.ts` becomes necessary**, the candidates
and their required test growth are:
- A dedicated "caddie speaks first without a visible user bubble" method (instead
  of reusing `sendText`): would add a public method → **must** add cases to
  `realtime-warm.test.ts` proving it (a) no-ops before `attachMic()`/`opened`, and
  (b) triggers exactly one `response.create`. **Recommendation: avoid it — reuse
  `sendText`, keep realtime.ts untouched.**
- Any new caddie tool (e.g. real `get_carries` later): grow `DEFAULT_TOOLS` +
  `dispatchTool` and add a case to `realtime-dispatch.test.ts`. Out of scope here.

The rule for the builder: **touching `realtime.ts` warm/mic code without growing
`realtime-warm.test.ts` is a hard stop.**

---

## 4. Honest degradation (resolves #4)

`CaddieSheet` becomes **dual-mode**, with the current path preserved intact as the
fallback:
- **Live mode (new default when eligible):** Realtime continuous listening. Eligible
  when `sessionActive && !isLocalRound && navigator.onLine`.
- **Classic mode (existing):** Deepgram/tap-to-talk + the 3-tier SSE text ladder,
  exactly as today. Nothing removed.

Fallback ladder INSIDE the sheet (reuse `MINT_DEADLINE_MS` = 3s and the existing
`transportReducer` semantics from `lib/caddie/transport.ts`):
- Mint > 3s, or ICE/SDP connect failure, or mic-permission denial, or `onError`
  before `connected` → **fall to classic mode** and render the existing `VoiceBody`
  with a **calm indicator** (a quiet mono line, e.g. "Tap-to-talk mode" — no error
  toast, no alarm; Northstar calm). Never a dead sheet.
- Fully offline at open → classic mode straight away (no mint).
- This mirrors `useVoiceCaddie`'s silent-downgrade discipline. Respect the
  no-fake-data-fallbacks lesson: the indicator **honestly labels the mode**; it
  never pretends live VAD is on when it is not.

Note the outer ladder still exists too: the orb already degrades realtime → sheet.
With the sheet itself realtime-first, the orb→sheet degrade now lands on a sheet
that will *retry* Realtime on open and, failing that, present classic mode.

---

## 5. UX (resolves #5) — yardage-book calm (designer will review)

Model the live view on `VoiceRoundSetupRealtime`, restyled into `CaddieSheet`'s
existing chrome (header, persona picker, hole chip, T.* tokens, PAPER_NOISE,
Instrument Serif):
- **Transcript + answers view:** conversation bubbles sorted by the stable `order`
  key (`sortByOrder`), partials at reduced opacity — reuse the exact rendering from
  `VoiceRoundSetupRealtime`. User right/ink, caddie left/paper-deep serif-italic.
- **Live status line:** map `RealtimeStatus` → calm copy ("Ready — go ahead",
  "Listening…", "Caddie speaking…"). No pulsing chrome beyond the existing quiet
  dot.
- **Affordances:** mute toggle (`client.setMuted`) + close (44×44, existing). On
  close: `client.stop()` (mic off); the 90s idle timer handles a lingering warm
  reconnect. **No** tap-to-start/stop mic button in live mode — that is the whole
  point.
- **Barge-in:** native via server VAD — no client logic needed.
- **TTS:** the Realtime client's **own** audio (`realtime.ts`'s single hidden,
  in-DOM, `playsinline` `<audio>` sink — already the iOS-safe pattern). **Do NOT**
  route live-mode replies through `useSheetTTS`. Note for the builder: the #108 iOS
  TTS fix was for the **fallback (classic) path's** TTS, not Realtime's — keep the
  two audio paths separate; live mode never calls `tts.speak`.
- **Flag it if it drifts:** if the live transcript pushes toward a chatty,
  dashboard-y feel, flag for the owner rather than shipping. Keep it a quiet page
  of the yardage book.

Behind a **feature flag** for rollout (mirror `tts-pref.ts`'s localStorage pattern,
e.g. `caddie-live-mode` pref, default off until device-verified, then flip default).

---

## 6. Cost & idle policy (resolves #6)

- **Model:** `gpt-realtime` (GA), audio in + audio out. Verify current per-minute
  audio pricing against OpenAI's live pricing page at build time (do not hardcode a
  stale number in code).
- **Per-round estimate:** the session is **not** continuously live. The client's
  `IdleTimer` disconnects after **90s** of no conversation activity
  (`REALTIME_IDLE_DISCONNECT_MS`, `idle-timer.ts`). Expected usage: a handful of
  sheet opens per round, ~30-90s of live audio each → **~5-10 live minutes/round**.
  At GA gpt-realtime audio rates this lands in the low single-digit dollars per
  round — bounded and affordable **because** of the idle cutoff. Put the concrete
  figure in the PR after checking live pricing.
- **Idle-timeout policy:** keep the existing 90s VAD-silence → suspend (`stop()`);
  **resume on the next sheet-open/tap** by adopting a fresh warm client or
  cold-minting. Do **not** hold one socket live for the whole round. This is the
  honest, affordable posture and needs no new timer (one authoritative timer already
  exists — do not add a second racing countdown).
- Warm preloads are already torn down on offline/backgrounded (`warm-session.ts`),
  so no billed zombie connections.

---

## 7. Test strategy (resolves #7) — deterministic, no real sockets

**Principle:** mock the Realtime client exactly like the existing warm-session /
warm-client tests. NO getUserMedia, NO RTCPeerConnection, NO sockets in CI.

- **Frontend unit (vitest):**
  - New `CaddieSheet` live-mode tests using the **injected fake** patterns already
    established: a fake `RTCPeerConnection`/data-channel (as in
    `realtime-warm.test.ts`) or an injected `createClient` (as in
    `warm-session.test.ts`). Assert: adopt-warm → `attachMic` once → opening turn
    injected via `sendText` → transcript renders in conversation order →
    mute toggles `setMuted` → **fallback to classic on mint-timeout / connect-fail /
    mic-deny** with the calm indicator, never a dead sheet.
  - Extend, do not weaken, `CaddieSheet.handsfree.test.tsx` /
    `CaddieSheet.session.test.tsx`: classic mode must still pass byte-for-byte.
  - If any `realtime.ts` seam is added (see §3): grow `realtime-warm.test.ts`
    (and `realtime-dispatch.test.ts` for any tool change). Pinning tests only grow.
- **Backend unit (pytest):**
  - New `backend/tests/test_realtime_grounding.py` (mirror `test_setup_voice.py`,
    pure): `build_realtime_instructions` now includes conversation history / green
    slope / last rec / recent shots when present, and is unchanged (guarded) when
    absent; honors HAZARD_GROUNDING_RULE.
  - Extend conditions/status tool-endpoint tests for the new payload fields.
- **Gates (every slice runs the applicable set):**
  - `cd frontend && npm run lint`
  - `cd frontend && npx tsc --noEmit`
  - `cd frontend && npm run build`
  - `cd frontend && npx tsx voice-tests/runner.ts --smoke`
  - `cd frontend && npx vitest run` (the new + existing voice/sheet suites)
  - `cd backend && ruff check .`
  - `cd backend && uv run pytest` (grounding + tool-payload tests)
  - `/code-review` and `/security-review` before the PR is marked ready (new
    user-facing capability + touches an authed transport path — required by CLAUDE.md).

---

## 8. Files to touch

### Frontend
- `frontend/src/components/CaddieSheet.tsx` — add live mode (adopt warm/cold Realtime,
  continuous transcript view, opening turn via `sendText`, mute/close, in-sheet
  fallback ladder + calm indicator). Classic path preserved.
- `frontend/src/app/round/[id]/RoundPageClient.tsx` — coordinate one-mic-at-a-time
  between orb and the now-live sheet (extend existing "stop any live/warm orb
  session" guard); pass the live-mode flag; keep `resolveOpeningShot` wiring.
- `frontend/src/hooks/useVoiceCaddie.ts` — only if warm-pool coordination needs a
  shared teardown/handoff nicety; prefer no change.
- (New) `frontend/src/components/CaddieSheet.realtime.test.tsx` — deterministic
  live-mode tests.
- CONSUMED, do not modify: `frontend/src/lib/voice/realtime.ts`,
  `frontend/src/lib/voice/warm-session.ts`, `realtime-ordering.ts`,
  `lib/caddie/transport.ts`.

### Backend
- `backend/app/caddie/voice_prompts.py` — extend `build_realtime_instructions`
  situation block (history, green slope, last rec, recent shots). Guarded.
- `backend/app/routes/caddie.py` — extend `get_session_conditions` (green slope)
  and confirm `get_session_status` exposes recent shots / last rec.
- `backend/app/services/realtime_relay.py` — update `get_conditions` tool
  description if its payload grows (keep the "never name an unmapped hazard"
  instruction).
- `backend/app/routes/realtime.py` — pass round `conversation_history` into
  `build_realtime_instructions` at mint (read from the session already loaded via
  `get_owned_session`).
- (New) `backend/tests/test_realtime_grounding.py`.

### Shared types to keep in sync
- `frontend/src/lib/types.ts` ↔ `backend/app/models.py` — no change expected; the
  grounding rides inside the `instructions` string and existing tool JSON payloads.
- `frontend/src/lib/caddie/types.ts` ↔ `StartRealtimeSessionResponse`
  (`routes/realtime.py`) — keep aligned if any response field is added (avoid it).
- Tool payloads (`get_conditions` etc.) are serialized straight to the model via
  `dispatchTool`; no typed frontend shape needs to change, but keep the descriptions
  honest and in sync with what the endpoints return.

---

## 9. Edge cases & risks

- **Warm-path invariant regression (highest):** any accidental edit to
  `realtime.ts` mic/gating code. Mitigation: §3 — consume seams only; pinning tests
  are a hard gate.
- **One-mic contention:** orb burst live while the golfer opens the sheet.
  Mitigation: stop the orb client before the sheet adopts (existing guard); the
  one-connection cap is the backstop.
- **iOS audio:** double-voice / silent-mic modes are already fixed in `realtime.ts`
  (single in-DOM `playsinline` sink; silent-placeholder + replaceTrack). Do not
  reintroduce a second audio element or route live replies through `useSheetTTS`.
- **Grounding gaps / hallucinated hazards:** covered by §2 + HAZARD_GROUNDING_RULE;
  `get_carries` stays honest `available:false`.
- **Cost blowup:** mitigated by the 90s idle cutoff + burst model (§6). Watch for a
  regression that keeps the session live across holes.
- **Continuity:** a fresh mint per open loses in-OpenAI dialogue; recovered by
  injecting the shared ledger history (§2 Slice A). If history injection regresses,
  the caddie "forgets" mid-round — covered by a backend test.
- **Device-only verification:** WebRTC/VAD can only be truly exercised on a real
  iPhone. CI is deterministic-mock only; the live path must be owner-tested on a
  TestFlight build before the flag default flips.

---

## 10. Slice breakdown (ordered by risk) — and the honest "first slice" answer

### Slice A — Backend grounding parity (SHIPPABLE THIS CYCLE, no transport, no invariants)
Extend `build_realtime_instructions` + the conditions/status tool payloads to close
the §2.3 gaps (history, green slope, last rec, recent shots). Pure backend, guarded,
schema-stable.
- **Independently shippable:** YES — and it **improves the live orb Realtime session
  in production today**, before any sheet change. This is the genuine, non-fake
  "pure grounding-context assembler with unit tests" first slice.
- **Touches warm-path invariants:** NO.
- **Gates:** `ruff check .`, `uv run pytest` (new `test_realtime_grounding.py` +
  tool-payload tests). Frontend gates run green (unchanged).

### Slice B — Live-mode transcript-view shell behind a flag (frontend, low risk)
Render the Realtime transcript/answers **view** in `CaddieSheet` behind
`caddie-live-mode` (default off), fed by a **mocked/injected** client in tests only;
in the app the flag stays off. No warm adoption wired to production paths yet.
- **Independently shippable:** YES, behind the flag — pure additive UI, no behavior
  change for users (flag off), fully unit-tested.
- **Touches warm-path invariants:** NO (consumes types only).
- **Gates:** lint, tsc, build, vitest, voice-tests smoke.

### Slice C — Transport migration: adopt warm caddie session + continuous listen (HIGH RISK)
Wire Slice B's shell to `warmSession.takeWarm`/cold-start + `attachMic` + opening
turn via `sendText` + mute/close + barge-in. This is the meaningful change that
resolves the owner's directive. Flag still gated; owner device-tests before default flip.
- **Independently shippable:** only atop A+B; requires the transport migration by
  definition.
- **Touches warm-path invariants:** consumes them (goal: zero `realtime.ts` edits;
  if any, grow pinning tests per §3).
- **Gates:** full frontend + backend gate set, `/code-review`, `/security-review`,
  **device verification**.

### Slice D — In-sheet honest-degradation ladder + calm indicator (depends on C)
Mint-timeout / connect-fail / mic-deny / offline → classic mode with the calm label.
- **Gates:** as C, plus fallback-path vitest cases.

### Slice E — Cost/idle polish, telemetry, flag default flip (depends on C/D)
Confirm 90s idle burst behavior end-to-end; add lightweight telemetry
(`lib/voice/telemetry.ts` pattern); flip the flag default after device sign-off.
- **Gates:** full set + owner "ship it".

### The honest recommendation
**A clean first slice IS shippable this cycle without touching transport
invariants: Slice A (backend grounding parity), optionally plus Slice B (flagged UI
shell).** Both are real, tested, and A materially improves the orb today. **But the
owner's actual pain — "it detects for me" instead of tap-to-talk — is only resolved
by Slice C, which necessarily IS the transport migration.** Recommendation:
**ship Slice A (and B) this cycle; land Slice C behind the flag and treat it as
PLAN-APPROVED-then-device-verified in the immediately following bundle** — do not
rush the transport flip into a bundle the owner cannot test on-device. Do not invent
a smaller "shippable" transport slice; there isn't an honest one.
