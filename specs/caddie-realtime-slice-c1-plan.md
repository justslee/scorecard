# Caddie Realtime — Slice C1 Implementation Plan (flag-default-OFF, silent rider)

Parent contract: `specs/caddie-realtime-conversation-plan.md`. This slice is stage 1 of Slice C, folding in Slice B's flagged shell (neither B nor the flag exist yet). It delivers live-mode transport in `CaddieSheet` behind a NEW `looper.caddieLiveMode` pref that ships **OFF**. Classic path stays byte-for-byte. Zero edits to `realtime.ts` / `warm-session.ts` is the goal and is achievable — every seam consumed here is already public and pinned.

## 1. Approach (what actually gets built)

`CaddieSheet` becomes dual-mode. On open it decides **live** vs **classic**:

- **Eligible for live** = `getCaddieLiveMode() && sessionActive && navigator.onLine`. Note `sessionActive` passed from `RoundPageClient` is already `caddieSessionActive && !isLocalRound` (RoundPageClient.tsx:2138), so `!isLocalRound` is already folded in — the sheet does not need a new `isLocalRound` prop.
- **Live** adopts a warm caddie Realtime client or cold-mints a fresh one, `attachMic()`s, injects the opening reco as the first spoken turn via `sendText`, and renders the streamed transcript in CaddieSheet chrome. Server VAD runs start/stop; only mute + close are exposed.
- **Fallback** (mint > 3s / connect-fail-before-connected / mic-deny / onError-before-connected / offline-at-open) → seamlessly renders the existing classic `VoiceBody`/mic with a calm mono indicator "Tap-to-talk mode". Never a dead sheet.
- **Flag OFF** (default) → the live branch is never entered; CaddieSheet renders exactly as today.

Realtime lifecycle lives in a NEW hook `useCaddieLiveSession` (mirrors `VoiceRoundSetupRealtime`'s inline client lifecycle + `useVoiceCaddie`'s adopt/cold pattern) rather than inlining ~150 lines into the already-2239-line `CaddieSheet.tsx`. CaddieSheet consumes the hook and swaps its body + footer.

## 2. The flag mechanism (verbatim for PR checklist + progress.md)

NEW file `frontend/src/lib/voice/live-mode-pref.ts`, mirroring `tts-pref.ts` exactly:

```ts
const STORAGE_KEY = "looper.caddieLiveMode";
export function getCaddieLiveMode(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(STORAGE_KEY) === "1"; } catch { return false; }
}
export function setCaddieLiveMode(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0"); } catch {}
}
```

**Default: OFF** (key absent → `getCaddieLiveMode()` returns false).

**How the owner flips it on-device (no shipped UI toggle in stage 1):** a one-shot URL param on the round page. Add to `RoundPageClient` a `useEffect` that reads `useSearchParams().get("liveMode")` once on mount and, if present, calls `setCaddieLiveMode(v === "1")`. So the owner opens `…/round/<id>?liveMode=1` on his iPhone once to turn it on (`?liveMode=0` to turn it off); the pref then persists in localStorage for every subsequent open. This matches the app's existing `useSearchParams` convention (used in `TournamentPageClient`, `CourseDetailClient`, etc.) and needs zero new UI. Console fallback for a tethered debug build: `localStorage.setItem('looper.caddieLiveMode','1')`.

## 3. The live session hook — `frontend/src/hooks/useCaddieLiveSession.ts` (NEW)

Signature (consumed by CaddieSheet):
```ts
useCaddieLiveSession({
  active: boolean;          // flag ON && sessionActive && open (gate)
  roundId: string;
  personaId: string;
  resolveOpeningShot?: () => Promise<{ distanceYards: number; fromTee?: boolean } | null>;
}): {
  liveState: 'connecting' | 'live' | 'fallback';
  fellBack: boolean;
  messages: RealtimeMessage[];   // already sortByOrder'd
  status: RealtimeStatus;
  muted: boolean;
  toggleMute: () => void;
  stop: () => void;              // client.stop()
}
```

