"use client";

/**
 * useDetachedCaddieLive — lifts ownership of the live Realtime caddie session
 * OUT of CaddieSheet and into RoundPageClient (specs/caddie-detach-and-
 * language-pin-plan.md, Item B). The core behavioral change: closing the
 * sheet no longer stops the live session — only an explicit `end()` does.
 *
 * A thin wrapper hook, not a context (one consumer pair — the round page
 * already lifts convHistory the same way). Composes `useCaddieLiveSession`
 * UNCHANGED: its warm-adopt/reconnect/suspend-resume state machines are
 * load-bearing and this wrapper never reaches into them — it only flips the
 * `active` gate and calls the hook's own public `stop()`.
 *
 * The gate: `active` for the inner hook is `liveOn` ALONE (previously it was
 * `open && sessionActive && getCaddieLiveMode() && navigator.onLine`, all
 * re-evaluated on every CaddieSheet render). Eligibility is now checked ONCE,
 * at `start()` time — the moment the golfer actually asks for live — so a
 * live conversation, once running, survives the sheet closing.
 *
 * Fallback-while-closed: if the live session degrades to the classic path
 * (mint timeout / connect fail / mic deny / a drop that exhausts the one
 * reconnect) while the sheet is closed, this releases `liveOn` so the NEXT
 * open retries live fresh — the same "next open retries" behavior the sheet
 * always had. While the sheet is OPEN, CaddieSheet itself renders the classic
 * fallback UI in place, without this wrapper touching `liveOn` (closing that
 * sheet is what would trigger the release, on the next tick).
 *
 * Suspended (90s idle) while closed intentionally does NOT release `liveOn`
 * — the transcript is preserved server-side/locally and reopening shows the
 * existing "Paused — tap to resume" affordance, exactly as it does today
 * while the sheet stays open across an idle window.
 *
 * `"connect-failed"` (specs/caddie-live-p0-connect-hole-plan.md §2.1-2.3)
 * ALSO deliberately does NOT release `liveOn`, closed or open — that release
 * IS the silent revert to "Ask caddie" this plan kills. It is the ONE
 * pre-connect terminal state a golfer resolves by tapping (`retryConnect()`,
 * threaded through below) rather than by the session quietly starting over.
 */

import { useCallback, useEffect, useState } from "react";
import {
  useCaddieLiveSession,
  type UseCaddieLiveSessionResult,
} from "@/hooks/useCaddieLiveSession";
import { getCaddieLiveMode } from "@/lib/voice/live-mode-pref";
import type { OpeningShot } from "@/lib/caddie/opening-turn";
import type { ScoreEntryResult } from "@/lib/voice/realtime";

export interface UseDetachedCaddieLiveOptions {
  roundId: string;
  personaId: string;
  holeNumber: number;
  holePar: number;
  holeYards: number | null;
  yardageBasis?: "gps" | "tee-card" | "tee-geom" | "card" | null;
  teeName?: string | null;
  resolveOpeningShot?: () => Promise<OpeningShot | null>;
  /** Explicit spoken score-entry routing (specs/caddie-two-tier-routing-plan
   *  .md §9) — passed straight through to `useCaddieLiveSession`. */
  enterScores?: (utterance: string, holeNumber?: number) => Promise<ScoreEntryResult>;
  /** Whether the caddie sheet UI is currently open. Read ONLY by the
   *  fallback-auto-release effect below — eligibility itself does not
   *  depend on sheet-open state (that's the whole point of detaching). */
  sheetOpen: boolean;
  /** True when this round/persona is eligible for a live session at all
   *  (caller-computed: `caddieSessionActive && !isLocalRound`). `start()` is
   *  a no-op when this is false. */
  eligible: boolean;
}

export interface DetachedCaddieLive {
  /** True from a user-triggered `start()` until an explicit `end()` (or a
   *  fallback-while-closed auto-release) — NOT tied to the sheet being open. */
  liveOn: boolean;
  /** The underlying session state — CaddieSheet renders its live body from
   *  this (passed through as a prop, unmodified). */
  session: UseCaddieLiveSessionResult;
  /** Turns the gate on, applying today's live-eligibility check exactly
   *  once. No-op if already on. */
  start: () => void;
  /** Instant mic cut: `session.stop()` then the gate flip (which also drives
   *  the inner hook's own `!active` teardown — idempotent, since `stop()`
   *  already nulled the client and the inner hook's `aborted`-style refs are
   *  terminal). The ONE true-stop path besides route-unmount/round-end. */
  end: () => void;
  /** Pill-indicator derivations. */
  isLive: boolean;
  isSuspended: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  /** True while the one quiet pre-connect auto-retry is in flight (specs/
   *  caddie-live-p0-connect-hole-plan.md §2.1). */
  isRetrying: boolean;
  /** True at the honest pre-connect terminal — `liveOn` stays true (see the
   *  docblock above); resolved by tapping `session.retryConnect()`. */
  isConnectFailed: boolean;
}

export function useDetachedCaddieLive({
  roundId,
  personaId,
  holeNumber,
  holePar,
  holeYards,
  yardageBasis = null,
  teeName = null,
  resolveOpeningShot,
  enterScores,
  sheetOpen,
  eligible,
}: UseDetachedCaddieLiveOptions): DetachedCaddieLive {
  const [liveOn, setLiveOn] = useState(false);

  // Hook called UNCONDITIONALLY (active=false when off) — no conditional-hook
  // hazard, same discipline CaddieSheet used before this change.
  const session = useCaddieLiveSession({
    active: liveOn,
    roundId,
    personaId,
    holeNumber,
    holePar,
    holeYards,
    yardageBasis,
    teeName,
    resolveOpeningShot,
    enterScores,
  });

  const start = useCallback(() => {
    if (liveOn) return; // already on — no-op (persona/round changes flow
    // through the inner hook's own dep-change cleanup, unchanged)
    if (!eligible) return;
    if (!getCaddieLiveMode()) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    setLiveOn(true);
  }, [liveOn, eligible]);

  const stopSession = session.stop;
  const end = useCallback(() => {
    stopSession(); // instant mic cut
    setLiveOn(false); // drives the inner hook's own `!active` teardown belt
  }, [stopSession]);

  // Fallback auto-release (preserves "next open retries live"): only when
  // the sheet is CLOSED — while open, CaddieSheet renders the classic
  // fallback body in place without releasing liveOn. Deferred out of the
  // effect body (react-hooks/set-state-in-effect — matches the established
  // pattern elsewhere in this codebase, e.g. app/tournament/new/page.tsx).
  useEffect(() => {
    if (!(session.fellBack && !sheetOpen)) return;
    const t = setTimeout(() => setLiveOn(false), 0);
    return () => clearTimeout(t);
  }, [session.fellBack, sheetOpen]);

  return {
    liveOn,
    session,
    start,
    end,
    isLive: liveOn && !session.fellBack,
    isSuspended: liveOn && session.liveState === "suspended",
    isListening: liveOn && session.status === "listening",
    isSpeaking: liveOn && session.status === "speaking",
    isRetrying: liveOn && session.liveState === "retrying",
    isConnectFailed: liveOn && session.liveState === "connect-failed",
  };
}
