# Fix iOS TTS Playback (P0) — Implementation Plan

## Problem statement

On the owner's iPhone (Capacitor iOS, WKWebView), spoken caddie replies never play. Prod telemetry: `voicetel surface=sheet-tts event=speak_failed detail=NotSupportedError`. Because the hands-free loop re-arms listening only on the audio element's `ended` event, no playback means no `ended`, means the conversational loop silently stalls. Reply text still renders (TTS is additive), so the failure is invisible except in telemetry.

## Root-cause analysis (ranked, tied to the specific error)

The observed error name is the whole ballgame. WebKit throws two distinct errors from `HTMLMediaElement`:

- **`NotAllowedError`** = autoplay/gesture policy rejected the play.
- **`NotSupportedError`** = the media *resource itself* could not be loaded/decoded (empty, wrong bytes, or a source the pipeline can't sniff as audio).

We observe `NotSupportedError`, so the resource handed to the element is bad. This rules the gesture hypotheses OUT as the reported cause and points squarely at the fetch/blob path.

**Cause (real): #1 — CapacitorHttp binary round-trip corruption + untyped Blob.**
`capacitor.config.ts` sets `CapacitorHttp.enabled = true`, which patches `window.fetch` to route through native `NSURLSession`. `speakCaddieReply` (`api.ts:826`) is the app's *first and only* receive-binary fetch through this path — every other call is JSON (`fetchAPI`), multipart *upload* (`transcribeBlob`), or SSE (streaming), and the realtime sink is a live `MediaStream`, never a downloaded body. Capacitor's native layer base64-encodes binary response bodies; the patched-`fetch` `.blob()`/`.arrayBuffer()` reconstruction is the known-flaky step for binary downloads (bytes mangled and/or the reconstructed `Blob.type` empty). `URL.createObjectURL` on a corrupt/untyped blob yields a resource WebKit can't decode → `.play()` rejects with `NotSupportedError`. This is exactly the signature. **This is the fix that resolves the reported bug.**

**Hypothesis #2 — gesture-unlock is ineffective (blessing an element with no `src`).** Real latent weakness: `unlock()` (`useSheetTTS.ts:100`) calls `play()` on an element with no source, and the actual `.play()` happens after an `await` (outside the gesture). But if this were the active failure it would surface as **`NotAllowedError`, not `NotSupportedError`** — so it is NOT the reported cause. We still harden it (below) because it is cheap, composable, and the requirement asks for the primed-audio pattern + distinct telemetry; but the plan is honest that #1 is what unblocks the owner.

**Hypothesis #3 — WKWebView autoplay policy / Info.plist `mediaTypesRequiringUserAction`.** Also a `NotAllowedError`-class cause, not observed. The JS-level fixes above are sufficient; **do not touch native config.** (Capacitor's WKWebView already defaults `mediaTypesRequiringUserAction` to none, and the mic-tap gesture chain is intact.) Flagged only so we don't chase it.

## The fix (minimal, composable, two parts)

### Part A — Fetch the mp3 without corruption and always type it (the actual fix)

In `frontend/src/lib/caddie/api.ts` `speakCaddieReply`, branch on platform:

- **Native (`Capacitor.isNativePlatform()` true):** bypass the flaky patched-`fetch` binary reconstruction by calling the native HTTP plugin directly and decoding the base64 ourselves.
  - `import { Capacitor, CapacitorHttp } from '@capacitor/core';`
  - `const resp = await CapacitorHttp.request({ method: 'POST', url: \`${API_BASE}/api/voice/speak\`, headers: { ...(await authHeaders()), 'Content-Type': 'application/json' }, data: { text, personality_id: personalityId }, responseType: 'blob', readTimeout: SPEAK_TIMEOUT_MS, connectTimeout: SPEAK_TIMEOUT_MS });`
  - On native with `responseType: 'blob'`, `resp.data` is a **base64 string**. Reconstruct with an explicit type by reusing the existing, already-tested helper: `return dataUrlToBlob(\`data:audio/mpeg;base64,${resp.data}\`);` (imported from `@/lib/scan-helpers`). This guarantees correct bytes AND `Blob.type === 'audio/mpeg'`.
  - Check `resp.status`: `if (resp.status < 200 || resp.status >= 300) throw new Error(\`Speak failed (${resp.status})\`);` (on error, `resp.data` is base64 of the error body — never feed it to the player).
- **Web (browser / jsdom):** keep the existing `fetch` + status check, but **always re-type the body**: `const buf = await res.arrayBuffer(); return new Blob([buf], { type: 'audio/mpeg' });` instead of `res.blob()`. This makes `createObjectURL` deterministic even if a proxy/browser returns an untyped blob.

Notes / trade-offs to record in code comments:
- `CapacitorHttp.request` has **no `AbortSignal` support**. On native we lose true mid-flight cancellation; `readTimeout` replaces the manual `SPEAK_TIMEOUT_MS` timer for that branch. Correctness of overlap/barge-in is still fully preserved because the hook already guards the result with `if (controller.signal.aborted) return` *after* the await (`useSheetTTS.ts:140`) — a superseded native response is discarded, never played. Keep the `AbortController`/signal plumbing for the web branch unchanged.
- Keep the existing web-path external-abort wiring; only the return-value construction changes.

### Part B — Prime the single element with a real silent source + emit distinct telemetry (harden gesture unlock)

In `frontend/src/hooks/useSheetTTS.ts`:

1. **Prime with a real, decodable source inside the gesture.** In `unlock()`, before `play()`, set `audioElRef.current.src` to a short **silent mp3 data-URI** constant (a module-level `SILENT_MP3_DATA_URI`), then `play().then(pause)`. This gives WebKit a genuine gesture-activated media load so the later programmatic `.play()` is reliably allowed. Keep exactly **one** persistent `HTMLAudioElement` (unchanged); `speak()` reassigns `.src` to the blob URL, reusing the same primed element.
2. **Guard the `ended` re-arm against the prime clip.** The silent prime clip could fire a native `ended` before we `pause()`, which would spuriously call `onPlaybackEnd` and re-arm the hands-free loop. Add a `playingRealRef` (boolean ref): set `true` in `speak()` immediately before `audioElRef.current.play()`, set `false` in `stop()` / at the top of a new `speak()` / in `onEnded`. In `onEnded`, only invoke `onPlaybackEndRef.current?.()` when `playingRealRef.current` was true. This **preserves the `ended`-only re-arm invariant** (a real reply ending still re-arms exactly once) while making prime/silent ends inert. `pause` still never re-arms (unchanged split).
3. **Emit distinct unlock telemetry.** In `unlock()`'s failure paths (the synchronous `catch` and the `play().catch`), call `voiceEvent("sheet-tts", "prime_failed", { detail: err instanceof Error ? err.name : "unknown" })`. This makes gesture/prime failures visible and **distinguishable from `speak_failed`** — telemetry is currently blind here. (Keep the existing `speak_failed` event in `speak()` untouched.)

Barge-in remains "pause the shared element" (`stop()` → `el.pause()`), which fires `pause` → `onPaused` → no re-arm. Unchanged and preserved.

### Backend — confirmed untouched

`backend/app/routes/voice.py:91` returns `Response(content=audio, media_type="audio/mpeg")` and `openai_tts.py` returns real mp3 bytes with `response_format: "mp3"`. `media_type="audio/mpeg"` is correct and sufficient; the native plugin decodes by our explicit `responseType`/reconstructed type, not by a filename. **No backend change needed** — no `Content-Disposition`/filename, no header change. (If we ever wanted belt-and-braces we *could* add `Content-Disposition: inline; filename="reply.mp3"`, but it is unnecessary and out of scope.) No ruff/DB/migration.

## Shared-types note

**No contract change.** `/api/voice/speak` request body (`{ text, personality_id }`) and binary `audio/mpeg` response are unchanged. `speakCaddieReply` still returns `Promise<Blob>`. Nothing in `shared/` or generated types is affected. Flag: if a reviewer proposes returning JSON+base64 from the backend instead, that WOULD be a contract change — we are explicitly not doing that.

## Tests (Vitest / jsdom, matching existing mock style)

**New file `frontend/src/lib/caddie/api.speak.test.ts`** (covers requirement (a) — the fetch bypass / explicit-type reconstruction; this can't live in the hook test because that file mocks `speakCaddieReply` wholesale):
- Web path: mock `@capacitor/core` with `Capacitor.isNativePlatform → false`; stub `global.fetch` to resolve a `Response`-like with `arrayBuffer()` returning known bytes and an empty/absent type; assert `speakCaddieReply()` resolves a `Blob` whose `.type === "audio/mpeg"`.
- Native path: mock `Capacitor.isNativePlatform → true` and `CapacitorHttp.request` to resolve `{ status: 200, data: <base64 of known bytes> }`; assert the result is a `Blob` with `.type === "audio/mpeg"` and decoded byte length matches (reuse `dataUrlToBlob` behavior). Assert `CapacitorHttp.request` is called with `responseType: 'blob'` and JSON `data`.
- Native error: `CapacitorHttp.request` resolves `{ status: 502, data: ... }` → `speakCaddieReply` rejects, and no blob is produced.

**Extend `frontend/src/hooks/useSheetTTS.test.ts`** (requirements (b)–(f); `speakCaddieReply` stays mocked to return a typed blob):
- (b) `unlock()` sets a non-empty `el.src` (the silent data-URI) synchronously — assert `document.querySelector("audio")!.getAttribute("src")` is set and starts with `data:audio`.
- (c) after `unlock()` then `speak()`, the element count stays `1` (element reused) and `play()` is called on it with the blob URL src.
- (d) a new `speak()` while speaking, and `stop()`, and a dispatched `pause` event, all leave `onPlaybackEnd` uncalled (barge-in pauses, never re-arms). (Keep/adapt the existing `pause` test.)
- (e) a dispatched natural `ended` after a real `speak()` calls `onPlaybackEnd` **exactly once** (existing test — keep green with the new `playingRealRef` guard, since `speak()` sets it true).
- (e-guard, new) a dispatched `ended` that occurs from priming only (unlock, no speak) does **not** call `onPlaybackEnd` — proves the prime clip can't re-arm the loop.
- (f) force `unlock()`'s `play()` to reject (`playSpy.mockRejectedValue(new DOMException("x","NotAllowedError"))`) and assert `voiceEvent` is called with `("sheet-tts", "prime_failed", { detail: "NotAllowedError" })`.

Update the jsdom `beforeEach` so setting `.src` to the data-URI doesn't throw (it won't in jsdom; `play`/`pause`/`createObjectURL` remain stubbed as today).

**Do not weaken** `CaddieSheet.handsfree.test.tsx` (tests 1–13, esp. (6) barge-in and (8) multi-turn re-arm) or `CaddieSheet.session.test.tsx` (esp. "speaks once", the post-first-token terminal case where TTS never fires, and "does NOT re-arm mid-stream"). The `playingRealRef` guard must keep the happy multi-turn loop re-arming exactly once per real reply — verify these stay green.

## Edge cases to preserve / verify

- **Offline / TTS 502:** `speakCaddieReply` rejects → hook's `catch` emits `speak_failed`, `isSpeaking=false`, reply text still shown, loop does not re-arm (no `ended`). Unchanged.
- **Abort / overlap (double speak):** new `speak()` aborts prior (web) or is discarded by the post-await `aborted` guard (native); only the latest plays; `playingRealRef` reset at top of `speak()`. Stale first fetch resolving late must not resurrect playback (existing test).
- **Unmount mid-playback:** cleanup effect aborts, revokes object URL, pauses+removes the element. Unchanged (`pause` fires but component is unmounting; guard prevents stray re-arm).
- **`speak()` before `unlock()`:** element lazily created; not primed → `.play()` may reject → `speak_failed` (swallowed). Still surfaces text. Acceptable; unchanged.
- **Barge-in:** `stop()` → pause → `onPaused` (no re-arm); grace timer cleared by CaddieSheet. Preserved.
- **Native timeout:** `readTimeout` fires → request rejects → `speak_failed`. Web keeps the `SPEAK_TIMEOUT_MS` AbortController.

## Risks

- **CapacitorHttp `responseType`/base64 shape:** the exact key (`resp.data` as base64 for `'blob'`) is the documented native behavior in Capacitor v8 (`@capacitor/core` `^8.4.1`). Verify on-device once via the smoke/verify pass; if `'blob'` yields something unexpected, `'arraybuffer'` returns base64 identically — the `dataUrlToBlob` reconstruction is agnostic.
- **Loss of native mid-flight abort:** accepted; correctness preserved by the existing post-await guard. Documented in code.
- **Prime `ended` race** → mitigated by `playingRealRef`. Without it, priming could spuriously re-arm the loop — this is the one subtle interaction to get right.
- **Silent-mp3 data-URI validity on iOS:** use a known-good minimal silent mp3; a malformed URI would itself throw `NotSupportedError` on prime (now visible via `prime_failed`, not conflated with speak).

## Verification gates (run all from `frontend/`)

```
cd frontend
npm run lint
npx tsc --noEmit
npm run build
npx tsx voice-tests/runner.ts --smoke
npx vitest run src/hooks/useSheetTTS.test.ts src/lib/caddie/api.speak.test.ts \
  src/components/CaddieSheet.handsfree.test.tsx src/components/CaddieSheet.session.test.tsx
```

Backend untouched → no ruff/pytest/migrations required. After merge, confirm on-device (or TestFlight) that `voicetel surface=sheet-tts` shows `speak` succeeding (no `speak_failed`/`NotSupportedError`) and the hands-free loop re-arms.

## Implementation sequencing

1. `api.ts` — Part A platform branch + explicit-type reconstruction (unblocks the bug on its own).
2. `useSheetTTS.ts` — Part B prime + `playingRealRef` guard + `prime_failed` telemetry.
3. `api.speak.test.ts` (new) + extend `useSheetTTS.test.ts`.
4. Run gates; confirm handsfree/session suites stay green.

### Critical Files for Implementation
- frontend/src/lib/caddie/api.ts (speakCaddieReply — the binary-fetch fix, ~line 813)
- frontend/src/hooks/useSheetTTS.ts (prime + playingRealRef guard + prime_failed telemetry)
- frontend/src/lib/scan-helpers.ts (dataUrlToBlob — reused to decode base64 → typed Blob)
- frontend/src/hooks/useSheetTTS.test.ts (extend hook tests)
- frontend/src/lib/caddie/api.speak.test.ts (new — fetch bypass / typed-blob tests)
