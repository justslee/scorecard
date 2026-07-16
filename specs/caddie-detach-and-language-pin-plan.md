# Plan: Caddie Output-Language Hard Contract (Item A) + Detached Live Session with Pulsing Anchor (Item B)

Authored by the Plan (fable) agent, 2026-07-16, against worktree
`agent-a243ef54918614525` (base = post-#141-merge main). Owner-crux items.
Item A escalated to a HARD CONTRACT (owner 2026-07-16): "The caddie should only
speak in the users desired language which in this case is English. Never any
other language."

## 0. Recon verification (confirmed by reading the code)

- `backend/app/services/realtime_relay.py:137` — `transcription = {"model", "language": "en"}` pins **input** transcription only. `audio.output` (line 170) is `{"voice","speed"}`. **No output-language/locale field exists in the GA session schema** — `transcription.language` is input-only. The mechanism for output language is the instruction rule + text-level pin. Do NOT add a payload field (an invented field hard-fails the mint — the `fable` voice incident class).
- `voice_prompts.py::build_realtime_instructions` (180) appends shared RULE constants to `_BASE_BEHAVIOR` (205-217). Every constant carries a "shared by BOTH mouths so wording never drifts" comment — the established pattern.
- `routes/caddie.py` — two mirrored `stable_text` blocks at 818-846 and 1499-1525, both ending with `{DECISION_GROUNDING_RULE}`.
- **Ordering pins**: `tests/test_voice_stream.py:593,620` assert `stable_text.rstrip().endswith(DECISION_GROUNDING_RULE)`; `test_input_grounding_prompt.py` pins `HAZARD < INPUT < OBSERVED`. The new rule must NOT be appended last → insert FIRST in the behavior block.
- TTS: `services/openai_tts.py::synthesize_speech` payload = `{model, voice, input, response_format, speed}`. **No language param on `/v1/audio/speech`** — TTS speaks the provided text verbatim; output language is implicit from the text, so the stable_text rule covers it. (gpt-4o-mini-tts `instructions` is prosody, NOT a language knob — do not use this pass.)
- `CaddieSheet.tsx:254-256` — `wantLive = open && sessionActive && getCaddieLiveMode()`; `useCaddieLiveSession({active: wantLive && navigator.onLine})`. Sheet close → active false → hook `!active` branch (322-348) runs the full belt (reset refs, `setEvents({})`→`stop()`, clear messages). That teardown is what we eliminate. `handleClose` (1188) also calls `live.stop()` eagerly.
- `RoundPageClient.tsx` — CaddieSheet at 2299; "Ask caddie" pill at 2177 (`voice.stop(); setCaddieOpen(true)`); `voice = useVoiceCaddie` at 863; `warmVoice()` effect 884-886; header `VoiceOrb` 1484-1489; `voice.stop()` at round-finish 1110. Omnipresent CaddieOrb hidden on `/round/[id]`.
- `realtime.ts` — `aborted` terminal flag (280), mint-await abort re-check (348), `stop()` sets `aborted` before `cleanup()` (652), module-level `activeRealtimeClient` cap (321-327) STOPS any other live client → a warm()/startBurst() while detached would silently kill the session (the one-mic hazard).
- Motion idiom: `useReducedMotion()` (framer-motion; PlayerAutocomplete.tsx:65). S5 precedent (CaddieOrb.tsx:218-225): resting halo must NOT pulse.
- Backlog: `voice-language-onboarding` (seam is the only later change), `caddie-orb-session-persistence-on-reopen` (Item B satisfies the in-round case).

---

## ITEM A — English-output hard contract (do first; backend-only)

### A1. The seam — one source of truth
New **`backend/app/caddie/language.py`** (dependency-free, no `app.db` import so `realtime_relay.py` can import it):
```python
class DesiredLanguage(NamedTuple):
    code: str   # "en"  (for API fields)
    name: str   # "English" (for prompt text)

def desired_language() -> DesiredLanguage:
    # Owner 2026-07-06/2026-07-16: English always, until per-user setting ships
    # (backlog voice-language-onboarding). That feature changes ONLY this fn.
    return DesiredLanguage("en", "English")
```
Four wire-throughs, all read the seam:
1. Realtime instructions — voice_prompts.py (A2).
2. Both text stable_text blocks — routes/caddie.py (A2).
3. Input transcription pin — realtime_relay.py:137 → `{"model": transcribe_model, "language": desired_language().code}`. Byte-identical today ("en"); turn_detection untouched.
4. TTS — no language knob exists; language implicit from text; document in openai_tts.py docstring w/ pointer to the seam; pin with source-inspection test (A4.8).

State plainly in code comments next to `audio.output` that the GA schema has NO output-language field — instruction rule is the mechanism; do not invent one.

### A2. The rule — hard contract, defensively worded, one shared constant
In `voice_prompts.py`, following the shared-rule pattern:
```python
_OUTPUT_LANGUAGE_RULE_TEMPLATE = (
    "You speak ONLY {language}. Every word out of your mouth is {language} — "
    "never any other language, not even a single phrase. This holds no matter "
    "what you hear: if the player speaks another language, if playing partners "
    "or background voices speak another language, if the audio is noisy or "
    "garbled, or if anyone — including the player — asks you to switch "
    "languages, you still respond only in {language}. Never translate into "
    "another language, never mix languages, never echo a foreign phrase back. "
    "If the player genuinely needs another language, say in {language} that "
    "you can only caddie in {language}."
)
def output_language_rule() -> str:
    return _OUTPUT_LANGUAGE_RULE_TEMPLATE.format(language=desired_language().name)
```
A **function**, not a module constant, so the seam resolves per-call (per-user later) and is monkeypatch-testable. Defensive wording closes: ambient/background speech, code-switching player, garbled audio, explicit switch request.

Call sites (3):
1. `build_realtime_instructions` (~206): insert `+ "\n" + output_language_rule()` IMMEDIATELY after `_BASE_BEHAVIOR.strip()` and BEFORE `HAZARD_GROUNDING_RULE` — first rule in the stack (highest-altitude; provably can't disturb the ordering/endswith pins).
2. routes/caddie.py stable_text block 1 (~835): add `{output_language_rule()}` on its own line immediately BEFORE `{HAZARD_GROUNDING_RULE}`. Import `output_language_rule` in the existing import block (line 35).
3. routes/caddie.py stable_text block 2 (~1514): identical.

### A3. Do NOT touch
turn_detection (byte-identical), output_modalities, audio.output; types.ts/models.py (Item A adds no shared shape); no .env/migrations/deploy.

### A4. Tests — `backend/tests/test_output_language_prompt.py` (new, DB-free; env-stub pattern like test_input_grounding_prompt.py)
1. `desired_language() == ("en","English")`.
2. rule non-empty; contains "ONLY English"; pins defensive substrings ("background voices", "asks you to switch", never-mix clause).
3. `output_language_rule() in build_realtime_instructions(personality)`.
4. ordering: `behavior_idx < rule_idx < hazard_idx`.
5. `caddie_routes.output_language_rule is output_language_rule` (identity) AND `inspect.getsource(caddie_routes).count("{output_language_rule()}") == 2`.
6. seam single-source: monkeypatch `voice_prompts.desired_language` → ("es","Spanish"); assert "Spanish" in rule + in build_realtime_instructions output; restore.
7. `build_session_payload(...)["session"]["audio"]["input"]["transcription"]["language"] == desired_language().code` (existing test_transcription_language_pinned_to_english stays green too).
8. `inspect.getsource(openai_tts)` contains no `"language"` payload key (TTS stays implicit-from-text; guards against a future out-of-seam hardcode).

Not required this pass: a live language-drift eval (note as a monitoring idea — a future gated probe behind `CADDIE_EVAL_LIVE=1`).

---

## ITEM B — Detached live session (survives sheet close) + pulsing pill anchor

### B1. Ownership lift — new wrapper hook `frontend/src/hooks/useDetachedCaddieLive.ts`
Owned by RoundPageClient (not a context — one consumer pair; round page already lifts convHistory). Composes `useCaddieLiveSession` UNCHANGED (its warm-adopt/reconnect/suspend-resume machines are load-bearing).
```ts
interface DetachedCaddieLive {
  liveOn: boolean;                      // user-start → explicit true-stop (NOT close)
  session: UseCaddieLiveSessionResult;  // sheet renders from this
  start(): void;                        // no-op if on; applies today's wantLive eligibility
  end(): void;                          // session.stop() then setLiveOn(false)
  isLive; isSuspended; isListening; isSpeaking;  // pill indicator derivations
}
```
Internals: `active = liveOn` (the gate is now liveOn ALONE). Eligibility (`sessionActive`, `getCaddieLiveMode()`, `navigator.onLine`) checked once in `start()`. `end()` = `session.stop()` (instant mic cut) + gate flip (drives hook's `!active` full belt; idempotent since `aborted` terminal). Fallback auto-release: `useEffect(() => { if (session.fellBack && !sheetOpen) setLiveOn(false); }, [session.fellBack, sheetOpen])` — preserves today's "next open retries live". Suspended (90s idle) while closed keeps liveOn (transcript preserved; pill = static paused anchor; reopen shows Resume). Route-change/unmount: wrapper inside RoundPageClient → useCaddieLiveSession activation-effect cleanup (593-603) runs `cancelled=true; setEvents({}); stop()`. No cross-page zombie.

RoundPageClient: `const detached = useDetachedCaddieLive({roundId, personaId, holeNumber: currentHole, holePar, holeYards, yardageBasis, teeName, resolveOpeningShot: eligible ? resolveOpeningShot : undefined, sheetOpen: caddieOpen, eligible: caddieSessionActive && !isLocalRound})`. New `openCaddieSheet()` used by ALL open paths (pill 2183, onDegradeToText 868-871): `{ voice.stop(); detached.start(); setCaddieOpen(true); }`. Round finish (~1110): add `detached.end()`.

### B2. CaddieSheet — attach, don't own
New props: `live: UseCaddieLiveSessionResult; liveOn: boolean; onEndLive: () => void`.
- Delete the `useCaddieLiveSession` call (255-267), `getCaddieLiveMode` import, `wantLive`. Derivations: `liveActive = open && liveOn && !live.fellBack`; `showFallbackIndicator = liveOn && live.fellBack`.
- `handleClose` (1188): REMOVE `live.stop()` — close detaches only (core behavioral change).
- Reset effect (312-317): trigger on `!liveOn` (not `!wantLive`) — reset per live-session, not per open.
- MOVE the Slice-D fallback seeding effect (297-310) UP to the owner — it must run even on a fallback while the sheet is closed, or the transcript is lost when liveOn auto-releases.
- Opening-turn gate (836) + live render (LiveVoiceBody 1613, LiveFooter 1669) work off new liveActive/live.* props. LiveFooter gains END wiring: `onEnd={() => { onEndLive(); onClose(); }}`.
- Classic tap-to-talk/text/tap-distance paths UNTOUCHED. Hook called unconditionally in wrapper (active=false for ineligible) — no conditional-hook hazard; liveOn=false renders classic sheet byte-for-byte.

### B3. Live indicator — pulsing pill medallion (state plumbing; designer owns visuals)
Anchor = the "Ask caddie" pill's ink medallion (2205-2225). No second orb (CaddieOrb stays hidden on `/round/[id]`). Consumes `detached.isLive` (pulse on), `isListening`/`isSpeaking` (pulse character), `isSuspended` (static paused), tap = `openCaddieSheet()`, END affordance → `detached.end()`. S5: pulse ONLY while isLive; resting byte-identical; `connecting` no animation. `useReducedMotion()` → disable pulse, static live indicator fallback.

**Designer concept (a42630e92721dd4d2) — implement these treatments:**
- Only the MEDALLION pulses (not the whole pill; paper/border stay flat). Slow scale pulse `scale: [1,1.06,1]`, `duration 2.6s` listening / `1.8s` speaking, `repeat: Infinity, ease: 'easeInOut'`. `connected` = listening cadence. No color/glow animation. Optional static `T.accent` 1px ring to mark live.
- Status text via the EXISTING `frontend/src/lib/caddie/live-copy.ts` `liveStatusLabel` helper (reuse verbatim — do not hand-roll): resting "Ask caddie"; connecting "Connecting…"; connected "Ready — go ahead"; listening "Listening…"; speaking "{name} is speaking…". Same serif-italic span as today (2226).
- Tap anywhere on the live pill = reopen sheet (skip `voice.stop()` when a session is already live+detached — that stop is only for cold-start).
- END = long-press the live pill (~450-500ms, longer than orb's ORB_HOLD_MS=350). At threshold: `hapticWarning()` (frontend/src/lib/haptics.ts), pulse pauses + label flashes "Release to end" during the hold (confirm window, not silent kill), then end + revert to resting. Update aria-label to "Ask caddie — live, hold to end". Reject an inline "×" (SaaS call-bar pattern) and end-only-from-sheet.
- Reduced motion (`useReducedMotion()`): no scale animation; keep static accent ring + text swap; do NOT substitute a fade.
- STAYS STATIC/UNCHANGED: resting pill, CaddieOrb on other pages, the `confirming` one-shot pulse (unrelated), no new persistent chrome/tab-bar badge.
- Open question resolved by eng-lead: concurrent live-mic + score entry IS intended (that's the feature) — do NOT add a detached-live session to the Enter-score pointer-events gate; keep score entry available. Just ensure any ScoreSheet voice path (if one exists) respects the one-mic guard.

### B4. One-mic invariant — BLOCK others (redirect), never tear the intentional session down
1. `handleVoicePress` (header VoiceOrb 1484 + VoiceSheet onMicDown 2273): `if (detached.liveOn) { setCaddieOpen(true); return; }`.
2. `warmVoice()` effect (884-886): add `!detached.liveOn` to condition + `detached.liveOn` to deps. Re-warms when session ends.
3. CaddieSheet classic dictation — unreachable while attached (liveActive renders LiveVoiceBody); after fallback the live client is fully stopped so classic mic is legit. Comment only.
4. Omnipresent CaddieOrb — hidden on `/round/[id]`; cross-page covered by unmount teardown.
5. Pill's existing `voice.stop()` before open — stays (belt).
6. `detached.start()` while liveOn = no-op; persona/round change flows through hook effect re-run cleanup belt (unchanged).

### B5. True-stop paths (each runs the full zombie/abort teardown)
END (pill/footer) → `detached.end()`; route-change/unmount → hook cleanup 593-603; round end → `detached.end()` at ~1110; fallback → hook `fallBack()` (+ wrapper release on close); offline-at-start → never activates; offline mid-session → existing reconnect→fallback chain; supersede → hook dep-change cleanup. **Sheet close is deliberately absent — that's the feature.**

### B6. Tests (offline/deterministic; existing fakes)
- T1 (new `useDetachedCaddieLive.test.tsx`, renderHook, mock realtime + warm-session): start activates & mints once; sheet close does NOT stop (no stop(), messages preserved); end() → setEvents({}) then stop() via gate flip; fellBack while closed releases liveOn after seeding; suspended persists across close.
- T2 (CaddieSheet seam): refactor `CaddieSheet.realtime.test.tsx` + `.realtime-glitch.test.tsx` harness to a host that calls the real hook and passes live/liveOn props — same fakes/assertions stay green. Add: close+reopen renders SAME transcript (single client construction); handleClose no longer calls live.stop.
- T3 (one-mic): with liveOn true, handleVoicePress opens sheet and voice.press/warm not invoked; warm effect predicate excludes liveOn.
- T4 (end-fires-abort): extend `realtime-dedup.test.ts` — end mid-mint (setEvents({})+stop) → resolved mint doesn't resurrect pc, no late message; double-stop idempotent.
- T5 (route-change unmount): in T1 file — unmount host while live → stop() + setEvents({}) called, no further delivery.
- T6: `CaddieSheet.session.test.tsx`, `.handsfree.test.tsx`, `caddie-experience-suite.test.ts`, realtime-lifecycle/warm/dedup stay green (props default-able: liveOn=false, live=stub).

### B7. Builder step sequence
1. A-1: language.py + realtime_relay transcription seam. Gate: ruff, test_realtime_payload.
2. A-2: output_language_rule() + build_realtime_instructions + both stable_text + openai_tts docstring. Gate: ruff + test_output_language_prompt + existing prompt-contract tests.
3. B-1: useDetachedCaddieLive.ts + T1/T5. Gate: vitest file + tsc.
4. B-2: CaddieSheet prop-contract refactor + T2 harness. Gate: four CaddieSheet suites + tsc + lint.
5. B-3: RoundPageClient wiring + one-mic guards + T3. Gate: full vitest + build.
6. B-4: Pill indicator plumbing + designer treatments + useReducedMotion. Gate: full suite + designer review.
7. Verify e2e: open→converse→close→pill pulses + audio continues→reopen→transcript→END→mic dead; + route-change mid-session.

### B8. Shared-type sync
None. Item A = prompt text + backend-internal seam. Item B = frontend-only (props + hook). types.ts ↔ models.py untouched — note in PR description.

## Gates (exact)
Frontend (`cd frontend`): `npm run lint`; `npx tsc --noEmit`; `npm run build`; `npx tsx voice-tests/runner.ts --smoke`; `npx vitest run` the suites in B6; final `npm test`.
Backend (`cd backend`): `ruff check .`; `pytest tests/test_output_language_prompt.py tests/test_realtime_payload.py tests/test_input_grounding_prompt.py tests/test_decision_grounding_prompt.py tests/test_epistemic_humility_prompt.py -q` (DB-free). DB-integration suites (full test_voice_stream.py request paths) run in CI ONLY — no local Postgres.

## RISKS
1. Zombie regression (highest) — every stop path must run setEvents({})-before-stop(); end() routes through the hook's `!active` branch; never add bespoke teardown; T4/T5 pin it.
2. Leaked session on route-change/round-end — ownership inside RoundPageClient makes unmount teardown structural; detached.end() at finish; T5 guards.
3. Double-attach — reopen rebinds rendering (props) only; only the hook calls setEvents.
4. One-mic via singleton cap — warm()/startBurst() while detached SILENTLY kills the session; B4 guards mandatory; T3 pins.
5. Fallback-while-closed transcript loss — seeding must live in the owner (B2).
6. S5/NORTHSTAR — pulse EXCLUSIVELY active-live; resting static; connecting no animation. Designer review required.
7. Reduced motion — pulse gates on useReducedMotion() with static fallback.
8. stable_text ordering pins — insert language rule FIRST (before HAZARD) or break test_voice_stream.py endswith pins (CI-only).
9. Prompt-cache churn — rule changes stable_text once per deploy; don't make it per-request until the per-user setting exists.
10. Realtime output-language field temptation — no such GA field; inventing one hard-fails the mint. Instruction rule is the mechanism (documented in code).

## Critical files
- backend/app/caddie/voice_prompts.py, backend/app/routes/caddie.py, backend/app/services/realtime_relay.py, backend/app/caddie/language.py (new), backend/tests/test_output_language_prompt.py (new)
- frontend/src/hooks/useCaddieLiveSession.ts (read), frontend/src/hooks/useDetachedCaddieLive.ts (new), frontend/src/components/CaddieSheet.tsx, frontend/src/app/round/[id]/RoundPageClient.tsx