Internals — mirror the two existing consumers, seam-for-seam:

1. On `active` transitioning true (and only while `navigator.onLine`):
   - Arm a `MINT_DEADLINE_MS` (3s, imported from `lib/caddie/transport.ts`) timer → on fire before `connected`, set `fallback`.
   - `const warm = warmSession.takeWarm({ kind: 'caddie', roundId, personalityId: personaId })`.
   - If `warm`: `warm.setEvents(events)` → `warm.emitCurrentStatus()` → `await warm.attachMic()`. On attachMic reject → fallback (mic-deny).
   - Else cold: `const client = new RealtimeCaddieClient({ roundId, personalityId: personaId }, events)` (no `mode` field — presence of `roundId` = caddie mode, exactly as `useVoiceCaddie` line 199) → `await client.start()`. On reject → fallback.
   - **Stage-1 reality to document, not fix now:** the existing "Ask caddie" one-mic guard calls `voice.stop()` (RoundPageClient.tsx:2012) which runs `warmSession.teardown()`, so `takeWarm` will usually return `null` and the sheet **cold-mints**. That is correct and safe. Wiring warm-adopt to actually hit is a later-stage optimization; do NOT touch the guard in this slice. Still call `takeWarm` first so the adopt path lights up for free once coordination is refined.

2. `events`:
   - `onStatus`: track `status`; on first `connected` set `liveState:'live'`, clear the mint deadline, and trigger the opening turn (below). On `error`/`closed` before ever-connected → fallback. Guard all setState with a `mountedRef`.
   - `onMessage`: `upsert` with `sortByOrder` (copy the `upsert` from `VoiceRoundSetupRealtime` lines 103-112).
   - `onError`: if never connected → fallback.
   - (No `onToolCall` needed here — tool dispatch is internal to `realtime.ts`.)

3. **Opening turn (first spoken turn via `sendText`, §1.3):** once `connected` AND `attachMic()` resolved, guard-once (`openedRef`), then:
   ```ts
   const shot = await resolveOpeningShot?.();
   if (!shot) return;                       // honest idle — just listen
   client.sendText(buildOpeningTurnText(shot));
   ```
   `sendText` (realtime.ts:324) already does `conversation.item.create` + `response.create` when the DC is open and surfaces the user bubble — the caddie then speaks turn one. Do NOT add a realtime.ts method.

4. `toggleMute` → `client.setMuted(next)`; `stop()` → `client.stop()`. Teardown on unmount and when `active` goes false (mirror VoiceRoundSetupRealtime cleanup lines 194-200).

**Shared opening-turn text builder:** extract the exact strings currently inline in CaddieSheet.tsx:708-710 into a module-scope pure `buildOpeningTurnText(shot)` and have BOTH the classic path (line 708) and the live hook call it. Output is byte-identical, so classic behavior and its tests are unchanged; this satisfies §1.3 "keep the opening-turn text builder in one place."

## 4. CaddieSheet changes — `frontend/src/components/CaddieSheet.tsx`

