# Caddie Orb Persona Consistency — Implementation Plan

**Branch:** `integration/next` (head `4cd41ca`). Two bundled P1s:
- **Part 1 (noticeable):** the omnipresent caddie orb discards the user's chosen persona on every non-round surface — hardcoded `"classic"` in the converse API calls and in the sheet TTS voice.
- **Part 2 (reliability, no prod mutation):** prod `caddie_personas` rows carry `voice_id='fable'` (professor, course-historian) — invalid for the OpenAI Realtime API, erroring the session mint. Fix = a voice-validity clamp at the mint choke point. A prod DB write is OUT OF SCOPE.

NORTHSTAR contract: quiet, voice-first, yardage-book feel; ONE coherent caddie presence (voice + name + greeting) across every surface. This plan touches only the off-round TEXT/TTS converse path (Part 1) and the backend mint payload (Part 2). It does NOT touch the live realtime session code paths on the frontend.

---

## Part 1 — Thread the selected persona through the orb

### 1.1 Ground truth (verified against head)

- `frontend/src/components/CaddieOrbSheet.tsx` — mounted ONCE in `frontend/src/app/layout.tsx` (line ~68, inside `AuthProvider`). `runConverse` hardcodes `personality_id: "classic"` twice:
  - line 202 — the streaming call `talkToCaddieStream({ ... personality_id: "classic" ... })`
  - line 215 — the JSON fallback `talkToCaddie({ ... personality_id: "classic" ... })`
- `frontend/src/components/LooperSheet.tsx` — `LooperSheetShell` (line 47) hardcodes the spoken voice at line 109: `tts.speak(last.text, "classic")` inside the speak-newest-turn effect (lines 94–112).
- Source of truth: `frontend/src/lib/caddie/persona.ts` → `useCaddiePersona()` (line 115). Resolution: server `preferred_personality_id` → localStorage `looper.caddiePersonaId` → `'classic'`. Initial state reads localStorage synchronously (line 116–118); one effect fetches `fetchPersonalities()` + `getCaddieProfile()` via `Promise.allSettled` (failure-tolerant, lines 121–145). `selectPersona` (line 147) writes state + localStorage + fire-and-forget `PUT /caddie/profile`.
- **Persona picker locations (grep `selectPersona`):** invoked ONLY from the round page — `src/app/round/[id]/RoundPageClient.tsx:275` (hook) → `:2316` `onSelectPersona={selectPersona}` → `CaddieSheet.tsx:1497` (persona picker in the round caddie sheet; `CustomPersonaModal` creates customs there too). There is NO off-round persona picker today.
- **`LooperSheetShell` consumers (grep):** exactly ONE — `CaddieOrbSheet.tsx:372`. The "tee-time shell instance" referenced in old comments was subsumed by the orb host; the optional-prop default is still required (back-compat for direct-render tests and any future consumer), but no other production call site needs edits.
- Backend `/api/caddie/voice` and `/api/caddie/personalities` fully honor `personality_id`; `speakCaddieReply(text, personalityId)` (`src/lib/caddie/api.ts:1093`) already threads it. This is a pure frontend omission.

### 1.2 Decision: where the orb resolves the persona

**Chosen: mount `useCaddiePersona()` inside `CaddieOrbSheet` (the layout-mounted host), and add a tiny module-level pub-sub inside `persona.ts` so ALL hook instances converge on `selectPersona`.**

Why this and not the alternatives:

