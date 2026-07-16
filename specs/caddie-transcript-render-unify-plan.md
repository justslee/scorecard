# caddie-transcript-render-unify — Implementation Plan

Repo: `/Users/justinlee/projects/scorecard` · Frontend-only · No backend diff expected.
Northstar: yardage-book, voice-first, calm serif/paper — never SaaS/dashboard (`NORTHSTAR.md`).
Fable plan (technical seam) + designer concept (visual reference) reconciled by eng-lead. Cycle 132.

## 0. The defect

The same "user turn / caddie turn" conversation renders FOUR different ways across live
surfaces (CADDIE-EXPERIENCE dims 3 & 8). One — CaddieSheet live mode — renders SaaS chat
bubbles (alignSelf flex-end/flex-start, radius-14 pills, ink/paperDeep fills), which breaks
the calm paper feel. Consolidate all four onto ONE shared transcript-rendering primitive in
the yardage-book idiom, keeping each surface's functional differences as COMPOSITION
(slots/props), then delete the divergent copies.

## 1. Verified current state (re-verify lines before editing — they may shift)

Four live render paths:

1. **VoiceSheet `Turn`** — `frontend/src/components/yardage/Voice.tsx:122-177`, mapped at
   `Voice.tsx:274` (`turns.map((t,i) => <Turn key={i} …/>`, index-keyed, `state` passed only
   to the LAST turn). Mounted at `frontend/src/app/round/[id]/RoundPageClient.tsx:2261-2276`
   with `turns={voice.turns}`. `VoiceTurn = { role:"user"|"caddy"; text }` (`Voice.tsx:16`).
   User: mono "You" caption + serif italic 24px + opening quote glyph + blinking listening
   caret. Caddy: 32px ink **medallion** with `caddy.initial` + mono `caddy.name` caption +
   `Waveform` when `state==="speaking"` else mono "SAID" chip + serif 18px body. Data via
   `useVoiceCaddie` → `messagesToTurns` (`lib/caddie/transport.ts:148-152`).

2. **LooperSheetShell** — `frontend/src/components/LooperSheet.tsx:297-324` (turn list,
   `turns.map((t,i) => <div key={i}…`), `:325-352` streaming block, `:353-366` listening,
   `:367-382` thinking, `:383-395` error, `:284-296` empty hint. `LooperTurn = { role:
   "user"|"looper"; text }` (`:24`). Caption mono 8.5px ls 1.4 `T.pencilSoft` uppercase —
   `t.role==="user"?"You":speakerLabel` (`:309`). Body serif 15.5px lh 1.45 ls −0.1 `T.ink`,
   italic when looper. `speakerLabel` threaded from `CaddieOrbSheet.tsx:385-389` via
   `captionPersonaName`. Consumed globally (`app/layout.tsx:68`). **Cleanest idiom — base.**

3. **CaddieSheet `VoiceBody`** — `frontend/src/components/CaddieSheet.tsx:2045-2345`
   (classic in-round "Ask caddie"). `VoiceCaddieMessage = { role:"user"|"assistant"; content }`
   (`lib/caddie/types.ts:180-183`). History: gated `convHistory.length > 2`,
   `convHistory.slice(0,-2).map((msg,i)…)` key=`i` (`:2071-2110`), CARDED radius-12
   `T.paperDeep`/`T.paperEdge` + hairline borders, caption raw `caddy.name`. NEWEST turn from
   SEPARATE `transcript`/`voiceAnswer` state in an `AnimatePresence mode="wait"` block
   (`:2113-2324`): quoted mono transcript, radius-16 carded answer with accent-colored
   `caddy.name` caption, follow-up/clear CTAs, nested `ListeningIndicator`.

4. **CaddieSheet `LiveVoiceBody`** — `CaddieSheet.tsx:1765-1838` (Realtime live mode).
   `RealtimeMessage = { id; role:"user"|"assistant"; text; partial?; order }`
   (`lib/voice/realtime.ts:45-58`). `messages.map((m)…)` **key=`m.id`** — the ONLY id-keyed
   renderer. Messages arrive PRE-SORTED by `order` from `useCaddieLiveSession` ("render
   as-is"); `partial` → opacity 0.7. **CHAT BUBBLES** (alignSelf, 85% maxWidth, radius 14,
   ink/paperDeep). No per-turn caption. The SaaS violator AND the surface carrying the
   dedup/ordering fix from `caddie-realtime-double-emit` — visuals may change, data flow may NOT.

Tokens: `frontend/src/components/yardage/tokens.ts` (`T`, `Caddy` at `:51`).

**Out of scope (5th bubble renderer):** `VoiceRoundSetupRealtime.tsx` (live at `/round/new`).
Do NOT touch this cycle; note as follow-up in the PR.

## 2. The shared primitive