- Read the flag at open: `const wantLive = open && sessionActive && getCaddieLiveMode();` Call `useCaddieLiveSession({ active: wantLive && navigator.onLine, ... })`.
- Derive `liveActive = wantLive && !live.fellBack`.
- **Render swap:** when `liveActive`, render a new `<LiveVoiceBody>` (bubble list copied from `VoiceRoundSetupRealtime` lines 337-356: user right/`T.ink`, caddie left/`T.paperDeep` serif-italic, partials at 0.7 opacity, `messages` already order-sorted) in place of the `mode==='voice'` `<VoiceBody>`, and replace the classic mic block (line 1490 `showMic`) with a footer status line (`RealtimeStatus`→calm copy, reuse `STATUS_LABEL`) + mute toggle (`live.toggleMute`) + existing close. Keep the sheet's outer chrome (header, persona picker, tabs). The "Distance" tab may remain (classic tap-reco is independent of the mic); the "Voice" tab body is what live replaces.
- **Fallback indicator:** when `wantLive && live.fellBack`, render the normal classic voice UI plus a quiet mono line "Tap-to-talk mode" (style like the existing footer mono labels, e.g. `T.mono` 9px `T.pencil`). No toast, no alarm.
- **Gate classic effects OFF while `liveActive`:** the auto-opening-turn effect (line 682) and the hands-free loop effects must early-return when `liveActive` so there is no double opening turn and no double mic. The live path owns the opening turn and TTS.
- **TTS separation (§5 / §6):** in live mode never call `tts.speak`/`tts.enqueue`; the Realtime client's own in-DOM `playsinline` sink handles audio. The #108 iOS fix was for the classic path only — keep both audio paths separate.
- On sheet close (`onClose`): call `live.stop()` before the parent's `setCaddieOpen(false)`.

## 5. RoundPageClient — `frontend/src/app/round/[id]/RoundPageClient.tsx`

Only one addition for this slice: the one-shot `?liveMode=` → `setCaddieLiveMode` persistence effect (§2). Do NOT change the one-mic guard, `resolveOpeningShot` wiring, or `useVoiceCaddie` in this slice. `resolveOpeningShot` is already passed to `CaddieSheet` (line 2142) and flows into the hook unchanged.

## 6. CONSUMED — do NOT modify

- `frontend/src/lib/voice/realtime.ts` (`RealtimeCaddieClient`: `setEvents`, `emitCurrentStatus`, `attachMic`, `sendText`, `setMuted`, `stop`, `RealtimeMessage`/`RealtimeStatus`)
- `frontend/src/lib/voice/warm-session.ts` (`warmSession.takeWarm`)
- `frontend/src/lib/voice/realtime-ordering.ts` (`sortByOrder`)
- `frontend/src/lib/caddie/transport.ts` (import `MINT_DEADLINE_MS` only)
- `frontend/src/lib/voice/tts-pref.ts` (pattern reference only)

**Guardrail (state twice):** touching `realtime.ts` warm/mic/gating code without growing `realtime-warm.test.ts` in the same commit is a HARD STOP. This slice is designed to require zero such edits. If a seam edit becomes unavoidable, name it and grow the corresponding pinning test (`realtime-warm.test.ts` / `realtime-dispatch.test.ts` / `warm-session.test.ts`) in the same commit.

## 7. Tests — `frontend/src/components/CaddieSheet.realtime.test.tsx` (NEW)

Deterministic only. `vi.mock("@/lib/voice/realtime")` and `vi.mock("@/lib/voice/warm-session")` to hand back a controllable fake client whose `events` you capture and drive (mirror the injected-`createClient` style in `warm-session.test.ts` and the fake-peer style in `realtime-warm.test.ts`). NO real `getUserMedia`/`RTCPeerConnection`/sockets. Mock `getCaddieLiveMode` → true for the live suite. Reuse the existing `framer-motion`/`api`/`telemetry` mocks from `CaddieSheet.handsfree.test.tsx`.

