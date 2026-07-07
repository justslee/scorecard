# Caddie connect preload — make "Connecting…" rare

Owner escalation (2026-07-06): "I don't love how we have to wait for the caddie to connect. Not a good user experience — some kind of preload is what we should do."

Target: < 500 ms to "Ready — go ahead" on a pre-warmed open; a calm, rare "Connecting…" otherwise.

FORBIDDEN: the previously-reverted shortcut — a warm session with the mic live streaming silence into the transcriber (whisper-1 hallucinated phantom user turns). Any design must make that STRUCTURALLY impossible, not merely unlikely. (Transcribe model is now gpt-4o-transcribe and language is pinned "en", but those are mitigations, not the guarantee.)

## Where the latency is (measured against the code)

`RealtimeCaddieClient.start()` (frontend/src/lib/voice/realtime.ts) does, in order:
1. **Mint** — browser → FastAPI → OpenAI `/client_secrets`. Two hops; dominant, variable cost on course cell.
2. `getUserMedia({audio})` — THE call that triggers the iOS mic-permission dialog.
3. `new RTCPeerConnection()` + createOffer + setLocalDescription — local, fast.
4. **SDP exchange** — browser → OpenAI `/v1/realtime/calls` (ephemeral secret is the Bearer).
5. ICE/DTLS to `connected`.

The 60s ephemeral TTL only gates the connect step; once the peer connection is up, TTL is irrelevant.

## Decisive design

**Warm = pre-mint AND immediately pre-connect a single, microphone-less WebRTC session, output-muted and transcript-gated; on open, attach the mic with `sender.replaceTrack()` (no renegotiation) and lift the gates.**

- Connecting immediately after minting consumes the TTL inside the mint→connect window — TTL expiry is designed out (no held-but-stale secret).
- Warm peer connection: audio transceiver with NO track and NO getUserMedia — the iOS permission dialog cannot fire pre-open and ZERO audio frames are transmitted; transcriber receives nothing. Belt: drop transcript events while `!opened`.
- At open only getUserMedia + replaceTrack remain → < 500 ms.
- ONE connection: the module-level `activeRealtimeClient` singleton in realtime.ts already enforces one live connection app-wide.

Rejected: pre-mint only (leaves SDP+ICE on the open path + TTL bookkeeping); mic-live warm (the reverted regression — forbidden); warm on bare page mount (billed connection for bouncers — warm on first interaction); a second setup-specific warm mechanism (one shared manager for both surfaces).

## Files

1. `frontend/src/lib/voice/realtime.ts` — warm mic-less + adopt-on-open support.
2. `frontend/src/lib/voice/warm-session.ts` — NEW: the single shared warm-lifecycle manager.
3. `frontend/src/components/VoiceRoundSetupRealtime.tsx` — adopt a warm client in start(); refresh the stale phantom comment.
4. `frontend/src/app/round/new/page.tsx` — setup warm trigger.
5. `frontend/src/hooks/useVoiceCaddie.ts` — `warm()` + press() adopts warm client.
6. `frontend/src/app/round/[id]/RoundPageClient.tsx` — warm when the caddie session becomes enabled.

No backend changes; no new deps.

## RealtimeCaddieClient changes (realtime.ts)

- Option `withholdMic?: boolean` on RealtimeCaddieOptions.
- `private opened: boolean` (init `!withholdMic`); `private micTransceiver: RTCRtpTransceiver | null`.
- start() with withholdMic: NO getUserMedia; `this.micTransceiver = this.pc.addTransceiver('audio', { direction: 'sendrecv' })` (send m-line, no track); `setOutputMuted(true)`. Else unchanged (set micTransceiver from the sender for symmetry).
- `async attachMic()`: getUserMedia (same constraints as today) → `micTransceiver.sender.replaceTrack(track)` (no renegotiation; supported in WKWebView) → `opened = true; setOutputMuted(false); idle.touch()`. Rejection (permission denied) rethrows — callers degrade (setup → error UI; orb → CONNECT_FAILED ladder).
- Transcript gating in handleEvent: `conversation.item.input_audio_transcription.completed`, both output_audio_transcript cases, assistant deltas — early-return (drop) when `!opened`.
- `setEvents(events)` — rebind handlers on adopt (manager creates warm client with minimal onError-only handlers).
- `emitCurrentStatus()` — re-emit live status so the adopting surface paints "Ready — go ahead" immediately.
- cleanup() unchanged (already cancels idle timer, nulls singleton, closes dc/pc, stops tracks, removes the audio sink).

## warm-session.ts — the one shared manager