### 2.1 Location / name
New file **`frontend/src/components/yardage/Transcript.tsx`** (NORTHSTAR: build on
`components/yardage/`). Two exports: per-turn primitive `ConversationTurn` (real seam — lets
VoiceSheet keep per-turn slots) + thin container `Transcript` (uniform lists). `Transcript`
is `turns.map(t => <ConversationTurn key={t.key} …/>)` in a flex column — owns nothing else.

### 2.2 API (the contract)
```tsx
export type TranscriptTurn = {
  key: string;                 // caller-owned React key (live: m.id; others: String(i))
  speaker: "user" | "caddie";
  text: string;
  streaming?: boolean;         // still-growing: user caret (display) / caddie live reply pulse
  muted?: boolean;             // reduced emphasis (kept in API; NOT used for live partials — see §3.2)
};
export function ConversationTurn(props: {
  turn: TranscriptTurn;
  speakerLabel?: string;       // caddie caption; user always "You". default "Caddy"
  size?: "book" | "display";   // book = LooperSheet base (default); display = VoiceSheet hero
  accent?: string;             // streaming caret color (display user)
  captionColor?: string;       // caption color override (default T.pencilSoft)
  leading?: ReactNode;         // slot left of the turn — VoiceSheet medallion
  captionTrailing?: ReactNode; // slot after caption — VoiceSheet Waveform / "SAID"
}): JSX.Element;
export function Transcript(props: {
  turns: TranscriptTurn[]; speakerLabel?: string; size?: "book"|"display";
  accent?: string; gap?: number; /* default 10 */
}): JSX.Element;
```

**Hard invariant (put in file header):** renders exactly the given array, in the given order,
keyed by `turn.key`. Visuals ONLY — never data, ordering, dedup, filtering. Ordering fixes
live upstream (`lib/voice/realtime-ordering.ts`/`useCaddieLiveSession.ts`) — NOT touched here.

