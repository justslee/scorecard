# Plan — Live caddie answers a STALE hole (P0, owner-reported)

Status: ready for builder · Author: opus planning step (eng-lead pre-handoff)
Scope: the Realtime (live) caddie only. The classic text ladder already threads
`holeNumber` per request and is not stale.

## 1. The bug (session-verified)

On Bethpage hole 3 (par 3, 178Y card) the live caddie opened with HOLE 1's
briefing: "first hole… plays about 384 total… driver". Root cause: the Realtime
session's **instructions are baked at MINT time** by
`build_realtime_instructions(...)` (backend `app/caddie/voice_prompts.py`,
called from `app/routes/realtime.py:start_realtime_session`). The instruction
body contains `# Current situation … Current hole: #<n>` composed from
`session.current_hole`. Two independent staleness sources:

1. **Warm-pool / early mint.** The pool mints at round open (hole 1); a hole
   change never refreshes the live session.
2. **`session.current_hole` itself lags.** Grep of the backend shows it is only
   advanced by tool/endpoint calls that carry a hole number —
   `session_recommend` (`routes/caddie.py:646`), `_build_session_voice_prompt`
   (`:710-711`), `record_shot`, `set_recommendation`. There is **no
   "player advanced to hole N" push** on a plain hole change. So even a fresh
   cold mint at sheet-open can read a stale `current_hole` if the player walked
   to a new hole without triggering a tool.

The tools (`get_conditions`, `get_recommendation`, `get_session_status`) return
correct current data *if the model calls them with the right `hole_number`*, but
the minted instruction context anchors the model to the wrong hole and it
answers from that anchor.

The opening turn compounds it: `useCaddieLiveSession.maybeFireOpeningTurn()`
sends `buildOpeningTurnText(shot)` — "I'm about N yards from the pin…" — which
carries **no hole identity**, so the model answers it from the minted hole.

## 2. Mechanism decision — out-of-band context event, NOT `session.update`

**Use `conversation.item.create` (an authoritative, silent context message,
`role:"system"`) on the live data channel — not `session.update`.**

One-line justification (verified against current OpenAI Realtime docs,
developers.openai.com `realtime-conversations` + `realtime-client-events`,
July 2026): `session.update` instructions "take effect on subsequent model
responses only" (not retroactively) **and** would force the browser to
reconstruct the full server-composed instruction string
(persona + memory + hazards + guide + 20-turn history) that it does not possess;
whereas a `conversation.item.create` message the model treats as ground truth
needs only the hole facts the client already holds (`holeNumber/par/yards`) and
composes cleanly with the on-demand tools. Confirmed both event shapes are
legal on an active WebRTC data channel:
`{type:"session.update",session:{instructions}}` and
`{type:"conversation.item.create",item:{type:"message",role:"system",content:[{type:"input_text",text}]}}`
followed optionally by `{type:"response.create"}`.

Design consequence: the hole-refresh item is sent **without** a following
`response.create` — it is a silent re-anchor, not a spoken turn. This keeps the
caddie quiet on every hole change (NORTHSTAR: calm, no chatter); the corrected
hole is used the next time the golfer actually asks. The opening turn keeps its
own `response.create` (it is a spoken turn) and is simply *preceded* by the
re-anchor item.

> Builder verification note: the doc example uses `role:"system"` with
> `input_text`. If the GA model rejects a system-role conversation item at
> runtime (watch the data channel `error` event in the smoke run), fall back to
> `role:"user"` with an explicit `"[Course update] …"` prefix. Decide this by
> observation in `voice-tests --smoke` / a device check, not by guessing.

## 3. Approach (steps, in order)

### 3.1 New transport seam — `sendContext()` (frontend `src/lib/voice/realtime.ts`)
Add ONE public method to `RealtimeCaddieClient`, mirroring the existing
`sendText()` (~lines 323-350) but **without** `response.create` and **without**
surfacing a transcript bubble:

```
/** Push an authoritative, SILENT context item into the running conversation
 *  (no response.create, no transcript bubble) — re-anchors the model to the
 *  current hole after a hole change or before the opening turn. */
sendContext(text: string): void {
  this.idle.touch();
  if (this.dc?.readyState === 'open') {
    this.dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system',
              content: [{ type: 'input_text', text }] },
    }));
    // No response.create — silent re-anchor, used on the model's NEXT turn.
  }
}
```
No change to `handleEvent`, ordering, idle, or warm/withheld internals. When the
channel is not open the call is a no-op (the next `connected` transition
re-anchors — see 3.4).

