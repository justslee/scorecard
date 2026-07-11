# S2 — Context contract + tee-time through it (omnipresent-caddie-orb, "the wow")

Parent epic: `specs/omnipresent-caddie-orb-plan.md` §3 (crux), §3.1 (contract), §3.3 (sheet host), §4 (tee-time spec), §6 (S2), §7 (risks), §9 (gates).

**The slice:** speak tee-time preferences to the omnipresent orb and the caddie dispatches the
search. Built as a *generic* page-context contract + a single generic sheet host, with tee-time as
the first `task` registration and today's general Looper as the `converse` floor.

**Scope fence (hard):**
- FRONTEND-ONLY. `backend/` is untouched.
- `parseTeeTimePrefs.ts`, `lib/teetime/voice-prefs.ts` (`applyParsedWindows`/`applyParsedCourses`/
  `applyPartySize`/`teeTimeAckLine`), every parser, and every existing voice test: **zero edits**.
  Voice-smoke stays green *by construction* (nothing it imports changes).
- `lib/looper-bus.ts` (incl. `looperContextForPath`): **zero edits** — it is preserved as the
  summon transport floor. The registry rides above it; the bus union does NOT grow in S2.
- S1 artifacts unchanged in behavior: `CaddieOrb` pointer semantics, `shouldShowCaddieOrb`,
  the round-page pill. (One additive, orb-internal edit: a `confirming` pulse subscription — §6.)
- Wire ONLY: contract + host + general + tee-time. Tournament (S3), round-setup (S3),
  My Card (S4) get *union slots*, not wiring.

---

## 0. Verified current state (anchors)

| Thing | Where | Fact that matters |
|---|---|---|
| Bus | `frontend/src/lib/looper-bus.ts` | `LooperContext = "general"\|"tee-time"\|"courses"`; `openLooper`/`onLooperOpen` CustomEvent; `looperContextForPath` route map. Unit-tested (`looper-bus.test.ts`). |
| Orb (S1) | `frontend/src/components/CaddieOrb.tsx` | Fires `openLooper({context: looperContextForPath(pathname), listening})` on tap/hold. No visual states yet. Sheet (z 60/61) covers the orb (z 50) while open. |
| General sheet | `frontend/src/components/LooperSheet.tsx` | `LooperSheetShell` (named export; shell owns TTS + body-scroll lock) + default export = the general converse brain: reset-on-open, 60ms-delayed listening start, `openGenRef` staleness gen, history from `turnsRef` (excludes the utterance being sent), 2-tier ladder `talkToCaddieStream` → `BeforeFirstByteError` → `talkToCaddie` (hole_number null), `useStreamBuffer` → `streamingTurn`, phase suppresses "thinking" while streaming. |
| Tee-time private host | `frontend/src/app/tee-time/page.tsx` | `Prefs` renders ONLY in `phase === "prefs"` (page.tsx:254-275) → mount/unmount there is naturally prefs-scoped. Private hosting ≈ lines 388-506 + 568-580 (detail in §7). |
| Parser | `frontend/src/lib/voice/parseTeeTimePrefs.ts` | `parseTeeTimePrefsLocally` confidence: `0.2` when signals===0, else `min(0.95, 0.55 + 0.1*signals)` → **any signal ⇒ ≥0.65**. `parseTeeTimePrefs` runs the LLM pass only when `options.llm.anthropicApiKey` is provided — the page never provides it (page.tsx:495-498), so in the shipped app confidence is always 0.2 (no signal) or ≥0.65 (signal). |
| Apply libs | `frontend/src/lib/teetime/voice-prefs.ts` | Pure; `applyParsedCourses` signals a total course-name miss by returning the input array `===`. |
| Dictation | `frontend/src/hooks/useLooperDictation.ts` | Options read via `optionsRef` **at event time** → `surface`/`getKeyterms` may be lane-dependent without re-instantiating the hook. `onUtteranceEnd` fires ≤1×/session. |
| Layout | `frontend/src/app/layout.tsx` | Mounts `<FloatingTabBar />` `<CaddieOrb />` `<LooperSheet />` (lines 65-67). |
| Legacy courses consumer | `frontend/src/app/courses/page.tsx:33-39` | Listens for bus `context === "courses"` and opens its own voice course search (a proto-"surface"). NOT migrated in S2 — the host must not steal its summons. |
| Voice gate | `frontend/voice-tests/runner.ts:58-59` | Tee-time lane exercises `parseTeeTimePrefs` local heuristics only. |
| Haptics | `frontend/src/lib/haptics.ts` | `'warning'` and `'success'` patterns exist. |

---

## 1. New file list + exact edits to existing files

**New files**
1. `frontend/src/lib/caddie-context.ts` — pure registry + orb-state channel (no React, no window).
2. `frontend/src/lib/caddie-context.test.ts` — vitest (node env; no DOM needed).
3. `frontend/src/hooks/useCaddiePageContext.ts` — register-on-mount hook (ref-delegating wrapper).
4. `frontend/src/components/CaddieOrbSheet.tsx` — the generic host (task/converse/surface lanes).
5. `frontend/src/components/CaddieOrbSheet.test.tsx` — vitest jsdom + @testing-library/react.
6. `frontend/src/lib/teetime/caddie-task.ts` — pure tee-time↔contract glue: `teeTimeTaskParse`,
   `planTeeTimeApply`, `teeTimeConfirmEcho`.
7. `frontend/src/lib/teetime/caddie-task.test.ts` — vitest.

**Edited files**
- `frontend/src/app/layout.tsx` — line 6: `import LooperSheet from "@/components/LooperSheet"` →
  `import CaddieOrbSheet from "@/components/CaddieOrbSheet"`; line 67: `<LooperSheet />` →
  `<CaddieOrbSheet />`. Nothing else.