Module-scoped singleton; timers injectable (mirror IdleTimer's pattern).

```
type WarmIntent =
  | { kind: 'setup'; personalityId: string }
  | { kind: 'caddie'; roundId: string; personalityId: string };
```

States: DORMANT (initial) → WARMING → WARM → CONSUMED.

- `warm(intent)`: DORMANT & online & visible → new RealtimeCaddieClient(intentOpts, {withholdMic: true}, {onError → teardown}); start(); → WARMING with a connect deadline (~MINT_DEADLINE_MS=3000 or slightly larger) — not connected by then → teardown → DORMANT (no user waiting). WARMING/WARM matching intent → no-op (idempotent, StrictMode-safe). Different intent → teardown, warm new.
- connected (via manager's onStatus) → WARM; idle cutoff = the client's existing 90s IdleTimer (REALTIME_IDLE_DISCONNECT_MS) — the manager OBSERVES the resulting closed status → DORMANT (one authoritative timer, no racing).
- `takeWarm(intent)`: WARM matching → return client → CONSUMED (caller: setEvents, emitCurrentStatus, attachMic). WARMING matching → return client too (surface shows Connecting… briefly) → CONSUMED. Mismatch/DORMANT → null (cold path).
- `teardown()`: offline, document hidden (visibilitychange — iOS suspends WebRTC in background; never hold a billed zombie), unmount, intent switch → client.stop() → DORMANT. warm() no-ops while offline.

## Setup sheet wiring

- Trigger (round/new/page.tsx): one-shot first-user-interaction listener (pointerdown/keydown/focusin) → warm({kind:'setup', personalityId:'classic'}); belt: onPointerDown of the mic button too. NOT bare mount (cost).
- Adopt in VoiceRoundSetupRealtime start(): takeWarm → setEvents → emitCurrentStatus → await attachMic(); else unchanged cold path. Existing teardown-on-unmount stops the adopted client (manager is CONSUMED, no double-stop).
- UI copy unchanged (Connecting… just becomes rare). Update the two stale comments (component header ~150, round/new overlay ~1605) to the new invariant: session may be pre-warmed but the mic is withheld (no getUserMedia, no track, transcripts dropped) until attachMic() at open.

## Orb wiring (reuse, not rebuild)

- useVoiceCaddie.warm(): warmSession.warm({kind:'caddie', roundId, personalityId}); dispatch PRESS→MINT_OK→CONNECTED off observed status so transportReducer tracks the phase. No mic attach.
- press(): no clientRef but warm caddie client exists → takeWarm + setEvents + attachMic + setMuted(false) instead of startBurst(). Existing warm-burst path (clientRef present) unchanged; cold-path 3s mint deadline / degrade-to-text untouched.
- RoundPageClient: one useEffect → voice.warm() when caddieSessionActive && !isLocalRound first turns true.

## Mint TTL expiry

Designed out: warm connects inside the 60s window. WARMING stalls past deadline → teardown → DORMANT → next open is a fresh cold mint. No stale secret reused; no minted-but-idle secret held.

## Edge cases

- iOS mic permission: getUserMedia ONLY in attachMic() at open. First-ever open shows the dialog (same as today); after grant, warmed opens are instant.
- Permission denied at open: attachMic rejects → setup shows the calm retry; orb degrades via CONNECT_FAILED; the mic-less warm client is torn down.
- Backgrounded: visibilitychange → teardown; re-warms on return via the triggers.
- Offline/airplane: warm() no-ops; mid-warm offline event tears down; open falls to cold/error paths (orb tier-3 offline card).
- Fast open/close + StrictMode double-mount: warm() idempotent per intent; connect deadline + activeRealtimeClient singleton prevent stacked connections; takeWarm transfers ownership exactly once (later calls null). Cleanup already prevents leaked sessions / stacked audio sinks.
- Connect-time greeting: output muted during warm + transcript gating drops pre-open greeting deltas; conversation starts clean on open.

## Tests (vitest, fake timers, injected deps — match frontend/src/lib/voice/*.test.ts patterns)

- warm-session.test.ts (new): state transitions; idempotent warm; intent switch tears down; idle-no-adoption → DORMANT; takeWarm matching/mismatch; offline/hidden teardown; connect-deadline → DORMANT. Fake client factory + fake timers.
- realtime-warm.test.ts (new): withholdMic start() calls NO getUserMedia and adds a track-less transceiver; transcript events dropped while !opened, delivered after attachMic(); attachMic calls getUserMedia once + replaceTrack on the existing sender (no second setLocalDescription ⇒ no renegotiation); setEvents/emitCurrentStatus. Mock RTCPeerConnection/mediaDevices as existing tests do.
- transport.test.ts (extend): PRESS while phase==='connecting' stays in the realtime tier, no re-mint.
- THE load-bearing regression test: no onMessage fires for a transcript event received before attachMic() — the phantom-transcript guard as an executable invariant.

## Gates

tsc, lint, vitest (new + voice/caddie suites), voice smoke, build. /code-review + /security-review (mint/WebRTC lifecycle change). designer: confirm Connecting… preserved, just rarer. On-device manual check post-ship: first-ever open shows mic dialog once; warmed open < ~0.5s; no phantom transcript on silence; background/airplane toggles don't leak a session or double the voice.

## Scope

One builder item. If trimming is needed: the orb wiring (items 5-6) is the splittable half; the setup-sheet preload answers the owner's complaint and ships first.