### 2.3 Visual spec (designer-authoritative — put tokens in a named constants block at top)
Base = LooperSheet turn markup as defaults, amended with the designer's spec:
- **Caption (both roles):** `T.mono`, 9px, ls 1.3, uppercase, color `T.pencilSoft` for BOTH
  roles (kill CaddieSheet's accent-colored caddie caption), mb 6.
- **User body:** `T.serif` italic, book 20px / display 24px, lh 1.28 (book) / 1.22 (display),
  ls −0.3 / −0.4, `T.ink`. Keep the opening curly-quote glyph (`T.pencil`, ~85% body size,
  baseline-shifted) on EVERY surface's user turn. Blinking listening caret when `streaming`
  user turn (from `Voice.tsx:134-140`).
- **Caddie body:** `T.serif` italic, 16px (book) / 18px (display), lh 1.4, ls −0.15, `T.ink`.
  NO card, NO border, NO background wash.
- **User vs caddie WITHOUT bubble alignment:** everything flush-left, full width. Distinguish
  by (1) caption content ("You" vs speaker name), (2) body size/weight (user bigger+quoted+
  terser, caddie calmer+longer). No alignSelf anywhere.
- **Streaming vs completed:** in-progress caddie turn renders at **opacity 1** (do NOT dim —
  dimmed live text reads as broken) with a live indicator in the caption row (reuse `PulseDot`
  from `yardage/Voice.tsx:84`, inline ~14-16px, as LooperSheet's thinking row). Completed →
  no indicator, no badge. **Kill the "SAID" chip** (pure SaaS status label) — VoiceSheet's
  caddie caption trailing shows Waveform while speaking, nothing when done.
- **Spacing:** user turns mb 16, caddie turns mb 14 (defaults; builder confirms empirically at
  render QA — intent not pixel-mandate).

## 3. Per-consumer adapters (keying/ordering acceptance criteria)

### 3.1 LooperSheetShell — migrate FIRST (base idiom + strictest string tests)
Replace turn list (`:297-324`):
```tsx
<Transcript
  turns={turns.map((t,i)=>({ key:String(i), speaker: t.role==="user"?"user":"caddie", text:t.text }))}
  speakerLabel={speakerLabel}
/>
```
Replace streaming block (`:325-352`, same gate `streamingTurn != null`):
```tsx
<ConversationTurn
  turn={{ key:"streaming", speaker:"caddie", text:streamingTurn, streaming:true }}
  speakerLabel={speakerLabel}
/>
```
Keep UNTOUCHED: empty hint, listening, thinking, error, TTS wiring, header, mic. Keep
`LooperTurn`/`LooperPhase` exports. **Acceptance:** `LooperSheet.test.tsx` passes UNEDITED
(pins exact "You"/`speakerLabel`/two-Looper-nodes/kicker) → primitive reproduces strings
character-for-character. Index keys stay.

### 3.2 LiveVoiceBody — the SaaS-bubble kill (highest risk)
Replace bubble map (`:1814-1835`):
```tsx
<Transcript
  turns={messages.map((m)=>({
    key: m.id,                                       // id-keyed — NEVER String(i)
    speaker: m.role==="user"?"user":"caddie",
    text: m.text,
    streaming: m.partial,                            // DESIGNER OVERRIDE: partial → streaming (opacity 1 + pulse), NOT muted/0.7
  }))}
  speakerLabel={captionPersonaName(caddy.name)}      // §4 — live mode GAINS captions
/>
```
Keep UNTOUCHED: both empty-state hints (`liveEmptyStateHint`), `LiveFooter`. Move the
"render as-is" comment onto the adapter. Adapter is 1:1 — no `.filter()`/`.sort()`/dedup. An
empty-text partial renders a caption with empty body — ACCEPT (do NOT filter; filtering would
diverge the rendered set from `live.messages` and risk the glitch-suite guarantees).
**Reconciliation:** the Fable plan proposed `muted: m.partial → 0.7`; the designer OVERRODE
this (dimmed live content reads as broken). Use `streaming: m.partial`; the primitive shows
opacity 1 + a caption pulse for a streaming caddie turn. `muted` stays in the API, unused here.
**Acceptance (BLOCKING):** key stays `m.id`; render order stays array order.
`CaddieSheet.realtime.test.tsx` order tests (`:425-443`, `:566-619`) and
`.realtime-glitch.test.tsx` dedup asserts (`getAllByText(...).toHaveLength(1)`) pass. `git
diff --name-only` shows ZERO change to `realtime.ts`, `realtime-ordering.ts`,
`useCaddieLiveSession.ts`, `realtime-dedup.test.ts`, `realtime-ordering.test.ts`.

### 3.3 VoiceBody — history unifies; current-turn split PRESERVED
History (`:2071-2110`): keep the `convHistory.length > 2` gate and `slice(0,-2)` EXACTLY;
replace the carded map with `<Transcript turns={convHistory.slice(0,-2).map((msg,i)=>({
key:String(i), speaker: msg.role==="user"?"user":"caddie", text:msg.content }))}
speakerLabel={captionPersonaName(caddy.name)} />`. Drop the radius-12 history cards (designer
D3: flatten). Current turn (`:2113-2324`): DO NOT collapse `transcript`/`voiceAnswer` into the
array. Keep the `AnimatePresence mode="wait"` block, ALL keys verbatim ("voice-answer",
"voice-listening", "voice-transcribing", "voice-thinking", "voice-error"), CTAs,
`ListeningIndicator`, and the answer-card CONTAINER (functional: hosts CTAs + re-listen).
Inside the card replace caption+body markup (`:2154-2177`) with `<ConversationTurn turn={{
key:"current", speaker:"caddie", text:voiceAnswer }}
speakerLabel={captionPersonaName(caddy.name)} captionColor={T.pencilSoft} />` (caption
standardized to pencilSoft per designer). Quoted mono transcript line (`:2130-2143`) stays as-is
this cycle (D4). **Acceptance:** `CaddieSheet.session.test.tsx`/`.handsfree.test.tsx` green,
zero behavior change; newest turn never appears twice.

### 3.4 VoiceSheet — medallion + waveform as slots
DELETE the local `Turn` (`:122-177`). Extract the medallion (`:148-166`) into a file-local
`Medallion({ caddy })` in `Voice.tsx` (VoiceSheet-only — NOT in Transcript.tsx). Extract the
mono "SAID"→ replace: the designer kills the SAID chip; VoiceSheet caddie caption shows
Waveform while speaking, nothing when done. Replace the map (`:274`) with a `ConversationTurn`
map (index keys preserved): `size="display"`, `accent`, `speakerLabel={captionPersonaName(
caddy?.name||"Caddy")}`, `leading={isCaddie ? <Medallion caddy={caddy}/> : undefined}`,
`captionTrailing={isCaddie && speaking ? <Waveform .../> : undefined}`, and `turn.streaming =
!isCaddie && isLast && voiceState==="listening"` (user caret). `speaking = isCaddie && isLast
&& voiceState==="speaking"`. Keep `VoiceTurn`/`VoiceState` exports, `VoiceOrb`, `PulseDot`,
`Waveform`, sheet chrome, mic dock. **Acceptance:** waveform ONLY on last caddie turn while
speaking; caret ONLY on last user turn while listening; medallion on every caddie turn.

## 4. speakerLabel / persona caption policy
Every tiny mono caption attributing the caddie uses `captionPersonaName(caddy.name)`
(`lib/caddie/persona.ts:81`). Consequences (all designer-approved): LiveVoiceBody GAINS
captions (required once alignment dies); CaddieSheet/VoiceSheet captions change e.g. "THE
STRATEGIST"→"STRATEGIST" (persona-coherence win). Sheet HEADERS/prose ("Live with {caddy.name}",
"{caddy.name} · On the bag", `liveEmptyStateHint(…, caddy.name)`, "{caddy.name} is thinking…")
are NOT captions — leave raw. Verified no test queries the exact caption strings in
CaddieSheet/VoiceSheet; `persona.test.ts` pins `captionPersonaName` itself.

## 5. Tests
### 5.1 New `frontend/src/components/yardage/Transcript.test.tsx`
user→"You" caption+text; caddie→given `speakerLabel`; renders array order AS GIVEN
(non-chronological in → same DOM text order out); preserves caller keys (reorder same-key
array → same DOM nodes move, identity preserved → no internal re-keying); no dedup (2 identical
texts distinct keys → 2 nodes); `streaming` caddie turn renders opacity 1 + pulse; `streaming`
user display turn renders caret; `leading`/`captionTrailing` slots render. Register in
`frontend/src/lib/voice/caddie-experience-suite.ts` with `dimensions:[3,8]`.
### 5.2 Keep green UNEDITED
`CaddieSheet.realtime`/`.realtime-glitch`/`.handsfree`/`.session`, `CaddieOrbSheet`,
`LooperSheet`, `persona.test.ts`, `realtime-dedup.test.ts`, `realtime-ordering.test.ts`, full
`test:caddie-experience`.
### 5.3 Gates (from `frontend/` unless noted)
`npm run lint` · `npx tsc --noEmit` · `npm run build` · `npm test` (full vitest) ·
`npm run test:caddie-experience` · `npx tsx voice-tests/runner.ts --smoke` · backend `ruff
check` (from `backend/`, `git diff --stat backend/` EMPTY). BLOCKING diff gate: `git diff
--name-only` must NOT include `lib/voice/realtime.ts`, `lib/voice/realtime-ordering.ts`,
`hooks/useCaddieLiveSession.ts`, `lib/types.ts`, `backend/app/models.py`.

## 6. Dead-code rider (SILENT, conditional — judgment call, not blind delete)
Grep-verified dead: `CaddieModal.tsx` imported/rendered NOWHERE; `CaddiePanel.tsx` (1327 lines,
zinc/emerald SaaS chat) only by `CaddieModal.tsx:7`; `CaddieNotesCard.tsx` only by
`CaddiePanel.tsx:61`; `hooks/useRealtimeCaddie.ts` only by `CaddiePanel.tsx:57`. All other
mentions are comments. Fold in deletion of these FOUR files ONLY IF the builder re-runs the
grep confirming zero live imports AND accepts that `CaddieNotesCard`'s "Caddie's notes on you"
memory UI is intentionally gone (unreachable today). If either fails, skip — not required.
Do NOT delete `lib/caddie/plays-like.ts` etc. (live).

## 7. Risks
R1 (BLOCKING) re-sort/dedup/re-key in live mode regresses double-emit fix → primitive renders
as-given; adapter 1:1 `key:m.id`; §5.3 diff gate + order/dedup tests. R2 VoiceBody newest turn
double-render → `slice(0,-2)` + separate card preserved. R3 caption drift breaks LooperSheet
identity tests → migrate LooperSheet FIRST, tests unedited. R4 streaming semantics → `streaming`
(caret/pulse, opacity 1) is the live-partial flag; `muted` unused for live (designer override).
R5 empty-text partial → caption+empty body (accepted, don't filter). R6 AnimatePresence key
churn → keep all motion keys + `mode="wait"` byte-identical. R7 new caption nodes collide with
text queries → verified none. R8 don't invent ids — keep caller keys. R9 per-surface empty
states stay per-surface. R10 waveform/caret last-turn gating stays in consumer. R11
VoiceRoundSetupRealtime out of scope → follow-up note.

## 8. Ordered build sequence
1. Create `Transcript.tsx` (constants + `ConversationTurn` + `Transcript`) + `Transcript.test.tsx`;
   register in `caddie-experience-suite.ts`. Run new test. 2. Migrate LooperSheetShell (§3.1);
   run `LooperSheet`/`CaddieOrbSheet` tests unedited. 3. Migrate LiveVoiceBody (§3.2) — delete
   bubbles; run realtime + glitch tests; verify §5.3 diff gate. 4. Migrate VoiceBody (§3.3);
   run session/handsfree. 5. Migrate VoiceSheet (§3.4) — delete local `Turn`, add
   `Medallion` local. 6. Apply §4 caption policy. 7. Optional rider (§6): re-verify, delete the
   4 dead files. 8. Full gates (§5.3); confirm `types.ts`/`models.py` untouched; no
   VAD/mic/one-mic/TTS/backend changes.
