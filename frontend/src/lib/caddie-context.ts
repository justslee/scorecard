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
  /** true → the host reopens the mic for one hands-free follow-up turn after
   *  speaking `line` (A3: the clarify question's answer). Only meaningful
   *  with `dispatched:false`. Optional — other registrants (tournament setup)
   *  need no change. */
  expectReply?: boolean;
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
