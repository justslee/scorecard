# caddie coherence polish — greeting normalize + loading copy align (designer-led concept)

Cycle 133. Two cycle-127 audit nits, batched (each below solo-cycle worthiness). Designer-led
concept (the vocabulary table below IS the builder's contract; fable architecture plan omitted per
the eng-lead brief's explicit designer→builder→reviewer→qa→designer process for a copy-alignment nit).
Land on `integration/next` (bundle #141). SILENT-ish polish. Land-and-review only — do NOT ship/ping.

Scope confirmed genuinely copy-layer only: NO change to `RealtimeStatus`, connect sequencing,
`useCaddieLiveSession`, VAD/mic, `realtime.ts`/`realtime-ordering.ts`, or shared types.

## 1. GREETING TABLE

| Surface | Greeting text / source | Persona-voicing rule | Reopen / no-re-greet rule |
|---|---|---|---|
| Round (spoken live / rendered classic) | `buildOpeningGreetingText()` `frontend/src/lib/caddie/opening-turn.ts:19-23` — WORDS UNCHANGED (already on-idiom). | Live: Realtime paraphrases in persona voice via `buildOpeningGreetingInstruction`. Classic: verbatim, captioned `captionPersonaName(caddy.name)` (round is always a persona chat, classic → "Classic Caddie"). | Already correct — `CaddieSheet.tsx:845` `if (convHistory.length > 0) return;` + `liveTranscriptSeenRef` at :840. CANONICAL reference — do NOT touch. |
| Converse (CaddieOrbSheet/LooperSheet, no bound task) | `emptyHint` `CaddieOrbSheet.tsx:396-401`. classic → "Tee times, courses, your game — ask me anything." non-classic → `` `${caddy.name} here — …` ``. | Not spoken (placeholder prose). FIX the name mismatch: swap `caddy.name` (untruncated) → `captionPersonaName(caddy.name)` at :401, matching the `speakerLabel` resolved at :386-389 so greeting and caption never disagree; also prevents long-custom-name overflow. | Safe today only as byproduct (emptyHint renders only when `turns.length===0`; `turns` persist across close/reopen). MAKE IT AN EXPLICIT TESTED INVARIANT: one comment at the `turns` state decl (`CaddieOrbSheet.tsx:44`) + a test asserting turns survive close→reopen and the hint never reappears once `turns.length>0`. |
| Task lane (LooperSheet bound to a page task) | `activeTask.copy.hint`/`.title` `LooperSheet.tsx:395,397`. | Never persona-voiced — `speakerLabel === "Looper"` when `activeTask != null` (:387-388). Correct as shipped; codify as canonical row. | N/A as a greeting event (static persistent task question). Do NOT add a no-repeat guard. |

TRAP (flag, do NOT build): "surface-appropriate greeting" must NOT be read as giving converse a
SPOKEN greeting like round — that needs a live Realtime session wired into CaddieOrbSheet + the
fire-once state machine. Out of scope; file separately if the owner wants it.

## 2. LOADING TABLE

| Status | Copy | Name used | Adopting surfaces |
|---|---|---|---|
| idle (round, mid-round) | `Connecting…` | — | `live-copy.ts` LIVE_STATUS_LABEL.idle |
| idle (round setup, pre-tap) | `Tap to start` | — (kept, legit distinct pre-tap state) | `VoiceRoundSetupRealtime.tsx:53` — unchanged |
| connecting | `Connecting…` | — | both |
| connecting (empty-state prose) | `Connecting to {name}…` | resolved name | `liveEmptyStateHint` |
| connected | `Ready — go ahead` | — | both |
| listening | `Listening…` | — | both |
| listening (empty-state prose) | `Go ahead — {name} is listening.` | resolved name | `liveEmptyStateHint` |
| speaking | `{name} is speaking…` | resolved name | both (CHANGED — was generic "Caddie") |
| speaking (empty-state prose) | `{name} is speaking.` | resolved name | `liveEmptyStateHint` (fix misresolved name — see below) |
| thinking | `{name} is thinking…` | resolved name | `LooperSheet.tsx:338` — already correct, cite as reference |
| error/closed | `Couldn't connect` / `Ended` | — | both, unchanged |
| paused | `Paused — tap resume below to keep talking.` | — | `liveEmptyStateHint`, unchanged |

Name resolution:
- Round surface (`live-copy.ts`, real persona known): resolved name = `captionPersonaName(caddy.name)`
  (same value as `speakerLabel` at `CaddieSheet.tsx:1828`). Fix BOTH: (a) `LIVE_STATUS_LABEL.speaking`
  → template on `{name}`, called with `captionPersonaName(caddy.name)`; (b) `liveEmptyStateHint`'s
  callers (`CaddieSheet.tsx:1799,1813`) currently pass RAW `caddy.name` — change to
  `captionPersonaName(caddy.name)` at both call sites.
- Round-setup surface (`VoiceRoundSetupRealtime.tsx`, hardcoded classic, task-like): resolved name =
  `"Looper"` → `speaking` = `"Looper speaking…"`. DEDUPE the fork: replace its `STATUS_LABEL` (:52-59)
  with `{ ...LIVE_STATUS_LABEL, idle: "Tap to start", speaking: "Looper speaking…" }` imported from
  `live-copy.ts` (one source of truth, no future silent fork).

Rationale: cross-surface identity (`captionPersonaName`/`speakerLabel`) already shipped; a generic
"Caddie speaking…" label two lines above a persona-named transcript caption is exactly the
two-honest-states-disagree bug `live-copy.ts`'s own header (:8-11) exists to prevent.

## 3. Calm-idiom rules (shared)
1. No exclamation marks anywhere.
2. Spaced em-dash ` — ` for two-clause context+prompt/status joins; never hyphen/colon for the join.
3. Ellipsis `…` (no trailing period, no space before) reserved for genuinely in-progress states;
   settled states get a period or none.
4. Persona name leads as grammatical subject of the action verb. Two both-correct identities:
   round & converse → `captionPersonaName(caddy.name)`; task lane & round-setup → `"Looper"`.
   Never mix within one surface.
5. Sentence case throughout; no Title Case.
6. Greetings end in a question/soft invitation; status/loading labels are bare declaratives.

## 4. RED-testable divergences (update the pinned tests — intentional expected diffs)
- `frontend/src/lib/caddie/live-copy.test.ts:89` pins `LIVE_STATUS_LABEL.speaking === 'Caddie speaking…'`
  → flips to persona-named form. Update.
- `frontend/src/components/CaddieSheet.realtime.test.tsx:1135` `getByText("Caddie speaking…")` → flips.
- NEW test: empty-hint name and transcript `speakerLabel` byte-identical for a long custom persona
  name (guard modeled on live-copy.test.ts:73-89 "never disagree").
- NEW test: `VoiceRoundSetupRealtime` STATUS_LABEL stays in sync with LIVE_STATUS_LABEL (or the dedupe
  removes the possibility).
- NEW test: converse no-re-greet invariant (turns survive close→reopen; hint never reappears once
  `turns.length>0`).
- NEW test: `CaddieOrbSheet.tsx:401` hint name == `:389` caption name for a >16-char custom persona.

## 5. Scope check — both nits are copy-layer only, no session-open restructure. CONFIRMED small.