Exact assertions:
1. **Adopt-warm path:** `takeWarm` returns a fake → `setEvents` + `emitCurrentStatus` called, `attachMic` called **exactly once**.
2. **Cold-mint path:** `takeWarm` returns `null` → `RealtimeCaddieClient` constructed with `{ roundId, personalityId }`, `start()` + `attachMic` called once.
3. **Opening turn:** after driving `onStatus('connected')` + attachMic resolved, with a `resolveOpeningShot` stub returning `{distanceYards: 150}`, `client.sendText` called **once** with the `buildOpeningTurnText` string; on `resolveOpeningShot` → `null`, `sendText` **not** called (honest idle).
4. **Transcript order:** feed `onMessage` out of arrival order → bubbles render in `sortByOrder` order (assert DOM text sequence).
5. **Mute:** tapping the mute control calls `client.setMuted(true)` then `setMuted(false)`.
6. **Fallback — never dead:** three cases each render the classic voice mic AND the "Tap-to-talk mode" indicator: (a) mint-timeout (advance fake timers past `MINT_DEADLINE_MS` before `connected`), (b) connect-fail (`onStatus('closed')`/`onError` before ever-connected), (c) mic-deny (`attachMic` rejects). Assert the classic mic button is present and no dead/empty sheet.
7. **Flag OFF:** with `getCaddieLiveMode` → false, `takeWarm`/`RealtimeCaddieClient` are **never** called and the classic UI renders (guards the silent-rider invariant).
8. **No TTS in live:** assert the mocked `useSheetTTS.speak` is not called on the live happy path.

**Do not weaken** `CaddieSheet.handsfree.test.tsx` / `CaddieSheet.session.test.tsx` — they must pass unmodified (flag defaults OFF, so their world is unchanged).

## 8. Shared types

No change. Grounding rides inside the `instructions` string / existing tool JSON (Slice A, separate). `frontend/src/lib/types.ts` ↔ `backend/app/models.py` untouched; `StartRealtimeSessionResponse` untouched.

## 9. Edge cases / risks

- **Warm-adopt rarely fires in stage 1** because the one-mic guard tears warm down on Ask-caddie open. Accepted: cold-mint is correct; warm-adopt optimization deferred. Do not edit the guard now.
- **Double opening turn / double mic** if classic effects aren't gated — gate the line-682 effect and hands-free effects on `!liveActive`.
- **Offline-at-open** → skip mint, straight to classic (checked via `navigator.onLine` before `active`).
- **iOS audio** — never introduce a second `<audio>` element or route live replies through `useSheetTTS`; the Realtime client owns its sink.
- **Device-only verification** — WebRTC/VAD can only be truly exercised on a real iPhone; CI is deterministic-mock. Flag stays OFF until owner device-signs-off (a later stage flips the default).
- **Persona id mismatch** — pass `personaId` (the sheet's real backend persona) as `personalityId` into both `takeWarm` and the cold client, matching `useVoiceCaddie`.

## 10. Gate commands (exact — run the frontend set; backend unchanged this slice)

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && npx vitest run src/components/CaddieSheet.realtime.test.tsx
cd frontend && npx vitest run                 # full suite: new + classic sheet + all voice
# Confirm pinning tests still GREEN (must not be modified this slice):
cd frontend && npx vitest run src/lib/voice/realtime-warm.test.ts src/lib/voice/warm-session.test.ts src/lib/voice/realtime-dispatch.test.ts
# Confirm classic sheet tests pass unmodified:
cd frontend && npx vitest run src/components/CaddieSheet.handsfree.test.tsx src/components/CaddieSheet.session.test.tsx
```
Before PR ready (CLAUDE.md — new user-facing capability on an authed transport path): `/code-review` and `/security-review`. Backend `ruff`/`pytest` not required here (no backend change in C1).

## 11. Files to touch (precise)

- NEW `frontend/src/lib/voice/live-mode-pref.ts` — flag helper.
- NEW `frontend/src/hooks/useCaddieLiveSession.ts` — Realtime lifecycle (adopt/cold, attachMic, opening turn via `sendText`, mute, stop, fallback).
- `frontend/src/components/CaddieSheet.tsx` — consume flag+hook, live body/footer swap, gate classic effects off in live, "Tap-to-talk mode" fallback indicator, extract `buildOpeningTurnText`.
- `frontend/src/app/round/[id]/RoundPageClient.tsx` — one-shot `?liveMode=` → `setCaddieLiveMode` persistence effect only.
- NEW `frontend/src/components/CaddieSheet.realtime.test.tsx` — deterministic live-mode tests.