### 3.2 New pure text builder (frontend `src/lib/caddie/opening-turn.ts`)
Add a sibling to `buildOpeningTurnText` (keep it in this already-shared file so
the hook has one import surface):

```
export interface HoleContext { holeNumber: number; par: number; yards: number; }
export function buildHoleContextText(h: HoleContext): string {
  return `Course update — ground truth: the player is now on hole ${h.holeNumber}, `
    + `par ${h.par}, ${h.yards} yards on the card. Disregard any earlier hole. `
    + `For live numbers call your tools (get_conditions, get_recommendation) with `
    + `hole_number ${h.holeNumber}; never answer from a previous hole.`;
}
```
Pure, DOM-free, network-free — unit-testable. Note it is a CONTEXT item, never
spoken and never rendered, so verbosity is fine; keep it one tight sentence.

### 3.3 Thread the hole into the hook (frontend `src/hooks/useCaddieLiveSession.ts`)
- Extend `UseCaddieLiveSessionOptions` with `holeNumber: number`, `holePar:
  number`, `holeYards: number`.
- Mirror them into a ref (`holeContextRef`), exactly like the existing
  `resolveOpeningShotRef` mirror (lines 145-148), so the connect/opening-turn
  callbacks (which have empty dep arrays) read the latest values without being
  recreated.
- Add `anchoredHoleRef = useRef<number|null>(null)` to the activation-reset
  block (reset alongside `openedTurnRef` etc. at lines ~247-254 and ~269-278).

### 3.4 Anchor on every connect (in `onStatus`, `src/hooks/useCaddieLiveSession.ts`)
Add a small `anchorHole()` closure (near `maybeFireOpeningTurn`):
```
const anchorHole = useCallback(() => {
  const h = holeContextRef.current;
  if (!clientRef.current || !everConnectedRef.current || !h) return;
  clientRef.current.sendContext(buildHoleContextText(h));
  anchoredHoleRef.current = h.holeNumber;
}, []);
```
Call it in `onStatus` on each transition to `connected` **before**
`maybeFireOpeningTurn()`:
- the reconnect sub-phase branch (line ~301, `if (s==='connected')` inside
  `reconnectingRef`),
- the initial-connect branch (line ~310-317).

Effect: initial connect re-anchors then speaks the opening turn with the correct
hole; a Slice D reconnect or Slice E resume (both mint a fresh, potentially
stale server session, and both skip the opening turn via `openedTurnRef`) still
get a silent re-anchor so the resumed conversation is on the right hole.

### 3.5 Anchor on hole change while open (new effect, same file)
```
useEffect(() => {
  if (!active) return;
  if (anchoredHoleRef.current === null) return; // never anchored yet → 3.4 covers it on connect
  if (holeNumber === anchoredHoleRef.current) return; // no change → no double-refresh
  anchorHole();  // reads the fresh hole from holeContextRef, sets anchoredHoleRef
}, [active, holeNumber, anchorHole]);
```
- Keyed on `holeNumber` only (plus stable `anchorHole`/`active`) → fires **once
  per actual change**.
- The `anchoredHoleRef` guard makes a re-run at the same hole a no-op → **no
  double-refresh race** with the connect-time anchor (which sets
  `anchoredHoleRef` to the same value).
- Session-not-yet-connected: `anchorHole()` early-returns on
  `!everConnectedRef.current`; `anchoredHoleRef` stays null → the eventual
  connect anchors the then-current hole (read live from the ref). No queue
  needed.

### 3.6 Feed the opening turn the hole (same file)
No change to `buildOpeningTurnText` (keeps the natural spoken line and keeps
the existing `sendText` pinning assertion valid). The opening turn "carries the
current hole" via the re-anchor item sent immediately before it in 3.4. The
existing `sendText(buildOpeningTurnText(shot))` at line ~236 is unchanged; it is
now always preceded by a `sendContext(...)` on the same channel in the same
connect handler.

### 3.7 Pass hole props from the sheet (frontend `src/components/CaddieSheet.tsx`)
`CaddieSheet` already receives `holeNumber/holePar/holeYards` (props, lines
73-79). Forward them into the `useCaddieLiveSession({...})` call (lines 234-239):
add `holeNumber, holePar, holeYards`. No new sheet prop, no RoundPageClient
change for the core fix — `<CaddieSheet holeNumber={currentHole} …>` already
passes them (RoundPageClient lines 2198-2200).