- **`storage`-event listener — REJECTED.** The DOM `storage` event fires only in OTHER tabs/windows, never in the tab that performed the write. The one real mid-session change path (user changes persona in the round page's `CaddieSheet`, then leaves the round and talks to the orb) is same-tab, so a storage listener solves nothing for the actual scenario.
- **Read localStorage at send-time in `runConverse`/`handleMicTap` — REJECTED as the sole mechanism.** It fixes the API `personality_id` cheaply, but (a) a fresh device with empty localStorage would ignore the server `preferred_personality_id` (the profile fetch is what resolves it), (b) the TTS voice lives in a child component effect keyed off a prop, which wants reactive state, and (c) the name/greeting coherence item (1.5) needs the `personas` list + `caddy` display shape — only the hook provides those.
- **Accept a stale layout instance — REJECTED.** It contradicts the owner's crux ("ONE coherent presence"): change persona on the round page, walk to Home, orb still speaks classic. The pub-sub costs ~15 lines in the module that already owns persistence.
- **Chosen mechanism fits existing patterns:** the codebase already uses module-level subscribe buses for exactly this cross-component wiring — `src/lib/looper-bus.ts` (`onLooperOpen`) and `src/lib/caddie-context.ts` (`onCaddieContextChange`). The pub-sub lives inside `persona.ts` (single file owns state, persistence, and now propagation).

**Boot-cost assessment (acceptable):** mounting the hook in the layout host adds two small parallel GETs (`/api/caddie/personalities`, `/api/caddie/profile`) at app boot, via `Promise.allSettled` — failures (including 401 when logged out) are swallowed and fall back to `BUILTIN_PERSONAS` + localStorage, so nothing blocks or crashes. When a round page also mounts its own instance the fetches duplicate (2 extra GETs per round open) — accepted; a module-level fetch cache is explicitly out of scope (do not sprawl). Note this in a code comment.

### 1.3 Exact edits

**A. `frontend/src/lib/caddie/persona.ts` — cross-instance sync (new, ~15 lines):**
- Module level: `const personaListeners = new Set<(id: string) => void>();` and `function notifyPersonaChange(id: string) { for (const l of personaListeners) l(id); }` (not exported, or exported only for tests).
- In `selectPersona` (line 147–153): after `setPersonaId(id); writeLocalPersonaId(id);` add `notifyPersonaChange(id);`.
- Also emit from the profile-resolution branch of the effect (after line 139 `writeLocalPersonaId(resolved)`) — idempotent (`setPersonaId` with an equal value is a React no-op) and keeps an already-mounted instance aligned if a later-mounting instance resolves the server preference first.
- In `useCaddiePersona`, add a subscribe effect: on mount `personaListeners.add(setPersonaId)` (or a wrapper), cleanup removes it. Guard: the emitter also having written localStorage means no listener needs to persist — listeners ONLY `setPersonaId`.
- No signature change to `CaddiePersonaState` — round page (`RoundPageClient.tsx:275`) is untouched and gains the same convergence for free.

**B. `frontend/src/components/CaddieOrbSheet.tsx` — consume + thread:**
- Import `useCaddiePersona` from `@/lib/caddie/persona`; at top of the component: `const { personaId, caddy } = useCaddiePersona();`.
- Line 202: `personality_id: "classic"` → `personality_id: personaId`.
- Line 215 (JSON fallback): same replacement.
- `runConverse` `useCallback` deps (line 241): add `personaId`. (`handleMicTap` already lists `runConverse` in its deps at line 341, and `micTapRef.current` is reassigned every render at line 343, so the auto-send path can never capture a stale persona.)
- Shell render (line 372): pass `personaId={personaId}`.
- NOTHING ELSE in this file changes — summon routing (lines 122–154), boundId binding, staleness `sessionRef` gen, context-unmount hygiene (lines 162–169), task gates, and the stream→JSON ladder structure stay byte-identical apart from the two literals + prop + greeting (1.5).

**C. `frontend/src/components/LooperSheet.tsx` — TTS voice + optional prop:**
- Add to `LooperSheetShell` props (line 47–76): `personaId?: string;` with JSDoc stating it selects the SPOKEN voice + is display-inert; destructure with default: `personaId = "classic"`.
- Line 109: `tts.speak(last.text, "classic")` → `tts.speak(last.text, personaId)`.
- The speak-newest-turn effect's dep array (line 112) intentionally stays `[open, turns]` with the existing eslint-disable — `personaId` is read at fire time; a persona change alone must NOT trigger the effect (it would incorrectly re-evaluate the watermark). Reading the fresh prop inside the effect closure is correct because the component re-renders on prop change before any new turn lands.
- Because the prop is optional with default `'classic'`, any consumer that omits it is byte-identical in behavior.

### 1.4 SSR / first-render safety (requirement 4)

- `useCaddiePersona`'s initial state calls `readLocalPersonaId()` which returns `null` server-side → `'classic'` on the server pass, possibly a different id on the client initializer. This CANNOT cause a hydration mismatch: the sheet renders `null` until `open === true` (AnimatePresence, `open` starts `false`), and `open` only flips on a user summon — no persona-dependent markup exists at first paint.
- Before the profile fetch resolves, `personaId` is the localStorage value (last known choice on this device) or `'classic'` — never undefined, never a crash; `caddy` falls back through `BUILTIN_PERSONAS` (persona.ts lines 155–158). A custom persona id that no longer resolves client-side still sends fine: backend `load_personality` falls back to classic server-side.

### 1.5 Name/greeting coherence — general lane only (requirement 3)

Current general-lane copy (CaddieOrbSheet.tsx lines 375–380): title `"What can I do for you?"`, emptyHint `"Tee times, courses, your game — ask me anything."`.

**Do (minimal, calm):** persona-aware emptyHint for the GENERAL lane only, and only when a non-classic persona is selected — keep classic byte-identical:

- title: unchanged (`"What can I do for you?"` is already quiet and persona-neutral).
- emptyHint fallback becomes (only in the final `??` position, so task and converse lane copy win exactly as today):
  `personaId === "classic" ? "Tee times, courses, your game — ask me anything." : `${caddy.name} here — tee times, courses, your game. Ask me anything.``
  (`caddy.name` is e.g. "The Hype Man" — one serif-italic line, no extra chrome, no emoji, no new components.)

**Explicitly defer (do NOT do):** renaming the shell's hardcoded "Looper" kicker (LooperSheet.tsx line ~175), the per-turn "Looper" author labels (~292, ~320), and "Looper is thinking…" (~362). Those are shared chrome across ALL lanes (task lane included); renaming them per persona is the audit's broader "assistant-name label consistency" item and would churn copy + existing test assertions across lanes — out of scope for this item. Note the deferral in the PR description.

### 1.6 Invariants — explicit guards (requirement 5)

The builder must NOT touch, and the reviewer must verify unchanged:
- **ONE-mic / single-orb invariant:** no new mic buttons, no second dictation instance; `useLooperDictation` stays the single instance in `CaddieOrbSheet` (line 80).
- **Realtime files untouched:** `src/lib/voice/realtime.ts`, `src/lib/voice/realtime-ordering.ts`, `src/hooks/useCaddieLiveSession.ts` — zero diffs. This item is the TEXT/TTS off-round converse path only.
- **Lane routing untouched:** summon routing (surface/legacy-courses/task/converse lanes), `boundId` binding, `sessionRef` staleness gen, context-unmount close, task gates (a)/(b)/(c), expectReply timer — only diffs in `CaddieOrbSheet.tsx` are: the hook call, two `personality_id` literals, the `personaId` prop, the emptyHint expression, dep array.
- **Task/converse lane copy:** tee-time task titles/hints and my-card converse titles/hints render exactly as before (they sit EARLIER in the `??` chains).
- **TTS opt-in default:** `getSheetTtsEnabled()` default-off behavior unchanged; we change only the persona argument, never when speech happens.

### 1.7 Tests — RED first (requirement 6)

**Existing harness facts:** `CaddieOrbSheet.test.tsx` is in the `test:caddie-experience` manifest (`src/lib/voice/caddie-experience-suite.ts` line 55) — new assertions there ride the named gate automatically. Its `vi.mock("@/lib/caddie/api")` factory (line ~62) currently exports ONLY `talkToCaddie`, `talkToCaddieStream`, `BeforeFirstByteError`.

**Test-infra prerequisite (will otherwise break at import time):** once `CaddieOrbSheet` imports `useCaddiePersona`, `persona.ts` pulls `fetchPersonalities`, `getCaddieProfile`, `updateCaddieProfile` from the mocked `@/lib/caddie/api` module. Extend the factory:
`fetchPersonalities: vi.fn(async () => [])`, `getCaddieProfile: vi.fn(async () => ({ preferred_personality_id: null }))`, `updateCaddieProfile: vi.fn(async () => ({}))` (hoisted so tests can override per-case). Also hoist the `useSheetTTS` mock's `speak` into a shared `vi.fn()` (currently an inline throwaway at line 85) so it can be asserted. Clear localStorage in `beforeEach`.

**New tests in `frontend/src/components/CaddieOrbSheet.test.tsx`** (describe block: "persona threading"):
1. *Selected persona reaches the streaming converse call:* seed `window.localStorage.setItem("looper.caddiePersonaId", "hype")`; summon via `openLooper` (general lane); drive the fake dictation to resolve "what's a good warmup?"; assert `talkToCaddieStream` called with `expect.objectContaining({ personality_id: "hype" })`. **RED today:** actual is `"classic"`.
2. *Selected persona reaches the JSON fallback:* same seed; make `talkToCaddieStream` reject with `MockBeforeFirstByteError`; assert `talkToCaddie` called with `personality_id: "hype"`. **RED today.**
3. *TTS speaks in the selected persona's voice:* same seed; let the stream resolve a reply text; after the looper turn commits, assert the hoisted `speak` mock was called with `(replyText, "hype")`. **RED today:** second arg is `"classic"`.
4. *Fallback floor:* no localStorage, `getCaddieProfile` resolves `{ preferred_personality_id: null }` → assert `talkToCaddieStream` called with `personality_id: "classic"` (GREEN before and after — regression pin).
5. *Server preference wins over localStorage:* localStorage `"hype"`, `getCaddieProfile` resolves `"professor"` → after the profile microtask settles, converse call carries `"professor"` (pins the hook's documented resolution order end-to-end through the orb).

**New file `frontend/src/components/LooperSheet.test.tsx`** (jsdom; mock `useSheetTTS` + framer-motion with the same cached-Proxy pattern as the orb test):
6. *Default-prop back-compat:* render `LooperSheetShell` open WITHOUT `personaId`, rerender appending a looper turn → `speak(text, "classic")`. Proves omitted-prop consumers are behavior-identical.
7. *Prop honored:* same with `personaId="hype"` → `speak(text, "hype")`. **RED today** (prop doesn't exist yet — write the test against the new prop; TypeScript will also be red until the prop lands, which is fine for a compile-level RED).
   (Leave the caddie-experience manifest untouched — the orb test already carries the gate coverage; do not add this file to the suite.)

**Proving RED:** implement tests 1–3, 5, 7 BEFORE the source edits; run `cd frontend && npx vitest run src/components/CaddieOrbSheet.test.tsx src/components/LooperSheet.test.tsx` and capture the failures showing actual `"classic"`. Then apply 1.3 and re-run to GREEN. Then run the full named gate `npm run test:caddie-experience` plus the realtime suites (`realtime-ordering.test.ts`, `CaddieSheet.realtime-glitch.test.tsx` et al. run inside both `npm run test` and the gate) — all must stay green with zero modifications to those files.

---

## Part 2 — Realtime voice-validity clamp (backend, no prod mutation)

### 2.1 Ground truth (verified)

- Root cause (already audited — do not re-audit): guarded seed `backend/supabase/migrations/003_caddie_personas.sql` carries `voice_id='fable'` on `professor` (line ~70) and `course-historian` (line ~97). `'fable'` is TTS-only — the Realtime API rejects it at mint (hard error, no fallback). `app/caddie/personalities.py::load_personality` (line ~181) is DB-FIRST, so the prod row overrides the cycle-127 code fix (`professor`→`cedar` in `PERSONALITIES`).
- Single choke point confirmed: `backend/app/services/realtime_relay.py::build_session_payload` (line 52) builds `"output": {"voice": voice_id or OPENAI_REALTIME_DEFAULT_VOICE, "speed": 1.15}` at line 144. Its ONLY production caller is `mint_ephemeral_session` (line 167), which is called from exactly two routes: `app/routes/realtime.py:86` (`/setup-session`) and `:142` (`/session`). Clamping inside `build_session_payload` therefore covers ALL mints with one clamp, and is pure/unit-testable with no HTTP mock at all.
- Valid Realtime voice set documented at `app/caddie/types.py:319` (comment on `CaddiePersonality.voice_id`): `alloy | ash | ballad | coral | echo | sage | shimmer | verse | marin | cedar`. `OPENAI_REALTIME_DEFAULT_VOICE` defaults to `"sage"` (relay line 21) — a member of the set.
- `tests/eval/test_realtime_session_config.py` already holds a LITERAL `VALID_REALTIME_VOICES` set (lines 42–45) as independent teeth over `PERSONALITIES` (code-side personas). It does NOT cover DB-sourced voice_ids — that is the gap this clamp closes.

### 2.2 Design

**Constant — single production source of truth:** define in `backend/app/caddie/types.py`, immediately above `CaddiePersonality` (adjacent to the line-319 doc comment, which should now reference it):
`VALID_REALTIME_VOICES: frozenset[str] = frozenset({"alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"})`
`types.py` is the natural home (it already documents the enum; no import cycle: `realtime_relay` → `app.caddie.types` is a new clean edge, `types.py` imports nothing from services).

**Clamp helper — in `realtime_relay.py`, exported:**
```
def clamp_realtime_voice(voice_id: Optional[str]) -> str:
    if voice_id in VALID_REALTIME_VOICES: return voice_id
    if voice_id: logger.warning("invalid Realtime voice %r — clamped to %r", voice_id, OPENAI_REALTIME_DEFAULT_VOICE)
    return OPENAI_REALTIME_DEFAULT_VOICE
```
- `None` → default (preserves the existing `voice_id or DEFAULT` behavior exactly, silently).
- Invalid non-empty value → default + ONE `logger.warning` — deliberate observability: prod logs will show the `'fable'` rows surviving in the DB until the owner-gated repair, without erroring the golfer's session.
- Apply at line 144: `"output": {"voice": clamp_realtime_voice(voice_id), "speed": 1.15}`. **`"speed": 1.15` is NOT touched.**

**Echo-back clamp — YES, do it.** `app/routes/realtime.py` lines 98 and 162 currently echo `voice_id=personality.voice_id or mint.get("voice", "")` into `StartRealtimeSessionResponse.voice_id`. Change both to `voice_id=clamp_realtime_voice(personality.voice_id)`. Justification: after the clamp, a `'fable'` row would otherwise make the server REPORT `voice_id="fable"` while actually minting `sage` — the response should describe the session that was actually minted (client telemetry/display honesty), and the helper makes it one shared expression, not a second copy of the logic. Response SHAPE is unchanged (same field, same type) → `frontend/src/lib/types.ts` ↔ `backend/app/models.py` need NO changes (confirmed: `StartRealtimeSessionResponse` is defined inline in `routes/realtime.py`; no shared-shape edit anywhere in this bundle).

**Eval-test teeth vs. duplication:** the literal set in `tests/eval/test_realtime_session_config.py` STAYS as-is (a test's independent copy is the point of the teeth — importing the production constant there would let a bad edit to the constant self-certify). Add one drift alarm to that file: `test_valid_voice_constant_matches_closed_set` asserting `app.caddie.types.VALID_REALTIME_VOICES == VALID_REALTIME_VOICES` (the local literal). Production code holds exactly ONE copy.

**Explicit non-goals:** no change to `sage`/default, no change to `speed: 1.15`, no edits under `backend/supabase/migrations/` (guarded dir), NO prod DB write of any kind (blocked/owner-gated; the clamp makes the repair non-urgent).

### 2.3 Backend tests — RED first (pure unit, CI-safe, no DB / no network)

Add to `backend/tests/test_realtime_payload.py` (already imports `build_session_payload` with the env shims at lines 10–14):
1. `test_invalid_tts_only_voice_clamped_to_default` — `build_session_payload("sys", "fable")` → `payload["session"]["audio"]["output"]["voice"] == OPENAI_REALTIME_DEFAULT_VOICE`. **RED today:** actual is `"fable"`. This is the exact prod-row scenario (a DB persona carrying `'fable'` reaches the mint via `personality.voice_id`). Parametrize over `["fable", "onyx", "nova", "not-a-voice"]`.
2. `test_valid_voice_passes_through_unchanged` — `build_session_payload("sys", "marin")` → `"marin"` (and keep the existing `"alloy"` passthrough test at line 98 green).
3. `test_default_voice_is_a_valid_realtime_voice` — `OPENAI_REALTIME_DEFAULT_VOICE in VALID_REALTIME_VOICES` (guards the env-default config shipped in code; an operator overriding the env var to an invalid voice remains an ops error — flagged, not engineered around).
4. `test_clamp_none_falls_back_to_default` — `clamp_realtime_voice(None) == OPENAI_REALTIME_DEFAULT_VOICE` (pins that the pre-existing None behavior is preserved).
5. *Echo-back honesty (route-level, still pure):* new test (same file or `tests/test_realtime_voice_clamp.py`) calling `await start_setup_session(SetupSessionRequest(personality_id="professor"), user_id="u1")` directly with `monkeypatch` on `app.routes.realtime.load_personality` (returns a `CaddiePersonality` with `voice_id="fable"`) and `app.routes.realtime.mint_ephemeral_session` (returns `{"value": "ek_x", "expires_at": 1, "id": "rs_1", "model": "gpt-realtime"}`) → assert `response.voice_id == OPENAI_REALTIME_DEFAULT_VOICE`. **RED today:** `"fable"`. No DB, no HTTP — safe for local `uv run pytest` (DB-integration tests stay CI-deferred).
6. Drift alarm in `tests/eval/test_realtime_session_config.py` per 2.2 (GREEN on landing; exists to catch future divergence).

Prove RED: write tests 1 and 5 first, run `cd backend && uv run pytest tests/test_realtime_payload.py tests/eval/test_realtime_session_config.py -x`, capture the `"fable"` failures, then land 2.2 and re-run to GREEN.

---

## Sequencing

1. **Backend clamp first** (independent, smallest): types.py constant → RED tests → relay helper + line-144 clamp → routes echo clamp → GREEN → `ruff check . && uv run pytest`.
2. **Frontend persona threading:** persona.ts pub-sub → orb/shell RED tests (incl. the api-mock factory extension) → CaddieOrbSheet + LooperSheet edits → greeting tweak → GREEN.
3. Full gates (below), then one manual pass: with persona set to Hype on the round page, leave the round, summon the orb on Home → reply arrives as Hype (network tab: `personality_id: "hype"`), speaker-toggle on → spoken in Hype's voice; greeting reads "The Hype Man here — …".

## Verification contract (gates)

- Frontend: `cd frontend && npm run lint && npx tsc --noEmit && npm run test && npm run test:caddie-experience && npx tsx voice-tests/runner.ts --smoke && npm run build`
- Backend: `cd backend && ruff check . && uv run pytest` (DB-integration tests deferred to CI)
- Shared shapes: NO change to `frontend/src/lib/types.ts` / `backend/app/models.py` (confirmed — no request/response shape changes anywhere in this bundle).
- Reviewer diff-guard: zero diffs in `src/lib/voice/realtime.ts`, `src/lib/voice/realtime-ordering.ts`, `src/hooks/useCaddieLiveSession.ts`, `backend/supabase/migrations/**`.

## Risks / flags

- **Boot fetches from layout:** two parallel, failure-tolerant GETs at app boot (plus duplicates when a round page mounts its own hook instance). Accepted as minimal; a module-level cache is a follow-up if it ever shows up in perf traces.
- **Partial name coherence by design:** the shell's "Looper" kicker/turn labels remain — deferred deliberately (shared chrome across lanes; see 1.5). Flag in the PR so the audit item stays visible.
- **Clamp can mask config drift:** an invalid voice now degrades silently to `sage` at runtime. Mitigated by the `logger.warning` and by the eval teeth staying red for any code-side persona regression; the prod-row repair remains owner-gated follow-up.
- **Custom personas with no `voice_id`:** already resolve to default at mint (None-path unchanged) — no behavior change.

## Critical Files for Implementation

- /Users/justinlee/projects/scorecard/frontend/src/components/CaddieOrbSheet.tsx
- /Users/justinlee/projects/scorecard/frontend/src/components/LooperSheet.tsx
- /Users/justinlee/projects/scorecard/frontend/src/lib/caddie/persona.ts
- /Users/justinlee/projects/scorecard/backend/app/services/realtime_relay.py
- /Users/justinlee/projects/scorecard/backend/app/routes/realtime.py