- `frontend/src/components/LooperSheet.tsx` — DELETE the default export (lines ~440-600, the whole
  "general context" section incl. its section comment) and the now-shell-unused imports
  (`useCallback`, `useLooperDictation`, `buildKeyterms`, `talkToCaddie`/`talkToCaddieStream`/
  `BeforeFirstByteError`, `useStreamBuffer`, `onLooperOpen`). KEEP `LooperSheetShell`,
  `LooperTurn`, `LooperPhase`, `SpeakerIcon` and all shell behavior byte-identical (TTS watermark,
  scroll lock, mic button). Update the header comment (the shell is now hosted only by
  `CaddieOrbSheet`; round-page `CaddieSheet` remains separate).
- `frontend/src/app/tee-time/page.tsx` — the ~120-line private-hosting deletion + contract
  registration; exact ranges in §7.
- `frontend/src/components/CaddieOrb.tsx` — additive only: subscribe `onCaddieOrbState`, play a
  one-shot success pulse on `"confirming"` (§6). No pointer/placement/visibility changes.
- `frontend/src/components/CaddieOrb.test.tsx` — add one test: confirming pulse subscription
  (existing assertions untouched).

**Deliberately untouched:** `looper-bus.ts` (+ test), `parseTeeTimePrefs.ts` (+ test),
`voice-prefs.ts` (+ test), `voice-tests/**`, `shouldShowCaddieOrb.ts`, `FloatingTabBar.tsx`,
`app/courses/page.tsx`, `useLooperDictation.ts`, `useSheetTTS.ts`, all round-page code.

---

## 2. The contract — `frontend/src/lib/caddie-context.ts` (full TypeScript)

```ts
// The caddie page-context registry (specs/omnipresent-caddie-orb-plan.md §3.1, slice S2).
//
// Pages declare WHAT the caddie can do for them here; the orb + the generic
// sheet host (CaddieOrbSheet) read the active context. Module-level slot +
// tiny subscription, in the spirit of looper-bus: no provider threading, no
// re-render of pages that don't care. Pure — no window, no React — so it is
// unit-testable and SSR-inert.

/** Gate under which a signalled task parse is confirmed, never auto-applied. */
export const TASK_CONFIDENCE_FLOOR = 0.6;

// Ids are the full epic roster (S3/S4 slot in WITHOUT touching this union's
// shape — they only start registering). S2 registers ONLY "tee-time".
export type CaddieTaskId = "tee-time" | "tournament-setup";
export type CaddieSurfaceId = "round-setup" | "courses";
export type CaddieConverseId = "my-card";

/** What a task-page's parser understood from one utterance. */
export interface TaskParse {
  /** The transcript that was parsed (echoed for tests/telemetry). */
  transcript: string;
  /** Did the page's parser recognize ANYTHING actionable? false → the host
   *  falls through to conversation; apply() is never called. */
  hasSignal: boolean;
  /** Parser confidence 0..1. hasSignal && confidence < TASK_CONFIDENCE_FLOOR
   *  → the host renders a confirm line and does NOT apply/dispatch. */
  confidence: number;
  /** Neutral echo of what was understood ("Saturday morning at Presidio,
   *  party of 4") — used ONLY in the low-confidence confirm line, so it must
   *  never promise action ("on it"). */
  ack: string;
  /** Page-owned parse result, handed back to apply() opaquely. The host
   *  never inspects it — this is what makes cross-page leakage structural
   *  nonsense (§8). */
  payload: unknown;
}

/** What apply() did — the honest ack the host renders + speaks. */
export interface TaskAck {
  /** One calm line: what landed, what didn't ("kept your picks"), and
   *  whether the caddie is going ("— on it."). Never fabricates success. */
  line: string;
  /** true → the PAGE armed its own dispatch (tee-time: the same 1400ms
   *  setTimeout(onDispatch) beat the tap flow uses). The host only plays the
   *  confirming beat (haptic + orb pulse); it owns no dispatch machinery. */
  dispatched: boolean;
}

export interface CaddieTaskContext {
  id: CaddieTaskId;
  kind: "task";
  copy: {
    title: string;   // sheet title while this task is active
    hint: string;    // empty-state hint
    /** Gentle post-conversation nudge for the fall-through case
     *  ("Want me to set that search up?"). */
    nudge: string;
  };
  /** STT vocabulary bias, resolved fresh at dictation start. */
  getKeyterms?: () => readonly string[];
  /** Wraps the page's OWN deterministic parser — and only it. */
  parse: (transcript: string) => Promise<TaskParse>;
  /** Merge into page state via the page's setters; return the honest ack.
   *  Called ONLY when hasSignal && confidence >= TASK_CONFIDENCE_FLOOR. */
  apply: (parse: TaskParse) => TaskAck;
}

export interface CaddieSurfaceContext {
  id: CaddieSurfaceId;
  kind: "surface";
  /** The page opens its own voice surface; the host opens NO sheet. */
  summon: (listening: boolean) => void;
}

export interface CaddieConverseContext {
  id: CaddieConverseId;
  kind: "converse";
  copy: { title: string; hint: string };
  /** Real grounding block or null (honest-empty). S2 wires the lane but no
   *  converse context registers; S4 (My Card) is the first consumer. */
  getGrounding: () => string | null;
}

export type CaddiePageContext =
  | CaddieTaskContext
  | CaddieSurfaceContext
  | CaddieConverseContext;

// ── Registry (exclusive, last-writer-wins) ──────────────────────────────────

let active: CaddiePageContext | null = null;
const listeners = new Set<(ctx: CaddiePageContext | null) => void>();

function notify(): void {
  for (const cb of listeners) cb(active);
}

/**
 * Register a page context. EXCLUSIVE: the newest registration wins.
 * Returns the unregister fn. Unregistering a registration that has since
 * been superseded is a no-op (it must not clobber the newer writer) —
 * identity is the ctx object itself.
 */
export function registerCaddieContext(ctx: CaddiePageContext): () => void {
  active = ctx;
  notify();
  return () => {
    if (active === ctx) {
      active = null;
      notify();
    }
  };
}

/** The active page context — null means: fall back to the general converse. */
export function getCaddieContext(): CaddiePageContext | null {
  return active;
}

/** Subscribe to registry changes. Returns the unsubscribe. */
export function onCaddieContextChange(
  cb: (ctx: CaddiePageContext | null) => void,
): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ── Orb state channel (host → orb, one-way) ─────────────────────────────────
// S2 consumes only "confirming" (the success beat after a task dispatch).
// "listening"/"thinking" are in the type so S5 motion work slots in without
// a contract change, but nothing sets them yet.

export type CaddieOrbState = "idle" | "listening" | "thinking" | "confirming";

let orbState: CaddieOrbState = "idle";
const orbListeners = new Set<(s: CaddieOrbState) => void>();

export function setCaddieOrbState(s: CaddieOrbState): void {
  if (s === orbState) return;
  orbState = s;
  for (const cb of orbListeners) cb(s);
}

export function getCaddieOrbState(): CaddieOrbState {
  return orbState;
}

export function onCaddieOrbState(cb: (s: CaddieOrbState) => void): () => void {
  orbListeners.add(cb);
  return () => orbListeners.delete(cb);
}
```