### 3.8 Defense-in-depth — thread current hole into the MINT (recommended, additive)
So the *initial* minted instructions and `get_conditions` default hole are also
correct (shrinks the window before the first anchor, and fixes the reconnect
mint). Strictly additive; the client anchor (3.4-3.5) remains the load-bearing
fix.
- Frontend `src/lib/voice/realtime.ts`: add optional `currentHole?: number` to
  `RealtimeCaddieOptions`; pass it in `startInner()`'s `startRealtimeSession({
  round_id, personality_id, current_hole: this.opts.currentHole })`.
- Frontend `src/lib/caddie/api.ts`: `startRealtimeSession` params gain optional
  `current_hole?: number` (line ~409).
- Frontend `src/hooks/useCaddieLiveSession.ts`: pass `currentHole: holeNumber`
  in BOTH `new RealtimeCaddieClient({...})` constructions (cold mint ~line 460,
  reconnect ~369) and resume (~413). Read from `holeContextRef.current` so the
  reconnect/resume mints carry the hole current AT THAT MOMENT.
- Backend `app/routes/realtime.py`: `StartRealtimeSessionRequest` gains
  `current_hole: int | None = None`; in `start_realtime_session`, when provided,
  set `session.current_hole = request.current_hole` **before**
  `build_realtime_instructions(...)` (in-memory is enough for the mint; do NOT
  add a DB write this cycle — keep it minimal and avoid clobbering a concurrent
  shot append).
- Warm-pool adoption is NOT covered by 3.8 (it mints at hole 1, before the hole
  is known) — that path is covered by the client anchor in 3.4. This is why 3.4
  is mandatory and 3.8 is defense only.

### 3.9 Opening-turn phrasing / distance audit (point 3 — DIAGNOSIS, minimal change)
Owner heard "I'm on the tee, about 231 yards to the pin" on a 178Y par 3.
- `buildOpeningTurnText` emits the "on the tee" phrasing **only** when
  `shot.fromTee === true`, which `resolveOpeningShotDistance`
  (`src/lib/caddie/opening-shot.ts`) sets **only** on the tee-fallback branch
  (GPS null/denied/timeout OR GPS distance implausible). So the branch selection
  and its label are **internally correct** — this is NOT a "GPS branch mislabeled
  as tee" bug. Do **not** change `opening-shot.ts` logic (its pinning test
  `opening-shot.test.ts` stays untouched).
- The 231 vs 178 gap = the **tee→green haversine for hole 3's OSM tee coord is
  ~231y** (a mislocated or back tee vs the 178 forward-tee card).
  **Course-data issue — NOTE only, do NOT fix course data this cycle** (per
  task). File as a follow-up: audit hole 3's ingested tee coordinate for
  Bethpage.
- Mitigation already delivered by this plan: the re-anchor item states
  "par 3, 178 yards on the card", so the model has the card number even when the
  from-tee opening distance is off, and `get_conditions`/`get_recommendation`
  return the real effective yards.
- Optional (cheap, silent) breadcrumb to confirm GPS-vs-tee on the owner's next
  round: emit a `voiceEvent("caddie","opening_shot",{ fromTee, distanceYards })`
  where the opening turn fires (telemetry already imported in the hook). Include
  only if it fits the bundle; not required for the fix.

### 3.10 Tile source-label legibility (point 4 — small, designer-adjacent)
File: `frontend/src/app/round/[id]/RoundPageClient.tsx`. The F/C/B source
caption (`fcbSource === "you" ? "● from where you stand" : "from the tee"`) is
rendered at lines ~1898-1910 inside the map card `data-overlay` block, and is
occluded by the floating Ask-caddie / Enter-score pill bar (`position:absolute;
bottom:0; zIndex:20`, lines ~2056-2145). The owner could not see WHY 231 ≠ 178.
Calmest fix within existing yardage patterns (no new component/library):
- **Move the source caption ABOVE the F/C/B tile row** — render it as a quiet
  right-aligned micro-label in/under the Wind/Elev/Plays stat divider
  (line ~1855), where the pill bar never reaches. Same `T.mono` 8.5px,
  `DEFAULT_ACCENT` when "from you" / `T.pencilSoft` when "from the tee". This
  guarantees it is always visible without fighting the pill bar's z-index.
  (Alternative if the designer prefers keeping it under the tiles: add
  `paddingBottom` to the map card / scroll area equal to the pill-bar height so
  the caption can clear the pills — but relocating above is calmer and simpler.)
- **PLAYS tile clarity** (lines ~1150-1160): the `sub` currently reads
  "adjusted"/"wind-adj"/"elev-adj"/"from tee" regardless of whether the base
  came from the live rangefinder or the tee. Tie the sub to `fcbSource`: when
  `fcbLive` drives `playsBase`, use "wind+elev from you" / "elev from you";
  otherwise keep "from tee". Keep wording ≤ the tile width; verify at 320px.
- Keep the change minimal — a designer reviews this seam separately
  (NORTHSTAR). No palette, type, or layout-system changes.

## 4. Files to touch (map)

Core fix (required):
- `frontend/src/lib/voice/realtime.ts` — add `sendContext()`; (3.8) optional
  `currentHole` in options + mint body.
- `frontend/src/lib/caddie/opening-turn.ts` — add `buildHoleContextText` +
  `HoleContext`.
- `frontend/src/hooks/useCaddieLiveSession.ts` — hole props + refs, `anchorHole`,
  connect-time anchor, hole-change effect, (3.8) currentHole in the 3 client
  constructions.
- `frontend/src/components/CaddieSheet.tsx` — forward `holeNumber/holePar/
  holeYards` into `useCaddieLiveSession`.

Defense-in-depth (recommended, additive):
- `frontend/src/lib/caddie/api.ts` — optional `current_hole` on
  `startRealtimeSession` params.
- `backend/app/routes/realtime.py` — optional `current_hole` on
  `StartRealtimeSessionRequest`; set `session.current_hole` before building
  instructions.

Point 4 (small UI):
- `frontend/src/app/round/[id]/RoundPageClient.tsx` — relocate F/C/B source
  caption; PLAYS sub clarity.

NOT touched: `app/caddie/voice_prompts.py` logic (the situation block is already
correct once `current_hole` is right), `useRealtimeCaddie.ts` (not the caddie
sheet's transport), `realtime_relay.py`, warm-session / ordering / idle
internals. No course-data edits.

## 5. Edge cases & races

- **Mint-hole == current-hole (no-op).** Connect anchors once and sets
  `anchoredHoleRef`; the hole-change effect then sees `holeNumber ===
  anchoredHoleRef` and does nothing. No redundant item, no double-refresh.
- **Rapid hole changes (3→4→5) while connected.** One `sendContext` per change
  (three items), each authoritative, last wins. The `anchoredHoleRef` guard
  prevents a second item for the *same* hole. Acceptable and correct.
- **Hole changes before `connected`.** `anchorHole()` early-returns
  (`!everConnectedRef`); `anchoredHoleRef` stays null; the eventual connect
  anchors the then-current hole read live from `holeContextRef`. Nothing queued.
- **Sheet reopened onto a new hole.** Fresh activation resets `anchoredHoleRef`
  to null; cold mint (3.8 carries the hole) + connect anchor set the right hole;
  opening turn (if `convHistory` empty) speaks it. Reopen onto an existing
  thread (`convHistory.length>0`) skips the opening turn but still anchors on
  connect.
- **Slice D reconnect / Slice E resume.** `openedTurnRef` already true → no
  re-greet (unchanged); the added connect-time `anchorHole()` silently re-anchors
  the fresh (possibly stale) server session. Order offset logic untouched.
- **Data channel not open when `sendContext` fires.** No-op guard; connect
  re-anchors. Never throws.
- **Warm-pool adoption** (`takeWarm` returns a client). It connects → the same
  connect-time anchor corrects hole 1 → current. This is the path 3.8 cannot fix,
  and the reason 3.4 is mandatory.
- **Fallback to classic (mic-deny / mint-timeout / double drop).** Classic path
  already threads `holeNumber` per `askCaddie` request — no staleness there;
  nothing to add.

## 6. Shared-type sync notes

- Core fix introduces **no** shared request/response shape change:
  `sendContext` and `buildHoleContextText` are internal; hole props are
  component-internal.
- (3.8 only) `StartRealtimeSessionRequest` gains `current_hole: int | None`
  (backend Pydantic) and `startRealtimeSession` params gain `current_hole?:
  number` (frontend `api.ts`). This request has no entry in the
  `frontend/src/lib/types.ts` ↔ `backend/app/models.py` shared surface (it lives
  in `routes/realtime.py` + `lib/caddie/api.ts`), so **no `types.ts`/`models.py`
  edit is required** — but keep the added field optional/back-compatible on both
  sides so existing callers (warm pool, setup) are unaffected.

## 7. Deterministic tests (extend at named seams; do NOT rewrite invariants)

Frontend `frontend/src/components/CaddieSheet.realtime.test.tsx` (add
`sendContext = vi.fn()` to `FakeRealtimeCaddieClient`, then EXTEND — the
existing warm-path / fallback / Slice D / Slice E cases stay byte-unchanged):
- **Opening turn carries the hole**: with `holeNumber:3, holePar:3,
  holeYards:178`, on `emitStatus("connected")` assert `sendContext` was called
  once with a string containing "hole 3", "par 3", "178" **before**
  `sendText(...)` (assert call order via mock invocation order); the existing
  `sendText` "I'm about 150 yards…" assertion is unchanged.
- **Hole-change refresh fires EXACTLY once per change**: after connected,
  rerender with `holeNumber:4` → `sendContext` called once with hole-4 text;
  rerender again with `holeNumber:4` (same) → NOT called again; rerender
  `holeNumber:5` → called once more. Assert total counts.
- **No double-refresh at connect**: mint at hole 3, connect → exactly one
  `sendContext` (the connect anchor); the hole-change effect does not add a
  second for the same hole.
- **Reconnect/resume re-anchors silently**: after a drop→reconnect (Slice D
  case) assert the second client's `sendContext` was called on its connect and
  its `sendText` was NOT (no re-greet — existing assertion) .

Frontend `frontend/src/lib/caddie/opening-shot.test.ts` — **UNTOUCHED** (branch
logic unchanged). If a `buildHoleContextText` unit test is wanted, add it in a
new `frontend/src/lib/caddie/opening-turn.test.ts` (or the nearest existing
opening-turn test file) — do not fold it into opening-shot.test.ts.

Backend `backend/tests/test_realtime_grounding.py` and
`backend/tests/test_realtime_tools.py` — **consume-only invariants; do not
rewrite.** They pass unchanged (3.8's `current_hole` is optional and defaults to
None, so `test_in_round_mint_uses_persona_voice_and_default_tools`'s
session-built `current_hole=12` still yields "Current hole: #12"). If 3.8 is
implemented, ADD one case to `test_realtime_tools.py`: a request WITH
`current_hole=3` against a session whose stored `current_hole=1` produces
"Current hole: #3" in the minted instructions.

## 8. Exact gates (all must pass before ready)

Frontend (local, CI gates):
```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && npx vitest run src/components/CaddieSheet.realtime.test.tsx \
                              src/lib/caddie/opening-shot.test.ts \
                              src/lib/caddie/opening-turn.test.ts
