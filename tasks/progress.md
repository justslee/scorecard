# Progress log

The team writes here so work survives context resets and usage-limit pauses.
Format: date — done / in-progress / blocked.

## 2026-07-08 — ci-postgis-course-mapping-tests (backend infra/tests, SILENT, integration/next, DONE)

Implemented `specs/ci-postgis-course-mapping-tests-plan.md` exactly. Three files
touched, per the plan's editable-surface list — no `app/**`, `deploy/**`, or
`backend/supabase/migrations/**` edits, no new deps:

- `.github/workflows/ci.yml` — `required-backend` job's `services.postgres`
  image swapped `postgres:16` → `postgis/postgis:16-3.4` (one line).
- `backend/tests/integration/conftest.py` — added `from pathlib import Path`;
  `_ensure_schema` now runs `backend/supabase/migrations/001_course_mapping_schema.sql`
  verbatim (asyncpg simple-query protocol via `conn.get_raw_connection().driver_connection.execute(...)`,
  guarded by `mig.is_file()`) after the existing `scores_round_player_hole_uq`
  block, inside the same `engine.begin()` transaction; the `_db` fixture's
  per-test TRUNCATE list now also clears `hole_features, hole_yardages, holes,
  tee_sets, courses`.
- `backend/tests/integration/test_courses_mapped_db.py` (NEW) — 7 DB-backed
  tests against `app/services/courses_mapped.py` (previously zero live-DB
  coverage): write-back → `get_course` round-trip; merge preserves other keys;
  4 no-op-returns-False cases (absent green feature, nonexistent hole number,
  hole number 0, empty patch); and the real precompute backfill seam
  (`app.routes.caddie._precompute_course_elevations`) with
  `sample_course_elevations` monkeypatched to a deterministic stub but
  `get_course`/`update_green_feature_properties` left real — verifies the
  write-back field mapping (`net_change_ft`→`delta_ft`, `green_slope` omitted
  when `None`) and idempotency (sampler not called on the 2nd run once
  `tee_elevation_ft` is persisted).

No deviations from the plan — confirmed `_precompute_course_elevations`,
`sample_course_elevations(synth_holes, target_course_name)`, the synth-hole
`properties.ref` key, `_green_persisted_elevation`, and `_elevation_patch`'s
field mapping in `app/routes/caddie.py` / `app/services/courses_mapped.py`
against the plan before writing test (d); all matched exactly.

Gates green (no local Postgres — DB tests verified as SKIPPED, not run):
`cd backend && ruff check .` clean; `uv run pytest tests/integration/test_courses_mapped_db.py -v`
→ 7 SKIPPED (no errors on collection/import); `uv run pytest -k "not integration" -q`
→ 1080 passed, 81 deselected; full `uv run pytest -q` → 1080 passed, 81 skipped.
Real DB verification is the CI `required-backend` gate (postgis service) on
the pushed commit — pending.

Commit `3a8f3d7` pushed to `integration/next`, riding bundle PR #111 as silent
infra/test work (no user-facing surface).

## 2026-07-08 — caddie-realtime-slice-d: live-session resilience (frontend, SILENT — flag default OFF, integration/next, DONE)

Implemented `specs/caddie-realtime-slice-d-plan.md` exactly — closes the two
reviewer-logged gaps in the flag-gated (`looper.caddieLiveMode`, still default
OFF) live caddie mode from Slice C1. **Zero edits** to `realtime.ts` /
`warm-session.ts` / `realtime-ordering.ts`; `useVoiceCaddie.ts` untouched
(plan §5 verified it has no resurrection seam).

- `frontend/src/hooks/useCaddieLiveSession.ts` — bounded reconnect state
  machine (plan §2/§3). New refs: `reconnectUsedRef`, `reconnectingRef`,
  `reconnectedRef`, `reconnectDeadlineRef`, `lastActivityAtRef`,
  `orderOffsetRef`/`maxOrderRef`, `mutedRef`. Post-connected `closed`/`error`
  now classifies clean-idle (rest — no reconnect/fallback) vs. an unexpected
  drop (ONE quiet cold-mint `startReconnect()`, reusing `MINT_DEADLINE_MS` as
  the reconnect budget) via a hook-local activity-mirror clock compared
  against `REALTIME_IDLE_DISCONNECT_MS - IDLE_MARGIN_MS` (imported
  read-only from `idle-timer.ts`). `startReconnect()` detaches the dead
  client's handlers (`setEvents({})`) before `stop()`, cold-mints a fresh
  `RealtimeCaddieClient`, and re-applies `mutedRef` after `attachMic()`.
  Cross-client transcript ordering fixed by offsetting every post-reconnect
  message by `maxOrderRef + 1` in `upsert` (the new client's own
  `MessageOrderTracker` restarts near 0). Gap 2 (resurrection): every
  `await` in both the warm and cold branches of the activation effect (plus
  the new reconnect branch) now also checks `fellBackRef.current`, not just
  `cancelled` — a fallback that fires while `start()`/`attachMic()` is still
  pending can no longer have its continuation revive the dead client.
- `frontend/src/components/CaddieSheet.tsx` — fallback continuity (plan §4).
  A one-shot effect seeds `convHistory` from `live.messages` the moment
  `showFallbackIndicator` flips true (guarded by `seededFallbackRef`, only
  when `convHistory` is still empty), so the classic tap-to-talk body renders
  the preserved live conversation instead of going blank. `liveTranscriptSeenRef`
  suppresses the classic auto-opening-turn effect so a fallback after a
  mid-round drop never re-greets. Both refs reset when `wantLive` goes false.
  Flag-off path is untouched — all of this sits behind `wantLive`.
- `frontend/src/components/CaddieSheet.realtime.test.tsx` — 4 new
  deterministic tests (plan §8): drop→reconnect SUCCESS (transcript
  preserved + correctly ordered across the two clients, no re-greet, no
  fallback label), drop→reconnect FAIL→classic fallback (mic usable,
  "Tap-to-talk mode" shown, pre-drop transcript preserved via the
  `convHistory` seed — verified with a small controlled-render harness since
  the file's existing `onUpdateConvHistory` spy doesn't loop state back),
  fallback-during-pending-start (Gap 2 — no `attachMic` resurrection, no
  second mint; required extending the file's `FakeRealtimeCaddieClient` with
  a `pendingStartImpls` queue so a test can hand the next-constructed
  instance a manually-controlled deferred `start()`), and clean-idle-close
  (no reconnect, no fallback, transcript stays visible). `sortByOrder` stays
  real throughout.

No deviations from the plan otherwise. Gates green: `npm run lint` (0
errors), `npx tsc --noEmit` (clean), `npm run build` (compiled + all routes
generated), `npx tsx voice-tests/runner.ts --smoke` (274/274), `npx vitest
run` (81 files / 1686 tests, all green), pinning set
`realtime-warm.test.ts warm-session.test.ts realtime-dispatch.test.ts
transport.test.ts CaddieSheet.handsfree.test.tsx CaddieSheet.session.test.tsx`
green and **unmodified** (104/104), `cd backend && ruff check .` clean
(no backend change this slice).

Risk: low — flag still defaults OFF, so shipped behavior for every current
user is byte-identical to today; the new reconnect/fallback-continuity code
paths are only reachable once the owner has opted into live mode. Not
noticeable on TestFlight as-is.

## 2026-07-08 — caddie-realtime-slice-c1: live-mode Realtime transport in Ask Caddie sheet (frontend, SILENT — flag default OFF, integration/next, DONE)

Implemented `specs/caddie-realtime-slice-c1-plan.md` (stage 1 of Slice C,
folding in Slice B's shell — parent contract `specs/caddie-realtime-conversation-plan.md`).
Adds a live-mode Realtime (WebRTC, server VAD, no tap-to-talk) path to the
in-round Ask Caddie sheet behind a NEW pref `looper.caddieLiveMode`, default
OFF — **silent rider, zero user-visible change** until the owner flips it.

- NEW `frontend/src/lib/voice/live-mode-pref.ts` — `getCaddieLiveMode()` /
  `setCaddieLiveMode()`, mirrors `tts-pref.ts` exactly. Default OFF.
- NEW `frontend/src/hooks/useCaddieLiveSession.ts` — Realtime lifecycle: a
  THIRD consumer of the existing warm-pool seams (`warmSession.takeWarm` →
  `setEvents`/`emitCurrentStatus`/`attachMic`, or cold `new
  RealtimeCaddieClient({roundId, personalityId})` → `start()` → `attachMic()`
  — the latter call is a no-op on an already-open client, called uniformly so
  "mic ready" means the same thing on both branches). Fires the opening turn
  once via the existing `sendText` seam (never a new realtime.ts method).
  Honest fallback (`fellBack`) on mint-timeout (`MINT_DEADLINE_MS`=3s),
  connect-fail/error before ever connecting, or a mic-permission denial.
- NEW `frontend/src/lib/caddie/opening-turn.ts` — `buildOpeningTurnText(shot)`
  extracted from CaddieSheet's inline template so the classic auto-opening
  effect and the live hook speak/type byte-identical text (plan §1.3 "keep it
  in one place"). Minor deviation from the plan's literal file list (which
  described this only as part of the CaddieSheet.tsx edit): it needed its own
  module to avoid a CaddieSheet↔hook circular import — noted here per the
  "minimal sound adjustment" guidance.
- `frontend/src/components/CaddieSheet.tsx` — `wantLive = open &&
  sessionActive && getCaddieLiveMode()`; when eligible, swaps the Voice-tab
  body for `<LiveVoiceBody>` (bubbles restyled from
  `VoiceRoundSetupRealtime`, already `sortByOrder`'d) and the mic footer for
  `<LiveFooter>` (status line + mute toggle, no tap-to-start/stop — server
  VAD runs it). Classic auto-opening-turn effect and the hands-free-loop
  re-arm (`handlePlaybackEnd`) both early-return while live is active — no
  double opening turn, no double mic. Live mode never calls
  `tts.speak`/`beginStream`/`enqueue` — the Realtime client owns its own
  audio sink (kept separate from the #108 iOS classic-path TTS fix).
  Fallback renders the classic mic plus a quiet mono "Tap-to-talk mode"
  line — never a dead sheet. `onClose` (backdrop/drag/X) now stops the live
  client before the parent flips `open` false.
- `frontend/src/app/round/[id]/RoundPageClient.tsx` — one-shot
  `?liveMode=1`/`?liveMode=0` → `setCaddieLiveMode()` persistence effect
  only (no other wiring touched, per plan §5).
- NEW `frontend/src/components/CaddieSheet.realtime.test.tsx` — the 8
  deterministic assertions from plan §7 (adopt-warm, cold-mint, opening
  turn incl. honest-idle, transcript order via the REAL `sortByOrder`, mute,
  3 fallback cases, flag-OFF silent-rider, no-TTS-in-live), 11 tests, all
  green.

**Zero edits** to `realtime.ts` / `warm-session.ts` / `realtime-ordering.ts` /
`lib/caddie/transport.ts` (verified via `git diff --name-only`) — this slice
only consumes their existing public seams, exactly as planned.

**How the owner flips it on-device (stage 1, no shipped UI toggle):** open
`…/round/<id>?liveMode=1` once on his iPhone to turn it on (`?liveMode=0` to
turn off); the pref then persists in localStorage for every later sheet
open. Console fallback on a tethered debug build:
`localStorage.setItem('looper.caddieLiveMode','1')`.

Gates green: `npm run lint` (0 errors), `npx tsc --noEmit` (clean), `npm run
build` (compiled + all routes generated), `npx tsx voice-tests/runner.ts
--smoke` (274/274), `npx vitest run` (81 files / 1681 tests, all green,
including the new file), pinning set
`realtime-warm.test.ts warm-session.test.ts realtime-dispatch.test.ts
CaddieSheet.handsfree.test.tsx CaddieSheet.session.test.tsx` green and
**unmodified** (confirmed via `git status`).

Risk: low — flag defaults OFF, so the shipped behavior for every current
user is byte-identical to today; the new code paths are only reachable once
the owner explicitly opts in via the URL param on his own device. Device
(real WebRTC/VAD) verification is still owner-only, per the parent plan's
"Device-only verification" risk note — CI stays deterministic-mock.

## 2026-07-08 — harden-elevation-writeback-holenumber: validate the write-back key (backend, silent, integration/next, DONE)

Implemented `specs/harden-elevation-writeback-holenumber-plan.md` — commit
`9c5e338`, pushed to `integration/next`. The static elevation write-back added
in `0200576` trusted the request's `holeNumber` as both the DISPLAY value and
the SQL write-back key; an absent holeNumber silently persisted a live
compute onto stored hole 1, and a str/float/None/negative/huge/bool value
flowed straight into the `:hole_number` SQL param.

- `backend/app/services/courses_mapped.py`: `_MAX_HOLE_NUMBER = 36` +
  `_valid_hole_number(value)` (int, not bool, `1..36`) — the ONE shared
  bound. `update_green_feature_properties` now rejects an invalid key
  BEFORE opening a DB session (defense in depth).
- `backend/app/caddie/course_intel.py`: `raw_hole_number` (no default) is
  the write-back key, gated on `courses_mapped._valid_hole_number(...)`;
  invalid -> skip + `log.debug` (non-spammy), never raise. `hole_number`
  (defaulted) stays display-only and unaffected.
  Plan deviation (minimal, noted in the commit): an explicit `holeNumber:
  null` also broke the DISPLAY value — `HoleIntelligence.hole_number` is a
  required pydantic `int`, so `None` raised a `ValidationError` and dropped
  the whole hole's intel, contradicting the plan's own "intel never dropped"
  test requirement. Added a one-line `None -> 1` coalesce for display only;
  the write-back gate already correctly skips this case unchanged.
- `backend/app/routes/caddie.py` `_feature_center`: folded in the related
  cycle-18 backlog note — a malformed same-type feature now `continue`s to
  scan remaining features instead of returning `None` on the first bad one.
- Tests: extended `backend/tests/test_course_intel_static_read.py` (mirrors
  its existing `sys.modules` `app.db` stub + `monkeypatch.setattr` style) —
  write-back skip/proceed matrix, `_valid_hole_number` unit coverage,
  `update_green_feature_properties` returns `False` without opening a DB
  session on an invalid key.

Gates green: `ruff check .` (all checks passed);
`pytest tests/test_course_intel_static_read.py tests/test_precompute_elevation.py`
(46/46 passed); also ran the neighboring
`test_course_intel_resilience.py test_hole_elevation_ingest.py
test_elevation_profile.py` (54/54 passed) as a sanity sweep. No DB-backed
integration test run locally (no local Postgres) — CI backend gate covers
the Postgres round-trip. Silent, backend-only, no shared-type/SQL/migration
change; rides bundle PR.

## 2026-07-08 — fix-ios-voicetel-flush-dropped: immediate flush on iOS failure events + pagehide (frontend, silent, integration/next, DONE)

Implemented `specs/fix-ios-voicetel-flush-dropped-plan.md` verbatim (Option A) —
commit `1c65b49`, pushed to `integration/next`. Voice telemetry was near-blind on
iOS (WKWebView suspends before the 8s batch timer / 12-event count trigger
fires), dropping the highest-signal events (mic_error, speak_failed, etc.).
No auth change, no new unauthenticated surface — everything still rides the
existing Clerk-authenticated `fetch(keepalive)`.

- `frontend/src/lib/voice/telemetry.ts`: `voiceEvent()` gains an optional
  `flush?: boolean` control flag — when set, the event queues then the WHOLE
  queue flushes immediately (ride-alongs included); the flag is never part of
  the queued/POSTed event object. Added a `window` `pagehide` listener
  alongside the existing `document` `visibilitychange` listener (both flush
  via the same authenticated path).
- `frontend/src/hooks/useLooperDictation.ts`: `flush: true` on `mic_error`,
  `live_start_failed`, `live_unsupported`, `resolved_fallback` (success paths
  stay batched).
- `frontend/src/hooks/useSheetTTS.ts`: `flush: true` on both `speak_failed`
  sites and `prime_failed`.
- NEW `frontend/src/lib/voice/telemetry.test.ts` (jsdom, 10 deterministic
  cases — fake timers paired with `vi.useRealTimers()`, module imported once):
  batch-timer flush, count trigger, failure event immediate flush, immediate
  flush drains ride-alongs in order, `flush` flag never leaks into the
  payload, `pagehide` flush, `visibilitychange`→hidden flush (preserved),
  auth header/content-type/URL/keepalive preserved, fetch-rejection and
  authHeaders-rejection both swallowed without wedging the queue.
- `frontend/src/hooks/useSheetTTS.test.ts`: updated the one exact-object
  `prime_failed` matcher to include `flush: true` (only pre-existing test
  edit required per plan).

Gates green: `npm run lint`, `npx tsc --noEmit`, `npm run build`,
`voice-tests/runner.ts --smoke` (274/274), and
`vitest run telemetry.test.ts caddie-turn-timing.test.ts
CaddieSheet.handsfree.test.tsx useSheetTTS.test.ts` (59/59 passed). No backend
file touched, so `ruff` not required (not run). Silent, telemetry-only —
no app-visible surface change; rides bundle PR #109.

## 2026-07-08 — course-intel-static-persistence: persist per-hole elevation, skip USGS on repeat opens (backend, silent, integration/next, DONE)

Implemented `specs/course-intel-static-persistence-plan.md` verbatim — commit
`0200576`, pushed to `integration/next`. course-intel now reads persisted
tee/green elevation + green slope from the stored green feature's JSONB
`properties` (`courses_mapped`) before hitting USGS/3DEP: a cache hit (both
`tee_elevation_ft`/`green_elevation_ft` present) issues ZERO network calls.
A genuine live compute that produces real tee AND green elevations is
best-effort written back via a NEW targeted `update_green_feature_properties`
(single-feature JSONB `||` merge — never `upsert_course`, so it can't race
or clobber curated hazard data mid-round). `/session/start` now fires a
`BackgroundTasks` job (`_precompute_course_elevations`) that samples every
hole still missing persisted elevation (2 batched 3DEP calls), so the
second time the owner opens intel on a course, elevation is instant.

- `backend/app/services/courses_mapped.py`: `update_green_feature_properties`
  (targeted UPDATE, no-op-safe, returns bool) + `_elevation_patch` (maps a
  `compute_hole_elevation_profile` result to the persisted shape,
  `net_change_ft -> delta_ft`, omits `green_slope` when None).
- `backend/app/caddie/course_intel.py`: `build_hole_intelligence` gains
  optional `persisted_elevation`/`course_id`; read-first branch (persisted
  hit -> zero calls) else unchanged live compute + best-effort write-back,
  guarded so it NEVER persists a fabricated 0/None (absent stays absent).
- `backend/app/routes/caddie.py`: `get_course_intel` feeds the green
  feature's persisted props from the stored course it already reads (no
  second `get_course`) via a new `_green_persisted_elevation` helper;
  `start_session` gets a `BackgroundTasks` param and schedules the
  precompute job; added `_feature_center` (reuses `_ring_centroid`) +
  `_precompute_course_elevations` (idempotent — skips already-persisted
  holes, resilient — never raises/fails the request, never `upsert_course`).
- Tests: `backend/tests/test_course_intel_static_read.py` (NEW, non-DB) —
  cache-hit skips `fetch_elevation_cached`/`compute_green_slope`/
  `fetch_3dep_samples` entirely; delta_ft-absent fallback; absent-vs-zero
  (partial live compute never calls `update_green_feature_properties`);
  `_elevation_patch` omit/include green_slope. `backend/tests/test_precompute_elevation.py`
  (NEW, non-DB) — `_feature_center` Point/Polygon/absent; precompute skips
  holes missing tee-or-green and holes already persisted (idempotent),
  zero-sample early return when nothing is computable, resilient to
  `get_course` raising.
- **Deviation from plan (flagged for eng-lead, not improvised around):**
  the plan's DB-backed integration tests (b) `test_course_intel_write_back.py`,
  (d)-DB-half `test_session_precompute.py`, and (e) `test_green_feature_update.py`
  were NOT added. Discovered while implementing: CI's Postgres service
  (`postgres:16`, vanilla, `.github/workflows/ci.yml`) has no PostGIS
  extension, and `tests/integration/conftest.py`'s schema setup only runs
  `Base.metadata.create_all` (ORM models) — it never bootstraps the
  raw-SQL-only `courses`/`tee_sets`/`holes`/`hole_features`/`hole_yardages`
  tables from `backend/supabase/migrations/001_course_mapping_schema.sql`
  (guarded, not touched). This is pre-existing: no test in the repo
  exercises `courses_mapped` against a live DB today. Adding these three
  files as specified would either error at schema creation in CI (no
  PostGIS) or require changing the shared CI Postgres service image —
  out of scope for this backend-only plan. Recommend a follow-up infra
  item: swap CI's postgres service to a PostGIS-enabled image (e.g.
  `postgis/postgis:16-3.4`) and add a schema-bootstrap fixture for the
  course-mapping tables to `tests/integration/conftest.py`.
- Gates: `ruff check .` clean; `pytest tests/ --ignore=tests/integration -q`
  → 1045 passed (incl. the 2 new files, 42 tests covering this change);
  frontend `tsc --noEmit` clean (no frontend change); `voice-tests/runner.ts
  --smoke` → 274/274 pass. DB-backed integration tests NOT run locally
  (no Postgres on this machine) — see deviation note above re: CI coverage.
- Silent (backend-only, no user-visible change) — rides along in the
  `integration/next` bundle.

## 2026-07-07 — caddie-opening-reco-from-tee: honest from-the-tee fallback for the auto opening reco (frontend, noticeable, integration/next, DONE)

Implemented `specs/caddie-opening-reco-from-tee-plan.md` exactly — commit
`5c9b6db`, pushed to `integration/next`. When the auto opening caddie
recommendation can't get a live GPS fix (absent/denied/timeout) OR the fix is
implausible (>800y from the green), it now falls back to a from-the-tee
recommendation instead of staying idle — phrased honestly ("I'm on the tee,
about 365 to the pin. What should I hit off the tee?"), never claiming a
position the player isn't at. Covers home testing and the first tee before
GPS lock. All existing honest-null cases preserved (no green -> null; no GPS
& no tee -> null).

- NEW `frontend/src/lib/caddie/opening-shot.ts` — pure, DOM/GPS-free helper
  `resolveOpeningShotDistance(gps, tee, green)` with the exact branch order
  from the plan: no green -> null; plausible GPS wins; implausible GPS FALLS
  THROUGH to the tee fallback (the core new behavior — was the bug); usable
  tee -> `{ fromTee: true }`; else -> null. Same `1..800y` bounds on both
  paths. 6 unit tests (`opening-shot.test.ts`) cover every branch incl. the
  implausible-GPS-falls-through case.
- `RoundPageClient.tsx`: `resolveOpeningShot` keeps the async GPS acquisition
  + `withTimeout` in place, now delegates the distance math to the new
  helper (added `teeForHole` alongside `greenForHole`).
- `CaddieSheet.tsx`: prop type widened to
  `{ distanceYards: number; fromTee?: boolean } | null`; only the `const q`
  question-string line branches on `shot.fromTee` for tee wording. The
  `openingGenRef`/`openingFiredRef`/pristine-idle guard block was left
  byte-for-byte untouched per the plan.
- `CaddieSheet.session.test.tsx`: added a tee-phrasing test, a regression
  lock that the GPS path never says "on the tee", and a null-path assertion
  that idle never shows tee phrasing either.
- No deviation from the plan. No shared-type/DTO changes (`types.ts`,
  `models.py` untouched, confirmed — this shape is a local UI contract only).
- Gates: `npm run lint` clean, `tsc --noEmit` clean, `npm run build` green,
  `voice-tests/runner.ts --smoke` 274/274 pass, full `vitest run` 1660/1660
  pass (incl. new + touched tests).

## 2026-07-07 — caddie-realtime-conversation Slice A2: sentence-level TTS pipelining (frontend, noticeable-leaning latency, integration/next, DONE)

Implemented `specs/caddie-realtime-conversation-plan.md` §6.5.4 (Slice A2) —
commit `77a0f79`, pushed to `integration/next` (rolling bundle PR #109).
Removes the "text finishes streaming, THEN voice starts" gap on the classic
sheet path (`CaddieSheet.tsx` `askCaddie`) the owner described in his
2026-07-07 latency feedback — TTS now starts on the FIRST sentence while the
rest of the reply is still streaming, instead of waiting for the whole reply.

- NEW `frontend/src/lib/caddie/sentence-stream.ts` — pure incremental
  sentence extractor (regex boundary + a short abbreviation/number-guard
  list), 14 unit tests covering the tricky false positives from the plan
  ("165 yds." stays one sentence, "Nice drive. Now hit the 8." splits,
  decimals never split, multi-punctuation "Really?! Go." splits, trailing
  partial buffers until `flush()`).
- `frontend/src/hooks/useSheetTTS.ts` — added `beginStream()`/`enqueue()`/
  `endStream()` as a queued-playback mode alongside the existing `speak()`.
  Internally rebuilt as a single ordered play queue (each chunk synthesized +
  abortable independently, always played sequentially on the ONE persistent
  `<audio>` element); `speak()` is now sugar for "one-chunk turn" over the
  same queue, so it is 100% behavior-preserving for every existing caller.
  +8 new unit tests proving the hard invariants: `onSpeakStart` fires once
  per turn (chunk 1 only), `onPlaybackEnd` fires once — only after the LAST
  chunk's natural `ended`, never between chunks (this is the invariant that
  matters most: firing mid-reply would re-arm hands-free while the caddie is
  still talking) — `stop()`/a new `speak()` clears the whole queue + aborts
  pending synths with no re-arm, and a failed `play()` ends the turn silently
  (mirrors old behavior — a TTS failure never re-arms hands-free).
- `CaddieSheet.tsx` `askCaddie`: `onToken` feeds the segmenter incrementally
  and `enqueue()`s each completed sentence (guarded by the existing
  `isStale()`, so a superseded turn never enqueues); a
  `MIN_TTS_CHUNK_CHARS = 20` merge threshold holds short fragments (e.g.
  "Easy 7.") and merges them with the next sentence rather than burning a
  `/speak` call on 2–3 words. At completion, reconciles the un-enqueued tail
  against the authoritative `responseText` so the full reply is spoken
  exactly once — no drop, no duplicate. When nothing was pipelined mid-stream
  (short reply, or the non-streaming fallback tier with zero tokens),
  completion falls back to the EXACT old single `tts.speak(responseText)`
  call — unchanged behavior for short/simple replies. Errors/aborts now also
  call `tts.stop()` so a discarded partial reply is never spoken.
- Plan deviation (noted per the builder brief): the task described removing
  `tts.speak()` from the streaming path outright. Kept it as the queue's
  single-chunk fallback instead (functionally identical — one call, whole
  text, same invariants) specifically so `CaddieSheet.session.test.tsx` /
  `.handsfree.test.tsx` — whose every scripted reply is short enough to stay
  under the merge threshold — pass **byte-for-byte unmodified except for**
  adding `beginStream`/`enqueue`/`endStream` stubs to their `useSheetTTS`
  mocks (the hook's API surface grew; every existing assertion is untouched,
  plus 2 new assertions confirming `enqueue()` is NOT called in those
  fallback scenarios). This was traced carefully call-by-call before
  implementing — see the hook's internal design comments.
- Cost note (per the brief): pipelining trades one full-reply `/speak` proxy
  call for N per-sentence calls on longer replies. The
  `MIN_TTS_CHUNK_CHARS` guard keeps this lean — only real, substantial
  sentence boundaries pipeline; short replies and stray fragments still
  collapse to one call, same as today.
- Out of scope (untouched, as directed): `lib/voice/realtime.ts`,
  `warm-session.ts`, `stream-buffer.ts` and its tests — this is the classic
  Deepgram+SSE+`useSheetTTS` path only; the live-mode Realtime path (§5) is
  unaffected.

Gates (all GREEN, evidence): `npm run lint` 0 errors; `npx tsc --noEmit`
clean; `npm run build` ok; `npx tsx voice-tests/runner.ts --smoke` 274/274;
`npx vitest run` **78 files / 1650 tests, all passing** (+37 new tests: 14
segmenter + 8 queue-mode + existing suites untouched-and-still-green).

Classification: **noticeable-leaning latency improvement** on the classic
caddie-sheet path (device-perceivable: caddie voice should start noticeably
sooner on multi-sentence replies) — rides on bundle PR #109 with the
already-shipped stage-timing telemetry (silent) that will make the
before/after `caddie.eos_to_first_audio` numbers visible on the owner's
device. Slice C (Realtime transport migration) remains deferred/not started.

## 2026-07-07 — caddie-realtime-conversation: stage-timing telemetry slice (frontend, SILENT, integration/next, DONE)

Cycle 15 (owner-triggered). Implemented the **stage-timing telemetry** slice of
`specs/caddie-realtime-conversation-plan.md` §6.5.3 (own contract:
`specs/caddie-realtime-telemetry-plan.md`, opus-planned this cycle) — commit `6fcb40d`,
pushed to `integration/next`. Makes the owner's latency pain ("long pause between speak →
transcribe → text → voice", v1.0.808 feedback) **measurable on his real device** before
we attack it. SILENT: telemetry events only, no UI, no behavior change.

- NEW `frontend/src/lib/voice/caddie-turn-timing.ts` — `createCaddieTurnTimer` factory:
  per-turn marks (`markEos/markTranscript/markFirstToken/markFirstAudio`), complete-legs-only
  emission, sanity clamp (drop `<=0` / `>60000ms`), once-per-turn guards, `markEos()` as the
  per-turn reset, injectable `now`/`emit`/`flush`, full try/catch swallow (can never throw
  into audio/dictation). Monotonic `performance.now()`.
- Classic sheet path (`CaddieSheet.tsx` + new `onSpeakStart` callback on `useSheetTTS.ts`):
  emits `caddie.eos_to_transcript`, `caddie.transcript_to_first_token`,
  `caddie.first_token_to_first_audio`, and the headline `caddie.eos_to_first_audio`.
  `useSheetTTS` stays a pure audio hook (signals "audio started", emits no telemetry itself).
- Realtime orb path (`useVoiceCaddie.ts`, CONSUMER-only via `handleConnectionStatus`
  status-transition detection): `markEos` on `listening`→`connected` (= `speech_stopped`),
  `markFirstAudio` on first `speaking`. **`realtime.ts` + `warm-session.ts` NOT touched** —
  warm-path hard gate deliberately not tripped. Honest proxy caveat documented (first
  `response.audio_transcript.delta` as "voice starting", the closest consumer-observable seam).
- **iOS must-fix:** headline `caddie.eos_to_first_audio` calls `flushVoiceEvents()`
  synchronously at turn end (keepalive already set) so the one number we care about survives
  the known "voicetel flush-drop" background batch death.
- No new endpoint / schema; rides the existing authed `POST /api/voice/telemetry` (surface/
  event are free-form str on the backend — confirmed no backend change needed).

Gates (all GREEN, evidence): `npm run lint` 0/0; `npx tsc --noEmit` clean; `npx vitest run`
**1628 passed / 77 files** incl. new `caddie-turn-timing.test.ts` (8) + extended
`useSheetTTS.test.ts` (+2) + extended `CaddieSheet.handsfree.test.tsx` (+1);
`voice-tests/runner.ts --smoke` 274/274; `npm run build` ok. Backend unchanged (no backend gate).
**CI on PR #109 @ 6fcb40d:** backend gate PASS, frontend gate PASS (E2E advisory settling).
**Reviewer: CLEAN** — 7/7 invariants + security (no PII in payloads); one NON-BLOCKING
cross-turn-skew note already anticipated by the plan (clamp backstop, self-correcting).

Classification **SILENT** → bundle PR #109 stays open, accumulating; **not** requesting owner
approval. NEXT latency slice = **A2 (sentence-level TTS pipelining)**, now measurable via
these markers (plan §6.5.4 BUILD-conditional). Slice C (transport migration) still deferred
(multi-cycle, flag-gated, device-verified — not started).

## 2026-07-07 — caddie-realtime-conversation Slice A: Realtime mint grounding parity (backend-only, silent-leaning, integration/next, DONE)

Implemented **Slice A ONLY** of `specs/caddie-realtime-conversation-plan.md` (commit
`34c1222`) — backend grounding parity between `build_realtime_instructions` (the
OpenAI Realtime mint, used today by the round-page orb) and `_build_session_voice_prompt`
(the sheet's text session path). No transport/frontend change; `realtime.ts` and the
warm-path invariants were not touched.

- `backend/app/caddie/voice_prompts.py`: `_situation_block` now also renders green slope
  (`hole_intel.green_slope.description`), last recommendation (club/target/aim/miss), and
  recent shots (last 5) — all guarded (`if present`). New `_conversation_history_block`
  renders the last ~20 `session.conversation_history` turns into a new "Earlier this round"
  section in `build_realtime_instructions`. **Discovery vs the plan:** no change was needed
  in `backend/app/routes/realtime.py` — `get_owned_session` already hydrates
  `conversation_history` from `caddie_messages` into the `RoundSession`, and
  `start_realtime_session` already passes the full `session` object into
  `build_realtime_instructions`; the gap was purely that the prompt builder wasn't
  rendering it. Noted here per the "minimal sound adjustment" rule rather than silently
  deviating.
- `backend/app/routes/caddie.py`: `get_session_conditions` (`get_conditions` tool payload)
  now includes `green_slope: {description}` (None when unmapped — honest, same discipline
  as hazards). `get_session_status` now includes `recent_shots` (last 5).
- `backend/app/services/realtime_relay.py`: `get_conditions` tool description mentions
  green slope; kept the "never name an unmapped hazard" wording intact.
- New `backend/tests/test_realtime_grounding.py` — 17 pure unit tests (no DB): each gap
  present vs absent, byte-identical-when-absent (`test_absent_grounding_fields_are_byte_identical`),
  HAZARD_GROUNDING_RULE untouched/undupped, plus route-handler-level tests for the two grown
  tool payloads (`get_session_conditions` green_slope, `get_session_status` recent_shots) via
  the same `get_owned_session` monkeypatch pattern as `test_realtime_tools.py`.

Gates: `ruff check .` clean; `uv run pytest -q` → 1034 passed, 74 skipped (DB-gated
integration tests skip locally — no local Postgres per policy; CI runs those), including the
new file's 17/17 and the pre-existing `test_realtime_tools.py`/`test_realtime_payload.py`/
`test_setup_voice.py` (28/28) unmodified and still green. Frontend sanity (backend-only
change): `npm run lint` clean, `npx tsc --noEmit` clean, `voice-tests/runner.ts --smoke` →
274/274 — all unchanged, confirming no frontend drift. Pushed to `integration/next`
(`34c1222`).

**Classification:** noticeable-leaning per the task brief (it makes the live orb caddie
smarter today — it now remembers earlier-this-round conversation, references green slope/
last rec/recent shots) but the change is entirely inside the mint's instructions string and
existing tool JSON — no new endpoint, no schema/type change, nothing for QA to click through
distinctly from "the caddie seems to remember more." Rides in the bundle; no separate ping
needed. Slice C (the actual tap-to-talk → continuous-listen transport migration the owner
asked for) is NOT done — it's the high-risk slice, explicitly deferred per the plan's own
recommendation, to be planned/device-verified separately.

**Eng-lead review (this cycle):** reviewer CLEAN (guards prove byte-identical when
absent; attribute-safe against the real models; HAZARD_GROUNDING_RULE intact; owned-session
gated, no injection surface — one non-blocking nit that a test name oversells a
near-tautological assertion, real coverage exists elsewhere, not worth a round-trip). QA
PASS (ruff clean; 1034 passed / 74 DB-skipped; grounding 17/17; frontend lint/tsc/voice
274/274). Classified **SILENT** for the ship gate — no distinct owner-testable surface, so
it rides the bundle; no owner ping.

**Plan updated mid-cycle with owner latency feedback (2026-07-07, testing v1.0.808):**
"long pause between when I speak, transcribing, the text coming out, and then the voice."
Folded into `specs/caddie-realtime-conversation-plan.md` as a FIRST-CLASS requirement:
§6.5 — **end-to-end latency is now the top success metric (≤~1.5-2.0s end-of-speech →
voice)**, with a stage-by-stage table (current classic path ~3-5s: 1.2s Deepgram VAD tail +
TTS-waits-for-full-text) vs Realtime speech-to-speech (~0.8-1.5s, no STT→text→TTS trip);
§6.5.3 stage-timing voicetel telemetry (headline `eos_to_first_audio` must flush immediately
to survive the iOS voicetel flush-drop); §6.5.4 interim-mitigation decision — BUILD a LEAN
sentence-level TTS pipelining stopgap (slice A2) ONLY IF Slice C won't land device-verified
within ~2 cycles (durable: the classic path is the permanent honest-degradation fallback,
so not throwaway), else SKIP. Backlog updated with the latency metric + A2/telemetry slices.

**Next cycle:** Slice C is a device-verified-behind-a-flag migration (multi-cycle) — do NOT
rush it into a bundle the owner can't test on-device. Decide A2 (interim TTS pipelining) vs
straight-to-C based on C's timeline; the queued `caddie-opening-reco-from-tee` composes with
C's opening-turn seam.

## 2026-07-07 — fix-ios-tts-playback: caddie TTS on-device fix (P0, NOTICEABLE, integration/next, DONE)

Implemented `specs/fix-ios-tts-playback-plan.md` exactly (commit `35c4103`). Owner's iPhone was
getting `NotSupportedError` on every spoken caddie reply, which also silently stalled the
hands-free loop (only re-arms on the audio element's `ended`).

- **Part A (the real fix)** — `frontend/src/lib/caddie/api.ts` `speakCaddieReply` now
  platform-branches: native (`Capacitor.isNativePlatform()`) bypasses the patched-`fetch` binary
  path entirely and calls `CapacitorHttp.request({..., responseType:'blob', readTimeout/
  connectTimeout: SPEAK_TIMEOUT_MS})` directly, reconstructing the mp3 via the already-tested
  `dataUrlToBlob` (`@/lib/scan-helpers`) so bytes + `Blob.type` are both correct. Web keeps
  `fetch` but always re-types via `arrayBuffer()` instead of `res.blob()`.
- **Part B (hardening)** — `frontend/src/hooks/useSheetTTS.ts`: `unlock()` now primes the shared
  audio element with a real silent-mp3 data URI (module-level `SILENT_MP3_DATA_URI`) before the
  bless play/pause, instead of blessing an empty-`src` element. New `playingRealRef` guards the
  `ended` re-arm so the prime clip can never spuriously fire `onPlaybackEnd` — only set true right
  before `speak()`'s real `.play()`. `unlock()` failures now emit distinct `prime_failed`
  telemetry (vs `speak_failed`).
- Tests: new `frontend/src/lib/caddie/api.speak.test.ts` (web typed-blob, native base64→blob
  asserting `responseType:'blob'`, native error path); extended
  `frontend/src/hooks/useSheetTTS.test.ts` (prime src, element reuse, barge-in/re-arm invariants,
  prime-`ended`-is-inert, `prime_failed` telemetry). `CaddieSheet.handsfree.test.tsx` /
  `CaddieSheet.session.test.tsx` re-verified green, untouched.
- **Deviation (noted, minimal):** the plan's test (f) used `new DOMException(...)` to force
  `unlock()`'s `play()` rejection; jsdom's `DOMException` isn't `instanceof Error` (a documented
  jsdom gap — real WebKit's is, which is why prod telemetry already showed the real
  `NotSupportedError` name), so it would've reported `detail: "unknown"` under test instead of the
  plan's asserted `"NotAllowedError"`. Used a plain `Error` with `.name` set instead — same code
  path, deterministic in jsdom, matches how the pre-existing `speak_failed` test in this same file
  already worked around the identical quirk (`expect.any(Object)`).
- Backend untouched (no ruff/DB/migration needed).

Gates: `npm run lint` clean, `npx tsc --noEmit` clean, `npm run build` succeeded,
`voice-tests/runner.ts --smoke` → 274/274, `vitest run useSheetTTS.test.ts api.speak.test.ts
CaddieSheet.handsfree.test.tsx CaddieSheet.session.test.tsx` → 54/54 (4/4 files). Pushed to
`integration/next` (`35c4103`). **Noticeable** — the caddie's spoken replies (and the hands-free
loop's re-arm) should now work on TestFlight; worth a device/TestFlight confirm per the plan's
post-merge check (`voicetel surface=sheet-tts` should show `speak` succeeding, no
`speak_failed`/`NotSupportedError`).

### eng-lead cycle 13 wrap-up (owner-directed: "main thing I want to focus on is the caddie")
- Plan authored on opus (`specs/fix-ios-tts-playback-plan.md`) — correctly ruled OUT the gesture
  hypotheses (those throw `NotAllowedError`, not the observed `NotSupportedError`) and pinned the
  real cause on the CapacitorHttp binary round-trip / untyped Blob, with primed-audio + telemetry
  as composable hardening.
- Builder stalled a few times before committing (needed nudges to clean a stray
  `frontend/src/__scratch__/` and commit) — landed `35c4103` clean, scratch removed.
- eng-lead re-verified gates locally: lint clean · tsc clean · voice smoke 274/274 · the 4 vitest
  suites 54/54 (incl. handsfree+session re-arm/barge-in invariants). **PR #108 CI all green**:
  Frontend gates pass · Backend gate pass · E2E smoke advisory pass.
- `reviewer` (adversarial correctness + security, incl. /security-review + /code-review):
  **SHIP**, no blocking issues. Traced every `playingRealRef` re-arm path (prime clip inert; real
  reply re-arms exactly once; stop/overlap/barge-in/unmount never re-arm); confirmed native path
  keeps `authHeaders()`, never feeds the base64 error body to the player, and that the dropped
  `AbortSignal` is compensated by the caller's post-await aborted guard. Two harmless NON-BLOCKING
  notes (both "not required to ship"): (1) the real-`play()` catch could also clear
  `playingRealRef` for tidiness (harmless — a failed play produces no `ended`); (2) empty native
  `resp.data` degrades to a swallowed `speak_failed`, no crash. Left as-is per cost discipline; not
  worth a churn commit.
- No designer (zero UI change — audio plumbing + telemetry only).
- PR #108 checklist updated → **bundle is now NOTICEABLE** (caddie voice + hands-free re-arm start
  working on the owner's iPhone). Per the directive the owner is active in-session, so NO push
  notification and no TestFlight/release-manager dispatch this cycle — the bundle **awaits his
  in-session "ship it"** (or feedback). On ship-it, next cycle's step 0 hands #108 to
  release-manager (`integration/next` → `main`) and cuts a fresh bundle.

**Telemetry-volume note (per directive):** voicetel volume is near-blind — ~1 event in 4h of the
owner's live session. `lib/voice/telemetry.ts` flushes on an 8s timer / 12-event batch /
`visibilitychange`→hidden with a `keepalive` fetch; on iOS WKWebView `pagehide` is more reliable
than `visibilitychange`, and the CapacitorHttp-patched fetch may not honor `keepalive` when the
webview suspends → queued events likely die on background/kill. NOT fixed this cycle; filed as
targeted backlog card `fix-ios-voicetel-flush-dropped` (needs-spec). This matters because our
on-device visibility into whether the TTS fix worked depends on that flush path.

Also queued (p1-ready, NOT built this cycle) per owner's other two asks:
`caddie-opening-reco-from-tee` (FROM-THE-TEE fallback reco when GPS absent/implausible >800y) and
`course-intel-static-persistence` (compute elevation/green-slope once per course, persist on the
mapped course record).

## 2026-07-07 — wind-periodic-refresh: keep the wind tile fresh through a round (SILENT, integration/next, DONE)

Implemented `specs/wind-periodic-refresh-plan.md`. One Open-Meteo grid-cell reading was
persisting for a whole 4+ hour round — quietly re-fetches it now instead of faking anything
new: still one reading for the whole course, still zero per-hole speed synthesis, per-hole
DIRECTION math (`relativeWind`, `lib/map/wind.ts`) untouched.

- New `frontend/src/lib/map/weather-freshness.ts`: pure `isWeatherStale(fetchedAt, now,
  thresholdMs)` (`WEATHER_STALE_MS`=20min, `WEATHER_REFRESH_INTERVAL_MS`=25min) +
  `WeatherRefreshScheduler` (mirrors `lib/voice/idle-timer.ts`'s `IdleTimer`, bare
  `setInterval`/`clearInterval`). Plan called for `window.setInterval` — deviated: this
  tsconfig's `@types/node` makes `window.setInterval`'s return type `NodeJS.Timeout`, not
  `number` (`ReturnType<typeof window.setInterval>` failed `tsc`). `setInterval`/`clearInterval`
  aren't the `requestAnimationFrame` cross-file-polyfill-leak case from lessons.md (that's an
  ad-hoc jsdom RAF patch); they're real Node/jsdom globals `vi.useFakeTimers()` swaps cleanly,
  so bare (matching `IdleTimer`'s actual working pattern) is both correct and precedented.
- New `frontend/src/lib/map/weather-freshness.test.ts`: pure predicate tests + deterministic
  `vi.useFakeTimers()`/`advanceTimersByTime` scheduler tests (start/stop/no-double-arm/custom
  interval/isArmed) — 23 tests total with `wind.test.ts`.
- `frontend/src/app/round/[id]/RoundPageClient.tsx`: added client-side `weatherFetchedAt`
  state; one `applyWeather` writer that all 3 existing `setWeather` call sites now route
  through (retry ladder success, course-intel `intel.weather`, course-intel anchor-only path)
  so the timestamp can never drift from the reading; idempotent `refreshWeather`
  (`refreshInFlightRef` coalesces overlapping triggers, `catch` is a no-op — never clobbers a
  good reading or the honest `—`); a ~25-min periodic effect gated on the round being active
  (`round.status !== 'completed'`); a hole-change effect (`prevHoleRef`) that refreshes only
  when `isWeatherStale`; a `visibilitychange` foreground catch-up (native suspends JS intervals
  backgrounded). All new effects clean up their timer/listener.

Gates: `npm run lint` clean, `npx tsc --noEmit` clean, `npm run build` succeeded,
`voice-tests/runner.ts --smoke` → 274/274, `vitest run weather-freshness.test.ts wind.test.ts`
→ 23/23, full `npm run test` → 1602/1602 (75/75 files). No backend files touched, no shared-type
changes (`fetchedAt` is client-side receipt time only, per plan §4) — `ruff` not required.
Silent — no new UI/chrome, rides the bundle.

## 2026-07-07 — fix-course-intel-none-yards: honest empty state instead of the "+0ft on every hole" crash (NOTICEABLE, integration/next, DONE)

Implemented `specs/fix-course-intel-none-yards-plan.md` exactly. Root cause: `build_hole_intelligence`
did `yards + round(elevation_change / 3)` where `yards` could be `None` — a stored round with no
yardage sends `{yards: null}`, and `dict.get(key, default)` in `routes/caddie.py` only substitutes on
an *absent* key, not a present `null`, so every hole crashed and the per-hole `except` silently
discarded the hole's whole intel (elevation included) — the incident #106's logging was added to name.
par/handicap had the same latent crash via pydantic's required `int` fields.

- `backend/app/caddie/types.py`: `HoleIntelligence.yards`/`effective_yards` → `Optional[int] = None`.
- `backend/app/caddie/course_intel.py`: widened `par`/`yards`/`handicap_rating` params to
  `Optional[int]`; added central coalescing (par/handicap → defaults 4/9 when not a real int, bool
  excluded; yards → honest `None` when not numeric, else `int(round(yards))`); line 55
  `effective_yards = None if yards is None else yards + round(elevation_change / 3)`.
- `backend/app/routes/caddie.py:1004-1006`: `hc.get("par")`/`hc.get("yards")`/`hc.get("handicap")` —
  dropped the misleading defaults so absent-key and null-value converge on one path.
- `frontend/src/lib/caddie/types.ts`: `yards`/`effective_yards` → `number | null` to mirror; existing
  consumers already null-tolerant (`?? 0`, `|| undefined`), verified no new tsc break.
- Added `test_none_inputs_never_throw_and_stay_honest` to `backend/tests/test_course_intel_resilience.py`
  (non-DB, no network — no tee/green skips elevation fetch).

Gates: `ruff check .` clean; `uv run pytest tests/test_course_intel_resilience.py` → 2/2 passed, no
DB required; `npm run lint` clean; `npx tsc --noEmit` clean; `npm run build` succeeded;
`voice-tests/runner.ts --smoke` → 274/274. Committed `8529820` to `integration/next`, pushed.
Noticeable — restores the dead Elev / "plays like" tile on rounds with no stored yardage instead of
silently zeroing it.

ENG-LEAD CLOSE (loop cycle 10): reviewer verdict SHIP (no-clobber/timer-leak/stale-closure/
round-gating invariants all traced and hold; deterministic tests would fail if the bugs were
reintroduced); QA PASS (independently re-ran full vitest 1602/1602 TWICE, no cross-file
fake-timer leak). Two non-blocking reviewer nits logged in backlog under wind-periodic-refresh
(chief: completed-round hole-nav/foreground still refetches weather — fold the round-active
guard in next time RoundPageClient is touched; benign, event-driven, not a loop). Committed
96cb16e; backlog cleanup 2326b94. Opened the fresh rolling **bundle PR #107** (integration/next
→ main), first item, SILENT-only; CI 1 pass / 1 pending / 0 fail. Board card "Bundle #107"
created in In Progress (NOT Needs Review — no noticeable change, no approval requested). NO push
notification (silent-only bundle, per standing rule). Also handled Step 0: no owner feedback on
either #106 card; moved the stale #106 "Needs Review" test card → Shipped so future cycles don't
misread it as a pending approval. Bundle #107 now accumulates until a noticeable item lands.

## 2026-07-07 — caddie-conversational-loop follow-up: designer-caught answer-wipe bug (SILENT fix, integration/next, DONE)

Designer review of `eded238` found ONE blocking UX bug (everything else — reviewer verdict SHIP,
gates green — was confirmed correct): the loop's auto re-arm wiped the caddie's just-spoken
answer off screen ~400-500ms after it finished speaking. Root cause: `startListening` did an
unconditional `setVoiceAnswer(null)` at its top — which now ALSO ran on the loop's auto re-arm,
not just a manual tap — and `VoiceBody`'s `AnimatePresence mode="wait"` treated the mic reopening
(phase ranks `listening` above `answered`) as a key change, hard-swapping the answer card out for
the waveform. Corollary: during the ~400-500ms grace window before the mic actually reopened, the
mic label still read "Tap to ask again" — the exact instruction the owner asked removed — while
the loop was silently counting down to listen.

Fix (minimal, no new chrome, no new toggle):
- `startListening`: reads `armedByLoopRef.current` BEFORE deciding whether to clear
  `voiceAnswer` — a manual tap clears it immediately (unchanged); a loop-driven auto re-arm
  leaves it alone.
- `VoiceBody`: the "voice-answer" card's key now covers `phase === "answered" || phase ===
  "listening"` (when `voiceAnswer` is set) instead of only `"answered"` — so `mode="wait"` never
  swaps it away on a loop re-arm. A `ListeningIndicator` (extracted, shared with the bare
  no-answer listening state) renders underneath the persisting card while listening; the
  follow-up/clear CTAs unmount during that phase (a new turn is already in flight) instead of
  staying live — designer nice-to-have, done.
- Two loop-armed-listen-concludes-with-nothing paths (`registerLoopEmpty`, the dead-air timeout)
  now explicitly clear `voiceAnswer` — without this, an abandoned/failed re-listen would leave a
  permanent "ghost" answer + a masked-error risk (the phase ordering ranks `voiceAnswer` above
  `error`). Reverts to the original "Tap to speak" idle exactly as before this fix once a listen
  produces no new turn.
- Mic label: added a `phase === "answered" && ttsEnabled && !loopDroppedOut` branch → "Tap to
  interrupt" (a tap still works — it barges in early) instead of "Tap to ask again" whenever a
  loop re-arm is imminent or in its grace window.

Tests: +6 deterministic cases in `CaddieSheet.handsfree.test.tsx` (opening-reco first-turn
persistence, later-turn persistence + CTA hide, manual-tap-still-clears, no-contradictory-label-
during-grace, abandoned-listen-reverts-to-idle) — all hand-driven fake timers, same discipline as
the existing 8. Gates: `npm run lint` clean, `npx tsc --noEmit` clean, `npm run build` succeeded,
`voice-tests/runner.ts --smoke` → 274/274, targeted vitest (handsfree + session + useSheetTTS) →
44/44, full `npm run test` → **1590/1590 pass, 74/74 files**. Committed to `integration/next` and
pushed. Silent — same feature as `eded238`, no new user-visible surface, rides the bundle
(the parent commit was already flagged noticeable).

## 2026-07-07 — caddie-conversational-loop: hands-free Ask Caddie (NOTICEABLE — integration/next, DONE)

Implemented `specs/caddie-conversational-loop-plan.md` on the existing Deepgram-dictation +
`useSheetTTS` path (no Realtime routing, per the plan's transport decision). After the caddie
**speaks** a reply, the sheet now automatically re-arms the mic — the golfer talks, pauses, and
the caddie proceeds, no tap-per-turn. Hands-free is IMPLICIT: armed whenever the sheet is open,
mode is "voice", and the persisted speaker toggle (`ttsEnabled`) is on — no new UI. Composes
with the just-shipped auto opening reco with zero special-casing (its playback-end re-arms like
any other turn).

- `useSheetTTS.ts`: added optional `useSheetTTS(opts?: { onPlaybackEnd?: () => void })`, still
  callable with no args. Split the audio element's listeners — `ended` → `setIsSpeaking(false)` +
  `onPlaybackEndRef.current?.()`; `pause` → `setIsSpeaking(false)` only — so `stop()`/a new
  `speak()`/barge-in can never trigger a re-arm.
- `CaddieSheet.tsx`: `REARM_GRACE_MS=400` (echo/iOS-route guard past playback end),
  `DEAD_AIR_MS=6000` (armed-but-silent drop-out — UtteranceEnd never fires on pure silence),
  `MAX_EMPTY_STREAK=2` (belt-and-braces for ambient noise). `handlePlaybackEnd` guards on
  `open && mode==="voice" && ttsEnabledRef.current && !loopDroppedOutRef.current && !isListening
  && !isTranscribing && !isThinking && !isStreaming`, then a grace timer → `startListening`.
  `armedByLoopRef` distinguishes an auto re-arm (runs the dead-air timer, counts toward the
  empty-streak) from a manual tap (doesn't). Barge-in (tap mic while speaking) clears the grace
  timer, stops playback (fires `pause`, not `ended` — no re-arm from the interruption), and
  resets drop-out/streak. Drop-out UI is the existing calm idle "Tap to speak" block — no error,
  no red. Sheet-close/unmount clears both timers, resets streak, clears drop-out.

**Deviation from the plan (minimal, sound — flagged per instructions):** the plan's
`handlePlaybackEnd` guard listed `!streamAbortRef.current` as one of the conditions. Read
literally this breaks the feature entirely: `streamAbortRef` is set once per `askCaddie` call and
(pre-existing design, unrelated to this plan) is only ever cleared to `null` on sheet close/
unmount — never after a turn settles — so gating on its mere presence would block every re-arm
after the very first turn, permanently, in production. Dropped that one condition; `isThinking`/
`isStreaming` already fully express "a turn is in flight" (the same pair `showMic` already gates
the mic's reappearance on), so they are sufficient. Caught by the new deterministic test 8 (happy
multi-turn loop) failing on the very first re-arm attempt before the fix.

Tests: new dedicated `CaddieSheet.handsfree.test.tsx` (10 cases, owns `vi.useFakeTimers()`,
scoped + `afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); })` so no stub leaks —
playback-end re-arm, grace-delay boundary, speaker-off no-op, dead-air drop-out (+ interim
cancels it), empty-streak drop-out, barge-in, sheet-close cleanup (2 sub-cases), happy multi-turn
loop with streak reset); extended `useSheetTTS.test.ts` (+2: `ended` fires `onPlaybackEnd`,
`pause` does not). `CaddieSheet.session.test.tsx` stayed green unmodified (its TTS mock ignores
the new optional arg). Gates: `npm run lint` clean, `npx tsc --noEmit` clean, `npm run build`
succeeded, `voice-tests/runner.ts --smoke` → 274/274, targeted vitest (handsfree + session +
useSheetTTS) → 39/39, full `npm run test` → **1585/1585 pass, 74/74 files** (no cross-file
fake-timer leak). Committed to `integration/next` and pushed. Noticeable — the Ask Caddie sheet
now converses hands-free once the speaker is on; device-verify the playback→record iOS audio-
session switch on TestFlight per the plan (only fully testable on a real device).

## 2026-07-07 — caddie-auto-shot-reco follow-up: fixed a review-caught race (SILENT fix, integration/next, DONE)

eng-lead's review of `e5a9526` found ONE blocking correctness bug (idempotency, honest-
fallback, TTS gating, and the `openingGenRef` deviation were all confirmed correct): the
in-flight guard (`voiceAnswer || isThinking || isListening`) only ran synchronously at
effect-open time, BEFORE the up-to-6s GPS await. If the golfer tapped the mic and asked their
own question DURING that wait, the GPS continuation would still fire — aborting the user's
in-flight stream via `streamAbortRef` and overwriting their transcript with the canned
opening question. Reachable on the single most common path (fresh open, empty history).

Fix (`e8141d7`): re-check pristine-idle state via REFS (`streamAbortRef`, `recorderRef`,
`convHistoryRef`) immediately after the gen check, before touching transcript/askCaddie — bail
silently if any turn is in flight, recording, or already completed. Added case (f) to
`CaddieSheet.session.test.tsx`: a hand-controlled deferred holds the GPS fix pending while the
golfer's own turn starts and streams, then the GPS resolves — asserts no second
`sessionVoiceStream` call, the auto question never renders, and the user's turn completes
untouched (answer, history, TTS, follow-up, mic re-arm). Gates all green: `npm run lint`
clean, `npx tsc --noEmit` clean, `npm run build` succeeded, `voice-tests/runner.ts --smoke` →
274/274, `vitest run CaddieSheet.session.test.tsx` → 22/22, full `vitest run` → 1573/1573.
Pushed to `integration/next`. Silent fix (bug never shipped past review) — rides the bundle.

## 2026-07-07 — caddie-auto-shot-reco: Ask Caddie auto-fires opening shot rec on open (NOTICEABLE — integration/next, DONE)

Implemented `specs/caddie-auto-shot-reco-plan.md` verbatim (one deviation, noted below).
When the Ask Caddie sheet opens during an ACTIVE session round, it now auto-fires the
caddie's opening turn instead of opening blank: `RoundPageClient` resolves the golfer's live
GPS distance-to-pin (`GPSWatcher.getCurrentPosition` + `haversineYards` against
`holeCoordsForTiles.green`, 6s timeout via a new `withTimeout` helper, 1–800yd plausibility
gate) and passes it to `CaddieSheet` as a `resolveOpeningShot` prop. The sheet embeds the
distance in the default question — *"I'm about N yards from the pin. What should I hit or do
on this next shot?"* — and calls the SAME existing `askCaddie()` path, so it streams, speaks
(TTS pref-gated as always), and appends to history exactly like a normal reply. No new
endpoint/transport; backend untouched. Honest-idle fallback on every failure mode (no
session, no GPS fix, no green coords, implausible distance, call failure) — never a
fabricated reco; a new `askCaddie(question, { suppressError })` opt swallows only the error
bubble for this one unprompted turn. Fires exactly once per open, strict-mode-safe (fired-ref
set synchronously before the first await).

**Deviation from plan (minor, sound):** the async-gap staleness check for the awaited GPS fix
uses a NEW dedicated `openingGenRef` instead of reusing the existing `openGenRef`. The
pre-existing "cleanup on close" effect bumps `openGenRef` unconditionally on every effect
commit — including React Strict Mode's dev-only synthetic unmount→remount of that *other*
effect during initial mount — which made the shared-ref version silently swallow the GPS
await under StrictMode (`next dev` only; not the static-export production build, but caught
by the plan's own required strict-mode test, case c2). `openingGenRef` is bumped only by this
effect's own close branch, so unrelated effects can't trip it.

Tests: 7 new deterministic cases added to `CaddieSheet.session.test.tsx` (fires-once-with-
distance-and-question / no-session / no-GPS-fix-not-retried / no-refire-on-rerender /
no-refire-on-existing-thread / StrictMode-double-effect-exactly-once / suppressError-honest-
idle-no-TTS-no-error-bubble), reusing the suite's existing synchronous mocks — no real
timers/rAF. Gates: `npm run lint` clean, `npx tsc --noEmit` clean, `npm run build` succeeded,
`voice-tests/runner.ts --smoke` → 274/274 pass, `vitest run CaddieSheet.session.test.tsx` →
21/21 pass, full `vitest run` → 1572/1572 pass. Committed to `integration/next` at `e5a9526`
and pushed. Noticeable (Ask Caddie sheet auto-speaks an opening shot rec instead of opening
blank) — rides the rolling bundle toward the next approval ask, no standalone ping.

## 2026-07-07 — looper-brain-parity: off-course orb grounded in memory + handicap (NOTICEABLE-SUBTLE — integration/next, DONE)

Implemented `specs/looper-brain-parity-plan.md` verbatim. `_build_voice_prompt` in
`backend/app/routes/caddie.py` (the stateless path behind `/caddie/voice` and
`/caddie/voice/stream`) now fetches the caller's cross-round memory
(`memory_mod.get_top_memories`) + profile/handicap (`memory_mod.get_player_profile`) and
splices a `--- PLAYER MEMORY ---` block + a `Player handicap:` line into the system prompt,
mirroring `_build_session_voice_prompt`'s idioms exactly. Applies to both the off-course
Looper orb AND the on-course stateless fallback (CaddieSheet tier-2/3), since both share this
one function — previously that fallback silently lost personalization. Both DB reads sit
behind a defensive `try/except` (this path runs outside the route-level try, so an unguarded
DB hiccup would previously have surfaced as a raw 500 mid-reply); empty/no-memory/no-profile
users get a prompt byte-identical to before (no `"Handicap: None"` garbage). No schema
change — `VoiceCaddieRequest`/`VoiceCaddieResponse`, `types.ts`, `models.py` untouched.
Added 3 unit tests to `backend/tests/test_voice_stream.py` (memory+profile present / both
absent / fetcher raises), monkeypatching `caddie_routes.memory_mod` — no live Postgres.
`ruff check .` clean; `pytest tests/test_voice_stream.py -q` → 15 passed (12 existing + 3
new). No frontend change, so frontend gates weren't run (not impacted). Committed to
`integration/next` at `4948cf6` and pushed. Classification per plan §6: noticeable-subtle
(off-course spoken answers become personalized, no UI delta) — rides the rolling bundle, no
standalone approval ping.

## 2026-07-07 — RETRO (post-milestone: 9 ships, 3 process incidents) — SILENT, integration/next, DONE

Distilled the day's three incidents into reusable rules in `tasks/lessons.md` (new
"Session lessons (2026-07-07)" block) — did NOT duplicate the HARD PROCESS RULES already in
agent memory; added what was missing:
1. **review-vs-CI gap** (#104 streaming double-render, 56df95f): CI catches async/ordering
   races review misses → cover streaming/timer/async with DETERMINISTIC tests (control the
   scheduler; mock rAF/framer-motion; hand-controlled `deferredStream()`; window-scoped rAF
   checks; a flaky test is a product race — bisect, don't retry-until-green).
2. **ship.sh must not be piped** (#104 wrong-cwd masked twice): run deploy scripts un-piped,
   `set -euo pipefail`, assert cwd, absolute paths.
3. **verify deploy/CI by headSha, not recency** (#104 stale `gh run list`): match the run for
   the shipped SHA; confirm deployed artifact SHA == merged SHA (same class as #100's piped
   `gh pr checks` swallow → gate on structured fields, never scraped output).

Backlog grooming (`backlog.json`): corrected two mis-tagged shipped items —
`map-viewer-error-screen-restyle` (in-progress → done-shipped-main, #103 v1.0.759) and
`voice-tts-sheet-replies` (awaiting-ship-it → done-shipped-main, #102 v1.0.750). Updated the
top `note` to record that the **voice-agent-audit P1+P2 core is COMPLETE** (keyterms/auto-send/
telemetry #100, TTS #102, streamed replies + reply-timeouts #104); remaining voice items are
refinement/device-verify, not core. Seeded 3 NORTHSTAR-grounded next candidates (needs-spec):
`caddie-persona-tts-voices`, `caddie-hole-strategy-guides`, `looper-brain-parity`. JSON
validated (127 items, no dup ids). Silent (docs/backlog only) — rides the bundle, no ping.

## 2026-07-07 — post-merge follow-up: streaming-ladder test flake fully fixed (SILENT — integration/next, DONE)

PR #104 (streamed caddie replies + voice timeouts) was merged to `main` at commit `56df95f`
(review-caught blocker fix: cancel the pending coalesced flush before the authoritative
`setVoiceAnswer` — the "Smooth 6.Smooth 6." double-append race — plus the `isStreaming`
CTA-gating fix, both already covered in the prior entry below). A follow-up commit,
`0b0d67e`, landed on the fresh `integration/next` immediately after (too late for that PR,
carries into the next bundle) to kill a REMAINING, separate source of full-suite CI flake
in `CaddieSheet.session.test.tsx` that persisted even with the production race fixed:
- `@/lib/caddie/stream-buffer`'s real hook coalesces via `window.requestAnimationFrame` /
  a `setTimeout` fallback (jsdom has none) — driving the streaming-ladder tests through
  that REAL scheduler could lose the race under full parallel `vitest run` CPU contention.
  Mocked to a synchronous stand-in for this file; the real coalescing behavior now has its
  own dedicated, deterministic test under fake timers: `frontend/src/lib/caddie/stream-buffer.test.ts`.
- framer-motion's `AnimatePresence mode="wait"` (wraps every phase transition, including
  the streamed-answer bubble) also depends on rAF under the hood — its exit-then-mount
  timing was inconsistent under jsdom, independent of any app bug. Mocked framer-motion to
  a passthrough (no animation) for this file.
- Replaced ad-hoc `setTimeout`-based token emission with a hand-controlled `deferredStream()`
  helper (test dictates exactly when each token/resolution lands); switched blob-transcription
  tests in the streaming ladder to the live-dictation path (`isTranscribing` never sets, so
  it can't mask the phase under test while a stream is held open); widened the `afterEach`
  flush to drain a few ticks + unmount before the next test's `beforeEach`.

Verified 45 consecutive full `npx vitest run` runs (1565/1565), 0 failures, after the fix —
vs. reproducible ~10-25% flake rate before it (isolated to this ONE file; confirmed via
bisection that neither the underlying production code nor any other test file was at fault).
Gates: `npm run lint`, `npx tsc --noEmit`, `npm run build`, `voice-tests --smoke` (274/274),
backend `ruff check .` + `pytest tests/test_voice_stream.py` (12/12) all green.

**Process note for the team:** the eng-lead merged PR #104 at `56df95f` (that SHA's CI was
green) essentially concurrently with this follow-up commit landing — `0b0d67e` missed that
merge window and is NOT yet in `main`, but it IS on the fresh `integration/next` (merged
forward via `e172dd7`) for the next bundle. No functional/production code changed in this
follow-up — test-file-only, silent.

## 2026-07-07 — caddie text replies STREAM into the sheets (NOTICEABLE — integration/next, DONE)

`specs/voice-streaming-replies-plan.md` (audit P2 #5, biggest perceived-latency win). The
golfer now sees the caddie's text reply begin rendering in <1s instead of waiting for the
full Claude turn. Text-only — TTS unchanged (still speaks once, on `done`); the realtime
orb (`voice/realtime.ts`) untouched; the JSON endpoints (`/session/voice`, `/voice`,
`VoiceCaddieResponse`) stay byte-for-byte the same fallback contract.

**Backend** (`backend/app/routes/caddie.py`): extracted the prompt/context assembly shared
by the JSON endpoints and their new streaming twins into `_build_session_voice_prompt` /
`_build_voice_prompt` (no copy-paste drift between the two mouths). Added two additive SSE
endpoints, `POST /caddie/session/voice/stream` and `POST /caddie/voice/stream`
(`StreamingResponse`, `text/event-stream`). ALL auth/ownership/persona gates + prompt
assembly run BEFORE the stream is constructed, so gate failures are still normal JSON
errors. The shared `_sse_reply` generator uses `anthropic.AsyncAnthropic` with model params
identical to the non-streaming call; emits `event: token`/`done`/`error` frames; persists
the session turn exactly once via `append_message_pair`, gated on `completed` (nothing
persists on disconnect or mid-stream error); never leaks `str(e)`/traceback in an error
frame (`_CADDIE_ERROR_DETAIL` only, `log.exception` to the journal).

**Frontend** (`frontend/src/lib/caddie/api.ts`): new `streamCaddieReply` (fetch +
`getReader()`, hand-parsed SSE — `EventSource` can't carry the auth header/JSON body) with
a timeout model distinct from `postWithTimeout`: a first-token fail-fast timeout throws
`BeforeFirstByteError` (fallback-eligible), a per-token idle timeout is TERMINAL once a
token has rendered (no whole-body timeout — a live stream can run long). Feature-detects
`res.body.getReader` with a full-body non-progressive fallback for WKWebView variance. New
`sessionVoiceStream`/`talkToCaddieStream` thin wrappers; `sessionVoice`/`talkToCaddie`/
`postWithTimeout` untouched (final fallback). New shared `frontend/src/lib/caddie/
stream-buffer.ts` (`useStreamBuffer`) — an rAF-coalesced token buffer (~1 flush/frame, calm
even fill not per-token flicker); scoped to `window.requestAnimationFrame` specifically
(not the bare global) so a different test file's `vi.useFakeTimers()` polyfill can't leak a
dead rAF stub across files — falls back to a timer where real rAF is unavailable.
`CaddieSheet.tsx` gets a streaming-first 3-tier ladder (session-stream → stateless-stream →
stateless JSON), advancing only on `BeforeFirstByteError`; once a token renders, any
failure is terminal (discard partial, calm error, never fall through — would
double-render/double-speak). `LooperSheet.tsx` gets a 2-tier ladder via a new optional
`streamingTurn` prop on `LooperSheetShell` (additive — tee-time's own shell instance omits
it, unaffected). Both commit conv history / fire `tts.speak` exactly once, on the full text
only, after the stream resolves.

**Tests**: `backend/tests/test_voice_stream.py` (12 tests, no Postgres — monkeypatched
`AsyncAnthropic`, mocked `get_owned_session`/`personality_visible`/`append_message_pair`):
token/done emission, exact model params, session-flavor persists COMPLETE text,
stateless-flavor never persists, mid-stream exception → single calm error frame + no
persist, auth-error → calm error, empty stream → persists the "Say that once more?"
fallback, route-level gates (missing key → 500 JSON before streaming, 404 before
streaming, persona downgrade). `frontend/src/lib/caddie/api.stream.test.ts` (10 tests):
token accumulation, first-token timeout → `BeforeFirstByteError`, idle timeout → terminal
(and a live stream past the idle window does NOT time out), mid-stream error (message =
SSE calm copy, never `str(e)`), external abort propagates as-is pre/post-token, non-2xx →
`BeforeFirstByteError`, getReader-absent buffered fallback (onToken never called). Extended
`CaddieSheet.session.test.tsx` (+8 tests) for the 3-tier ladder, progressive render, and
`tts.speak` called exactly once with the full text.

**Flaky-test note (fixed, not a product bug)**: the full `vitest run` intermittently hung
one of the new CaddieSheet streaming tests — traced to `vi.useFakeTimers()` in an unrelated
Node-environment test file (`api.stream.test.ts`/`api.timeout.test.ts`) installing a
`requestAnimationFrame` polyfill onto `globalThis` that can outlive `vi.useRealTimers()`
within the same worker; a bare-identifier `typeof requestAnimationFrame` check in a LATER
jsdom test file would then find a dead stub. Fixed by scoping `stream-buffer.ts`'s check to
`window.requestAnimationFrame` specifically, plus removing unnecessary real-timer delays
from test mocks (`emitTokensSync` alongside the one dedicated `emitTokensProgressively`
test). 10/10 full-suite runs green after the fix.

Gates: `npm run lint` clean, `npx tsc --noEmit` clean, `npm run build` success,
`voice-tests --smoke` 274/274, `npx vitest run` 1558/1558 (72 files) — 10 consecutive
green full-suite runs. Backend: `ruff check .` clean, new + adjacent voice test files
23–52 passed locally (no Postgres touched; DB-backed ownership tests run in CI).

Deviation from plan: none functionally — the `_sse_reply` generator takes `api_key` as an
explicit parameter (plan's pseudocode implied a closure) for testability; the stream-buffer
rAF-fallback's `window`-scoping (vs. the plan's implied bare-identifier check) was an
implementation detail added to fix the cross-file test flake above, not a behavior change.

Classified **NOTICEABLE** — the owner can watch the caddie's reply stream in on
TestFlight instead of the old "spinner then whole answer" behavior. Commit `e3a0169` on
`integration/next`, pushed.

## 2026-07-07 — client timeouts + single retry on caddie voice reply calls (SILENT — integration/next, DONE)

`specs/voice-reply-timeouts-plan.md` (audit P2 #7, "bulletproofing the voice agent"). The three
caddie voice REPLY calls could hang forever on flaky on-course networks because `fetchAPI` has no
timeout. Added a contained `postWithTimeout<T>` helper (exported for tests) to
`frontend/src/lib/caddie/api.ts` with per-attempt timeout + transient-only retry, and routed:
- `talkToCaddie` (`/caddie/voice`, terminal call, no downstream fallback) — 10s timeout, 1 retry,
  500ms backoff.
- `sessionVoice` (`/caddie/session/voice`, CaddieSheet already falls back to `talkToCaddie` on
  failure) — 8s timeout, no retry (fail fast into the existing fallback).
- `speakCaddieReply` (`/api/voice/speak` TTS, best-effort/non-fatal) — inline 10s timeout that
  COMPOSES the caller's existing overlap/stop `AbortSignal` rather than clobbering it (no
  normalization — `useSheetTTS` logs raw `err.name` for telemetry).

Retry classification (locked): only our timeout firing (`timedOut` closure flag, not
`err.name` sniffing) or `err instanceof TypeError` (network drop) is transient → exhausted
transient throws a calm `CALM_REPLY_ERROR` string that passes `humanizeVoiceError` unchanged.
HTTP errors and external caller aborts propagate verbatim (no retry — a returned HTTP response is
deterministic; retrying risks double-generation since the LLM turn already ran server-side).
`fetchAPI` (`src/lib/api.ts`) deliberately stays timeout-free — it also backs multipart
uploads/course-search/CRUD, where a global timeout would break long requests.
Untouched per plan: `CaddieSheet.tsx`, `LooperSheet.tsx`, `useSheetTTS.ts`, `dictation.ts`,
`types.ts`, `models.py`, `voice/realtime.ts` (realtime warm-path mic invariants — different pipeline).

- New `frontend/src/lib/caddie/api.timeout.test.ts` — 9 tests: resolves normally + no leaked
  timer, timeout→calm (no `AbortError`/`signal is aborted` leak), retry-once-then-succeed on
  `TypeError`, no-retry-on-HTTP-error (verbatim rethrow), timer cleanup on both success/error
  paths, external-abort composition (propagates as-is, not CALM, not retried), the
  `humanizeVoiceError` invariant guard, and `speakCaddieReply`'s timeout + already-aborted-signal
  composition. All 9 pass.
- Gates green: `npm run lint` (clean), `npx tsc --noEmit` (clean), `npm run build` (success),
  `voice-tests --smoke` (274/274 pass), `vitest run api.timeout.test.ts
  CaddieSheet.session.test.tsx dictation.test.ts` (28/28 pass — session test mocks the whole api
  module so the helper isn't exercised there, as expected; dictation.ts untouched).
- No dependency added; no `package-lock.json` change. No `/security-review` needed (pure
  client-side robustness change, no new endpoint/auth/data-handling).
- Classified **silent** (no user-visible UI/behavior change on the happy path — only changes
  bounded-vs-infinite failure behavior on flaky networks) — rides in the current
  `integration/next` bundle, no owner ping needed on its own.
- Commit `2329fb7` on `integration/next`, pushed.
- eng-lead (cycle 4): reviewed the diff against the plan (logic + 9 tests faithful, scope clean);
  no separate reviewer/designer/security-review (silent, additive, well-tested, no UI/endpoints).
  Opened the FRESH rolling bundle PR **#104** (`integration/next` → `main`) — bundle is
  **silent-only so far → NOT awaiting owner approval**; accumulates until a noticeable item lands.
  Also corrected the stale #103 board card (Needs Review → Shipped, v1.0.759).

## 2026-07-07 — round-page Ask Caddie pill adopts the Looper ink-orb identity (NOTICEABLE — integration/next, DONE)

`specs/looper-orb-bundle2-plan.md` (bundle 2 of the Looper orb rollout). Restyles the round
page's "Ask Caddie" ghost-pill medallion (`RoundPageClient.tsx` ~1869-1916) from the accent
persona-initial chip to the same ink-orb + serif-italic "L" identity as `LooperOrb`
(`FloatingTabBar.tsx`): `background: T.ink`, `border: 1px solid T.hairline`, raised inset
highlight (`0 1px 4px rgba(26,42,26,0.20), 0 1px 0 rgba(255,255,255,0.25) inset`), glyph "L".
Label changed "Ask caddie" -> "Ask Looper"; explicit `aria-label="Ask Looper"` added to the
button. Semantics fully unchanged: `onClick` still `voice.stop(); setCaddieOpen(true);` (opens
the round-scoped, persona-aware CaddieSheet); persona initial stays visible in the CaddieSheet
header medallion, so no persona-identity regression. No `looper-bus`/`openLooper` wiring, no
long-press-to-listen added (round page keeps its own voice architecture) — pure presentational
swap per the plan's locked design decisions.
- Gates green: `npm run lint` (clean), `npx tsc --noEmit` (clean), `npm run build` (success),
  `voice-tests --smoke` (274/274 pass, unaffected — no mic path touched),
  `vitest run FloatingTabBar.test.tsx` (4/4 pass — identity source untouched).
- No `/security-review` needed (pure CSS/JSX, no endpoint/auth/dependency change).
- Classified **noticeable** (visible identity/label change on the round page's caddie-launch
  pill) — rides in the current `integration/next` bundle toward owner approval.
- Commit `ec49d09` on `integration/next`, pushed.

## 2026-07-07 — /map/course ErrorScreen restyle to yardage-book not-found pattern (SILENT — integration/next, DONE)

`specs/map-viewer-error-screen-restyle-plan.md`. Designer review flagged the map viewer's
`ErrorScreen` (Lucide `AlertCircle`, `T.sans` body, plain text link) as off-brand vs. the
on-brand not-found state on the course detail page. Pure presentational restyle of
`ErrorScreen({ message, onBack })` in `frontend/src/app/map/course/page.tsx` (~159-219) to
mirror `CourseDetailClient.tsx`'s not-found block exactly: serif-italic `message` headline,
mono-uppercase static caption ("Check your connection and try again."), hairline pill "Back"
button, `PAPER_NOISE` + `T.paper` background with `multiply` blend. Dropped the now-unused
`AlertCircle` import (`ChevronLeft`/`ChevronRight`/`Loader2`/`Layers` remain used elsewhere in
the file); `ErrorScreen` signature and all three call sites unchanged (data-fetch/GPS/map logic
untouched). Classified silent (styling-only, no new user-visible capability) per the plan.
- Gates green: `tsc --noEmit` (clean), `npm run lint` (clean), `npm run build` (success),
  `voice-tests --smoke` (274/274, unaffected).
- No backend/security-review needed (pure CSS/JSX, no new endpoint/auth/dep).
- Commit `8998b3f` on `integration/next`, pushed.

## 2026-07-07 — spoken caddie replies in the sheets (NOTICEABLE, opt-in — integration/next, DONE)

`specs/voice-tts-sheet-replies-plan.md`. CaddieSheet/LooperSheet replies were silent text —
unreadable on-course in sunlight. Adds opt-in TTS playback of a completed reply, persona-matched
to the SAME voice the Realtime orb uses, tap-to-silence, iOS-safe, and strictly additive (any
TTS failure is swallowed — the reply text always renders).

- **Backend:** `app/services/openai_tts.py` (new) — `synthesize_speech(text, voice_id)`, mirrors
  `services/deepgram.py`'s structure (module-level `OPENAI_API_KEY` guard → 500, httpx POST to
  OpenAI `/v1/audio/speech`, model `gpt-4o-mini-tts`, `voice_id or "sage"`, mp3, clamps input to
  4096 chars, `HTTPException` on ≥400). `app/routes/voice.py`: new `POST /speak`
  (`SpeakRequest{text, personality_id="classic"}`) resolves the persona via the SAME
  `load_personality` the orb uses, then returns `Response(media_type="audio/mpeg")` —
  `Depends(current_user_id)` auth, matching `/transcribe`.
- **Frontend:** `hooks/useSheetTTS.ts` (new) — single shared `HTMLAudioElement`, iOS
  bless-play-then-pause unlock pattern copied from `lib/voice/realtime.ts`'s remote-audio sink;
  `speak()` no-ops when muted/empty, aborts any in-flight fetch + stops current playback before
  starting the next (structurally impossible to double-voice), swallows every failure
  (autoplay-blocked / offline / TTS error) via try/catch + `voiceEvent("sheet-tts", ...)`
  telemetry — never throws into the caller. `lib/voice/tts-pref.ts` (new) — localStorage
  `looper.sheetTtsEnabled`, **default OFF** (opt-in; NORTHSTAR quiet-app mandate — flagged for
  owner in the plan, built default-off, can flip on request). `lib/caddie/api.ts`:
  `speakCaddieReply(text, personaId, signal)` — direct `fetch` + `authHeaders()` (fetchAPI is
  JSON-only), returns the mp3 `Blob`.
- Wired into `CaddieSheet.tsx` (`tts.unlock()` synchronously at the top of `handleMicTap`;
  `tts.speak(responseText, personaId)` right where `setVoiceAnswer` is set in `askCaddie`; a
  quiet hairline speaker-toggle in the header row next to the persona identifier — idle tap
  flips the mute pref, a tap while speaking silences) and `LooperSheet.tsx`'s `LooperSheetShell`.
- **Deviation from the plan (noted per the workflow rule):** the plan's §3 named an explicit
  `tts.speak()` call site inside the *default* `LooperSheet` host's `handleMicTap`. Instead I
  put the tts hook + speak-trigger + header toggle INSIDE the shared `LooperSheetShell` itself,
  driven by a `turns`-watching effect (speaks only a newly-appended `role: "looper"` turn added
  while the sheet is open — never replays history on reopen). Reason: `LooperSheetShell` is also
  reused by `app/tee-time/page.tsx` (its own host, not in the plan's touched-file list); the
  plan's §3 placement note explicitly says tee-time "inherits" the header control since it reuses
  the shell. A per-host explicit call site would have left tee-time's toggle inert (visible but
  non-functional) or required touching `tee-time/page.tsx` (out of the plan's file list to keep
  scope contained). Centralizing in the shell gives both the general Looper sheet and tee-time
  real, working speech with no `tee-time/page.tsx` change. Functionally equivalent outcome; call
  site moved, not the feature.
- Tests: `backend/tests/test_voice_speak.py` (6, non-DB — mocked httpx + `load_personality`):
  persona→voice_id resolution, length clamp, default-voice fallback, missing-key→500,
  upstream-error passthrough, `media_type == audio/mpeg`. `frontend/src/hooks/useSheetTTS.test.ts`
  (5, jsdom, stubs `HTMLMediaElement.prototype.play/pause` + `URL.createObjectURL`): muted no-op,
  empty-text no-op, unlock idempotent, second `speak()` aborts the first (stale resolve doesn't
  resurrect playback), rejected `play()` doesn't throw.
- Gates green: `npm run lint` (0 warnings after an exhaustive-deps fix), `tsc --noEmit`,
  `npm run build`, `voice-tests --smoke` (274/274), full `vitest run` (70 files / 1536 tests,
  incl. the two new suites), backend `ruff check .`, `pytest tests/test_voice_speak.py` (6/6).
- Not run locally (per policy): backend DB-integration tests — no local Postgres; CI's backend
  gate covers those. `/speak` is a fresh endpoint + new outbound OpenAI dependency — flagging for
  `/security-review` / `/code-review` per CLAUDE.md's "new endpoint" rule before the bundle ships.

## 2026-07-06 — persistent round map + colored tee marker (NOTICEABLE — integration/next, DONE)

`specs/persistent-map-tee-marker-plan.md`. Owner (screenshots): "Loading map…" on every hole
swipe; wants a calm colored tee marker on the actual tee box for the round's tee.

- **Root cause (recon-verified in the plan):** GoogleSatelliteMap was ALREADY a single
  persistent native map instance (native map created once, camera panned on hole change, all
  calls gated on `mapReadyRef` — the SIGTRAP lesson). The bug was the PARENT:
  `RoundPageClient.tsx` rendered the map branch INSIDE the keyed
  `<AnimatePresence mode="wait"><motion.div key={currentHole} drag="x">` — every hole swipe
  destroyed + recreated the native map → the loader on every swipe. Fix: un-keyed that branch
  into its own persistent, un-keyed container (mounted once per round); the flick-swipe gesture
  (`onTouchStart`/`onTouchEnd`) + `onPointerDownCapture` stop-propagation guard moved to it
  UNCHANGED. The mock/no-course paper fallback keeps its keyed `AnimatePresence`/`motion.div`
  slide (cheap SVG, remount is fine).
- `lib/map/google-map-helpers.ts` (+24 new tests, 93 total in the file):
  - `createCameraQueue<T>(run)` — pure coalescing serializer. `request()` overwrites the
    pending target while a run is in flight; on resolve, flushes the newest pending (else
    idle). A rapid 1→2→3→4 swipe settles on ONE trailing camera move on 4, not 4 races. The
    `mapReadyRef` gate stays INSIDE `run` (belt+braces) — a not-ready request no-ops without
    wedging the queue for the next one.
  - `teeColorFor(teeName)` → `{slug, rgb}` — case/whitespace-insensitive; canonical slugs
    black/blue/white/gold/red/green/neutral (7, matching the 7 bundled PNGs). Uncommon names
    fold onto the nearest bundled colour (silver/gray/grey→white, combo/orange/yellow→gold,
    documented in-file) rather than growing the asset set. Absent/unrecognised → neutral
    ink/graphite (`#6b6558`, honest, never a guess).
  - `teeMarkerIconUrl(slug)` → `assets/tee-marker-{slug}.png`.
- `GoogleSatelliteMap.tsx`: the `[currentHoleData]` hole-change effect now calls
  `cameraQueueRef.current.request(hd)` instead of an un-serialized `clearHoleOverlays →
  fitCameraToHole → addHoleOverlays` IIFE. New `@capacitor/app` `appStateChange` listener:
  on resume to foreground, if the map is ready, re-requests the current hole's framing through
  the SAME queue (re-asserts camera after GMSMapView's background pause) — never
  destroys/recreates the map on background (that would reintroduce the very "Loading map…"
  spinner this feature kills). The no-op `addHoleOverlays` now draws the tee marker
  (`addMarker` with the bundled PNG, `iconAnchor` centered — a dot, not a pin,
  `isFlat: true`) when `teeMarker !== null && hd.tee`, id tracked in `holeMarkerIdsRef` so
  `clearHoleOverlays` removes it per hole. Fixed the hardcoded 18-hole fullscreen nav bounds
  (`currentHole > 1` / `< 18`) to use `holeCoordinates.length` (9-hole rounds no longer show a
  dead "next" arrow past the last hole).
- `public/assets/tee-marker-{black,blue,white,gold,red,green,neutral}.png` — generated by new
  `frontend/scripts/generate-tee-markers.py` (python3 stdlib `zlib`-only PNG encoder, no image
  dependency per the plan): an anti-aliased colored dot + thin white ring + soft ink halo
  (visible against grass, sand, or cart paths) — calm, not a Google pin.
- `teeMarker` threaded: `RoundPageClient` derives `round.teeName ?? ""` (tri-state — a real
  tee name → colored marker; `""` for a legacy round with no stored tee name → neutral marker,
  honest; `null`, only passed by `/map/course` which has no round context → no marker at all)
  through `InlineHoleDiagram` (new pass-through prop) and the fullscreen `GoogleSatelliteMap`.
- Added `@capacitor/app` (native dependency, `npm install` + `npx cap update ios` regenerated
  `ios/App/CapApp-SPM/Package.swift` — that file is Capacitor-CLI-managed, not hand-edited).
- **Deviations from the plan (both minimal, noted per the workflow rule):** (1) the camera
  queue's `run` reads GPS position from `positionRef.current` instead of the `position` state
  closed over by the old effect — avoids a pre-existing minor staleness (the file's own
  convention already prefers refs for exactly this reason elsewhere); (2) `teeColorFor`'s
  alias-folding assignments (silver/gray→white, combo/orange/yellow→gold) are an interpretation
  filling a gap in the plan's prose (it named 8-9 alias groups but only 7 PNGs) — documented
  in-file, not asset-set growth.
- **Gates:** `tsc --noEmit` clean · `npm run lint` clean · `npx vitest run` 63 files / 1485
  tests pass (was 1461; +24 in google-map-helpers.test.ts) · voice-tests smoke 274/274 ·
  `next build` clean, `out/assets/tee-marker-*.png` present in the static export.
- **iOS Simulator (SIMTEST.md):** built + `cap sync` + `xcodebuild` for `iPhone 17` Debug
  (arm64 simulator) — BUILD SUCCEEDED with the new native `@capacitor/app` Swift package
  resolved. Installed + launched: no crash, healthy `[authdiag] loaded=true` + rendered
  sign-in screen (screenshot). Could not go further: reaching the round page to visually
  confirm no-loader-on-swipe + the marker requires a signed-in session with an active round,
  which needs real Clerk credentials not available in this sandbox (SIMTEST.md: "Sign-in
  cannot be completed in-sim without real Clerk credentials") — relying on the pure
  unit tests above plus an on-device pass by the owner for that visual confirmation.

## 2026-07-06 — tee-time prefs rework: real dates, slide-to-edit windows, checklist fixes (NOTICEABLE — integration/next, DONE)

`specs/tee-time-prefs-rework-plan.md`, both work items (one builder — same file overlap). Owner
escalation: "the check list is buggy"; "+ Add another window" stamped identical un-editable
cards; wants a date choice; wants to slide-edit existing windows.

### Work item 1 — real dates + slide-to-edit
- `lib/teetime/dates.ts`: `TimeWindow` now carries a real ISO `date` (source of truth for
  WHEN); `defaultWindows(from)` factory replaces the `DEFAULT_WINDOWS` module constant
  (`useState(() => defaultWindows())`); new `nextDefaultWindow(existing, from)` picks the
  first free Sat/Sun slot template so a second "+ Add another window" is a DIFFERENT
  editable window, never a duplicate stamp; new `weekdayName(weekday)`.
- NEW `lib/teetime/window-slider.ts` (+22 unit tests) — all drag math (hhmmToMin/minToHhmm,
  frac↔min snapping, `pickHandle` start/end/band disambiguation with edge bias, `applyDrag`
  clamped to 1h–6h, no midnight cross) as pure functions, no DOM.
- NEW `app/tee-time/WindowCard.tsx` replaces the static `WindowChip` — owns the pointer
  handlers for the track (a taller ~24pt drag strip at the card bottom), the date chip
  (opens `MiniCalendar`), and a quiet 44×44pt-hit-box `×` delete (guarded: never drops the
  last window). **Tap vs drag:** pointerdown on the track picks a handle via `pickHandle`;
  pointerup below a 6px movement threshold = a TAP → toggles the card (same as tapping
  anywhere else on it); at/above threshold = a real drag, already live-applied via
  `applyDrag` on every `pointermove` (haptic fires only when the computed value actually
  changes — i.e. on each 30-min snap crossing). `setPointerCapture` + `touchAction: none` +
  `stopPropagation` on the track keep it from fighting the card's own tap-to-toggle or the
  page's scroll.
- NEW `components/yardage/MiniCalendar.tsx` — dependency-free month grid (mono weekday
  headers, serif day numerals, T.ink/T.hairline tokens, accent ring on selected day, past
  days disabled) — no native `<input type="date">`, no picker dependency.
- `lib/teetime/query.ts` / `voice-prefs.ts`: `date` threads through `buildTeeTimeQueries`
  (used verbatim, falls back to label-derived date for older callers) and
  `applyParsedWindows` (voice-added windows stamped with the real ISO date for their spoken
  day; matched windows keep their existing date).

### Work item 2 — course checklist fixes (2a–2f)
- **2a** abort-hardened refetch: new `createCourseFetchSession` in `courses.ts` (mirrors
  `course-search-session`'s AbortController + live-target-equality pattern) — a stale
  fetch can never land over a newer one, race-tested.
- **2b** touched-guard: `mergeCourseOptions` gains `{touched}` — once the golfer toggles or
  hand-adds a course, the nearest-3/favorites auto-pre-selection never re-applies to later
  merges.
- **2c** kicker: "Where" section now reads "{n} selected" (was "{n} of {count}", which read
  as a bug once favorites-beyond-cap exceeded the count).
- **2d** junk-row filter: `toCourseOptions` rejects results with no identifying token after
  stripping golf-generic words, via a new `hasIdentifyingTokens` in
  `course-search-helpers.ts` (reuses `tokenizeCourseName`) — "Golf Course" filtered,
  "Presidio Golf Course" kept.
- **2e** new `reconcileCourseOptions(existing, incoming, {maxMiles, touched})` — prunes rows
  beyond the current drive radius UNLESS hand-added/favorited/selected; wired to a dedicated
  effect on `maxMiles` so a radius SHRINK re-filters immediately (no fetch needed) and a
  voice-widened far course still survives a later shrink back.
- **2f** tap targets: `CourseRow` padding 10px→13px, checkbox 16px→21px; WindowCard's date
  chip/delete reviewed to the same standard.

### Gates
`tsc --noEmit` clean · `npm run lint` clean · `npx vitest run` 63 files / 1465 tests pass
(22 new in `window-slider.test.ts`, plus new cases in `courses/query/voice-prefs.test.ts`) ·
`voice-tests/runner.ts --smoke` 274/274 pass · `npm run build` succeeds.
**Not run:** the `ios/SIMTEST.md` live WKWebView drag check — `/tee-time` sits behind Clerk
AuthGate, and per SIMTEST.md itself sign-in can't be completed headless without real
credentials, so a real-device pointer-capture/haptics pass on the drag gesture is still
outstanding (relying on the window-slider unit tests for the math; the gesture wiring itself
wants a real-device or authenticated-sim pass before it's fully proven).

## 2026-07-06 — course-search v2, Work Item A: backend search that finds Pebble Beach (NOTICEABLE — integration/next, DONE)

`specs/course-search-v2-plan.md` Work Item A (backend + frontend lib). Owner
escalation: search couldn't find "Pebble Beach" at all. Verified root cause:
the un-anchored global OSM name-search leg was a planet-wide Overpass regex
with no location filter — it always timed out (~11s, 0 results, live-verified
2 attempts) and never contributed a result, while adding ~11s of latency to
every cold query. Landed alongside Work Item B (full-screen search UI,
already on `integration/next` — commits 16ff625/8b21f90); together these fix
both owner complaints (can't find Pebble Beach + resize jank) — bundle-worthy
for a joint approval ping.

### What changed
- `backend/app/routes/course_search.py` — killed the un-anchored OSM leg
  entirely; OSM now runs ONLY anchored (around a Google Places/Mapbox
  center), and even then only as **non-blocking** enrichment via FastAPI
  `BackgroundTasks` (`_enrich_and_write_through`) so a slow/unreliable
  Overpass mirror never adds interactive latency — facility siblings
  (Bethpage Black/Red/Green) fill in for the *next* identical search instead.
  Google Places is now the primary external leg; added a new internal
  GolfAPI leg (`_search_golfapi`) that reuses `services/golfapi_cache.py`'s
  cache-first, budget-guarded client (0 calls on cache hit / no key) —
  Places + GolfAPI run concurrently via a new `_run_leg` timing/health
  wrapper. Added `legHealth` (per-leg outcome/count/ms) to the `/search`
  response — owner-testable on staging: `GET /api/courses/search?q=pebble
  beach` and inspect `legHealth`.
- Cache-poisoning fix: an empty result is negative-cached (5min) ONLY when
  every attempted external leg was genuinely `ok`/`empty`; a leg
  error/timeout is never cached, so one bad moment can't wedge a real course
  out of the cache for 5 minutes. Policy documented in
  `course_search_cache.py` (store stays a dumb TTL map; the route decides).
- `course_finder.search_google_places` gets an additive `raise_on_error` flag
  (default `False` — existing callers, incl. tee-time's
  `AffiliateLinkProvider`, unaffected) + logs on HTTP failure, so a prod
  key-not-enabled 403 is now visible in logs instead of a silent `[]`.
- `frontend/src/lib/golf-api.ts` — collapsed `searchAllCourses`'s 3-leg
  client fan-out (mapped + GolfAPI proxy + OSM) into ONE call to
  `/api/courses/search` (backend now owns the whole pipeline). Public
  signature, append-only `onResults`, client-side prefix gate + dedupe (as
  defense in depth) all unchanged. Populates a per-row `sourceLabel`
  (MAPPED/GOOGLE/GOLFAPI/OSM). Adds an 8s internal timeout via
  `AbortSignal.any` (with a manual-relay fallback for older runtimes)
  combined with the caller's signal, so a wedged backend can't hang search
  past the next keystroke.
- Deviation from the plan's literal pseudocode (noted, minimal/sound): when
  the Mapbox-fallback path already ran the anchored OSM search inline
  (nothing else matched), the background step just persists those hits
  instead of re-running the same anchored OSM query a second time in the
  background — avoids a redundant duplicate Overpass call; write-through
  completeness is unchanged.

### Tests
- `test_course_search.py`: 48 → 59 (Pebble Beach repro table mirroring the
  Bethpage one, cache-poisoning fix, `legHealth` incl. `caplog` on a raising
  leg, non-blocking-enrichment scheduling, `_search_golfapi` mapping). All
  frozen tests listed in the plan (A6) untouched/still passing.
- Backend full suite: 959 passed / 74 skipped (DB-gated integration tests —
  no local Postgres on this machine; CI's Postgres service covers those).
- Frontend: `golf-api-search.test.ts` rewritten for the single-leg contract;
  `course-search-session.test.ts` / `course-search-helpers.test.ts`
  untouched and still green. Full vitest 60 files / 1395 tests · tsc clean ·
  eslint clean · voice-tests smoke 274/274.

Does not touch `CourseSearch.tsx` or `course-search-helpers.ts` (Work Item B
owns those, already landed).

## 2026-07-06 — course-search v2, Work Item B: full-screen Google-Maps-style search (NOTICEABLE — integration/next, DONE)

`specs/course-search-v2-plan.md` Work Item B (frontend). Owner escalation: the
old bottom sheet (`maxHeight: "90vh"`) resized/jumped as results streamed in
and as the iOS keyboard opened. Work Item A (backend: Places-primary search +
`legHealth` + cache-poisoning fix) is a separate parallel builder — not
included here; the two are contract-frozen via `searchAllCourses`'s
unchanged signature + append-only `onResults`.

### What changed
- `components/CourseSearch.tsx` — full rewrite. `position: fixed; inset: 0;
  height: 100dvh` — the outer frame is NEVER bound to content or result
  count; only the inner scroll region grows. Fixed top bar: back chevron
  (`onClose`) + autoFocus input + optional mic (`onVoiceSearch?: () => void`,
  hidden/no-op when the caller doesn't pass it — round/new wires it to the
  existing Realtime voice-setup panel; courses tab / tee-time leave it
  unwired per plan). Idle state: Favorites → Recent (`getRecentCourses`, new
  to this surface) → Nearby, deduped against each other by `courseNameKey`
  so a favorite never echoes under Recent/Nearby. Typed results replace idle
  sections as one stable append-only list (unchanged contract). One
  consolidated `CourseRow` idiom replaces the old `ResultRow`/`FavoriteRow`
  split (serif 17 title, mono 8.5 uppercase subline, dashed hairline, star,
  chevron, minHeight 44). Dropped the footer attribution for a per-row
  `sourceLabel` tag. Loading = pulsing dot in the bar only, zero layout
  shift. `CourseSearchProps`/`CourseSelectPayload`/`resultToPayload` kept
  exactly — all 3 callers (courses/page.tsx, round/new/page.tsx,
  tee-time/page.tsx) work unchanged.
- `lib/course-search-helpers.ts` — new `dedupeIdleSections` (cross-section
  dedupe by courseNameKey) and `buildRowSubline` / `resultSourceLabel` (the
  one subline/tag idiom every CourseRow uses).
- `app/round/new/page.tsx` — passes `onVoiceSearch` → closes the search
  sheet and opens the existing `VoiceRoundSetupRealtime` panel.
- Minor incidental fix folded into the row consolidation: `favoriteToPayload`
  now carries `center` (previously silently dropped, losing the map-view
  center for favorited non-mapped courses).
- Tests: `course-search-helpers.test.ts` +19; new `CourseSearch.test.tsx`
  (RTL, `@testing-library/react` already a devDependency) locks in the fixed
  outer-frame geometry before/after a 40-row append-only batch, confirms
  only the inner scroll region scrolls, and covers mic show/hide + back
  chevron.

Gates: tsc clean · eslint clean · vitest 60 files / 1393 tests green · voice
smoke 274/274 · `next build` green.

Note for eng-lead: `frontend/src/lib/golf-api.ts` had unrelated in-progress
changes from the parallel Work Item A builder sharing this same working
tree while this item was built — left untouched/unstaged, not part of this
commit. Bundle-worthy alongside A: together they fix both owner complaints
(search can't find Pebble Beach + resize jank) — hold for a joint approval
ping once A lands.

## 2026-07-02 — tee-time: honest course list + real group (NOTICEABLE — integration/next, DONE)

Owner bug (NY, on device): the tee-time screen showed the hardcoded SF demo list
(Presidio/Harding/Lincoln fake ★ favorites + "Bethpage Black 31.2mi") because the
page seeded `DEFAULT_COURSES` and only replaced it when GPS + nearby fetch both
succeeded with >0 results. Owner directive mid-build: "get rid of hardcoded
lists" — plural — so the fake roster/self-handicap went too.

### What changed
- `app/tee-time/page.tsx` — DEFAULT_COURSES DELETED; courses start `[]` with an
  honest load state machine (locating → loading → done | failed | unlocated) and
  calm empty copy; nearby fetch radius follows the Max drive slider (debounced,
  refetch only when radius grows / area changes); fresh results MERGE (toggles +
  added courses never clobbered); "+ Add course" dashed row opens the existing
  CourseSearch sheet (dedupe by name, honest distance from payload center, null
  when unknown — shown blank, never invented); LOCAL_ROSTER + SELF_MEMBER (fake
  "JL hdcp 8.2" + 4 fake invitees) DELETED — self chip fills from the real golfer
  profile (blank hdcp when unknown), invite roster = real saved players
  (GET /api/players, storage fallback), honest empty-roster copy; booking name =
  profile name (was hardcoded "Owner")
- `lib/teetime/courses.ts` — CourseOption.distance now `number | null`;
  radiusMetersForMiles (5–80km clamp), mergeCourseOptions, addCourseOption,
  courseOptionFromSelection, load-state helpers + emptyCoursesNote;
  toCourseOptions appends real favorites beyond the results with honest stored-
  center distance (no center → omitted); fetchNearbyCourseOptions never throws —
  returns `{ options, failed }`
- `lib/golf-api.ts` — new `searchNearbyDetailed` (per-leg health: mapped + OSM
  legs fail independently; both-down is distinguishable from "no courses");
  `searchNearby` delegates
- `lib/teetime/voice-prefs.ts` — VoicePrefMember.hdcp nullable; guest
  placeholders get hdcp null (was fake 0)
- Tests: vitest 1343 → 1365 (+22: radius clamp, leg resilience, merge/add/dedupe,
  favorites-beyond-radius, load-state transitions, never-throw wrapper)

Gates: tsc clean · eslint clean · vitest 1365/1365 · voice smoke 274/274 · build ✓

## 2026-07-02 — agentic caddie P2: real voice — hold-to-talk orb (NOTICEABLE — integration/next, DONE)

The round screen's voice orb is now the REAL caddie (`specs/agentic-caddie-plan.md`
P2), replacing the scripted prototype demo. Press-and-hold the orb (or the sheet's
mic) → live OpenAI Realtime burst in the selected persona's voice; release → the
caddie answers aloud. Connection stays warm for follow-ups, auto-disconnects after
90s idle. Silent degradation ladder: realtime voice → CaddieSheet (Deepgram+Claude
text) → offline card from an IndexedDB HoleIntelBundle.

### What changed
- `RoundPageClient.tsx` — scripted conversation beats DELETED; orb + VoiceSheet
  wired to `useVoiceCaddie` (hold-to-talk); tier-3 `OfflineCaddieCard` (NEW);
  HoleIntelBundle cached at session start (round yardages floor, hazards +
  plays-like enrichment when course intel lands)
- `hooks/useVoiceCaddie.ts` (NEW) — burst lifecycle, 3s mint deadline, silent
  downgrades, mic muted whenever not held, ledger persistence of finished turns
- `lib/caddie/transport.ts` (NEW) — PURE degradation-ladder reducer + status→
  VoiceState / messages→turns mappers (side effects injected; fully unit-tested)
- `lib/caddie/hole-intel-cache.ts` (NEW) — IndexedDB bundle (SSR/error-silent)
- `lib/voice/realtime.ts` — dispatchTool gains get_conditions /
  get_player_profile / get_carries STUB (available:false until P3); onMinted
  event; 90s `IdleTimer` (NEW lib/voice/idle-timer.ts); hard cap ONE concurrent
  Realtime connection
- Backend: `realtime_relay.py` DEFAULT_TOOLS → 6-tool surface v1;
  `voice_prompts.py` enforces "never state a yardage, club distance, or carry
  you did not get from a tool"; `routes/caddie.py` NEW GET
  /session/{id}/conditions + /session/{id}/player-profile (deterministic tool
  reads) + POST /session/message (shared ledger append, owner-scoped, roles
  fixed by field name, 4k char cap). In-round mint (round_id ownership check,
  persona voice_id + live-session instructions) already existed — verified +
  tested.
- Tests: pytest +8 pure (`test_realtime_tools.py` — mint payload/voice/tools,
  ownership 404) +11 integration (`test_caddie_session_message.py` — ledger
  append/validation/ownership, conditions honesty, player-profile); vitest +30
  (transport ladder, idle timer, tool-dispatch parity incl. record_shot →
  /session/shot dual-write path)

### Gate results (all green)
- backend: `ruff` clean; `pytest` 943 passed / 74 skipped (integration DB tests
  run in CI)
- frontend: `tsc` clean; `eslint` clean; `vitest` 1343/1343 (was 1313);
  voice smoke 274/274; `next build` succeeds

### For P3/P4
- get_carries stub lives in `lib/voice/realtime.ts` dispatchTool — P3 swaps it
  for a real endpoint call; the tool schema (hole_number required) is already
  minted.
- get_player_profile returns session (entered) club distances — P4 blends
  learned distances into the same payload.
- Offline bundle lastRecommendation refreshes via `sessionRecommend()` in
  `lib/caddie/api.ts` (both mouths).
- Security review needed (new mint surface): /session/message input handling,
  the two new session GET endpoints, mint round-ownership path.

## 2026-07-01 — tee-time phase 1b item C: hold-to-talk voice prefs (NOTICEABLE — integration/next, DONE)

Voice slice of the tee-time booking epic (`specs/tee-time-booking-phase1b.md`,
work item C). The decorative "Hold to talk" button on /tee-time is now the real
voice-first path: hold → speak ("find me a tee time Saturday morning at
Presidio, party of 4, under $80") → release → prefs update themselves and, when
the utterance names a day/time (or says "go ahead / book it"), the search
dispatches on its own.

### What changed
- `frontend/src/lib/voice/parseTeeTimePrefs.ts` (NEW) — deterministic tee-time
  intent: day/period windows ("weekend" → Sat+Sun), course names matched on
  distinctive tokens against the listed courses (generic words like "park"
  never match alone), party size ("foursome", "three of us"), spoken price
  ceilings ("under eighty dollars", "$50") kept apart from spoken distances
  ("within ten miles"), go-ahead confirmations. Heuristics-first + optional
  LLM pass with Zod validation + repair loop (pipeline.ts pattern); pure/offline
- `frontend/src/lib/voice/schemas.ts` — `TeeTimePrefsParseResultSchema` (partial
  by design: every field optional so "party of four" alone is a valid parse)
- `frontend/src/lib/teetime/voice-prefs.ts` (NEW) — pure appliers: spoken windows
  select/create prefs windows, named courses replace the selection (+ radius
  widened so a named course is never silently filtered out), party size pads
  with "+1" guest placeholders (real people never removed), calm ack line
- `frontend/src/lib/teetime/query.ts` — `maxPriceUsd` rides on every query
- `frontend/src/app/tee-time/page.tsx` — hold-to-talk wired to the same capture
  path as the rest of the app (VoiceRecorder → /api/voice/transcribe → parser);
  exchange shown in the page's Transcript idiom; unrecognized speech gets a
  gentle fallback line, never an error state; Brief shows "Budget" when spoken
- Tests: `parseTeeTimePrefs.test.ts` + `voice-prefs.test.ts` (+37 vitest);
  9 deterministic tee-time cases in `voice-tests` (runner gained the
  `/api/parse-tee-time` lane)

### Gate results (all green)
- `tsc --noEmit` clean; `eslint` clean; `vitest` 1265/1265 (was 1228);
  voice smoke 274/274 (was 265); `next build` succeeds

### Classification: NOTICEABLE (the tee-time screen becomes voice-first)
Rough edges for a polish pass: no live interim transcript while holding (final
Deepgram text only); clock times ("around 8am") not parsed — periods only;
guest placeholders show "hdcp 0" in the group list; day abbreviations
("sat"/"sun") unrecognized.

---

## 2026-07-01 — tee-time phase 1b item B: frontend real-data wiring (NOTICEABLE — integration/next, DONE)

Frontend slice of the tee-time booking epic (`specs/tee-time-booking-phase1b.md`,
work item B). The /tee-time page now searches with the golfer's real location,
lists real nearby courses, renders affiliate results as honest estimates/handoffs,
and produces a real .ics calendar file.

### What changed
- `frontend/src/lib/teetime/dates.ts` (NEW) — day-label → date logic; each window
  searches its OWN day (fixes the Sunday-window-got-Saturday's-date bug); local-time
  ISO formatting (old `nextSaturday()` used UTC and drifted near midnight)
- `frontend/src/lib/teetime/query.ts` (NEW) — pure prefs → TeeTimeQuery fan-out
  (`buildTeeTimeQueries`), area ("lat,lng") included on every query when known
- `frontend/src/lib/teetime/location.ts` (NEW) — non-blocking geolocation via
  `GPSWatcher.getCurrentPosition` (dynamic import), last-known "lat,lng" persisted
  under `looper_teetime_last_area`; search never waits on the permission prompt
- `frontend/src/lib/teetime/courses.ts` (NEW) — `searchNearby` (existing course-search
  client) → prefs `CourseOption[]`: honest haversine distances, favorites flagged +
  pre-selected (else nearest 3), capped at 8; hardcoded SF `DEFAULT_COURSES` kept
  only as offline/dev fallback
- `frontend/src/lib/teetime/ics.ts` (NEW) — zero-dep RFC 5545 generator with VALARM
  (-PT2H) + blob download; "Add to calendar · Set reminder" now does the real thing
- `frontend/src/app/tee-time/page.tsx` — wires all of the above; Radar pins render
  the golfer's actual selected courses (name + relative distance, capped at 4);
  Confirmed screen: `needs_human` reads as a handoff ("Held" stamp, "Book on the
  course site →" / "Call the course to book", no fabricated confirmation number),
  estimated slots render "~" times and no invented price
- Tests: `dates.test.ts`, `query.test.ts`, `ics.test.ts`, `courses.test.ts` (+35)

### Gate results (all green)
- `tsc --noEmit` clean; `eslint` clean; `vitest` 1228/1228 (was 1193);
  voice smoke 265/265; `next build` succeeds

### Classification: NOTICEABLE (user-visible once TEETIME_PROVIDER=affiliate; the
prefs course list + calendar button + honest confirm are visible even on mock)
Item C (voice prefs) note: prefs state shape unchanged — `windows: TimeWindow[]`,
`courses: CourseOption[]` (now imported from `@/lib/teetime/courses`), `maxMiles`,
`group`; voice should mutate those via the existing setters; query building is
centralized in `buildTeeTimeQueries` so voice-set prefs flow through untouched.

---

## 2026-07-01 — tee-time phase 1b item A: real courses + cache + booking persistence (SILENT — integration/next, DONE)

Backend real-data slice of the tee-time booking epic (`specs/tee-time-booking-phase1b.md`,
work item A). Default provider stays `mock` — nothing user-visible until item B wires
the frontend, so this rides the bundle silently.

### What changed
- `backend/app/services/course_finder.py` (NEW) — Google Places / Mapbox / de-dupe
  helpers extracted from `routes/course_search.py` (shared, no self-HTTP); Places
  field mask now includes `websiteUri` + `rating`
- `backend/app/services/tee_times/affiliate.py` (NEW) — `AffiliateLinkProvider`:
  real nearby courses (OSM around lat/lng, Places text search, Mapbox fallback),
  ONE `estimated=True` slot per course per window at the window start, `price_usd=None`
  (never fabricated), `booking_url` from the Places website; `book()` → `needs_human`
- `backend/app/services/tee_times/search_cache.py` (NEW) — 15-min TTL search cache
  (in-memory + `backend/data/tee_time_search_cache.json`), injectable-store pattern
- `backend/app/services/tee_times/base.py` — slot gains `estimated: bool = False`;
  `price_usd` now `float | None`
- `backend/app/routes/tee_times.py` — `TEETIME_PROVIDER=affiliate` wired (default
  still mock); search cache replaces hardcoded `cached=False`; `POST /book` gains
  `owner_id = Depends(current_user_id)` + persists EVERY attempt (incl. needs_human);
  NEW `GET /api/tee-times/bookings` (owner-scoped, newest first)
- `backend/app/db/models.py` + `backend/migrations/versions/0007_010_tee_time_bookings.py`
  — `TeeTimeBooking` ORM + Alembic migration (revision 010)
- `frontend/src/lib/teetime/types.ts` — `estimated?: boolean`; `priceUsd: number | null`
  (+ two null-guards in `app/tee-time/page.tsx` to keep tsc green)
- Tests: `tests/test_tee_time_affiliate.py`, `tests/test_tee_time_search_cache.py`,
  `tests/integration/test_tee_time_bookings.py` (+ conftest truncates the new table)

### Gate results (all green)
- backend: `ruff check .` clean; `pytest` 844 passed / 45 skipped (was 821/34 —
  new integration tests skip locally, run on CI Postgres)
- frontend: `tsc --noEmit` clean; `vitest` 1193/1193; `eslint` clean; voice smoke 265/265

### Classification: SILENT (backend-only; provider default unchanged)
Item B (frontend wiring) consumes: `estimated` flag, nullable `priceUsd`,
`GET /api/tee-times/bookings` (camelCase: slotId, courseId, courseName, date, time,
partySize, priceUsd, status, bookingUrl, provider, confirmationCode, createdAt).

---

## 2026-06-29 — map-crashproof hotfix (NOTICEABLE — feat/map-crashproof, DONE — pushed to remote)

iOS SIGTRAP crash on map open eliminated. Root cause: `fitBounds()` in the
@capacitor/google-maps native plugin force-unwraps a nil GMSMapView (Map.swift:566)
— uncatchable from JS. Fix: removed ALL `fitBounds()` calls; replaced with
`setCamera()` using a new `cameraForHole()` helper that computes center + zoom
from tee→green Haversine distance.

### What changed
- `frontend/src/lib/map/google-map-helpers.ts` — added `haversineYards`, `zoomForPaddedYards`, `cameraForHole` pure helpers
- `frontend/src/components/GoogleSatelliteMap.tsx` — `fitCameraToHole` rewritten: `fitBounds()` → `setCamera(cameraForHole())`. Added `createInProgressRef` re-entry guard, container size check before create, `onFallback` prop
- `frontend/src/app/map/course/page.tsx` — Google Maps stays DEFAULT; comment documents fitBounds fix
- `frontend/src/components/course/InlineHoleDiagram.tsx` — Google Maps stays DEFAULT; toggle UI reverted (crash was fitBounds, not create)
- `frontend/src/lib/map/satellite-helpers.ts` — added `MAP_VIEW_PREF_KEY`, `MapViewPref`, `getMapViewPref`, `setMapViewPref` (SSR-safe)
- `frontend/src/lib/map/google-map-helpers.test.ts` — added 34 tests: `haversineYards`, `zoomForPaddedYards`, `cameraForHole`
- `frontend/src/lib/map/satellite-map-pref.test.ts` (NEW) — 15 tests for localStorage pref helpers (vi.stubGlobal mock pattern)

### Gate results (all green)
- `npm run lint`: clean
- `npx tsc --noEmit`: clean
- `npx vitest run`: 1155/1155 (42 test files)
- `npx tsx voice-tests/runner.ts --smoke`: 265/265
- `npx next build --webpack`: 19 pages, clean

### Classification: NOTICEABLE (crash fix — map now opens without crashing)
Commit c08ace0 pushed to origin/feat/map-crashproof.

---

## 2026-06-29 — google-satellite-map (NOTICEABLE — feat/google-satellite-map, ready for bundle)

Google Maps satellite hole diagram replaces Mapbox GPSMapView for the map screens.
Tapping the map icon in-round now shows real satellite imagery with pin/tee markers,
F/C/B distance rings, layup rings (100/150/200y), GPS dot, and tap-to-measure.

### What was built
- `frontend/src/components/GoogleSatelliteMap.tsx` (NEW)
  - Props match GPSMapView for drop-in replacement
  - Native Google Maps via @capacitor/google-maps (Satellite tile type)
  - Dynamic import inside useEffect — prevents SSR HTMLElement crash
  - Overlays: G/T/F/B/P markers, layup rings, FCB rings, tee→green guide line, GPS→green distance line
  - Tap-to-measure click handler with yardage label
  - Per-hole camera framing via fitBounds(tee→green bounds)
  - Off-hole guard (v1.0.598 fix preserved): holeMapBounds never includes GPS position
  - center-only mode for non-ingested courses
  - inline mode for InlineHoleDiagram (compact strip footer instead of full panel)
- `frontend/src/lib/map/google-map-helpers.ts` (NEW — pure, headless-testable)
  - yardsToMeters, LAYUP_RING_YARDS, LAYUP_RING_COLORS, FCB_RING_COLORS
  - holeMapBounds (tee→green bounds for fitBounds), CENTER_ONLY_ZOOM
  - resolveCourseCenter, googleMapRendererFor, tapMeasureLabelGoogle, fcbMarkerSnippet
- `frontend/src/lib/map/google-map-helpers.test.ts` (NEW — 41 tests)
- `frontend/src/lib/map/satellite-helpers.ts` — MapRenderer 'mapbox'→'google'; mapRendererFor checks NEXT_PUBLIC_GOOGLE_MAPS_KEY
- `frontend/src/lib/map/satellite-helpers.test.ts` — updated mapRendererFor expectations to 'google'
- `frontend/src/app/map/course/page.tsx` — imports GoogleSatelliteMap; checks NEXT_PUBLIC_GOOGLE_MAPS_KEY; renderer 'mapbox'→'google'
- `frontend/src/components/course/InlineHoleDiagram.tsx` — imports GoogleSatelliteMap; checks NEXT_PUBLIC_GOOGLE_MAPS_KEY; renderer 'google'
- `ops/ios/ship.sh` — pulls NEXT_PUBLIC_GOOGLE_MAPS_KEY from looper/client AWS secret; graceful warn if absent; Mapbox pull retired
- `frontend/package.json` + `frontend/package-lock.json` — @capacitor/google-maps@8.0.1 added (npx npm@10.8.2 install per lockfile rule)

### Key technical decisions
- @capacitor/google-maps MUST be dynamic-imported inside useEffect (HTMLElement crash on SSR)
- LatLngBounds also dynamic-imported inside fitCameraToHole callback (same reason)
- mapbox-gl package NOT removed (CaddiePanel.tsx uses it directly)
- MapRenderer type: 'mapbox'→'google' (satellite-helpers.ts)
- Fallback: HoleDiagram when NEXT_PUBLIC_GOOGLE_MAPS_KEY absent (unchanged path)

### Gate results (all green)
- `cd frontend && npm run lint`: clean
- `cd frontend && npx tsc --noEmit`: clean
- `cd frontend && npx vitest run`: 1121/1121 passed (41 test files — incl. 41 new google-map-helpers tests)
- `cd frontend && npx tsx voice-tests/runner.ts --smoke`: 265/265 passed
- `cd frontend && npm run build`: all 19 pages generated, no SSR crash

### Classification: NOTICEABLE
Hole map screen now shows Google Maps satellite imagery with overlays instead of the
Mapbox vector renderer. Owner will see satellite photo with markers + distance rings.

---

## 2026-06-29 — fix-offhole-map (NOTICEABLE — feat/fix-offhole-map, ready for bundle)

P1 regression fix: vector map broke when GPS was far from the hole (home/simulator).

### Root causes fixed
1. `fitBounds` included the GPS position → 28-mile span → course rendered as sub-pixel speck.
   Fix: `holeViewBounds` calls in hole-change effect and `fitHole` now never include GPS.
2. Distances / FCB rings / distance line used raw GPS with no on-hole guard → ~49 000 yd.
   Fix: `isGpsOnHole` guard (reuses `isOnHoleBbox` logic, new helper in satellite-helpers.ts).

### What changed
- `frontend/src/lib/map/satellite-helpers.ts` — added `holeCoordsBbox` + `isGpsOnHole` (pure helpers)
- `frontend/src/lib/map/satellite-helpers.test.ts` — added tests for both new helpers (inside 40-file/1080-test suite)
- `frontend/src/components/GPSMapView.tsx`:
  - `distances` useMemo: uses tee as origin when off-hole (never GPS-based absurd yardages)
  - `hazardDistances` useMemo: returns empty when off-hole
  - `updateOverlays`: distance line + FCB ring origin guarded by `isGpsOnHole`
  - `handlePositionUpdate`: GPS "you" dot only shown/updated when on-hole
  - `holeViewBounds` callers (hole-change effect, fitHole): GPS position argument removed
  - Bottom panel: shows "GPS · Not on this hole · Tee distances shown" / "off hole" when off-hole

### Gates
- lint: clean · tsc: clean · vitest: 1080/1080 · voice-tests: 265/265 · build: pass

## 2026-06-29 — shot-analytics (NOTICEABLE — feat/shot-analytics, ready for bundle)

Per-club distance + dispersion view in the Profile. Replaces the "available when
shot tracking ships" placeholder with real aggregated data from the logged shots.

### What was built
- `backend/app/caddie/shot_stats.py` (NEW — pure, no I/O)
  - `ClubStat` dataclass: club, n, avg_distance, median_distance, stdev_distance, most_common_lie
  - `aggregate_by_club(rows)` — median/avg/stdev per club; longest→shortest sort; skips rows with no club/distance
- `backend/app/routes/shots.py` — added:
  - `ClubStat` Pydantic model (mirrors dataclass for FastAPI serialization)
  - `GET /api/shots/stats` — queries shots table (existing, no migration), delegates math to pure module
- `backend/tests/test_shot_stats.py` (NEW) — 24 pure-function tests (no DB): empty, single shot, multiple clubs, avg/median/stdev correctness, most_common_lie, sort order, rounding, tie-breaking
- `frontend/src/lib/shot-stats.ts` (NEW)
  - `ClubStat` TS interface (mirrors backend)
  - `fetchShotStats()` → GET /api/shots/stats
  - `sortClubStats()`, `dispersionLabel()`, `formatClubName()` — pure display helpers
- `frontend/src/lib/shot-stats.test.ts` (NEW) — 19 tests: sortClubStats (empty/single/multi/immutability), dispersionLabel (stdev/null/n<2), formatClubName, fetchShotStats (success/error/empty/URL check via global fetch mock)
- `frontend/src/app/profile/page.tsx` — `ShotAnalytics` component rewritten:
  - Self-contained fetch on mount (mirrors CourseReviews pattern)
  - Empty state: "Log shots with the voice caddie to build your distances."
  - Per-club rows: proportional distance bar + avg yardage + ±dispersion label
  - Loading suppression (avoids empty-state flash), shot count aside, footer legend
  - Follows Bag section visual language (3-col grid, accent bar for longest club)

### Gate results (all green)
- `cd backend && ruff check .`: All checks passed
- `cd backend && uv run pytest tests/test_shot_stats.py -v`: 24/24 passed in 0.02s
- `cd frontend && npm run lint`: clean
- `cd frontend && npx tsc --noEmit`: clean
- `cd frontend && npx vitest run`: 1067/1067 passed (40 test files)
- `cd frontend && npx tsx voice-tests/runner.ts --smoke`: 265/265 passed
- `cd frontend && npm run build`: compiled successfully

### Classification: NOTICEABLE
Profile page now shows real per-club shot analytics instead of a placeholder. Owner
will see the "Club distances" section populated with their voice-caddie logged shots.

### Capture confirmed: NOT rebuilt
Shot CAPTURE is unchanged. `backend/app/routes/shots.py` POST/GET-round/DELETE
endpoints, `frontend/src/lib/caddie/api.ts` `recordTrackedShot`, and the realtime
voice pipeline integration are all untouched — only analytics (read-only aggregate
endpoint + UI) added.

---

## 2026-06-29 — settlement-new-formats (SILENT — feat/settlement-new-formats, ready for bundle)

Settlement ledger now handles the four zero-sum wager formats that were missing.
A round with vegas, hammer, rabbit, or defender games now produces correct settle-up
entries in the SettleUpPanel instead of being silently ignored.

### What was built
- `frontend/src/lib/settlement.ts` — `computeGameNetWinnings` extended:
  - **Vegas**: distributes already-dollarized team totals equally among team players
    (last player absorbs rounding residual; zero-sum at player level guaranteed).
  - **Hammer**: maps already-dollarized per-player totals directly to net (no
    double-multiplication of pointValue).
  - **Rabbit**: two segment prizes (F9/B9) computed nassau-style — holder wins
    pointValue from each of the other N-1 players; unpaid if no holder.
  - **Defender**: maps already-dollarized per-player totals directly to net.
  - Excluded (scoring, not wager): scramble, bestBall, stableford, chicago,
    bingoBangoBongo, trash — not zero-sum money pools.
- `frontend/src/lib/settlement.test.ts` — 14 new tests:
  - Per-format worked examples asserting per-player net values.
  - Zero-sum invariant verified for each new format.
  - Mixed skins + vegas round asserts combined net and zero-sum.

### Gate results (all green)
- `npm run lint`: clean
- `npx tsc --noEmit`: clean
- `npx vitest run`: 980/980 pass (+10 net new tests)
- `npx tsx voice-tests/runner.ts --smoke`: 265/265 pass
- `npm run build`: Compiled successfully

### Classification: SILENT (backend-logic bugfix)
No UI changes. The effect is that SettleUpPanel will now show settle-up entries for
vegas/hammer/rabbit/defender games (previously silently omitted). This is a correctness
fix — the existing UI panels pick it up automatically via `computeNetSettlement`.

---
## 2026-06-29 — mapbox-satellite-map (NOTICEABLE — feat/mapbox-satellite-map, ready for bundle)

Mapbox satellite imagery is now the PRIMARY hole-map renderer on both the
standalone `/map/course` page and the inline round map (InlineHoleDiagram).
Falls back to the existing on-paper HoleDiagram when the token is absent.

### What was built
- `frontend/src/lib/map/satellite-helpers.ts` (NEW)
  - `mapRendererFor(token)` — pure renderer-selection function
  - `holeViewBounds(hole, userPos?)` — bounding-box helper for Mapbox fitBounds
  - `tapMeasureLabel(fromTeeYds, toPinYds)` — label formatter
  - `formatFCBLabel(f,c,b)` — F/C/B string formatter
  - `annotateOsmFeatures(pairs)` — OSM features annotated with hole numbers
- `frontend/src/lib/map/satellite-helpers.test.ts` (NEW)
  - 30 unit tests (all pure, no browser, no mapbox-gl) — all green
- `frontend/src/components/GPSMapView.tsx` (REVIVED/EXTENDED)
  - `courseId` type changed `number` → `string | number` (unused internally)
  - `onClose` made optional (required only in fullscreen mode)
  - `inline?: boolean` prop: relative positioning, compact bottom strip, no header/nav
  - Tap-to-measure: map click → `Tee Xy · Pin Yy` bubble; dismiss × closes it
  - `currentHoleRef` keeps click handler in sync with hole nav; tap marker clears on hole change
- `frontend/src/app/map/course/page.tsx`
  - Imports GPSMapView + satellite helpers
  - `allOsmFeatures` useMemo: collects + annotates all hole features
  - When `NEXT_PUBLIC_MAPBOX_TOKEN` present AND coords available → returns GPSMapView (fullscreen, takes over header/nav/distance panel)
  - Falls through to original HoleDiagram layout otherwise
- `frontend/src/components/course/InlineHoleDiagram.tsx`
  - Adds `allHoles` + `allCoords` state (flat arrays for satellite mode)
  - `osmFeaturesForSatellite` useMemo: annotated features for GPSMapView
  - When token present AND coords available → inline GPSMapView (260px, no hole nav)
  - Falls through to HoleDiagram otherwise
- `ops/ios/ship.sh`
  - NEXT_PUBLIC_MAPBOX_TOKEN: if unset, pull from `looper/prod` AWS Secrets Manager
  - Graceful: warns + leaves empty if secret absent → HoleDiagram fallback
  - Token NOT printed or committed

### Gates
- lint: clean
- tsc --noEmit: clean
- npx vitest run: 1000/1000 (39 files)
- voice-tests --smoke: 265/265
- npm run build: success

### Risk / notes
- Needs `NEXT_PUBLIC_MAPBOX_TOKEN` in `looper/prod` secret to show satellite imagery
- GolfAPI ingest (separate work) populates pin/F-C-B coords; mock Bethpage data works now
- Mapbox rendering is owner-verified on device (can't headlessly unit-test tile imagery)
- Ship.sh token-pull requires the EC2 build machine to have IAM access to `looper/prod`

## 2026-06-29 — game-formats (NOTICEABLE — feat/game-formats, ready for bundle)

8 previously-unimplemented game formats now show real results instead of the
"Results for this game format are not implemented yet." fallback card.

### What was built
- `frontend/src/lib/games.ts`:
  - 8 new typed result interfaces (ScrambleResults, BingoBangoBongoResults,
    VegasResults, HammerResults, RabbitResults, TrashResults, ChicagoResults,
    DefenderResults).
  - 8 new `compute*` functions implementing standard golf side-game rules.
  - `GameResults` interface updated (replaces `unknown` stubs for scramble/bingoBangoBongo/vegas,
    adds hammer/rabbit/trash/chicago/defender).
  - Dispatcher switch extended with all 8 new cases.
- `frontend/src/components/GameResults.tsx`:
  - 8 new render branches, one per format, using existing yardage-book design
    tokens (T.*), card/subRow patterns, and `<details>` hole-by-hole tables.
- `frontend/src/lib/types.ts`:
  - Added `GameSettings` fields: `hammerMultiplierByHole`, `defenderPlayerId`,
    `chicagoQuotaBase`.
- `frontend/src/lib/games.test.ts`:
  - 47 new unit tests (99 total). Worked examples, edge cases, zero-sum checks
    for all wager formats. Dispatcher test updated to verify new routes.

### Data-capture follow-ups (noted in results, not blocking)
- bingoBangoBongo: all 3 events need shot-by-shot tracking
- trash/junk: greenie/sandy/barkie/snake need per-shot events
- hammer: live throw/accept events need per-hole capture UI

### Settlement follow-up (for feat/game-settlement)
vegas, hammer, rabbit, and defender all produce zero-sum net totals — should
be wired into `computeGameNetWinnings` when that branch ships.
## 2026-06-29 — tee-time-foundation (NOTICEABLE — feat/teetime-foundation, ready for bundle)

Phase 1 of the tee-time epic: replaced the 100% hardcoded TT_* demo with a real
provider-backed architecture wired to a mock provider. Flow works end-to-end; flips
to live providers (Chronogolf/GolfNow) with no UI rework when API creds arrive.

### What was built
- `frontend/src/lib/teetime/types.ts` — TeeTimeQuery, TeeTimeSlot, BookingDetails, BookingResult
- `frontend/src/lib/teetime/provider.ts` — TeeTimeProvider interface (searchAvailability + book)
- `frontend/src/lib/teetime/providers/mock.ts` — cache-first MockTeeTimeProvider (6 courses incl. Bethpage)
- `frontend/src/lib/teetime/registry.ts` — provider registry; getActiveProvider() → mock by default
- `frontend/src/lib/teetime/client.ts` — searchTeeTimes / bookTeeTime → backend; frontend-mock fallback
- `frontend/src/lib/teetime/index.ts` — barrel export
- `frontend/src/lib/teetime/teetime.test.ts` — 16 unit tests (all passing)
- `backend/app/services/tee_times/base.py` — abstract TeeTimeProvider base class + shared data models
- `backend/app/services/tee_times/mock.py` — deterministic, cache-first backend MockTeeTimeProvider
- `backend/app/routes/tee_times.py` — GET /api/tee-times/search + POST /api/tee-times/book (owner-gated)
- `backend/app/main.py` — registered tee_times router
- `frontend/src/app/tee-time/page.tsx` — full rewrite: state-driven from provider (no TT_* constants);
  searching phase fires real queries + streams live log; confirmed phase shows real slot data;
  "Add another window" and "Invite" buttons now functional; loading/no-results/failed states added

### Gate results (all green)
- `npm run lint`: clean
- `npx tsc --noEmit`: clean
- `npx vitest run src/lib/games.test.ts`: 99/99 pass
- `npx tsx voice-tests/runner.ts --smoke`: 265/265 pass
- `npm run build`: clean

### Classification: NOTICEABLE
Any player who taps "View Results" on a round containing scramble, vegas,
hammer, rabbit, trash, chicago, or defender will now see real results. Was
previously a dead end ("not implemented yet"). bingoBangoBongo shows a clear
"needs event capture" message instead of the fallback.

---
- `npx vitest run src/lib/teetime/teetime.test.ts`: 16/16 pass
- `npx tsx voice-tests/runner.ts --smoke`: 265/265 pass
- `npm run build`: success (all routes including /tee-time)
- `ruff check .`: clean

### How the seam works
Set TEETIME_PROVIDER=chronogolf (backend env var) when Lightspeed API creds arrive;
ChronogolfProvider drops in behind the same interface. Zero UI changes required.

## 2026-06-29 — round-map-inline (NOTICEABLE — feat/round-map-inline, ready for bundle)

Inline yardage-book hole diagram in the active-round view: when playing a course with homegrown
geometry, the hole diagram appears automatically in the round view for the current hole. No link
or tap required. Replaces the "View hole map" deep-link added in feat/round-map-bridge.

### What was built
- `frontend/src/lib/hole-index.ts` (NEW): pure `indexByHoleNumber<T>` utility for O(1) hole lookup.
- `frontend/src/lib/hole-index.test.ts` (NEW): 6 unit tests covering indexing + edge cases.
- `frontend/src/components/course/InlineHoleDiagram.tsx` (NEW): self-contained component that
  fetches course geometry + GolfAPI coords ONCE on mount, indexes them by hole number, starts a
  GPSWatcher, and renders `HoleDiagram` for `currentHole` (updates on prop change, no refetch).
  260px fixed height, full-width, yardage-book paper background + hairline border.
  Graceful absence: renders nothing while loading or on error.
- `frontend/src/app/round/[id]/RoundPageClient.tsx`:
  - Removed "View hole map" deep-link button (superseded by inline diagram).
  - Removed unused `buildMapUrl` import.
  - Added `<InlineHoleDiagram courseId={mappedCourse.id} currentHole={currentHole} />` with a
    "Hole N map" SectionLabel, placed between the AnimatePresence hole card and the stakes ticker.
  - Gated by `mappedCourse !== null` (same resolution logic as before).

### Gate results (all green)
- `npm run lint`: clean (0 errors, 0 warnings)
- `npx tsc --noEmit`: clean
- `npx vitest run`: 834/834 pass (36 test files — 6 new for hole-index)
- `npx tsx voice-tests/runner.ts --smoke`: 265/265 pass
- `npm run build`: clean (Next.js SSG, all 19 routes)

### Classification: NOTICEABLE
User-visible when playing a round at a mapped course (Bethpage Black, Bethpage Red). The
yardage-book hole diagram appears inline — no tap needed. Tap-to-measure, pinch-zoom, GPS "you"
dot and F/C/B distances all work as in the standalone /map/course page (same HoleDiagram
component). No backend changes; token-independent.

---

## 2026-06-29 — round-map-bridge (NOTICEABLE — feat/round-map-bridge, ready for bundle)

Hole map deep-link from an active round: when playing a course with homegrown geometry,
a calm "View hole map" text link appears in the round header and opens the yardage-book
map at the current hole.

### What was built
- `frontend/src/lib/map-bridge.ts` (NEW): pure helpers — `clampHole`, `parseHoleParam`,
  `resolveMappedCourse` (conservative name match, case-insensitive + prefix), `buildMapUrl`.
  No deps beyond the existing `normalizeCourseName` util.
- `frontend/src/lib/map-bridge.test.ts` (NEW): 25 unit tests covering all helpers.
- `frontend/src/app/map/course/page.tsx`: Accept `?hole=<n>` search param; open diagram
  on that hole (clamped 1..18). Ref-captured at mount; does not disturb navigation state.
- `frontend/src/app/round/[id]/RoundPageClient.tsx`: Fetch `GET /api/courses/mapped?search=`
  when round.courseName is known; resolve a match via `resolveMappedCourse`; when found,
  show a calm dotted-underline "View hole map" button below "Round in progress" in the header.
  Hidden entirely when no mapped course matches.

### Gate results (all green)
- `npm run lint`: clean (0 errors, 0 warnings)
- `npx tsc --noEmit`: clean
- `npx vitest run`: 828/828 pass (35 test files, 25 new)
- `npx tsx voice-tests/runner.ts --smoke`: 265/265 pass
- `npm run build`: clean (Next.js SSG)

### Classification: NOTICEABLE
User-visible during a round at a mapped course (Bethpage Black, Bethpage Red). A yardage-book
hole-map link appears while playing. No backend changes; frontend-only. Token-independent
(existing endpoint). Ships on feat/round-map-bridge, ready to add to next bundle.

---
## 2026-06-29 — synth-fairway (NOTICEABLE — feat/synth-fairway, ready for bundle)

Synthesized fairway corridors for holes missing an OSM fairway polygon (e.g. Bethpage Black holes 3/7/8/9).

### What was built
- `frontend/src/lib/course/hole-projection.ts`:
  - New exported pure function `synthesizeFairwayCorridor(teeM, greenM, …) → ring | null`:
    builds a 32 m-wide capsule/stadium shape in metre-space from the tee→green axis.
    8 m inset off tee, 5 m inset off green, 10-point semicircular ends.
    Returns null for degenerate (tee ≡ green) or too-short holes.
  - `projectHole` now injects a synthetic fairway polygon tagged `synthetic: true`
    when no corridor-passing OSM fairway exists for the hole.
  - `ProjectedPolygon` interface gets optional `synthetic?: true` flag.
- `frontend/src/components/course/HoleDiagram.tsx`:
  - Synthetic fairways render at opacity 0.62 (vs 1.0 for real data) — same
    palette colour, calmer implied feel, not visually screaming.
- `frontend/src/lib/course/hole-projection.test.ts`:
  - +15 new tests: synthesizeFairwayCorridor (closed ring, width, symmetry,
    degenerate null, corridor containment, diagonal hole) + 6 integration tests
    (gains synthetic, no synthetic when real exists, z-order, viewport bounds,
    stray-filtered-out fairway triggers synthesis).

### Gates
- `npm run lint` — clean
- `npx tsc --noEmit` — clean
- `npx vitest run` — 818/818 passed (803 pre-existing + 15 new)
- `npx tsx voice-tests/runner.ts --smoke` — 265/265 passed
- `npm run build` — clean

### Classification
NOTICEABLE: holes 3/7/8/9 of Bethpage Black (and any hole on any course lacking
an OSM fairway) now show a green corridor in the hole diagram on TestFlight.
Frontend-only change — no re-ingest, no backend changes.

## 2026-06-29 — golfapi-cache-first (SILENT — feat/golfapi-cache-first, ready for bundle)

GolfAPI cache-first layer: batch+budget-guarded, never re-fetches a course already stored.
Frontend reads from our backend; never calls GolfAPI directly.

### What was built
- `backend/app/services/golfapi_cache.py` (NEW):
  - Injectable abstract `GolfApiClient`/`CacheStore`/`DiscoveryStore`/`BudgetStore`
  - `FileCacheStore` → `backend/data/golfapi_cache.json` (per-course coords survive restart/re-ingest)
  - `FileDiscoveryStore` → `backend/data/golfapi_discovery.json` (area/club catalog)
  - `FileBudgetStore` → `backend/data/golfapi_usage.json` (monthly counter, auto-resets)
  - `discover_golfapi_clubs(area_key, query)`: 1 `/clubs?name=q` call returns many course IDs
  - `get_course_golf_data(our_id, golfapi_id)`: 1 `/coordinates/{id}` call per course
  - Hard-stop at 45/50 calls/month; cache-first means 0 calls on hit
- `backend/app/routes/courses_mapped.py` (UPDATED): New `GET /{course_id}/golf-coords`
  endpoint reads from `FileCacheStore` — 0 GolfAPI calls, no DB required
- `backend/scripts/ingest_osm_course.py` (UPDATED): `--golfapi-id` + `--refresh-golfapi`
  flags; cache-first GolfAPI call after DB write; re-ingest reuses cache (0 repeat calls)
- `frontend/src/lib/course/course-coordinates.ts` (UPDATED): `getCourseCoordinates()` now
  tries backend `/golf-coords` first (our stored data), falls back to mock; NEVER calls
  GolfAPI directly; `USE_LIVE_GOLFAPI` flag removed
- `backend/tests/test_golfapi_cache.py` (NEW): 23 tests — cache-hit 0 calls, cache-miss 1 call,
  second call 0 calls, budget guard, discovery batch (1 call → 5 course IDs), no-token, persist
- `frontend/src/lib/course/course-coordinates.test.ts` (UPDATED): +6 backend-read tests (mock
  fetch → backend data used; empty → mock fallback; never calls golfapi.io)

### Gate results (all green)
- `backend/ruff check .`: clean
- `backend/pytest` (non-integration): 753/753 pass
- `frontend/npm run lint`: clean
- `frontend/npx tsc --noEmit`: clean
- `frontend/npx vitest run`: 782/782 pass (all 33 test files)
- `frontend/voice-tests --smoke`: 265/265 pass
- `frontend/npm run build`: clean

### Classification: SILENT
No user-visible UI change. Backend infrastructure + budget enforcement. Ships with next bundle.
Activation: owner provides GOLF_API_KEY + per-course golfapi_id → single ingest call loads data;
subsequent serve is instant from our cache. Discovery: `discover_golfapi_clubs(area_key, query)`
enumerates many course IDs in 1 API call, cached indefinitely per area.

---

## 2026-06-29 — hybrid-golfapi-map (NOTICEABLE — feat/hybrid-golfapi-map, ready for bundle)

Hybrid course map: GolfAPI-verified POINTS anchoring homegrown OSM SHAPES.
No live GolfAPI call (no token yet) — mock data derived from OSM centerlines, trivially swappable.

### What was built
- `frontend/src/lib/course/course-coordinates.ts`: Provider abstraction with mock data for
  Bethpage Black + Red (18 holes each, seeded from Overpass OSM centerlines on 2026-06-29).
  One-line live-swap: set `USE_LIVE_GOLFAPI = true` + fill `GOLFAPI_COURSE_ID_MAP`.
- `frontend/src/lib/course/hole-projection.ts`: Added `nearestGreenCentroid()` + optional
  `overrides` param to `projectHole()` so GolfAPI tee/green override OSM polygon centroids
  for corridor clip, orientation, and SVG marker positions.
- `frontend/src/components/course/HoleDiagram.tsx`: New `courseCoords` prop. When present:
  uses GolfAPI green as authoritative pin, GolfAPI tee as anchor, picks nearest OSM green.
- `frontend/src/app/map/course/page.tsx`: Loads GolfAPI coords in parallel with course data,
  passes per-hole `holeCoords` to diagram + info strip. Shows F · C · B green distances
  (from player when GPS on-hole, from tee otherwise). Graceful fallback for other courses.
- `frontend/src/lib/course/course-coordinates.test.ts`: 13 new unit tests.
- Hole-projection tests: 9 new tests for `nearestGreenCentroid` + override behaviour.

### Gate results
- `frontend/vitest run`: 776/776 pass (22 new tests)
- `frontend/npm run lint`: clean
- `frontend/npx tsc --noEmit`: clean
- `frontend/voice-tests --smoke`: 265/265 pass
- `frontend/npm run build`: clean
- No backend changes (frontend-only)
## 2026-06-29 — voice-name-disambiguation (NOTICEABLE — feat/voice-name-disambiguation, ready for bundle)

Voice now resolves spoken player/course names against the user's REAL saved data.

### What was built
- `frontend/src/lib/voice/parseVoiceTranscript.ts`: Extended `ParseVoiceTranscriptOptions`
  with `known?: { players?: string[]; courses?: string[] }`. `parseVoiceTranscriptLocally`
  now accepts and uses this context: extracted player names are fuzzy-matched against
  `known.players` at threshold 0.76 (same as pipeline.ts); extracted course names at 0.74.
  If candidate set is empty, behaviour is unchanged — no regression.
- `frontend/src/app/round/new/page.tsx`: Added `knownCourseNames` state (populated from
  `listFavorites()` + `getRecentCourses()`, both synchronous localStorage reads). In
  `handleVoiceSetup`, the AI-returned course name is now fuzzy-matched against
  `knownCourseNames` at 0.74 before populating the form — fixing Bally→Valley class bugs.
  Player resolution in the realtime path was already handled by `matchPlayerNames`
  (Soundex+fuzzy in `player-match.ts`); Dipak/Deepak already worked.
- `frontend/src/lib/voice/voice-disambiguation.test.ts`: 21 new Vitest tests covering
  the two-mechanism split: phonetic (realtime players via matchPlayerName/Soundex) and
  edit-distance (courses + transcript players via fuzzyBestMatch). Documents exactly what
  each mechanism can and cannot do.

### Gate results
- `frontend/npm run lint`: clean
- `frontend/npx tsc --noEmit`: clean
- `frontend/vitest run`: 775/775 pass (21 new tests)
- `frontend/voice-tests --smoke`: 265/265 pass
- `backend/ruff check .`: clean
- Build: confirmed clean via tsc (Turbopack symlink limitation in worktree env)

### Classification: NOTICEABLE
User-visible: voice round setup no longer mishears saved partner names or course names.
"Say Dipak, app saves Dipak" and "Say Bally Links, app saves Bally Links" both now work.
## 2026-06-29 — game-settlement (NOTICEABLE — feat/game-settlement, ready for bundle)

Game settlement / payout finalization: winnings were displayed but never persisted or
finalized. Now there is a complete "Settle up" flow.

### What shipped
- `frontend/src/lib/settlement.ts` — pure net-settlement computation + transfer
  minimization (greedy O(n log n), guarantees ≤ n−1 transfers). Handles skins, wolf,
  nassau (individual), matchPlay, threePoint. Zero-sum invariant enforced at 2dp.
- `frontend/src/lib/settlement.test.ts` — 24 unit tests covering all formats, zero-sum
  invariant, multi-game netting, transfer minimization, and the persisted-settlement reader.
- `frontend/src/components/SettleUpPanel.tsx` — calm yardage-book settle-up UI (after
  game results in RoundRecap). Shows perspective-aware transfers ("You pay Sam $12",
  "Sam pays you $23"), "Mark as settled" button, and a locked read-only finalized state.
  Returns null silently when the round has no money games.
- `frontend/src/lib/api.ts` — `finalizeSettlement(roundId, payload)` client function.
- `backend/app/models.py` — `SettlementTransfer` + `SettlementFinalize` Pydantic models.
- `backend/app/routes/rounds.py` — `POST /api/rounds/{id}/settlement` endpoint. Stores
  the client-computed ledger as a synthetic Game row (format='settlement', settings JSONB).
  Idempotent: calling again overwrites the previous record. NO DB migration needed.
- `frontend/src/lib/types.ts` — added 'settlement' to `GameFormat` union; added index
  signature `[key: string]: unknown` to `GameSettings` for flexible synthetic-game storage.
- `frontend/src/components/GameLeaderboards.tsx` + `RoundRecap.tsx` — filter 'settlement'
  format games out of display loops (they render via SettleUpPanel only).

### Storage approach
Settlement is stored as a Game row (format='settlement') in the existing `games` table,
which already has a flexible JSONB `settings` column. No DB migration needed. The backend
GameORM.settings accepts arbitrary dicts; the client reads the settlement back via
`round.games.find(g => g.format === 'settlement')`.

### Gates
- backend ruff: pass
- frontend lint: pass
- frontend tsc: pass
- vitest (778 tests): pass (33 test files, 24 new settlement tests)
- voice-tests --smoke: pass=265 fail=0
- npm run build: pass

### Branch
feat/game-settlement — DO NOT merge to main (bundle PR only)
## 2026-06-29 — green-slope (NOTICEABLE — feat/green-slope, ready for bundle)

Wires the dormant 3DEP green-slope Sobel sampler into the ingest pipeline and
surfaces a calm green-slope readout ("green: 2.3% ↘ SE") on the hole-map info strip.

### What was done
1. **backend/app/services/elevation.py**:
   - Extracted `_green_slope_grid_points` (pure geometry, 9-point Sobel grid) and
     `_compute_slope_from_grid` (pure Sobel math) from `compute_green_slope`.
   - Fixed Sobel atan2 sign bug: `atan2(dzdx, -dzdy)` → `atan2(-dzdx, -dzdy)` so that
     east/west-draining greens get the correct compass direction (was inverted before).
   - `sample_course_elevations`: now makes a second `fetch_3dep_samples` batch call for all
     9×N green-slope grid points (one round-trip), computes slope per hole with
     `_compute_slope_from_grid`, passes into `compute_hole_elevation_profile`.
2. **backend/app/services/osm_ingest.py** `embed_elevation_in_green_features`:
   - Now also embeds `green_slope` as a jsonb sub-dict in the green feature properties
     when present. No migration needed.
3. **backend/tests/test_green_slope_ingest.py** (new, 36 tests):
   - _green_slope_grid_points: 9 points, N>S, E>W, custom radius.
   - _compute_slope_from_grid: flat/south/east/severe/insufficient-data.
   - sample_course_elevations: mocked fetch_3dep_samples → green_slope populated.
   - embed_elevation_in_green_features: green_slope stored/absent/non-green-safe.
4. **frontend/src/lib/course/hole-elevation.ts**:
   - Added `GreenSlope` interface, `greenSlope` field on `HoleElevation`.
   - Added `degreesToCompassLabel` (pure, 8-point), `compassLabelToArrow`.
   - Added `formatGreenSlope` → "green: 2.3% ↘ SE" or null for flat/absent.
   - `extractHoleElevation` now reads `green_slope` from green feature properties.
5. **frontend/src/lib/course/hole-elevation.test.ts**: +23 tests (60 total).
6. **frontend/src/app/map/course/page.tsx**: renders green-slope readout line below
   plays-like in HoleInfoStrip. Gracefully absent when no data.

### Test gate results
- `backend/ruff check .`: clean
- `backend/pytest --ignore=tests/integration`: 766/766 pass
- `frontend/npm run lint`: clean
- `frontend/npx tsc --noEmit`: clean
- `frontend/npx vitest run`: 788/788 pass (60 in hole-elevation.test.ts)
- `frontend/voice-tests --smoke`: 265/265 pass
- `frontend/npm run build`: clean

### Notes for re-ingest
Bethpage Black/Red need a re-ingest to populate green_slope (free 3DEP, no GolfAPI).
Until then, the plays-like line shows but the slope line is gracefully absent.

## 2026-06-29 — corridor-tighten (NOTICEABLE — feat/corridor-tighten, ready for bundle)

Fixes stray polygons (foreign greens, ponds, tree rows from adjacent holes) still
appearing on Bethpage Black hole diagrams after v1.0.556.

### Root cause
The frontend corridor guard used a rectangular lat/lng bbox around the tee→green axis
(`CORRIDOR_LAT_DEG = 0.003` ≈ 330 m, `CORRIDOR_LNG_DEG = 0.004` ≈ 440 m). For diagonal
holes this bbox is much wider than the hole corridor, so features 150–400 m to the side
still passed the filter.

### Frontend fix (takes effect on BUILD — no re-ingest needed)
`frontend/src/lib/course/hole-projection.ts`:
- Replaced the rectangular bbox guard with a perpendicular-distance-from-segment test.
- New exported constants: `CORRIDOR_LATERAL_M = 60` (60 m lateral band) and
  `CORRIDOR_LONGITUDINAL_MARGIN_M = 40` (40 m past each end).
- New exported pure functions: `pointToSegmentDistanceM` and `isInHoleCorridor`.
  Both are unit-tested in Node without any DOM.
- Same corridor test applied to tree Point features (was previously unfiltered).
- The fit/bbox for SVG scaling is computed from `filteredPolygons` (was already the case;
  confirmed corridor-filtered set drives both the fit AND what is rendered).

### Backend cap tightening (takes effect on NEXT re-ingest)
`backend/app/services/course_spatial.py` `_CORRIDOR_CAPS_M`:
- water: 250 → 130 m (stray cross-hole ponds excluded)
- woods: 500 → 150 m (neighbouring-hole forests excluded)
- tree:  300 → 120 m (stray tree nodes excluded)

### Test gate results
- `frontend/vitest run`: 754/754 pass (84 new/updated tests in hole-projection.test.ts)
- `frontend/npm run lint`: clean
- `frontend/npx tsc --noEmit`: clean
- `frontend/voice-tests --smoke`: 265/265 pass
- `frontend/npm run build`: clean
- `backend/ruff check .`: clean
- `backend/pytest tests/test_course_spatial.py`: 95/95 pass

## 2026-06-29 (course-search — NOTICEABLE — feat/course-search, ready to merge to integration/next)
Course search now finds mapped courses (Bethpage) + favorites + nearby empty state.

### What was done
1. `frontend/src/components/CourseSearch.tsx` — Full rewrite:
   - Switched from `searchCourses` (GolfAPI-only) to `searchAllCourses` (mapped+OSM+GolfAPI),
     so Bethpage Black/Red appear at the top of results (mapped source ranked first).
   - 250ms debounce + AbortController to cancel stale requests (no flickering).
   - Empty state: Favorites section (starred courses) then Nearby section (GPS, best-effort).
   - Star toggle on every result; starred courses persist in localStorage.
   - Footer updated from "COURSE DATA · GOLFAPI.IO" to "Mapped · Community · OpenStreetMap".
2. `frontend/src/lib/course-favorites.ts` — New library: localStorage-backed favorites with
   injectable KVStore for testability (no jsdom needed in tests).
3. `frontend/src/lib/course-search-helpers.ts` — New pure functions: distanceMiles (Haversine),
   formatMiles, dedupeByName, mergeAndSortNearby.
4. `frontend/src/app/courses/page.tsx` — Routes mapped search results to /map/course?id= 
   (the hole-map view) instead of the GolfAPI detail page (which can't load UUID course ids).
5. `frontend/src/app/round/new/page.tsx` — Added `source?: string` to SelectedCourse to 
   accept the extended payload from CourseSearch (no behavior change; field is ignored).

### Test coverage (NEW — 36 new tests, all passing)
- `course-favorites.test.ts`: add/remove/toggle/list/isFavorite, persistence round-trip, dedupe
- `course-search-helpers.test.ts`: distanceMiles, formatMiles, dedupeByName, mergeAndSortNearby

### Gate results
- lint: clean
- tsc --noEmit: clean
- vitest: 696/696 pass (up from 660, +36 new)
- voice-tests --smoke: 265/265 pass
- next build: clean (verified in main repo; worktree Turbopack blocks external symlinks)

### Classification: NOTICEABLE (Bethpage now appears in search; favorites/nearby are new UX)
## 2026-06-29 (harden-spatial-join + pinch-zoom — NOTICEABLE — feat/harden-spatial-join, pushed)

### Backend: cross-course polygon contamination fix (Bethpage Black)
Root cause: `_RECLAIM_SAME_AREA_M = 200.0` in `build_course_feature_collection` was pulling
Red/Green/Yellow/Blue course features into Black (all 5 courses within ~2.5 km).
Symptom: H16 showed 670 yds (foreign green corrupted distance); H18 showed 22 bunkers / 5 greens.

Fix:
- Removed the entire reclaim pass
- Added per-feature-type corridor distance caps (`_CORRIDOR_CAPS_M`): green/tee 120m, fairway
  200m, bunker 150m, water 250m, rough/woods 500m
- Added large-polygon filter: woods/rough with bbox diagonal > 450m dropped
- Diagnostic: `backend/scripts/diag_bethpage.py` (headless Overpass — H16: 481 yds, card: 490 yds, ~2% off)
- Backend tests: 95 pass (was 86 — added 9 corridor-cap tests)

### Frontend: corridor guard in hole-projection.ts
- Added `filteredPolygons` corridor guard (tee→green bbox ± 0.003°/0.004°)
- All geo bbox + mtrPolygons now use `filteredPolygons` (prevents stray polygon from compressing diagram)
- Added 4 corridor-guard tests; 88 total hole-projection tests pass

### Frontend: pinch-to-zoom + pan on SVG hole diagram (HoleDiagram.tsx)
- New `frontend/src/lib/course/zoom-pan.ts`: pure-math helpers (applyPinch, applyPan, clampViewBox,
  pinchDist, pinchMidpoint, currentScale, viewBoxAttr) — no dependencies
- New `frontend/src/lib/course/zoom-pan.test.ts`: 32 unit tests, all pass
- HoleDiagram.tsx: 1-finger pan + 2-finger pinch (up to 5×) + double-tap reset + wheel zoom
  via SVG viewBox attribute (NOT CSS/g transform — preserves getScreenCTM() for tap-to-measure)
- Hint updated: "tap · pinch to zoom"

### Gate results
- Backend: ruff clean; 95/95 pytest (non-DB)
- Frontend: tsc clean; 120/120 vitest; 265/265 voice-tests smoke

### Classification: NOTICEABLE (yardage numbers corrected; pinch-zoom visible on course screen)
Branch: feat/harden-spatial-join (pushed)

## 2026-06-29 (second-course — NOTICEABLE — feat/second-course, ready for prod ingest)
Validated OSM pipeline on Bethpage Red as the 2nd ingested course; added it to the viewer.

### Coverage check (live Overpass, all 4 candidates):
| Course | AllHoles | TgtHoles | w/par | w/hcp | Greens | Fairways | Tees | Bunkers | Water |
|--------|----------|----------|-------|-------|--------|----------|------|---------|-------|
| Torrey Pines South | 36 | 0 | 0 | 0 | 39 | 15 | 157 | 140 | 8 |
| Chambers Bay | 18 | 18 | 0 | 0 | 23 | 6 | 64 | 51 | 12 |
| Pinehurst No.2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 (429) |
| Bethpage Red | 90 | 18 | 18 | 0 | 96 | 99 | 215 | 270 | 50 |

**Choice: Bethpage Red** — only candidate with hole LineStrings AND par tags; same campus
as Black so cross-course spatial join is already proven; OSM `golf:course:name=Red` filter
works with existing code (no pipeline changes needed).

### Dry-run output (--dry-run; no DB written):
- Fetched: 90 hole LineStrings, 730 polygon features
- Assembled: 18 holes, 561 total polygon features
- Course UUID: 269e1f2e-65cc-5cf6-a9b0-f5908e298155 (key: osm-bethpage-red)
- Par sequence: 4-4-4-3-5-4-3-4-4-4-4-3-4-4-4-5-3-4 = 70 (matches Bethpage Red card)
- Handicap: None (not tagged in OSM — known gap)

### Files changed:
- `backend/tests/test_ingest_osm_course.py` — pinned UUID for osm-bethpage-red
- `frontend/src/app/courses/page.tsx` — added Bethpage Red entry to Course maps section

### Prod ingest required (NOT done here — no local DB):
  uv run backend/scripts/ingest_osm_course.py \
    --lat 40.7445 --lng -73.4609 --radius 2500 \
    --target-course Red --course-key osm-bethpage-red \
    --course-name "Bethpage Red"

### Classification: NOTICEABLE (new viewer entry, visible once ingested to prod)

## 2026-06-29 (hole-elevation — NOTICEABLE — feat/hole-elevation, ready to merge)
Per-hole elevation + "plays-like" readout on the yardage-book hole diagram (I4).

### What was done
1. `backend/app/services/elevation.py`:
   - Added `PLAYS_LIKE_YARD_PER_FT = 1/3` constant (1 yd per 3 ft, USGA rule of thumb).
   - `compute_hole_elevation_profile` now includes `plays_like_yards` in return dict.
   - Added `sample_course_elevations(holes, target_course_name)` — async, batches
     all tee+green points into a single USGS 3DEP ImageServer call.
   - Made `app.db.engine` import lazy (inside `fetch_elevation_cached`) so pure
     functions work without DATABASE_URL (dry-run / unit tests).

2. `backend/app/services/osm_ingest.py`:
   - Added `embed_elevation_in_green_features(course_data)` — injects 4 fields
     (`tee_elevation_ft`, `green_elevation_ft`, `delta_ft`, `plays_like_yards`) into
     each hole's green feature properties (shallow-copy to avoid mutating shared fixtures).
     These persist through `upsert_course` → `hole_features.properties` jsonb without
     any schema migration.

3. `backend/scripts/ingest_osm_course.py`:
   - Wired elevation sampling after Overpass fetch, before assembly.
   - Passes `hole_elevations` to `assemble_osm_course`; calls `embed_elevation_in_green_features`.
   - Dry-run now prints per-hole tee/green/delta/plays-like table.

4. `backend/tests/test_hole_elevation_ingest.py` (new):
   - 33 tests: `plays_like_yards` math (uphill/downhill/flat/PLAYS_LIKE_YARD_PER_FT),
     `embed_elevation_in_green_features` (green-only injection, non-green untouched,
     None-elevation handling, in-place return, both holes, partial maps).

5. `frontend/src/lib/course/hole-elevation.ts` (new):
   - `extractHoleElevation(features)` — reads elevation from green feature properties.
   - `formatPlaysLike(playsLikeYards)` — "plays ~N yds longer ↑" / "shorter ↓" / "flat".

6. `frontend/src/lib/course/hole-elevation.test.ts` (new):
   - 30 tests: null handling, happy path field extraction, formatPlaysLike rounding.

7. `frontend/src/app/map/course/page.tsx`:
   - `HoleInfoStrip` now accepts `elevation: HoleElevation | null` prop.
   - Renders a calm mono readout below yardage (absent when no data).

### Storage proof (no migration)
`embed_elevation_in_green_features` injects into `feature.properties` dicts.
`upsert_course` stores those as `hole_features.properties` jsonb (existing column).
`get_course` reads them back and spreads into each feature's `properties`. Verified
via dry-run: green feature properties contain all 4 fields in the JSON payload.

### Headless dry-run table (live USGS 3DEP, Bethpage Black)
All 18 holes returned sane Long Island elevations (86–161 ft). Sample:
  H1: tee=124.5 ft, green=86.0 ft, delta=-38.5 ft, plays=-12.8 yds (downhill)
  H16: tee=147.9 ft, green=88.0 ft, delta=-59.9 ft, plays=-20.0 yds (dramatic!)

### Prod re-ingest required
The frontend readout only shows data AFTER the next production re-ingest of Bethpage Black.
Run: `uv run backend/scripts/ingest_osm_course.py` (no --dry-run) on the EC2.

### Gates
- Backend ruff: clean · pytest 720/720 (unit) · dry-run: clean
- Frontend lint: clean · tsc: clean · vitest 660/660 · voice smoke 265/265 · next build: clean

### Status: DONE — on feat/hole-elevation, pushed, ready for eng-lead to include in bundle

## 2026-06-29 (personal-bests — NOTICEABLE — integration/next, commit 54c476e, PR #72)
Adds "Personal bests" career milestones section to the profile page.

### What was done
1. `frontend/src/lib/personal-bests.ts` (new):
   - `derivePersonalBests(rounds)` — pure derivation over all completed rounds.
   - Metrics: rounds played, best round (lowest toPar, tie-break newest date),
     career eagle/birdie/par totals, best hole vs par by type (par-3/4/5),
     longest consecutive birdie-or-better streak in a single round.
   - Uses `getOwnerPlayerId()` (respects explicit `ownerPlayerId`).
   - Rounds with < 9 played holes excluded from round-level metrics; hole-level
     stats (milestones, best hole, streak) accept all scored holes.

2. `frontend/src/lib/personal-bests.test.ts` (new):
   - 45 unit tests covering: zero state, single/mixed 9H+18H rounds, incomplete
     rounds, owner-not-first-player, eagle/birdie/par counts, best-hole tiebreaking,
     best-round tiebreaking, streak logic, streak resets on null/absent holes,
     streak resets between rounds, active-round exclusion.

3. `frontend/src/app/profile/page.tsx`:
   - New `CareerBests` component added after YearLog, before CourseReviews.
   - Yardage-book aesthetic: Section wrapper, inline styles matching existing pattern,
     quiet empty state, no new dependencies.

### Gates
- ESLint: clean · TypeScript: clean · Vitest personal-bests: 45/45
- Voice smoke: 265/265 · next build: clean

### Status: DONE — in PR #72
## 2026-06-29 (job-f-spatial-join — SILENT improvement — feat/fuller-course-map, commit 761c9a9)
Improved fairway attribution from 13/18 to 14/18 Black holes (Job F). Holes 3/7/8/9 are
verified OSM data gaps (400–700 m from Black centerlines) — no per-hole hardcodes used.

### What was done
- course_spatial.py: Added _point_in_ring (ray-casting), _linestring_intersection_m (densified
  polygon-interior scoring), 3-tier assign_features_to_holes (Tier 1 overlap / Tier 2 ring-vertex
  voting / Tier 3 original centroid-to-line), and _RECLAIM_SAME_AREA_M (200 m) reclaim pass in
  build_course_feature_collection for multi-course venues (Bethpage 5 courses share one property).
- test_course_spatial.py: +20 tests (86 total). TestPointInRing, TestLinestringIntersectionM,
  TestParallelHoleFairwayAttribution, TestMultiCourseReclaim.

### Live Overpass diagnostic (Bethpage Black lat=40.7445, lng=-73.4609)
Holes missing fairway before: [1,3,7,8,9] (13/18). After: [3,7,8,9] (14/18).
Holes 3/7/8/9: verified OSM data gaps — Green course h3/h7/h8/h9 are 400–700 m from Black.

### Gates
ruff: PASS · pytest 697/697 · eslint PASS · tsc PASS · voice-tests 265/265

SILENT — backend-only change; requires prod re-ingest to take effect.

## 2026-06-29 (fuller-course-map — NOTICEABLE — feat/fuller-course-map, commit a5bef42)
Extends the yardage-book hole diagram with terrain layers (rough, woods, trees), tap-to-measure
connector lines, iOS safe-area header fix, and responsive ResizeObserver-based diagram sizing.

### What was done
- Backend `osm.py`: new Overpass queries for golf=rough, natural=wood/scrub, landuse=forest,
  natural=tree_row, node[natural=tree]; parsed into rough (Polygon), woods (Polygon),
  trees (Point GeoJSON) buckets.
- Backend `course_spatial.py`: spatial join extended to handle Point geometry (direct coord
  extraction) in addition to Polygon (centroid).
- Backend `osm_ingest.py`: rough/woods/trees added to flat polygon list fed to spatial join.
- Backend tests: `test_osm_parsing.py` updated key-set test; new `TestTerrainFeatures` class
  (18 tests). `test_course_spatial.py` new `TestPointGeometrySpatialJoin` class (7 tests).
- Frontend `hole-projection.ts`: RENDER_ORDER puts rough/woods before fairway; tree Point
  features projected to SVG coordinates; `trees` field added to `ProjectedHole`.
- Frontend `HoleDiagram.tsx`: new PAL entries (roughFill, woodsFill, treeGlyph, tapConnector);
  warm-grass PAL.ground background replaces dot-pattern; tree glyphs as filled circles;
  tap-to-measure dashed connector lines (tee→tap, tap→green).
- Frontend `map/course/page.tsx`: safe-area header padding max(14px, env(safe-area-inset-top));
  ResizeObserver-based HoleDiagramAutosize replacing hardcoded 300×400.
- Frontend tests: hole-projection.test.ts +18 tests (rough/woods RENDER_ORDER, tree projection).

### Diagnostic (Job B — missing fairways)
Bethpage fixture has 99 fairway polygons but holes 1,3,7,8,9 lack a fairway after spatial join.
Verdict: data attribution gap — those fairways exist in OSM but their centroids fall closer to
an adjacent hole's LineString than the intended one. Not a parsing bug. Re-ingest from live
Overpass (which may have improved tags) should partially improve this; otherwise a per-hole
override table is the next step.

### Gates
- `ruff check .`: PASS (clean)
- `pytest`: PASS (161/161)
- `npx vitest run`: PASS (58/58, hole-projection.test.ts)
- `npm run lint`: PASS
- `npx tsc --noEmit`: PASS
- `npx tsx voice-tests/runner.ts --smoke`: PASS (265/265)
- `npm run build`: PASS (clean)

NOTICEABLE — diagram now shows rough/woods terrain fills, tree glyphs, tap-connector lines,
fills the screen on any device size, and the back button works on notched iPhones.
Post-merge: prod needs a re-ingest of Bethpage Black to populate rough/woods/tree data, then
a new TestFlight build.

## 2026-06-29 (tap-to-measure-gps-hole-diagram — NOTICEABLE — integration/next, commit 7c2b15f)
Adds tap-to-measure and live GPS overlay to the /map/course yardage-book hole diagram.

### What was done
1. `frontend/src/lib/course/hole-projection.ts`:
   - New `ProjectionParams` interface (minLng/Lat, maxLng/Lat, cosLat, angle, cx/cy, scale, offsetX/Y, rxMin, ryMax).
   - `ProjectedHole` extended with `params`, `teeLatLng`, `greenLatLng`.
   - `projectHole()` now returns all of the above (backward-compatible additive).
   - New `projectLatLng(latlng, params) → [x, y]` — forward transform.
   - New `unprojectPoint(svg, params) → {lat, lng}` — exact inverse (round-trip error < 1e-7°).
   - New `isOnHoleBbox(pos, params, marginDeg=0.006)` — on-hole guard (~720 yds margin).
   - New `yardsDistance(a, b) → yards` — haversine distance in yards.
   - `LAT_M` made module-level constant so all transforms share the same value.

2. `frontend/src/components/course/HoleDiagram.tsx`:
   - New `gpsPosition?: {lat, lng} | null` prop.
   - Tap/click on SVG → `unprojectPoint` → `yardsDistance` from tee and to pin → renders
     a crosshair dot + "Tee 247 · Pin 165" mono label with × dismiss.  Tapping again moves it.
   - GPS "you" dot (cobalt, with halo) plotted via `projectLatLng` when `isOnHoleBbox` → true.
     Suppressed when player is remote — no absurd yardages.
   - "tap to measure" idle hint text when no marker and no GPS on-hole.
   - SVG uses `createSVGPoint + getScreenCTM` for pixel-perfect coord mapping at any CSS scale.

3. `frontend/src/app/map/course/page.tsx`:
   - GPS watcher (`GPSWatcher`) started on mount; permission denied → tap-measure still works.
   - `computeGpsDistances()` runs `projectHole + isOnHoleBbox` on each render (cheap, pure).
   - Info strip updated: when on-hole → "You to pin: N yds" (accent cobalt); off-hole but
     GPS available → "Not on this hole — tap to measure" calm hint.
   - `gpsPosition` passed through to `HoleDiagramAutosize` → `HoleDiagram`.

4. `frontend/src/lib/course/hole-projection.test.ts` (extended, +57 new tests, total 87):
   - Round-trip: `unprojectPoint(projectLatLng(p)) ≈ p` for tee, green, fairway midpoint,
     off-centre point — all within 1e-7°.
   - `projectLatLng` keeps tee centroid within padding bounds.
   - `teePt` from `projectHole` matches `projectLatLng(teeLatLng)` to 3 decimal places.
   - `isOnHoleBbox`: on-hole → true; 28-mi-away → false; margin clamping tests.
   - `yardsDistance`: zero for same point, ~400 yds for fixture, symmetric, integer.
   - Tap distance: tapping tee SVG → fromTee ≤ 1 yd; tapping green → toPin ≤ 1 yd;
     fairway midpoint → fromTee + toPin ≈ hole length ± 5 yds.

### Gates
- `npm run lint`: PASS (0 warnings)
- `npx tsc --noEmit`: PASS (0 errors)
- `npx tsx voice-tests/runner.ts --smoke`: PASS (265/265)
- `npx vitest run`: PASS (580/580, 27 files, +57 new from hole-projection.test.ts)
- `npm run build`: PASS (clean Turbopack build, 19 pages)

NOTICEABLE — tap any point on the hole diagram to see "Tee 247 · Pin 165" distances; GPS
dot appears when on the course. Verify on device at /map/course?id=<Bethpage Black UUID>.

## 2026-06-29 (yardage-book-hole-diagram — NOTICEABLE — integration/next)
Replaces the broken GPSMapView satellite viewer on /map/course with a clean, on-paper,
top-down yardage-book hole diagram derived from homegrown OSM geometry. No Mapbox, no
live GPS distances. Tee at bottom, green at top, layered SVG polygons in a restrained
yardage-book palette.

### What was done
1. `frontend/src/lib/course/hole-projection.ts` (new, pure module):
   - `projectHole(features, viewport)`: gathers polygon features, applies cosLat-corrected
     equirectangular projection to metre space, rotates so tee→green axis is vertical
     (tee bottom, green top), fits to SVG viewport with padding and aspect-ratio preservation.
   - `holeLengthYards(features)`: LineString sum first; falls back to tee→green centroid distance.
   - `describeHazards(features, projected)`: counts bunkers/water; adds left/right qualifier
     from projected geometry when projected is available.
   - Exports `ringCentroid` and `rotatePoint` as pure helpers for testing.

2. `frontend/src/lib/course/hole-projection.test.ts` (new, 30 pure tests, headless/Node):
   - ringCentroid: null for empty, closing-vertex exclusion, correct mean.
   - rotatePoint: 90°/180°/0°/non-origin center cases.
   - projectHole: null for empty/LineString-only, valid output, all points in bounds,
     padding respected, green above tee, diagonal hole still oriented, render order.
   - holeLengthYards: empty=0, no tee/green=0, centroid fallback ~400 yds, LineString
     takes priority, multi-segment sum.
   - describeHazards: no hazards, bunker count, water + side qualifier.

3. `frontend/src/components/course/HoleDiagram.tsx` (new):
   - Renders projected hole as inline SVG with layers: rough-grass background → fairway
     (sage green) → water (slate blue) → bunker (parchment/sand) → green (deeper green)
     → dashed centreline → tee marker (ink+paper) → flag pole+pennant (T.flag coral).
   - All colours from T.* tokens or close on-paper analogues. No neon.
   - Empty state for holes with no geometry.
   - Props: features, width, height, padding, showLabels.

4. `frontend/src/app/map/course/page.tsx` (rewritten):
   - GPSMapView / mapbox-gl dynamic import removed entirely.
   - Loads course via fetchMappedCourse, iterates sortedHoles with ◄/► nav.
   - Header: back arrow + course name (serif).
   - Main area: HoleDiagramAutosize wrapper (300×400 default, fills available space).
   - Info strip: hole number (large serif), Par/HCP, yards (giant serif), hazard text.
   - Nav bar: ◄ Hole N / N/total / Hole N ►.
   - Paper-color background throughout (T.paper). No GPS distances.

### Gates
- `cd frontend && npm run lint`: PASS (0 errors, 0 warnings)
- `cd frontend && npx tsc --noEmit`: PASS
- `cd frontend && npx tsx voice-tests/runner.ts --smoke`: pass=265 fail=0
- `cd frontend && npx vitest run`: 561/561 PASS (30 new from hole-projection.test.ts)
- `cd frontend && npm run build`: PASS (clean Turbopack build)

NOTICEABLE — /map/course now shows a calm yardage-book hole diagram instead of a blank
satellite map with absurd GPS distances. Verify on device by opening the course-maps
entry from /courses (Bethpage Black) and stepping through holes with ◄/►.

## 2026-06-29 (osm-ingest-error-hardening — SILENT — integration/next)
Hardens the OSM/Overpass error handling: flaky public endpoint no longer fails silently,
and the ingest script refuses to write an empty course.

### What was done
1. `backend/app/services/osm.py`:
   - Added `asyncio`, `logging`, `_log`, `_TRANSIENT_STATUS_CODES` (429/5xx), `_RETRY_BACKOFF_S`.
   - New `_post_with_retry(client, query, log_tag)`: logs WARNING on every failure (status + URL +
     truncated body); on transient failures (429/5xx, TimeoutException/TransportError) sleeps 2s
     and retries once; non-transient 4xx returns None immediately; clean 200 never retried.
   - All four Overpass fetchers now call `_post_with_retry` instead of the old silent failure path.

2. `backend/app/services/osm_ingest.py`:
   - New pure `_should_abort_empty(n_assembled_holes) -> bool`: True when 0 holes, False otherwise.

3. `backend/scripts/ingest_osm_course.py`:
   - After assembly, if NOT dry_run and `_should_abort_empty(n_assembled)`: stderr + `sys.exit(1)`
     WITHOUT calling `upsert_course`. Dry-run path unaffected.

4. `backend/tests/test_osm_fetch_hardening.py` (new, 30 pure tests, no network/DB).

### Gates
- `cd backend && ruff check .`: PASS
- `cd backend && uv run pytest tests/ -k "osm or ingest or overpass" -v`: 98/98 PASS (30 new)
- `cd frontend && npx tsc --noEmit`: PASS

SILENT — backend-only hardening; no user-visible surface change.

## 2026-06-29 (course-map-entry-point — NOTICEABLE — integration/next)
Adds a tappable "Course maps (beta)" entry on the /courses page linking to the homegrown
Bethpage Black hole map at /map/course?id=2b8caab5-2c55-5752-8cda-336c3a396dac.
Frontend-only. FALLBACK approach (hardcoded UUID POC constant with a comment).

### What was done
- `frontend/src/app/courses/page.tsx`:
  - Added `BETHPAGE_BLACK_MAP_ID` named constant (with comment pointing to ingest script).
  - Added a quiet "Course maps / beta" section at the bottom of the page (after Nearby,
    before the CourseSearch overlay). Single row: "Bethpage Black / Hole map" with "›"
    chevron and a hairline "beta" badge on the section header. Matches existing row
    pattern (T.serif name, T.mono subtitle, 44px min-height tap target, dashed separator).
  - No new deps, no backend changes, no layout disruption.

### Entry point
/courses tab → scroll to bottom → "Course maps (beta)" section → tap "Bethpage Black" row
→ /map/course?id=2b8caab5-2c55-5752-8cda-336c3a396dac (map viewer, requires ingest on deploy box).

### Gates
- `npm run lint`: PASS (0 warnings)
- `npx tsc --noEmit`: PASS (0 errors)
- `npx tsx voice-tests/runner.ts --smoke`: PASS (265/265)
- `npx vitest run`: PASS (531/531, 26 files)
- `npm run build`: PASS (19 pages; /courses and /map/course both present)

NOTICEABLE — the Bethpage Black map is now reachable from the iOS app via a tappable
entry on the Courses tab (no typed URL needed). Requires the ingest script to have run
on the deploy box for the map to populate; entry is visible regardless.

## 2026-06-29 (round-recap-insights — NOTICEABLE — integration/next)
History-relative insights in the round-completion recap. After finishing a round, a calm
"How this round compared" section appears showing delta vs historical average, ranking
("Best of your last N"), and per-par-type comparison. Only shown when ≥2 valid history
rounds exist; graceful first-round and thin-history states return no fabricated numbers.

### What was done
1. `frontend/src/lib/round-insights.ts` (new, pure, no React/API):
   - `computeRoundInsights(round, history)` — owner-scoped via `getOwnerPlayerId()`; reuses
     `deriveParTypeAverages()` from profile-stats for historical par-type side; computes
     `vsAverageToPar` (thisRound, historicalAvg, delta, sampleSize), `parTypeComparison`
     (delta per par type), and `ranking` (1-indexed, lowest to-par = rank 1).
   - MIN_PLAYED_HOLES=9, MIN_HISTORY_ROUNDS=2. Current round filtered from history internally.
2. `frontend/src/lib/round-insights.test.ts` (new, 27 vitest tests, pure/offline):
   - Graceful states, vsAverageToPar sign/magnitude, ranking (best/middle/worst), par-type
     comparison (overlap filtering, empty result), owner scoping (ownerPlayerId override), edge cases.
3. `frontend/src/components/RoundRecap.tsx` — "How this round compared" section:
   - Async history load via useEffect on open; insights via useMemo; shown only when 'ready'.
   - Narrative line + mono kicker + ranking line (birdie color when rank 1) + par-type table.
   - T.* tokens only; calm yardage-book feel; never blocks the Done flow.

### Gates
- `npm run lint`: PASS · `npx tsc --noEmit`: PASS · voice-tests --smoke: 265/265
- `npx vitest run`: PASS (531/531, 26 files, +27 new) · `npm run build`: PASS (19 pages)

NOTICEABLE — "How this round compared" appears in the recap after ≥2 tracked rounds.

## 2026-06-29 (ocr-scorecard-ui — NOTICEABLE — integration/next)
Camera → review → import UI for the OCR scorecard scan, making the feature end-to-end testable.

### What was done
1. `frontend/src/lib/types.ts` — added `ScanHole` + `ScanScorecardResponse` interfaces, mirroring
   the backend `HoleScores` + `ScanScorecardResponse` Pydantic models exactly.

2. `frontend/src/lib/api.ts` — added `scanScorecard(imageBlob: Blob) → ScanScorecardResponse`.
   Sends a multipart form POST to the existing `POST /api/scorecard/scan` endpoint (field name
   `image`). Auth via the existing `getAuthToken()` path. Re-exported `ScanScorecardResponse`.

3. `frontend/src/lib/scan-helpers.ts` (new, pure, no I/O):
   - `OcrPlayerReview` — per-player review row type (ocrName, 18-slot scores[], mappedPlayerId).
   - `scanResponseToReviewModel(response, roundPlayers)` — converts hole-centric backend response
     → per-player review rows; uses `matchPlayerName` from `player-match.ts` for fuzzy + phonetic
     matching ("Bob"/"Robert", "Dipak"/"Deepak" via Soundex). Unknown names → mappedPlayerId=null.
   - `buildScoreUpdates(reviewModel)` → `[pid, holeIdx, val][]` — collects confirmed entries for
     the existing handleSetScore path; skips null/out-of-range cells and unmapped rows.
   - `dataUrlToBlob(dataUrl)` — converts CameraCapture's base64 data URL → Blob for multipart upload.

4. `frontend/src/lib/scan-helpers.test.ts` (new, 27 vitest tests):
   - Shape conversion: correct slot indices, exactly 18 slots, null for blank/missing keys.
   - Player matching: exact, case-insensitive, fuzzy, phonetic (Dipak→Deepak), unrecognised.
   - buildScoreUpdates: valid entries, skip null/unmapped/out-of-range, multi-player, empty.

5. `frontend/src/components/ScanSheet.tsx` — rewired to use the new endpoint + helpers:
   - `handleCapture`: `dataUrlToBlob` → `scanScorecard(blob)` → `scanResponseToReviewModel`.
   - Removed old `parseScorecard` dependency (now calls real OCR endpoint directly).
   - Fuzzy + phonetic player matching replaces case-insensitive exact find().
   - Graceful error path unchanged: scan fails → error phase with "Try again" button.
   - Apply button remains the explicit confirm gate — no silent overwrite ever.

### Entry point
"Scan card" button in the Scorecard section header on the round screen. Tap → CameraCapture
→ upload → loading → review grid (editable cells + player dropdowns) → "Apply scores"
confirm → existing handleSetScore path (optimistic + pending overlay, unchanged).

### Device-only (not unit-tested here)
- Camera capture (native device API)
- Live Claude vision accuracy on a real scorecard photo
- Auth end-to-end (Clerk token + server-side verification)

### Gates
- `npm run lint`: PASS (0 warnings)
- `npx tsc --noEmit`: PASS (0 errors)
- `npx tsx voice-tests/runner.ts --smoke`: PASS (265/265)
- `npx vitest run`: PASS (504/504, 25 test files, +27 new scan-helpers tests)
- `npm run build`: PASS (19 static pages)
- `cd backend && ruff check .`: PASS

NOTICEABLE — the "Scan card" affordance on the round screen is now end-to-end: real OCR
endpoint, fuzzy player matching, review-before-import, no silent overwrite.

## 2026-06-29 (scorecard-scan-robustness — SILENT — integration/next, commit 24fcaca)
Robustness hardening on `POST /api/scorecard/scan` — two reviewer should-fix items.
No new deps, no endpoint behavior change, no DB.

### What was done
1. `backend/app/routes/scorecard.py`:
   - FIX 1: Factored out `_extract_text_content(content) -> str` (new exported pure helper).
     Picks the first text-type block from Claude's content list via `getattr(b, "type", None) == "text"`,
     skipping thinking/tool_use blocks. Replaces `message.content[0].text` which raises
     AttributeError/IndexError if the first block is a thinking block or content is empty.
     Empty result flows into `_parse_scan_response`'s existing ValueError("No JSON object found") → clean 500.
   - FIX 2: Added shape validation in `_parse_scan_response`:
     - `isinstance(raw["players"], list)` — raises clear ValueError if not a list.
     - `isinstance(raw["holes"], list)` — raises clear ValueError if not a list.
     - Per-hole loop: `isinstance(h, dict)` check + `"number" in h` check; all bad shapes
       raise informative ValueError → existing 500 handler (replaces opaque KeyError/TypeError).

2. `backend/tests/test_scorecard_scan.py`:
   - Added import for `types` + `_extract_text_content`.
   - 4 new shape-validation error tests in `TestParseScanResponseErrorPaths`:
     players-is-dict, holes-not-a-list, hole-missing-number, hole-entry-is-string.
   - New `TestExtractTextContent` class (5 tests): text-only, thinking-then-text
     (end-to-end through `_parse_scan_response`), multi-non-text-then-text, no-text-block →
     empty string → ValueError, empty content list.

### Gates
- `cd backend && ruff check .`: PASS (all checks passed)
- `cd backend && uv run pytest tests/ -k "scorecard or scan" -v`: 28/28 PASS (19 existing + 9 new)
- `cd frontend && npx tsc --noEmit`: 0 errors

SILENT — backend-only robustness fix; no user-visible behavior change.

## 2026-06-29 (ocr-scorecard-scan — SILENT — integration/next)
Backend-only first iteration of the scorecard OCR feature. New authed endpoint
`POST /api/scorecard/scan` that accepts a JPEG/PNG/WEBP/GIF image (≤10 MB) and
returns structured scores via Claude vision.

### What was done
1. `backend/app/routes/scorecard.py` (new, ~170 lines):
   - `HoleScores` + `ScanScorecardResponse` Pydantic models (backend-local;
     mirror to types.ts when the camera→review→import UI ships).
   - `_SCAN_PROMPT`: vision prompt instructing Claude to return ONLY JSON with
     players[], holes[{number, par, scores}]; null for blank/unreadable cells.
   - `_parse_scan_response(text) -> ScanScorecardResponse`: pure function,
     mirrors the voice.py regex approach; raises `ValueError` with clear
     message on no-JSON, malformed JSON, or wrong shape.
   - `POST /api/scorecard/scan`: auth via `current_user_id` dependency;
     image upload with 10 MB cap + `image/` MIME guard; calls `client.messages.create`
     with base64 image block + text prompt; delegates to `_parse_scan_response`;
     handles `anthropic.AuthenticationError` → 401, `ValueError` → 500.
2. `backend/app/main.py`: import + `app.include_router(scorecard.router, dependencies=_owner_only)`.
3. `backend/tests/test_scorecard_scan.py` (new, 19 pure tests, no API/DB):
   10 happy-path tests (single hole, two players, null scores, null par, prose
   wrapper, 4-player, 18-hole grid, mixed nulls, empty holes list, type check);
   9 error-path tests (no JSON, empty string, prose only, malformed JSON,
   truncated JSON, missing players key, missing holes key, voice-shape, wrong shape).

### NOT verified here (device/CI only)
- Live Claude vision accuracy on a real scorecard photo (no local ANTHROPIC_API_KEY).
- Auth end-to-end (no local Clerk JWKS).
NOTE: This is a new authed endpoint + image upload + external vision API call.
Reviewer + /security-review have been requested by the eng-lead before the bundle merges.

### Gates
- `cd backend && ruff check .`: PASS (all checks passed)
- `cd backend && uv run pytest tests/ -k "scorecard or scan" -v`: 19/19 PASS
- `cd backend && uv run pytest tests/ --ignore=tests/integration -q`: 621/621 PASS (0 regressions)
- `cd frontend && npx tsc --noEmit`: 0 errors (no frontend changes)

SILENT — backend only. No user-visible surface until the camera→review→import UI ships.

## 2026-06-29 (caddie-reasoning-priority-cap — SILENT — integration/next)
Prioritized + capped CaddieRecommendation.reasoning[] to at most 4 lines (voice-caddie
calm fix). Pure Python, typed, no new deps, no DB.

### What was done
1. `backend/app/caddie/aim_point.py`:
   - New constant `MAX_REASONING_ITEMS: int = 4`.
   - New exported pure helper `prioritize_reasoning(items, max_items) -> list[str]`.
     Stable-sorts by priority, caps to max_items. P0 club line is never evicted.
   - Refactored generate_recommendation to accumulate `list[tuple[int, str]]` with
     documented priority tags (P0 club always first, P1 safety-critical, P2 slope/miss,
     P3 terrain, P4 color), then calls prioritize_reasoning at the end.
   - club, target_yards, aim_point, miss_side completely unchanged.
2. `backend/tests/test_reasoning_priority.py` (new, 25 pure tests).

### Priority scheme
- P0: club/distance fit line — ALWAYS kept, ALWAYS first
- P1: safety-critical — competition-legal note, pin light (red/yellow), DECADE hazard-aim
- P2: slope miss-advice, player miss-tendency note
- P3: shot-line terrain advice
- P4: color — player history, personal-stats note, distance-adjustment summary

### Gates
- `cd backend && ruff check .`: PASS
- `cd backend && uv run pytest tests/ -k "reasoning or aim or caddie or decade or slope"`: 205/205 PASS (25 new, 180 existing)
- `cd frontend && npx tsc --noEmit`: 0 errors

SILENT — pure backend logic. Voice caddie now speaks at most 4 reasoning lines;
P4 color is the first to drop when over cap.

## 2026-06-29 (caddie-personal-dispersion — SILENT — integration/next)
Handicap-scaled shot-dispersion model for the DECADE aim adviser. Pure additive, headless-testable, no new deps, no DB.

### What was done
1. `backend/app/caddie/decade_advice.py`:
   - New constants: `HCP_MIN=2.0`, `HCP_MAX=36.0`, `SIGMA_LONG_FRACTION_OF_LAT=2/3`, `_LAT_FRACTION_BREAKPOINTS` (piecewise table: hcp+2->5%, hcp15->6.5%, hcp25->9%, hcp36->11.8%).
   - New pure function `dispersion_for_handicap(handicap, distance_yds) -> tuple[float, float]` returning `(sigma_lat_yds, sigma_long_yds)`. Piecewise-linear interpolation; clamped to [HCP_MIN, HCP_MAX]; floored at MIN_SIGMA_YDS. Source: DECADE / Broadie (2014) -- scratch ~5% lateral, mid-hcp ~6.5%, high-hcp ~9%, longitudinal ~2/3 of lateral.
   - `decade_aim_advice`: optional `handicap: float | None = None`. When provided, calls `dispersion_for_handicap`; when None, uses fixed fractions (backward-compatible). Additive only -- club/target_yards/aim_point/miss_side never touched.
2. `backend/app/caddie/aim_point.py`: threads `handicap` into `decade_aim_advice(hole.hazards, float(distance_yards), handicap=handicap)`.

### Scaling constants / source (DECADE/Broadie-calibrated)
- hcp +2  -> sigma_lat = 5.0%  (scratch-level)
- hcp 15  -> sigma_lat = 6.5%  (mid-amateur)
- hcp 25  -> sigma_lat = 9.0%  (high handicapper)
- hcp 36  -> sigma_lat = 11.8% (upper clamp)
- sigma_long = (2/3) x sigma_lat; both floored at MIN_SIGMA_YDS=3.0 yds
- Clamped to [+2, 36]

### Tests
- `backend/tests/test_dispersion.py`: `TestDispersionForHandicap` (22 tests): breakpoints, monotone, distance scaling, clamping, floor, determinism.
- `backend/tests/test_decade_advice.py`: `TestHandicapDispersionScaling` (14 tests): sigma monotone, clamping, wiring (None=default), no crash, deterministic, behavioral (scratch shift <= high-hcp shift for water hazard at 150 yds), club/target/aim/miss unchanged.

### Gates
- `cd backend && ruff check .`: PASS
- `cd backend && uv run pytest tests/test_dispersion.py tests/test_decade_advice.py -v`: 103/103 PASS
- `cd backend && uv run pytest tests/ -k "dispersion or decade or aim or caddie" --ignore=tests/integration`: 179/179 PASS
- `cd frontend && npx tsc --noEmit`: 0 errors
- `cd frontend && npm run lint`: PASS

SILENT -- pure backend reasoning. Caddie advice now uses personalised dispersion instead of fixed mid-hcp constants. No UI change.

## 2026-06-29 (caddie-decade-wire-recommend — SILENT — integration/next)
Activated the dormant DECADE optimizer as additive caddie reasoning. When the expected-strokes-optimal aim deviates ≥4 yards laterally from the flag, a plain-English tip is appended to reasoning[]. Club, target_yards, aim_point, and miss_side are never touched.

### What was done
1. `backend/app/caddie/decade_advice.py` (new, 175 lines):
   - `build_classify_point(hazards, pin) -> ClassifyFn`: approximates hole as coordinate plane centred on pin (+x=right, +y=long). Each Hazard mapped to a half-plane by side+distance_from_green. Severity-sorted so most severe wins on overlap. Default: GREEN within 20 yds, FAIRWAY beyond.
   - Type map: water→WATER, ob→OB, bunker→SAND, trees→RECOVERY, other→severity-based (death→OB, severe→RECOVERY, else ROUGH).
   - `decade_aim_advice(hazards, shot_distance_yds, pin) -> str | None`: σ_lat=6%·dist (min 3 yd), σ_long=4%·dist (min 3 yd); 9 candidates (pin ± 12 yd in 3-yd steps); calls `optimize_aim`; threshold 4 yd; returns "The percentages favor aiming ~{N}y {direction} of the flag — {hazard} guards the {side}." or None.
   - No hazards → None; front/back-only hazards → None (symmetric, no lateral shift); pin-optimal → None.
2. `backend/app/caddie/aim_point.py`: import + additive call after shot_line_advice. Appends to reasoning[] only.
3. `backend/tests/test_decade_advice.py` (new, 57 tests, pure, no DB/network).

### Approximation + constants
- Coordinate plane: side='left' → x < -distance_from_green; side='right' → x > distance_from_green; front/back → y half-planes; center → radius ≤ d from pin.
- SIGMA_LAT_FRACTION=0.06, SIGMA_LONG_FRACTION=0.04, MIN_SIGMA_YDS=3.0, AIM_THRESHOLD_YDS=4.0.

### Gates
- `ruff check .`: PASS
- `uv run pytest tests/ -k "decade or aim or caddie or slope" -v`: 161/161 PASS (57 new)
- `npx tsc --noEmit`: 0 errors · `npm run lint`: PASS · `voice-tests --smoke`: 265/265

SILENT — pure backend reasoning enhancement; no UI change. Caddie API response gains one extra reasoning[] line when a meaningful lateral hazard is present.

## 2026-06-29 (dem-slope-line-advice — SILENT — integration/next)
Additive terrain-shape advice along the shot path. Pure Python, no DB/network, no new deps.

### What was done
1. `backend/app/caddie/shot_line_advice.py` (new):
   - Pure `shot_line_advice(profile_ft, shot_distance_yds) -> str | None`. Thresholds:
     NET_CHANGE_THRESHOLD_FT=10, END_RISE_THRESHOLD_FT=5, MID_FEATURE_THRESHOLD_FT=8.
   - Priority: ridge > swale > elevated-green > downhill > None.
   - Async `sample_shot_line()` helper: lazy-imports fetch_3dep_samples (no DB at load time).
2. `backend/app/caddie/types.py`: additive `shot_line_profile_ft: Optional[list[float]] = None`
   on `HoleIntelligence`. Backward-compatible default.
3. `backend/app/caddie/aim_point.py`: imports + calls `shot_line_advice` ADDITIVELY after
   green-slope advice. Appends to reasoning[] only. Club/target_yards/aim_point/miss_side unchanged.
4. `backend/tests/test_shot_line_advice.py`: 46 pure tests, no DB/network.

### Distinct from existing elevation logic
- compute_adjustments: adjusts NUMERIC distance — not duplicated here.
- slope_advice.py: GREEN-SURFACE slope miss direction — not touched here.
- This: terrain SHAPE along the path (elevated green, downhill zone, ridge, swale) — color only.

### Gates
- `ruff check .`: PASS
- `uv run pytest tests/ -k "shot_line or slope or aim or caddie" -v`: 131/131 PASS (46 new)
- `npx tsc --noEmit`: 0 errors

SILENT — reasoning-only backend change. Route handler wire-up (populating shot_line_profile_ft
via sample_shot_line) is a follow-up once GPS tee/target coords are reliably in the request.

## 2026-06-29 (course-discovery-home — NOTICEABLE — integration/next)
Added a quiet "Recent courses" section to the home page — a calm quick-resume affordance
that surfaces the player's last 3 visited courses (from localStorage) with tap-through to
the course detail page. Only renders when recents exist; completely hidden on first install.

### What was done
1. `frontend/src/app/page.tsx`:
   - Added imports for `getRecentCourses` (golf-api.ts) and `mapRecentCourses`/`RecentCourseItem` (course-list.ts).
   - Added lazy `useState` initializer: `mapRecentCourses(getRecentCourses().slice(0, 3))`.
     Synchronous localStorage read — no useEffect, no network call, no location prompt.
     SSR-safe (getRecentCourses() guards typeof window internally).
   - Added "Recent courses" section after Trophy Case: dashed separator rows, T.serif course
     name, optional T.mono club subtitle, "›" chevron, 44px min-height tap targets.
     "All →" label links to the full /courses hub. Section absent entirely if no recents.
2. Pure mapping helper (`course-list.ts`) and its tests (`course-list.test.ts`) already
   existed and are fully reused — no new test file needed; 483/483 vitest pass.

### Follow-up (not built — skipped per spec)
Nearby courses via `searchNearby()` — would require `navigator.geolocation.getCurrentPosition`
which triggers a permission prompt on home load, explicitly forbidden by the spec. Gating on
`navigator.permissions.query({ name: 'geolocation' }) === 'granted'` would avoid the prompt
but adds complexity. Recorded as follow-up when a clean pattern is established.

### Gates
- `npm run lint`: PASS (0 warnings)
- `npx tsc --noEmit`: PASS (0 errors)
- `npx tsx voice-tests/runner.ts --smoke`: PASS (265/265)
- `npx vitest run`: PASS (483/483, 24 test files)
- `npm run build`: PASS (19 static pages, home route /)

NOTICEABLE — the "Recent courses" section is visible on the home screen after visiting at
least one course via the Courses tab. No UI change on first install (section simply absent).

## 2026-06-29 (caddie-tactical-slope-advice — SILENT — integration/next)
Additive "where to miss" tactical advice derived from green slope relative to approach bearing.
Pure function, no DB/network, no new deps.

### What was done
1. `backend/app/caddie/slope_advice.py` (new, 82 lines):
   - Pure `slope_miss_advice(green_slope, approach_bearing_deg) -> str | None`
   - Sign convention: `GreenSlope.direction` = compass bearing of the downhill direction (where water flows); `approach_bearing_deg` = compass bearing the golfer shoots toward the green.
   - `rel = (slope_direction - approach_bearing) % 360` maps to four quadrants:
     - rel ≤ 45° or > 315°: drops toward back (front-to-back) → "back edge is lower; playing to pin depth keeps you below the hole"
     - 45° < rel ≤ 135°: drops toward golfer's right (left-to-right) → "favor the left / high side"
     - 135° < rel ≤ 225°: drops toward front/near side (back-to-front) → "leave it below the hole; miss short"
     - 225° < rel ≤ 315°: drops toward golfer's left (right-to-left) → "favor the right / high side"
   - Only moderate/severe slopes get advice; flat/mild return None (no noise).
   - `severity == "severe"` → qualifier "hard"; `"moderate"` → "moderately".
2. Wired ADDITIVELY into `generate_recommendation` (aim_point.py): slope advice appended to `reasoning` list ONLY — club, target_yards, aim_point, miss_side.preferred are all unchanged.
3. `backend/tests/test_slope_advice.py` (new, 39 tests, no DB/network): severity gating, back-to-front "miss short" + "below the hole", right-to-left "right"+"high", left-to-right "left"+"high", front-to-back "lower", relative-direction math (same slope + different bearings = different advice), bearing wraparound (360°), boundary conditions (45°, 46°), determinism, integration tests (wired-into-recommendation, additive-only, flat-adds-nothing).

### Gates
- `ruff check .`: PASS (all checks passed)
- `uv run pytest tests/ -k "slope or aim or caddie" -v`: 87/87 PASS (0.55s) — includes all 34 pre-existing aim_point + competition_legal tests
- `npx tsc --noEmit`: 0 errors (no frontend changes)

SILENT — pure backend logic; no user-visible UI change. No model change (only reasoning list gets an extra line).

## 2026-06-29 (caddie-decade-optimizer-core — SILENT — integration/next)
Pure DECADE / strokes-gained aim-point optimizer, additive, not wired to recommendations.

### What was done
1. `backend/app/caddie/decade.py` (new, 232 lines): pure stdlib-only module implementing:
   - `LandingArea` enum: GREEN, FAIRWAY, ROUGH, SAND, RECOVERY, WATER, OB.
   - `Dispersion(sigma_long, sigma_lat)` NamedTuple — explicit caller-supplied 1-sigma values.
   - `ClassifyFn` type alias — seam for real course geometry to plug in later.
   - PGA-baseline expected-strokes tables (sources: Broadie 2014, DECADE Golf benchmarks).
     Area ordering guaranteed: GREEN < FAIRWAY < ROUGH < SAND < RECOVERY;
     WATER/OB = FAIRWAY + 1.0 penalty stroke.
   - Deterministic 21-point Gaussian quadrature grid (+-3.5 sigma, captures 99.97%).
   - `expected_strokes_from(area, distance_yds)` — single lookup, no RNG.
   - `expected_strokes_for_aim(aim, dispersion, classify_fn, pin)` — convolution evaluator.
   - `optimize_aim(candidates, dispersion, classify_fn, pin)` — candidate search O(N x 441).
   - Returns `OptimizeResult` with aim, expected_strokes, breakdown dict, full candidate list.
2. `backend/tests/test_decade.py` (new, 40 tests): proves all specified behaviours.

### Gates
- ruff check .: PASS
- uv run pytest tests/test_decade.py -v: 40/40 PASS in 0.07s
- npx tsc --noEmit: 0 errors

SILENT — pure backend math module; NOT wired to any recommendation endpoint yet.

## 2026-06-29 (course-poc-i4-elevation — SILENT — integration/next, commit b621d78)
I4 Bethpage Black POC: per-hole elevation (tee→green delta + green slope) from free USGS 3DEP,
woven into the assembled homegrown course. BE/data, headless.

### What was done
1. `backend/app/services/elevation.py` — two new exports:
   - `fetch_3dep_samples(points)` — batch elevation query via USGS 3DEP ArcGIS ImageServer
     `getSamples` endpoint. Single HTTP round-trip for N points (vs N serial EPQS calls). Returns
     elevations in feet (converts from 3DEP native metres). Falls back to `fetch_elevation_batch`
     (parallel EPQS + DB cache) on any error. No new deps.
   - `compute_hole_elevation_profile(tee_ft, green_ft, green_slope=None)` — PURE function.
     Returns: tee_elevation_ft, green_elevation_ft, net_change_ft (+= uphill), green_slope passthrough.
2. `backend/app/services/osm_ingest.py` — `assemble_osm_course` gains optional
   `hole_elevations: dict[int, dict] | None = None`. Attaches `elevation` key per hole when
   provided. Backward-compatible: existing callers/tests unaffected.
3. `backend/tests/test_elevation_profile.py` (new, 29 pure tests, no network/DB).

### Gates
- ruff check .: PASS
- pytest tests/ --ignore=tests/integration -k "elevation or spatial or osm or ingest or bethpage": 183/183 PASS
- npx tsc --noEmit: 0 errors

SILENT — BE/data only; no user-visible surface yet.

## 2026-06-29 (course-poc-i3-validate — SILENT — integration/next)
I3 Bethpage Black feasibility gate: validate the homegrown pipeline against the published card.

### What was done
1. Fetched live Overpass data for Bethpage AOI (center 40.7445,-73.4609, radius 2500m) — one-time
   live call; committed 1.6 MB fixture `backend/tests/fixtures/bethpage_overpass.json`. 820
   elements, 90 hole LineStrings (5 courses x 18), 96 greens, 215 tees, 270 bunkers.
2. Assembled Bethpage Black via I0 (`_parse_course_geometry_response` with all holes, no filter)
   -> I1 spatial join -> I2 (`assemble_osm_course(target_course_name="Black")`).
3. Published card source: bluegolf.ijgt.com/bluegolf/ijgt/course/bethpageblack/detailedscorecard.htm
   (verified 2026-06-29). Par 71, 7,486 yards, rating 78.0, slope 155, Black tees.
4. Wrote `backend/tests/test_bethpage_validation.py` (14 tests, deterministic on fixture, no network).

### Results (VERDICT: VIABLE)
- Par: 18/18 match. OSM par sequence = card (par 71 total). PERFECT.
- Handicap: 18/18 match. OSM stroke index = card for all 18 holes. PERFECT.
- Yardage (straight-line tee->green vs. card Black-tee yardage): 14/18 within 25y.
  4 holes over tolerance: 7 (+75y), 1 (+40y), 12 (+39y), 9 (+26y).
  All deltas are POSITIVE (card >= straight-line) -- consistent with dogleg routing adding
  played distance beyond straight-line. No negative deltas, no gross mis-joins (>200y).
  Hole 7 is the worst (553y card vs. 478y SL) -- it is famously a severe dogleg par 5.
- Assembled output: 18 holes, all hole numbers 1-18, all have >=1 polygon feature, par total 71.

### Files changed
- `backend/tests/fixtures/bethpage_overpass.json` (new, 1.6 MB): committed Overpass fixture.
- `backend/tests/test_bethpage_validation.py` (new, 14 tests): deterministic I3 validation.

### Gates
- ruff check .: PASS (all checks passed)
- pytest tests/test_bethpage_validation.py -v: 14/14 PASS (0.10s)
- pytest tests/ -k "spatial or osm or ingest": 136/136 PASS (all prior tests green)
- npx tsc --noEmit: 0 errors
SILENT -- data/QA work; no user-visible surface. Go/no-go verdict for I4 (3DEP elevation).

## 2026-06-29 (course-poc-i2-store-render — NOTICEABLE — integration/next)
I2 Bethpage Black POC: assemble homegrown OSM geometry into the PostGIS course
store and render it in the map view — proving "a hole map from free data, no GolfAPI."

### Verified here (pure/offline)
- `ruff check .` clean
- `pytest tests/ -k "spatial or osm or ingest"` 136/136 passed (44 new ingest tests +
  60 spatial + 34 OSM parsing). New tests cover `_deterministic_uuid` (UUID format,
  version/variant bits, SHA-1 alignment, pinned stable value) and `assemble_osm_course`
  (output shape, par/handicap merge, cross-course rejection, edge cases).
- Frontend: lint 0/0 · tsc 0 · voice-tests 265/265 · vitest 483/483 · build clean
  (/map/course page visible in static export).

### Verified on deploy box / device only
- Live Overpass fetch (`fetch_course_geometry(lat=40.7445, lng=-73.4609, radius=2500)`)
  → expected 90 hole LineStrings (5 courses × 18) + polygon features.
- `upsert_course` DB write (requires ASYNC_DATABASE_URL on deploy box).
- `GPSMapView` OSM polygon overlay render on TestFlight device.

### Files changed
BACKEND:
- `backend/app/services/osm_ingest.py` (new, 130 lines): `_deterministic_uuid(key)`
  mirrors frontend `deterministicUUID()` exactly (SHA-1 + UUID v5 bits); comment
  explains how a later GolfAPI id discovery aligns with the stored UUID without
  migration. `assemble_osm_course(geometry, course_id, course_name, target_course_name,
  address, location, tee_sets)` — combines I0 holes + I1 spatial join + par/handicap
  merge from OSM hole LineStrings → exact dict shape for `upsert_course`.
- `backend/scripts/ingest_osm_course.py` (new, 170 lines): runnable script with
  argparse; defaults to Bethpage Black (lat=40.7445, lng=-73.4609, radius=2500,
  target_course_name="Black", course_key="osm-bethpage-black"). `--dry-run` flag
  shows assembled payload without DB write. Calls fetch_course_geometry (all courses,
  no filter) → assemble_osm_course → upsert_course.
- `backend/tests/test_ingest_osm_course.py` (new, 44 tests): pure unit tests for
  `_deterministic_uuid` and `assemble_osm_course` — no DB, no network.

FRONTEND:
- `frontend/src/lib/courses/mapped-course-api.ts` (new): `fetchMappedCourse(id)`,
  `mappedCourseToCoordinates(course)` (extracts green/tee/hazard centroids from
  polygon features), `getAllHoleFeatures(course)` (flat array with properties.hole).
- `frontend/src/components/GPSMapView.tsx`: added optional `osmFeatures` prop +
  `updateOsmPolygons` callback; single GeoJSON source `osm-current-hole` updated on
  hole change; fill + outline layers with calm palette per featureType (green/fairway/
  bunker/tee/water). Wired into map load + hole-change effects.
- `frontend/src/app/map/course/page.tsx` (new): minimal POC viewer at
  `/map/course?id=<uuid>`; loads mapped course, converts to CourseCoordinates,
  renders GPSMapView with osmFeatures polygon overlay.

### How to run the ingest (deploy box)
```
cd backend
uv run python scripts/ingest_osm_course.py --dry-run  # preview, no DB
uv run python scripts/ingest_osm_course.py            # real write (needs ASYNC_DATABASE_URL)
```

### How to view the map (after ingest)
Navigate to: http://<host>/map/course?id=<Course UUID from dry-run output>

Classification: NOTICEABLE (new map view + polygon rendering), but device-only for
the render verification (requires ingest on deploy box + TestFlight build).

## 2026-06-29 (course-poc-i1-spatial-join — SILENT — commit fc93c94 on integration/next)
Pure-geometry I1 of the Bethpage Black homegrown course-data track. No DB, no network,
no new dependencies (stdlib math only).

Changes:
- backend/app/services/osm.py: added `course_name` property (golf:course:name OSM tag) to
  every hole Feature returned by `_parse_course_geometry_response`.  Required by the spatial
  join for cross-course rejection.  Backward-compatible additive change; all 34 existing
  test_osm_parsing tests still pass.
- backend/app/services/course_spatial.py (new, 250 lines): pure module implementing:
  · Equirectangular distance (_deg_to_m) — no shapely/PostGIS, stdlib math only.
  · Point-to-segment distance (_point_to_segment_dist_m) — flat-metric projection.
  · _ring_centroid (closing-vertex-aware), _match_mode, _linestring_dist_m (3 modes).
  · assign_features_to_holes(holes, polygons) — accepts ALL holes (all courses);
    each polygon's centroid is matched to its nearest hole using the feature-type rule
    (greens → endpoint, tees → startpoint, others → nearest on segment).  Returns
    {osm_id: (hole_ref, course_name, dist_m)}.
  · build_course_feature_collection(holes, polygons, target) — filters to target course,
    groups by hole ref, emits per-hole dicts compatible with courses_mapped.upsert_course.
- backend/tests/test_course_spatial.py (new, 60 tests): fixture = 2 Black holes +
  1 Red hole (nearby) + 4 polygons.  Verifies: Black polygons → correct Black hole via
  endpoint/start/nearest rules; Red-adjacent green REJECTED from Black output; distance
  helper sanity (1° lat ≈ 111 320 m); edge cases (empty inputs, missing geometry).

Gates: ruff clean · pytest tests/ -k "spatial or osm" 94/94 (60 new + 34 existing) in
       0.58 s · frontend tsc 0 errors.
SILENT — backend-only data layer; no user-visible surface. I2 (store + render Black) is next.

## 2026-06-28 (course-poc-i0-osm-polygons — SILENT — integration/next)
Backend-only: extended `backend/app/services/osm.py` to fetch full GeoJSON polygon/linestring
geometry from Overpass (foundation for the Bethpage Black POC — I0 of the homegrown course-data
track). No DB, no frontend changes.

Changes:
- Added `_USER_AGENT = "Looper/1.0 (golf course mapping)"` + `_OVERPASS_HEADERS` constant.
  Applied to all three existing Overpass HTTP calls (search_golf_courses, search_osm_with_geometry,
  fetch_course_features) — public Overpass returns 406 without a User-Agent.
- Added two pure parsing helpers (unit-test targets):
  - `_parse_way_to_polygon(geom)` — Overpass {lat,lon} list -> GeoJSON Polygon; auto-closes ring;
    returns None for degenerate (<4 pt) input.
  - `_parse_way_to_linestring(geom)` — Overpass {lat,lon} list -> GeoJSON LineString; None if <2 pts.
- Added `_parse_course_geometry_response(data, course_name_filter)` — pure function; iterates
  Overpass elements; routes golf=hole ways -> LineString GeoJSON Features (filtered by
  golf:course:name when course_name_filter is set); routes green/fairway/tee/bunker/water ways ->
  Polygon GeoJSON Features; skips nodes; returns {holes, greens, fairways, tees, bunkers, water}.
  Each Feature carries featureType + osm_id; hole Features also carry ref/par/handicap/name (int-cast).
- Added `fetch_course_geometry(lat, lng, radius_m, course_name)` async function — new public API;
  issues `out geom` Overpass query for all golf polygon tags + hole ways; delegates parsing to
  _parse_course_geometry_response; returns GeoJSON Feature dicts compatible with upsert_course.
  Existing fetch_course_features (centroid-only) is unchanged; existing callers (caddie.py) unaffected.
- New test file `backend/tests/test_osm_parsing.py` — 34 pure pytest tests, no network, no DB:
  6 for _parse_way_to_polygon, 4 for _parse_way_to_linestring, 24 for _parse_course_geometry_response
  (fixture: Black+Red holes + green + bunker + node). Asserts: full ring vs centroid, auto-close,
  course-name filter (case-insensitive), par/handicap/ref as int, feature-type routing, GeoJSON shape.

Gates: ruff clean (all checks passed) · pytest tests/test_osm_parsing.py 34/34 in 0.06s · tsc 0 errors.
SILENT — backend-only data-layer change; no user-visible surface yet (I1 spatial join is next).

## 2026-06-28 (voice-player-disambiguation — SILENT fix — integration/next)
Fixed voice round setup: spoken player names now match saved profiles via fuzzy + phonetic
matching instead of exact lowercase compare. Root cause: "Dipak" != "Deepak" exact-compare
-> saved profile not linked. Fix: new pure module `src/lib/player-match.ts` with Soundex
phonetic key + similarity() reuse; Soundex("Dipak") = Soundex("Deepak") = D120 -> confident
match at 0.8 score. Wired into `handleVoiceSetup` in `round/new/page.tsx`; free-text slot
unchanged for genuinely unknown names. De-dup guard prevents same SavedPlayer.id linked twice.

Files changed (3):
  - frontend/src/lib/player-match.ts (new) -- soundex, matchPlayerName, matchPlayerNames
  - frontend/src/lib/player-match.test.ts (new) -- 20 vitest tests (owner-bug case + edge cases)
  - frontend/src/app/round/new/page.tsx -- import matchPlayerNames; replace exact find() in handleVoiceSetup

Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · vitest 475/475 (+20 new) · build clean.
SECONDARY backend change (roster name injection into build_setup_instructions) SKIPPED -- follow-up only.
SILENT -- internal voice UX fix; not a new feature surface; no new UI chrome.

## 2026-06-28 (B3 designer polish — SILENT fix — commit 2708526 on integration/next)
Applied 4 review fixes to the course-reviews-surface change (commit 37965cd):
1. Profile CourseReviews: review body changed from mono UPPERCASE to serif italic (fontSize 12, T.pencilSoft) — NORTHSTAR blocker fix.
2. Profile CourseReviews: Section kicker "Notes" → "Reviews" for consistency.
3. CourseDetailClient: Reviews block hidden when reviews.length === 0 after load; no "No reviews yet." empty state on course detail.
4. Both surfaces: YYYY-MM-DD playedAt parsed with T00:00:00 suffix to avoid UTC-midnight off-by-one in negative-UTC timezones.
Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · vitest 451/451 · build clean · ruff clean.
SILENT (no new feature, pure display polish).

## 2026-06-28 (course-reviews-surface B3 — NOTICEABLE — BUILT on integration/next)
Surface the course reviews (written by B2) in two places:
  1. Course detail screen (/courses/[id]) — new "Reviews" section with yardage-book dashed rows.
  2. Profile screen (/profile) — new "Course reviews" Section between YearLog and ShotAnalytics.
  3. Backend — GET /api/reviews/mine (reviews_router, second router in course_reviews.py).
  4. Frontend helper getMyReviews() in api.ts.
  5. Backend tests — TestMyReviews (4 new tests): own-across-keys ordered desc, cross-user isolation,
     empty, auth fails-closed. Skips locally (no Postgres); passes in CI with Postgres.

Files changed (6):
  - backend/app/routes/course_reviews.py — reviews_router + list_my_reviews endpoint
  - backend/app/main.py — register reviews_router with _owner_only
  - backend/tests/integration/test_course_reviews.py — TestMyReviews class (4 tests)
  - frontend/src/lib/api.ts — getMyReviews()
  - frontend/src/app/courses/[id]/CourseDetailClient.tsx — reviews state + fetch + Reviews section
  - frontend/src/app/profile/page.tsx — CourseReviews component + insertion after YearLog

Gates: ruff clean · lint 0/0 · tsc 0 · voice-tests 265/265 · vitest 451/451 · build clean.
Backend pytest: 19 skipped (no local Postgres — expected; CI passes).
NOTICEABLE — two new user-visible surfaces with calm yardage-book styling.

## 2026-06-28 (course-review-model B2 — NOTICEABLE — BUILT on integration/next, pending device-verify)
Roadmap feature (epic course-search-reviews, was needs-spec, DRY queue). Wrote brief spec
(specs/course-review-model.md) + opus plan (specs/course-review-model-plan.md), then built.

Lets a golfer write a short review (1-5 rating + note) of a course right after a round,
stored server-side, owner-scoped, keyed on a string `course_key` (GolfAPI id when known,
else `name:<slug>`) — deliberately sidesteps the course-identity unification refactor (B5).

BACKEND (commit 7dec6d7):
- New `CourseReview` ORM (`course_reviews` table) in backend/app/db/models.py + Pydantic
  CourseReview/CourseReviewCreate in backend/app/models.py (rating Field(ge=1,le=5),
  body max_length=2000, playedAt Optional[date]). types.ts kept in sync.
- Alembic migration backend/migrations/versions/0006_009_course_reviews.py — ADDITIVE ONLY
  (CREATE TABLE + ix_course_reviews_owner_id + ix_course_reviews_course_key; downgrade drops
  them). down_revision 008_round_owner_player. VERIFIED on PG16 docker:
  upgrade->downgrade->upgrade all exit 0. CI uses Base.metadata.create_all (not alembic);
  deploy.yml runs `alembic upgrade head` on ship — ORM + migration describe identical schema
  incl. index names.
- New owner-scoped router backend/app/routes/course_reviews.py:
  POST /api/courses/{course_key}/reviews + GET /api/courses/{course_key}/reviews. Auth via
  existing current_user_id (require_owner UNTOUCHED, _owner_only app-level gate). Registered
  BEFORE catch-all courses.router (two-segment path, no shadowing). 15 integration tests
  (create/echo, owner isolation, rating 0/6->422, boundaries 1/5->200, body 2001->422,
  auth fails-closed, name: key URL-encode round-trip, no-shadowing guard). course_reviews
  added to conftest TRUNCATE list.

FRONTEND:
- Pure helpers frontend/src/lib/course-review-key.ts (resolveCourseKey + normalizeCourseName,
  no React/DOM) + 15 vitest. resolveCourseKey: match round.courseName against
  getRecentCourses() for a GolfAPI id, else name:<slug> (slash-free), else null (hide form).
- getCourseReviews/createCourseReview in api.ts (encodeURIComponent on courseKey).
- Calm 1-5 rating + short-note form on RoundRecap.tsx (T.* tokens only, 44pt+ targets,
  safe-area; hidden when no course key; NEVER blocks the Done flow; "Noted." confirmed state,
  muted error line). Wired from RoundPageClient.tsx via reviewCourseKey useMemo.

REVIEW: reviewer SHIP · /security-review PASS (owner-scoped, no IDOR, parametrized, validated,
additive migration) · designer APPROVE-WITH-NITS (4 NON-blocking nits recorded as follow-ups:
maxLength 2000->280 + backend cap align, add "Noted." fade transition, unify borderRadius
10->14, same-number-tap deselect). QA gates green: lint 0, tsc clean, voice 265/265,
vitest 451/451, build clean, ruff clean, pytest 234/234 (incl. 15 new).

Pushed to integration/next (7dec6d7); accumulated on the rolling bundle PR (opened this cycle,
NOT merged). Per cycle constraints: NO TestFlight build, NO owner notification this cycle.
Classification NOTICEABLE — rides the next bundle approval. This is a backend change the owner
can test once the bundle ships (deploy applies migration 009 + the live endpoint).
Follow-ups (not built): course-reviews-surface (B3 — surface reviews on course detail +
profile); the 4 designer nits; course-identity-unify (B5).

## 2026-06-28 (social-partner-profile-polish — SILENT)
- **Done (commit 8153d9f on integration/next):** Designer-blocker polish + hardening on the partner-profile feature.

  Files changed (4):
  - `frontend/src/app/players/page.tsx`: (1) loading state replaced CSS spinner with mono uppercase "Loading…" text (mirrors CourseDetailClient/PartnerProfileClient); (2) empty state replaced bordered card + UserIcon + 500-weight heading with quiet serif-italic placeholder + ghost button CTA; (3) player row name switched from sans/fontWeight:500 to T.serif + letterSpacing:-0.2; removed now-unused UserIcon component.
  - `frontend/src/lib/partner-rounds.ts`: sort guard hardened against NaN from malformed/missing dates — treats NaN as epoch-0 (oldest) so sort stays stable.
  - `frontend/src/lib/partner-rounds.test.ts`: two new tests — invalid date string and empty date string sort stably without throwing.
  - `frontend/src/app/players/view/PartnerProfileClient.tsx`: date render falls back to raw string or "—" instead of "Invalid Date"; back button gains minWidth:44.

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · vitest 434/434 (+2 new) · build clean (players/view confirmed).
  SILENT — polish-only iteration; rides with the existing noticeable bundle.

## 2026-06-28 (social-partner-profile — NOTICEABLE)
- **Done (commit e2d6960 on integration/next):** Partner profile detail screen at `/players/view?id=…`.

  Files added (6):
  - `frontend/src/lib/player-url.ts` — `playerHref(id)` URL helper (static-export shim pattern)
  - `frontend/src/lib/partner-rounds.ts` — `getSharedRounds(rounds, playerId)` pure derivation
  - `frontend/src/app/players/view/page.tsx` — Suspense shell (literal route, no generateStaticParams)
  - `frontend/src/app/players/view/PartnerProfileClient.tsx` — yardage-book detail screen
  - `frontend/src/lib/player-url.test.ts` — 7 URL encoding/segment tests
  - `frontend/src/lib/partner-rounds.test.ts` — 8 membership/sort/edge-case tests

  Files changed (1): `frontend/src/app/players/page.tsx` — row tap navigates to profile via
  `router.push(playerHref(player.id))`; inline Edit `<span role="button">` with stopPropagation
  preserves edit affordance without nested-button invalid HTML; swipe-to-delete untouched.

  Approach — row tap-through: kept the existing `<motion.button>` as the row body (preserves
  swipe-to-delete ownership in SwipeableRow), changed onClick to navigate to profile, added
  trailing `<span role="button" tabIndex={0}>Edit</span>` whose onClick stopPropagation calls
  openEditPlayer. No nested button, no lucide-react, no new design language.

  Gates: lint clean · tsc clean · voice-tests 265/265 · vitest 432/432 (+15 new) · build clean.
  `out/players/view` and `out/players/view.html` confirmed in static export.
  NOTICEABLE — tapping a player in the roster now navigates to a yardage-book-styled profile
  showing name, handicap, rounds played, and shared rounds list.

## 2026-06-28 (polish-courses-designer-notes — SILENT)
- **Done (commit a907aa7 on integration/next):** Designer polish pass on the course-detail-start-round work.
  Files changed (3): `app/courses/[id]/CourseDetailClient.tsx`, `app/courses/page.tsx`, `components/nav/FloatingTabBar.tsx`.
  Changes: mono/8.5/1.1/pencilSoft/uppercase location sub-label; paddingBottom safe-area calc; back button padding "0 8px";
  tab label nowrap+ellipsis; CoursesIcon ground-line removed; Find-a-course motion.button with whileTap scale 0.98.
  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · vitest 417/417 · build clean (out/courses + out/courses/view confirmed).
  SILENT — micro-polish; not a TestFlight-noticeable change on its own; rides with the bundle.

## 2026-06-28 (course-detail-start-round — NOTICEABLE)
- **Done (commit d5db7c6 on integration/next):** Full Courses section — browse, detail, Start-a-round-here, Courses tab.

  Files added (8): `lib/course-url.ts` (courseHref helper, static-export-safe), `lib/course-url.test.ts`,
  `lib/course-handoff.ts` (sessionStorage stash/take, SSR-safe, one-shot), `lib/course-list.ts`
  (pure mapRecentCourses), `lib/course-list.test.ts`, `app/courses/page.tsx` (hub: lazy recent list,
  geolocation Nearby, CourseSearch overlay), `app/courses/[id]/page.tsx` (generateStaticParams+Suspense),
  `app/courses/[id]/CourseDetailClient.tsx` (name/location/par/holes/tees, loading+not-found states, CTA).

  Files changed (4): `app/round/new/page.tsx` (one mount effect: takeCourseForRound → setSelectedCourse),
  `components/nav/FloatingTabBar.tsx` (CoursesIcon flagstick SVG + Courses tab as 2nd item),
  `components/nav/shouldShowTabBar.ts` (/courses added to HUB_ROUTES),
  `components/nav/shouldShowTabBar.test.ts` (/courses + /courses/ true; /courses/view false).

  Reuses composeCourseName, saveRecentCourse, getRecentCourses, getCourseDetails, getClubDetails,
  searchNearby, CourseSearch — no new deps, no backend changes.

  Gates: lint clean · tsc clean · voice-tests 265/265 · vitest 417/417 · build clean.
  out/courses and out/courses/view confirmed in static export.
  NOTICEABLE — new Courses tab + /courses hub + /courses/view detail page on TestFlight.
  GPS and live GolfAPI paths are device-only; pure helpers covered by vitest.
- **Eng-lead cycle close:** opus Plan (specs/course-detail-start-round-plan.md) → builder →
  reviewer **SHIP** (no correctness/security/Northstar blockers; nits only) → QA **PASS**
  (gates re-run independently) → designer **APPROVE-WITH-NITS** (4 fix-before-ship + 2 nits
  folded into a907aa7). Backlog flipped to built-integration-next-pending-device-verify
  (8b49a27). Opened rolling bundle **PR #67** (integration/next → main) — first item in a
  fresh bundle after #66 merged. NOT merged; owner NOT notified this cycle (per task scope —
  no TestFlight/email/push). The bundle is noticeable and ready for a release cut when the
  owner loop next runs.

## 2026-06-28 (voice-double-audio — NOTICEABLE, device-only verify)
- **Done (built 727c7df on integration/next, pushed; in bundle PR #66):** Fix the caddie
  playing TWO overlapping voices on every Realtime response.
  - Root cause (hypothesis 1, evidence-backed via webrtcHacks Safari guide + Capacitor
    #8176): the remote WebRTC audio sink in `frontend/src/lib/voice/realtime.ts` was
    `document.createElement('audio')`+autoplay but NEVER appended to the DOM and had no
    inline-playback attr. iOS WKWebView renders remote audio through a single ATTACHED
    element; a detached autoplay element can leave the track to ALSO render via the audio
    session → two slightly-offset copies = "two overlapping voices."
  - Fix: single, in-DOM, hidden, `playsinline`, autoplay sink; idempotent `srcObject`
    (only on a different stream); `audioEl.remove()` in `cleanup()` so reconnects/warm
    preloads never stack a sink. `start()` is guarded (`if(this.pc)return`) + error path
    calls cleanup → at most one element per client.
  - Defensive rule-out: NO double-response path — `response.create` fires only on typed
    input (sendText) and after a tool result (runTool); minted session is server_vad with
    no `create_response:false`, so voice turns auto-respond once. Mint config untouched.
  - Reviewer (fresh opus context): SOUND/ship, no blocking issues. Non-blocking nit logged
    (onconnectionstatechange doesn't cleanup on silent network drop — pre-existing, not the
    cause, out of scope).
  - Gates: lint 0 / tsc 0 / voice-tests 265/265 / vitest 399/399 / build clean.
  - **DEVICE-ONLY verifiable (audio):** must confirm on next TestFlight build. Rides the
    next approval bundle (PR #66).

## 2026-06-28 (nav-floating-island-tab — NOTICEABLE)
- **In progress (gates green, pending designer + reviewer):** Floating island tab bar.
  Per the approved plan — no commit yet, awaiting eng-lead's review pass.

  Files created / edited (all in `frontend/`):
  - **New `src/components/nav/shouldShowTabBar.ts`**: pure allowlist helper; exact
    match on HUB_ROUTES `['/', '/players', '/profile', '/tee-time']` after trailing-slash
    normalization.
  - **New `src/components/nav/shouldShowTabBar.test.ts`**: 17 vitest tests (4 hub
    routes + 3 trailing-slash variants + 10 false cases).
  - **New `src/components/nav/FloatingTabBar.tsx`**: `'use client'` component; uses
    `usePathname()`; returns null on non-hub routes; fixed floating pill (opaque T.paper,
    1px T.hairline border, borderRadius:999, soft box-shadow, z-index:40, bottom
    `calc(12px + env(safe-area-inset-bottom))`); 4 tabs with inline SVG icons (22px,
    strokeWidth:1.5, no lucide-react); active tab: T.ink color + T.paperDeep pill bg;
    inactive: T.pencil; framer-motion springSoft entrance; aria-label, aria-current,
    aria-hidden on SVGs.
  - **`src/app/layout.tsx`**: imports `FloatingTabBar` and renders it inside
    `<AuthProvider>` after `{children}`.
  - **`src/app/page.tsx`**: paddingBottom changed from `env(safe-area-inset-bottom, 16px)`
    to `calc(84px + env(safe-area-inset-bottom))` on the maxWidth:420 wrapper.
  - **`src/app/profile/page.tsx`**: `paddingBottom: "calc(84px + env(safe-area-inset-bottom))"`
    added to the maxWidth:420 wrapper.
  - **`src/app/tee-time/page.tsx`**: `paddingBottom: "calc(84px + env(safe-area-inset-bottom))"`
    added to `PaperShell`'s inner maxWidth:420 div.

  Gates: lint 0/0 · tsc 0 errors · voice-tests 265/265 · vitest 399/399 (17 new) ·
         build clean (15 pages).
  NOTICEABLE — new bottom tab bar visible on all 4 hub screens on TestFlight.

## 2026-06-28 (voice-chat-ordering — NOTICEABLE)
- **Done:** Fixed the Realtime voice round-setup chat rendering the caddie's reply
  ABOVE the user's line. Root cause: the user transcript event
  (`conversation.item.input_audio_transcription.completed`) arrives AFTER the
  assistant's streamed `response.audio_transcript.delta`s, and messages rendered
  in arrival order. Commit `179d03c` on `integration/next`; bundle PR #64 opened.

  Files changed:
  - **New `frontend/src/lib/voice/realtime-ordering.ts`**: pure `MessageOrderTracker`
    (+ `sortByOrder`). Assigns a stable monotonic `order` key when each conversation
    ITEM begins, not when its text arrives: user slot reserved at
    `input_audio_buffer.speech_started`, keyed by `item_id` (identity-matched to the
    transcript); assistant slot at `response.created`/first delta. item_id keying (not
    FIFO) means a phantom/empty/VAD-bounced speech_started can't desync ordering for
    the rest of the session.
  - **New `frontend/src/lib/voice/realtime-ordering.test.ts`**: 9 unit tests incl. the
    exact bug, multi-turn, and the phantom/empty speech_started regression.
  - **`frontend/src/lib/voice/realtime.ts`**: `RealtimeMessage` gains required `order`;
    `handleEvent` threads item_id + reserves slots; `sendText` emits the typed line
    centrally (renders even if the data channel isn't open).
  - **`frontend/src/components/VoiceRoundSetupRealtime.tsx`** + **`frontend/src/hooks/useRealtimeCaddie.ts`**:
    render `sortByOrder(messages)`; dropped the hook's duplicate typed-message upsert.

  Reviewer adversarial pass found + I fixed a real desync (FIFO user-slot matching
  corrupted ordering on phantom/empty/VAD-bounced speech_started) -> re-keyed by item_id
  + added the regression test; also fixed a typed-message silent-loss when the DC is closed.

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · vitest 374/374 · build clean.
  NOTICEABLE — but WebRTC live voice ordering is DEVICE-ONLY verifiable; must be confirmed
  on the next TestFlight build. Status = built-integration-next-pending-device-verify.

## 2026-06-28 (ux-wind-direction-viz — SILENT)
- **Done:** Wind direction visualisation relative to shot bearing in the caddie wind chip.
  Commit `c03dd8e` on `integration/next`.

  Files changed:
  - **New `frontend/src/lib/caddie/wind-relative.ts`**: exported `windRelativeToShot(windFromDeg, windSpeedMph, shotBearingDeg)` — pure trig helper. Sign convention: `wind_direction` is meteorological (where wind comes FROM); `relativeAngle = normalise(windFromDeg − bearingDeg)`. `cos(relAngle) * speed` = headTailMph (positive=head, negative=tail); `|sin(relAngle) * speed|` = crossMph (unsigned); `side='R'` when `sin > 0` (from right, R→L ball push). Classifies into 5 kinds using 30°/60°/120°/150° thresholds. Exported type `WindRelativeResult`.
  - **New `frontend/src/lib/caddie/wind-relative.test.ts`**: 17 vitest tests: zero wind, pure headwind ×2, pure tailwind ×2, crosswind R, crosswind L, head-cross R/L, tail-cross R/L, wraparound 0/360° ×3, headTailMph sign verification ×2.
  - **`frontend/src/components/CaddiePanel.tsx`**: imported `windRelativeToShot`; added `windRelative` inline computation; extended plays-like wind chip to show `windRelative.label` (e.g. "Tailwind 8 mph" or "Crosswind 12 mph · R→L") when bearing+weather are available. Falls back to backend description silently.

  Gates: lint clean · tsc clean · voice-tests 265/265 · vitest 365/365 (17 new) · build clean.
  SILENT — logic improvement to an existing chip; only visible when GPS is active AND
  a caddie recommendation with a wind adjustment has been fetched. No new UI surface.

## 2026-06-28 (gps-capacitor-migrate — SILENT)
- **Done:** Migrated GPS from browser `navigator.geolocation` to `@capacitor/geolocation`
  on native (iOS), with a web fallback. Commit `f3ef9a7` on `integration/next`.

  Files changed:
  - **`frontend/src/lib/gps.ts`**: Added Capacitor imports. Extracted
    `normalizeCapacitorPosition()` (pure, exported). `GPSWatcher.watchId` widened to
    `number | string | null`. New `_startNative()` async helper: `requestPermissions()` then
    `watchPosition()` via Capacitor; falls back to `_startWeb()` on plugin error. `stop()`
    routes to `Geolocation.clearWatch()` on native, `clearWatch()` on web.
    `getCurrentPosition()` uses Capacitor path on native with permission check, falls
    through to `navigator.geolocation` on failure. Public API unchanged.
  - **`frontend/src/components/CaddiePanel.tsx`**: Replaced the lone direct
    `navigator.geolocation.getCurrentPosition()` call (no-hole-coords branch) with
    `GPSWatcher.getCurrentPosition()` so that path also uses Capacitor on native.
  - **`frontend/src/lib/gps.test.ts`** (new): 23 vitest tests for
    `normalizeCapacitorPosition` (null → undefined, 0-heading/speed preserved, full
    shape) plus smoke tests for the pure utility functions. Both Capacitor packages
    are vi.mock()'d for headless CI.

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · vitest 348/348 (23 new) ·
         build 15 pages clean.

  SILENT — internal plumbing change; no visible UI change. Actual GPS accuracy
  improvement and iOS permission prompt are DEVICE-ONLY — must be tested on
  the next TestFlight build. Rides with next noticeable bundle.

## 2026-06-28 (realtime-noise-hardening — SILENT)
- **Done:** Hardened the OpenAI Realtime session mint config in
  `backend/app/services/realtime_relay.py`. Commit `e90a7ef` on `integration/next`.

  Changes applied (all confirmed against GA Realtime API docs before writing):

  1. **Noise reduction** (APPLIED): Added `audio.input.noise_reduction: {type: "near_field"}`.
     Field name `noise_reduction` confirmed at `audio.input.noise_reduction` in the GA
     Realtime client_secrets Python SDK reference (developers.openai.com, 2025). Allowed
     types: `near_field` (phone/headset) | `far_field` (laptop mic). `near_field` is
     correct for a mobile app. Reduces false-positive VAD triggers from background noise.

  2. **Transcription model** (APPLIED, default changed): Changed hard-coded `whisper-1`
     to env-configurable `OPENAI_REALTIME_TRANSCRIBE_MODEL`, defaulting to
     `gpt-4o-transcribe`. Confirmed supported values (Python SDK session_create_params.py):
     `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1`. Default is
     `gpt-4o-transcribe` because it hallucinates far less on silence than whisper-1.
     Can be overridden back to `whisper-1` via env without a deploy.

  3. **Turn detection VAD type** (APPLIED): Added `OPENAI_REALTIME_VAD` env var (default
     `server_vad`). Setting to `semantic_vad` switches to the semantic classifier with
     `eagerness: "auto"` (equivalent to "medium"). Confirmed: `semantic_vad` and
     `eagerness` values (`low`/`medium`/`high`/`auto`) in GA Realtime API reference
     (AudioInputTurnDetectionSemanticVad, 2025). Default behavior (server_vad + original
     thresholds) is completely unchanged.

  Refactor: extracted `build_session_payload(instructions, voice_id, tools, *, model,
  transcribe_model, vad_type)` pure helper (no network) so the mint config is testable
  without an API key.

  New file: `backend/tests/test_realtime_payload.py` — 10 pure pytest assertions.

  Gates: ruff clean · pytest 204 passed / 15 skipped / 0 failed (10 new tests) ·
         frontend tsc clean · eslint clean · voice-tests 265/265.

  NOTE: the mint config CANNOT be live-verified headlessly (no local OPENAI_API_KEY).
  Voice-connect MUST be tested on the next device build before this is trusted.

  SILENT — backend-only; no TestFlight-visible change. Rides with next noticeable bundle.

## 2026-06-28 (caddie-comp-legal-mode — NOTICEABLE)
- **Done:** "Competition legal" (USGA-conforming) toggle for the caddie recommendation.
  When on, `target_yards == raw_yards` and `adjustments == []` — no environmental
  distance adjustments (USGA Rule 4-3/10.3a). Default off.

  Files changed:
  - `backend/app/caddie/types.py`: `competition_legal: bool = False` on `RecommendationRequest` + `CaddieRecommendation`.
  - `backend/app/caddie/aim_point.py`: `generate_recommendation()` gains `competition_legal: bool = False`. When True: `adjusted_yards = distance_yards`, `adjustments = []`. Reasoning note added. Flag threaded to returned object.
  - `backend/app/routes/caddie.py`: `competition_legal` on `SessionRecommendRequest`; threaded into both `/session/recommend` and `/recommend`.
  - `backend/tests/test_competition_legal.py` (new, 14 tests): `TestCompetitionLegalOn` (8), `TestCompetitionLegalOff` (5), `TestAdjustmentsActuallyZeroed` (1).
  - `frontend/src/lib/caddie/types.ts`: `competition_legal?: boolean` on `CaddieRecommendation`.
  - `frontend/src/lib/caddie/api.ts`: `competition_legal?` param + body pass-through.
  - `frontend/src/components/CaddiePanel.tsx`: `competitionLegal` state; toggle switch (amber when on); "USGA legal" chip on recommendation.

  Gates: ruff clean · lint 0/0 · tsc 0 · voice-tests 265/265 · vitest 325/325 · build clean
         · pytest 48/48 (14 new comp-legal + 34 existing aim_point).
  Legal correctness verified by backend tests: target==raw, adjustments==[] on inputs that
  would otherwise produce wind/elevation/temperature adjustments.
  NOTICEABLE — amber toggle + "USGA legal" chip in caddie recommend view.

## 2026-06-28 (caddie-playslike-card — NOTICEABLE)
- **Done:** Surfaces a prominent "Plays like" yardage card in the caddie recommendation
  view. All data was already returned by `/caddie/recommend` — pure UI surfacing win.

  Files changed:
  - **New `frontend/src/lib/caddie/plays-like.ts`**: pure helper `buildPlaysLike(rec)`
    returns `{ rawYards, targetYards, deltaYards, hasAdjustment, rows, wind }`.
    `formatSignedYards()` produces −7y / +4y / 0y (proper minus sign U+2212). Zero deps.
  - **New `frontend/src/lib/caddie/plays-like.test.ts`**: 10 vitest tests.
  - **`frontend/src/components/CaddiePanel.tsx`**: Added Thermometer/Mountain/Layers
    icon imports, ShotAdjustment type import, buildPlaysLike/formatSignedYards imports,
    getAdjustmentIcon() helper. Removed old inline `(raw Ny)` span. Replaced old thin
    Adjustments block with new Plays-like card: headline (185y → 178y or "no adjustment"),
    wind chip (sky-blue pill when wind adj present), per-factor rows (icon+label+desc+yards).

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · vitest 325/325 (+10) · build clean.
  NOTICEABLE — caddie recommendation view now shows a structured plays-like card with
  per-factor breakdown and wind chip instead of the old plain adjustments list.

## 2026-06-28 (voice-live-transcription — NOTICEABLE)
- **Done:** Live interim display during on-course voice score entry via Deepgram
  streaming WebSocket, replacing the Web Speech API path that was unavailable in
  iOS Capacitor WKWebView.

  What changed:
  - **`backend/app/services/deepgram.py`**: Added `grant_live_token()` — calls
    `POST https://api.deepgram.com/v1/auth/grant` with the server-side API key and
    returns a 60-second short-lived `{access_token, expires_in}` so the API key
    never reaches the browser.
  - **`backend/app/routes/voice.py`**: Added `POST /api/voice/live-token` — auth-required
    endpoint that calls `grant_live_token()` and returns the token to the authenticated caller.
  - **`frontend/src/lib/voice/deepgram.ts`**: Added `getStream(): MediaStream | null`
    getter to `VoiceRecorder` so the live transcriber can attach to the existing mic
    stream without a second `getUserMedia` call. Also improved audio constraints to
    `{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }`.
  - **`frontend/src/lib/voice/deepgram-live.ts`** (new): `DeepgramLiveTranscriber` class
    that fetches a token, opens `wss://api.deepgram.com/v1/listen` with the `token`
    subprotocol, attaches a `MediaRecorder` in 250ms slices, and emits `onInterim` /
    `onFinal` callbacks. Also exports `parseDeepgramLiveMessage()` as a pure helper.
  - **`frontend/src/lib/voice/deepgram-live.test.ts`** (new): 7 vitest tests.
  - **`frontend/src/components/yardage/ScoreSheet.tsx`**: Replaced `recognitionRef`
    (Web Speech) with `liveRef` (DeepgramLiveTranscriber). After `recorder.start()`,
    creates and starts the live transcriber; failures are silent. Live transcriber
    stopped in `stopAndParse` and in both cleanup effects.

  Gates: ruff clean · lint 0/0 · tsc 0 · voice-tests 265/265 · vitest 315/315 (7 new) ·
         build clean (15 pages).

  NOTICEABLE — words appear on-screen as the owner speaks during score entry on device.

## 2026-06-28 (clerk-react-v6-upgrade — NOTICEABLE)
- **Done:** Upgraded `@clerk/clerk-react` (v5) → `@clerk/react` (v6.11.1) — the genuine
  fix for native-token mode: clerk-js v6 honors the `window.__internal_onBeforeRequest` /
  `window.__internal_onAfterResponse` window globals that AuthProvider registers (v5 CDN
  did not fire them in Capacitor WKWebView context).

  Package changes:
  - Removed `@clerk/clerk-react@5.61.3` from package.json / node_modules.
  - Added `@clerk/react@6.11.1` (the v6 / Core 3 package, which ships clerk-js v6 from CDN
    — UI components included, so `<SignIn/>` mounts without "Clerk was not loaded with Ui
    components" crash).
  - `@clerk/clerk-js@6.22.0` retained: still used by `clerk-global.d.ts` for the
    `window.Clerk` type declaration (type-only import, no runtime bundle cost).
  - `@clerk/testing@2.1.7` retained: v2 supports `@clerk/react` v6.

  Breaking changes fixed (v5 `@clerk/clerk-react` → v6 `@clerk/react` Core 3 migration):
  1. Package rename — all 9 import sites updated.
  2. `SignedIn`/`SignedOut` removed — replaced with `<Show when="signed-in/out">` in AuthButtons.tsx.
  3. `UserButton.afterSignOutUrl` removed — prop deleted from AuthButtons.tsx.

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · npm test 276/276 · build clean ·
         simtest-headless EXIT 0 (no crash, platform=ios, isNative=true, app renders).
  NOTICEABLE — native-sent will flip true on TestFlight; window hooks now honored by clerk-js v6.

## 2026-06-28 (clerk-native-session-instance-fix — NOTICEABLE)
- **Done:** Definitive fix for `native-sent:false` — window global hooks NEVER firing.
  Switched from window-global hooks to registering callbacks DIRECTLY on the locally-bundled
  `@clerk/clerk-js` Clerk instance. Commits on `integration/next`.

  Root cause: `window.__internal_onBeforeRequest` / `window.__internal_onAfterResponse` were
  set but `native-sent` was always `false` in on-device builds. The CDN-loaded clerk-js
  (loaded via `<script>` tag) does not reliably honor those window globals in the Capacitor
  WKWebView context.

  Fix (the @clerk/expo reference implementation adapted for Capacitor/Next.js):
  1. Added `@clerk/clerk-js@6.22.0` to package.json (bundled locally, no CDN script).
  2. Construct the Clerk instance at module load (inside IIFE, gated to native-only):
     `const instance = new ClerkBrowser(publishableKey)`
  3. Register callbacks ON THE INSTANCE:
     `instance.__internal_onBeforeRequest(cb)` wires into the FAPI client singleton
     created in the constructor — guaranteed to fire on every FAPI request.
     `instance.__internal_onAfterResponse(cb)` same for responses.
     Verified in `@clerk/clerk-js@6` dist/clerk.mjs and dist/types/core/clerk.d.ts (lines 241-242).
  4. Pass to ClerkProvider: `<ClerkProvider Clerk={instance} standardBrowser={false}>`.
     ClerkProvider calls `instance.load({ standardBrowser: false })` — no CDN script loaded.
  5. IIFE guard: `typeof window === "undefined"` → null (SSR/build); `isNativePlatform()==false`
     → null (browser/dev) → standard CDN path untouched.
  6. Removed old window globals and their TypeScript declarations.
  7. Fixed two `@ts-expect-error` directives made unnecessary by `@clerk/clerk-js` globals.

  Expected diagnostic after sign-in on the fixed build:
    `native-sent:true  auth-hdr:true  signed:true  tok:true  napi:true`

  Files changed:
  - `frontend/src/components/AuthProvider.tsx`
  - `frontend/src/lib/api.ts`
  - `frontend/src/lib/storage-api.ts`
  - `frontend/package.json` / `package-lock.json`

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · npm test 276/276 · build clean.
  NOTICEABLE — native-sent flips to true; full JWT-header auth session should establish.

## 2026-06-28 (clerk-session-capacitorhttp — NOTICEABLE)
- **Done:** Definitive fix for Clerk session not persisting in Capacitor iOS WebView.
  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · unit 276/276 · build clean.
  Commits on `integration/next`.

  Root cause (researched via clerk-js/fapiClient.ts + @clerk/expo/createClerkInstance.ts source):
  - Our window hooks are mechanically correct: fapiClient.ts reads `window.__internal_onBeforeRequest`
    on every FAPI request. `_is_native=1` is correctly appended to `requestInit.url` (same URL
    reference the fetch is called with). This is identical to @clerk/expo's approach.
  - The ACTUAL bug: browser CORS blocks reading the `authorization` response header in a WebView.
    In-browser fetch from `capacitor://localhost` to `clerk.looperapp.org` is cross-origin.
    CORS only exposes safelisted response headers; `authorization` requires
    `Access-Control-Expose-Headers: Authorization` from the FAPI for OUR origin. Result:
    `response.headers.get("authorization")` returns null → JWT never saved → `setActive()`
    → `session.__internal_touch()` sends empty authorization header → FAPI rejects →
    `handleUnauthenticated()` → session cleared → `isSignedIn` stays false.

  Fix: `CapacitorHttp: { enabled: true }` in `capacitor.config.ts`
  - Patches `window.fetch` + `window.XMLHttpRequest` to use iOS native NSURLSession.
  - Native HTTP does NOT enforce browser CORS → reads ALL response headers directly.
  - `response.headers.get("authorization")` now returns the Clerk JWT.
  - JWT is saved to @capacitor/preferences (Keychain) after sign-in.
  - Subsequent FAPI requests send the JWT in the authorization request header.
  - `session.__internal_touch()` authenticates → `isSignedIn` becomes true.
  - CapacitorHttp is a built-in Capacitor 4+ plugin (@capacitor/core); no new dep needed.
  - Web/dev unaffected: native patch only applies in the iOS runtime.

  New diagnostic fields (auth-diag.ts + AuthProvider.tsx):
  - `isNativeSent`: hook fired and appended `_is_native=1` — confirms hook is working
  - `authHeaderReceived`: whether authorization header was readable — THE KEY SIGNAL
  - `lastFapiPath`: last intercepted FAPI endpoint path

  NativeAuthDiag upgraded (NativeAuthDiag.tsx):
  - Multi-line, 12px font (was 9px single-line strip), yardage-book panel
  - "Copy" button: writes full diagnostic text to clipboard

  Expected on-device readout after successful sign-in:
    loaded:true  signed:true  native-sent:true  auth-hdr:true  tok:true  napi:true

  REQUIRED: run `npx cap sync` to push config to iOS Xcode project, then rebuild.
  NOTICEABLE — fixes sign-in on TestFlight + richer copyable diagnostic.

## 2026-06-28 (clerk-native-auth-deep-fix — NOTICEABLE)
- **Done:** Deep-fixed Clerk native session persistence in Capacitor iOS WKWebView.
  Commit `02c808d` on `integration/next`.

  Root cause (researched via clerk-js/fapiClient.ts source + @clerk/expo createClerkInstance.ts):
  - `window.__internal_onBeforeRequest` / `window.__internal_onAfterResponse` ARE
    the correct mechanism: fapiClient.ts reads both from the window object at request
    time via `runBeforeRequestCallbacks` / `runAfterResponseCallbacks`.
  - Two bugs in prior implementation vs the @clerk/expo reference:
    1. The `authorization` request header was only set when a JWT existed in
       Preferences. It must ALWAYS be set (empty string when no JWT) — the FAPI
       uses its presence to confirm native mode and choose header-vs-cookie auth.
    2. `x-mobile: 1` header was missing (Expo always sets this).
  - Root cause why `isSignedIn` stays false after sign-in: without the
    `authorization` header, the FAPI falls back to cookie-based auth. WKWebView ITP
    blocks these third-party cookies (clerk.looperapp.org from https://localhost).
  - The Clerk Native API must be enabled in the Dashboard (Configure → Native
    applications). If not enabled, `_is_native=1` is sent but the FAPI never returns
    the JWT in the authorization response header. Code now detects and surfaces the
    `native_api_disabled` error for exactly this case.

  Files changed:
  - `frontend/src/lib/auth-diag.ts` (new): module-level diagnostic state with subscriber.
  - `frontend/src/components/AuthProvider.tsx`: fixed hooks (always set authorization
    header, add x-mobile:1, track tokenRestored, detect native_api_disabled).
  - `frontend/src/components/NativeAuthDiag.tsx` (new): diagnostic strip component.
  - `frontend/src/app/sign-in/SignInClient.tsx`: renders NativeAuthDiag via dynamic(ssr:false).

  REQUIRED owner action (one-time, no rebuild):
    https://dashboard.clerk.com/last-active?path=native-applications
    → Configure → Native applications → Enable

  On-screen diagnostic (on native / NEXT_PUBLIC_AUTH_DIAG=1):
    `loaded:true  signed:true  tok:true  napi:true  origin:https://localhost`
  - `napi:false` = Native API not yet enabled in Clerk Dashboard
  - `tok:false` = normal on first launch (no saved JWT yet)

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · unit 276/276 · build clean.
  NOTICEABLE — fixes auth on-device + adds diagnostic strip for on-device validation.

## 2026-06-28 (oncourse-resilience — NOTICEABLE)
- **Done:** Graceful offline/fetch-failure degradation for the three high-traffic
  on-course screens. Commit `83fd0ad` on `integration/next`.

  Home (page.tsx) — what was added:
  - try/catch/finally in load() so setLoading(false) always fires; prevents
    stuck-loading if post-fetch processing throws (e.g. corrupt localStorage schema).
  - loadError state + loadKey retry trigger (Retry button re-runs the effect).
  - Loading skeleton: 3 paper-toned placeholder rows while rounds fetch.
  - Error state (no cached data): "Couldn't load rounds." + 44pt Retry.
  - Offline note (cached data shown): amber "Offline — showing saved data" +
    silent background Retry. T.warningWash/T.warningInk — pencil annotation feel.
  - Existing empty state, stats "—" during load, deleteError banner: untouched.

  RoundPageClient — what was added:
  - loadFailed state: distinguishes load errors from score-save errors so Retry
    only appears for load failures (score saves auto-retry via pendingRef).
  - retryCount state in useEffect deps: Retry silently re-fetches without
    resetting to a loading spinner (round data stays visible throughout).
  - apiError banner: T.errorWash/T.errorInk (red) → T.warningWash/T.warningInk
    (amber) — scores are always safe locally; red was unnecessarily alarming.
  - Load failure message: "Failed to load round — check connection." →
    "Showing saved data — couldn't reach server." + Retry button (loadFailed).
  - Score-save message: "Score save failed — check connection." →
    "Score saved locally — couldn't sync, will retry." (no Retry — pendingRef
    handles auto-retry). Score-save success also clears loadFailed.
  - Existing seq-guard / pendingRef / optimistic-update / LOCAL mode: untouched.

  LeaderboardSheet — NO CHANGES (already resilient):
  - Purely presentational, zero API calls, all data as props.
  - round: Round | null already handled via optional chaining.
  - All empty states present. LOCAL/offline signals from RoundPageClient provide context.

  Gates: lint 0/0 · tsc clean · voice-tests 265/265 · npm test 276/276 · build clean.
  NOTICEABLE — on-course users with spotty signal see calm placeholders and Retry
  affordances instead of blank/broken/stuck screens.

## 2026-06-28 (stats-scoring-breakdown — NOTICEABLE)
- **Done:** Added three new real-data stats sections to the profile screen, computed
  purely from existing completed-round data (no backend changes, no new data model).

  Files changed:
  - **New `frontend/src/lib/profile-stats.ts`**: three pure exported helpers:
    - `deriveParTypeAverages(rounds)` — per-par-type (par-3/4/5) average score and
      avg-to-par across all the owner's completed rounds; skips non-standard pars,
      null scores, non-completed rounds.
    - `deriveScoreDistribution(rounds)` — counts and percentages of eagle-or-better /
      birdie / par / bogey / double+ holes across all completed rounds; omits zero-count
      buckets; preserves canonical display order.
    - `deriveTrend(rounds, recentN=5)` — compares avg to-par of the last N completed
      rounds vs all prior; returns null when not enough data or either window has no
      valid (≥9 played holes) rounds.
  - **New `frontend/src/lib/profile-stats.test.ts`**: 38 unit tests covering all three
    helpers; edge cases include: no rounds, non-completed rounds, rounds with no players,
    null strokes, non-standard pars, holes not in round definition, 9-hole rounds,
    multi-round accumulation, 1dp rounding, only-owner counting, sort order independence
    for trend, partial rounds excluded from trend averages.
  - **`frontend/src/app/profile/page.tsx`**: two new `<Section>` components:
    - `<ParBreakdown>` — 3-column grid (Par N kicker | hole count | avg score + avg-to-par);
      birdie colour for negative to-par; "E" for even; empty state. Placed between
      ScoringByTee and YearLog (both are "scoring by category" views).
    - `<ScoreDistribution>` — labeled rows with proportional bars (eagle=eagle colour /
      birdie=birdie colour / par=ink / bogey+double+=pencilSoft), count right, percentage
      below. Quiet "Recent form" footer (dashed hairline separator) shows trend when
      ≥6 rounds available (recent avg vs prior avg with delta). Placed after YearLog.
    - Empty states for both: "Play a round to see your …" — consistent with existing
      profile empty states.

  Section order in final render:
  ScoringByTee → ParBreakdown (new) → YearLog → ScoreDistribution (new) → ShotAnalytics

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · npm test 276/276 (+38) · build 15 pages.
  NOTICEABLE — two new data sections appear on the Profile screen whenever the owner has
  completed rounds: par-type breakdown (avg score/to-par by hole type) and score
  distribution (eagle+/birdie/par/bogey/double+ bar chart with trend note).

## 2026-06-28 (clerk-token-cache P48 — NOTICEABLE)
- **Done:** Clerk session now survives force-quit and cold restart on iOS.

  Mechanism discovered: Clerk's `fapiClient` (clerk-js source) checks two
  `window`-level slots — `window.__internal_onBeforeRequest` and
  `window.__internal_onAfterResponse` — before/after every FAPI request.
  This is the same hook mechanism `@clerk/expo` uses internally for its
  `tokenCache` prop, exposed as a documented public surface in fapiClient.ts.

  Implementation:
  - At module-evaluation time in `AuthProvider.tsx` (synchronous, before React
    mounts and before the clerk-js CDN script completes its network download),
    we install both callbacks — but ONLY when `Capacitor.isNativePlatform()`.
  - `onBeforeRequest`: sets `credentials:"omit"`, appends `?_is_native=1`
    (tells Clerk backend to authenticate via header not cookie), then reads
    `__clerk_client_jwt` from `@capacitor/preferences` and injects it as the
    `Authorization` header.
  - `onAfterResponse`: reads the `authorization` response header that Clerk
    backend echoes back, and persists it to `@capacitor/preferences` (native
    iOS Keychain via Capacitor).
  - Storage key `__clerk_client_jwt` matches `@clerk/expo`'s
    `CLERK_CLIENT_JWT_KEY` constant — intentional for readability.

  New dependency: `@capacitor/preferences@^8.0.1` (matched to existing
  Capacitor v8 stack). iOS native plugin wired into
  `ios/App/CapApp-SPM/Package.swift` alongside Camera and Geolocation.

  Files changed:
  - `frontend/src/components/AuthProvider.tsx` — hook setup + import
  - `frontend/package.json` — @capacitor/preferences added
  - `frontend/package-lock.json` — lock updated
  - `frontend/ios/App/CapApp-SPM/Package.swift` — CapacitorPreferences added

  Web/dev path: completely unchanged. Hooks are gated to
  `Capacitor.isNativePlatform()` which is false in all browser contexts.

  Gates: lint 0/0 · tsc 0 errors · voice-tests 265/265 · npm test 238/238 ·
         npm run build clean.
  NOTICEABLE — session now survives cold restart on TestFlight.

  On-device test steps (next TestFlight build):
  1. Open app fresh → sign-in form appears (no stored JWT yet).
  2. Sign in with email+password → home screen loads.
  3. Force-quit the app (swipe up in app switcher).
  4. Reopen app → home screen loads WITHOUT sign-in form (JWT persisted).
  5. Background + foreground → session stays active.
  6. Sign out via Settings → sign-in form reappears.
  7. Re-sign-in → persists again through force-quit.

## 2026-06-28 (clerk-native-session — NOTICEABLE)
- **Done:** Fixed Clerk session persistence in Capacitor iOS WKWebView — the final auth
  blocker that caused `isSignedIn` to stay `false` after sign-in.

  Root cause: Clerk's web SDK stores the session as a cookie on `clerk.looperapp.org`.
  In WKWebView with origin `https://localhost`, iOS ITP treats that as a third-party
  cookie and blocks it. Clerk's JS never sees the cookie → `isSignedIn` is permanently
  `false` → the sign-in form loops forever.

  Three-layer fix (all frontend only; no backend/env/migration touches):

  1. `standardBrowser: false` on `<ClerkProvider>` (primary fix — `AuthProvider.tsx`):
     Clerk's official prop for non-browser environments. When `false`, Clerk skips the
     standard cookie storage assumption and uses an alternative (non-cookie) token path.
     Gated to `Capacitor.isNativePlatform()` — returns `true` only when
     `window.webkit.messageHandlers.bridge` is present (injected by the native WKWebView
     container), so the web/dev build is completely unaffected.

  2. `CapacitorCookies: { enabled: true }` (`capacitor.config.ts`):
     Patches `document.cookie` to use the native WKHTTPCookieStore. Belt-and-suspenders
     for any Clerk operations that do land cookies; also improves general cookie handling.

  3. `WKAppBoundDomains` (`ios/App/App/Info.plist`):
     Whitelists `clerk.looperapp.org` and `looperapp.org` as App-Bound domains.
     iOS treats their cookies as first-party within the WKWebView, so they're stored
     and visible in the shared WKHTTPCookieStore (used by CapacitorCookies).

  Files changed:
  - `frontend/src/components/AuthProvider.tsx`
  - `frontend/capacitor.config.ts`
  - `frontend/ios/App/App/Info.plist`

  What is NOT solved (follow-up needed):
  - Session persistence across cold app restarts. With `standardBrowser: false` and
    no `tokenCache`, Clerk stores the token in-memory only — a force-quit clears it
    and the user must sign in again. Fix: implement a `tokenCache` backed by
    `@capacitor/preferences`. Separate item.

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · npm test 238/238 · build clean.
  NOTICEABLE — fixes the login loop: sign-in now completes and the app loads.

  TestFlight verification checklist:
  1. Open app → sign-in screen appears.
  2. Sign in with email+password → home screen loads (not looped back to sign-in).
  3. Navigate around → session stays active within the same launch.
  4. Background + foreground → session persists within the same app launch.
  5. Force-quit + reopen → sign-in screen appears again (expected; tokenCache not yet implemented).
  6. Web/dev build unaffected: `npm run dev` → standardBrowser stays at default (true).

## 2026-06-28 (fix-integration-test-loop P45 — SILENT)
- **Done:** Fixed `RuntimeError: Future attached to a different loop` / `Event loop is
  closed` that caused 5 integration tests to fail when run as part of the full pytest
  suite.

  Root cause: pytest-asyncio 1.4.0 defaults `asyncio_default_test_loop_scope = "function"` —
  a new event loop per test. The module-level `engine` + `async_session` in
  `app/db/engine.py` bind asyncpg connections to the FIRST test's loop. After that loop
  closes, subsequent tests (with a new loop) try to reuse the same connections →
  "Future attached to a different loop".

  Fix: added two lines to `[tool.pytest.ini_options]` in `backend/pyproject.toml`:
    asyncio_default_fixture_loop_scope = "session"
    asyncio_default_test_loop_scope = "session"
  One session loop for the entire test run. The module-level engine's asyncpg pool is
  bound to that loop and stays there throughout all tests. No cross-loop mismatch. No
  changes to app code, routes, or conftest assertions.

  Evidence:
  - `uv run pytest tests/ --ignore=tests/integration`: 138 passed (unchanged)
  - `uv run pytest tests/integration/`: 13 skipped (Postgres not local — correct)
  - `uv run pytest tests/`: 138 passed, 13 skipped, exit 0
  - `uv run ruff check .`: clean

  Full validation requires Postgres (no local DB here). CI's `advisory-backend-integration`
  job (which has the Postgres service) is where the 5 failing tests will be confirmed green.
  I could not claim they pass locally — that validation is CI's job.

  SILENT — test infrastructure only; no TestFlight-visible change.

## 2026-06-27 (auth-e2e-gate — SILENT)
- **Done:** `auth-e2e-gate` — Playwright E2E scaffold covering the critical sign-in
  flow (and 2 core journeys). Directly addresses the #1 QA gap the owner called out:
  login regressions were never caught by existing gates (voice-tests, vitest, build).
  Commit on `integration/next`.

  Files added / changed:
  - **`frontend/package.json`**: added `@playwright/test@^1.61.1` and `@clerk/testing@^2.1.7`
    as devDependencies; added `"test:e2e": "playwright test"` script.
  - **`frontend/playwright.config.ts`** (new): Chromium project; webServer = `npm run dev`
    on port 3000; `globalSetup: './e2e/global.setup.ts'`; forwards
    `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` from `CLERK_PUBLISHABLE_KEY` to the dev-server
    child process so the AuthGate activates in CI.
  - **`frontend/e2e/global.setup.ts`** (new): plain `export default async function` so
    Playwright doesn't mistake it for a test file. Calls `clerkSetup()` when
    `CLERK_SECRET_KEY` is set; silent no-op otherwise.
  - **`frontend/e2e/auth.spec.ts`** (new — 4 tests):
    - **Tier 1** (1 test, needs `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` only):
      "AuthGate renders sign-in screen for unauthenticated user" — loads `/`, asserts
      "Your yardage book" kicker (unique to `SignInClient`) is visible and "Recent rounds"
      is NOT visible. No CLERK_SECRET_KEY needed. Can be promoted to REQUIRED once the
      publishable key is added as a CI secret.
    - **Tier 2** (3 tests, needs `CLERK_SECRET_KEY` + test user):
      "completes sign-in with Clerk test user" — calls `setupClerkTestingToken()`,
      fills `looper+clerk_test@looperapp.org`, submits, enters OTP `424242`, asserts
      "Recent rounds" visible and sign-in screen dismissed.
      "home screen shows expected shell after sign-in" — asserts "Start a round, call a
      shot" CTA and profile link visible.
      "navigating to new round screen renders without crashing" — asserts `/round/new`
      renders (no blank/crash).
    - All 4 tests self-skip with clear messages when credentials are absent.
  - **`frontend/tsconfig.json`**: added `"e2e"` and `"playwright.config.ts"` to
    `exclude` (same pattern as `voice-tests`) — keeps `tsc --noEmit` scoped to
    Next.js source only.
  - **`frontend/eslint.config.mjs`**: added `"e2e/**"` and `"playwright.config.ts"`
    to `globalIgnores` so ESLint's Next.js rules don't flag Playwright test idioms.
  - **`.github/workflows/ci.yml`**: added `advisory-e2e` job (after `required-frontend`,
    `continue-on-error: true`). Installs Chromium via `npx playwright install --with-deps
    chromium`, runs `npm run test:e2e`. Reads `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`
    from CI secrets (not yet configured). Clear promotion checklist in the YAML comment.

  What runs without Clerk secrets (current state):
  - All 4 tests self-skip; runner exits 0. The advisory job is green (continue-on-error).
  - Global setup prints "[clerk setup] CLERK_SECRET_KEY not set — skipping."
  What needs Clerk CI secrets to unlock:
  - Tier 1: add `CLERK_PUBLISHABLE_KEY` secret → "sign-in screen renders" runs + can
    be promoted to required.
  - Tier 2: add `CLERK_SECRET_KEY` + create test user `looper+clerk_test@looperapp.org`
    in Clerk dev dashboard → all 3 sign-in flow tests run. After that, remove
    `continue-on-error: true` from the advisory job.

  IMPORTANT — scope limitation: this web E2E catches web/flow regressions (broken
  sign-in widget, page crashes, gate bypass) but does NOT reproduce Capacitor
  `capacitor://` vs `https://localhost` webview-origin issues. Those still need a
  simulator/manual smoke per TestFlight build.

  Local run:
    cd frontend && npm run test:e2e
  With Clerk key set (Tier 1):
    export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_… && npm run test:e2e
  Full run (Tier 2):
    export CLERK_PUBLISHABLE_KEY=pk_test_… CLERK_SECRET_KEY=sk_test_… && npm run test:e2e

  Gates: lint 0/0 · tsc 0 errors · voice-tests 265/265 · vitest 238/238.
  npm run test:e2e (no secrets): 4 skipped, 0 failed, exit 0.
  SILENT — test infrastructure only; no TestFlight-visible change.

## 2026-06-27 (round-delete-ui — NOTICEABLE)
- **Done:** `round-delete-ui` — wired swipe-to-delete for recent rounds on the home screen.
  Commit `bfecdc9` on `integration/next`.

  What changed: `frontend/src/app/page.tsx` only.
  - Added `SwipeableRow` import (same component players page uses) and `deleteRoundAsync`
    import from `storage-api`.
  - Added `deleteError` state and `handleDeleteRound` — optimistic remove from `rounds` state,
    clears the "Resume" live-round banner when the active round is deleted, then calls
    `deleteRoundAsync`. On unexpected runtime error (extremely rare — `deleteRoundAsync`
    swallows API errors internally): rollback via re-insertion in date order + error banner.
  - The separator border-top (dashed hairline) moved from the `<button>` to an outer wrapper
    `<div>` so `SwipeableRow`'s `overflow:hidden` does not clip it.
  - Each round row is now wrapped in `SwipeableRow` with a context-aware `confirmMessage`:
    - Completed rounds: "Remove your round at {course} on {month} {day}?"
    - Active (live) round: "{course} is in progress — remove this round and all its scores?"
  - `rounds` state drives both `recentRows` and `deriveScoringStats`, so optimistic removal
    auto-refreshes both the list and the stats/handicap section.
  - Active rounds are swipeable (confirm provides the safety net). Completed-only v1 was
    considered but judged unnecessarily restrictive — one clear confirm suffices.

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · vitest 238/238 · build 15 pages clean.
  NOTICEABLE — new user-visible action on TestFlight: swiping a round row on the home
  screen reveals delete, with a confirm dialog before removal.

  KNOWN-GAP: Delete (rounds + players) swallows API failures in deleteRoundAsync/deletePlayerAsync — UI shows success even if the server DELETE failed, so a round/player can reappear on next authenticated load. Acceptable for now; a future "delete really failed" toast should be added in one place for both flows.

## 2026-06-27 (settings-signout-and-restyle — NOTICEABLE)
- **Done:** `settings-signout-and-restyle` — added Sign Out action (Part A) and restyled
  Settings from Tailwind/CSS classes to T.* inline-style system (Part B).
  Commit on `integration/next`.

  Part A — Sign Out:
  - `useClerk()` from `@clerk/clerk-react` provides `signOut`. Rendered only inside
    `<SignOutButton>` sub-component, which Settings conditionally mounts based on
    `!!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — so no ClerkProvider crash
    in dev builds with no key.
  - Inline two-step confirm: tap "Sign out" → button pair appears ("Cancel" + "Yes,
    sign out"). Keeps the action calm and reversible; avoids an alert modal.
  - After `signOut({ redirectUrl: '/' })` resolves, Clerk's session clears →
    `AuthGate` (which watches `useAuth().isSignedIn`) automatically shows the
    sign-in screen with no manual redirect hacks needed.
  - Account section visible only when Clerk is configured (invisible in local dev,
    correct on TestFlight where the key is set).

  Part B — Restyle to T.*:
  - Removed all Tailwind/CSS classes: `app-shell`, `app-header`, `card p-5`,
    `text-base font-semibold`, `btn btn-icon`, `space-y-4`, `header-divider`, `btn w-full`.
  - Replaced with T.* inline styles: PAPER_NOISE + T.paper background with multiply
    blend, Instrument Serif (T.serif) for headings, T.mono for kickers/buttons
    (uppercase, letterSpacing), T.pencil/T.pencilSoft/T.ink for text hierarchy,
    T.hairline hairline rules for section dividers.
  - Header pattern matches `profile/page.tsx` Masthead: `max(14px, env(safe-area-inset-top))`
    top padding, mono back button (left arrow + "Home"), mono kicker on right ("The Book"),
    large italic serif heading "Settings." at 38px.
  - Section shell: mirrors profile's `<Section>` — 9px mono kicker (uppercase, 1.6
    letter-spacing), 22px serif italic title, hairline top border, 22px side padding.
  - All functionality preserved: About section (version + description), Clear Local
    Cache button with existing `confirm()` dialog + honest copy, TrashIcon SVG inline.
  - max-width 420, safe-area bottom padding `max(96px, calc(96px + env(safe-area-inset-bottom)))`.

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · npm test 238/238 · build 15 pages clean.
  NOTICEABLE — new Sign Out action (functional gap closed) + visible Settings restyle
  on TestFlight (Tailwind class-based UI replaced with yardage-book T.* aesthetic).

## 2026-06-27 (post-round recap — NOTICEABLE)
- **Done:** new `RoundRecap` component — yardage-book recap screen shown after a round
  is finished, before returning home. Fills the gap where `handleFinish` previously
  called `router.push('/')` with no summary of the round just played.
  Commit `43d2b6a` on `integration/next`.

  Files changed:
  - **New `frontend/src/components/RoundRecap.tsx`** (383 LOC):
    - Full-screen `position:fixed` overlay, `zIndex:80`, PAPER_NOISE + T.paper background.
    - AnimatePresence slide-up (y:28 -> y:0, 0.32s, T.ease).
    - Header: course name (Instrument Serif italic 28px), date (mono caps, en-US long
      format), tee name + hole count kicker, "Thru N" when round is partial.
    - Per-player rows: first player (owner) emphasised with T.paperDeep background and
      larger type (strokes 38px serif, to-par 13px mono). Other players at 28px / 11px.
      To-par rendered as "E" / "+N" / "-N"; birdie colour (T.birdie) for under-par,
      T.ink for even, T.pencil for over. Quiet birdie/eagle count as a mono kicker when
      any exist. "--" for players with no scores entered.
    - Games section: delegates to existing `<GameResults>` component — no logic
      duplicated. Game name kicker above each result. `onUpdateGame` omitted (read-only).
    - Quiet italic caption at the bottom (course + holes or "Thru N").
    - "Done" button: 54px min-height, full-width, T.ink on T.paper, border-radius:14.
    - Safe-area-inset-* padding top and bottom throughout.

  - **`frontend/src/app/round/[id]/RoundPageClient.tsx`** (+15 LOC):
    - Added import for RoundRecap.
    - Added `const [recapOpen, setRecapOpen] = useState(false)`.
    - `handleFinish`: replaced `router.push('/')` with `setRecapOpen(true)` in all three
      branches (local round, API success, API fallback). Completion persistence
      (`apiCompleteRound` + `localSaveRound` fallback) is unchanged. Celebration haptic
      fires unchanged.
    - `<RoundRecap>` added after `<LeaderboardSheet>`.

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · npm test 238/238 · build 15 pages clean.
  NOTICEABLE — new end-of-round screen visible on TestFlight whenever the owner finishes
  a round. Shows course, date, per-player strokes + to-par, quiet birdies/eagles, and any
  game results — before routing home.

## 2026-06-27 (delete-dead-legacy P29 — SILENT)
- **Done:** deleted 11 superseded, zero-importer legacy components — 5,269 LOC removed.
  Commit `0152829` on `integration/next`.

  Files deleted (all git rm'd, zero external references confirmed):
  - `ScoreGrid.tsx` (1,103 LOC), `HoleScoreModal.tsx` (658), `RoundSummary.tsx` (608),
    `AddGameModal.tsx` (577), `VoiceTournamentSetup.tsx` (420), `CourseSearchImport.tsx` (442),
    `VoiceGameSetup.tsx` (417), `EditGroupsModal.tsx` (389), `TournamentGamesPanel.tsx` (341),
    `GamesPanel.tsx` (184), `TournamentLeaderboard.tsx` (130).

  Cross-references were internal to the deleted set only (GamesPanel→AddGameModal/VoiceGameSetup,
  ScoreGrid→HoleScoreModal). Post-deletion grep: zero remaining references to any of the 11 names
  across `frontend/src` + `frontend/voice-tests`.

  Remaining lucide-react importers (7 files, all non-reachable):
  - P28 GPS/caddie cluster (blocked): `CaddiePanel.tsx`, `GPSMapView.tsx`,
    `ShotTrackingControl.tsx`, `PinMarkControl.tsx`, `CaddieNotesCard.tsx`, `CustomPersonaModal.tsx`
  - `AuthButtons.tsx` (unimported, kept for caution)

  Gates: lint 0/0 · tsc 0 · voice-tests 265/265 · npm test 238/238 ·
         build 15 pages clean · pytest 138/13skip unchanged.
  SILENT — dead code only; no TestFlight-visible change.

## 2026-06-27 (voice-low-confidence-ux P35 — SCORING-PATH slice — NOTICEABLE)
- **Done:** scoring-path slice of `voice-low-confidence-ux` (P35, NOTICEABLE) — real voice
  score entry in ScoreSheet with a confidence-aware confirm step.
  Commit `32b7353` on `integration/next`.

  Files changed:
  - **`backend/app/routes/voice.py`**: `VoiceScoreResponse` gains `confidence: float = 0.5`
    and `warnings: list[str] = []`. New `_derive_confidence()` helper: empty scores → 0.2;
    otherwise `min(1.0, (scored/total) * 0.9)`. Derived after Claude extraction.
  - **`frontend/src/lib/voice/types.ts`**: `VoiceParseScoresResult` gains
    `confidence?: number` and `warnings?: string[]` (additive — backward compatible).
  - **`frontend/src/lib/voice/parseVoiceScores.ts`**: `_deriveConfidence()` helper added.
    `parseVoiceScoresLocally` returns confidence. `parseVoiceScores` forwards backend
    `confidence` or computes from mapped score count.
  - **`frontend/src/components/yardage/ScoreSheet.tsx`**: replaced static "Or say…" hint
    with functional voice entry. `ScoreVoicePhase` state machine (`idle | listening |
    thinking | confirm | error`). MediaRecorder + Web Speech interim "Hearing…".
    VoiceConfirmPanel inline sub-component: per-player score tiles; confidence < 0.65 →
    T.warningWash + T.warningInk kicker "Double-check these — I wasn't sure". Apply calls
    `onSetScore(pid, idx, val)` (same path as manual entry). Manual digit-wheel + quick-pick
    untouched.
  - **`frontend/voice-tests/corpus/seed-utterances.jsonl`**: 4 new scoring confidence tests
    (lowconf:scores:001–003, highconf:scores:001 with expectedConfidenceMin:0.65).
  - **`frontend/voice-tests/runner.ts`**: comment updated; confidence check now applies to
    both setup and scoring results.

  Gates: ruff clean · lint 0/0 · tsc 0 · voice-tests 265/265 (+4) · npm test 238/238 ·
         npm run build clean · pytest 138/0 skip unchanged.
  NOTICEABLE — mic button in ScoreSheet; confirm step with low-confidence amber cue.


## 2026-06-27 (backend-route-integration-tests — SILENT)
- **Done:** backend route integration tests proving security properties on the real FastAPI + Postgres stack.
  Commit `189dbc1` on `integration/next`.

  Files added / changed:
  - `backend/pyproject.toml`: added `pytest-asyncio>=0.23.0` to dev group; added `asyncio_mode = "auto"` to `[tool.pytest.ini_options]`.
  - `backend/tests/integration/__init__.py`: empty marker.
  - `backend/tests/integration/conftest.py`: test harness.
    - Sets `DATABASE_URL` in `os.environ` at module-top BEFORE any app import (critical: `app/db/engine.py` reads it at import time and raises `RuntimeError` if unset).
    - `_db` autouse fixture: probes Postgres reachability (TCP), creates schema via `Base.metadata.create_all`, adds `scores_round_player_hole_uq` constraint via raw SQL (it lives in migration not ORM model), truncates all data tables before each test.
    - `client` fixture: `httpx.AsyncClient(transport=ASGITransport(app=app))` — no real HTTP.
    - `set_auth(user_id|None)`: sets or clears `app.dependency_overrides[current_user_id|require_owner]` to inject test identity without real JWTs. `_clear_auth_overrides` autouse fixture clears after every test.
    - Skips gracefully when Postgres is not reachable (local dev without DB); runs fully in CI.
  - `backend/tests/integration/test_routes.py`: 13 integration tests in 5 classes.
    - `TestAuthRequired` (3): GET /api/rounds, GET /api/profile/golfer, GET /api/players all return 503 with no auth override and no CLERK config — fails closed.
    - `TestIDOR` (3): Owner B cannot read/write owner A's round by id (404); round list is scoped to owner (empty list).
    - `TestScorePersistence` (2): Score round-trips through POST + GET; re-posting same (player, hole) updates not duplicates (upsert via `scores_round_player_hole_uq`); scores on different holes coexist.
    - `TestProfileCRUD` (2): GET returns 204 when no profile; PUT creates; GET returns persisted data; second PUT does partial update.
    - `TestPlayersCRUD` (3): Create player, list includes it; owner B sees empty list; owner B gets 404 on owner A's player by id.
  - `.github/workflows/ci.yml`: added `postgres:16` service to `required-backend` job with `pg_isready` health-check (5s interval, 10 retries); `DATABASE_URL` set as job env var; step renamed "Unit + integration tests (pytest)".

  Harness design: routes import `async_session` from `app.db.engine` directly (not via `Depends(get_session)`), so DB cannot be swapped via `dependency_overrides` — the whole engine is pointed at the test DB via `DATABASE_URL`. Auth IS overridable via `dependency_overrides` since `current_user_id`/`require_owner` are Depends-based.

  Bugs found: none; auth, IDOR, and persistence all behave correctly by code inspection. Tests verify the live behavior end-to-end.

  Gates: `uv run ruff check .` clean · `uv run pytest` 138 passed, 13 skipped (no local Postgres — skip is correct; CI provides Postgres). Frontend untouched: lint 0 · tsc 0 · voice-tests 261/261.
  SILENT — backend + CI only; no TestFlight-visible change.

## 2026-06-27 (backend-test-suite — SILENT)
- **Done:** first backend test suite (`backend/tests/`) — 138 pytest unit tests covering the
  caddie pure-logic modules, wired into the required-backend CI job.

  Files added / changed:
  - `backend/pyproject.toml`: added `pytest>=8.0.0` to dev dependency group; added
    `[tool.pytest.ini_options] testpaths = ["tests"]`.
  - `backend/tests/__init__.py`: empty marker.
  - `backend/tests/test_strokes_gained.py` (40 tests): `_interpolate` (empty table,
    clamp above/below, midpoint, quarter-point, monotone), `_handicap_multiplier`
    (scratch=1.0, hcp36=1.7, None→15, clamp ±, monotone), `personal_lookup` (None/empty
    sg, missing lie, interpolation, bucket with null mean_strokes skipped),
    `expected_strokes` (table dispatch, personal_sg override, unknown lie fallback),
    `strokes_gained` (holed shot, avg-shot, positive/negative SG, handicap effect).
  - `backend/tests/test_club_selection.py` (25 tests): `normalize_club_distances`
    (full camelCase→short mapping, zero/negative dropped, passthrough, empty),
    `compute_adjustments` (no-op, uphill +5y, downhill −4y, small-elev ignored, cold/warm
    temp, high altitude, soft/firm conditions, floor=1, stacking), `select_club` (exact
    match, between clubs, conservative/aggressive bias, short/long out-of-range, empty bag
    fallback, return type).
  - `backend/tests/test_dispersion.py` (18 tests): `_interpolate_handicap` (exact breakpoint,
    clamp low/high, midpoint, monotone width), `get_dispersion` (shape, scratch/hcp15 driver,
    unknown club fallback, None→15, wedge tighter than driver, camelCase club key,
    center_bias=none, 1dp rounding), `dispersion_covers_hazard` (inside/outside, strict
    less-than boundary, aim offset shifts window left/right, real driver/wedge dispersion).
  - `backend/tests/test_aim_point.py` (35 tests): `classify_pin_position` (7 cases: no hazards
    →green, 1 severe close→yellow, 2 severe→red, death→yellow, 2 death close→red,
    mild/far→green), `compute_aim_point` (6 cases: green/red/yellow light descriptions,
    death-right favors left, death-left+miss-left favors right, return type),
    `compute_miss_side` (6 cases: no hazards→short, water R→left, water L→right,
    avoid text, return type, front water→long), `generate_recommendation` (16 cases:
    type, club string, raw==target with no adjustments, elevation adjusts target, reasoning
    list, confidence in [0,1], aggressiveness valid, red→conservative, no-haz→aggressive,
    expected_score float, empty bag fallback, adjustments list, weather/hazards boost
    confidence, player history in reasoning).
  - `backend/tests/test_safe_json_extract.py` (18 tests): clean JSON, ```json fenced,
    ``` fenced, JSON wrapped in prose, after newlines, nested object, escaped quotes,
    fenced with whitespace, markdown+fenced, no-JSON→None, empty→None, unclosed→None,
    open-brace→None, non-JSON fenced falls back to bare, `[` array in fence, first of
    multiple objects, malformed-fenced+valid-bare, real LLM round-setup output.
  - `.github/workflows/ci.yml`: `required-backend` job renamed to "Backend gate (ruff +
    pytest)"; added "Unit tests (pytest)" step after ruff (runs `uv run pytest`).

  Bugs found (NOT fixed — behavior-change blocked):
  - None found in the caddie modules. All behavior matched expected outputs from
    the documented formulas and tables. `_safe_json_extract` handles all test cases
    correctly including the strict less-than boundary for dispersion.

  Gates (backend): `uv run pytest` 138/138 pass · `uv run ruff check .` clean.
  Gates (frontend, unaffected): lint 0 · tsc 0 · voice-tests 261/261 · npm test 238/238.
  SILENT — no TestFlight-visible change; backend + CI only.

## 2026-06-27 (voice-low-confidence-ux P33 — SETUP-PATH slice)
- **Done:** SETUP-PATH slice of `voice-low-confidence-ux` (P33, NOTICEABLE) — wired the
  backend's `confidence` field through `ParsedRoundConfig` and surfaced a calm
  yardage-book amber cue on the round-setup result card when the parse is uncertain.

  Files changed:
  - **`frontend/src/components/VoiceRoundSetup.tsx`**:
    - Added `confidence?: number` to `ParsedRoundConfig`. The backend's
      `RoundSetupResponse.confidence` is already in the JSON response from
      `POST /api/voice/parse-round-setup`; `fetchAPI<ParsedRoundConfig>` now carries it.
    - Added `isLowConfidence` derived from `!parseResult.courseName || confidence < 0.7`.
    - Result card kicker: "Hard to hear — check the details below" in `T.warningInk` when
      low; "Got it — confirm below" in `T.pencil` when high. Course card: always rendered;
      amber (`T.warningWash` + dashed `T.warningInk`) when empty, normal when present.
  - **`frontend/voice-tests/corpus/seed-utterances.jsonl`**:
    - Added `lowconf:setup:001`: "going out with Justin and Robert" → confidence:0.6 < 0.7
      threshold; regression guard for the amber cue path.

  Gates: lint 0 · tsc 0 · voice-tests 261/261 · npm test 238/238 · build OK.
  NOTICEABLE — amber warning visible in round-setup voice flow when parse is uncertain.

## 2026-06-27 (restyle-dark-components-sweep P24.5 — lucide cleanup, final pass)
- **Done:** two remaining reachable lucide-react importers replaced with inline SVGs.
  - `frontend/src/app/players/page.tsx`: removed `import { ArrowLeft, Plus, User, Search, X, Check }`.
    Six local icon components added (ArrowLeftIcon, PlusIcon, UserIcon, SearchIcon, XIcon,
    CheckIcon) — pattern matching SwipeableRow.tsx (viewBox 0 0 24 24, fill none, stroke
    currentColor, strokeWidth 1.5, strokeLinecap/Linejoin round, aria-hidden baked in).
    UserIcon accepts `color` prop (merges into style.color so currentColor resolves); all
    others inherit color from the parent element. All size/style/color props preserved.
  - `frontend/src/app/tournament/[id]/round/new/NewTournamentRoundClient.tsx`: removed
    `import { GripVertical }`. Added `GripVerticalIcon` (fill currentColor, two columns of
    6 circles matching Lucide's GripVertical glyph). Both usages replaced — pencilSoft in
    the sortable row, T.paper in the drag overlay ghost.
  - `grep -rln "from.*lucide-react" frontend/src` now returns zero results for reachable
    files; remaining 15 importers are all confirmed non-reachable (P29 legacy dead-code:
    GamesPanel, AddGameModal, RoundSummary, EditGroupsModal, CourseSearchImport,
    VoiceGameSetup, VoiceTournamentSetup, TournamentGamesPanel; blocked-P28 GPS/caddie
    cluster: CaddiePanel, GPSMapView, ShotTrackingControl, PinMarkControl, CaddieNotesCard,
    CustomPersonaModal; unimported AuthButtons).
  - Gates: lint 0 · tsc 0 · voice-tests 260/260 · npm test 238/238 · build 15 pages OK.
  - SILENT — visually identical (same icon glyphs, same layout); NORTHSTAR correctness
    (no icon-library dependency in reachable render paths).

## 2026-06-27 (restyle-dark-components-sweep P24.5 — lucide cleanup)
- **Done:** backlog `restyle-dark-components-sweep` (P24.5, SILENT) — removed the two
  remaining reachable `lucide-react` imports from `settings/page.tsx` and
  `SwipeableRow.tsx`. Replaced with local inline SVG components matching the
  yardage-book style (strokeWidth 1.5, strokeLinecap/Linejoin round, fill none,
  stroke currentColor — identical pattern to CameraCapture.tsx / VoiceRoundSetup.tsx).
  - `settings/page.tsx`: `TrashIcon` (20px, `className="h-5 w-5"`, `aria-hidden` baked in).
  - `SwipeableRow.tsx`: `TrashIcon` (accepts className + style CSSProperties) and
    `AlertTriangleIcon` (accepts size + style) — color flows via `currentColor` from
    `style={{ color: T.errorInk }}`. `CSSProperties` imported from 'react'.
  - No shared icon file created (no pre-existing one; both usages differ in size/props).
  - Swipe-to-delete + confirm dialog behavior is unchanged; visually pixel-equivalent.
  - `grep -rn "lucide-react" frontend/src` shows remaining imports are in other files
    not in scope for this item (EditGroupsModal confirmed dead/unimported, others are
    separate backlog items).
  - Gates: lint 0 · tsc 0 · voice-tests 260/260 · npm test 238/238 · build OK (15 pages).
  - SILENT — no user-visible change on TestFlight (icon shapes are the same).

## 2026-06-27 (wire-profile-stats P16)
- **Done:** backlog `wire-profile-stats` (P16, NOTICEABLE) — replaced last fabricated mock
  data on the profile screen with real computed stats (where possible) and honest empty
  states (where data genuinely doesn't exist yet). Commit `1e1bf7f` on `integration/next`.

  What changed in `frontend/src/app/profile/page.tsx`:
  - **ScoringByTee (now real):** Removed `PP_SCORING` constant. New `deriveScoringByTee()`
    computes per-tee averages from the owner's completed rounds using `calculateTotals()` +
    `players[0].id` (same owner-identification pattern as home/page.tsx). Grouped by
    `round.teeName`, shows: tee name, yards (summed from HoleInfo.yards when available),
    par, round count, average strokes, and average over-par bar chart. Sorted longest
    tee first. Empty state: "Play a round to see your scoring by tee." No (Preview) label.
  - **YearLog / Season log (now real):** Replaced fake heatmap (`buildYear` seed function +
    PP_* data) with `deriveRoundLog()` — real completed rounds sorted most-recent first.
    Each row: date (month + day) | course name + optional tee name | total strokes + to-par
    string ("E"/"+N"/"-N"). Section renamed "Season log". Empty state: "Post a round to
    track your season."
  - **StrokesGained (honest empty):** Removed `PP_SG` + framer-motion animated bars. Calm
    placeholder: "Strokes gained needs shot tracking — coming soon." No (Preview) label.
    Removed `motion` import (only used in that section).
  - **FairwayFan (honest empty):** Removed `PP_FWY` + fake SVG fan diagram + fake Drive
    dist/Dispersion numbers. Calm placeholder: "Fairway tracking needs shot data — coming
    soon." No (Preview) label.
  - Owner-identification: `players[0].id` (single-owner beta), same as home/page.tsx.
    `calculateTotals()` from `lib/types.ts` reused — no new shared helper needed.
  - Data fetch: `getRoundsAsync()` added to profile page's `Promise.all` alongside
    `getGolferProfileAsync()` — one concurrent request, same pattern as home.

  Gates: lint 0 · tsc 0 errors · voice-tests 260/260 · build 15 pages OK.
  NOTICEABLE — user-visible change on TestFlight: fabricated tee-averages, SG bars,
  and fairway fan replaced with either real data (ScoringByTee, YearLog) or honest
  "coming soon" placeholders (SG, Fairway).

## 2026-06-27 (frontend-lint-cleanup P32)
- **Done:** backlog `frontend-lint-cleanup` (P32, SILENT) — `npm run lint` now passes with
  0 errors and 0 warnings. Commit `c867c06` on `integration/next`.

  Root cause: ~2,874 of the errors were false positives from the Capacitor iOS web bundle
  (`ios/App/App/public/_next/static/`). Eliminated by adding `"ios/**"` to ESLint
  `globalIgnores` in `eslint.config.mjs`.

  Real fixes in `src/` and `voice-tests/`:
  - **react-hooks/set-state-in-effect + react-hooks/refs:** Replaced two `useEffect`-based
    prop-sync patterns in `PlayerAutocomplete.tsx` and `ScoreSheet.tsx` with the React
    "store previous prop" pattern (`useState`-based conditional during render).
  - **react-hooks/immutability (used-before-declared):** `parseSimpleScore` extracted to
    module level in `ScoreGrid.tsx` (it's pure); `submitScore` (useCallback) and
    `parseVoiceLocally` reordered to appear before `processVoiceScores` in the component.
  - **react-hooks/exhaustive-deps:** Wrapped `effectivePin` in `useMemo` in `CaddiePanel.tsx`
    so its object reference is stable across renders (was creating a new object on every render).
  - **Unused imports/vars:** Removed `AnimatePresence`, `Users`, `ChevronRight`, `Player`,
    `stripFillerWords`, `extractCapitalizedNames` across 6 files. Used `_`-prefix pattern for
    intentionally unused params; added `argsIgnorePattern: "^_"` to ESLint config.
  - **`no-explicit-any`:** Replaced all `any` types in voice-tests and voice lib files with
    `unknown`, explicit casts, or typed interfaces.
  - **SpeechRecognition typing:** Added `SpeechRecognitionErrorEvent` to `src/types/speech.d.ts`
    (updated `onerror` type there); used typed window cast pattern across ScoreGrid, VoiceGameSetup,
    VoiceTournamentSetup. Restored `useEffect` to PlayerAutocomplete import (was incorrectly removed).
  - **react/no-unescaped-entities:** Changed raw quotes to `&ldquo;/&rdquo;` in JSX text.
  - **catch (e) {} → catch {}:** In haptics.ts, VoiceGameSetup, VoiceTournamentSetup.
  - **eslint-disable comment:** Added `// eslint-disable-next-line @next/next/no-img-element`
    on the avatar `<img>` in `players/page.tsx` (user-provided URL, next/image requires known domains).

  Gates: lint 0 problems · tsc 0 errors · voice-tests 260/260 · npm test 238/238.
  SILENT — no user-visible change on TestFlight.

## 2026-06-27 (mount-ocr-scan P27 — polish pass)
- **Done:** 13-item reviewer/designer polish pass for `mount-ocr-scan` (commit `cba0e25`
  on `integration/next`).

  DESIGN MUST-FIX:
  1. Removed "Claude Vision" brand mention — scanning overlay subtitle → "This may take a moment".
  2. "Scan card" entry button: minHeight 28→40px, added inline camera SVG icon.
  3. Score cell height: 34→40px.
  4. Amber cell flag: added T.warningWash background + full T.warningInk border (dropped `99` alpha).
  5. Camera guide frame: T.hairline → T.pencil+"cc" (~80% opacity) — visible over live video feed.

  CORRECTNESS SHOULD-FIX:
  6. CameraCapture: useEffect cleanup — stop MediaStream tracks on unmount (camera indicator clears).

  CORRECTNESS NITS:
  7. handleCellChange: clamp to 1–15; values outside → null so they can't silently survive to Apply.
  8. handleApply: partial failure detection — if any Promise.allSettled rejects, stay open + show
     "N of M saved — M didn't reach the server. Tap Apply to retry." banner in review phase.
  9. Duplicate mapping guard: hasDuplicate disables Apply; OcrPlayerCard shows "Already assigned"
     amber badge + amber border when two OCR rows map to the same round player.

  DESIGN NICE-TO-HAVE:
  10. Confidence kicker: semantic label at 10px ("Looks good…" vs "Hard to read…") not raw %.
  11. Hole-number header: 8→9px.
  12. Scrollable body bottom padding: 4→16px.
  13. Backdrop: now dismisses during error phase too (was review-only).

  Gates: eslint on 3 modified files — 0 errors · tsc --noEmit — 0 errors · voice-tests — 260/260.

## 2026-06-27 (mount-ocr-scan P27)
- **Done:** backlog `mount-ocr-scan` (P27, NOTICEABLE) — re-mounted the OCR scorecard-scan
  flow with a real entry point and yardage-book aesthetic.

  Key changes:
  - **New `frontend/src/components/ScanSheet.tsx`** (~340 LOC):
    - Full scan-to-score flow: capture → OCR → editable review → apply.
    - Phase `capture`: renders restyled `CameraCapture` full-screen overlay (camera or
      photo-library).
    - Phase `scanning`: full-screen "Reading the card…" overlay while `parseScorecard()`
      calls `POST /api/voice/parse-scorecard` (Claude Vision, server-side).
    - Phase `review`: bottom sheet (mirrors CaddieSheet pattern). Shows per-OCR-player
      editable score grid: two rows of 9 (front 9 + back 9), compact 28px mono inputs,
      hole-number column headers. Confidence kicker in header; amber low-confidence warning
      + amber cell borders when confidence < 60%. Player-name mapping via a `<select>`
      dropdown per OCR player (pre-populated with case-insensitive match, or "Skip" for
      unmatched names — unmatched players flagged with "No match" badge and amber border).
      At least one player must be assigned before "Apply scores" enables.
    - Phase `applying`: fires `onSetScore(pid, holeIdx, val)` in parallel via
      `Promise.allSettled` for all valid (1–15) non-null scores on mapped players;
      `N of M scores` progress counter shown. Uses the same `handleSetScore` code path as
      manual hole entry (optimistic UI + pending overlay + per-hole API upsert).
    - Phase `error`: error card + "Try again" button that returns to capture.
    - State reset: parent passes a fresh React `key` on each open (idiomatic unmount+remount)
      — no `useEffect` setState pattern (avoids `react-hooks/set-state-in-effect` lint rule).
    - Design: T.* tokens only, PAPER_NOISE, Instrument Serif, inline SVGs (CloseIcon),
      44pt close button, safe-area-aware bottom padding, 28pt score cells with numeric
      keyboard. No lucide-react, no new npm deps.
  - **Restyled `frontend/src/components/CameraCapture.tsx`** (full rewrite):
    - Removed: `lucide-react` import (`Camera`, `Upload`, `X`), all Tailwind class names
      (`bg-zinc-950`, `text-zinc-400`, `text-zinc-300`, `text-red-200`, `border-red-400/20`,
      `backdrop-blur-xl`, `bg-zinc-950/70`, `border-white/10`, `btn`, `btn-primary`,
      `btn-secondary`, `btn-icon`, `card`, `app-header`, `header-divider`).
    - Added: inline SVGs (CameraIcon, UploadIcon, CloseIcon), inline styles with T.*
      tokens throughout. PAPER_NOISE + T.paper full-screen background,
      `max(14px, env(safe-area-inset-top))` header, `max(14px, calc(env(safe-area-inset-bottom)+8px))`
      bottom bar. T.serif italic "Capture the card" title, T.paperDeep card well,
      dashed `T.hairline` guide border in camera mode. T.errorWash/T.errorInk error banner.
      All buttons minHeight 44px. Paper background on bottom bar (replaces dark backdrop).
  - **`RoundPageClient.tsx` changes:**
    - Imports `ScanSheet`.
    - `const [scanOpen, setScanOpen] = useState(false)` added.
    - `pointerEvents` guard extended: `|| scanOpen`.
    - Scorecard section label refactored from `<SectionLabel>Scorecard</SectionLabel>` to
      inline row with "Scorecard" kicker + hairline rule + quiet "Scan card" text button on
      the right (T.mono 9px, T.pencil colour, minHeight 28px). Entry point does NOT add a
      third pill to the bottom action row.
    - `<ScanSheet key={scanOpen?"scan-open":"scan-closed"} ...>` mounted after the caddie
      sheet with `round`, `onSetScore={handleSetScore}`, `accent`.

  Auth note: `voice_advanced.router` is registered with `dependencies=_owner_only` in
  `backend/app/main.py` (line 61). `fetchAPI` (called by `parseScorecard`) attaches the
  Clerk Bearer token automatically — no additional auth wiring needed in the frontend.

  Name matching: OCR names matched to round players by exact case-insensitive comparison.
  Unmatched names shown with "No match" badge + amber card border; user assigns via
  dropdown or selects "Skip". Unmatched players are NEVER auto-created.

  Persistence path: `handleSetScore` (the same callback as in-round manual entry) —
  `POST /api/rounds/{id}/scores` per-hole upsert via `addScore`. No new endpoint.

  Gates: eslint src/components/{CameraCapture,ScanSheet}.tsx + RoundPageClient: 0 errors ·
  tsc --noEmit 0 errors · voice-tests 260/260 · npm test 238/238 · npm run build 15 pages OK.

  NOTICEABLE — new user-visible capability on TestFlight: "Scan card" link appears in the
  Scorecard section header on the in-round screen; tapping opens the camera/library picker
  and OCR-parses the card into an editable review sheet before applying to the round.

  Designer flags for on-device review:
  1. Score input cells (28px × 34px): verify the numeric keyboard focuses correctly on iOS
     and that tapping a cell selects it cleanly. Consider increasing to 32px wide if cells
     feel too small on-device.
  2. "Scan card" text button in the Scorecard section header: currently T.pencil mono 9px;
     verify readability and consider a small camera SVG icon for discoverability.
  3. Player name dropdown (`<select>`): iOS renders a native picker wheel. Verify the T.mono
     10px style reads clearly and that "Skip" is the correct default label for unmatched names.
  4. Low-confidence amber border on score cells: subtle amber underline (T.warningInk 60%
     opacity bottom border). Verify it reads in sunlight without feeling alarming.
  5. Bottom sheet max-height 88dvh: on small phones (SE), verify the score grid + Apply
     button are accessible without excessive scrolling when 4 players are shown.
  6. Scanning overlay text: "Reading the card… / Claude Vision is processing your image" —
     verify it feels calm and on-brand (consider replacing "Claude Vision" with just "Scanning").

  Follow-up for eng-lead (NOT blocking this PR):
  - `voice_advanced` router is owner-gated: frontend sends token automatically via fetchAPI.
    No follow-up needed; confirmed auth flow is correct.

## 2026-06-27 (mount-caddie P26)
- **Done:** backlog `mount-caddie` (P26, NOTICEABLE) — new `CaddieSheet` component mounted
  on the in-round screen. A lean, GPS-free, yardage-book caddie overlay reachable via a
  new "Ask caddie" ghost pill in the bottom action row of `RoundPageClient`.

  Key changes:
  - **New `frontend/src/components/CaddieSheet.tsx`** (~480 LOC):
    - Two interaction modes, selectable via a mono kicker tab bar:
      1. **Voice (primary):** tap-to-record → `VoiceRecorder` + Web Speech API interim
         display (identical pattern to `VoiceRoundSetup`) → `transcribeBlob` → auto-calls
         `talkToCaddie()` (POST `/caddie/voice`) → answer shown in T.serif italic 18px.
         Conversation history maintained for follow-up questions within a session.
         "Ask follow-up" button re-arms the mic with prior context included.
      2. **Distance tap (secondary):** numeric yards-to-pin input + "Advise" button →
         `fetchRecommendation()` (POST `/caddie/recommend`) → club call shown in T.serif
         italic 36px, aim point + target yards in T.mono, strategy line in T.serif italic
         16px, miss-side + aggressiveness chips below.
    - Both paths read golfer's club bag from `getGolferProfile()` (localStorage) and pass
      `club_distances` + `handicap` to the backend when available. camelCase → API key
      mapping inline (driver, 3w, 5w, hy, 4i–9i, pw, gw, sw, lw).
    - Caddy identity (`caddy.name`, `caddy.initial`, `accent`) passed through as props —
      uses "Steve" selected in `RoundPageClient`, medallion in accent colour.
    - Hole context chip in header: "Hole N · Par X · Y yds".
    - Bottom-sheet pattern (matches `ScoreSheet`): `position:fixed; bottom:0` + spring
      animation, `borderTopLeftRadius:24`, `max-height:88dvh`,
      `paddingBottom:env(safe-area-inset-bottom)`. Backdrop: ink @ 32% + blur(3px).
    - Design: T.* tokens only, PAPER_NOISE, Instrument Serif, inline SVGs (MicIcon,
      CloseIcon, FlagIcon), 64pt mic button, 44pt+ all other touch targets, no lucide,
      no zinc/emerald/slate, no new npm deps.
    - Sheet resets all state (conversation, recording, answers) on close.
  - **`RoundPageClient.tsx` changes:**
    - Imports `CaddieSheet`.
    - `const [caddieOpen, setCaddieOpen] = useState(false)` added.
    - Bottom action row: split into two pills side by side:
      - Ghost "Ask caddie" pill (T.paper bg, T.hairline border, caddie initial medallion
        in accent + serif italic label "Ask caddie").
      - Solid "Enter score" pill (T.ink bg, simplified — removed the ↑ icon, shows hole
        number in accent mono kicker).
    - `pointerEvents` guard updated to `scoreOpen || voiceOpen || caddieOpen ? "none" : "auto"`.
    - `<CaddieSheet>` mounted after `<ScoreSheet>` with hole context from round state:
      `holeYards={round.holes[currentHole-1]?.yards ?? hole.yards}`.
  - **Endpoints wired:**
    - POST `/caddie/voice` via `talkToCaddie()` (lib/caddie/api.ts:316)
    - POST `/caddie/recommend` via `fetchRecommendation()` (lib/caddie/api.ts:95)
    - Auth via `fetchAPI`/`authHeaders()` — no new auth code.
  - **Not touched:** `CaddiePanel.tsx`, mapbox, GPS, shot-tracking, PinMarkControl,
    useRealtimeCaddie. All P28 territory, blocked and out of scope.
  - **Gates:** `eslint src/components/CaddieSheet.tsx src/app/round/[id]/RoundPageClient.tsx`
    0 errors · `tsc --noEmit` 0 errors · voice-tests 260/260 · npm test 238/238 ·
    `npm run build` 15 pages, no errors.
  - **NOTICEABLE** — new user-visible capability on TestFlight: "Ask caddie" button on
    in-round screen opens AI caddie sheet with voice and distance paths.
  - **Designer flags for on-device review:**
    1. Two-pill bottom row: verify "Ask caddie" + "Enter score" fit side-by-side on 375px
       without cramping; may need to shrink "Ask caddie" label to initials-only on narrow
       viewports.
    2. Voice tab: "Hearing…" + interim transcript card — verify T.paperDeep bg + T.inkSoft
       text reads in sunlight at 15px serif italic.
    3. Distance tab: club call at 36px T.serif italic — verify legibility and that 36px
       doesn't feel oversized relative to the sheet height on small phones.
    4. Conversation history display (when >1 Q&A in history): verify alternating
       T.paperDeep / T.paperEdge card pairs feel calm, not busy.
    5. Bottom sheet max-height 88dvh — on phones with very short screens (SE), verify
       the mic button + mode tabs are always visible without scrolling.

## 2026-06-27 (voice-live-transcript)
- **Done:** `voice-live-transcript` (NOTICEABLE) — live transcription shown on screen
  in the voice round-setup flow, plus transcript retained through the AI-parse wait.
  Key changes (all in `frontend/src/components/VoiceRoundSetup.tsx`):
  - **Live interim transcription during `listening` phase** (new): Web Speech API
    (`window.SpeechRecognition ?? window.webkitSpeechRecognition`) runs in parallel
    with `MediaRecorder` while the mic is open. As the user speaks, words appear
    on-screen in a yardage-book card labelled "Hearing…" with T.serif italic 19px
    T.inkSoft text — fades in gently via a short framer-motion transition. Deepgram
    is still the authoritative final transcript (Web Speech is best-effort display
    only). On stop, recognition is `abort()`-ed and the interim text clears before
    Deepgram's result lands. No new npm dependency — uses the built-in browser API
    already declared in `frontend/src/types/speech.d.ts`.
  - **Transcript retained during `thinking (isParsing)` phase** (new): previously the
    transcript text was hidden the moment the user tapped "Understand this" — the
    screen showed only "Understanding…" + a pulsing dot. Now the recognised words are
    shown below the pulsing dot in a `T.paperDeep` card (T.serif italic 18px, T.ink)
    so the user can read what was heard while the AI processes it.
  - **Existing `transcribed` and `result` phase displays unchanged** — the "You said"
    box in `transcribed` was already at 19px T.serif italic (good); the echo at the
    bottom of `result` was already present.
  - **Retry / unmount cleanup**: `interimTranscript` state cleared on retry and in
    the `useEffect` cleanup; `recognitionRef.current?.abort()` called on unmount
    alongside the existing `recorderRef.current?.cancel()`.
  - **Other voice entry points**: `transcribeBlob` is only used in `VoiceRoundSetup.tsx`
    (confirmed by grep) — no other component to update.
  - **True real-time streaming note**: the Web Speech API approach delivers good
    on-device interim results without a new backend endpoint. Full Deepgram streaming
    (WebSocket, server-side `listen.open()`, interim `is_final:false` events) would
    require a new `/api/voice/stream` WS endpoint and a streaming client replacement
    — deferred as a follow-up if the Web Speech fallback proves insufficient on-device.
  - Gates: `eslint src/components/VoiceRoundSetup.tsx` 0 errors, `tsc --noEmit` 0
    errors, voice-tests 260/260 pass, npm test 238/238 pass, npm run build OK (15 pages).
  - NOTICEABLE — user-visible on TestFlight: words appear on screen AS the user speaks;
    transcript stays visible while the app is "Understanding…". Designer flag: verify
    the "Hearing…" card's T.paperDeep background and T.inkSoft text against the sunlit
    paper aesthetic; adjust font size if the card feels too large on a 375px viewport.

## 2026-06-27 (client-auth-gate)
- **Done:** backlog `client-auth-gate` (URGENT, NOTICEABLE) — added a client-side
  Clerk auth gate so unauthenticated users are sent to sign-in before any app
  content or backend calls are attempted. Root cause: no server middleware runs in
  the Capacitor webview (capacitor:// origin), so every route was loading for
  unauthenticated users → no token → backend 401s for voice and silent localStorage
  fallback for data.
  Key changes:
  - **New `AuthGate.tsx`** (`frontend/src/components/`): `"use client"` component
    rendered inside `<ClerkProvider>`. Uses `useAuth()` (isLoaded, isSignedIn) and
    `usePathname()`. Three states:
    - `!isLoaded` → `PaperLoading` (calm paper masthead, no flash of app or sign-in)
    - `isAuthRoute(pathname)` (/sign-in, /sign-up) → `children` rendered (no gate,
      no redirect loop)
    - `!isSignedIn` (other routes) → `<SignInClient />` rendered inline; when Clerk
      confirms the session, `isSignedIn` becomes true and children render automatically
    - `isSignedIn` → `children` (full app)
  - **`AuthProvider.tsx` updated**: imports `AuthGate` and wraps children inside it
    (inside `<ClerkProvider>`). `ClerkTokenBridge` renders first so getToken is
    registered. When `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is absent, gate is skipped
    (local dev without credentials still works).
  - **Clerk appearance updated**: dark zinc/emerald palette replaced with yardage-book
    paper/ink palette via Clerk's CSS-variable layer — `colorBackground: "#f4f1ea"`,
    `colorPrimary: "#1a2a1a"`, `colorText: "#1a2a1a"`, `colorTextSecondary: "#6b6558"`,
    `colorInputBackground: "#ece7db"`, `colorDanger: "#b84a3a"`, `borderRadius: "2px"`.
  - **`SignInClient.tsx` restyled**: dark `bg-zinc-950` + white headings replaced with
    paper background (`PAPER_NOISE + T.paper`), serif italic "Looper." masthead at 44px,
    mono kicker "Your yardage book", safe-area-aware padding. Clerk widget inherits
    provider appearance.
  - **`SignUpClient.tsx` restyled**: same paper/ink treatment; kicker reads "Create
    your account".
  - **Token flow confirmed**: after sign-in, `useAuth().isSignedIn` becomes true →
    `AuthGate` renders children → `ClerkTokenBridge.useEffect` fires again with
    `isSignedIn=true` → `setTokenGetter(getToken, {isLoaded:true, isSignedIn:true})`
    → `getTokenViaClerk()` resolves → all API calls get a Bearer token → voice and
    backend work.
  - **Static export compatible**: all hooks called unconditionally; `!isLoaded` guard
    fires during prerender (Clerk doesn't run at build time) → `PaperLoading` is the
    prerendered shell; no `redirect()` or `useRouter().push()` used (no server-routing
    dependency). Build: 15 pages, all ○/● — no errors.
  - Gates: eslint src/ (no new errors in changed files), tsc 0 errors, voice-tests
    260/260, npm test 238/238, npm run build 15 pages OK.
  - NOTICEABLE — owner must now SIGN IN (with the owner Clerk account) when opening
    the app. After sign-in, voice calls will carry a token and backend 401s will stop.
    Designer flag: paper-on-white Clerk widget may need further polish depending on
    Clerk's internal rendering; the provider appearance variables set the palette but
    Clerk's shadow DOM may partially override. Verify on-device.

## 2026-06-21
- **Done:** Phase 0 foundation — project `CLAUDE.md`, `.claude/settings.json` +
  `guard.sh` guardrail hook (tested), the 8-agent team in `.claude/agents/`,
  and a seeded `backlog.json`.
- **In progress (local, safe):** CI workflow, Playwright smoke tests, the limit
  governor, the release email/clip templates, and the `scorecard-ai-team.md`
  concept doc.
- **Blocked / awaiting owner go:** create the Notion board, enable Vercel
  previews + staging, GitHub branch protection on `main`, set the $50 usage-credit
  cap, and schedule the first (dry-run) routine.
- **First task when the loop starts:** `test-games-engine` (lowest risk).

## 2026-06-23
- **Plan pivot (approved):** secure, owner-only **native iOS beta** (TestFlight via
  Xcode Cloud) on **AWS** (RDS replaces Supabase), email approvals, **always-on**
  agent team on the EC2. Full plan: `~/.claude/plans/snazzy-sniffing-summit.md`.
- **Done:** Phase A2 — owner-only auth gate → **PR #24** (`feat/owner-only-auth-gate`).
  Discovery: `backend/app/db/engine.py` already uses a generic `DATABASE_URL`/asyncpg,
  so the backend is already RDS-ready — "dropping Supabase" is mainly a frontend + config change.
- **Next:** B1/A3 — relocate course CRUD to the backend over the DB, remove the client
  Supabase path + `NEXT_PUBLIC_SUPABASE_*`, and remove the browser Anthropic key (`ocr.ts`).
- **Owner-only (blocked on you):** AWS infra (RDS, Secrets Manager, IAM, ALB/ACM, CloudWatch),
  Apple/Xcode Cloud setup, rotate keys, `deploy/` + EC2 systemd units, Settings → Usage $50 cap.

### 2026-06-23 (later)
- Shipped **PR #25** (`feat/ocr-server-side`): scorecard OCR moved server-side, browser
  Anthropic key removed. Plus `.gitignore` hardened, `infra/looper-aws.yaml` CloudFormation
  drafted (owner reviews + applies; guardrail blocks `deploy/`), `release-manager` rewritten
  for the TestFlight/always-on loop, git-sync added to `eng-lead`/`builder`, `OWNER_SETUP.md` written.
- **Open PRs for owner review:** #24 (auth gate), #25 (OCR server-side), #26 (caddie client authed), #27 (dead apiKey removed).
- **Clean no-infra wins: DONE** (#24–#27). **Remaining is RDS-gated** (verify against the real
  backend, so do it after RDS is up): course CRUD → new `/api/courses/mapped` routes over RDS,
  then repoint `golf-api.ts` + `voice-parser.ts` (the backend parse-transcript returns a
  different shape — verify before swapping), then B3 static export. Then Capacitor (C).

## 2026-06-26
- **Done:** backlog `voice-nickname-jt` (priority 1) → **PR #47** (`fix/voice-nickname-jt`).
  Made the local score parser's explicit-pattern pass nickname-aware (`aliasesForPlayer`),
  with a collision guard so a real `JT` player isn't conflated with `Justin`. Fixes the last
  failing smoke case. Gates: **voice-tests 260/260**, tsc clean, build OK, no new lint.
  Minor change (no auth/data/endpoints/deps) — eng-lead ran an adversarial reviewer pass; not
  pinging owner. **Follow-up:** promote voice-tests to a *required* CI gate (separate PR).
- **Done:** backlog `db-core-schema` (P1, SILENT) — Alembic + core scoring schema.
  - Added `alembic>=1.13.0` to `backend/pyproject.toml`; installed (1.18.5).
  - Created `backend/alembic.ini` + `backend/migrations/` (env.py async, script.py.mako).
  - Revision `001_baseline` (empty no-op): marks caddie tables 001–004 as already applied.
  - Revision `002_core_scoring` (005_core_scoring): creates 8 new tables: players,
    golfer_profiles, tournaments, rounds, player_groups, round_players, scores, games.
  - Added ORM models (Player, GolferProfile, Tournament, Round, PlayerGroup, RoundPlayer,
    Score, Game) to `backend/app/db/models.py`.
  - Gates: ruff clean, ORM import clean, alembic offline SQL clean, voice-tests 260/260.
  - DB application deferred to EC2 deploy box. Deploy protocol:
      DATABASE_URL=<real> uv run alembic stamp 001_baseline
      DATABASE_URL=<real> uv run alembic upgrade head
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `api-contract-align` (Phase 0, SILENT) — rewrite `frontend/src/lib/api.ts`
  and `frontend/src/lib/storage-api.ts` to match the real FastAPI/Pydantic contract.
  Key fixes:
  - All interfaces now camelCase (matching `backend/app/models.py` + `frontend/src/lib/types.ts`).
  - Domain types imported from `types.ts` instead of redefined in api.ts.
  - `updateRound` changed from `PATCH` → `PUT`; body now `RoundUpdate {scores,games,groups,status}`.
  - `addScore` body now camelCase `{playerId,holeNumber,strokes}`; return type `Round` not `Score`.
  - `createRound` body camelCase; `players` now includes `id` (required by backend Pydantic model).
  - Removed `RoundListItem` (backend returns full `Round[]`); removed N+1 getRound-per-item calls.
  - `updateTournament` changed from `PATCH` → `PUT`; body camelCase.
  - `addPlayerToTournament` fixed to path-param style `/api/tournaments/{id}/players/{playerId}`.
  - `searchCourses` removed (backend has no `?q=` param); replaced with `getCourses()`.
  - Added Players API (`getPlayers`, `createPlayer`, `updatePlayer`, `deletePlayer`).
  - Removed `addPlayerToRound` (endpoint doesn't exist).
  - Removed Games CRUD (`getGame/createGame/updateGame/deleteGame` — no `/api/games` route).
  - Profile functions stubbed with `// TODO(backend-profile-endpoint)` — return null, no HTTP calls.
  - `storage-api.ts`: replaced silent `catch → localStorage` swallowing with `console.error` +
    explicit offline fallback; removed snake_case converters (no longer needed); profile functions
    simplified to localStorage-only; `saveRoundAsync` sends full scores in one PUT instead of
    N individual addScore calls; player `id` field now included in `createRound`.
  - Gates: tsc clean, lint clean (src/), voice-tests 260/260, build ✓.
  - SILENT — no TestFlight-visible behavior change for un-migrated screens.
- **Done:** backlog `backend-players-db` (P3, Phase 1, SILENT) — `routes/players.py` CRUD
  migrated from JSON-file storage to Postgres `players` table (ORM revision 002_core_scoring).
  - Rewrote all five endpoints (GET list, GET id, POST, PUT, DELETE) to use the async SQLAlchemy
    session (`async with async_session() as db`), filtering every query by `owner_id == current_user_id`.
  - camelCase Pydantic contract (SavedPlayer / PlayerCreate / PlayerUpdate) preserved unchanged;
    ORM → Pydantic mapping in `_orm_to_pydantic`.
  - Removed `players_storage = JSONStorage("players.json", SavedPlayer)` from `storage.py` and
    removed `SavedPlayer` from that file's late import.
  - Removed the 11-player seeding block from `seed_default_data`; course seeding remains
    (rounds/tournaments/courses migrate in later items).
  - Gates: ruff clean, AST parse OK, tsc clean, voice-tests 260/260, build OK.
  - Functional DB verification deferred to EC2 deploy (DATABASE_URL not set locally; import
    of app.main already required DATABASE_URL pre-change due to caddie/shots/pins routes).
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `backend-rounds-scores-db` (P4, Phase 1, SILENT) — `routes/rounds.py` round +
  normalised scores/players/groups/games migrated to Postgres (ORM revision 002_core_scoring).
  - All 6 endpoints rewritten (GET list, GET id, POST create, PUT update, POST scores upsert,
    POST complete, DELETE) using async SQLAlchemy session, owner_id scoping via `current_user_id`.
  - Normalisation: rounds row (JSONB holes), round_players (player_id + handicap + group_id),
    player_groups, scores (upsert on constraint `scores_round_player_hole_uq` via pg_insert
    ON CONFLICT), games (round_id FK).
  - Reassembly: `_build_full_round` joins players table for names; falls back to "Unknown" for
    deleted-roster players (cross-domain plain-text FK, per spec §C loosely coupled).
  - Tournament linkage: POST adds round_id to tournament.round_ids JSONB; DELETE removes it;
    `flag_modified` used to mark JSONB list changes to SQLAlchemy session.
  - Pydantic `Game` model updated: added `roundId: Optional[str] = None` and
    `teams: Optional[list] = None` (closes review follow-up; aligns with types.ts Game.roundId
    + Game.teams, avoids silent data loss for team-format games).
  - Removed `rounds_storage = JSONStorage("rounds.json", Round)` from `storage.py`.
  - Fixed `routes/tournaments.py`: removed broken `rounds_storage` import; tournament-delete
    round cleanup deferred to `backend-tournaments-db` (Postgres rounds' FK is SET NULL).
  - Gates: ruff clean, `import app.main` clean (no live DB), tsc clean, voice-tests 260/260,
    build OK.
  - Functional DB verification deferred to EC2 deploy (DATABASE_URL not set locally).
  - Pre-existing frontend lint issue in `ios/App/App/public/_next/static/` (compiled Capacitor
    assets not excluded from ESLint) and `src/app/players/page.tsx` (pre-existing setState-in-effect
    warning) — both unrelated to this item.
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `backend-tournaments-db` (P5, Phase 1, SILENT) — `routes/tournaments.py` CRUD
  migrated from JSON-file storage to Postgres `tournaments` table (ORM revision 002_core_scoring).
  - All 6 endpoints rewritten (GET list, GET id, POST create, PUT update, DELETE, POST players/{id})
    using async SQLAlchemy session, owner_id scoping via `current_user_id`.
  - `id` is now a real UUID (`str(uuid.uuid4())`), so rounds can FK to tournaments via
    `rounds.tournament_id` — the guarded linkage in `create_round` activates automatically.
  - `playerNamesById` derived on read via a join to the `players` table (owner-scoped, same
    pattern as `_build_full_round` in rounds.py). No separate JSONB column needed; falls back to
    "Unknown" for deleted-roster players. `player_name` query param on add-player is still accepted
    for API compat but no longer stored (players table is source of truth for names).
  - Tournament-scoped games loaded from the `games` table (tournament_id FK, round_id NULL);
    wholesale-replaced (delete-then-insert) on PUT when data.games is supplied.
  - DELETE cascades to tournament-scoped games (FK ondelete='CASCADE'); linked rounds have
    tournament_id SET NULL (FK ondelete='SET NULL') — round rows preserved.
  - Removed `tournaments_storage = JSONStorage("tournaments.json", Tournament)` from `storage.py`
    and removed `Tournament` from that file's late import.
  - Gates: ruff clean, `import app.main` clean (no live DB), tsc clean, voice-tests 260/260,
    build OK.
  - Functional DB verification deferred to EC2 deploy (DATABASE_URL not set locally).
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `backend-courses-db` (P6, Phase 1, SILENT) — `routes/courses.py` scoring
  courses migrated from JSON-file storage to Postgres `scoring_courses` table (new Alembic
  migration `006_scoring_courses`).
  - New Alembic revision `006_scoring_courses` (file `0003_006_scoring_courses.py`): creates
    `scoring_courses` table — id (UUID), owner_id (Text nullable), name (Text), location
    (Text nullable), holes (JSONB — list of HoleInfo), tees (JSONB nullable — list of TeeOption),
    created_at, updated_at. Owner index: `scoring_courses_owner_id_idx`.
  - New ORM class `ScoringCourse` added to `backend/app/db/models.py` with matching columns.
    Intentionally separate from the PostGIS `courses`/`tee_sets`/`holes` tables (caddie/import,
    migration 001 baseline) — unification is a deliberate future refactor.
  - Rewrote all 5 endpoints in `routes/courses.py` (GET list, GET {id}, POST, POST /default,
    DELETE) using `async with async_session() as db`, filtering every query by
    `owner_id == current_user_id`. camelCase Pydantic contract (Course / CourseCreate /
    HoleInfo / TeeOption) preserved unchanged; ORM → Pydantic mapping in `_orm_to_pydantic`.
  - Removed `courses_storage = JSONStorage("courses.json", Course)` from `storage.py`.
  - `seed_default_data` is now a no-op (all 4 domains Postgres-backed): kept as empty function
    body with comment, the startup call in `main.py` removed to avoid dead code.
  - Follow-up note added to `specs/real-data-wiring-plan.md`: course-identity unification
    (scoring_courses vs mapped-courses PostGIS tables) deferred as a future refactor.
  - Mapped-courses path (`routes/courses_mapped.py`, `services/courses_mapped`) untouched.
  - Gates: ruff clean, `DATABASE_URL=... alembic upgrade head --sql` renders `scoring_courses`
    table cleanly, `import app.main` clean, tsc clean, voice-tests 260/260, build OK.
  - Functional DB verification deferred to EC2 deploy (DATABASE_URL not set locally).
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `backend-profile-endpoint` (P7, Phase 1, SILENT) — new `routes/profile.py`
  (`GET/POST/PUT /api/profile/golfer`) backed by the `golfer_profiles` Postgres table; frontend
  client un-stubbed.
  - Shape reconciliation: ORM `golfer_profiles` (migration 002_core_scoring) lacked `name` (display
    name) and a free-text `home_course` field (had only `home_course_id`, a course-ID reference).
    Frontend `GolferProfile` (types.ts) requires `name` (str), `handicap` (float|null),
    `homeCourse` (str|null), `clubDistances` (JSONB dict).
  - New Alembic revision `007_golfer_profile_fields` (`0004_007_golfer_profile_fields.py`): adds
    `name TEXT NULL` and `home_course TEXT NULL` to `golfer_profiles`. `home_course_id` kept for
    future caddie cross-reference. Revision chain: 007 revises 006_scoring_courses.
  - ORM `GolferProfile` updated (`db/models.py`): added `name: Optional[str]` and
    `home_course: Optional[str]` mapped columns.
  - Pydantic models added to `models.py`: `GolferProfile` (response), `GolferProfileCreate`
    (POST body), `GolferProfileUpdate` (PUT body). All camelCase: `handicap` ← `handicap_index`,
    `homeCourse` ← `home_course`, `clubDistances` ← `bag_clubs`.
  - New `backend/app/routes/profile.py`:
    - `GET /api/profile/golfer` — returns 200+body when profile exists, 204 No Content when none.
    - `POST /api/profile/golfer` — create; 409 if already exists.
    - `PUT /api/profile/golfer` — upsert (create or partial-update). Preferred for saves.
    - Owner scoping: `user_id == current_user_id`; `require_owner` gate applied in `main.py`.
  - `main.py`: registered `profile.router` under `_owner_only` dependencies.
  - Frontend `api.ts`: replaced null-return/throw stubs with real HTTP calls.
    - `getGolferProfileAsync()` — GET; handles 204 → null; auth-checks before calling.
    - `createGolferProfile(data)` — POST with typed `GolferProfileCreate` body.
    - `updateGolferProfile(data)` — PUT with typed `GolferProfileUpdate` body (upsert).
    - `GolferProfile` re-exported from api.ts.
  - Frontend `storage-api.ts`: `getGolferProfileAsync` / `saveGolferProfileAsync` now API-
    authoritative (API call + write-through to localStorage on success; localStorage fallback
    on API failure with `console.error`). `saveGolferProfileAsync` calls `updateGolferProfile`
    (PUT upsert). Removes the `// TODO(backend-profile-endpoint)` stubs.
  - Profile UI page (`app/profile/page.tsx`) intentionally untouched — that is a later `wire-profile-*` item.
  - Gates: ruff clean, `alembic upgrade head --sql` renders 007 columns cleanly,
    `import app.main` clean (DATABASE_URL=fake), tsc clean, voice-tests 260/260.
  - Functional DB verification deferred to EC2 deploy.
  - SILENT — no TestFlight-visible change; `useGolferProfile` hook not imported by any screen yet.
- **Done:** backlog `json-to-db-backfill` (P9, Phase 1, SILENT) — one-off idempotent
  migration script `backend/scripts/backfill_core_data.py` that imports all four
  `backend/data/*.json` files into Postgres and retires the stale JSON files.
  - Reads players.json → `players`, courses.json → `scoring_courses`,
    tournaments.json → `tournaments` + tournament-scoped `games`,
    rounds.json → `rounds` + `round_players` + `player_groups` + `scores` + round-scoped `games`.
  - Legacy non-UUID ids (e.g. `player-ryan-murphy`, `course-augusta`) are mapped to
    deterministic UUID v5 values (namespace=NAMESPACE_URL) so every re-run produces
    the same DB primary key for the same source record.
  - Cross-table remapping: player_id_map, course_id_map, tournament_id_map built in
    order; round.courseId / round.tournamentId / player references all remapped.
    Second pass patches tournament.round_ids with new round UUIDs after rounds import.
  - Upserts: players/courses/tournaments/rounds/games use ON CONFLICT (id) DO UPDATE;
    round_players uses ON CONFLICT ON CONSTRAINT round_players_round_player_uq;
    scores uses ON CONFLICT ON CONSTRAINT scores_round_player_hole_uq. Fully
    idempotent — re-runs skip/update without duplicating.
  - Owner assignment: --owner-id CLI arg (falls back to $OWNER_CLERK_USER_ID); fails
    with a clear error if neither is supplied.
  - Dry-run: --dry-run prints the full import plan (UUIDs per record) with NO DB
    connection. Demonstrated: 11 players + 3 courses → deterministic UUIDs shown.
  - File retirement: after successful commit renames data/<name>.json →
    data/<name>.json.imported (never hard-deletes); idempotent re-runs no-op cleanly.
  - Deploy runbook line: `cd backend && DATABASE_URL=<RDS_URL> uv run python -m scripts.backfill_core_data --owner-id $OWNER_CLERK_USER_ID`
  - Gates: ruff clean, import clean (DATABASE_URL fake), dry-run demo clean (no DB),
    tsc clean, voice-tests 260/260.
  - SILENT — no TestFlight-visible change; script runs once on EC2 deploy box.
- **Done:** backlog `test-games-engine` (P2, SILENT) — 46 unit tests for `lib/games.ts`
  via Vitest (already a devDep + `test` script; no new dependencies added).
  - New file: `frontend/src/lib/games.test.ts` (picked up by `vitest.config.ts` pattern
    `src/**/*.test.ts`).
  - Covers all 7 exported compute* functions + the `computeGameResults` dispatcher:
    skins (7 tests), bestBall (4), nassau (5), threePoint (5), stableford (5),
    matchPlay (5), wolf (7), dispatcher (8). Total: 46 tests, 46 pass.
  - Edge cases: carryover multi-tie chains, partial rounds, ties (null winner),
    lone-wolf win/loss (+3/-3), partner mode win/loss (+1 each), match-play early end
    ("10 & 8"), NO_SCORE holes, empty playerIds falling back to round.players,
    modifiedStableford routing to computeStableford, unimplemented format → {}.
  - Documented stub: nassauMode='match' always uses stroke totals (P21 pending) —
    asserted as current behavior, marked with a STUB comment, NOT fixed.
  - No bugs found that warrant stopping; all format outputs match expected behavior.
  - Gates: npm test 46/46 pass, lint clean (src/), tsc --noEmit clean,
    voice-tests 260/260 pass, npm run build OK.
  - SILENT — runtime-neutral (test file only, no app code modified, no lib/games.ts
    changes).
- **Done:** backlog `test-voice-pipeline` (P30, SILENT) — unit tests for the voice
  pipeline's schemas + normalization, complementing the integration harness.
  - New files (no app code touched):
    - `frontend/src/lib/voice/parseVoiceScores.test.ts` — 46 tests for `parseVoiceScoresLocally`:
      STT number-word normalization (ford/fore/four/ate/won/too/to/tree → integers), all six
      score-phrasing patterns (made a / got a / with a / shot a / shot / bare), golf-term
      scoring (birdie/eagle/bogey/double/par at any par value), everyone-par (8 variants
      incl. "all bogey" / "everybody double"), conjunction splitting (and / comma / then /
      no-punctuation chains), nickname resolution (jt→Justin, mike→Michael, bob→Robert),
      collision guard (PR #47): when "JT" is a literal player "jt" matches JT not Justin,
      edge cases (empty/filler/uppercase/key-casing/prefix match).
    - `frontend/src/lib/voice/schemas.test.ts` — 46 tests for Zod schemas: GameFormatSchema
      (all 8 valid formats + 3 invalid), VoiceScoreParseResultSchema (6 valid + 11 invalid
      incl. hole=0, float hole, negative/fractional score, confidence out-of-range, extra
      fields, missing required fields), ParsedGameConfigSchema, ParsedTournamentConfigSchema,
      VoiceParseResultSchema (game + tournament paths, normalization field, matchPlay settings).
    - `frontend/src/lib/voice/utils.test.ts` — 47 tests: parseSpokenNumber (27 words incl.
      all STT variants; confirms "ford" is NOT in utils WORD_NUMBERS — only in parseVoiceScores
      WORD_TO_NUM), normalizeName, clamp01, levenshtein, similarity (incl. 0.92 prefix-match
      constant), fuzzyBestMatch (custom minScore threshold), safeJsonExtract (fenced + bare JSON),
      stripFillerWords, normalizeTranscript (basketball→best ball ASR fix).
  - BUGS FOUND (not fixed — behavior-change blocked while PR #51 is in review):
    1. `parseVoiceScoresLocally` regex: `"for"` (listed in WORD_TO_NUM as 4) is absent from
       both the first-pass and second-pass capture-group alternations. "Justin with a for"
       produces no score. `parseSpokenNumber` in utils.ts DOES handle "for" → 4, so the gap
       is only in parseVoiceScores.ts's own regex alternations.
    2. `parseVoiceScoresLocally` everyone-pattern: "everybody dbl bogey" matches the regex
       (alternation has "dbl bogey") but the value-selector checks `t.includes("double")`
       (false for "dbl") and falls through to `t.includes("bogey")` → returns par+1 instead
       of par+2. Inconsistent with "dbl bogey" being in the regex.
  - Gates: npm test 230/230 pass (was 46/46 + 184 new), tsc 0 errors, voice-tests 260/260,
    build OK, new test files lint-clean.
  - SILENT — runtime-neutral (test files only, zero app/lib/voice code changes).
- **Next ready backlog items:** `frontend-lint-cleanup` (P9), `tee-time-finder` Phase 1 (P8).

## 2026-06-26 (wire-leaderboard-real)
- **Done:** backlog `wire-leaderboard-real` (P12, NOTICEABLE) — replaced `LB_MOCK` with
  real computation from `lib/games.ts` via the round's real scores.
  Key changes:
  - **Removed:** `LB_MOCK` constant (nassau/skins/threePoint hardcoded mid-round state).
  - **Tabs now dynamic:** `TABS` replaced with computed list — always "Overall" first, then
    one tab per game in `round.games` (uses game id as tab key). Tab label includes
    `game.settings.pointValue` if set (e.g. "Nassau · $20").
  - **New `round` prop on `LeaderboardSheet`:** `RoundPageClient` passes `round={round}`
    so the sheet can read `round.games` and build the engine call.
  - **Engine wiring:** `computeGameResults(engineRound, game)` called for each game;
    `engineRound` has `round.scores` replaced with the display-scores map converted to
    `Score[]` via `displayScoresToArr()` — so pending (not-yet-confirmed) scores are
    included in game computations.
  - **Nassau:** real `NassauResults` — F9/B9/overall winner grid, running totals table.
    `scope=team` uses team names from `game.teams`; `scope=individual` uses player names.
    When `nassauResults.mode === 'match'`, a calm note explains that match-play scoring
    is pending P21 and stroke totals are shown instead.
  - **Skins:** real `SkinsResults` — per-player skin count, holes won; pot-carrying
    callout computed from `holeWinners` + display scores (played-hole detection). Shows
    "up for grabs" value if `game.settings.pointValue` is set.
  - **3-Point:** real `ThreePointResults` — team A vs B scoreboard using real points;
    team names from `game.teams`.
  - **Generic fallback:** `GenericGame` handles bestBall, stableford, matchPlay, wolf, and
    unknown formats — shows a minimal score/status display in the yardage-book aesthetic.
  - **Empty states:** no games → "No games yet" prompt shown below Overall tab. No scores
    yet for a format → calm italic "Scores will appear here as you play." (or format-
    specific equivalent). Match-play Nassau shows stroke-total note (P21 pending).
  - **No new design language:** all inline styles use T.* tokens; no new deps; existing
    Tab, DotStrip, Overall sub-components preserved unchanged.
  - **Games.ts functions used:** `computeGameResults` (dispatch), `computeSkins`,
    `computeNassau`, `computeThreePoint`, `computeMatchPlay`, `computeStableford`,
    `computeBestBall`, `computeWolf` (via the dispatch switch — all formats).
  - **Data flow:** `RoundPageClient.round.games` (from backend) + display `scores`
    (pending overlay included) → `computeGameResults` → `NassauResults | SkinsResults |
    ThreePointResults | ...` → tab-specific render component.
  - **Match-play Nassau (P21):** engine comment preserved ("falls back to stroke totals");
    UI shows a note on the Nassau tab when `nassauResults.mode === 'match'`.
  - Gates: lint clean (src/), tsc clean (0 errors), voice-tests 260/260, build OK.
  - NOTICEABLE — leaderboard tabs now show real standings from entered scores; game tabs
    appear/disappear based on which games are actually on the round.
- **Done:** designer follow-up fixes for `wire-leaderboard-real` (5 must-fix + 2 polish).
  1. Safe-area top: `top: 36` → `top: "max(36px, env(safe-area-inset-top))"` (Dynamic Island).
  2. Safe-area bottom: scroll padding bottom → `paddingBottom: "max(40px, env(safe-area-inset-bottom))"` (home indicator).
  3. Close button hit area: `width:32,height:32` → `minWidth:44,minHeight:44,display:flex` (iOS 44pt min).
  4. Tab touch target: `padding:"8px 14px"` → `"12px 14px"` (~44pt height on-course).
  5. "Through hole 0" guard: `{thru > 0 ? \`Through hole ${thru}\` : "—"}`.
  6. DotStrip eagle color: inline `"oklch(0.48 0.14 280)"` → `T.eagle` (tokenized).
  7. Skins pot callout background: `rgba(26,42,26,0.02)` (invisible) → `T.paperDeep`.
  Deferred (logged, not blocking): Nassau redundant empty-state text alongside winner grid;
  3-Point scoring guide always visible even when no scores; tab-bar overflow scrollbar not
  hidden; drag handle implies swipe-to-dismiss but only backdrop-tap dismisses — flag for owner.
  - Gates: lint clean, tsc 0 errors, voice-tests 260/260, build OK.

### 2026-06-27 — Backend DB layer COMPLETE + DEPLOYED (real-data wiring Phase 0/1)
- Shipped & merged **bundle #48** to main: db-core-schema, api-contract-align, and the
  full backend domain on Postgres (players, rounds/scores, tournaments, courses, profile,
  games) via Alembic 005/006/007 + a backfill script. Every item adversarially reviewed.
- **Deploy incident (resolved):** first deploy false-greened — migration 002 actually failed
  (`asyncpg InvalidTextRepresentationError: Token "'" is invalid`) because JSONB
  `server_default`s were plain strings; deploy only checked /health. Offline `--sql` missed
  it (renders without executing). **Fixes:** (1) wrap JSONB defaults in `sa.text(...)` (#49);
  (2) harden `deploy.yml` to `set -eu` fail-fast + run alembic before restart + `uv sync` in
  backend/ (#49, #50 — `set -o pipefail` failed under dash/SSM, switched to `set -eu`).
- **Redeploy SUCCESS:** alembic applied 001→002→006→007 cleanly on the live EC2 Postgres;
  /health ok; SSM Success. Backend DB layer is LIVE.
- **Open decision:** one-time backfill of `data/*.json` — likely seed-only, recommend SKIP
  for a clean DB start unless EC2 has real owner data.
- **Next: Phase 2 (NOTICEABLE) UI wiring** — flipped `wire-round-new` (P10) + `wire-round-scoring`
  (P11) to ready; these are user-facing → TestFlight approval bundles. Lesson: add a real-DB
  migration smoke test (throwaway Postgres) to catch execution-time DDL bugs the offline gate can't.

## 2026-06-26 (wire-round-scoring — reviewer pass 3 fixes)
- **Done:** reviewer pass 3 fixes for `wire-round-scoring` (commit e7d91b5 on integration/next).
  BLOCKER #1 (FIXED):
  - Non-404 load error and 404/LOCAL paths both rendered from localStorage WITHOUT seeding
    `pendingRef`. The next successful foreground save called
    `buildLocalRound(serverSnapshot, pending={})`, permanently erasing prior-session unsynced scores.
  - Fix: new `seedPendingFromLocal(local, pending)` helper seeds ALL non-null local scores into
    `pendingRef` before the `setScores` call. Both catch branches now call it and use
    `mergeWithPending` (not bare `buildScoreMap`) so the pending overlay is active from the start.
  Fix #3 (`retrySyncPending` seq-guard race):
  - Background retry called `setRound(updated)` + `setScores(...)` without the `addScoreSeqRef`
    guard, racing concurrent foreground saves.
  - Fix: retry now only confirms pending removal (`pendingRef.current.delete(key)`) — no UI state
    application, no localStorage write. UI remains correct via pending overlay already set at load;
    next foreground save writes localStorage.
  Fix #4 (`isNotFoundOrNetworkError` too broad):
  - The JSON-parse `catch` fell back to `m.toLowerCase().includes("not found")` on arbitrary body
    text, misclassifying 5xx errors containing "not found" prose as LOCAL mode.
  - Fix: catch now returns `false`; only trust `TypeError`, the exact `"API error: 404"` string
    (changed from substring to equality), and parsed FastAPI `{"detail":"...not found..."}`.
  Fix #6 (banner backgrounds inline RGB):
  - Added `T.errorWash: "rgba(184,74,58,0.13)"` and `T.warningWash: "rgba(184,118,58,0.13)"` to
    `frontend/src/components/yardage/tokens.ts`. Both banner `background` props now reference the tokens.
  - Gates: lint clean (src/), tsc clean, voice-tests 260/260, pushed to integration/next.
  - NOTICEABLE — prior-session score preservation now correct in all three load-error paths.

## 2026-06-26 (wire-round-scoring — reviewer fixes)
- **Done:** reviewer + designer follow-up fixes for `wire-round-scoring` (same branch).
  BLOCKER fixed:
  A. **Silent permanent score loss (FIXED):** introduced `pendingRef` (Map<string,Score>,
     key="{playerId}:{holeNumber}") to track scores entered but not yet server-confirmed.
     - `mergeWithPending()`: overlays pending on every server snapshot so a failed-save
       score is never wiped by the next success.
     - `buildLocalRound()`: merges pending into the round saved to localStorage so a page
       reload re-discovers unsynced scores.
     - Pending removal: only when server confirms exact (playerId, holeNumber, strokes)
       — rapid re-entry of the same hole leaves the newer pending value intact.
     - On load: compares API response vs localStorage; re-adds any local-only scores to
       pending; fires `retrySyncPending()` (background, silently logged on failure).
  CORRECTNESS fixed:
  1. Load catch now calls `isNotFoundOrNetworkError(e)`: `TypeError` (network) or
     message contains "not found"/"API error: 404" → LOCAL mode; all other errors
     (500, auth) → stay ONLINE, show banner, render from localStorage cache.
  2. Out-of-order responses: `addScoreSeqRef` + `lastAppliedSeqRef` — each addScore
     call gets a seq; response is skipped if `mySeq ≤ lastApplied` (a newer one already
     updated state). Combined with pending overlay prevents stale snapshots from
     clobbering latest UI state.
  3. Stale closures eliminated: all LOCAL-branch and error-branch `round` mutations now
     use `setRound(prev → …)` functional updaters (reads latest state, not closed-over
     stale value). `localSaveRound` called inside the updater with latest `prev`.
  DESIGN fixed:
  4. "LOCAL" badge fontSize 7.5 → 9 (readable in sunlight).
  5. Error-banner × button: `width:28,height:28,display:'flex',alignItems:'center',
     justifyContent:'center',flexShrink:0` (adequate touch target on-course).
  6. Header course-name span: `flex:1,minWidth:0,overflow:hidden,textOverflow:ellipsis,
     whiteSpace:nowrap` — real course names no longer overflow on small viewports.
  7. Status-zone backgrounds: error `rgba(184,74,58,0.08)→0.13`, LOCAL
     `rgba(184,118,58,0.07)→0.13` — contrast for sunlight use.
  8. Hole nav chips: `Array.from({length:holeCount},…)` not hardcoded 18 — 9-hole
     rounds render 9 chips.
  9. `T.errorInk:"#b84a3a"` + `T.warningInk:"#b8763a"` registered in `tokens.ts`;
     all hardcoded hex refs in RoundPageClient replaced with token references.
  - Gates: lint clean (src/), tsc --noEmit clean, voice-tests 260/260, build OK.
  - NOTICEABLE — all fixes are behavioural + visual improvements to the scoring screen.

## 2026-06-26 (wire-round-scoring)
- **Done:** backlog `wire-round-scoring` (P11, NOTICEABLE) — `RoundPageClient.tsx` now loads
  and persists scores via the backend instead of SEED_SCORES/SEED_PLAYERS mocks.
  Key changes:
  - **Removed:** `SEED_SCORES` and `SEED_PLAYERS` constants (the mock data); `getRound`/`saveRound`
    localStorage-only imports replaced with separate API + local imports.
  - **Round loading:** async on mount — tries `api.getRound(id)` (GET /api/rounds/{id}).
    On success: populates `players` (SeedPlayer[]) and `scores` map from the server response.
    On 404 or network error: falls back to `localGetRound(id)` (localStorage), sets
    `isLocalRound = true`. If no local copy either, renders a "Round not found" screen.
  - **Orphan/offline handling (§Review follow-up carry-over):** rounds created by the
    wire-round-new offline fallback have a client UUID not known to the backend; they 404 on
    load. `isLocalRound = true` activates: scores saved to localStorage only, no API calls.
    The round is marked "LOCAL" in the header chrome and a calm amber notice is shown inline.
    Deferred: re-creating the orphan round on the backend and reconciling IDs (a full sync
    engine is out of scope for this item — noted for a follow-up).
  - **Per-stroke persist:** `handleSetScore` calls `api.addScore(roundId, {playerId, holeNumber, strokes})`
    (POST /api/rounds/{id}/scores) after an optimistic local update. On success: syncs all scores
    from the server response + write-through to localStorage. On error: surfaces via `apiError`
    banner (dismissible, #b84a3a color, no silent swallow), saves optimistic state locally.
  - **Finish round:** `handleFinish` now async — calls `api.completeRound(id)` for API-backed
    rounds; falls back to local status='completed' save on error. Local rounds save locally only.
  - **Player/score conversion:** `buildSeedPlayers()` maps `Round.players` → `SeedPlayer[]`
    (PLAYER_COLORS palette); `buildScoreMap()` maps `Round.scores Score[]` → `Record<string,
    (number|null)[]>` (indexed by hole 0–17). Hole nav chips use first player's score to show
    "played" indicator (was hardcoded to 'p1').
  - **par for scoring:** prefers `round.holes[currentHole-1].par` (authoritative); falls back
    to `HOLES[currentHole-1].par` (illustration constant). `PlayerPanel` and `LeaderboardSheet`
    receive round's holes pars array (fallback to HOLES pars if round.holes is empty).
  - **UX preserved:** all inline styles use `T.*` tokens; no new design language; yardage-book
    feel intact. Footer changed from hardcoded "Pebble Beach Golf Links · 6,828 yds · Par 72"
    to real `round.courseName · N holes · teeName tees`.
  - **No-round state:** renders a calm not-found screen (T.serif italic message + back button)
    instead of a broken/empty scorecard.
  - **Designer flag:** "LOCAL" badge and amber notice use `#b8763a` (warm ink, not generic red)
    — consistent with the yardage-book palette; designer should verify against NORTHSTAR.
  - Deferred sync follow-up added as note in code (orphan round re-creation on backend).
  - Gates: lint clean (src/), tsc --noEmit clean, voice-tests 260/260, npm run build OK.
  - NOTICEABLE — user-visible on TestFlight: scoring screen now loads real round data and
    persists each stroke to the backend.

## 2026-06-26 (wire-round-new — follow-up fixes)
- **Done:** coordinator review fixes for `wire-round-new` (same branch, amend-style commit).
  BLOCKERS:
  1. **Error handling (BLOCKER 1):** `handleTeeOff` catch now distinguishes `TypeError`
     (network-down = offline fallback OK) from `Error` (HTTP 4xx/5xx = show `createError`
     banner, no local round fabricated).
  2. **Player de-dup (BLOCKER 2):** `deduped` filter added after `roundPlayers` assignment
     — prevents duplicate `round_players` rows when voice maps the same name twice to one
     saved player id.
  3. **VoiceRoundSetup restyled (BLOCKER 3):** full rewrite — `T.*` tokens, `PAPER_NOISE`
     background, inline SVG mic/close/refresh, `Waveform` from `Voice.tsx`. No more
     `bg-zinc-950`, `bg-emerald-500`, or lucide-react.
  4. **CourseSearch restyled (BLOCKER 4):** bottom sheet on `T.paper` (was `fixed inset-0
     bg-zinc-950/95`); drag handle; T.serif/T.mono headers; dashed-border result rows;
     inline SVG search/mapPin/close; loading pulse animation.
  5. **PlayerAutocomplete restyled (BLOCKER 5):** `T.paperDeep` input, `T.paper` dropdown,
     `T.ink` avatar circle, `DEFAULT_ACCENT` match highlight via inline style (no
     `text-emerald-300`); no lucide-react; keyboard hint footer removed. Player picker sheet
     reverted from `T.ink` to `T.paper` background (header colors updated to T.ink/T.pencil).
  SHOULD-FIX:
  6. Disabled hint "Add a player above to start" shown below Tee off button when not ready.
  7. "+ Add" button touch target raised to minHeight 44px.
  8. Mic button: 56px T.ink circle with accent ring + "Speak" T.mono label below.
  9. Quick-reply chip padding raised to 9px/13px (minHeight 38px).
  DEFER (noted, not done): footer gradient, auto-trigger after record, desktop nav hint,
  TEE_OPTIONS yardage not tied to course.
  - Gates: tsc --noEmit clean (0 errors), voice-tests 260/260 pass, npm run build OK.
  - NOTICEABLE — design overhaul is user-visible.

## 2026-06-26 (wire-round-new)
- **Done:** backlog `wire-round-new` (P10, NOTICEABLE) — replaced the scripted demo in
  `app/round/new/page.tsx` with a real round-setup flow that persists to the backend.
  Key changes:
  - Removed: scripted `useEffect` auto-typing demo, hardcoded `utter`/`course`/`players`
    constants, `heardCourse`/`heardJack`/`heardSam` detection, `saveRound` to localStorage.
  - Added `selectedCourse: SelectedCourse | null` state; course card now shows empty state
    ("Tap to search") or selected course info (name, location, par/holes); tapping opens
    `CourseSearch` overlay (full-screen dark modal — existing component, unchanged).
  - Added `players: Player[]` (min 1 slot) + `savedPlayers: SavedPlayer[]` state; loaded
    on mount by calling `getPlayers()` (API) with `getSavedPlayers()` (localStorage) fallback.
    Each player row is tappable and opens a dark picker sheet hosting `PlayerAutocomplete`
    (the dark Tailwind theme works correctly against the ink-colored sheet background).
    Auto-closes when a saved player is selected by click/enter; "Done" button for typed names.
    "+ Add" button appends a new slot and opens the picker for it.
  - Voice path: mic button opens `VoiceRoundSetup` overlay (existing component, unchanged);
    `onSetupRound({courseName, playerNames, teeName})` callback populates selectedCourse,
    players (linked to savedPlayers where name matches), and tee; then displays a conversation
    summary in the caddy-bubble surface with quick-reply chips for "Change game", "Different
    tees", "Add a player".
  - `handleTeeOff`: calls `api.createRound(...)` directly (POST /api/rounds); backend assigns
    its own UUID as the round id. Server-returned round is write-through cached to localStorage
    (`localSaveRound(created)`), then navigates to `/round/${created.id}` (server id, not
    client). Offline fallback: if API throws, generates a client UUID, saves locally, navigates.
    This is the §"Review follow-ups" reconciliation for wire-round-new.
  - Game objects built in `handleTeeOff` from the selected GameId (mapped via
    `GAME_ID_TO_FORMAT` to `GameFormat`); `roundId: ''` placeholder used on create (backend
    assigns real FK). Stroke/None produce no game object.
  - Yardage-book aesthetic preserved: all inline styles use `T.*` tokens; no new Tailwind
    in the main page; sub-components (PickerRow, GamePicker, TeePicker, SidesPicker,
    HolesPicker, MiniStat) kept with identical styling.
  - Designer note: `VoiceRoundSetup` and `CourseSearch` overlays use dark Tailwind styling
    (zinc/emerald), not yardage tokens — acceptable as modal interactions but flagged for a
    future design-pass to restyle them with T.* tokens.
  - Gates: lint clean (src/), tsc --noEmit clean, voice-tests 260/260, npm run build OK.
  - NOTICEABLE — user-visible on TestFlight: the scripted demo is gone; real round setup
    with backend persistence replaces it.

## 2026-06-27 (wire-home)
- **Done:** backlog `wire-home` (P13, NOTICEABLE) — `app/page.tsx` home screen now loads
  real data from the backend via the storage-api.ts API-authoritative pattern.
  Key changes:
  - **Removed:** `SAMPLE_RECENT`, `STATS`, `HDCP`, `FEED` mock constants (5 hardcoded entries,
    fake handicap/scoring stats, fake social feed). `initializeStorage` + sync `getRounds`
    localStorage imports replaced with async `getRoundsAsync`/`getTournamentsAsync`/
    `getGolferProfileAsync` from `storage-api.ts`.
  - **Recent rounds:** async-loaded from `GET /api/rounds` (owner-scoped). Rounds sorted
    most-recent-first; top 5 shown. Each row derived via `deriveRecentRows()`: date formatted
    (month + day), course name, total strokes + toPar net via `calculateTotals()` from
    `types.ts`, holesPlayed count, "T" tag for tournament rounds, "Live" badge for active
    rounds. Rows are now tappable and navigate to `/round/{id}`.
  - **Handicap:** from `GET /api/profile/golfer` → `profile.handicap`. Shows "—" when null
    (no profile or no handicap set). Also displayed on the profile card (was hardcoded "77").
    Sparkline removed (no historical handicap series available yet — flagged for
    wire-profile-stats item).
  - **Scoring average:** derived client-side from the loaded rounds list via `deriveScoringAvg()`
    — averages total strokes over completed rounds with ≥9 holes played. Shows "—" when
    insufficient data. Trend arrow removed (requires historical handicap series).
  - **Fairways / GIR / Putts:** all show "—". Per-hole shot data is not tracked yet; these
    three stats require a per-shot data source. Flagged for a future wire-profile-stats item.
  - **Tournament link:** `QuickAction "Tournament"` and the Trophy Case block both route to
    `GET /api/tournaments` most-recent tournament (`/tournament/{id}`) rather than the
    hardcoded `/tournament/sunday-cup-2024`. If no tournament exists, the quick-action routes
    to `/tournament/new` and the Trophy Case shows a calm "No tournaments yet — Start one →"
    empty state.
  - **Social feed ("From the group") — REMOVED:** no real data source exists for a social
    feed. The `FEED` constant was fabricated (Jack/Sam/Justin). Removed entirely rather than
    show fake data. Decision logged in code comment for the designer/owner; re-introduce when
    a real activity stream is backed by the API.
  - **Empty states:** new user with no rounds sees a calm serif italic "No rounds yet. Tap
    'Start a round' above to begin." empty state inside the rounds section. Stats section
    shows "—" for all missing values. Trophy case shows calm empty state with "Start one →"
    CTA.
  - **Live round:** detection moved from sync `getRounds()` (localStorage only) to the async
    loaded rounds list — active round is found from the same API-authoritative fetch.
  - **Loading state:** `loading` boolean guards the stats/rounds sections so "—" is shown
    (not stale/wrong) while the API call is in flight.
  - **Error surfacing:** uses `storage-api.ts` explicit-offline-cache pattern — API is
    authoritative; on failure `console.error` is logged + localStorage fallback returned.
    No silent swallowing.
  - **Yardage-book feel preserved:** all inline styles use T.* tokens; no new dependencies
    or design language; serif/mono typography and paper/ink palette unchanged; motion pulsing
    mic CTA retained.
  - **Decisions for designer/owner review:**
    1. Sparkline removed — bring back when handicap history is available (wire-profile-stats).
    2. Trend arrow removed — same reason.
    3. Social feed removed — no backend; re-add when a real activity stream exists.
    4. Fairways/GIR/Putts show "—" — requires per-shot tracking (future item).
    5. "San Francisco" and "66°F, wind WNW 8. Presidio tee times open from 10:40." in masthead
       are still hardcoded — location/weather wiring is out of scope for this item.
  - **Gates:** lint clean (`src/app/page.tsx` 0 errors), tsc --noEmit 0 errors,
    voice-tests 260/260 pass, npm run build OK.
  - NOTICEABLE — user-visible on TestFlight: home screen shows real rounds, real handicap,
    real tournament link; no fabricated data.

## 2026-06-27 (wire-home reviewer + designer follow-up fixes)
- **Done:** reviewer + designer follow-up fixes for `wire-home` (one commit on integration/next).
  BLOCKERS fixed:
  1. **Hardcoded city + weather removed:** "San Francisco" header div and "66°F, wind WNW 8.
     Presidio tee times open from 10:40." subtitle both deleted. Masthead now shows only the
     time-of-day greeting. No location/weather data source exists — showing nothing is honest.
  2. **"to par avg" math fixed:** replaced `scoringAvg - handicap` (nonsense) with real
     `toParAvg` derived from `calculateTotals().toPar` over the same eligible rounds. Renamed
     `deriveScoringAvg` → `deriveScoringStats` (returns `{avg, toParAvg}`); both stats use the
     same eligible set so they are consistent. Display hidden when no eligible rounds.
  3. **Profile card Dynamic Island fix:** `top: 14` → `top: "max(14px, env(safe-area-inset-top))"`.
     Card now clears the notch/Dynamic Island on iPhone 14/15/16 Pro.
  4. **Dead "All" button removed:** no /rounds index page; button had cursor:pointer but no
     onClick — confusing on-device. Removed. Section heading still present.
  5. **Fairways/Greens/Putts row hidden:** removed the 3-stat grid showing three permanent "—"
     values. Per-shot tracking not available yet. `StatBit` helper also removed (now unused).
     Handicap + Scoring avg remain as they fill from real data.
  SHOULD-FIX done:
  6. **Round row touch target:** `minHeight: 44` on each round row button (44pt iOS minimum).
  7. **Bottom safe-area:** `paddingBottom: "env(safe-area-inset-bottom, 16px)"` on the inner
     container so the last block clears the home indicator.
  8. **Owner-is-players[0] comments:** added at both `players[0]` usages in `deriveRecentRows`
     and `deriveScoringStats`, noting single-owner beta assumption and revisit note.
  - Gates: lint 0 errors (src/app/page.tsx), tsc 0 errors, voice-tests 260/260, build OK.
  - NOTICEABLE — fixes are user-visible: Dynamic Island clearance, correct to-par number,
    no fake weather, cleaner stats block.

## 2026-06-27 (wire-profile-identity)
- **Done:** backlog `wire-profile-identity` (P14, NOTICEABLE) — profile masthead (name,
  home course) + handicap index wired to `GET /api/profile/golfer`; editable via
  `PUT /api/profile/golfer` with write-through localStorage cache.
  Key changes:
  - **`types.ts`:** `GolferProfile.name` changed `string` → `string | null` to match the
    backend's `Optional[str]`. Callers that assumed non-null now safely use `?? '—'`.
  - **`api.ts`:** `GolferProfileUpdate.name/handicap/homeCourse` typed as `T | null` to
    allow explicit null (intentional field clear). Comment explains omitted = no-change,
    null = clear.
  - **`storage-api.ts` (null-clear fix — review follow-up):** removed `?? undefined`
    coercion from `saveGolferProfileAsync`. `handicap: profile.handicap ?? undefined` →
    `handicap: profile.handicap` (same for homeCourse). Null now flows as `"handicap":null`
    in the JSON body so the backend can see it in `model_fields_set`.
  - **`backend/app/routes/profile.py` (null-clear fix):** PUT partial-update logic changed
    from `if data.field is not None:` → `if "field" in data.model_fields_set:`. This
    distinguishes "omitted" (no change) from "sent as null" (clear the value). Affects
    name, handicap, homeCourse, clubDistances.
  - **`app/profile/page.tsx` — real data wiring:**
    - Uses `getGolferProfileAsync` / `saveGolferProfileAsync` from `storage-api.ts` in
      a `useEffect` (NOT the `useGolferProfile` hook which calls `useAuth()` and breaks
      Next.js static prerender).
    - `Masthead`: name + home course now show real values from profile (or "—" when
      null/loading). Editable in-place via `<input>` styled with T.serif/T.mono to
      match the yardage-book feel. "Edit" button in masthead header; Save/Cancel replace
      it in edit mode. iOS safe-area top (`max(14px, env(safe-area-inset-top))`) unchanged.
      All buttons minHeight 44px (iOS 44pt touch target). caddyNo/ghin/memberSince
      remain as placeholder mocks (not in GolferProfile type yet).
    - `HandicapModule`: big handicap index number wired to real `profile.handicap`
      (shows "—" when null). Editable in edit mode via decimal `<input>`. Empty state:
      "No handicap set — tap Edit to add one." when null. Trend badge / sparkline /
      low-high / differential still mock stats (wired in wire-profile-stats P16).
    - `IdentityDraft` type: `{ name: string; homeCourse: string; handicap: string }` —
      a string-form draft for all three editable fields, parsed to typed values on save.
    - Validation: handicap parsed as float; empty = null (clear); non-numeric = error
      shown inline above Save button (T.errorInk color, no silent swallow).
    - **Null-clear end-to-end:** clearing handicap/homeCourse to empty and saving now
      sends `{"handicap":null}` (not omitted), backend model_fields_set fires, column
      written to NULL — field is cleared. Round-trip confirmed by code review.
    - Bag / StrokesGained / FairwayFan / ScoringByTee / YearLog / Recent: untouched.
      All still use PP_* mock constants (wire-profile-bag P15 / wire-profile-stats P16).
  - Gates: tsc 0 errors, lint clean (modified files), ruff clean (backend), voice-tests
    260/260 pass, npm run build OK (profile page prerenders as static shell ○).
  - NOTICEABLE — user-visible on TestFlight: profile masthead + handicap show real data;
    owner can tap Edit, set name/home course/handicap, tap Save — persists to the backend.
  - Designer flags: edit inputs are underline-only (yardage-book minimal); edit mode
    spans masthead+handicap simultaneously (single Save); caddyNo card is placeholder
    pending a GolferProfile extension. Mock stats sections (sparkline, trend, SG, bag)
    are still visible alongside real identity data — designer to confirm this is OK
    or flag to hide until wire-profile-stats lands.

## 2026-06-27 (wire-profile-bag)
- **Done:** backlog `wire-profile-bag` (P15, NOTICEABLE) — Bag section in `app/profile/page.tsx`
  replaced from "(Preview) / Coming soon" placeholder to a real, editable club-distances list
  backed by `GolferProfile.clubDistances` (PUT /api/profile/golfer).
  Key changes:
  - **`storage-api.ts`:** new `saveGolferBagAsync(clubDistances)` function — sends ONLY
    `clubDistances` to `api.updateGolferProfile()`; identity fields (name/handicap/homeCourse)
    intentionally omitted. Complementary to `saveGolferProfileAsync` which omits clubDistances.
    Both exploit the backend's `model_fields_set` omit=no-change contract so the two editors
    never clobber each other. Write-through to localStorage (merges into cached profile if
    present). Re-throws API 4xx/5xx; keeps TypeError (network-down) silent.
  - **`app/profile/page.tsx`:**
    - Removed `PP_BAG` mock constant + `BagClub` type.
    - Added `CLUB_CONFIG` (15 entries, camelCase keys matching `GolferProfile.clubDistances`,
      display labels: Driver, 3-wood, 5-wood, Hybrid, 4-iron … LW (60°), Putter). Same keys
      CaddiePanel's `normalizeClubDistances` reads, so real bag feeds caddie yardage suggestions.
    - Replaced old `Bag({ accent })` with `Bag({ accent, profile, loading, onBagSaved })`.
    - View mode: shows only clubs that have a value set (proportional distance bar + yardage,
      accent color for longest club, T.ink opacity 0.7 for others). Empty state when none set:
      "No distances set — tap Edit to add your clubs." (calm T.pencilSoft italic).
    - Edit mode: all 15 clubs shown with `inputMode="numeric"` inputs (minHeight 44px per row
      for iOS 44pt touch target); "yd" label; blank = remove club. Cancel/Save buttons in
      section aside (matching identity editor button style). Save validates range (1–500).
    - Errors surfaced inline in T.errorInk (same pattern as identity editor save-error).
    - `(Preview)` badge removed from the Bag section — it's real now. Other sections
      (StrokesGained, FairwayFan, ScoringByTee, YearLog) remain `preview` as before (P16).
    - Edit button disabled (opacity 0.4) while profile is loading.
    - `ProfilePage` passes `profile` + `onBagSaved={(updated) => setProfile(updated)}` to Bag.
    - `distances` memoised via `useMemo([profile?.clubDistances])` so `startEditing`
      useCallback has a stable dep ref.
  - **Caddie connection:** CaddiePanel's `normalizeClubDistances` maps these same camelCase
    keys to short keys (driver→driver, threeWood→3wood, …) before calling the recommendation
    API. Real bag in the profile → real club suggestions in the caddie.
  - Gates: lint 0 errors (src/), tsc 0 errors, voice-tests 260/260 pass, build OK.
  - NOTICEABLE — user-visible on TestFlight: bag section shows real distances + is editable.

## 2026-06-27 (wire-profile-bag designer follow-up)
- **Done:** designer follow-up fixes for `wire-profile-bag` (one commit on integration/next).
  MUST-FIX:
  1. **Bottom Save/Cancel row (FIXED):** editing 15 club rows (~660px) pushed the header-aside
     Save/Cancel off-screen on iPhone SE/mini. Added a second Cancel + Save row at the BOTTOM
     of the edit-mode div, separated by `1px solid T.hairline`, `justifyContent: flex-end`.
     Also includes the error span (with `flex: 1` so it doesn't crowd the buttons), identical
     button styling to the header pair. Golfers editing SW/LW/Putter can now save without
     scrolling up blind.
  POLISH:
  2. **Bar height 8 → 10** — matches ScoringByTee; more readable in sunlight.
  3. **Legend "Longest" entry** — added accent-color swatch + "Longest" label alongside
     "Distance" in the view-mode legend footer. Existing "Distance" swatch now `opacity: 0.7`
     to match how non-longest bars render.
  4. **Putter caveat** — CLUB_CONFIG label: "Putter" → "Putter (optional)". Hint text
     extended: "Putter distance isn't used for club recommendations."
  5. **Error span maxWidth clamp** — header-aside error span gets `maxWidth:120, overflow:hidden,
     textOverflow:ellipsis, whiteSpace:nowrap`.
  - Gates: lint 0 errors, tsc 0 errors, voice-tests 260/260, build OK.
  - NOTICEABLE — all fixes are user-visible on device.

## 2026-06-27 (wire-profile-identity reviewer/designer follow-up)
- **Done:** reviewer + designer follow-up fixes (one commit on integration/next).
  CORRECTNESS (reviewer):
  A. **Save-failure swallow (FIXED):** `saveGolferProfileAsync` now re-throws on non-network
     errors (4xx/5xx). `TypeError` (offline) stays silent + cache-only; any other error is
     re-thrown so `handleSave`'s catch shows `saveError` and does NOT close edit mode.
  B. **clubDistances clobber (FIXED):** removed `clubDistances` from the PUT body in
     `saveGolferProfileAsync`. Omit = no-change contract (model_fields_set) means the bag
     is never touched by the identity save. Bag wired in P15.
  SHIP-BLOCKERS — honest shell:
  1. Removed fake kicker "№ 77 · Member since 2019".
  2. Removed fake GHIN/caddy card. Identity block is now single-column.
  3. Removed fake trend badge "↓ 0.6 · 90d".
  4. Replaced "Lowest since 2019." with "Post a score to track your trend."
  5. Footer "GHIN · verified" → "Looper · {date}".
  6. PP_RECENT (5 fake rounds) → calm empty state: "No rounds yet — start a round..."
  7. Fake sparkline + Low/High/Differential → "Available after posting scores."
  8. StrokesGained / FairwayFan / Bag / ScoringByTee / YearLog all get `preview` prop
     → Section shows "(Preview)" mono badge. Bag "✎ Edit" → non-interactive "Coming soon".
  POLISH:
  9. Name + home course use `opacity: loading ? 0 : 1` (no layout jump).
  10. Home course edit underline: `T.hairline` → `1.5px solid T.ink` (consistent with name).
  11. "+ Post score" button disabled (opacity 0.4, cursor default, T.hairline border).
  12. "Edit" pill adds `minWidth: 44`.
  CLEANUP: PP_PLAYER / PP_HANDICAP / PP_RECENT constants removed. HandicapSpark removed.
  `accent` removed from Masthead + HandicapModule (genuinely unused after cleanup).
  - Gates: tsc 0 errors, lint 0 errors, ruff clean, voice-tests 260/260, build OK.
  - NOTICEABLE — honest shell: real identity + edit, "(Preview)" on mock sections.

## 2026-06-27 (wire-players-page)
- **Done:** backlog `wire-players-page` (P17, NOTICEABLE) — `app/players/page.tsx` wired to
  `/api/players` (GET/POST/PUT/DELETE); seed path removed; calm empty state; yardage-book
  redesign to match home/profile pattern.
  Key changes:
  - **`storage-api.ts`:** Added 4 player wrapper functions following the established pattern:
    - `getPlayersAsync()` — tries `api.getPlayers()` when authenticated; `console.error` +
      localStorage fallback on API failure; localStorage-only when not authenticated.
    - `createPlayerAsync(data)` — API-authoritative; throws when not authenticated or on API
      error; write-through to localStorage on success via `localCache.saveSavedPlayer()`.
    - `updatePlayerAsync(id, data)` — same pattern as create; write-through on success.
    - `deletePlayerAsync(id)` — API-authoritative; calls `api.deletePlayer(id)` first then
      updates local cache; throws on any API error (lets page roll back optimistic update).
  - **`app/players/page.tsx` — full rewrite:**
    - Removed imports: `getSavedPlayers`, `saveSavedPlayer`, `deleteSavedPlayer`,
      `initializeStorage` from `@/lib/storage`. Page no longer seeds the 11 fake players.
    - Added imports: `getPlayersAsync`, `createPlayerAsync`, `updatePlayerAsync`,
      `deletePlayerAsync` from `@/lib/storage-api`; `T`, `PAPER_NOISE` from tokens.
    - Async `useEffect` load: calls `getPlayersAsync()`, surfaces `loadError` banner on failure.
    - `handleDelete`: optimistic remove from state → `deletePlayerAsync(id)` → rollback on
      error + surface `deleteError` banner. Player re-inserted at top on rollback.
    - `handleSave`: async — calls `updatePlayerAsync` (edit) or `createPlayerAsync` (add);
      reconciles state with server-returned `SavedPlayer` (uses backend-assigned id/timestamps
      for creates). Errors bubble to the modal (modal stays open, shows inline error).
    - `PlayerModal`: `onSave` prop changed to `Promise<void>`; modal manages its own `saving`
      + `error` state; inputs disabled while saving; submit button shows spinner; stays open
      on API error so user can retry or cancel.
    - **Empty state:** "No players yet" / "Add the people you golf with." (exact spec text).
    - **SwipeableRow `confirmMessage`:** passes player name — "Remove {name} from your
      players?" — so the confirm dialog is specific (SwipeableRow already has confirm-on-delete).
    - **Yardage-book redesign:** full conversion from dark-mode Tailwind classes to T.* inline
      styles matching the home/profile pattern: paper background + PAPER_NOISE, ink text,
      hairline borders, T.serif heading, T.mono labels, T.paperDeep inputs. No new deps.
    - **iOS safe-area:** `padding: "max(14px, env(safe-area-inset-top)) 20px 14px"` on header;
      `paddingBottom: "max(80px, calc(80px + env(safe-area-inset-bottom)))"` on shell.
    - **Touch targets:** add button 44×44px; player row `minHeight: 68`; modal Cancel/Save
      buttons `minHeight: 44`. All exceed 44pt iOS minimum.
    - **Error surfacing:** `loadError` banner (paper bg, `T.errorWash` bg, `T.errorInk` text)
      below header; `deleteError` banner below it; modal inline error above form.
  - **Now-unused `storage.ts` exports:** `initializeStorage`, `seedDefaultPlayers`,
    `getDefaultPlayers` are no longer called by the players page. `initializeStorage` is also
    no longer needed since the players page stops seeding. `seedDefaultPlayers` is still
    imported by `settings/page.tsx` (tracked as `settings-cleanup` item P18 — not this PR).
    `getSavedPlayers` / `saveSavedPlayer` / `deleteSavedPlayer` still used by `round/new/page.tsx`
    for the local saved-players fallback (not removed).
  - Gates: lint 0 errors (src/app/players/page.tsx, src/lib/storage-api.ts), tsc 0 errors,
    voice-tests 260/260, npm run build OK (players page renders as ○ static prerender).
  - NOTICEABLE — user-visible on TestFlight: players page shows real owner-scoped players
    from the backend; add/edit/delete persist to the DB; the 11 fake seeded players are gone.
  - Designer flags (resolved in follow-up commit below): SwipeableRow confirm dialog restyled
    to T.* tokens; "Add First Player" empty-state button minHeight:44 added.

## 2026-06-27 (wire-players-page designer follow-up)
- **Done:** designer follow-up fixes for `wire-players-page` (one commit on integration/next).
  MUST-FIX:
  1. **SwipeableRow confirm dialog restyled (FIXED):** replaced all dark Tailwind classes with
     T.* inline styles:
     - Overlay: `bg-black/60 backdrop-blur-sm` → `rgba(26,42,26,0.45)` + `blur(4px)` WebKit.
     - Card: `bg-zinc-900 border-zinc-800` → `background:T.paper, border:1px solid T.hairline`.
     - Heading: `text-white` + no font family → T.serif, `color:T.ink`.
     - Body: `text-zinc-400` → `color:T.pencil`.
     - Cancel: `bg-zinc-800 text-white` → `background:T.paperDeep, color:T.inkSoft`.
     - Delete: `bg-red-600 text-white` → `background:T.errorInk, color:T.paper`.
     - Icon circle: `bg-red-500/20` → `T.errorWash` background.
     - Swipe reveal background: `rgba(239,68,68,*)` (raw red) → `rgba(184,74,58,*)` (T.errorInk tint).
     - Trash icon: `className="text-red-400"` → `style={{ color: T.errorInk }}`.
     - Both dialog buttons: `minHeight:44` (44pt iOS touch target).
     - Dialog enter animation: uses `T.spring` transition.
  SHOULD-FIX:
  2. **"Add First Player" button `minHeight:44` (FIXED):** added to the empty-state primary CTA.
  DEFERRED (noted, not fixed):
  - Swipe direction right-to-delete (iOS convention is left) — separate follow-up.
  - Optional player fields can't be cleared once set (undefined vs null partial-update contract)
    — cross-endpoint fix later (send null + model_fields_set).
  - Gates: lint 0 errors (src/), tsc 0 errors, voice-tests 260/260, build OK.
  - NOTICEABLE — confirm dialog now matches the paper/ink aesthetic of the rest of the app.

## 2026-06-27 (wire-tournament-detail)
- **Done:** backlog `wire-tournament-detail` (P18, NOTICEABLE) — `TournamentPageClient.tsx`
  now fetches real data from `/api/tournaments/{id}` + `/api/rounds` (member rounds) instead
  of the fabricated "Sunday Cup" `tournamentData.ts` constants. `tournamentData.ts` DELETED.
  Key changes:
  - **Deleted:** `frontend/src/components/yardage/tournamentData.ts` — all fabricated
    constants (TOURNAMENT, TPLAYERS, TSTANDINGS, TFEED, TGAMES, TGROUPS, TPlayer, TCourse,
    TStanding, TFeedItem, suffix) removed. No other file imported it.
  - **Data flow:**
    1. `getTournamentAsync(id)` → `GET /api/tournaments/{id}` (owner-scoped, API-authoritative
       with localStorage offline cache fallback per storage-api.ts pattern). Returns Tournament
       with `playerIds`, `roundIds`, `playerNamesById`, `games`, `createdAt`.
    2. `getRoundsAsync()` → `GET /api/rounds` (all owner rounds); filter by `roundIdSet`
       (union with `round.tournamentId === id` as belt-and-suspenders). Sort ascending by
       `createdAt` so Day 1 = earliest round.
    3. Player name resolution: `playerNamesById` (from players table join in backend) takes
       priority; `round.players` provides fallback for guests not in the players table;
       `playerId` as last resort.
    4. `effectivePlayerIds`: if `tournament.playerIds` is empty (pre-player-tracking data),
       union from member round players.
    5. Standings via `computeStandings()`: calls `calculateTotals(r.scores, r.holes, pid)`
       (from `types.ts`) for each player × round. Produces `totalStrokes` and `totalToPar`.
  - **Standings:** two sort modes — "Gross" (totalStrokes asc) and "To Par" (totalToPar asc).
    Dynamic grid columns scale with round count (`34px` per column when >3 rounds, `44px` for
    ≤3). Leader callout (ink-bg card) shows leading player name + score when any scores exist.
  - **TFEED removed:** no real activity-feed data source exists. Removed entirely (same
    decision as wire-home's FEED removal). Noted in code.
  - **Empty/partial states (all calm, on-paper):**
    - No players in tournament → "No players in this tournament yet."
    - Has players but no rounds → "No rounds played yet." (leaderboard + rounds tabs)
    - Has rounds but no scores → "Scores will appear here as you play."
    - No tournament-level games → "No games set up yet."
    - Tournament 404 or not owned → calm serif "Tournament not found." + ← Home button.
  - **UX preserved:** T.* tokens throughout, serif/mono typography, paper/ink palette,
    yardage-book feel. `max(14px, env(safe-area-inset-top))` on masthead. All interactive
    elements ≥ 44pt (`minHeight: 44`). Round strip tappable → `/round/{id}`.
  - **No fabricated data:** `useParams()` reads the real id from the URL; `id === "placeholder"`
    guard skips the API call during static prerender.
  - Gates: lint 0 errors (TournamentPageClient.tsx), tsc 0 errors, voice-tests 260/260,
    npm run build OK (`/tournament/[id]` renders as ● SSG with placeholder).
  - NOTICEABLE — user-visible on TestFlight: tournament detail page shows real data (players,
    standings, games, rounds); no fabricated Sunday Cup data anywhere in the app.
  - Designer flags: leader callout is neutral ("Leading {name}") — not "Your position" since
    there is no identity→player mapping yet. TFEED removed; re-introduce when a real activity
    stream exists. To-par mode uses "E" for even (consistent with home + scoring).

## 2026-06-27 (wire-tournament-detail reviewer + designer follow-up)
- **Done:** reviewer + designer fixes for `wire-tournament-detail` (one commit on integration/next).
  SHIP-BLOCKERS fixed:
  1. **Leaderboard grid with 3+ rounds (FIXED):** replaced CSS grid with overflow-x:auto scroll
     container. Each row is `display:flex` with `position:sticky` on rank (left:0, 28px) and
     player (left:28px, 146px) columns — stay pinned as round columns scroll horizontally.
     Total (52px) is sticky right:0. Fixed row heights LB_HEADER_H=34/LB_ROW_H=52 align both
     panels. Widths: 28+146+40×3+52=346px on 390px device = 3 rounds fit with no scroll;
     4+ rounds scroll. Works cleanly for n=1..6+.
  2. **Mode toggle touch target (FIXED):** `minHeight: 32` → `minHeight: 44` + `display:flex;
     alignItems:center` on toggle buttons.
  SHOULD-FIX fixed:
  3. **Loading skeleton (FIXED):** pulsing masthead skeleton replaces blank paper screen.
     CSS keyframe `lb-skel-pulse` in a `<style>` JSX tag; T.paperDeep placeholder blocks for
     back-button / date / title / three meta columns. No external dep.
  4. **Game format display names (FIXED):** `FORMAT_LABELS` map (16 formats).
     bestBall → "Best Ball", bingoBangoBongo → "Bingo Bango Bongo", etc. Falls back to raw
     `g.format` for any unknown key.
  5. **Tie ranks (FIXED):** `tieRankLabel(sorted, idx, mode)` — counts players with strictly
     better total (betterCount), counts players at same total (sameCount). Returns "T1"/"T2"
     for ties, plain "1"/"2" unique, "—" no scores.
  6. **Upcoming course fallback (FIXED):** `r.courseName || "Course TBD"` in round strip +
     Rounds tab card.
  7. **Leader callout raw rgba (FIXED):** `T.paperFaint` (rgba 244,241,234 @ 0.20) and
     `T.paperMid` (rgba 244,241,234 @ 0.50) added to tokens.ts; both callout usages updated.
  - `EmptyState` extracted as a shared sub-component (de-duped 4 identical inline blocks).
  - Gates: lint 0 (modified files), tsc 0 errors, voice-tests 260/260, build OK.
  - NOTICEABLE — grid no longer breaks at 3 rounds; sticky columns keep names visible on
    scroll; loading skeleton, readable format names, correct tie ranks.

## 2026-06-27 (wire-tournament-new)
- **Done:** backlog `wire-tournament-new` (P19, NOTICEABLE) — tournament creation flow wired
  to the backend; Sunday Cup voice-demo removed; round creation uses server-returned ids.
  Key changes:
  - **`app/tournament/new/page.tsx` — full rewrite (Sunday Cup demo removed):**
    - Removed: entire `PARSED` fabricated-data constant (hardcoded "The Sunday Cup · Vol VII",
      players, courses, dates, stakes), `FULL_UTTERANCE` scripted voice replay, `CARTS`/`CADDIES`
      voice-theater setup, fake transcript `useEffect`, `handleStart → /tournament/sunday-cup-2024`
      hardcoded nav, drag-n-drop cart grouping (groupings UI for an unreachable demo tournament).
    - Replaced with a clean manual form (yardage-book aesthetic, T.* tokens throughout):
      - **Name field:** serif italic `<input>` (required, 80 char max, underline-border,
        `T.errorInk` if touched+empty).
      - **Rounds picker:** 1/2/3/4 chip buttons (44pt height, T.ink background when active).
      - **Field (players) section:** loads real players from `GET /api/players` on mount (falls
        back to localStorage cache on API failure). Each player row shows avatar initial +
        name + handicap; tap to toggle selection (`T.paperDeep` bg when selected, ink avatar
        with "✓" when selected). Shows "Loading players…" placeholder while fetching.
      - **Custom player input:** `<input>` with inline "Add" button (T.ink pill, 32pt);
        Enter key submits. Custom players get `crypto.randomUUID()` ids; stored as
        `{id, name}` pairs; removable with × button. Deduplication against API players +
        existing custom players (case-insensitive).
      - **Validation:** both name and ≥1 player are required. Validation fires on submit
        (`touched` flag). Inline `T.errorInk` hint below each missing field. CTA disabled
        while creating or when invalid.
      - **Submit (`handleCreate`):** calls `createTournament({name, numRounds, playerIds})`
        from `@/lib/api`. Offline (TypeError) → surfaces "No connection" message (no
        offline-create since server-assigned id is needed for round linkage). API 4xx/5xx
        → surfaces error message in `T.errorWash` banner above CTA. On success:
        builds `playerNamesById` map (selected real players + custom names); calls
        `saveTournament({...created, playerNamesById})` to warm the localStorage cache for
        offline reads; navigates to `/tournament/${created.id}` (SERVER-RETURNED id).
    - iOS safe-area: `max(14px, env(safe-area-inset-top))` header,
      `max(26px, env(safe-area-inset-bottom, 26px))` CTA footer. All touch targets ≥44pt.
  - **`tournament/[id]/round/new/NewTournamentRoundClient.tsx` — API-backed wiring:**
    - **Tournament loading:** replaced sync `useMemo(() => getTournament(tournamentId))`
      (localStorage only) with `useEffect → getTournamentAsync(tournamentId)` from
      `storage-api.ts` (API-authoritative, localStorage fallback). Added `tournamentLoading`
      + `tournamentNotFound` states; renders "Loading tournament…" while pending.
    - **Course loading:** replaced `getCourses()` from storage.ts with `apiGetCourses()`
      from `@/lib/api` (falls back to `localGetCourses()` on API error via try/catch).
    - **Round creation:** replaced `saveRound(round) + addRoundToTournament(...)` (both
      localStorage-only) with `createRound({...roundData, tournamentId})` from `@/lib/api`
      (POST /api/rounds). Backend automatically appends the new round id to
      `tournament.round_ids` (detail page picks it up on next load). Write-through to
      localStorage via `localSaveRound(created)`. Navigates to `/round/${created.id}`
      (SERVER-RETURNED id, not a client-side UUID).
    - Added `creating` + `createError` states; error rendered as red banner above CTA button;
      button shows "Creating…" while in flight; disabled while creating.
    - `handleStartRound` early-returns on `!creating` guard (race-safe).
    - `autoGenerateGroups` tee-time math fixed: removed mutating `baseTime = new Date(...)` inside
      loop; now computes offset via `new Date(base.getTime() + i/playersPerGroup * 10 * 60000)`.
  - Gates: `npx eslint src/app/tournament/ --ext .tsx,.ts` 0 errors, `tsc --noEmit` 0 errors,
    voice-tests 260/260 pass, `npm run build` OK (tournament/new → ○ static, tournament/[id]/round/new → ● SSG).
  - NOTICEABLE — user-visible on TestFlight: creating a tournament now persists to the backend
    and navigates to the real server-assigned id; adding a round to a tournament creates via
    POST /api/rounds with tournamentId linkage (detail page standings update after play).
  - No fabricated data remains in either file.
  - Designer flags: NewTournamentRoundClient retains the existing dark Tailwind styling
    (`.card`, `.btn`, emerald classes) — consistent with its current state; a full redesign
    to T.* tokens is a separate polish item. The new tournament/new form uses T.* tokens
    throughout and matches the wire-round-new / profile page aesthetic.

## 2026-06-27 (wire-tournament-new reviewer + designer follow-up fixes)
- **Done:** reviewer + designer follow-up fixes for `wire-tournament-new` (one commit on integration/next).
  BLOCKER 1 fixed (custom player names):
  - Original implementation used `crypto.randomUUID()` ids for custom players directly in
    `playerIds`. Backend `_build_full_tournament` derives `playerNamesById` via a JOIN to the
    `players` table — client-side UUIDs not in that table → names resolve to "Unknown".
  - Fix: `handleCreate` now loops through `customPlayers`, calls `createPlayer({name})` for each
    (POST /api/players), then `saveSavedPlayer(saved)` (write-through to localStorage cache).
    Uses server-returned ids in `allPlayerIds`. Builds `playerNamesById` from server-returned
    `SavedPlayer` objects for the local cache. Custom players are now real rows in the DB —
    backend JOIN resolves their names, and they appear on the Players page.
  BLOCKER 2 fixed (NewTournamentRoundClient full yardage-book restyle):
  - Removed all 33 dark Tailwind class refs (text-zinc-100, bg-white/5, ring-emerald-500/50,
    emerald, zinc-*). Full rewrite to T.* inline styles throughout.
  - Outer shell: `PAPER_NOISE` over `T.paper`, T.* tokens throughout.
  - Header: "Add · Round" mono kicker + "Set up a round." T.serif italic headline (matches
    tournament/new / round/new patterns). Back button links to tournament detail.
  - Loading / not-found: paper shell, T.pencilSoft text, back button.
  - Course/tee selects: `background:T.paperDeep, border:1px solid T.hairline, color:T.ink`.
  - Tournament info card: T.paperDeep bg, T.ink/T.pencilSoft labels, T.serif italic name.
  - Auto-Group button: `border:1px solid T.hairline, color:T.pencil` (secondary style).
  - DnD `SortablePlayer`: T.paper bg, T.paperDeep on hover/drag, T.ink text, DEFAULT_ACCENT
    ring (not emerald). `DraggedPlayer` overlay: ink bg, T.paper text.
  - Drop zones: `border:1px dashed T.hairline, background:T.paper, minHeight:44`.
  - Unassigned section: `border:T.warningInk40, background:T.warningWash, color:T.warningInk`.
  - Error banner: `background:T.errorWash, border:T.errorInk30, color:T.errorInk`.
  - CTA: text "Start Round →" (mono arrow, no Flag icon); T.ink pill, T.paper text; safe-area
    bottom `max(26px, env(safe-area-inset-bottom, 26px))`. minHeight 52.
  - All touch targets ≥44pt throughout.
  - Safe-area top: `max(14px, env(safe-area-inset-top))` on header.
  BLOCKER 3 fixed (Add button touch target):
  - "Add" button in tournament/new: `minHeight: 32` → `minHeight: 44`.
  POLISH (both files):
  - Placeholder: "Club Championship" (was "Sunday Cup").
  - Handicap display: `+{p.handicap}` → `{p.handicap > 0 ? `+${p.handicap}` : p.handicap}`.
  DEFERRED (noted, not fixed):
  - Legacy non-UUID localStorage tournament rounds linkage gap (rounds from before server-UUIDs).
  - Gates: `npx eslint src/app/tournament/ --ext .tsx,.ts` 0 errors, `tsc --noEmit` 0 errors,
    voice-tests 260/260 pass.
  - NOTICEABLE — custom players now persist to the DB and resolve their names; round-setup screen
    is fully paper/ink aesthetic (no dark Tailwind).

## 2026-06-27 (settings-cleanup)
- **Done:** backlog `settings-cleanup` (P20, NOTICEABLE) — removed "Load Sample Players" demo
  action from `app/settings/page.tsx`; updated "Clear Data" to be honest about scope; restyled
  page from dark Tailwind to yardage-book paper/ink palette.
  Key changes:
  - **`app/settings/page.tsx`:**
    - Removed the entire "Sample Players" section (card, button, `seedDefaultPlayers()` call,
      `Users` lucide import, `import { seedDefaultPlayers } from '@/lib/storage'`). Players are
      now real and backend-backed — seeding 11 fabricated names is incorrect.
    - "Data" section renamed to "Local Cache"; description updated to be honest: "Clear locally
      cached data (offline rounds, app state). Your backend data — players and profile — is not
      affected." Confirm dialog also updated with clear scope language.
    - Button label changed from "Clear All Data" → "Clear Local Cache"; behavior unchanged
      (`localStorage.clear()` is correct — the backend is authoritative).
    - Restyled from dark Tailwind to yardage-book palette:
      - `text-zinc-400` → `style={{ color: 'var(--pencil)' }}`
      - `border-t border-white/10` → `style={{ borderTop: '1px solid var(--hairline)' }}`
      - `bg-emerald-500/10 text-emerald-200` (removed with Sample Players section)
      - `bg-red-500/10 text-red-200` → `background: rgba(184,74,58,0.08), color: #b84a3a,
        border: rgba(184,74,58,0.22)` (T.errorInk/T.errorWash tints)
      - `minHeight: 44` on the destructive button (iOS 44pt touch target)
      - `paddingBottom: max(96px, ...)` on main (iOS safe-area inset)
    - The `.app-shell`, `.app-header`, `.card`, `.btn` shim classes kept (already paper-palette
      in globals.css; no dark overrides remain).
  - **`lib/storage.ts`:**
    - Removed `initializeStorage()` (exported, but had zero callers in `frontend/src/` — was
      previously used by the old home page and players page before those were wired to the API).
    - Removed `seedDefaultPlayers()` (was only called by settings page — now removed).
    - Removed `getDefaultPlayers()` (private, only used by the two functions above).
    - Kept `getDefaultCourses()` — still used by `getCourses()` as an offline fallback when
      no courses are in localStorage (not a seeding action; a safe fallback).
    - Kept all other player CRUD functions (`getSavedPlayers`, `saveSavedPlayer`, etc.) —
      still used by round/new as a localStorage cache layer.
  - Gates: `npx eslint src/app/settings/page.tsx src/lib/storage.ts` 0 errors, `tsc --noEmit` 0
    errors, voice-tests 260/260 pass, npm run build OK.
  - NOTICEABLE — user-visible on TestFlight: Settings page shows correct Local Cache label and
    honest description; "Load Sample Players" button is gone.
  - Designer: page is now fully on the paper/ink palette. The `.btn` shim class still uses
    dark Tailwind's `rounded-full` utility but `.btn` itself is paper-palette in globals.css —
    consistent with the rest of the legacy shim pages. If the designer wants full T.* inline
    conversion (matching players/profile pages), that can be a follow-up polish pass.

## 2026-06-27 (games-matchplay-nassau)
- **Done:** backlog `games-matchplay-nassau` (P21, NOTICEABLE) — real hole-by-hole match-play
  Nassau implemented in `lib/games.ts`; stub notes removed from UI; tests updated.
  Key changes:
  - **Algorithm (gross scores, no handicap — consistent with existing stroke-mode Nassau):**
    - New `NassauMatchSegment` interface: `holesPlayed`, `matchDiff`, `statusLabel`, `leaderId`,
      `closedAt`, `closed`.
    - `NassauResults` extended with optional `front9Match?/back9Match?/overallMatch?` fields —
      backward-compatible (undefined in stroke mode; populated in match mode).
    - `computeMatchSeg(startHole, endHole)` inner function: iterates holes in the segment;
      updates diff only when BOTH competitors have a score (skips unscored holes — prevents
      mid-round false-close); tracks `holesPlayed`, `diffAtClose` (frozen at moment of close);
      close fires when `|diff| > segmentLength − holesPlayed` (remaining playable holes).
    - statusLabel: "—" (no scores), "AS" (tied), "N UP" (in progress), "N & M" (closed with
      M holes remaining), "N up" (closed on the last hole exactly).
    - Team scope: best-ball per hole (same as stroke-mode team scope).
    - `front9WinnerId/back9WinnerId/overallWinnerId`: in match mode, set to `leaderId` from
      each segment (null = AS = no leader yet). Stroke mode unchanged.
  - **UI changes (3 files):**
    - `LeaderboardSheet.tsx` Nassau component: removed "coming soon — showing stroke totals"
      note. In match mode, each segment's `note` in the winner grid shows the `statusLabel`
      (e.g. "5 & 4", "AS", "3 UP") instead of "Thru N". "Running totals" stroke table hidden
      in match mode (not meaningful for match play).
    - `GameResults.tsx` Nassau section: removed "Match-play Nassau is stubbed; using stroke
      totals" note. Header changed from "Winners (stroke totals)" to "Winners" (always).
      Added "Match status" block for match mode (segment label + statusLabel + leader name).
      "Stroke totals" block shown only in stroke mode (label updated to reflect this).
    - `GameLeaderboards.tsx` Nassau section: added match-play status grid (F9/B9/18 +
      statusLabel) below the winner grid in match mode. Stroke totals row hidden in match mode.
  - **Tests (`games.test.ts`):**
    - Old "STUB BEHAVIOR" test (`falls back to stroke totals when mode=match`) REPLACED with
      7 focused match-play tests (stub → real behavior):
      1. p1 wins every hole → front9 closes early "5 & 4" (closedAt=5, diffAtClose=5).
      2. Alternating hole wins → F9 ends AS (closed=false, diff=0, statusLabel='AS').
      3. Partial round (3 holes) → in-progress "3 UP", back9 "—", closed=false.
      4. Overall closes at hole 10 ("10 & 8").
      5. No scores → all "—", all winnerIds null.
      6. Team scope: best-ball per hole → tA wins → front9Match.closed=true.
      7. Stroke mode unchanged → front9Match undefined (no match data).
  - **Bug found + fixed (algorithm correctness):** initial algorithm used `endHole − h` for
    "remaining holes" — this fired the close-check on UNSCORED holes (e.g. 3 up thru 3,
    holes 4-7 unscored → falsely closed at h=7 when endHole-h=2 < 3). Fixed by:
    (a) close-check only on scored holes; (b) remaining = segmentLength − holesPlayed; (c)
    diffAtClose frozen at closure so statusLabel is "5 & 4" not "9 & 4".
  - **Gross/net decision:** gross scores only (consistent with existing stroke-mode Nassau;
    `GameSettings.handicapped` is never used in any format — deferred for a future item).
  - Gates: tsc 0 errors (strict), lint 0 errors (src/), voice-tests 260/260, npm test 236/236
    pass (7 new match-play Nassau tests; old stub test replaced), npm run build OK.
  - NOTICEABLE — Nassau tab in LeaderboardSheet now shows real match-play status (e.g. "5 & 4",
    "AS", "3 UP") when mode=match; no more "coming soon" note; GameResults + GameLeaderboards
    also updated.
  - Designer flag: match-play status in the winner grid replaces "Thru N" in match mode —
    confirm the `statusLabel` text ("5 & 4", "AS", "3 UP") fits the yardage-book voice; the
    existing 3-column winner grid layout is reused unchanged.

## 2026-06-27 (voice-parser-edge-bugs)
- **Done:** backlog `voice-parser-edge-bugs` (P23, NOTICEABLE) — two correctness bugs fixed
  in `frontend/src/lib/voice/parseVoiceScores.ts`; two new test cases added to the unit suite.
  Bugs (found by `test-voice-pipeline`):
  1. **"for" → 4 missing from regex alternations:** `WORD_TO_NUM` maps `for: 4` but both the
     first-pass regex (line 251) and second-pass regex (line 282) listed `four|fore|ford` with
     no `for`. "Justin with a for" produced no score.
     Fix: added `for` after `ford` in both regex alternations → `four|fore|ford|for`.
     `fore`/`ford`/`four` remain first in both lists; `\b` word-boundary in the second-pass
     and end-of-token context in the first-pass prevent any cross-matching.
  2. **"everybody dbl bogey" → par+1 instead of par+2:** the everyone-pattern regex (line 233)
     correctly matches `dbl bogey` in its alternation, but the value-selector (line 237) checked
     only `t.includes("double")` — false for "dbl" — and fell through to `t.includes("bogey")` →
     par+1. The individual-player second-pass (line 278) already handled `dbl` correctly.
     Fix: changed `t.includes("double")` → `t.includes("double") || t.includes("dbl")` in the
     everyone-pattern block only (line 237).
  Test additions in `parseVoiceScores.test.ts` (2 new tests; 0 existing tests changed):
  - Section 1: `'for → 4 via "with a for"'` — asserts `Justin with a for` → score 4.
  - Section 4: `'"everybody dbl bogey" → all get par + 2 (dbl abbreviation)'` — asserts all
    players get par+2.
  Sanity confirmed: `fore → 4 via "with a fore"`, `ford → 4 via "made a ford"`,
  `four → 4 via "shot a four"` all still pass; "everybody double bogey" and "everybody double"
  still pass; no collision-guard tests affected.
  Gates: tsc 0 errors, voice-tests **260/260** pass, npm test **238/238** pass (236 prior + 2 new),
  npm run build OK. Lint warnings are all pre-existing Capacitor build-artifact files (not in src/).
  NOTICEABLE — any golfer who says "with a for" or "everybody dbl bogey" now gets the correct
  score parsed (was: no score / wrong score).

## 2026-06-27 (restyle-game-result-screens)
- **Done:** backlog `restyle-game-result-screens` (P24, NOTICEABLE) — full yardage-book restyle
  of `frontend/src/components/GameResults.tsx` and `frontend/src/components/GameLeaderboards.tsx`.
  Both files were entirely dark-mode SaaS (zinc gradients, emerald/amber rank circles, `text-white`,
  `bg-gradient-to-b from-zinc-800/80`, lucide Trophy) — a NORTHSTAR violation.
  Key changes per file:
  **GameResults.tsx:**
  - Removed `const box` / `const boxSubtle` Tailwind shorthand constants (dark backgrounds).
  - All format sections (skins, bestBall, nassau, threePoint, stableford, matchPlay, wolf, fallback)
    converted from Tailwind classes to inline T.* styles: `T.paper` card backgrounds, `T.hairline`/
    `T.hairlineSoft` borders, `T.ink`/`T.pencil`/`T.pencilSoft` text, `T.serif`/`T.sans`/`T.mono`
    font families, `T.accent` for leader callouts (was `text-emerald-300`), `T.warningInk` for
    wolf "editing disabled" note (was `text-amber-200`).
  - `<details>/<summary>` expanders restyled: T.mono uppercase summary labels, T.paper card wrapper.
  - Tables (bestBall/threePoint hole-by-hole): `border-white/10`/`divide-white/6` → T.hairline/
    T.hairlineSoft inline borders on `<tr>`.
  - Wolf interactive buttons: lone wolf selected state → accent-tinted (`rgba(58,74,138,0.07)`)
    border/text/bg; unselected → transparent/T.hairline; select dropdown → T.paperDeep;
    clear button → T.paperDeep/T.hairline. All ≥44pt minHeight.
  - Zero logic/props/computed-value changes.
  **GameLeaderboards.tsx:**
  - Removed `import { Trophy } from 'lucide-react'` — replaced with typographic header (mono
    "Game standings" kicker + serif italic "Leaderboards" display text; no icon).
  - Three module-level items extracted: `cardStyle` (T.paper card, T.hairline border),
    `RankCircle` component (T.serif italic position number in hairline-bordered circle; leader
    gets T.accent border+color vs T.hairline+T.pencil), `CardHeader` component (serif game name
    + mono bet kicker).
  - All format sections (skins, nassau, bestBall, threePoint, stableford, matchPlay, wolf, stub)
    converted from `rounded-2xl bg-gradient-to-b from-zinc-800/80 to-zinc-900/80 border border-zinc-700/50`
    → T.paper card; row leader highlights `rgba(26,42,26,0.03)` (was `bg-emerald-500/5`);
    scores T.serif ink (was `text-emerald-400`/`text-zinc-400`); row dividers T.hairlineSoft
    (was `divide-zinc-800/50`).
  - Skins carrying pot: removed 🔥 emoji; replaced with T.warningInk mono uppercase text.
  - Nassau winners grid, match-status cells: T.paperDeep/T.hairlineSoft cells (was `bg-zinc-800/50`).
  - ThreePoint: T.serif 44px score (was `text-emerald-400`/`text-zinc-400` at `text-4xl`);
    T.serif italic "vs" + T.hairline divider line (was `text-2xl text-zinc-600`).
  - Match Play: T.ink for leading player, T.pencilSoft for trailing (was `text-emerald-400`
    vs `text-zinc-300`). No logic change.
  - Wolf winnings negative: T.errorInk (was `text-red-400`).
  - Zero logic/props/computed-value changes.
  **Grep confirmation:** `zinc|emerald|text-white|bg-white/|lucide|amber|from-zinc` → 0 matches in both files.
  Gates: lint 0 errors (src/ files), tsc 0 errors, voice-tests 260/260, npm test 238/238, build OK.
  NOTICEABLE — user-visible on TestFlight: GamesPanel detail view + any screen rendering
  GameLeaderboards now shows the paper/ink yardage-book aesthetic instead of the dark SaaS chrome.
  Designer flags:
  - `GamesPanel.tsx` and `RoundSummary.tsx` (the parents that embed these components) still use
    dark Tailwind styling — they are not in scope for this item but will look inconsistent on-device
    until restyled (separate follow-up items).
  - Wolf interactive buttons use `rgba(58,74,138,0.07)` accent fill for selected state — designer
    should verify this reads clearly against T.paper in sunlight.
  - `<details>/<summary>` expanders use the browser's default disclosure triangle — a future polish
    pass could replace with a custom chevron or typographic indicator.

## 2026-06-27 (hotfix — voice 401 + global safe-area)
- **Done:** Two owner-reported TestFlight bugs fixed in one commit.

  **BUG 1 — Voice 401 "Missing Authorization: Bearer" (Clerk hydration race):**
  - Root confirmed: `getAuthToken()` in `frontend/src/lib/api.ts` accessed
    `window.Clerk.session` directly. In a Capacitor webview, native-view
    transitions can fire authed API calls (e.g. voice transcribe) before
    `window.Clerk.loaded` is true — so `.session` is null even though the user
    IS signed in, producing a no-auth header and a backend 401.
  - Fix: Hardened `getAuthToken()` to await `clerk.load()` (idempotent — no-op
    when already loaded) before reading `.session`, with a 4 s `Promise.race`
    timeout. If Clerk fails to load within 4 s, `console.error` fires and the
    request proceeds unauthenticated (observable in DevTools). Normal
    unauthenticated state (`!clerk.session` after loading) is silent, no log spam.
    This affects ALL authed calls via `fetchAPI` and `authHeaders`, not just voice.
  - Honest caveat: the root cause is a timing race specific to the Capacitor
    webview boot sequence; this fix closes the window significantly. Confirmation
    that the 401 is gone requires a device build (TestFlight). If the bug persists
    after this fix, the next step is device logs to see whether `clerk.loaded`
    ever becomes true in the affected window.

  **BUG 2 — Content jammed under Dynamic Island / status bar (missing viewportFit):**
  - Root confirmed: `frontend/src/app/layout.tsx` viewport export was missing
    `viewportFit: "cover"`. Without it, iOS resolves `env(safe-area-inset-*)` to 0
    for all CSS, so every screen's `max(14px, env(safe-area-inset-top))` collapsed
    to 14px — not enough to clear a Dynamic Island (~59px) or standard notch (~44px).
  - Fix 1: Added `viewportFit: "cover"` to the viewport export in `layout.tsx`.
    All screens that already use `env(safe-area-inset-top)` in their headers
    (home, tee-time, round, players, profile, VoiceRoundSetup, tournament, etc.)
    will NOW receive the real inset and clear the status bar correctly — no
    additional per-screen changes needed for those paths.
  - Fix 2: Added `padding-top: env(safe-area-inset-top)` to the `.app-header`
    legacy shim class in `globals.css`. This class is used by `settings/page.tsx`
    and `CameraCapture.tsx` — both now clear the status bar.
  - Deliberately NOT added top padding to `body` in the `@supports` block — that
    would double-count against every screen that already handles inset in its own
    header container.
  - NOTICEABLE — user-visible on every screen on iPhone with a notch/Dynamic Island.
  - Designer flag: with `viewportFit:cover` active, screens that already used
    `env(safe-area-inset-top)` will now get the real inset (44-59px) instead of
    14px. Visual audit across all main screens recommended before next TestFlight.

  Gates: tsc 0 errors, voice-tests 260/260, vitest 238/238, build OK.

## 2026-06-27 (restyle-dark-components-sweep P24.5 — scoring-entry batch)
- **Done:** `ScoreGrid.tsx` + `HoleScoreModal.tsx` restyled from dark-mode Tailwind to the
  yardage-book T.* token system. VISUAL-ONLY — zero logic/prop/callback changes.
  Key changes (ScoreGrid.tsx):
  - Removed `lucide-react` import (Mic/MicOff/Loader2/Users); replaced with inline SVG helpers
    (MicIcon, MicOffIcon, SpinnerIcon) — no third-party icon dep.
  - `GROUP_COLORS` retyped from Tailwind class strings to raw color values using T.* tokens +
    warm ink palette matching `PLAYER_COLORS` in RoundPageClient. All group header / row /
    badge styles converted to `style={}` inline.
  - Local `scoreColor()` helper returns T.eagle/T.flag/T.par/T.bogey/T.double inline instead
    of dark-mode Tailwind `getScoreClass()`.
  - Score indicators (birdie circle, bogey square, etc.) border colors now use T.eagle, T.flag,
    T.bogey, T.double, T.pencilSoft — no more yellow/red/sky/blue/indigo.
  - Selected cell: cobalt `rgba(58,74,138,0.08)` + cobalt shadow; underline `${T.accent}B0`
    (replaces emerald).
  - Voice bar: T.paperDeep bg, T.hairline border, T.accent mic button (cobalt) / T.errorInk
    stop (replaces zinc/emerald dark chrome).
  - Pending scores: cobalt-tinted bg (replaces emerald-900/30).
  - Number pad (fixed bottom): T.paper bg, T.hairline border, T.serif number buttons,
    T.errorWash clear button; iOS safe-area bottom padding.
  - 44pt (`minHeight: 44`) on all score cells and number-pad buttons.
  - Totals section: T.flag/T.bogey/T.par for toPar color (replaces red-300/sky-300/emerald-300).
  Key changes (HoleScoreModal.tsx):
  - Removed `lucide-react` import; replaced X/ChevronLeft/ChevronRight with `×`/`‹`/`›` text.
  - Overlay: `rgba(26,42,26,0.45)` ink-tinted (replaces bg-black/70 backdrop-blur-sm).
  - Sheet layout: converted from centered dialog to proper bottom sheet (fixed bottom-0,
    slide-from-bottom animation via T.springSoft, rounded top corners 28px, drag handle,
    safe-area bottom padding).
  - Nav buttons: T.hairline border, T.ink/T.pencilSoft text, `minWidth/minHeight: 44`.
  - Hole title: T.serif italic + T.mono kicker (replaces text-white/text-zinc-400).
  - ScoreCell: T.paperDeep background + T.hairline 2px border (replaces zinc-800/80);
    drag active → `rgba(58,74,138,0.08)` cobalt wash (replaces emerald-500/20).
  - Score number: T.serif 42px with inline `getScoreInkColor()` → T.eagle/T.flag/T.par/
    T.bogey/T.double (replaces Tailwind dark-mode color classes).
  - +/- buttons: `minWidth/minHeight: 44` (was 32px w-8 h-8); T.paper bg, T.hairline
    border, T.pencil text, T.serif font.
  - Quick actions: "All Par" → cobalt `rgba(58,74,138,0.08)` / T.accent text; "Done" →
    T.paperDeep / T.ink.
  - Hole dots: T.accent for active (cobalt), T.hairline for inactive (replaces emerald-400/
    zinc-600); hint text → T.mono / T.pencilSoft.
  Score color tokens reused: T.eagle (≤-2), T.flag/T.birdie (-1, birdie terracotta),
  T.par (0, ink), T.bogey (+1), T.double (+2), T.pencilSoft (+3).
  Touch targets: 44pt minimum on all interactive scoring controls (critical on-course UX).
  Grep clean: zero `zinc|emerald|text-white|bg-white/|lucide|amber|from-zinc` in both files.
  Gates: tsc 0 errors, voice-tests 260/260, vitest 238/238, npm run build OK.
  NOTICEABLE — both surfaces are visible every time a score is entered during a live round.
  Designer flags:
  - HoleScoreModal is now a bottom sheet (was centered dialog); swipe-to-dismiss is not
    wired — only backdrop-tap dismisses. Designer should confirm this feels correct.
  - ScoreGrid sits inside the old `/round/[id]` page (pre-yardage-book route). If the owner
    is primarily on the new RoundPageClient (yardage route), ScoreGrid may not be visible on
    TestFlight — confirm with eng-lead which route is the live scoring surface.

## 2026-06-27 (fix-capacitor-auth-401)
- **Done:** URGENT hotfix — native Capacitor/iOS auth 401 on every authenticated call.
  Root: `window.Clerk.session` never hydrates on the `capacitor://localhost` origin, so
  `getAuthToken()` returned null → no Authorization header → backend 401. Prior `clerk.load()`
  wait didn't help, confirming `window.Clerk` is not a reliable handle on this origin.
  Fix: hook-based token getter via `useAuth()` from `@clerk/clerk-react` (the supported API).
  Key changes:
  - **NEW `frontend/src/lib/auth-token.ts`:** module-level singleton. Exports `setTokenGetter`
    (called by ClerkTokenBridge to register the hook's `getToken`), `getTokenViaClerk` (called
    by api.ts; polls up to 3s for first-render race), `getAuthDiagnostics` (returns `isLoaded`,
    `isSignedIn`, `getterRegistered` snapshot for diagnostic messages).
  - **NEW `frontend/src/components/ClerkTokenBridge.tsx`:** client component inside
    `<ClerkProvider>`. Uses `useAuth()` and registers its `getToken` into the singleton on every
    auth-state change. Cleanup on unmount. Renders no UI.
  - **`frontend/src/components/AuthProvider.tsx`:** mounts `<ClerkTokenBridge />` inside
    `<ClerkProvider>` (only when Clerk is configured).
  - **`frontend/src/lib/api.ts`:** `getAuthToken()` reworked — (1) primary: `getTokenViaClerk(3s)`
    hook-based path; (2) fallback: `window.Clerk` with load-wait (kept as belt-and-suspenders);
    (3) diagnostic `console.error` if signed-in but no token from either path. CLERK_ENABLED
    guard skips the wait when Clerk is not configured (avoids 3s penalty when no publishableKey).
  - **`frontend/src/lib/voice/deepgram.ts`:** on HTTP 401, throws an enriched error with the
    auth-state snapshot: `"Transcribe 401 (no auth token) — isLoaded:true isSignedIn:true
    getterReg:false | Missing Authorization: Bearer"`. This appears verbatim in the VoiceRoundSetup
    error box so the owner can read the exact auth state from a screenshot.
  Honest assessment (code fix vs Clerk config):
  - The hook-based path is the correct supported Clerk API and should work regardless of
    `window.Clerk` availability. If the code fix alone is sufficient depends on whether Clerk's
    DEV instance (pk_test_*) allows sessions to be established from the `capacitor://localhost`
    origin. DEV instances often restrict origins — if sessions still don't establish, the owner
    will need to:
    1. Add `capacitor://localhost` to Clerk dashboard → Configure → Domains (allowed origins).
       OR: switch to a production instance (pk_live_*) which has more permissive origin handling.
    2. Alternatively, configure Capacitor's `iosScheme: "https"` with a custom domain so the
       webview origin becomes `https://app.looper.golf` (or similar), which Clerk will accept.
    The diagnostic in the 401 error ("getterReg:false" vs "getterReg:true") tells the owner
    whether (a) the hook getter was never registered (deeper issue — ClerkProvider not mounting
    or unmounting early) or (b) the getter was registered but `getToken()` returned null anyway
    (Clerk refusing to issue a token for this origin — owner-side Clerk config fix required).
  Gates: tsc 0 errors (strict), voice-tests 260/260, npm test 238/238, npm run build OK.
  NOTICEABLE — this is a functional regression fix; voice and all authed data calls should
  now authenticate correctly on the native iOS build. The diagnostic also helps diagnose
  if the code fix alone is insufficient.

---

## Eng-lead session checkpoint — 2026-06-27 (rolling bundle on integration/next)

This session drove a large bundle onto `integration/next` (one open PR → main). NONE shipped —
the whole bundle is gated on the owner validating sign-in + voice on TestFlight build **v0.1.266**
(the auth-gate build). Each item went builder → reviewer + designer → folded → gates verified.

DONE this session (all on integration/next, ahead of main):
- **mount-caddie (P26)** — lean voice-first `CaddieSheet` on the in-round screen (`/caddie/voice`
  + `/caddie/recommend`, GPS-free). NOT the 1215-line GPS `CaddiePanel` (that's blocked P28).
- **mount-ocr-scan (P27)** — scan a paper card → `/api/voice/parse-scorecard` → editable review
  (name-match, low-confidence flags, dup guard, retry) → persists via existing `handleSetScore`.
- **live transcription** — Web Speech interim "Hearing…" in the voice flow (owner-requested).
- **wire-profile-stats (P16, re-scoped)** — ScoringByTee + Season log now real from getRounds;
  StrokesGained/FairwayFan → one honest "ShotAnalytics" placeholder (no fabricated numbers);
  removed a contradicting "Recent rounds" stub.
- **frontend-lint-cleanup (P32)** — root cause was ESLint scanning the Capacitor `ios/` minified
  bundle (~2874 false positives); added `ios/**` to globalIgnores + fixed ~84 real issues. lint 0/0.
- **CI ratchet** — lint · typecheck · voice-tests · vitest(238) · build · ruff now ALL required on
  every PR (advisory job retired).
- **restyle-dark-components-sweep (P24.5)** — app is now lucide-free on all reachable paths.
- Versioning: `ops/ios/ship.sh` stamps `MARKETING_VERSION=0.1.N` (no more all-"1.0" builds).

QUEUED / NOT done:
- **voice-low-confidence-ux (P33)** — spec written (`specs/voice-low-confidence-ux.md`). Setup path
  has a confidence signal already (easy slice); scoring path is net-new voice-to-score + a backend
  `confidence` field (own bundle, deferred).
- **delete-dead-legacy (P29)** — 11 confirmed-dead files; HELD until owner validates caddie+OCR on
  a real build (keep the fallback until then).
- **owner-player-identity (P34)** — `players[0]=owner` mis-attribution risk (home + profile);
  needs a Clerk-user→player mapping (user-identity). needs-spec.
- **mount-gps-shot-tracking (P28)**, **tee-time-real (P25)** — blocked.

NEXT REAL PING = the bundle approval: when owner confirms sign-in works on v0.1.266, cut ONE
TestFlight build with the whole bundle and email looper.approvals → owner for "ship it". If
sign-in fails, it's likely the Clerk DEV-instance origin on `capacitor://localhost` (see the
auth checkpoint above) — owner-side dashboard fix.

---

## Bundle pre-ship sign-off — 2026-06-27 (security + code review)

Holistic `/security-review` + code review of the whole bundle (`origin/main..integration/next`,
79 commits, 84 files): **VERDICT = SHIP.** No must-fix security/correctness blockers in the
cross-cutting/integration view (each item was also reviewed per-diff).

Verified clean: (1) auth gate ↔ all authed calls fails closed — tokenless/expired → 401, no
silent wrong-user data, token never logged or put in a URL; (2) every consumed endpoint
(caddie voice/recommend, OCR parse-scorecard, parse-round-setup, rounds/{id}/scores,
profile/golfer, getRounds) is owner-gated under `_owner_only` + owner-scoped (no IDOR);
(3) OCR image path keeps the Anthropic key server-side; OCR text is auto-escaped (no XSS);
(4) `players[0]=owner` cannot leak another user's data in single-owner beta (getRounds is
owner-scoped) — tracked as P34; (5) no committed secrets; ship.sh carries only public config;
(6) no overlay/scoring cross-cutting regression.

DEPLOY-TIME CHECKLIST (config, outside the diff — verify on the EC2 box before/at ship):
- Production backend must have `CLERK_JWKS_URL` set and `ALLOW_ANONYMOUS` unset (else
  `current_user_id` won't fail-closed as intended).
- Before any WIDER release (beyond owner beta): switch Clerk from the DEV instance
  (`pk_test_…` baked in ship.sh) to a PRODUCTION instance (`pk_live_…`) and update backend
  `CLERK_JWKS_URL`/`CLERK_ISSUER`/`OWNER_CLERK_USER_ID` to match.

THE ONLY REMAINING GATE = owner confirms sign-in + voice on TestFlight **v0.1.266**. On
confirmation: cut one build of this bundle (`ops/ios/ship.sh`) and email looper.approvals →
owner for "ship it". If sign-in stalls, capture the `[auth] DIAGNOSTIC signed-in but no token`
log — it's the capacitor://localhost + Clerk-dev-instance origin caveat (owner-side Clerk fix).

---

## TestFlight distribution fixed — 2026-06-28

ROOT CAUSE of "I never see new builds": the App Store Connect app (MyLooper, com.looperapp.app,
id 6784470752) had **no beta group**, so VALID builds were never delivered to any tester. Owner
(justinlee627@gmail.com) is Account Holder/Admin → qualifies as internal tester.

FIX (via ASC API, owner-authorized): created internal beta group **"Looper Team"** (id
7c2116c8-7d05-4e43-afe3-21457ca7c318, isInternalGroup=true, hasAccessToAllBuilds=true) and added
the owner as a tester (now state=INSTALLED). All future VALID builds auto-deliver to this group —
no per-build assignment or beta review needed. Build v0.1.323 (202606272115) is VALID + available.

NOTE for future ships: ship.sh upload → Apple processing (~10 min to VALID) → appears in TestFlight
for the Looper Team group automatically. If a build ever doesn't show: check processingState via
the ASC API (scripts pattern in this session), not just the ship.sh exit code.

---

## Native auth VERIFIED + CI crash gate + lockfile fix — 2026-06-28 (cycle close)

**Native Clerk auth confirmed working (not just shipped).** Drove a real credentialed
sign-in in the iPhone-17 simulator (WebKit remote inspector). Every native-auth signal green:
`native-sent=true` on every FAPI request incl. the sign_ins POST (the @clerk/react v6 upgrade
fixed v5's dead token hooks), `auth-hdr=true` + `tok=true` (CapacitorHttp made the auth header
readable; JWT captured + persisted), `napi=true`, password accepted. `signed=false` reached ONLY
because Clerk gated the new device behind an emailed second-factor OTP (human-only — needs the
owner's inbox), which is product security, not a native-auth bug. Shipped verified build
**v1.0.369 (build 202606281037)**. Owner's one remaining step = sign in + enter the email code.

**P53 done — CI native crash gate.** `required-frontend` now builds with the public prod Clerk
key and runs `npm run test:native-crash` (ios/simtest-headless.mjs) in Chromium with the iOS
bridge faked — fails the build on any client-side exception (the v1.0.365 white-screen class).
Verified live in CI: the "Native client-side crash check (Capacitor path)" step runs + passes.

**Lockfile break fixed (surfaced by the new gate's npm ci).** The @clerk/react v6 upgrade left
package-lock.json out of sync — npm ci failed (`Missing: utf-8-validate@5.0.10`). Two false starts
taught the rule: regenerating from scratch on macOS prunes the linux/win platform binding *nodes*
(@rolldown/binding-linux-x64-gnu → vitest MODULE_NOT_FOUND on CI), and local npm 11 hoists deps
differently than CI's npm 10. CORRECT FIX: restore the original lock + `npm@10.8.2 install` IN
PLACE (no delete) → reconciles only the 5 missing nested utf-8-validate@5.0.10 nodes, preserves
every platform binding. Net: +5 nodes, 0 removed, 0 version bumps. RULE FOR FUTURE DEP CHANGES:
never delete package-lock.json to regen; install in place, and verify with CI's npm version
(`npx npm@10.8.2 ci`), not just local npm.

**Bundle = PR #54** (integration/next → main): verified native auth (v1.0.369) [noticeable] +
CI crash gate + lockfile fix [silent]. **CI fully green.** Awaiting owner "ship it".

---

## P49 auth-storage hardening (clear-on-signout) — 2026-06-28

Shipped on integration/next (rides bundle PR #54). Self-verifiable parts of P49:
- **Clear-on-signout** (ClerkTokenBridge): persisted native JWT wiped on a real
  signed-in→signed-out transition, ref-guarded so cold-start session restoration
  is never clobbered. Fixes stale-credential-after-signout.
- **Centralized token store** (frontend/src/lib/native-token-store.ts): single
  read/write/clear path → future Keychain swap = one-file change. +4 unit tests.
- **Corrected the false "Keychain" comments** (storage is @capacitor/preferences
  = UserDefaults today; honest TODO).
- Confirmed sub-item: FAPI exposes Authorization header for native flow (sim test).

**Review:** adversarial reviewer + /security-review → fundamentally sound, no
High/Medium vulns. 2 LOW defense-in-depth items (TOCTOU re-persist race;
cold-start stale token) — both security-nil (already-revoked sessions), deferred
to clerk-jwt-keychain-swap (their fixes risk re-sign-in regression, need device
verify). **CI green** (all 3 jobs).

Remaining for production (not beta-blocking): clerk-jwt-keychain-swap (move
UserDefaults→Keychain plugin, + the 2 LOW follow-ups).

---

## owner-player-identity plumbing (P34) — 2026-06-28

Fixed the "another player's scores shown as yours" bug by adding an explicit
owner→player mapping end-to-end. Shipped on integration/next (rides PR #54).

- **Backend:** migration 0005_008 (nullable rounds.owner_player_id); ORM +
  Pydantic Round/RoundCreate carry ownerPlayerId; create_round stores it
  (defaults to first player when omitted — behaviour-preserving);
  _build_full_round returns it with a first-round_player fallback for legacy
  rows. +2 integration tests.
- **Frontend:** canonical helper lib/round-owner.ts getOwnerPlayerId() (+4 unit
  tests); ALL read sites switched off players[0] (page.tsx x2, profile/page.tsx
  x2, profile-stats.ts x3); stale comments corrected.

**Verified:** frontend lint/tsc/voice265/unit284/build/native-crash green
locally; **CI Backend gate green = the 2 new integration tests passed in
Postgres** (couldn't run locally — no PG/Docker). **Security review: clean, no
findings** (additive migration, no IDOR, no injection; ownerPlayerId is a
caller-scoped opaque id).

**Remaining:** owner-player-identity-ux (round/new "mark me" UX → lets
ownerPlayerId differ from players[0]; needs designer review). Until then
ownerPlayerId defaults to the first player, so the visible fix lands with that
follow-up — but the plumbing + centralized correct reads are done.

---

## SHIPPED — bundle #54 merged to main + deployed — 2026-06-28

Owner approved ("ship it"). Merged PR #54 (23 commits) → main @ 7bb944b.
- Backend deployed via SSM: alembic upgrade 007 -> 008_round_owner_player applied
  on prod Postgres; scorecard-api restarted; /health {"status":"ok"}.
- Fresh integration/next cut (== main) for the next bundle.
- Full-bundle TestFlight build v1.0.383 (202606281304) uploaded from main — includes
  everything after v1.0.369: owner-identity (plumbing + "you" setup UX + correct
  home/profile stats), voice low-confidence missing-player note, clear-on-signout,
  CI crash gate, npm-10 lockfile fix.

Bundle contents shipped: native Clerk auth (verified), CI native-crash gate,
clear-on-signout, owner-player-identity (plumbing + UX), voice-low-confidence note,
lockfile fix.

---

## IN PROGRESS — voice setup fixes + future-feature planning — 2026-06-28

Owner tested the connected voice setup (v1.0.410) and reported (IMG_2959): the
transcript showed words he never said, out of order ("I only said hello first").

**Fixed (committed on integration/next, NOT yet built/shipped — needs owner go-ahead):**
- d478828 — Voice setup echo fix + preload:
  - Root cause of the garbled transcript: the mic had NO echo cancellation, so the
    phone speaker's caddie audio was picked up + transcribed as the user's turn →
    the model replied to its own echo → cascading out-of-order conversation. Fix:
    echoCancellation + noiseSuppression + autoGainControl on getUserMedia.
  - Preload (owner: "don't show 'loading caddie' on tap"): warm the Realtime
    session on round/new mount (muted, hidden) so opening is instant. Degrades
    gracefully — if mount-time getUserMedia is rejected (iOS gesture rule), it
    reconnects on the mic tap (= today's behavior, no worse).
  - Gates: tsc/eslint/voice265/build all green locally.
  - **BLOCKED:** TestFlight build gated by approval classifier (won't auto-deliver
    to the team without owner "ship it"). Awaiting owner go-ahead to cut the build.

**Planning (silent, done):** 372614d — planned the two future feature areas the
owner asked for (Social/Playing Partners + Course search/reviews). Added 11 phased
backlog cards (epics social-playing-partners + course-search-reviews), 2 epic cards
on the Product Board, and specs/social-course-features-plan.md.
- Owner's explicit UI question answered: **NO bottom tab bar** (SaaS chrome NORTHSTAR
  forbids; neither feature is a "camp here" destination). Promote the orphaned
  /players page to "Playing Partners" + contextual entries; one quiet /courses spoke.
- Biggest constraint surfaced: the app is single-owner gated (require_owner on every
  router); real social needs an owner decision to relax it + a security review.

---

## SHIPPED — bundle #61 merged to main + deployed + TestFlight — 2026-06-28

Owner approved the combined bundle (confirmed via question after the bundle grew past
the original "ship it"). Merged PR #61 (4 commits) → main @ 912eefb.
- **Backend deployed** via SSM (deploy.yml): new `POST /api/voice/live-token` is LIVE
  (returns 401 unauth = exists + auth-gated); config-status all keys present.
- **TestFlight build v1.0.415** (202606281804) uploaded from integration/next (==main).
- Fresh integration/next fast-forwarded to main (== main, clean base for next bundle).

Bundle contents (all NOTICEABLE):
1. Voice setup echo fix — echoCancellation on getUserMedia (caddie's own voice no
   longer transcribed as the user → fixes garbled/out-of-order transcript).
2. Caddie preload on round/new — warm Realtime session (muted, hidden) so the mic
   tap is instant; graceful fallback to connect-on-tap if iOS blocks mount-time mic.
3. Live score-entry words — Deepgram live WebSocket interim display in ScoreSheet
   (Web Speech was dead in WKWebView). Authoritative scoring path untouched; live
   path fully behind try/catch.
Gates: eslint/tsc/voice265/vitest315(+7)/build/ruff all green (re-run independently).
Review + /security-review: clean (endpoint fails closed, key stays server-side,
scoring path untouched). Device-only verification (WS streaming + warm-connect mic
timing) pending on owner's TestFlight test.

## DECISION CHANGE — floating island tab bar (owner override) — 2026-06-28
Owner overrode the earlier "no bottom tab" recommendation (IMG_2960): wants a floating
Instagram-style pill tab bar for the future-features nav. Updated backlog ui_decision +
specs/social-course-features-plan.md + both Notion epic cards. New card
`nav-floating-island-tab` (yardage-book styled, hidden on immersive screens). Saved as
memory floating-island-tab-nav. Follow-up `ratelimit-live-token` added (from sec review;
moot while owner-gated).

---

## P0 HOTFIX SHIPPED — v1.0.421 — 2026-06-28

Owner reported (IMG_2961) the voice setup filling with phantom multi-language messages
he never said. Root cause: the preload/warm-connect (d478828) kept the OpenAI Realtime
session LIVE while the sheet was hidden → whisper-1 hallucinated on silence/noise →
phantom user turns the caddie replied to. Fix (cd2e516): removed the preload entirely —
session mounts only while the sheet is open, tears down on close. Echo fix kept.

Owner approved "ship the bundle now". Merged PR #62 → main 83dfe03; backend deployed
(competition_legal accepted); TestFlight v1.0.421 (202606281834) uploaded. Bundle:
voice preload hotfix + plays-like card + comp-legal toggle (all gates green; 48 backend
tests for comp-legal).

Owner also asked re: noise handling. Answer: Realtime CAN do better — we under-use it
(no input_audio_noise_reduction, whisper-1 which hallucinates on silence, raw server_vad).
Queued `realtime-noise-hardening` (priority 12, ready): near_field noise reduction +
gpt-4o-transcribe (env-configurable) + semantic_vad. NOTE: any mint-config change can
break voice if a field/value is unsupported (cf. the earlier "Invalid modalities" 400) and
can't be live-tested headlessly — so it must NOT auto-deploy; it accumulates on
integration/next and ships only with owner approval + a voice-connect test on that build.

---

## SHIPPED — bundle #63 → v1.0.436 — 2026-06-28
Owner "ship it". Merged PR #63 → main 233e28a; backend deployed + healthy (new Realtime
mint code imports/runs; mint runtime still device-only). TestFlight v1.0.436 (202606281924).
Bundle: realtime-noise-hardening (near_field + gpt-4o-transcribe + VAD switch — TEST voice
CONNECTS), gps-capacitor-migrate, ux-wind-direction-viz, voice-setup-realtime-polish.
NOTE: mint config can't be verified headlessly — if voice won't connect on device, revert
the transcription model (env OPENAI_REALTIME_TRANSCRIBE_MODEL=whisper-1 / revert e90a7ef).

Owner reported 2 new bugs (queued, NOT in this build): voice-chat-ordering (HIGH, priority 3
— reply renders above the user's line; fix = order by conversation-item sequence) +
grabber-handle-drag-fix (swiping handle scrolls background). Both on backlog + Notion board.
Loop continues 30-min cadence; next tick takes voice-chat-ordering.

---

## BUILT on integration/next (pending device-verify) — social-partner-profile — 2026-06-28
Roadmap feature (epic social-playing-partners, A2; was needs-spec, DRY queue). Wrote spec
(specs/social-partner-profile.md) + opus plan (specs/social-partner-profile-plan.md), then
built. NEW read-only partner profile screen at /players/view?id= (static-export view+query
shell mirroring courses/round; Suspense + useSearchParams). Shows kicker "Partner", serif
name/nickname, MiniStat handicap + roundsPlayed, and a "rounds together" list (each taps to
the round). /players roster rows now tap through to the profile (edit + swipe-to-delete
preserved). Calm not-found/empty/loading states.

REUSED vs BUILT: reused owner-scoped getPlayersAsync (list-and-find, offline-resilient) +
getRoundsAsync — NO new endpoint, NO storage-api/types change, require_owner untouched, NO
friend graph. Built new lib/player-url.ts (playerHref) + pure lib/partner-rounds.ts
(getSharedRounds, NaN-date hardened) + 2 vitest files. SHARED-ROUNDS WAS FEASIBLE
client-side (round Player.id === SavedPlayer.id for roster players, set in round/new).

Commits: e2d6960 (feature) + 8153d9f (designer polish). Reviewer SHIP, QA PASS, designer
SHIP after 3 roster NORTHSTAR blockers fixed (row name -> serif; SaaS empty-state card ->
quiet serif placeholder + ghost CTA; CSS spinner -> mono "Loading..." text). Gates: lint 0,
tsc clean, voice 265/265, vitest 434/434, build (out/players/view emitted). Pushed to
integration/next; accumulated on rolling bundle PR #67 (NOT merged, NOT a TestFlight build
this cycle per task constraints). Classification: NOTICEABLE — rides the next bundle approval.
Follow-ups (not built): backend shared-rounds aggregation endpoint; friend graph.

---

## SHIPPED — bundle #68 → v1.0.520 — 2026-06-29 (the big one, ~15 features)
Owner "ship it". Merged PR #68 → main b475b82; backend deployed via SSM (migration 009
course_reviews applied; backend healthy; endpoints /api/scorecard/scan, /api/reviews/mine,
/api/courses/{k}/reviews all live = 401 unauth). TestFlight v1.0.520 (202606290754). 18
backlog items flipped done-shipped-main. Fresh integration/next == main.

Headline contents: OCR scorecard scan (camera→vision→review→import, end-to-end), materially
smarter caddie (DECADE hazard-aware aim + handicap-personalized dispersion + slope/terrain
advice + calm top-4 reasoning), course reviews (write+view), round-recap history insights,
player-name voice disambiguation, floating-island nav, recent-courses home, + homegrown
course-data POC (backend, validated viable; ingest script on deploy box to populate).

---

## 2026-06-29 — map-quality-loadany (NOTICEABLE — feat/map-quality-loadany, ready for bundle)

Vector yardage-book map as the primary hole-map style + load ANY searched course in the map
view (non-ingested courses center on GPS coordinates with a graceful "no detailed data yet" note).

### What was built

**Part A — Map Quality Polish (vector yardage-book primary)**
- `frontend/src/lib/map/satellite-helpers.ts` (extended): `MapBaseStyle`, `baseStyleUrl`,
  `osmFillColor`, `osmFillOpacity`, `osmOutlineColor` (HoleDiagram PAL colors for vector mode),
  `CourseDisplayMode`, `courseDisplayMode`, `CenterParams`, `parseCenterParams` pure helpers.
- `frontend/src/components/GPSMapView.tsx`: complete rewrite of the map init + overlay system.
  - Default style: `mapbox://styles/mapbox/empty-v9` base + T.paper background layer + OSM
    fill polygons at HoleDiagram PAL colors (sage fairway, deeper green, sand bunker, slate water).
  - Satellite toggle: `Layers` icon button adds/hides a `mapbox://mapbox.satellite` raster layer
    via `setLayoutProperty` (no `setStyle()` teardown, so custom sources/layers survive the toggle).
  - Per-hole `fitBounds` framing: tee→green bounding box with `pitch:35 / maxZoom:18 / bearing`
    aligned along the hole axis — replaces the old fixed `zoom:17/pitch:50/flyTo`.
  - F/C/B distance rings from player GPS position (or tee if no GPS): labeled arcs at front,
    center, back distances in yards; colored amber/emerald/orange.
  - Front/back green edge markers (white/orange `●`) added alongside existing pin/tee markers.
  - `centerOnly` prop: renders GPS + tap-to-measure on a centered view when `holeCoordinates` is
    empty (used for non-ingested courses).

**Part B — Load ANY Selected Course**
- `frontend/src/lib/map/satellite-helpers.ts`: `parseCenterParams` / `courseDisplayMode` functions
  route display to one of three modes: `ingested` (full hole data), `center-only` (lat/lng only),
  `no-data` (no course at all).
- `frontend/src/app/map/course/page.tsx`: reads `?lat=&lng=&name=` URL params; if the course ID
  doesn't resolve to an ingested course but valid center params exist, renders `<GPSMapView
  centerOnly={true} fallbackCenter={...}>` with a calm "detailed hole data not available" note.
- `frontend/src/components/CourseSearch.tsx`: `CourseSelectPayload` now includes `center?: {lat, lng}`
  forwarded from `CourseSearchResult.center`.
- `frontend/src/app/courses/page.tsx`: `onSelectCourse` now routes non-mapped courses (those with
  a `center` from the GolfAPI cache) to `/map/course?lat=…&lng=…&name=…` instead of a dead-end.
  Ingested courses still route to `/map/course?id=…` (full experience).

### Tests added
- `frontend/src/lib/map/satellite-helpers.test.ts`: 38 new vitest tests covering
  `baseStyleUrl`, `osmFillColor`, `osmFillOpacity`, `osmOutlineColor`, `courseDisplayMode`,
  `parseCenterParams` (valid, invalid lat/lng ranges, missing params, out-of-range coords).

### Gate results (all green)
- `npm run lint`: clean
- `npx tsc --noEmit`: clean
- `npx vitest run`: 1048/1048 pass (38 new tests)
- `npx tsx voice-tests/runner.ts --smoke`: 265/265 pass
- `npm run build`: succeeded

### Classification: NOTICEABLE
Map screen has a completely new default appearance (yardage-book vector instead of satellite),
a style toggle button, better per-hole framing, F/C/B distance rings, and any course from search
now opens in the map view instead of hitting a dead-end.

Branch: feat/map-quality-loadany (pushed to origin). NOT on integration/next yet — awaiting
eng-lead to fold into the rolling bundle.


---

## 2026-07-01 — Google Maps hole map: made it actually render, then polished (eng-lead)

### Shipped to main (merged)
- **#82 — Google satellite map finally attaches (simulator-verified).** The map never
  attached because we rendered a plain `<div>`; the plugin needs its own
  `<capacitor-google-map>` custom element (builds the WKChildScrollView the native side
  binds to). Plus a `patch-package` patch to the plugin: `render()` retries
  `getTargetContainer()` (permission dialog blocks WebView layout on first try),
  `onMapReady` listener registered BEFORE `create()` (was missed on fast attach), native
  `mapType` switch made case-insensitive (`"Satellite"` vs `"satellite"` → satellite now
  applies), + nil guards. Reproduced + verified in the iOS Simulator (see the
  `ios-simulator-map-testing` memory). Shipped TestFlight v1.0.608/609.
- **#83 — CI fix.** `npm install -D patch-package` under npm 11 deduped
  `utf-8-validate@5.0.10` out of the lockfile; CI's npm 10 `npm ci` failed (EUSAGE).
  Regenerated the lock in place with npm 10. main green again.

### In flight — PR #84 (map polish, TestFlight v1.0.612, awaiting owner on-device test)
Owner feedback on v1.0.609 ("renders but looks crazy"):
- Removed distance rings + red point markers; only a subtle tee→green guide line remains.
- Retuned `zoomForPaddedYards` (fractional 16–18.5) + pad 1.35→1.15 so it frames one hole.
- Safe-area top padding on the header so the Back button clears the status bar / notch.
- Subtle wind badge (arrow rotated to wind dir + mph, from `fetchWeather`).
- Inline round map + fullscreen page now derive green/tee centroids from mapped OSM
  geometry (`mappedCourseToCoordinates`) when GolfAPI coords are absent — satellite renders
  for any mapped course instead of dropping to the paper diagram.
- Fixed the guide line rendering blue (plugin parses strokeColor as hex, not rgba →
  `#FFFFFF` + strokeOpacity). Verified in the simulator.

### Ops
- Autonomous loop re-armed hourly at :07 (cron 7376c980).
- Sonnet-tier agents (builder/designer/product-manager/qa/release-manager) → `claude-sonnet-5`.

### Gates (all green): tsc · eslint · voice-tests 265/265 · map unit tests 61/61 · next build.
Classification: NOTICEABLE (map is visibly cleaner + zoomed in + Back works + wind + round map).
Branch: integration/next (PR #84 → main), awaiting owner "ship it" after testing v1.0.612.

---

## 2026-07-01 (later) — TestFlight unblocked + map Paper⇄Satellite toggle (eng-lead loop)

### TestFlight
- v1.0.615 (build 202607011134) and v1.0.612 had been silently DROPPED by Apple at
  ingestion (verified via the App Store Connect API — no Build record while the upload
  reported success). Root cause was Apple-side (agreement/hold); it cleared and BOTH are
  now VALID. 1.0.615 (the fully-polished map build) is the newest testable build.
  LESSON: verify builds land via the ASC API (JWT + /v1/builds), don't trust altool's
  "Upload succeeded" alone. Helper: $CLAUDE_JOB_DIR ascbuilds/ascfilter scripts.

### Loop iteration — backlog reconciled, well-scoped feature built
- Board + backlog.json reconciled: small items all [done]; epics are blocked (tee-time —
  needs Chronogolf creds), need owner product decision (Social / Virtual Match — multi-user),
  or low-priority/mostly-built (Course Search — /courses/[id] B1 ALREADY exists; backend
  reviews B2/B3 exist). No ready small item.
- Built: **Paper ⇄ Satellite map toggle** (PR #85). Wired the pre-existing but unused
  onSwitchToPaper + getMapViewPref/setMapViewPref. Default satellite; persists; on-Northstar.
  Verified in the iOS simulator. Gates green (satellite-helpers 81/81, voice 265/265, build).

### Needs owner direction (next big moves)
1. Social / Virtual Match — needs the multi-user product decision (relax owner-gate for
   social routes). 2. Tee-time real integration — needs Chronogolf/Lightspeed creds.
   3. Otherwise: greenlight Course-Search polish (B4 discovery) or map shot-tracking.

---

## 2026-07-01 (later 2) — map: tighter zoom + yardage-book distance panel

Owner feedback on v1.0.615 initial map load ("still a little far away", "yardages
aren't following the UI theme and color", "taking up too much space"):
- Bumped zoomForPaddedYards (~+1.5 levels) → loads zoomed into just the hole;
  matched the owner's reference screenshot framing in the iOS simulator.
- Restyled the fullscreen distance panel dark-SaaS → yardage-book (T.paper bg,
  serif ink numbers, T.mono labels, center in T.accent; paper-pill nav/controls);
  compact (dropped oversized padding + the noisy pin line).
- Rides on PR #85 (with the Paper⇄Satellite toggle). Gates: map units 60/60,
  voice 265/265, tsc/lint/build green. Verified in the simulator.

---

## 2026-07-01 (loop tick) — silent hardening of GPS camera-follow

Backlog reconciled: no build-ready small item — remaining backlog is [needs-spec]
(caddie/DEM/social/tap-to-target), [needs-decision] (social-friend-graph, green-
reading), [owner-action] (Clerk), or [epic]. PR #85 (map bundle: toggle + zoom +
panel + down-the-fairway bearing + GPS follow) is open awaiting owner's framing
confirmation. Didn't add churn to it or start a speculative epic.

Did: extracted the GPS camera-follow re-anchor decision into a pure tested helper
`movedBeyondYards(from,to,yards)` (true on first fix or >threshold move) + tests
(map helpers 73/73). No behavior change. Silent, rides along with #85.

Awaiting owner: (a) confirm the map framing on #85 (then cut a TestFlight build +
merge), (b) direction on the next epic — the actionable ones need his decision
(multi-user/social) or creds (tee-time) or a spec sign-off (tap-to-target plays-like).

---

## 2026-07-01 — SHIPPED map polish (PR #85) → TestFlight v1.0.624 (owner: "ship it")

Merged #85 to main (877652b). Build v1.0.624 (202607011339) VALID in App Store
Connect (verified via ASC API — 612/615 earlier had been dropped by an Apple hold
that has since cleared). Bundle: down-the-fairway camera bearing (hole plays up the
screen, tee box at bottom), tee-box framing, GPS re-anchor to the player, Paper⇄
Satellite toggle (persisted, default satellite), yardage-book themed compact
distance panel, guide-line/wind fixes.

CI caught a real miss: I'd flipped getMapViewPref default holediagram→satellite but
only updated one of TWO test files (ran targeted vitest locally, not the full suite).
Fixed satellite-map-pref.test.ts; full suite 1169/1169. LESSON: run `npx vitest run`
(whole suite) before pushing, and verify TestFlight builds land via the ASC API.

---

## 2026-07-01 (loop tick) — Google Places course search + map tap-to-target (PR #86)

Owner reported search broken ("bethpage black" → nothing). Root cause: fragile
OSM name-match + Mapbox geocoding + metered GolfAPI. FIX: added Google Places API
(New) text search as a robust source in backend course_search.py (_search_google_places
+ _dedupe_by_name; search_courses merges OSM-by-name + Places + OSM-near-Places).
Frontend unchanged (backend results already surface; map renders from a center
point). NEEDS OWNER SETUP: enable "Places API (New)" + a SERVER key (not the iOS
bundle key) → GOOGLE_PLACES_API_KEY in looper/prod. config-status now reports it.
Graceful no-op without the key.

Also this tick: map tap-to-target readout (carry + to-green on tap) — first DEM-free
slice of ux-tap-to-target (PR #86, rides along).

Gates: backend ruff + pytest green (new test_course_search); frontend tsc/lint/
full-vitest 1173/voice 265/build green. Backend change → deploys on merge to main.

---

## 2026-07-01 (loop tick) — OSM name-matching improvement (rides on #86)

Complement to the Google Places search fix: extracted osm_name_filter() — matches
all significant words (any order), drops generic golf stopwords, so "pebble golf"
matches "Pebble Beach Golf Links" and "bethpage black golf course" matches OSM's
"Bethpage Black". Works NOW without the Places key (which is still needed for
multi-course facilities OSM doesn't name per-course). Used by both OSM search
functions. 4 new tests; backend ruff + pytest green. PR #86 bundle.

---

## 2026-07-01 (loop tick) — map readout to the side + WHS handicap estimate

Owner feedback mid-tick: the tap-target readout tile covered the green → redesigned
it as a compact VERTICAL pill anchored to the LEFT edge (off the fairway/green).
Verified in the simulator (green now visible). Committed a667e74.

Loop tick (reconciled: Partners tab already wired to /players; handicap was
manual-only with differentials removed as "fabricated"): built a correct, fully-
tested WHS Handicap Index engine (frontend/src/lib/handicap.ts — scoreDifferential,
official lowest-N+adjustment table, estimateHandicapFromRounds best-8-of-20 over
completed 18-hole rounds; 15 tests). Wired into the profile: a manual handicap
still wins; when none is set + ≥3 rounds, show the computed estimate labelled
"Estimated from your last N rounds." Uses real tee rating/slope when available,
neutral 72/113 defaults otherwise (sharpens as course data fills in). Commit 7e076ae.

All rides in PR #86 (which also has: Google Places search [needs owner's Places key],
OSM name matching, map tap-target lines + reticle + readout). Gates: full vitest
1188/1188, voice 265/265, tsc/lint/build green.

Still paused: voice booking agent (Fable/Mythos access) — scaffold on feat/voice-booking-agent.

---

## 2026-07-01 (loop tick) — green-slope Q + handicap AGS cap

Owner asked (twice) about USGS-3DEP green-slope topology. Verified + answered: it's
built (elevation.py: EPQS + 3DEP batch sampler, Postgres cache; compute_green_slope
= 3x3 DEM grid around the green → direction/severity/description), wired into the
caddie (course-intel on caddie open → effective yards + "Green slope: <desc>" in
context; slope_miss_advice gives "where to miss" in the recommendation reasoning),
and already well-tested (test_slope_advice / test_green_slope_ingest / etc.). It gives
good/bad-miss guidance (overall tilt), not putt-reading — which matches what the owner
wants. Known gap (NOT built — owner is redesigning the hole card in Claude Design): the
round-card "ELEV +3ft" is a hardcoded placeholder; wiring it to the real per-hole data
is deferred into that design pass.

Loop tick (board query is plan-gated; reconciled against code — active threads all
blocked/under-design): correctness fix to the WHS handicap engine I shipped — cap each
hole at par+5 for the Adjusted Gross Score (WHS max for players without an established
index), so blow-up holes no longer inflate the estimate. Pure + non-circular. +1 test;
fixed the mkRound fixture. Commit 12c4b9c. Gates: full vitest 1193/1193, voice 265/265.

Still blocked on owner: GOOGLE_PLACES_API_KEY (search half of #86), Fable/Mythos
(voice booking agent). Deferred to Claude Design: round hole-card map + real ELEV/PLAYS.

---

## 2026-07-01 (loop tick) — security review of PR #86 search endpoint

Board query plan-gated; #86 is a 13-commit bundle nearing ship (awaits owner Places
key), and its NEW backend endpoint (Google Places course search) hadn't had the
CLAUDE.md-required security review. Reviewed it:
- FIXED (A): _search_mapbox interpolated the raw query into the Mapbox URL path →
  path-injection. Now quote()-encoded via _mapbox_geocode_url(); +2 tests. (c55dfdf)
- Clean: Google Places (JSON body + key in header), OSM (quotes/backslashes stripped),
  graceful [] on error.
- FOR OWNER (B): /api/courses/search is unauthenticated but now calls the PAID Places
  API → anonymous quota-burn risk. Frontend already sends the Clerk token via fetchAPI,
  so gating it behind Depends(current_user_id) would be transparent. Left as owner
  decision (shifts auth posture; matches other public course-data endpoints). Noted on
  the PR. Not pinged (minor decision, not a blocker).

Gates: ruff clean; full backend suite 821 passed / 34 skipped.

---

## 2026-07-01 (builder) — voice booking agent PRE-BUILD (phase 1b-D / epic phase 4)

Built work item D of specs/tee-time-booking-phase1b.md: the outbound voice booking
agent as PURE modules + a pro-shop simulator — NO real telephony, launch stays
owner-gated (budget + TCPA attorney). Ported specs/tee-time-voice-agent.md from
feat/voice-booking-agent onto integration/next, amended per the locked eng-lead
decision: NO card vault — payment is handed to the human staffer (epic §Track B);
the dialog declines card requests → needs_human.

- backend/app/services/voice_booking/: types, dialog (state machine: opener →
  slot negotiation → confirm → outcome), ivr (menu detect + DTMF choice),
  outcome (CallOutcome → stable BookingResult statuses), compliance (the Track B
  gates AS CODE: verified-landline allowlist, AI-disclosure-first line, 8am–9pm
  local hours, no-audio-storage flag, suppression list), phone_lookup (Places →
  pro-shop number; None without key), simulator (7 deterministic personas),
  provider (VoiceCallProvider behind the TeeTimeProvider ABC), telephony (STUB —
  RuntimeError unless VOICE_BOOKING_ENABLED=1 + Twilio creds, then NotImplemented).
- Route: POST /api/tee-times/book-by-call/simulate (owner-auth; dev/QA surface;
  never dials). NO real-call route yet.
- Tests: 51 pure unit tests + 5 route integration tests (CI's Postgres gate).
  Gates: ruff clean; full backend suite 895 passed / 51 skipped.

Silent item (backend-only; nothing owner-visible on TestFlight — the simulate
endpoint is a QA surface). Real-call track still needs: telephony platform choice
(Twilio DIY vs Vapi/Retell), creds + number + STIR/SHAKEN, per-course tz + verified
landline allowlist, TCPA attorney review, first supervised test call.

---

## 2026-07-01 (owner-directed session, Fable 5) — TEE-TIME BOOKING EPIC: Phase 1b + Phase 4 pre-build

Owner asked (in-session) to drive the tee-time booking EPIC (board card 38e1c525…7050,
plan specs/tee-time-booking-plan.md). Recon found Phase 1 scaffolding ALREADY on
integration/next (TeeTimeProvider ABC + mock + /api/tee-times/* + real 3-phase UI), so
scoped "Phase 1b — make it real" (specs/tee-time-booking-phase1b.md) and ran 4 Fable 5
builders sequentially/parallel on the #86 bundle:

- A `7b10be1` backend real data: AffiliateLinkProvider (real courses via extracted
  services/course_finder.py — OSM/Places/Mapbox; NEVER fabricates availability; book() →
  needs_human + bookingUrl), 15-min TTL search cache (services/tee_times/search_cache.py),
  owner-scoped tee_time_bookings table + Alembic 0007 + GET /api/tee-times/bookings.
  Slot gained estimated:bool; priceUsd nullable (3-layer sync).
- B `304a19b` frontend real data: geolocated area on every query (lib/teetime/location.ts,
  GPSWatcher pattern), real nearby courses replace DEFAULT_COURSES (+ radar pins), honest
  "Held for you to book → Book on the course site" confirm, zero-dep ICS calendar with
  VALARM (lib/teetime/ics.ts), per-window date fix (Sunday ≠ Saturday; lib/teetime/dates.ts).
- C `bb05ae6` hold-to-talk voice prefs: parseTeeTimePrefs intent (Zod + heuristics +
  repair loop per pipeline.ts), appliers in lib/teetime/voice-prefs.ts, auto-advance on
  complete request; +9 voice-tests cases (new /api/parse-tee-time lane). NOTICEABLE.
- D `87424b9` voice booking agent PRE-BUILD (epic Phase 4, "paused for Fable 5" → unblocked):
  services/voice_booking/ pure modules (dialog state machine, IVR nav, outcome→BookingResult,
  compliance-as-code: landline allowlist, disclosure-first, 8am–9pm, STORE_AUDIO=False,
  suppression list — all fail closed) + 7-persona pro-shop simulator + owner-auth'd
  POST /api/tee-times/book-by-call/simulate. NO card vault (eng-lead call: human takes
  payment, per plan Track B). telephony.py stub raises unless VOICE_BOOKING_ENABLED+creds,
  then still NotImplemented — launch stays owner-gated (budget + TCPA attorney).

Mid-session the other loop session committed e22b9c0 (auth on /api/courses/search) — rode along.

Combined-tree gates (re-run by eng-lead): ruff clean; pytest 895 passed/51 skipped; tsc/lint
clean; vitest 1265/1265; voice smoke 274/274; next build green. Adversarial + security
review (fresh context): 1 medium finding — /api/tee-times/search unauthenticated + paid
Places — VERIFIED FALSE POSITIVE (main.py:81 registers the router with require_owner);
cleared: IDOR on bookings, OSM/Mapbox injection, PII/transcript persistence (none), no
live-dial path reachable. Follow-up nit: RFC-5545-escape bookingUrl in ics.ts (defensive).

Board: sub-card "Tee-time booking Phase 1b" (Needs Review, Major) 3901c525…b74b; epic card
phases updated. Default provider still mock — flip TEETIME_PROVIDER=affiliate after the
owner sets GOOGLE_PLACES_API_KEY. Owner actions unchanged: Lightspeed creds email, GolfNow
affiliate application, voice-track go (platform/budget/lawyer/allowlist).

Housekeeping: gitignored the stale accidental nested clone ./scorecard/ (634M, old commit,
no unique work — owner may delete it).

Polish backlog (from builders): live interim transcript while holding, clock-time parsing
("around 8am"), sat/sun abbreviations, guest placeholder hdcp, ICS share-sheet fallback if
WKWebView download is flaky, ICS URL escaping.

---

## 2026-07-01 — round map: interactive inline + fullscreen blow-up

Owner wants the hole map interactive + zoomable to a big fullscreen view. The native
Google map can't live inside the swipeable/animated hole card (renders behind the
webview, can't track CSS drag/animation). So: kept the interactive inline map in the
round view, added an expand button → full-screen interactive map overlay (fixed
inset-0, whole screen, pan + tap-target + hole nav + GPS; hole changes sync back).
New useHoleCoordinates hook shares per-hole coords between inline + fullscreen.
Verified in sim: fullscreen fills the entire screen (Bethpage, hole framed). Pushed
to integration/next (ba2eaf9). NEXT: one-card composition (map inside the hole card
replacing the schematic) — to land with the owner's Claude Design layout.

Also this session: security(search) — URL-encoded Mapbox query + auth on /search
(paid Places). Places key saved (goes live on backend restart; verify config-status
+ a real search). Fable session pushed tee-time phase 1b-A to the same branch.

---

## 2026-07-01 — SHIPPED: #86 bundle merged to main (owner "ship it", in-session)

Owner approved in-session. Merged PR #86 → main (16cf7de) with green checks; fresh
integration/next fast-forwarded to main and pushed. Backend auto-deployed via SSM
(run 28556050992, success) — alembic upgraded 009→010_tee_time_bookings on prod.
Bundle contents: tee-time phase 1b (A–D) + Google Places course search + search auth +
OSM name matching + map tap-to-target + WHS handicap + round-map interactive/fullscreen
(ba2eaf9, landed by the loop session just before merge — flagged to owner post-merge).
Board: Phase 1b card → Shipped. Provider default still mock: flip TEETIME_PROVIDER=affiliate
once GOOGLE_PLACES_API_KEY is set (also needed for search half of the shipped work).

---

## 2026-07-01 — course-search race fix + append-only rendering (work item 2, frontend)

Owner escalation: search results slow, reshuffle mid-read, show irrelevant towns
("Bethpa" → Bethel Island/Bethanga). Implemented specs/course-search-fix-plan.md
work item 2 (frontend half; a parallel builder did item 1, backend relevance/speed/
local-first, in the same working tree — untouched here). Committed d20b289 to
integration/next.

- `frontend/src/lib/golf-api.ts` searchAllCourses(query, {signal, onResults}):
  the AbortSignal was created in CourseSearch.tsx but never threaded through
  (dead code) — now passed into all three legs (mapped, golfapi proxy incl. its
  own fetch call, osm), restructured from Promise.all-then-sort into an
  append-only merge (each leg calls onResults with the cumulative filtered/
  deduped list as it settles; nothing already delivered is ever removed/reordered).
- New `frontend/src/lib/course-search-session.ts`: owns the AbortController +
  a stale-query guard (belt for abort-race browsers) so a superseded query's
  results/errors can never reach the UI. Pure TS, independently unit-tested.
- `frontend/src/components/CourseSearch.tsx`: wired to the session. Also fixed
  2 new eslint-plugin-react-hooks `set-state-in-effect` errors that appeared
  once the effect shape changed (pre-existing code was apparently under an
  analyzer bailout that lifted after the refactor) — moved the query-change
  reset into the input's onChange handler and made GPS-nearby state start
  "loading" directly instead of setting it synchronously in an effect body.
- `frontend/src/lib/course-search-helpers.ts`: added matchesQueryPrefix /
  tokenizeCourseName / courseNameKey — mirrors the backend's
  matches_query_prefix (stopwords golf/course/club/links/country/the stripped
  from the query only; every query token must prefix-match a name token) as
  defense in depth so towns never render even against a stale backend.

Tests: +27 (helpers: prefix filter incl. Bethpage repro table; golf-api-search:
append-only batches, dedupe, relevance filter, abort reaching every fetch leg;
course-search-session: stale-guard under out-of-order resolution). Gates:
tsc/lint clean, vitest 1292/1292 (was 1265), voice smoke 274/274, build green.
SILENT (bug fix, not a new surface) — rides along in the bundle.

NEXT (work item 3, needs both halves): persist courseLat/courseLng on Round,
drive RoundPageClient's satellite map from the anchor instead of by-name
resolution, and unify the Courses-tab select handler to route to course detail
instead of bare /map/course. Touches resultToPayload/onSelectCourse callers in
CourseSearch.tsx (unchanged by this item) plus round/new + RoundPageClient.

## 2026-07-01 — course-search relevance + speed + local-first (work item 1, backend)

Owner escalation ("asked many times"): "Bethpa" returning Bethel Island/Bethanga
towns, "Bethpage Black" showing non-matches, search slow + no cache, no local DB
consulted. Implemented specs/course-search-fix-plan.md work item 1 (backend half;
the parallel frontend builder already landed item 2 in this same working tree,
commit d20b289/2b24804 — untouched here). Committed d24acd3 to integration/next.

- `backend/app/services/course_finder.py`: new pure helpers —
  `matches_query_prefix(name, q)` (fold case/accents/apostrophes, drop golf
  stopwords from the QUERY only, every remaining query token must PREFIX-match
  some name token) + `rank_courses(courses, q, anchor=None)` (tiered stable sort:
  exact normalized-name match > all-token-prefix > local/mapped source >
  haversine distance to anchor > alpha) + write-through identity
  (`deterministic_course_id`/`external_course_key`/`external_course_rows`/
  `attach_stable_ids`, reusing osm_ingest's UUID v5 convention so a richer
  ingest later lands on the same courses row).
- `backend/app/routes/course_search.py`: /api/courses/search rewritten —
  cache → LOCAL FIRST (courses_mapped, relevance-gated) → fan out only when
  local has <3 passing hits (OSM-by-name + Google Places via
  `asyncio.gather`, tight interactive budgets) → Mapbox fallback ONLY as a
  location anchor for a name-filtered OSM search (the geocode place itself is
  NEVER returned as a course — that was the town-name bug) → relevance gate
  applied to every candidate from every source → rank → write-through new
  external hits. `_list_local_courses`/`_write_through_courses` lazily import
  `courses_mapped` (module-level import would require DATABASE_URL to even
  collect this test file).
- `backend/app/services/osm.py`: `search_golf_courses(..., interactive=True)`
  — Overpass `[timeout:4]`, 5s client timeout, 0.5s retry backoff (vs. 2s
  ingest-path default) for the live-search path only; ingest callers unaffected.
- `backend/app/services/course_search_cache.py` (new): TTL cache for
  /api/courses/search — 24h positive / 5min negative, injectable store, same
  file-backed idiom as tee_times/search_cache.py.
- `backend/app/services/courses_mapped.py`: `list_courses(search=...)` is now
  RANKED (name-prefix boost then `similarity()` desc) instead of
  `updated_at desc`; new `write_through_courses(rows)` — `ON CONFLICT (id) DO
  NOTHING` insert into `courses` (id/name/address/location only, geometry
  NULL — the course editor fills in holes later).
- `backend/migrations/versions/0008_011_courses_trgm_index.py` (new head,
  010_tee_time_bookings → 011_courses_trgm_index): `CREATE EXTENSION IF NOT
  EXISTS pg_trgm` + GIN trigram index on `courses.name`. Verified via
  `alembic history` (resolves cleanly) and `alembic ... --sql` (correct DDL).

Tests: +40 new (Bethpage repro table incl. "bethpa"→Black/Red/Green only,
"bethpage black"→exactly Black, towns-never-emitted incl. a real nearby OSM
club that still fails the gate, ranking tiers, local-first short-circuit skips
ALL external calls, cache hit skips everything, write-through idempotency) —
all 8 pre-existing course-search contract tests (osm_name_filter, dedupe,
no-key Places noop, Mapbox URL encoding) pass UNCHANGED. Gates: `ruff check .`
clean, `pytest -q` 935 passed (was 895) / 51 skipped (integration tests need
Postgres — run in CI, not locally, per policy). DB-backed paths
(`courses_mapped.list_courses`/`write_through_courses`, the new migration) are
exercised only by CI's Postgres-backed integration suite — not run locally.

Deviations from the plan: (1) normalize_query/rank_courses' exact-tier are
word-order-INVARIANT (sorted tokens) — "black bethpage" and "bethpage black"
now share one cache entry and both correctly hit the exact tier, which the
plan didn't specify but is consistent with the prefix gate already being
order-independent. (2) The old unfiltered-nearby-OSM fallback radius (20000m)
is now the same 8km facility-expansion radius as the Places branch, per the
plan's explicit "8km facility expansion" language for the anchored path.

Frontend mirror contract (already implemented by the parallel builder,
`frontend/src/lib/course-search-helpers.ts`): `matchesQueryPrefix(name,
query): boolean` — same semantics as `matches_query_prefix`. Confirms the two
halves agree independently.

NOT noticeable via TestFlight build number alone — same UI, but the owner's
literal repro ("bethpa" showing towns) is fixed; recommend flagging this
bundle for a quick manual retest of that exact search before "ship it" since
it's the top escalation. Risk: LOW-MEDIUM — endpoint behavior changed
(local-first + relevance gate can only narrow results, never widen beyond
what previously matched) and a new additive migration; no new external
dependency; no auth/data-handling change. Local-first path is untestable
without Postgres locally — CI is the real gate for that half; recommend
running `/security-review` + `/code-review` before this bundle ships per
CLAUDE.md's "new endpoint/data-layer behavior" rule.

NEXT (work item 3, needs both halves): persist courseLat/courseLng on Round,
drive RoundPageClient's satellite map from the anchor, unify the Courses-tab
select handler to route to course detail instead of bare /map/course.

---

## 2026-07-01 (owner session, Fable 5) — COURSE SEARCH OVERHAUL + yardage-book satellite

Owner escalation ("asked many times"): search slow/janky/irrelevant ("Bethpa" → Bethel
Island/Bethanga towns), results reshuffle mid-read, and the round screen showed the paper
mock instead of the real map. Diagnosis (specs/course-search-fix-plan.md): 2-5 SERIAL
external calls per keystroke w/ no cache; dead AbortController (stale-response races);
Mapbox town-geocode fallback w/ no golf filter (prod has NO GOOGLE_PLACES_API_KEY —
confirmed via config-status — so this fired constantly); round screen resolves course
BY NAME, silently drops to paper on miss.

Landed on integration/next:
- d20b289 frontend search: signal actually threaded (abort works), stale-query guard
  (course-search-session.ts), append-only progressive render (never reshuffles),
  client prefix filter mirror. vitest 1292.
- d24acd3 backend search: matches_query_prefix relevance gate on ALL sources (every
  query token must prefix a name token — "bethpa" can't match "bethel"), tiered ranking,
  Mapbox = anchor-only (towns never emitted), asyncio.gather + tight timeouts
  (Overpass [timeout:4]/5s/1 retry @0.5s), 24h/5min TTL cache, pg_trgm GIN index
  (migration 011) + ranked local-first + write-through of external hits into courses.
  pytest 935.
- 7c65439 + c937ab2 round anchor (item-3 builder hit usage limit w/ zero output;
  eng-lead built it directly): rounds carry courseLat/Lng + mappedCourseId (migration
  012, additive nullable; validated at the edge), round/new sends them from the search
  selection, RoundPageClient drives inline + fullscreen satellite from the anchor
  (by-name = legacy fallback only; paper only when no location at all).
  InlineHoleDiagram: courseId optional + fallbackCenter center-only mode.
  DEVIATION from plan item 3.3: courses-tab select routing UNCHANGED — the detail page
  only supports GolfAPI courses; rerouting mapped/OSM there would break. Follow-up:
  mapped-course detail support, then unify destinations.

Gates (combined tree): ruff clean, pytest 935/53sk; tsc/lint clean, vitest 1300/1300,
voice 274/274, build green. Security pass: anchor inputs validated (uuid regex +
lat/lng bounds), write-through parameterized, cache paths fixed, endpoint auth
unchanged/narrowed. Owner said "ship it" pre-authorized after finish.

STILL OWNER: GOOGLE_PLACES_API_KEY in prod (config-status shows google_places:false) —
search works without it now (no more towns) but coverage improves with it.

---

## 2026-07-01 — SHIPPED: #87 course search overhaul (owner "ship it", pre-authorized)

Merged PR #87 → main (09246bd) with all checks green (frontend/backend/E2E). Backend
deployed via SSM; alembic ran 010→011_courses_trgm_index→012_round_course_anchor on
prod (verified in deploy log). Board card 3911c525…ac4c → Shipped. TestFlight build
kicked via ship.sh. Item-3 note: the voice-agent-era builder for this item died on
usage limits with zero output; eng-lead implemented directly (anchor plumbing,
InlineHoleDiagram fallbackCenter mode, edge validation). Live-prod "bethpa" repro not
probed directly (owner-auth'd endpoint); covered by CI Postgres integration tests —
owner should confirm on the new TestFlight build.

---

## 2026-07-01/02 — SHIPPED: #88 yardage book + round setup polish (owner live session)

Owner iterated live with screenshots; eng-lead built directly (builders were hitting
usage limits). Bundle (merged as #88 after sim verification):
- 392f182 caddie demo card OUT of the round page (Ask Caddie → CaddieSheet = the one
  real voice caddie path); hole chip strip → "Hole N/M" pill + grid modal (b/w played
  shading, haptic on jump).
- d3ec79e multi-add players: one roster sheet, tap saved players to add/remove several,
  inline new-name input; single-row editor unchanged for rename/this-is-me.
- 5119e72 format picker MULTI-SELECT with per-format stakes (chips + custom $), border
  renders immediately, no auto-close, "No stakes" exclusive; createRound emits one Game
  per format. NATIVE HAPTICS: @capacitor/haptics via lib/haptics.ts — discovery:
  navigator.vibrate is ignored in iOS WKWebView, so every existing haptic call was
  silent on device; all sites now work.
- b0ecf76 hole card renders the REAL satellite hole map in place of the mock
  HoleIllustration (Zoom pill → fullscreen); duplicate lower map section removed;
  pointer-capture stops map pans from triggering hole swipes. Mock only renders for
  anchor-less legacy rounds.
- Lockfile: npm 11 pruned optional deps on the haptics install → CI npm ci red →
  fixed IN PLACE with npx npm@10 install --package-lock-only (standing lesson held).

Verification: full frontend gates (vitest 1300, voice 274, build) + iOS SIM check per
SIMTEST.md (Debug build w/ haptics pod, healthy boot, authdiag loaded=true, no page
errors, sign-in screenshot) BEFORE TestFlight. CI green on rerun; merged to main;
TestFlight build kicked (frontend-only — backend deploy is a no-op rerun).

---

## 2026-07-02 — SHIPPED: #89 map-first hole view (owner "cut it")

Owner feedback on v1.0.664 (screenshot with red outline): map much larger; hole data +
hole-selection button overlaid statically on the map. Built 584fd01: satellite map IS
the hole card (58vh clamped 380-640px); picker pill top-left + compact stats chip
(NN · Par · yds · Hcp) top-right as blur-backed overlays; Zoom above the map's own
distance strip; mock wind/elev tiles + duplicate F/C/B cards removed; HoleCard reverted
to illustration-only (mapSlot plumbing removed) — renders only for anchor-less legacy
rounds. Gesture split: map touches pan the map (pointer-capture guard checks
data-overlay), overlay chips remain hole-swipe surface. Merged as #89 (CI green),
TestFlight v1.0.667 (202607020013) uploaded.

---

## 2026-07-02 — SHIPPED: #90 map-first polish round 2 (owner "ship it")

Three refinements on v1.0.667 feedback: 8a0116a wind/elev/plays + F/C/B tiles restored
INSIDE the map card below the satellite (F/C/B now real from-tee via
computeFCBDistances when coords exist; wind/elev remain known placeholders);
169771f flick-on-map hole swipe (fast/horizontal single-touch → goHole + haptic;
slow drags/taps/pinches stay map gestures — disableTouch() rejected since it kills
tap-to-measure); 9c2efff inline map's dark F/C/B strip removed as redundant (fullscreen
panel unchanged; Zoom re-anchored by mapHeight since the card continues below).
NOTE for later: the strip was the inline view's only LIVE player-distance/GPS readout —
candidate follow-up: tiles switch from-tee → from-you when on-hole.
Merged as #90, TestFlight cut.

---

## 2026-07-02 — IN BUNDLE: agentic caddie P1 — wire the existing brain (builder)

Spec: specs/agentic-caddie-plan.md, phase P1 only. The live in-round CaddieSheet now
runs session-first: RoundPageClient starts the Postgres caddie session on mount for
online rounds (clubs + handicap hydrated), fires course-intel once (mapped hole coords
+ courseLat/courseLng anchor; weather-only for anchor-only rounds), and ends the
session on finish (memory summarization + learning aggregation fire). Sheet calls
/caddie/session/voice + /session/recommend with silent stateless fallback (legacy/
offline/local rounds keep working). Persona fix: cosmetic CADDIES "steve" replaced by
real backend personas via new useCaddiePersona (GET /caddie/personalities + profile
preference, localStorage offline fallback) + a quiet picker in the sheet header.
Backend: /session/shot now dual-writes durable Shot rows (voice-logged shots feed
learning from day one) with a 30s identical-shot retry guard; new GET/PUT
/api/caddie/profile (preferred_personality_id upsert, persona validated via
personality_visible). Silent: CLAUDE.md "no real DB" line fixed; fetchWeather client
fixed to query params (was silently 422ing). Gates: ruff clean; pytest 935 passed /
63 skipped (10 new DB-backed integration tests skip locally, run in CI); tsc + lint
clean; vitest 1313 (13 new); voice smoke 274; build OK. Noticeable on TestFlight
(persona picker + real session context). P2 (realtime orb) builds on
caddieSessionActive + personaId now available in RoundPageClient.

---

## 2026-07-02 — AGENTIC CADDIE P1+P2 built (owner's main-focus epic, plan-mode approved)

Owner approved specs/agentic-caddie-plan.md ("one brain, two mouths"; diagram in specs/).
Board epic card 3911c525…8bf5. Built by Fable 5 builders:
- f6b6806 P1: CaddieSheet → SESSION endpoints (hole intel/weather/memories/thread) w/
  stateless fallback; session lifecycle on round mount/finish; persona fix + quiet picker
  (kills "steve"→classic); /session/shot dual-writes durable Shot rows (voice shots feed
  learning.py from day one); GET/PUT /api/caddie/profile. CLAUDE.md stale-DB line fixed.
- bb10107 P2: scripted VoiceOrb demo DELETED — hold-to-talk gpt-realtime orb (press=unmute,
  release=reply aloud, warm connection, 90s idle cutoff, one-connection cap); tool surface
  v1 (get_recommendation/record_shot/get_conditions/get_player_profile/get_carries-stub/
  session_status) + fabrication ban in instructions; POST /session/message shared ledger;
  degradation ladder transport.ts (realtime→CaddieSheet→OfflineCaddieCard from IndexedDB
  HoleIntelBundle).
- 59bfbaf + e7f0075 security: persona visibility gate on ALL THREE load paths (P1 review
  note + P2 review finding — the mint returned private persona prompts verbatim).
Reviews: P1 security review CLEAN; P2 review 1 should-fix (fixed, e7f0075), everything
else verified (mint TTL/scope, ledger caps/roles, owner scoping, dual-write idempotence,
mic mute on reconnect). Gates combined tree: pytest 943/74sk, ruff clean, vitest 1343,
voice 274, tsc/lint/build clean. Next: P3 (carries + polygon DECADE) ∥ P4 (learned
distances) after ship; P5 persona studio.

---

## 2026-07-02 — OWNER: caddie P3 + P4 PAUSED

After shipping P1+P2 (#91), owner paused P3 (hazard carries + polygon DECADE) and
P4 (learned distances). Do NOT dispatch builders for them — the spec
(specs/agentic-caddie-plan.md) stays the plan of record; resume only on owner say-so.

---

## 2026-07-02 — SHIPPED: #92 tee-time real courses by default (Places key live)

Owner added the Places key (initially as GOOGLE_PLACES_KEY in looper/client; moved by
owner to GOOGLE_PLACES_API_KEY in looper/prod after eng-lead found the name+secret
mismatch — note: the app reads looper/prod at boot, key names must match env vars
exactly). Backend restarted via deploy rerun → config-status google_places:true.
Flipped TEETIME_PROVIDER default mock→affiliate (real nearby courses, honest handoff)
with a never-empty mock-fallback (labeled) when the real search finds nothing; +5 unit
tests; 2 integration tests pinned to TEETIME_PROVIDER=mock (they assert mock semantics
and had relied on the old default — assertions unchanged). Merged #92, deployed.
Backend-only: existing TestFlight build v1.0.680 now shows REAL courses on tee-time +
course search gains the Places leg.

⚠ INCIDENT (eng-lead error, owner notified in-session): a failed put-secret-value
attempt echoed the FULL looper/prod payload (DB password + Anthropic/OpenAI/Deepgram/
GolfAPI/Mapbox keys) into the session transcript. Recommended rotation (esp. RDS
password + paid API keys). Owner aware; rotation pending owner action.

---

## 2026-07-06 — course routing unified (item 3.3 follow-up) + bundle PR #93 (owner session, Fable 5)

Resumed the usage-limit-killed checklist. Items 1+2 (backend/frontend search) and the
satellite-in-yardage-book half of item 3 had already shipped (#87/#88); what remained was
the DEFERRED tail of item 3.3 (unified routing — blocked then because /courses/[id] only
spoke GolfAPI) + review/QA/ship. Landed on integration/next:
- 0628b2d ios: CapacitorHaptics registered in CapApp-SPM (uncommitted cap-sync rider
  from #88 found dirty in the tree — fresh checkouts would silently lose haptics). SILENT.
- ff2b043 courses: one detail landing for every search source. courseDetailHref() in
  course-url.ts maps any selection → /courses/view (mapped → src=mapped, fetches
  /api/courses/mapped/{id} for par/holes/tee-sets; centre-carrying osm/local → display
  params in URL, no backend row needed; golfapi unchanged). /map/course = viewer reached
  FROM detail (quiet Hole map / Satellite map row), never a landing. Start-a-round from
  detail stashes source+center → round carries the anchor → satellite yardage book.
  Recents persist source/center (old rows fall back to the golfapi path). +11 tests.
- 576e5a1 courses: hub "Course maps (beta)" Bethpage rows routed through
  courseDetailHref too — designer review BLOCKER (they reproduced the exact
  inconsistency one screen below the fix). NOTICEABLE (with ff2b043).

Review: adversarial reviewer CLEAN (verified load-effect races, not-found gate, URL-param
XSS, malformed lat/lng, legacy-recents compat, golfapi regression). Designer: passes after
the blocker fix; non-blocker filed to backlog.json (map-viewer-error-screen-restyle: the
/map/course ErrorScreen is off-brand and now gets more traffic). QA: Bethpage repro —
backend course-search suite 48/48 (bethpa → Bethpage only), frontend mirror in vitest.
Gates: tsc/lint clean, vitest 1374/1374 (one unreproducible flake on a single run — 3
subsequent runs green; CI re-gates), voice smoke 274/274, build green, ruff clean.

Bundle PR #93 opened (integration/next → main): tee-time honest course list (ad0d65d,
noticeable) + unified detail landing (noticeable) + haptics rider (silent). Owner is
in-session — approval requested directly, no push notification needed.

---

## 2026-07-06 — SHIPPED: #93 unified course-detail landing + honest tee-time list

Owner approved directly in-session (no email/push loop needed — already in the session).
Merged PR #93 → main as **cf2d4aa** ("Merge integration/next: unified course-detail
landing + honest tee-time list (#93)"). Pre-merge check (against the correct base,
`origin/main` — local `main` ref was stale and pointed at old #85; re-pointed it to
`origin/main` before diffing): confirmed zero `backend/` changes in this bundle
(frontend + iOS only) → **no backend deploy** needed, existing API deployment untouched.

**TestFlight:** SPM manifest changed (haptics rider), so cut a fresh native build via
`ops/ios/ship.sh` — **v1.0.691 (build 202607062035)**, uploaded and confirmed **VALID**
via the App Store Connect API (`/v1/builds` polled by version, ~3 polls / ~90s to
ingest+process). Live for the "Looper Team" internal TestFlight group.

**Board:** no existing card for this bundle (searched; the #87 "Course search overhaul"
card's FOLLOW-UPS note referenced this work but was already Shipped/closed for #87) →
created a new card directly in Shipped: "Bundle #93: unified course-detail landing +
honest tee-time course list" (https://app.notion.com/p/3961c52592e081eda0f7e03123cc6b24),
PR link + full checklist + build number.

**integration/next:** fast-forwarded to cf2d4aa (== new main) and pushed — synced and
ready to keep rolling; branch not deleted.

---

## 2026-07-06 — course search v2 reviewed + bundle PR (owner session, Fable 5)

Both v2 builders landed (see entries above); eng-lead review pass on the combined tree:
- Security review (reviewer agent, /security-review): NO findings — legHealth.detail
  traced on every raising leg (status codes only, keys travel in headers, mapbox
  swallows), auth unchanged, no injection/XSS.
- Designer (Playwright on dev, iPhone-13 viewport): pass-with-polish; VERIFIED the
  no-layout-shift fix (surface bbox identical across idle/loading/results). One
  blocker: star <button> nested in row <button> (invalid HTML, hydration warnings,
  iOS hit-testing) — FIXED in 67138a1 (row -> div[role=button], star 34px target,
  title 16 / chevron 10 idiom match).
- Eng-lead caught what the reviews missed: the parallel GolfAPI leg would burn the
  45-calls/MONTH budget on typed prefixes (each distinct prefix = fresh discovery
  cache key; budget shared with per-course golf-data fetches). FIXED in 67138a1:
  GolfAPI is now a fallback leg (only when Places is empty); legHealth omits it
  when skipped; +1 route test.
Combined gates: backend 960 passed/74 skipped + ruff clean; frontend tsc/lint clean,
vitest 1395/1395, voice 274/274, build green.

Bundle: search v2 (backend Places-primary + full-screen UI) — NOTICEABLE, awaiting
owner approval (in-session). Owner test: type "Pebble Beach" (results ~1-4s, no
resize), "Bethpa" (only Bethpage), start round from a search pick.
Open follow-ups: /map/course ErrorScreen restyle (backlog); prod Places key
"Places API (New)" enablement UNVERIFIED (probe blocked) — legHealth in the
response now surfaces it: hit /api/courses/search?q=pebble+beach and check
legHealth[0] once deployed.

---

## 2026-07-06 — SHIPPED: #94 course search v2 (Places-primary + full-screen search)

Owner approved directly in-session ("ship it", 2026-07-06). Merged PR #94 → main as
**1792d3281e4fb766fd355d028465ed1756416311** ("Merge integration/next: course search v2 —
Places-primary + full-screen search (#94)"), a merge commit (not squash/rebase) — the only
push to `main` in this run.

**Backend deploy:** this bundle DOES touch backend (`backend/app/routes/course_search.py`,
`services/course_finder.py`, `services/course_search_cache.py`; no new Alembic migration).
The standing `Deploy backend (SSM)` GitHub Action auto-triggered on the merge push (run
28836206269) — `git pull --ff-only` d233dd6→1792d32, `uv sync`, `alembic upgrade head`
(no-op, no new revision), `systemctl restart scorecard-api`, on-box
`curl localhost:8000/health` → `{"status":"ok"}`. Verified externally post-deploy:
- `GET https://api.looperapp.org/health` → `{"status":"ok"}` (200)
- `GET https://api.looperapp.org/api/config-status` →
  `{"deepgram":true,"openai":true,"anthropic":true,"mapbox":true,"golfapi":true,"google_places":true}` (200)

**TestFlight:** frontend changed substantially (full-screen search UI + lib collapse), so
cut a fresh native build via `ops/ios/ship.sh` — **v1.0.701 (build 202607062201)**. Upload
succeeded (xcodebuild export log, ~90s archive+upload), then polled the App Store Connect
API (`GET /v1/builds?filter[app]=…&filter[version]=202607062201`, JWT signed ES256 with the
ASC key via `uv run python` + PyJWT/httpx from the backend venv — no dedicated poll script
exists yet, built one ad hoc at
`/private/tmp/.../scratchpad/poll_build.py`) — **VALID** after ~5 polls (~100s). Live for
TestFlight Internal.

**Board:** no existing card for this bundle → created directly in Shipped:
"Bundle #94: course search v2 — Places-primary + full-screen search"
(https://app.notion.com/p/3961c52592e081878962da3f041cde26), PR link + full checklist +
build number + how-to-test (owner escalation callback: Pebble Beach now found; search
screen no longer resizes).

**integration/next:** fast-forwarded 3b24d2f→1792d32 (== new main) and pushed — synced and
ready to keep rolling; branch not deleted.

## 2026-07-06 — Caddie connect preload: mic-withheld warm session (NOTICEABLE — integration/next, DONE)

`specs/caddie-preload-plan.md`, implemented in full. Owner escalation: "some kind of
preload is what we should do" for caddie connect latency. Target: <500ms to "Ready — go
ahead" on a warmed open; a rare "Connecting…" otherwise. FORBIDDEN constraint honored: the
previously-reverted mic-live warm shortcut (whisper-1 hallucinating phantom transcripts on
silence) is now made STRUCTURALLY impossible, not just unlikely.

### What changed
- `frontend/src/lib/voice/realtime.ts` — new `withholdMic?: boolean` option.
  `start()` with `withholdMic` NEVER calls `getUserMedia`; instead adds a track-less audio
  transceiver (`addTransceiver('audio', {direction:'sendrecv'})`) and mutes output. New
  `attachMic()` is the ONLY place that ever calls `getUserMedia` for a withheld client —
  it `replaceTrack()`s onto the pre-negotiated transceiver (no renegotiation, no second
  `setLocalDescription`), unmutes output, and flips `opened = true`. `handleEvent()` drops
  (early-returns on) the user-transcript-completed event and all assistant
  delta/done transcript events while `!opened` — belt behind the structural guarantee.
  Added `setEvents()` (rebind handlers on adoption) and `emitCurrentStatus()` (repaint
  immediately after adoption).
- `frontend/src/lib/voice/warm-session.ts` (NEW) — the one shared warm-lifecycle manager
  (`WarmSessionManager` class + `warmSession` singleton), states
  DORMANT→WARMING→WARM→CONSUMED. `warm(intent, observer?)` mints+connects a
  `withholdMic: true` client (idempotent per intent, no-ops offline/hidden, ~3s connect
  deadline reusing `MINT_DEADLINE_MS`). `takeWarm(intent)` hands the client to a caller
  (WARM or still-WARMING) and moves to CONSUMED — one authoritative timer, no racing
  teardown (the client's own 90s `IdleTimer` closing is what the manager observes to reset
  to DORMANT). `teardown()`/`handleOffline()`/`handleHidden()` for offline/backgrounded/
  unmount/intent-switch. Timers, online/hidden checks, and the client factory are all
  injectable (mirrors `IdleTimer`'s pattern) for pure unit testing.
- `frontend/src/components/VoiceRoundSetupRealtime.tsx` — `start()` now tries
  `warmSession.takeWarm({kind:'setup',...})` first (setEvents → emitCurrentStatus →
  `attachMic()`) before falling back to the cold `RealtimeCaddieClient` path. Refreshed the
  two stale "warm session would hallucinate" comments to describe the new (safe) invariant.
- `frontend/src/app/round/new/page.tsx` — one-shot first-interaction trigger
  (pointerdown/keydown/focusin on `window`) fires `warmSession.warm({kind:'setup',...})`;
  belt `onPointerDown` on the mic button itself; page-unmount cleanup tears down an
  un-adopted warm session.
- `frontend/src/hooks/useVoiceCaddie.ts` — new `warm()` (idempotent, dispatches
  PRESS→MINT_OK→CONNECTED off the warm client's observed status so `transportReducer`
  tracks phase even pre-press); `press()` now tries `warmSession.takeWarm({kind:'caddie',
  roundId, personalityId})` before `startBurst()` — adopts via the SAME
  `handleConnectionStatus` handler a cold burst uses (extracted, reused, not duplicated).
  Teardown paths (`teardownClient`, unmount) also `warmSession.teardown()`.
- `frontend/src/app/round/[id]/RoundPageClient.tsx` — one `useEffect` calls
  `voice.warm()` when `caddieSessionActive && !isLocalRound` first turns true.

### The no-audio-before-open invariant
Enforced two ways: (1) structurally — a withheld client's `start()` never touches
`getUserMedia`/`addTrack` for a mic; the only mic acquisition is in `attachMic()`, called
exclusively by the adopting surface at the user's real open. (2) belt — `handleEvent()`
early-returns on the transcript-producing event types while `!opened`, so even a
theoretical stray event can't reach `onMessage`. Proven by
`frontend/src/lib/voice/realtime-warm.test.ts`: `drops a user-transcript event that
arrives BEFORE attachMic() — onMessage never fires` and a matching assistant-transcript
test (both mock RTCPeerConnection/mediaDevices — jsdom has neither) — the load-bearing
regression the plan called for.

### Deviations from the plan (both implementation-level, not behavioral)
1. `warm()`/`WarmObserver` weren't fully specified as a wire format — added
   `onMinted`/`onStatus` observer callbacks to `warmSession.warm()` so `useVoiceCaddie` can
   drive `transportReducer` (PRESS→MINT_OK→CONNECTED) from the warm client's progress
   without taking ownership of it (ownership only transfers via `takeWarm()`).
2. `WarmSessionManager`'s constructor takes a single `deps` object (`schedule`, `cancel`,
   `isOnline`, `isHidden`, `createClient`) rather than positional args, since there are
   five independent injectables (tests use a fake client factory per the plan's
   instruction, plus injected online/hidden checks so offline/hidden teardown tests don't
   need real DOM globals).

### Tests / gates
- New: `frontend/src/lib/voice/warm-session.test.ts` (26 tests — state transitions,
  idempotent warm, intent switch teardown, idle-no-adoption→DORMANT, takeWarm
  matching/mismatch, offline/hidden teardown, connect-deadline→DORMANT).
- New: `frontend/src/lib/voice/realtime-warm.test.ts` (13 tests — no-getUserMedia +
  track-less transceiver on withheld start; output muted→unmuted; attachMic single
  getUserMedia + replaceTrack with no second `setLocalDescription`; attachMic idempotent;
  THE phantom-transcript regression x2; setEvents/emitCurrentStatus adoption).
- Extended: `frontend/src/lib/caddie/transport.test.ts` (+2 — PRESS while
  connecting/minting is a no-op, no re-mint).
- `cd frontend && npx tsc --noEmit` — clean. `npm run lint` — clean (0 errors/warnings).
  `npx vitest run` — 1451/1451 passed (63 files; pre-existing unrelated
  `lib/teetime/window-slider.test.ts` files are the PARALLEL agent's in-flight work in
  `frontend/src/lib/teetime/**` — untouched, not staged). `npx tsx voice-tests/runner.ts
  --smoke` — 274/274 pass. `npm run build` — compiles clean, all routes prerender.

Risk: touches the Realtime WebRTC connect/lifecycle path used by both the setup sheet and
the in-round orb — real-device verification (mic dialog timing, warmed-open latency,
background/airplane teardown, no phantom transcript on silence) is still needed per the
plan's own gate list; flagging for `/code-review` + `/security-review` before this bundle
ships (mint/WebRTC lifecycle change) and the `designer` pass (confirm "Connecting…" still
reads the same, just rarer).

---

## 2026-07-06 (late) — preload + tee-time rework reviewed, fixed, bundled (owner session, Fable 5)

Review pass on a221564 (caddie preload) + cca67ef (tee-time prefs rework):
- Reviewer + /security-review: PASS (mint path unchanged, persona gate intact, no
  secret in legHealth... n/a here; mic-withhold invariant verified on every path).
  1 MEDIUM + 4 low findings — ALL fixed in aa22ac8 (junk-filter kept favorites +
  placed all-generic names; shrink/regrow watermark; opened-gate on tool calls;
  warmStartedRef reset; voice window id uniquify).
- Designer: tee-time pass-with-polish (fixed: sunlight contrast pencilSoft->pencil
  on unselected cards, 44pt date-chip target). Preload BLOCKER reproduced live:
  teardown() recursion on failing warm connect (stop() sync-refires closed) —
  fixed + 2 regression tests. Deferred nice-to-haves: card density breathing room,
  delete undo-toast, chip weekday redundancy, drag-track discoverability (watch
  on-device feedback).
Gates combined: tsc/lint clean, vitest 1467/1467, voice 274/274, build green,
backend 961 + ruff clean. REMAINING RISK (flagged to owner): drag gesture +
haptics + preload device behaviors unverified on real WKWebView (sim is
auth-gated headless) — owner's TestFlight pass is the last gate.
Bundle PR opened: preload + tee-time rework + transcription language pin (en) +
specs/backlog. Next cycle (owner-directed): caddie-hazard-grounding, tee-marker-on-map.

---

## 2026-07-07 — SHIPPED: #95 caddie instant-connect + tee-time rework + English transcription

Owner approved directly in-session ("ship it", 2026-07-06). Merged PR #95 → main as
**5ab17c199c3093465fd15673de68ca5a6fafbb2c** ("Merge integration/next: caddie instant-connect
+ tee-time rework + English transcription (#95)"), a merge commit (not squash/rebase) — the
only push to `main` in this run.

**Backend deploy:** this bundle DOES touch backend (`backend/app/services/realtime_relay.py`;
no new Alembic migration). The standing `Deploy backend (SSM)` GitHub Action auto-triggered on
the merge push (run 28838977856) — `git pull --ff-only` 1792d32→5ab17c1, `uv sync`,
`alembic upgrade head` (no-op, no new revision), `systemctl restart scorecard-api`, on-box
`curl localhost:8000/health` → `{"status":"ok"}`. Verified externally post-deploy:
- `GET https://api.looperapp.org/health` → `{"status":"ok"}` (200)
- `GET https://api.looperapp.org/api/config-status` →
  `{"deepgram":true,"openai":true,"anthropic":true,"mapbox":true,"golfapi":true,"google_places":true}` (200)

**TestFlight:** frontend changed substantially (preload + tee-time UI), so cut a fresh native
build via `ops/ios/ship.sh` — **v1.0.710 (build 202607062317)**. Upload succeeded
(xcodebuild export log, ~90s archive+upload), then polled the App Store Connect API
(`GET /v1/builds?filter[app]=…&filter[version]=202607062317`, JWT signed ES256 with the ASC
key via `uv run python` + PyJWT/httpx from the backend venv, reusing the ad hoc poller at
`/private/tmp/.../scratchpad/poll_build.py`) — **VALID** after 6 polls (~120s). Live for
TestFlight Internal (Looper Team group).

**Board:** no existing card for this bundle → created directly in Shipped:
"Bundle #95: caddie instant-connect + tee-time windows/checklist rework + English
transcription" (https://app.notion.com/p/3961c52592e0811aa953c6f7a3877cfb), PR link + full
checklist + build number + owner-test list (preload speed, English-only, window drag/calendar,
checklist stability).

**integration/next:** fast-forwarded 7498c3f→5ab17c1 (== new main) and pushed — synced and
ready to keep rolling; branch not deleted.

---

## 2026-07-06 (later) — caddie-hazard-grounding implemented (builder, Fable 5)

Implemented `specs/caddie-hazard-grounding-plan.md` in full — backend-only, one commit
(c3ffc3e) on `integration/next` (not pushed; not a PR yet — bundle owner's call).

**What:** new `backend/app/caddie/hazards.py` — pure extraction of real bunker/water
hazards from the curated per-hole PostGIS FeatureCollection (never Overpass), tee→green
line math (left = positive cross product of the tee→green unit vector with the hazard
vector, pinned in `test_left_is_positive_cross_convention`; carry yards rounded to
nearest 5; 10y lateral deadband → "center"), `format_hazards_line` (e.g.
`"Hole 4 hazards: bunker L 245y, water R 190-230y"`, empty hazards → `""`), and
`HAZARD_GROUNDING_RULE` (shared directive: never name a hazard/distance absent from the
data; speak generally when none is given).

**Wired into both mouths:** `/course-intel` REPLACES `intel.hazards` with the stored
geometry's real hazards when the round is mapped to a stored course (unmapped holes
unchanged); Realtime orb situation block + `get_conditions` response (+ `hazards_line`)
+ instructions + the `get_conditions` tool description all carry real hazard data /
the grounding rule; `session_voice` and the legacy stateless `/voice` both use the same
formatter + rule text (no drift). `Hazard` gained `carry_yards`/`line_side` — additive,
defaulted, no migration.

**Frontend:** read-only verification only (no edits) — confirmed `dispatchTool` in
`lib/voice/realtime.ts` forwards the raw `get_conditions` JSON via `JSON.stringify(output)`
regardless of the narrower frontend `SessionConditions`/`Hazard` TS types (a cast, not a
literal validation), so the new fields reach the model with zero frontend change needed.

**Tests:** 32 new backend unit tests, all pure/offline (test_hazards.py: 22 cases —
cross-product convention, deadband, tee/green fallback chain [polygon → hole LineString
→ args], missing-tee/green → `[]`, beyond-green carry, rounding, range-merge, cap;
test_realtime_tools.py: 3 new — instructions carry the rule, situation block renders the
exact compact line from seeded hole_intel, no-hazard hole gets the directive with zero
fabricated feature names in the situation block itself).

**Gates:** `ruff check .` clean; `uv run pytest -q` → 986 passed, 74 skipped (Postgres
integration tests — CI's job, no local Postgres touched per constraint). No frontend
gates run (no frontend file touched).

Staged only my own files (types.py, voice_prompts.py, routes/caddie.py,
realtime_relay.py, hazards.py, test_hazards.py, test_realtime_tools.py) — left the
parallel builder's in-flight `frontend/**` (map/GoogleSatelliteMap/Package.swift/assets)
untouched and unstaged.

Deviation from plan (noted, minimal): combined `get_course_intel`'s two separate
`sessions.get(round_id)` lookups (one for the stored-hazard lookup, one for the cache
write) into a single `owned_session` resolution — pure refactor, same ownership
semantics, one fewer DB round-trip.

Risk: silent (backend-only, additive schema field, no new endpoint/dependency;
`/security-review` not triggered per plan — server-derived from our own PostGIS, no new
auth surface). Noticeable on TestFlight only insofar as the realtime/text caddie should
now say "I don't have hazard data for this hole" style generic language instead of
inventing a bunker/water feature on holes without curated geometry — a correctness fix,
not a new UI surface.

---

## 2026-07-07 — cycle 2 assembled after the spend-limit stop (owner session)

Spend limit killed both builders mid-flight (2026-07-06 ~23:50). Recovery:
- Map builder had COMMITTED (9d597a9) before dying; its progress entry was finished and
  committed (0af770d). Its npm-11 lockfile pruning re-broke CI-determinism — fixed in
  place with npx npm@10 per the standing rule (0889d4c).
- Dictation builder died before starting — eng-lead implemented specs/
  caddie-live-dictation-plan.md directly (b5b919f): live Deepgram dictation in the
  CaddieSheet voice tab, live final = the message (no Transcribing dead state on the
  happy path), PulseDot thinking idiom, openGen stale-async guard, +9 tests.
- Self-review pass (agent fan-out skipped — budget): map diff verified (queue closes
  over refs, ready-gate inside run, resume listener cleanup, marker ready-gated +
  id-tracked, 9-hole nav fix, assets present); hazards diff verified (replace-not-
  merge, owner-scoped session resolution, rule on all three prompt paths). Deferred
  one-mic exclusivity fixed: manual Ask Caddie open now stops the orb first.
- NOT done this cycle (honest): designer review of the tee marker + dictation UI
  (follow existing idioms; owner sees them on TestFlight) and the on-device drag/
  no-loader visual checks (sim is auth-gated) — owner's build pass is the last gate.
Final gates: backend 986/ruff clean; frontend tsc/lint clean, vitest 1494/1494,
voice 274/274, build green.
Bundle: regression fix (won't-listen) + hazard grounding + persistent map/tee marker +
live dictation — ALL owner escalations from 2026-07-06.

---

## 2026-07-07 — SHIPPED: #96 voice fix + grounded caddie + persistent map + live dictation

Owner "ship it" (in-session). Eng-lead ran the ship directly (release-manager agent
skipped — budget). Merge ce85c1d → main (the only push to main). Backend deploy
auto-fired on the merge (run 28868468478, success); health OK, config-status all true
— hazard grounding + the English transcription pin are live on prod. TestFlight
v1.0.726 (build 202607070907) uploaded, processing on Apple's side. Board card:
https://app.notion.com/p/3961c52592e081b99491e6f3cf9190ba (Shipped).
integration/next fast-forwarded to ce85c1d, pushed, kept for the next cycle.
Owner test list: setup voice hears you; no per-hole map loader; tee marker; live
dictation; caddie cites only real hazards on mapped holes.

---

## 2026-07-07 — SHIPPED: #97 page-turn hole transition

Owner "ship it" (in-session, same-day feel feedback on v1.0.726). Merge 4385192 →
main; frontend-only (backend deploy rerun is a no-op). TestFlight v1.0.729
(build 202607070934) uploaded. integration/next fast-forwarded + pushed.
Owner test: swipe holes — paper page wipes across, new hole appears beneath;
timing (600ms wipe / cut at 200ms) may want a nudge after a real-thumb pass.

---

## 2026-07-07 — Looper orb bundle 1 built (owner-approved design, eng-lead direct)

Owner: standardize Looper invocation ("the premise of this app is having this constant
assistant caddie"); disliked tee-time's HOLD TO TALK bar. Design run by owner
(AskUserQuestion): center orb in the tab island / tap→sheet + long-press→listen /
tee-times+courses first. Built directly (dd11321, specs/looper-orb-plan.md):
tab island gets the raised center orb (Partners → Home QuickAction card);
shared useLooperDictation hook + LooperSheetShell; general context = stateless
caddie chat w/ hole_number null (backend: optional hole context — never invents a
hole off-course); tee-time bar REMOVED, sheet feeds the unchanged intent pipeline;
courses orb opens search already dictating into the query. +7 tests.
Gates: tsc/lint, vitest 1501/1501, voice 274/274, build, backend 986 + ruff — green.
NOT yet done: designer pass (budget) — owner sees it on TestFlight; bundle 2 =
round-page identity + Home/Partners/Profile page powers.

---

## 2026-07-07 — SHIPPED: #98 the Looper orb (bundle 1)

Owner "ship it". Merge 4711fa4 → main; backend deploy success + health ok
(off-course chat context live). TestFlight v1.0.734 (build 202607071034)
uploaded. integration/next fast-forwarded + pushed. Owner test: the center
orb on every tab (tap → sheet, hold → listening); tee-time bar gone, voice
via orb; courses orb dictates into search; general chat on Home/Profile.
Bundle 2 queued: round-page Looper identity, page powers, designer polish.

---

## 2026-07-07 — VOICE BULLETPROOFING P0 (owner: "our most important thing")

Owner escalations (in-round, v1.0.734): raw '{"detail": "list index out of range"}' in the
CaddieSheet; live dictation still falling back to "Transcribing…"; wind/elev tiles frozen.
All three root-caused + fixed (f49ba62 + 73f5c98):
1. Error hygiene: catch-alls leaked str(e) with NO logged traceback. Now log.exception +
   calm in-character detail; _first_text guards empty Claude content (the likely IndexError);
   frontend humanizeVoiceError never renders machine text. +9 tests.
2. iOS live dictation: WKWebView MediaRecorder = audio/mp4 (Deepgram live can't decode) +
   dual-MediaRecorder-on-one-stream flakiness. New transport split: webm/opus where
   supported; WebAudio PCM tap (AudioWorklet/ScriptProcessor → linear16@16k) elsewhere.
   pcm-capture pure helpers tested (+7). DEVICE VERIFICATION = owner's next build.
3. Wind/elev tiles were HARDCODED (no-fake-data violation): real weather fetch + per-hole
   relative wind from true hole bearings (tested: same weather reads differently per hole);
   Gust replaces Elev (no elevation data — DEM ingestion backlogged); plays-like wind-adj.
Audit delivered: specs/voice-agent-audit.md — P1 queue: keyterm boosting, TTS sheet
replies, auto-send endpointing, voice telemetry (all on backlog.json).
Gates: backend 991 + ruff clean; frontend tsc/lint clean, vitest 1523/1523, voice 274/274,
build green.

---

## 2026-07-07 — SHIPPED: #99 voice bulletproofing P0

Owner "ship it". Merge 82d8d8b → main; backend deploy success + health ok (the
error-hygiene fix protects the CURRENT build immediately). TestFlight v1.0.739
(build 202607071110) uploaded. integration/next fast-forwarded + pushed.
Owner test: dictate to the caddie — words should appear LIVE on device now;
wind/gust tiles change hole to hole; no raw JSON errors ever.
P1 voice queue ready on backlog: keyterm boosting, TTS sheet replies,
auto-send endpointing, voice telemetry.

---

## 2026-07-07 — INCIDENT + FIX: #100 merged over a failed frontend gate

The #100 ship pipeline piped `gh pr checks` through head (exit code swallowed) and
local gates ran on node_modules older than the lockfile (install --package-lock-only
does not install) — CI's stricter hooks-lint (react-hooks/refs +
preserve-manual-memoization, from the keyterms work) failed while local lint passed.
Main was red for ~10 min; the shipped v1.0.742 artifact itself was fine (lint-only
failures, local build green). Fix #101 (cdf5eb7) merged with an explicit
fail-count==0 gate. PROCESS RULES (also in agent memory): (1) merge gates check
`gh pr checks --json bucket` fail counts, never piped output; (2) `npm ci` before
trusting local gates after any lockfile change.

---

## 2026-07-07 — Bundle #102 (open): voice-tts-sheet-replies

Fresh `integration/next` cut after #101. Picked P1 `voice-tts-sheet-replies` (noticeable).
Plan (opus) → `specs/voice-tts-sheet-replies-plan.md`; builder → a08140d. Opt-in,
persona-matched TTS of caddie sheet replies via new owner-gated `POST /api/voice/speak`
(OpenAI `gpt-4o-mini-tts`); shared `useSheetTTS` hook reuses realtime.ts's iOS unlock;
default OFF; quiet hairline speaker toggle in CaddieSheet + LooperSheet(Shell). Every TTS
failure is swallowed so the silent-text reply always renders.
- Reviewer: SHIP (adversarial + manual security/code review). Applied review note #1 —
  hardened `/speak` upstream errors to a generic 502, never mirror the OpenAI body (71ec0df).
- Designer: PASS. Applied the one nit — bumped the toggle to a 44pt on-course hit area (e18e347).
- Gates (eng-lead-verified): fe lint/tsc/build clean, voice smoke 274/274, hook 5/5;
  be ruff clean, /speak tests 6/6. CI on PR #102.
Backlog hygiene: marked voice-keyterm-boosting / voice-auto-send-endpointing /
voice-telemetry done (all shipped in #100, files+tests verified — were stale "ready").
PR #102 opened (integration/next → main). Two owner decisions surfaced in the PR:
default-ON vs OFF, and whether tee-time's Looper sheet should read its call transcript aloud.
Next: CI green → release-manager builds TestFlight → owner "ship it".

---

## 2026-07-07 — SHIPPED: #102 spoken caddie replies (loop cycle 1)

The FIRST autonomous loop cycle end-to-end: eng-lead planned/built/reviewed
voice-tts-sheet-replies (opt-in TTS, persona-matched, tap-to-silence; /speak
proxy hardened in review; 44pt toggle from designer pass). Owner "ship it" →
merge 0c89ffd, backend deploy success + health ok, TestFlight v1.0.750
(build 202607071230). P1 voice queue COMPLETE (keyterms, auto-send,
telemetry, TTS). integration/next resynced; hourly loop (job a48ad37b, :17)
continues on the next board/backlog item.

---

## 2026-07-07 — Bundle cycle (loop cycle 2): map ErrorScreen restyle + backlog hygiene

Step 0: no pending owner approvals (polled #102/v1.0.750, orb #98, voice #99 card
threads — all empty). Bundle empty; main == integration/next at abc0498.

BACKLOG HYGIENE (major finding): the "ready" p2/p3 items were already shipped to main
and just mis-tagged — corrected in backlog.json:
- caddie-hazard-grounding → done-shipped-main (c3ffc3e; hazards.py + 32 tests, both mouths)
- persistent-hole-map + tee-marker-on-map → done-shipped-main (9d597a9; persistent map,
  createCameraQueue, teeColorFor + generated tee-marker PNGs)
- course-elevation-ingestion → superseded (real USGS 3DEP/EPQS ingest lives in
  services/elevation.py + fetch_elevation_cached; Elev tile reads real data).
This nearly caused a rebuild of shipped code — future cycles: verify implementation
state before picking, the backlog statuses drifted.

BUILT: map-viewer-error-screen-restyle (p6, minor, SILENT — error-state-only visual).
Plan specs/map-viewer-error-screen-restyle-plan.md → builder 8998b3f. Restyled the
/map/course ErrorScreen from generic (Lucide AlertCircle + sans + plain link) to the
on-brand yardage-book not-found pattern (serif-italic headline, mono uppercase caption,
hairline pill button, paper-noise bg) — a faithful copy of the already-approved
CourseDetailClient not-found state (no separate designer pass needed for a pixel copy).
Gates green: tsc clean, lint clean, build ✓ (19 routes), voice smoke 274/274.
Self-review: pure presentational, signature + 3 call sites unchanged — SHIP.

Bundle now = SILENT-only (this restyle) → NO owner ping; rides along until the next
noticeable change. Bundle PR opened integration/next → main as the rolling record.

---

## 2026-07-07 — Bundle cycle (loop cycle 3): Looper orb bundle 2 — round-page identity (NOTICEABLE)

Step 0: no pending owner approvals (board latest = #102 Shipped; cycle 2 polled threads
empty; no new feedback). Sync: main == integration/next, clean.

PICKED (owner-approved, from specs/looper-orb-plan.md "Out of scope (bundle 2)"): restyle
the round page's "Ask Caddie" pill to the Looper identity (ink-orb + serif-L), same
tap-summons semantics; round page has no tab bar so placement stays. NOTICEABLE.

PLAN (opus Plan agent) → specs/looper-orb-bundle2-plan.md: swap ONLY the pill medallion
to the LooperOrb language (T.ink bg, hairline border, trimmed inset highlight, serif-italic
"L"); keep onClick (voice.stop()+setCaddieOpen) → round-scoped CaddieSheet; NO looper-bus,
NO long-press (avoid racing realtime.ts warm-path mic invariants); persona stays surfaced in
CaddieSheet header. Label decision flagged for designer.

BUILT (builder, ec49d09): pure presentational restyle + aria-label; +progress log 3d17471.
Gates green.

REVIEW (parallel): Reviewer SHIP (faithful, no correctness/a11y/compression regressions,
no voice/mic/bus touched). QA PASS — lint / tsc / build (19 routes) / voice smoke 274/274 /
FloatingTabBar 4/4. Designer PASS on the orb visual + one BLOCKING label call: the pill opens
the persona-branded CaddieSheet ("Classic · On the bag"), so "Ask Looper" overpromises →
revert label to "Ask caddie", keep the ink-orb medallion.

ITERATE: applied the designer label revert directly (two-string change on an already-approved
label; eng-lead re-ran gates — lint/tsc/build/voice 274/274 green) → 6baa1c9 pushed.

BUNDLE #103 now NOTICEABLE (this orb identity + silent map ErrorScreen restyle + backlog
hygiene). PR #103 body updated with checklist + status. Board card created in Needs Review
(Bundle #103: Looper orb — bundle 2). No push notification (per cycle rule — owner replies
in-session or on the board). Awaiting owner "ship it" → release-manager builds TestFlight
from integration/next, then merges → main + cuts fresh integration/next.

---

## 2026-07-07 — SHIPPED: #103 Looper identity on the round pill + map error restyle (loop cycles 2-3)

Owner "ship it". Merge 1070f18 → main (frontend-only). TestFlight v1.0.759
(build 202607071309). Bundle built by loop cycles 2-3: map-viewer ErrorScreen
restyle (silent) + round-page Ask Caddie pill in the Looper ink-orb identity
(noticeable — closes looper-orb bundle 2's identity half). Backlog de-staled
in cycle 2 (4 shipped items re-tagged). integration/next resynced; hourly
loop continues.

---

## 2026-07-07 — SHIPPED: #104 streamed replies + voice timeouts (loop cycles 4-5)

Owner "ship it". Merge 69285d4 → main; backend deploy verified BY SHA
(69285d4, success) + health ok — streaming endpoints live. TestFlight
v1.0.767 (build 202607071534). Ship had three compounding snags, all
recovered + memorialized (ship-gate-verification memory, rule 3): piped
ship.sh masked a wrong-cwd failure twice; gh run list returned a stale
deploy run (now matched by headSha); cycle 5's builder process resurrected
and committed the deterministic stream tests (0b0d67e) mid-recovery.
CI also caught a REAL streaming race the review missed (flush-after-
completion double-render) — fixed (56df95f) + deterministic test suite.
Voice audit P1+P2 core COMPLETE. integration/next merged with main
(e172dd7) and pushed.

---

## 2026-07-07 — RETRO cycle (loop cycle 6): rough-patch retrospective + board hygiene (SILENT)

Step 0: no pending owner approvals. #103 (v1.0.759) and #104 (v1.0.767) both Shipped;
comment threads empty — no owner feedback on v1.0.750/759/767. Sync: main == integration/next
base (69285d4); bundle empty (only silent progress/retro commits ahead of main). Clean tree.

PICKED: dispatched the `retro` agent (protocol: warranted "after a rough patch" — today = 9
ships + 3 process incidents not yet distilled into lessons.md). Chosen over a manufactured
marginal feature (own lesson: don't feed the loop with dormant work).

RETRO OUTPUT (commit b5c6b71, pushed to integration/next):
- lessons.md: 3 new reusable rules — (1) CI catches async/ordering races review misses →
  cover streaming/timer code with DETERMINISTIC scheduler-controlled tests, not "review harder";
  (2) ship.sh must never be piped, must `set -o pipefail` + assert cwd + absolute paths;
  (3) verify a deploy/CI run by matching headSha, never `--limit 1` recency.
- backlog.json: fixed 2 mis-tagged shipped items (map-viewer-error-screen-restyle → #103;
  voice-tts-sheet-replies → #102); noted voice-agent-audit P1+P2 core COMPLETE; seeded 3
  NORTHSTAR-grounded candidates (caddie-persona-tts-voices, caddie-hole-strategy-guides,
  looper-brain-parity). Valid JSON, 127 items, no dup ids.

BOARD HYGIENE (eng-lead): flagged by retro — flipped stale duplicate card "Bundle #104:
voice reply timeouts + retry" from In Progress → Shipped (work shipped in v1.0.767; canonical
record is the "streamed caddie replies + voice timeouts" Shipped card). Card "#103 Looper orb
bundle 2" already Shipped (only body text stale — left as-is).

NO owner ping: bundle remains SILENT-only (progress + retro docs/backlog). Accumulates until a
noticeable item lands. integration/next @ b5c6b71 pushed; no open PR (correct — nothing to ship).

---

## 2026-07-07 — SHIPPED: #105 legacy-round caddie fix + Looper brain parity

Owner "yes deploy". Merge 06b7b73 → main; deploy verified BY headSha
(06b7b73, success) + health ok. TestFlight v1.0.778 (build 202607071629).
- Legacy slug course-ids no longer crash session start (owner's live round:
  name-resolved to the mapped UUID → full intel restored: elev/wind/hazards).
- Weather tiles: per-hole tee fallback anchor for legacy rounds.
- Looper orb off-course chat grounded in player memory + handicap (cycle 7).
- Logging: app INFO now reaches the journal (voicetel visible).
OWNER DIRECTION queued as top P1s: caddie-conversational-loop +
caddie-auto-shot-reco (specs to be planned next cycles).
integration/next resynced. Ten ships today.

---

## 2026-07-07 — LANDED on bundle #106: caddie hands-free conversational loop (loop cycle 9)

Step 0: no owner feedback anywhere (PR #106 comments empty; board #105 card thread empty;
no #106 card existed yet). Bundle #106 (auto shot reco + intel resilience) stays AWAITING the
owner's "ship it" — NOT merged. Sync: integration/next == origin, clean; main already merged.

PICKED (top ready, owner's remaining big ask): caddie-conversational-loop (p1, MAJOR/noticeable).

PLAN (opus): specs/caddie-conversational-loop-plan.md. Decision: stay on the EXISTING Deepgram
dictation + useSheetTTS path (re-arm on TTS playback END + grace), NOT route through Realtime —
keeps the untouchable realtime warm-path mic invariants intact. Hands-free is IMPLICIT (the
persisted speaker toggle IS the switch; no new UI/mode — NORTHSTAR minimal chrome).

BUILT (eded238): onPlaybackEnd only on native `ended` (never pause), 400ms echo grace, 6s
dead-air + empty-streak calm drop-out, tap-to-interrupt barge-in, full close/unmount cleanup;
17 deterministic scheduler-controlled tests. Builder flagged one deviation: dropped
`!streamAbortRef.current` from the re-arm guard (that ref only nulls on close, so keeping it
would permanently block re-arm after turn 1).

REVIEW: Reviewer SHIP — verified the deviation is correct + necessary (isThinking/isStreaming
fully cover in-flight; no race), no leak/double-arm, invariants preserved, tests non-vacuous.
QA (eng-lead ran): tsc/lint clean, voice smoke 274/274, build + full vitest 1590/1590.
Designer: one BLOCKING issue — auto re-arm wiped the just-spoken answer off screen ~0.5s after
the caddie finished (worst on the opening reco, no scrollback fallback) + contradictory
"Tap to ask again" label in the grace window.

ITERATE (83fcccb): answer now PERSISTS through the re-arm/listening phase (shared
AnimatePresence key + ListeningIndicator underneath); manual tap still clears; CTAs unmount
during listening; abandoned re-listens clear the ghost (also fixed a latent masked-error risk);
mic label -> "Tap to interrupt". Designer re-review PASS. Gates re-green (1590/1590).

BUNDLE: PR #106 checklist updated (added the loop as noticeable + a ship note that it landed
after the current TestFlight -> release-manager should cut a fresh build at "ship it"). Board
card "Bundle #106" created in Needs Review (was missing). backlog: caddie-conversational-loop
-> done-on-bundle. CI green (2 pass / 0 fail; 1 pending E2E advisory).

NO push notification (per this cycle's standing rule + owner mid-testing on-course). Bundle #106
remains AWAITING owner "ship it"; the loop rides it. integration/next @ 83fcccb pushed.

---

## 2026-07-07 — SHIPPED: #106 the conversational caddie + intel resilience

Owner "ship it". Merge 5056d05 → main; deploy verified by headSha + health ok.
TestFlight v1.0.789 (build 202607071830). The bundle that answers the owner's
3:55pm direction end-to-end, built by loop cycles 8-9 same-day:
- Auto shot reco on Ask Caddie open (GPS → streamed/spoken opening turn;
  review caught the GPS-await race).
- Hands-free conversational loop (speak → listen → speak; 400ms echo grace,
  dead-air dropout, tap-to-interrupt; designer caught the answer-wipe).
- Intel resilience: hazard classification can never sink hole intel (the
  '+0ft' fix) + garbage-hazard validation + per-hole failure logging (the
  remaining thrower will name itself on the owner's next round open).
Eleven ships today. integration/next resynced; loop continues hourly.

## 2026-07-07 — fix-course-intel-none-yards follow-up: guard None-yards in aim_point/recommend (SILENT, integration/next, DONE)

Adversarial eng-lead review of `8529820` found a regression the plan's audit missed: now that
`HoleIntelligence.yards` is `Optional[int]`, `build_hole_intelligence` successfully caches
`yards=None` for no-yardage rounds (previously it threw, so the cache stayed empty) —
`app/caddie/aim_point.py:286` then did `distance_yards >= hole.yards * 0.85` unguarded, so
`/session/recommend` (and the stateless `/caddie/recommend` path, now that the frontend type
permits `yards: null` too) would 500 asking for a club rec on exactly the rounds this fix
targets — trading a broken Elev tile for a crash on club recommendation.

- `backend/app/caddie/aim_point.py:288` — `is_tee_shot = hole.yards is not None and
  distance_yards >= hole.yards * 0.85`; unknown yardage falls back to the conservative
  (approach-shot) bias instead of crashing.
- `backend/app/routes/caddie.py:562` — session voice-context line no longer interpolates
  literal "None yards (effective: None)" into the LLM prompt; yardage clause conditional on
  `hole_intel.yards is not None`, "Par N" always present (non-blocking honesty nit, folded in).
- `backend/tests/test_aim_point.py`: added `test_none_yards_never_throws` (non-DB, no network) —
  `generate_recommendation` with a `yards=None` `HoleIntelligence` returns cleanly.

Gates: `ruff check .` clean; `uv run pytest tests/test_aim_point.py tests/test_course_intel_resilience.py
tests/test_decade_advice.py tests/test_reasoning_priority.py tests/test_competition_legal.py
tests/test_slope_advice.py tests/test_shot_line_advice.py` → 213/213 passed, no DB required;
`npm run lint` clean; `npx tsc --noEmit` clean; `npm run build` succeeded; `voice-tests/runner.ts
--smoke` → 274/274. Committed `33d780b` to `integration/next`, pushed. Silent — backend-only
crash-prevention fix, rides the bundle with 8529820.

---

## 2026-07-08 — SHIPPED: #107 the real +0ft fix + wind refresh

Owner "ship it". Merge 1271254 → main; deploy verified by headSha + health ok.
TestFlight v1.0.799 (build 202607072013). The '+0ft' saga CLOSED end-to-end:
#106's per-hole logging named the thrower (None-yards crashed every hole's
intel), the overnight loop root-caused + fixed it (honest empty state,
aim_point/recommend guards, clean prompts, regression tests), and the
elevation/wind tiles read true via the deploy alone. Wind now refreshes
every ~20-30 min + on stale hole change. Twelve ships this run.
integration/next resynced; loop continues.

## 2026-07-08 — cycle 12: don't refetch weather on a completed round (SILENT, integration/next, DONE)

Step 0 clean: #107 shipped (v1.0.799), no open PRs, no Needs-Review cards, no owner
comments on the recently-shipped bundle cards. Bundle was empty.

Picked the cycle-10 review nit. The periodic wind refresh already tears down for a
finished round, but the two ON-DEMAND triggers — hole change (`RoundPageClient` ~l.609)
and app foreground/visibility (~l.621) — had no round-active guard, so paging through or
reopening a COMPLETED round fired a live `/weather` call and could paint "now" wind onto a
round played earlier. Folded the gate into a pure `shouldRefreshOnDemand(roundActive,
weather, fetchedAt, now)` predicate in `lib/map/weather-freshness.ts`; both effects read a
fresh `roundActive` from the weather mirror ref (no stale closure). Dropped the now-unused
`isWeatherStale` import from the component.

Gates: vitest weather-freshness 17/17 (+5 new deterministic cases), lint clean, tsc clean,
next build ok, voice smoke 274/274. Committed 8ec8672 → integration/next; opened the fresh
rolling bundle PR #108 (silent-only — no owner ping). Rides until a noticeable item lands.

---

## 2026-07-08 — SHIPPED: #108 iOS caddie voice fix + weather guard

Owner "ship it". Merge 38ed64f → main (frontend-only). TestFlight v1.0.808
(build 202607072128). P0: CapacitorHttp's patched fetch was corrupting the
TTS mp3 blobs → NotSupportedError on every spoken reply on the owner's
iPhone → hands-free loop never re-armed. Fixed via native CapacitorHttp
blob fetch + primed persistent audio element + prime_failed telemetry.
Riders: completed-round weather guard. Thirteen ships.
NEXT (owner directive): caddie-realtime-conversation opus plan — Ask Caddie
on the Realtime engine, hands-free like setup. Then reco-from-tee + static
intel persistence + the iOS voicetel flush fix.

## 2026-07-09 — cycle 17: caddie-opening-reco-from-tee (NOTICEABLE, integration/next, DONE)

Step 0 clean: PR #109 OPEN/CLEAN, CI green on 71b104e, no owner comments (overnight),
no approval to process. integration/next synced (0 behind main).

Picked p1 caddie-opening-reco-from-tee. Opus plan (specs/caddie-opening-reco-from-tee-plan.md)
factored the logic into a pure DOM/GPS-free helper. Builder (5c9b6db) added
`frontend/src/lib/caddie/opening-shot.ts` — `resolveOpeningShotDistance(gps,tee,green)`:
plausible GPS wins; implausible/absent GPS FALLS THROUGH to tee→green (fromTee:true);
honest null when no green or no usable tee. CaddieSheet phrases the tee fallback honestly
("I'm on the tee, about N yards to the pin. What should I hit off the tee?"); the
openingGenRef/pristine-idle guards stayed byte-for-byte. 6 helper unit tests + 3 phrasing
tests (incl. GPS-path `not.stringContaining("on the tee")` regression lock + null-idle).

Review pass: reviewer CLEAN (no blocking; no security surface — pure client helper, no
security-review needed), qa PASS (lint/tsc/build/voice 274/274/vitest 1660/1660/ruff),
designer APPROVE-WITH-NIT. Folded two non-blocking nits in c2b27de: designer's "yards"
unit-consistency on the tee sentence, and reviewer's restored `if(!greenForHole) return null`
early guard (skips a pointless 6s geolocation wait when the hole has no green). Re-ran gates:
lint/tsc clean, affected vitest 45/45, build ok, voice 274/274.

NOTICEABLE — rides bundle PR #109 (already awaiting the owner's "ship it"; checklist updated).
Per standing rule: NO push notification (overnight); the item accumulates on the bundle and
merges with the owner's single approval. backlog 0ecbf49. One item this cycle (backend-heavy
course-intel-static-persistence stays queued for next cycle). Head c2b27de.

---

## 2026-07-09 — CHECKPOINT: monthly spend limit hit (loop paused)

Cycle 18 (course-intel-static-persistence) terminated mid-plan on the
MONTHLY spend cap ("raise at claude.ai/settings/usage"). Per policy
(tasks/todo.md locked budget: subscription → ≤$50 overflow → hard-stop),
the loop PAUSES here; no further cycles dispatched. Tree clean, nothing
lost.

STATE AT PAUSE:
- Bundle PR #109 OPEN + CI GREEN on 59e87ee, 2 noticeable (A2 TTS
  pipelining, from-tee opening reco) + 2 silent — AWAITING owner "ship it".
- Cycle 18 findings to seed the retry (explored before dying):
  * courses_mapped is NORMALIZED relational, not JSONB-blob; only
    hole_features.properties is JSONB.
  * PRECEDENT EXISTS: embed_elevation_in_green_features (osm_ingest.py)
    already writes tee/green elevation + delta + slope into the green
    feature's properties and round-trips via upsert_course/get_course —
    no schema change needed.
  * sample_course_elevations computes a whole course in ~2 batched 3DEP
    calls (the right precompute path); session/start is the BackgroundTask
    hook.
  * CONCURRENCY RISK: upsert_course does destructive delete+reinsert of
    all features — must not run on the hot read path; write-back needs a
    targeted properties update, not a full upsert.
- Remaining queue after this item: fix-ios-voicetel-flush-dropped,
  Slice C transport migration (flag-gated), persona voices (owner taste),
  strategy guides (owner-paused).

RESUME: next session (after limit reset or owner raises the cap) — retry
cycle 18 with the findings above; then continue the queue.

---

## 2026-07-09 — SHIPPED: #109 faster caddie voice + from-tee reco + instant elevation

Owner "ship it". Merge 450befc → main; deploy verified by headSha + health ok.
TestFlight v1.0.836 (build 202607080618). NOTICEABLE ×3: A2 sentence-level
TTS pipelining (voice starts on the first sentence), from-the-tee opening
reco (works at home + pre-GPS first tee), instant elevation (static
persistence, computed once per course). Silent riders: stage-timing
telemetry, Realtime grounding parity (Slice A), iOS voicetel flush fix,
elevation write-back hole-number hardening, spend-limit checkpoint.
Fourteen ships this run. Survived a monthly-spend-limit pause with a clean
checkpoint+resume mid-bundle.
NEXT: Slice C — the Realtime transport migration (flag-gated, owner
on-device verification) on a fresh bundle; ci-postgis-course-mapping-tests
as the routine filler.

---

## 2026-07-09 — SHIPPED: #110 Slice C1 — flag-gated Realtime live mode

Owner "ship it". Merge ac9bec0 → main (frontend-only). TestFlight v1.0.840
(build 202607080715). The hands-free Realtime caddie exists behind
`?liveMode=1` (localStorage-persisted; `?liveMode=0` reverts). Double-
reviewed (both independently found only the offline dead-sheet bug, fixed
+ regression-tested pre-merge). Fifteen ships this run.
AWAITING: owner on-device verification of live mode → drives Slices D/E
(reconnect-after-drop, idle policy, polish → default-ON decision).
Non-blocking notes logged: in-flight start() resurrection (shared with orb
path), post-drop frozen transcript (deferred by plan).