Notes an adversarial reviewer will ask about:
- **Why object-identity tokens, not ids?** Two mounts of the same page (StrictMode double-mount,
  fast route bounce) must not have mount A's cleanup clear mount B's registration. Object identity
  gives each `registerCaddieContext` call its own token for free.
- **Why not a stack?** Page registrations are route-scoped and at most one page is mounted; a
  stack would encode a nesting that cannot occur and would resurrect stale contexts on pop.
  Last-writer-wins + stale-unregister-no-op is the whole truth.
- **SSR:** no `window`, module state only — importable from tests and server bundles inert.

---

## 3. The hook — `frontend/src/hooks/useCaddiePageContext.ts`

**The thrash problem:** the page rebuilds its context object every render (its `parse`/`apply`/
`getKeyterms` MUST close over current state — `courses`, `windows`, `group`). Registering that
fresh object each render would fire `onCaddieContextChange` every keystroke → host re-renders,
and worse, a sheet-open-session's "did my context unregister?" check would see churn.

**Solution:** register ONCE per mount a *stable delegating wrapper*; keep the latest page context
in a ref the wrapper reads through. The registry sees one registration per mount; the methods
always see fresh page state.

```ts
"use client";

import { useEffect, useRef } from "react";
import {
  registerCaddieContext,
  type CaddiePageContext,
  type CaddieTaskContext,
  type CaddieConverseContext,
  type CaddieSurfaceContext,
} from "@/lib/caddie-context";

/**
 * Register this page's caddie context for as long as the calling component is
 * mounted. Mount → register (last-writer-wins), unmount → unregister.
 * The ctx object may be rebuilt every render — a stable wrapper is registered
 * once and delegates through a ref, so the registry never sees render thrash.
 */
export function useCaddiePageContext(ctx: CaddiePageContext): void {
  const ref = useRef(ctx);
  ref.current = ctx;
  const { id, kind } = ctx; // fixed for a mounted page component
  useEffect(() => {
    return registerCaddieContext(makeDelegate(kind, () => ref.current));
    // id/kind can't change without the page component remounting; if they
    // somehow do, re-register cleanly.
  }, [id, kind]);
}

function makeDelegate(
  kind: CaddiePageContext["kind"],
  get: () => CaddiePageContext,
): CaddiePageContext {
  if (kind === "task") {
    const t = () => get() as CaddieTaskContext;
    return {
      id: t().id,
      kind: "task",
      get copy() { return t().copy; },
      getKeyterms: () => t().getKeyterms?.() ?? [],
      parse: (transcript) => t().parse(transcript),
      apply: (p) => t().apply(p),
    };
  }
  if (kind === "surface") {
    const s = () => get() as CaddieSurfaceContext;
    return { id: s().id, kind: "surface", summon: (l) => s().summon(l) };
  }
  const c = () => get() as CaddieConverseContext;
  return {
    id: c().id,
    kind: "converse",
    get copy() { return c().copy; },
    getGrounding: () => c().getGrounding(),
  };
}
```

React 18 StrictMode dev double-invoke (mount→cleanup→mount) is safe: second register wins, first
cleanup is a stale-token no-op, final cleanup on real unmount clears. (Covered by a test in §9.)

---

## 4. The host — `frontend/src/components/CaddieOrbSheet.tsx`