```
(Also run the untouched classic suites — `CaddieSheet.handsfree.test.tsx`,
`CaddieSheet.session.test.tsx` — to prove the flag-off world is unchanged.)

Backend:
```
cd backend && ruff check .
```
Named backend tests (`test_realtime_grounding.py`, `test_realtime_tools.py`) are
**DB-backed / run in CI only** — there is NO local Postgres. Do not spin one up;
rely on CI for the DB-backed asserts. The pure-instruction asserts in those
files import without a DB (they set `LOOPER_SECRETS_DISABLED`), but leave
execution to CI per house rule.

Manual/observed (for the `role:"system"` verification in §2): during
`voice-tests --smoke` or a device check, watch the data channel `error` event —
if a system-role `conversation.item.create` is rejected, switch to the
`role:"user"` "[Course update]" fallback and re-run.

## 9. NORTHSTAR alignment

- **Voice-first / calm.** The hole refresh is SILENT (no `response.create`) — the
  caddie never spontaneously chatters on a hole change; it simply stops being
  wrong the next time asked. The opening turn stays a single natural spoken line.
- **Yardage-book, quiet UI.** The only visible change is making the F/C/B source
  label legible and the PLAYS sub honest — same tokens, no new chrome; designer
  reviews the seam.
- **Honest, no fabrication.** The re-anchor states card facts the client owns and
  routes specifics through the existing tools + the hazard/one-brain rules; no
  invented yardages. Course-data tee mislocation is flagged, not faked.
- **Noticeable bundle.** The caddie visibly stops answering the wrong hole — a
  real, owner-facing fix worth an approval bundle.