Mounted once in `app/layout.tsx` (replacing `<LooperSheet />`). Wraps `LooperSheetShell`. Owns:
the summon subscription, one `useLooperDictation` instance, the turn log, the converse machinery
(moved verbatim from today's `LooperSheet` default), and the task gates.

### 4.1 State

```
open: boolean
boundId: CaddieTaskId | null        // task ctx id the OPEN session is bound to; null = general lane
turns: LooperTurn[]; turnsRef       // mirrors LooperSheet's turnsRef pattern
thinking: boolean; error: string | null
streamingText: string | null; streamAbortRef; answerBuffer (useStreamBuffer)
sessionRef: number                  // staleness gen — the old openGenRef, generalized
micTapRef                           // onUtteranceEnd → same path as tapping the mic
dictation = useLooperDictation({
  surface: boundId ?? "looper-general",          // preserves today's telemetry labels exactly
  getKeyterms: () => boundTaskCtx?.getKeyterms?.() ?? buildKeyterms(),
  onUtteranceEnd: () => micTapRef.current(),
})                                   // options are read via ref at event time — lane-safe
```

`boundTaskCtx` is looked up from the registry by `boundId` at use time (`getCaddieContext()`,
checked `id === boundId`), never stored as a component-state copy — one source of truth.

### 4.2 Summon routing (the lane switch)

```
useEffect(() => onLooperOpen((detail) => {
  const ctx = getCaddieContext();

  // 1) SURFACE — no sheet at all: the page owns its own voice surface.
  if (ctx?.kind === "surface") { ctx.summon(detail.listening); return; }

  // 2) LEGACY floor — the courses hub still consumes its own bus summons
  //    (app/courses/page.tsx:33). Until S3 migrates it to a "courses"
  //    surface registration, the host must not double-handle it.
  if (!ctx && detail.context === "courses") return;

  // 3) TASK or CONVERSE or GENERAL — open the sheet, bound to the context.
  setBoundId(ctx?.kind === "task" ? ctx.id : null);
  setOpen((wasOpen) => {
    if (!wasOpen) resetSession();     // sessionRef++, turns=[], thinking=false,
    return true;                      // error=null, abort stream, buffer.cancel,
  });                                 // streamingText=null  (verbatim from LooperSheet)
  if (detail.listening) setTimeout(() => void dictationRef.current.start(), 60);
}), []);
```

Why "registry wins, bus context is only a legacy floor": the bus keeps carrying WHERE the summon
came from (`looperContextForPath`), but the registry carries WHAT the caddie can do. On
`/tee-time` in the searching/options/confirmed phases, `Prefs` is unmounted → registry empty →
a bus `"tee-time"` summon lands in the general converse, exactly per epic §4. No bus change, no
`LooperContext` union growth in S2 (S3 pages like `/tournament/new` map to bus `"general"`
already — the registry overrides, so the union never needs those ids).

### 4.3 Mic handler — lanes + gates (precise pseudocode)

```
handleMicTap():
  setError(null)
  if (!dictation.listening): await dictation.start(); return

  gen = sessionRef.current
  setThinking(true)
  heard = await dictation.stopAndResolve()
  if (stale(gen)) return                       // sheet closed/reopened meanwhile
  if (!heard):
    setThinking(false)
    setError(boundTask ? "Didn't catch that — tap the mic and tell me when and where."
                       : "No speech detected. Tap the mic to try again.")
    return

  historyBase = turnsRef.current               // SNAPSHOT BEFORE appending — see note (a)
  appendTurn({ role: "user", text: heard })

  ctx = boundTaskCtx()                          // registry lookup by boundId
  if (ctx):                                     // ── TASK LANE ──
    try:
      parse = await ctx.parse(heard)
    catch:
      if (!stale(gen)) { setThinking(false)
        setError("Lost that one — mind saying it again? Or fill it in below.") }
      return
    if (stale(gen)) return

    if (!parse.hasSignal):                      // GATE (a): FALL THROUGH → converse
      await runConverse(gen, heard, historyBase, { nudge: ctx.copy.nudge })
      return

    if (parse.confidence < TASK_CONFIDENCE_FLOOR):   // GATE (b): confirm, don't act
      appendTurn({ role: "looper",
        text: `Here's what I got — ${parse.ack}. Say it again to correct, or edit below.` })
      haptic("warning")                         // epic §5: warning once, no dispatch
      setThinking(false)
      return

    ack = ctx.apply(parse)                      // GATE (c): merge + honest ack
    appendTurn({ role: "looper", text: ack.line })
    if (ack.dispatched):                        // the PAGE armed its own 1400ms beat;
      haptic("success")                         // the host only plays the beat
      setCaddieOrbState("confirming")
      setTimeout(() => setCaddieOrbState("idle"), 900)
    setThinking(false)
    return

  // ── CONVERSE LANE (general in S2; my-card in S4) ──
  await runConverse(gen, heard, historyBase)
```

Notes:
- **(a) `historyBase` snapshot.** Today's `LooperSheet` builds `conversation_history` from
  `turnsRef.current` immediately after `setTurns` — the ref updates in an effect, so the history
  excludes the utterance being sent (it travels as `transcript`). In the task fall-through, the
  `await ctx.parse()` between append and converse may let a render flush the ref, which would
  DUPLICATE the utterance (once in history, once as transcript). Snapshotting `historyBase`
  before the append and passing it into `runConverse` preserves the old semantics in both lanes.
- **Confidence gate is inert for today's deterministic parses — argued, not hoped:** the local
  parser yields ≥0.65 whenever any signal exists (0.55 + 0.1·signals), and the page never passes
  an LLM key, so a tee-time parse is either no-signal (0.2 → fall-through) or ≥0.65 (→ apply).
  Gate (b) therefore changes nothing about today's tee-time behavior; it exists for
  LLM-assisted parses (S3 tournament) and is unit-tested with a synthetic context (§9).
- **`parse.ack` never promises action** — contract doc + `teeTimeConfirmEcho` (§7.2) enforce it.

### 4.4 The shared converse flow — factored ONCE

`runConverse` is a single function inside the host, closing over the session refs. Both callers —
the general lane and the task fall-through — go through it; there is no second copy of the
ladder anywhere (the one in `LooperSheet`'s default export is deleted in the same commit).

```
runConverse(gen, finalText, historyBase, opts?: { nudge?: string }):
  streamAbortRef.current?.abort()
  controller = new AbortController(); streamAbortRef.current = controller
  answerBuffer.cancel(); setStreamingText(null)
  isStale = () => sessionRef.current !== gen || streamAbortRef.current !== controller

  try:
    history = historyBase.map(role looper→assistant, user→user)   // verbatim mapping
    // 2-tier ladder — stream first; fall to stateless JSON only on a
    // pre-first-byte failure (BeforeFirstByteError). Verbatim from LooperSheet.
    try:
      responseText = await talkToCaddieStream(
        { transcript: finalText, personality_id: "classic", hole_number: null,
          conversation_history: history },
        { onToken: (d) => answerBuffer.push(d), signal: controller.signal })
    catch (err):
      if (!(err instanceof BeforeFirstByteError)) throw err
      answerBuffer.cancel(); setStreamingText(null)
      responseText = (await talkToCaddie({ transcript: finalText,
        personality_id: "classic", hole_number: null,
        conversation_history: history })).response

    if (isStale()) return
    answerBuffer.flush(); setStreamingText(null)
    // Fall-through nudge rides in the SAME looper turn (paragraph break):
    // one turn → the shell's speak-newest-turn TTS watcher speaks answer+nudge
    // together; two turns would skip the answer (the watermark jumps to the
    // last appended index in a single render).
    text = opts?.nudge ? `${responseText}\n\n${opts.nudge}` : responseText
    appendTurn({ role: "looper", text })
  catch:
    if (!isStale()):
      answerBuffer.cancel(); setStreamingText(null)
      setError("Looper couldn't answer that one. Try again.")
  finally:
    if (!isStale()) setThinking(false)
```

Grounding: `CaddieConverseContext.getGrounding` exists in the union but **the host does not
consume it in S2** — there is no backend field to carry it (that is S4's `stats_context`, both
sides). Wiring it now would either send an unknown field or fake grounding. Documented inline.

### 4.5 Close + context-unmount hygiene

```
close():
  sessionRef.current++
  dictation.cancel()
  streamAbortRef.current?.abort(); streamAbortRef.current = null
  answerBuffer.cancel(); setStreamingText(null)
  setOpen(false); setThinking(false); setError(null); setBoundId(null)

useEffect(() => onCaddieContextChange((ctx) => {
  // The sheet's task session is bound to a registration. If that page
  // unmounts (tee-time: the 1400ms beat fired onDispatch → phase "searching"
  // → Prefs unmounted → unregister), the parse/apply closures are dead —
  // close the whole lane cleanly rather than talk to a ghost.
  if (openRef.current && boundIdRef.current !== null && ctx?.id !== boundIdRef.current) close();
}), []);
```

This reproduces (and improves) today's behavior: the old tee-time shell vanished with `Prefs`'s
unmount; the host now plays the shell's exit animation instead. The page's dispatch timer is NOT
touched by `close()` — closing the sheet during the 1400ms beat does not cancel a dispatch the
ack already promised ("— on it."), matching today exactly.

### 4.6 Render

```
phase = dictation.listening ? "listening"
      : thinking && streamingText == null ? "thinking" : "idle"     // verbatim

<LooperSheetShell
  open={open} onClose={close}
  title={boundTaskCtx()?.copy.title ?? "What can I do for you?"}
  emptyHint={boundTaskCtx()?.copy.hint ?? "Tee times, courses, your game — ask me anything."}
  turns={turns} phase={phase} interim={dictation.interim}
  error={error ?? dictation.micError}
  onMicTap={() => void handleMicTap()}
  streamingTurn={streamingText}
/>
```

A fall-through keeps the task title for the session (the sheet was summoned on that page);
`boundId` only resets on close/summon.

---

## 5. General migration — byte-behavior parity checklist

Decision (per epic §3.3): **`CaddieOrbSheet` subsumes the default `LooperSheet` export.** The
default export is deleted; the shell stays. Only importer of the default is `layout.tsx` (grep-
verified); only importers of the shell are tee-time (deleted here) and the new host.

The general path must be indistinguishable. Parity items, each traceable to `LooperSheet.tsx`:

| Behavior | Source lines | Host reproduction |
|---|---|---|
| Reset only on closed→open transition | 478-489 | `setOpen(wasOpen => …)` in summon routing |
| 60ms-delayed `dictation.start()` on listening summon | 491-493 | identical |
| Staleness gen guards every await | 465, 516-533 | `sessionRef` + `isStale` |
| History from `turnsRef` (excludes in-flight utterance) | 536-539 | `historyBase` snapshot (§4.3a) |
| Stream ladder + `BeforeFirstByteError`-only fallback, `hole_number: null` | 544-561 | verbatim in `runConverse` |
| `streamingTurn` render + commit-full-text-once | 452-456, 563-566 | verbatim |
| Error copy strings | 522, 571 | verbatim |
| Phase suppresses thinking while streaming | 583-584 | verbatim |
| Auto-send on utterance end | 459-464 | `micTapRef` |
| Keyterms `buildKeyterms()` | 462 | general-lane branch of `getKeyterms` |
| Telemetry surface `"looper-general"` | 461 | `surface: boundId ?? "looper-general"` |
| TTS, scroll lock, mic gesture unlock | shell-owned | shell untouched |
| Title/hint copy | 590-591 | host defaults |

The only intentional non-parity anywhere in S2 (task lane, not general): (i) tee-time turns now
reset per sheet-open instead of persisting page-lifetime `voiceLines` (the `.slice(-4)` cap was an
artifact of that persistence; a session-scoped log stays short by construction), and (ii) the
"didn't catch that" line renders in the shell's error slot rather than as a looper turn — same
words, same italic treatment. Both called out for the designer review.

---

## 6. Orb confirming beat — minimal `CaddieOrb.tsx` edit

The sheet covers the orb while open (z 61 vs 50), so the confirming beat is primarily haptic
(`haptic("success")`, fired by the host at ack time) — and the orb pulse lands visibly as the
sheet slides away during the 1400ms beat / phase change. Additive edit only:

```ts
// inside CaddieOrb():
const [confirming, setConfirming] = useState(false);
useEffect(() => onCaddieOrbState((s) => setConfirming(s === "confirming")), []);
// motion.button animate: { scale: confirming ? [1, 1.12, 1] : 1, opacity: 1 }
// transition: confirming ? { duration: 0.5, ease: "easeOut" } : T.springSoft
```

No pointer, placement, `shouldShowCaddieOrb`, or aria changes. "listening"/"thinking" orb visuals
remain S5 (nothing sets those states yet).

---

## 7. Tee-time migration through the contract

### 7.1 Deletions in `frontend/src/app/tee-time/page.tsx` (line numbers as of HEAD)

| Lines | What | Action |
|---|---|---|
| 52 | `import { LooperSheetShell } from "@/components/LooperSheet"` | DELETE |
| 53 | `import { useLooperDictation } …` | DELETE |
| 54 | `import { onLooperOpen } …` | DELETE |
| 55 | `import { buildKeyterms } …` | KEEP (used by `getKeyterms`) |
| 388-394 | voice comment + `voiceLines` state | DELETE (host renders turns) |
| 395-399 | `dispatchTimerRef` + unmount-cleanup effect | KEEP (apply arms it) |
| 401-404 | `say` | DELETE (acks return through `TaskAck.line`) |
| 406-448 | `applyParsed` | REPLACE with contract `apply` (below); the no-signal branch (407-411) MOVES OUT to the host's fall-through |
| 450-471 | sheet-host state: `looperOpen`, `looperThinking`, `looperMicRef`, `dictation`, `dictationRef`, `onLooperOpen` effect | DELETE |
| 473-477 | `closeLooper` | DELETE |
| 479-506 | `handleLooperMic` + `looperMicRef.current` assignment | DELETE |
| 568-580 | comment + `<LooperSheetShell …/>` JSX | DELETE |

Net: ~120 lines of private hosting out; ~30 lines of contract registration in. `Prefs`'s props
are unchanged (`onDispatch`, setters, `coursesTouchedRef` all still used).

**Prefs-phase scoping — confirmed:** `TeeTimePage` renders `<Prefs>` only when
`phase === "prefs"` (page.tsx:254-275); searching/options/confirmed return other components. So
`useCaddiePageContext` inside `Prefs` registers exactly for the prefs phase and unregisters the
instant a dispatch (voice or tap) moves the phase on — no phase plumbing, the component tree IS
the scope. Post-dispatch, orb summons on `/tee-time` fall to general (epic §4, exactly).

### 7.2 New pure glue — `frontend/src/lib/teetime/caddie-task.ts` (tested)

Keeps the page thin and makes "identical asks" assertable offline. Imports ONLY the untouched
libs (`voice-prefs.ts`, `parseTeeTimePrefs.ts` types/`hasTeeTimeSignal`).

```ts
/** parsed → the contract's TaskParse. Pure. */
export function teeTimeTaskParse(
  transcript: string,
  parsed: TeeTimePrefsParseResultValidated,
): TaskParse {
  return {
    transcript,
    hasSignal: hasTeeTimeSignal(parsed),
    confidence: parsed.confidence,
    ack: teeTimeConfirmEcho(parsed),
    payload: parsed,
  };
}

/**
 * Neutral echo for the low-confidence confirm line — teeTimeAckLine's summary
 * with its action framing removed ("— on it." / "Got it — ") so a line that
 * did NOT act never claims it did. Derived, not duplicated: teeTimeAckLine
 * stays the single formatter; format-locking tests below break loudly if its
 * two shapes ever change. (Unreachable for today's tee-time parses — any
 * local signal ⇒ confidence ≥0.65 and the page passes no LLM key — but the
 * contract field must be honest under S3+ LLM parsers.)
 */
export function teeTimeConfirmEcho(parsed: TeeTimePrefsParseResultValidated): string {
  const line = teeTimeAckLine(parsed);
  if (!line) return "not much, honestly";
  return line.replace(/\s*—\s*on it\.$/, "").replace(/^Got it — /, "").replace(/\.$/, "");
}

/** Everything applyParsed COMPUTED, minus the setters and the timer. Pure.
 *  null = leave that pref untouched. Body is today's page.tsx:413-446 verbatim,
 *  ordering preserved: windows → courses (+miss note, + radius widening) →
 *  explicit maxDistanceMiles (wins over widening, as the last setState did) →
 *  party → price → line → dispatched. */
export interface TeeTimeApplyPlan {
  windows: VoicePrefWindow[] | null;
  courses: CourseOption[] | null;      // null on total course-name miss (=== sentinel respected)
  maxMiles: number | null;
  group: VoicePrefMember[] | null;
  maxPriceUsd: number | null;
  line: string;                        // courseMissNote ?? teeTimeAckLine(parsed) ?? "Got it."
  dispatched: boolean;                 // parsed.windows.length > 0 || parsed.dispatch
}
export function planTeeTimeApply(
  parsed: TeeTimePrefsParseResultValidated,
  current: { windows: VoicePrefWindow[]; courses: CourseOption[]; maxMiles: number; group: VoicePrefMember[] },
): TeeTimeApplyPlan
```

Behavior-preservation details an adversary will probe:
- **Course-miss honesty:** `applyParsedCourses` returns the input `===` on a total miss →
  `plan.courses = null` + `line = "Couldn't find … — kept your picks."` (verbatim copy, incl. the
  fact that a miss note REPLACES the ack line, exactly as today's `courseMissNote ?? …`).
- **Radius widening:** farthest selected course distance > maxMiles → widen to
  `min(50, ceil(farthest))`; explicit spoken distance then overrides (today: two `setMaxMiles`
  calls, last wins → here: `explicit ?? widened ?? null`). Same final state.
- **`dispatched` predicate** is byte-identical to page.tsx:445.
- `coursesTouchedRef` is NOT set by the voice path today; the plan keeps it that way.

### 7.3 Registration inside `Prefs` (replaces all deleted hosting)

```tsx
const apply = (p: TaskParse): TaskAck => {
  const parsed = p.payload as TeeTimePrefsParseResultValidated;
  const plan = planTeeTimeApply(parsed, { windows, courses, maxMiles, group });
  if (plan.windows) setWindows(plan.windows);
  if (plan.courses) setCourses(plan.courses);
  if (plan.maxMiles != null) setMaxMiles(plan.maxMiles);
  if (plan.group) setGroup(plan.group);
  if (plan.maxPriceUsd != null) setMaxPriceUsd(plan.maxPriceUsd);
  if (plan.dispatched) {
    if (dispatchTimerRef.current) clearTimeout(dispatchTimerRef.current);
    dispatchTimerRef.current = setTimeout(onDispatch, 1400);   // the SAME structured-asks
  }                                                            // dispatch the tap flow uses:
  return { line: plan.line, dispatched: plan.dispatched };     // onDispatch → phase "searching"
};                                                             // → buildTeeTimeQueries → asks

useCaddiePageContext({
  id: "tee-time",
  kind: "task",
  copy: {
    title: "Where are we playing?",                                        // old shell title
    hint: "What do you have in mind for this weekend? I'll rustle one up.", // old voiceLines[0]
    nudge: "Want me to set that tee-time search up? Just say when and where.",
  },
  getKeyterms: () => buildKeyterms(courses.map((c) => c.name)),            // old dictation bias
  parse: async (transcript) => {
    const parsed = await parseTeeTimePrefs({
      transcript,
      known: { courses: courses.map((c) => c.name) },       // UNTOUCHED call, verbatim args
    });
    return teeTimeTaskParse(transcript, parsed);
  },
  apply,
});
```

The object rebuilds every render (fresh `courses`/`windows`/`group` closures); the hook's
ref-delegation makes that free (§3). The `clearTimeout` before re-arming fixes a latent
double-arm (two utterances inside 1.4s each armed a timer; both fired `onDispatch` — harmless but
sloppy); the second `setPhase("searching")` was a no-op, so this is test-invisible.

`asks` identity: the voice path ends in the *same* `onDispatch` → `Searching` →
`buildTeeTimeQueries` over the *same* page state the plan produced — the dispatched `asks` are
identical to today's by construction (and asserted in §9's plan tests).

---

## 8. Why cross-page leakage is structurally impossible (the argument)

1. **There is no global intent router to mis-route.** The host never inspects transcripts; the
   ONLY parser that can run is `getCaddieContext().parse` — the active page's own deterministic
   parser, registered by the mounted page component, over that page's own schema. A tee-time
   utterance spoken on Home meets no parser at all (registry empty → general converse); a
   tournament utterance spoken on `/tee-time` meets `parseTeeTimePrefs`, which finds no tee-time
   signal → `hasSignal:false` → conversation + nudge. Wrong-page *dispatch* has no code path.
2. **Exclusivity is mechanical:** one module-level slot, last-writer-wins, object-identity
   unregister. Two contexts can never be simultaneously consultable.
3. **Registration is scoped by the component tree, not by route string matching:** `Prefs`
   mounts only in the prefs phase, so even *same-page* leakage (voice-editing prefs while the
   search is running) is impossible — the contract is gone the moment the phase moves.
4. **`payload` is opaque:** the host cannot develop opinions about page data; only the page's
   `apply` (which owns the setters) touches page state, on the host's gates.
5. **The sheet session is bound to the registration** (`boundId` + close-on-unregister): a
   context switch mid-session can't splice one page's parse into another page's apply.

---

## 9. Tests (all new; zero existing tests modified)

### `frontend/src/lib/caddie-context.test.ts`
1. register → `getCaddieContext()` returns it; unregister → null.
2. **Exclusivity / last-writer-wins:** A then B → active is B.
3. **Stale unregister is a no-op:** A then B, then A's unregister → active STILL B; B's
   unregister → null (StrictMode double-mount safety).
4. Same-shape double register (two objects, same id) → second wins; first's cleanup no-op.
5. Subscription fires on register/unregister with the new value; unsubscribe stops delivery.
6. **General fallback contract:** fresh module state → `getCaddieContext()` is null (documented
   as "host falls to general").
7. Orb-state channel: set/get/subscribe/unsubscribe; setting the same state doesn't re-notify.

### `frontend/src/lib/teetime/caddie-task.test.ts`
1. `teeTimeTaskParse`: signal fixture → `hasSignal:true`, confidence passthrough, payload `===`
   parsed; no-signal fixture → `hasSignal:false`, confidence 0.2.
2. `teeTimeConfirmEcho` format-lock: "goes" shape (`"Saturday morning — on it."` →
   `"Saturday morning"`), "got it" shape (`"Got it — party of 4."` → `"party of 4"`), null →
   fallback. (Breaks loudly if `teeTimeAckLine`'s two shapes ever change.)
3. `planTeeTimeApply` ≡ old `applyParsed` (fixtures through the real untouched libs):
   - windows merge = `applyParsedWindows(current, parsed.windows)`;
   - course miss → `courses:null` + kept-your-picks line; course hit → selection replaced;
   - radius widening (far selected course) and explicit-miles-wins ordering;
   - party resize via `applyPartySize`; price set; line = miss-note ?? ack ?? "Got it.";
   - `dispatched` true iff windows>0 or dispatch.
4. **Identical asks:** feed plan output into `buildTeeTimeQueries` (real fn) and assert equality
   with queries built from state mutated the old way (`applyParsedWindows` etc. applied directly).

### `frontend/src/components/CaddieOrbSheet.test.tsx` (jsdom + RTL; mock `useLooperDictation`
with a controllable fake, mock `@/lib/caddie/api`, `@/lib/haptics`, `useSheetTTS` as today's
suites do; drive summons via real `openLooper` and contexts via real `registerCaddieContext`)
1. **Gate (b) blocks dispatch:** task ctx whose parse resolves `{hasSignal:true, confidence:0.5,
   ack:"Saturday-ish"}` → "Here's what I got — Saturday-ish. Say it again to correct, or edit
   below." rendered; `apply` NOT called; `haptic("warning")` once; no confirming orb state.
2. **Gate (a) fall-through routes no-signal to converse:** parse resolves `hasSignal:false` →
   `talkToCaddieStream` called with the transcript and `hole_number:null`; `apply` NOT called;
   reply turn ends with the ctx's nudge; history excludes the in-flight utterance.
3. **Gate (c) applies + beats:** high-confidence parse → `apply` called once with the exact
   TaskParse; ack line rendered; `dispatched:true` → `haptic("success")` + orb state
   `"confirming"`; `dispatched:false` → neither.
4. **General lane parity:** no registration + summon `context:"general"` → title "What can I do
   for you?"; mic → stream ladder called; `BeforeFirstByteError` → `talkToCaddie` fallback used.
5. **Surface lane:** register surface ctx, summon → `summon(listening)` called with the bus
   flag; no sheet in the DOM.
6. **Legacy courses floor:** no registration, summon `context:"courses"` → host renders nothing
   (the courses page's own listener owns it).
7. **Unregister-while-open closes the task lane cleanly:** open task session → unregister →
   sheet closes, `dictation.cancel` called, no further setState (no act() warnings).
8. Reset-on-open only on closed→open (turns survive a re-summon while open).

### `frontend/src/components/CaddieOrb.test.tsx` (extend)
- `setCaddieOrbState("confirming")` → pulse state toggles (assert via animate prop or a data hook), returns to rest on `"idle"`. Existing pointer tests untouched.

---

## 10. Gates (run after implementation, in order)

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npx tsx voice-tests/runner.ts --smoke     # HARD gate — must be green by construction
cd frontend && npm run build
cd frontend && npx vitest run
```

Plus designer review (epic §9): sheet copy per lane, the fall-through nudge line, the confirming
pulse, the two called-out non-parity items in §5.

## 11. Implementation order (each step compiles + tests green)

1. `lib/caddie-context.ts` + tests (pure, standalone).
2. `hooks/useCaddiePageContext.ts` (compiles unused).
3. `lib/teetime/caddie-task.ts` + tests (pure, standalone — proves apply-parity before any UI moves).
4. `components/CaddieOrbSheet.tsx` + tests; `layout.tsx` swap; delete `LooperSheet` default
   export (one commit — the general brain must never be mounted twice).
5. Tee-time migration (§7 deletions + registration) + `CaddieOrb` confirming pulse.
6. Full gate run; manual pass: speak "Saturday morning at <course>, party of four" on `/tee-time`
   → prefs update behind the sheet → ack → search dispatches with identical asks; speak "what's a
   good warmup?" on `/tee-time` → caddie answers + nudge; same question on Home → plain general.

## 12. Risks & edge cases (adversarial pass)

- **Registration thrash** — page rebuilds ctx every render → solved by register-once +
  ref-delegating wrapper (§3); registry notifications fire only on mount/unmount. Tested (§9.1-4).
- **StrictMode double-mount** — object-identity tokens make the interleaved cleanup a no-op (§2, §9 test 3).
- **Sheet open across context unmount** — the tee-time dispatch itself triggers this every time
  (beat → phase change → `Prefs` unmount). Close-on-unregister (§4.5) cancels dictation, aborts
  streams, and plays the shell's exit. Closing must NOT cancel the page's armed dispatch timer —
  the ack promised the search.
- **Dictation cleanup** — single hook instance in the host; `close()` and unregister-close both
  call `dictation.cancel()`; `stopAndResolve` results are gen-guarded so a stale resolve after a
  close can't append turns.
- **TTS in the shared converse** — shell-owned and untouched; the one trap (two turns appended in
  one render → only the last is spoken) is designed around by riding the nudge in the same turn
  (§4.4). Task acks get spoken exactly as the old tee-time shell instance did.
- **History duplication on fall-through** — the `historyBase` snapshot (§4.3a); without it the
  transcript could appear twice in the caddie request.
- **Double-handling the courses hub** — explicit legacy floor rule (§4.2 step 2); S3 replaces it
  with a `"courses"` surface registration and deletes the page's raw bus listener.
- **Confidence gate wording** — `parse.ack` must never promise action; enforced by
  `teeTimeConfirmEcho` + format-lock tests; the branch is provably unreachable for S2 tee-time
  parses (no LLM key + local floor 0.65) so no live-UX regression risk while still being real,
  tested host behavior for S3.
- **`asks` drift** — impossible by construction (same `onDispatch`, same state, same
  `buildTeeTimeQueries`) and pinned by §9 caddie-task test 4.
- **Voice-tests churn** — zero parser/lib files touched; the smoke lane imports nothing that
  changes. Green by construction, verified by the hard gate.
- **NORTHSTAR conformance** — quiet: one sheet, no new chrome, nudge is one gentle line; honest:
  low-confidence never acts, course-miss says "kept your picks", no fabricated grounding (S2
  passes none rather than pretending); voice-first: the wow path is speak → honest ack → the
  caddie goes.

## 13. S3/S4 slot-in (accommodated, not wired)

- **Tournament (S3):** `id:"tournament-setup"`, `kind:"task"` — the union, gates, ack echo, and
  host tests already fit an LLM-assisted parser with real sub-0.6 confidences. No host change.
- **Round setup / courses (S3):** `kind:"surface"` — lane exists (§4.2 step 1); courses migration
  additionally deletes the §4.2 step-2 legacy rule + the page's bus listener.
- **My Card (S4):** `kind:"converse"` — union slot exists; S4 adds `stats_context` to the request
  builder in `runConverse` + backend. No contract change.

### Critical Files
- `frontend/src/components/CaddieOrbSheet.tsx` (new host — lanes, gates, shared converse)
- `frontend/src/lib/caddie-context.ts` (new contract + registry + orb-state channel)
- `frontend/src/app/tee-time/page.tsx` (reference task migration; §7 deletions/registration)
- `frontend/src/components/LooperSheet.tsx` (default export deleted; shell preserved)
- `frontend/src/lib/teetime/caddie-task.ts` (new pure glue proving apply/asks parity)
