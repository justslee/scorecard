"use client";

// The generic caddie-orb sheet host (specs/orb-s2-context-contract-teetime-plan.md §4).
//
// Mounted ONCE in app/layout.tsx (replacing the old private `LooperSheet`
// default export it subsumes). Wraps `LooperSheetShell`. Owns: the summon
// subscription, ONE `useLooperDictation` instance, the turn log, the shared
// converse machinery (moved verbatim from LooperSheet's former default
// export — see `runConverse` below, factored ONCE), and the task gates that
// decide whether the active page's registered parser applies, falls through
// to conversation, or asks for confirmation. See caddie-context.ts for the
// contract this host reads.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { LooperSheetShell, type LooperTurn, type LooperPhase } from "@/components/LooperSheet";
import { useLooperDictation } from "@/hooks/useLooperDictation";
import { buildKeyterms } from "@/lib/voice/keyterms";
import { talkToCaddie, talkToCaddieStream, BeforeFirstByteError } from "@/lib/caddie/api";
import { useCaddiePersona, captionPersonaName } from "@/lib/caddie/persona";
import { useStreamBuffer } from "@/lib/caddie/stream-buffer";
import { onLooperOpen, onLooperDockedGesture } from "@/lib/looper-bus";
import { haptic } from "@/lib/haptics";
import {
  getCaddieContext,
  onCaddieContextChange,
  setCaddieOrbState,
  setCaddieOrbCaption,
  TASK_CONFIDENCE_FLOOR,
  type CaddieTaskContext,
  type CaddieConverseContext,
  type CaddieTaskId,
} from "@/lib/caddie-context";

/** Docked no-speech self-heal (§2f): how long the "Didn't catch that" caption
 *  sits on the orb before the docked session quietly collapses back to idle. */
const DOCKED_NO_SPEECH_TIMEOUT_MS = 2500;

export default function CaddieOrbSheet() {
  // Source of truth for the golfer's chosen persona (persona.ts §resolution
  // order); mounting the hook here — the layout-mounted, single omnipresent
  // host — is what makes every off-round surface speak/reply in the SAME
  // persona chosen on the round page, instead of silently defaulting to
  // classic (persona.ts's module-level pub-sub converges this instance with
  // any other mounted instance, e.g. the round page's own).
  const pathname = usePathname();
  const { personaId, caddy } = useCaddiePersona();
  const [open, setOpen] = useState(false);
  // The task ctx id the OPEN session is bound to; null = general lane.
  const [boundId, setBoundId] = useState<CaddieTaskId | null>(null);
  // Docked = no sheet chrome, talking straight into the orb (§2). Full =
  // today's sheet. presentationRef is mirrored via effect (below), same
  // pattern as openRef, so async/effect code always reads the LIVE value.
  const [presentation, setPresentation] = useState<"docked" | "full">("full");
  const presentationRef = useRef<"docked" | "full">("full");
  useEffect(() => {
    presentationRef.current = presentation;
  }, [presentation]);
  // true while THIS host expects dictation to stop next (docked tap-to-send,
  // onUtteranceEnd auto-send, or the docked-cancel gesture) — distinguishes
  // an intentional stop from an unexpected listening drop (§2e trigger c).
  const dockedExpectedStopRef = useRef(false);
  // Bare-silence self-heal timer while docked (§2f) — collapses to idle
  // rather than promoting to a full sheet for nothing heard.
  const noSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // INVARIANT (verified, specs/caddie-coherence-polish-plan.md §1): turns
  // persist across a RE-SUMMON while the sheet is already open (see the
  // "reset-on-open only on closed→open" tests below) — so `emptyHint`
  // (rendered only when `turns.length === 0`) can never re-greet onto a
  // preserved mid-session conversation, mirroring CaddieSheet.tsx:845's
  // round-side no-re-greet contract. NOTE this is narrower than a literal
  // close()-then-reopen: `resetSession()` (below) intentionally clears
  // `turns` on the closed→open transition, so a fully closed-then-reopened
  // sheet deliberately starts a fresh conversation — that reset is a
  // pre-existing, separately-tested behavior, not a re-greet regression.
  const [turns, setTurns] = useState<LooperTurn[]>([]);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Streaming caddie reply — see LooperSheet's former default export; only
  // the FULL text is ever committed into `turns`, on completion.
  const [streamingText, setStreamingText] = useState<string | null>(null);

  const streamAbortRef = useRef<AbortController | null>(null);
  // A3: the one hands-free follow-up mic-reopen after a task ack that asks a
  // clarify question (TaskAck.expectReply). Cleared on close()/a manual mic
  // tap so a superseded/closed session can never reopen the mic underneath
  // the golfer.
  const expectReplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answerBuffer = useStreamBuffer((chunk) => {
    setStreamingText((prev) => (prev ?? "") + chunk);
  });

  // Staleness gen — the old openGenRef, generalized to every lane.
  const sessionRef = useRef(0);
  const turnsRef = useRef<LooperTurn[]>([]);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  const boundIdRef = useRef<CaddieTaskId | null>(null);
  useEffect(() => {
    boundIdRef.current = boundId;
  }, [boundId]);
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // The bound task's LIVE registration — looked up by id at use time, never
  // stored as a component-state copy (one source of truth: the registry).
  const boundTaskCtx = useCallback((): CaddieTaskContext | null => {
    const ctx = getCaddieContext();
    if (ctx?.kind === "task" && ctx.id === boundIdRef.current) return ctx;
    return null;
  }, []);

  // Auto-send: Deepgram's end-of-speech triggers the same path as tapping
  // the mic to send (ref indirection — the handler is defined below).
  const micTapRef = useRef<() => void>(() => {});
  const dictation = useLooperDictation({
    // Preserves today's telemetry labels exactly: "tee-time" while bound to
    // that task, "looper-general" for the general/converse lane.
    surface: boundId ?? "looper-general",
    getKeyterms: () => boundTaskCtx()?.getKeyterms?.() ?? buildKeyterms(),
    onUtteranceEnd: () => micTapRef.current(),
  });
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;

  const appendTurn = useCallback((t: LooperTurn) => {
    setTurns((ts) => [...ts, t]);
  }, []);

  const resetSession = useCallback(() => {
    sessionRef.current++;
    setTurns([]);
    setThinking(false);
    setError(null);
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    answerBuffer.cancel();
    setStreamingText(null);
  }, [answerBuffer]);

  const close = useCallback(() => {
    sessionRef.current++;
    dictationRef.current.cancel();
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    answerBuffer.cancel();
    setStreamingText(null);
    if (expectReplyTimerRef.current) {
      clearTimeout(expectReplyTimerRef.current);
      expectReplyTimerRef.current = null;
    }
    setOpen(false);
    setThinking(false);
    setError(null);
    setBoundId(null);
    // Docked hygiene — always safe to run even for a full-sheet close:
    // setCaddieOrbState("idle") dedups (inert once already idle), and
    // resetting presentation/caption/the stop-expectation flag here means
    // every close path (manual, route-change, unregister, docked-cancel)
    // leaves the orb in a clean idle state for the next summon.
    if (noSpeechTimerRef.current) {
      clearTimeout(noSpeechTimerRef.current);
      noSpeechTimerRef.current = null;
    }
    setPresentation("full");
    dockedExpectedStopRef.current = false;
    setCaddieOrbState("idle");
    setCaddieOrbCaption(null);
  }, [answerBuffer]);

  /** Promotion — docked → full is ONLY a presentation flip: same `open`, same
   *  `sessionRef` generation, same `turns`, same dictation instance. Never
   *  touches sessionRef/turns/dictation — that is what satisfies the
   *  dedup/zombie-guard invariant by construction (§2d). */
  const promoteToFull = useCallback(() => {
    if (noSpeechTimerRef.current) {
      clearTimeout(noSpeechTimerRef.current);
      noSpeechTimerRef.current = null;
    }
    setPresentation("full");
    setCaddieOrbState("idle");
    setCaddieOrbCaption(null);
  }, []);

  // ── Summon routing (the lane switch) ──
  useEffect(() => {
    return onLooperOpen((detail) => {
      const ctx = getCaddieContext();

      // 1) SURFACE — no sheet at all: the page owns its own voice surface.
      if (ctx?.kind === "surface") {
        ctx.summon(detail.listening);
        return;
      }

      // 2) LEGACY floor — the courses LIST page still consumes its own bus
      //    summons (app/courses/page.tsx). `looperContextForPath` (lib/
      //    looper-bus.ts) scopes `context: "courses"` to that list route
      //    only, so this guard now only ever fires there — course DETAIL
      //    pages summon `context: "general"` and fall through to lane 3
      //    below (the general converse sheet), not swallowed here. Until a
      //    future slice migrates the list page to a "courses" surface
      //    registration, the host must not double-handle its summons.
      if (!ctx && detail.context === "courses") return;

      // 3) TASK or CONVERSE or GENERAL — open the sheet, bound to the context.
      //    Surface-registered pages summon through lane 1 above and never
      //    reach here; `presentation` only matters for this lane.
      setBoundId(ctx?.kind === "task" ? ctx.id : null);
      setPresentation(detail.presentation ?? "full");
      setOpen((wasOpen) => {
        if (!wasOpen) resetSession();
        return true;
      });
      if (detail.listening) {
        setTimeout(() => void dictationRef.current.start(), 60);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Context-unmount hygiene ──
  // The sheet's task session is bound to a registration. If that page
  // unmounts (tee-time: the 1400ms beat fired onDispatch → phase "searching"
  // → Prefs unmounted → unregister), the parse/apply closures are dead —
  // close the whole lane cleanly rather than talk to a ghost. The page's
  // dispatch timer is NOT touched by close() — it fires independently.
  useEffect(() => {
    return onCaddieContextChange((ctx) => {
      if (openRef.current && boundIdRef.current !== null && ctx?.id !== boundIdRef.current) {
        close();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Promotion trigger (b): a real mic/connect error while docked — the
  //    orb has nothing to show for a dead mic, so surface the full sheet
  //    (its error line + retry mic) instead of leaving a silent chip. ──
  useEffect(() => {
    if (open && presentation === "docked" && dictation.micError) promoteToFull();
  }, [open, presentation, dictation.micError, promoteToFull]);

  // ── Promotion trigger (c): an UNEXPECTED listening drop while docked
  //    (e.g. the Realtime/Deepgram stream died underneath us) promotes to
  //    the full sheet so the golfer isn't left staring at a silently-dead
  //    orb. An EXPECTED stop (docked tap-to-send, onUtteranceEnd auto-send,
  //    or the docked-cancel gesture) sets `dockedExpectedStopRef` first —
  //    see handleMicTap and the docked-gesture subscription below — so this
  //    effect can tell the two apart. close() bumps sessionRef then sets
  //    open false, so `openRef` being stale-false by the time this runs
  //    makes close() inert here (no promotion out from under a close). ──
  const prevListeningRef = useRef(false);
  useEffect(() => {
    const listening = dictation.listening;
    const was = prevListeningRef.current;
    prevListeningRef.current = listening;
    if (listening) {
      dockedExpectedStopRef.current = false;
      return;
    }
    if (!was) return;
    if (!openRef.current || presentationRef.current !== "docked") return;
    if (dockedExpectedStopRef.current) {
      dockedExpectedStopRef.current = false;
      return;
    }
    promoteToFull();
  }, [dictation.listening, promoteToFull]);

  // ── Docked gesture subscription — the orb's OWN tap/hold while docked
  //    means "send now" / "cancel", never "reopen the sheet" (the ordinary
  //    looper:open summon). "send" while still connecting (mic not hot yet)
  //    is inert — nothing has been heard to send. ──
  useEffect(() => {
    return onLooperDockedGesture((gesture) => {
      if (!openRef.current || presentationRef.current !== "docked") return;
      if (gesture === "send") {
        if (!dictationRef.current.listening) return; // connecting: inert
        micTapRef.current();
      } else {
        dockedExpectedStopRef.current = true;
        close(); // cancel: releases the mic + resets presentation/orb/caption
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Docked → orb state/caption publisher ── the orb has no idea what the
  //    dictation hook is doing; this is the ONLY place that tells it, so the
  //    orb's pulse is always driven from the same render that means the mic
  //    is actually hot (mic-privacy invariant — never a live mic with no
  //    same-frame indicator). ──
  useEffect(() => {
    if (!open || presentation !== "docked") return;
    if (dictation.listening) {
      setCaddieOrbState("listening");
      setCaddieOrbCaption(dictation.interim ? `“${dictation.interim}”` : "Hearing…");
    } else {
      setCaddieOrbState("connecting");
      // Don't clobber the no-speech caption ("Didn't catch that") while its
      // self-heal timer is running (§2f) — this branch also fires right
      // after that timer starts, once dictation.listening flips false.
      if (!noSpeechTimerRef.current) setCaddieOrbCaption("Connecting…");
    }
  }, [open, presentation, dictation.listening, dictation.interim]);

  // ── Route-change hygiene — docked is page-scoped: a docked session must
  //    not keep the mic hot underneath a golfer who navigated away. Full-
  //    sheet sessions are untouched — they already survive navigation. ──
  const prevPathRef = useRef(pathname);
  useEffect(() => {
    if (prevPathRef.current === pathname) return;
    prevPathRef.current = pathname;
    if (openRef.current && presentationRef.current === "docked") {
      dockedExpectedStopRef.current = true;
      close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // ── The shared converse flow — factored ONCE. Both the general lane and
  //    the task fall-through go through this; there is no second copy of the
  //    stream→JSON ladder anywhere. ──
  const runConverse = useCallback(
    async (
      gen: number,
      finalText: string,
      historyBase: LooperTurn[],
      opts?: { nudge?: string; statsContext?: string | null },
    ) => {
      streamAbortRef.current?.abort();
      const controller = new AbortController();
      streamAbortRef.current = controller;
      answerBuffer.cancel();
      setStreamingText(null);
      const isStale = () => sessionRef.current !== gen || streamAbortRef.current !== controller;

      try {
        const history = historyBase.map((t) => ({
          role: t.role === "looper" ? ("assistant" as const) : ("user" as const),
          content: t.text,
        }));

        // 2-tier ladder — stream first; fall to stateless JSON only on a
        // pre-first-byte failure (BeforeFirstByteError). Verbatim from LooperSheet.
        const statsContext = opts?.statsContext ?? undefined;
        let responseText: string;
        try {
          responseText = await talkToCaddieStream(
            {
              transcript: finalText,
              personality_id: personaId,
              hole_number: null,
              conversation_history: history,
              stats_context: statsContext,
            },
            { onToken: (delta) => answerBuffer.push(delta), signal: controller.signal },
          );
        } catch (err) {
          if (!(err instanceof BeforeFirstByteError)) throw err;
          answerBuffer.cancel();
          setStreamingText(null);
          const res = await talkToCaddie({
            transcript: finalText,
            personality_id: personaId,
            hole_number: null, // off-course — never pretend to be on a hole
            conversation_history: history,
            stats_context: statsContext,
          });
          responseText = res.response;
        }

        if (isStale()) return;
        answerBuffer.flush();
        setStreamingText(null);
        // Fall-through nudge rides in the SAME looper turn (paragraph break):
        // one turn → the shell's speak-newest-turn TTS watcher speaks
        // answer+nudge together; two turns would skip the answer.
        const text = opts?.nudge ? `${responseText}\n\n${opts.nudge}` : responseText;
        appendTurn({ role: "looper", text });
      } catch {
        if (!isStale()) {
          answerBuffer.cancel();
          setStreamingText(null);
          setError("Looper couldn't answer that one. Try again.");
        }
      } finally {
        if (!isStale()) setThinking(false);
      }
    },
    [answerBuffer, appendTurn, personaId],
  );

  // ── Mic handler — lanes + gates ──
  const handleMicTap = useCallback(async () => {
    setError(null);
    // A manual tap (or onUtteranceEnd's auto-send, which routes through this
    // same handler) supersedes any pending auto-reopen from a prior turn.
    if (expectReplyTimerRef.current) {
      clearTimeout(expectReplyTimerRef.current);
      expectReplyTimerRef.current = null;
    }
    if (!dictation.listening) {
      await dictation.start();
      return;
    }

    const gen = sessionRef.current;
    setThinking(true);
    // Marks this stop as EXPECTED before it happens — the unexpected-drop
    // promotion effect (trigger c, above) checks this so a docked tap-to-send
    // (or onUtteranceEnd's auto-send through this same handler) never ALSO
    // promotes on top of the send/no-speech handling below.
    dockedExpectedStopRef.current = true;
    const heard = await dictation.stopAndResolve();
    if (sessionRef.current !== gen) return; // sheet closed/reopened meanwhile
    if (!heard) {
      setThinking(false);
      if (presentationRef.current === "docked") {
        // Bare silence while docked collapses to idle — never promotes to a
        // full sheet for nothing heard (§2f).
        setCaddieOrbCaption("Didn't catch that");
        const gen2 = sessionRef.current;
        noSpeechTimerRef.current = setTimeout(() => {
          noSpeechTimerRef.current = null;
          if (sessionRef.current === gen2 && openRef.current && presentationRef.current === "docked") {
            close();
          }
        }, DOCKED_NO_SPEECH_TIMEOUT_MS);
      } else {
        const activeTask = boundTaskCtx();
        setError(
          activeTask
            ? "Didn't catch that — tap the mic and tell me when and where."
            : "No speech detected. Tap the mic to try again.",
        );
      }
      return;
    }

    // SNAPSHOT BEFORE appending the user turn — see historyBase note in the
    // plan: the parse() await between append and converse may let a render
    // flush turnsRef, which would duplicate the utterance in the fall-through.
    const historyBase = turnsRef.current;
    appendTurn({ role: "user", text: heard });
    // Promotion trigger (a): the golfer's own turn just landed — promote
    // BEFORE parse()/converse() so every downstream render (parse confirm,
    // task ack, streaming reply) lands in the now-visible full sheet, not a
    // still-docked orb with nowhere to show it.
    if (presentationRef.current === "docked") promoteToFull();

    const activeTask = boundTaskCtx();
    if (activeTask) {
      // ── TASK LANE ──
      let parse;
      try {
        parse = await activeTask.parse(heard);
      } catch {
        if (sessionRef.current === gen) {
          setThinking(false);
          setError("Lost that one — mind saying it again? Or fill it in below.");
        }
        return;
      }
      if (sessionRef.current !== gen) return;

      if (!parse.hasSignal) {
        // GATE (a): FALL THROUGH → converse, with the ctx nudge riding in
        // the SAME looper turn as the reply.
        await runConverse(gen, heard, historyBase, { nudge: activeTask.copy.nudge });
        return;
      }

      if (parse.confidence < TASK_CONFIDENCE_FLOOR) {
        // GATE (b): confirm, don't act.
        appendTurn({
          role: "looper",
          text: `Here's what I got — ${parse.ack}. Say it again to correct, or fix it in the form.`,
        });
        haptic("warning");
        setThinking(false);
        return;
      }

      // GATE (c): merge + honest ack. The page armed its OWN dispatch timer
      // (if any) inside apply() — the host only plays the confirming beat.
      const ack = activeTask.apply(parse);
      appendTurn({ role: "looper", text: ack.line });
      if (ack.dispatched) {
        haptic("success");
        setCaddieOrbState("confirming");
        setTimeout(() => setCaddieOrbState("idle"), 900);
      }
      if (ack.expectReply && !ack.dispatched) {
        // A3: one hands-free follow-up turn — the clarify answer. Gen + open
        // guards make a close/unregister/dispatch race in the intervening
        // 900ms inert (a stale/closed session must never reopen the mic).
        expectReplyTimerRef.current = setTimeout(() => {
          if (sessionRef.current !== gen || !openRef.current) return;
          if (!dictationRef.current.listening) void dictationRef.current.start();
        }, 900);
      }
      setThinking(false);
      return;
    }

    // ── CONVERSE LANE (general in S2; my-card in S4) ──
    // A registered converse context (e.g. /profile's "my-card") grounds the
    // reply in the golfer's real stats; captured once at send time (not
    // per-token) — general lane (no converse ctx) passes nothing, unchanged.
    const ctx = getCaddieContext();
    const statsContext = ctx?.kind === "converse" ? ctx.getGrounding() : undefined;
    await runConverse(gen, heard, historyBase, { statsContext });
  }, [dictation, boundTaskCtx, appendTurn, runConverse, promoteToFull, close]);

  micTapRef.current = () => void handleMicTap();

  // While a reply is streaming in, the growing `streamingTurn` speaks for
  // itself — suppress the separate "thinking…" pulse so the two don't show
  // at once (quiet, not busy — NORTHSTAR).
  const phase: LooperPhase =
    dictation.listening ? "listening" : thinking && streamingText == null ? "thinking" : "idle";

  // Render-time task lookup MUST read the `boundId` STATE var, not
  // `boundIdRef` — the ref is mirrored one render late (via effect), so on the
  // batched setBoundId+setOpen summon render it is still stale and the sheet
  // would flash the generic converse copy instead of the task's own greeting
  // ("Where are we playing?"). `boundId` state is current in the render it is
  // read in; the registry (`getCaddieContext`) is module state, also current.
  // The ref-based `boundTaskCtx()` stays for the async/callback paths, where
  // at least one render has passed so the ref is up to date.
  // A fall-through keeps the task title for the session (the sheet was
  // summoned on that page); boundId only resets on close/summon.
  const activeCtx = getCaddieContext();
  const activeTask: CaddieTaskContext | null =
    boundId != null && activeCtx?.kind === "task" && activeCtx.id === boundId ? activeCtx : null;
  // A registered converse context (e.g. /profile's "my-card") greets the golfer
  // with its OWN title + hint. Unlike a task there is no boundId to pin (converse
  // never binds), so the live registry is the source of truth — the newest
  // converse registration owns the sheet copy while its page is active.
  const activeConverse: CaddieConverseContext | null =
    activeCtx?.kind === "converse" ? activeCtx : null;

  // Cross-surface identity label (specs/caddie-cross-surface-identity-label-
  // plan.md §3): who the reply caption / streaming caption / thinking pulse
  // attribute the reply to. Task lane is the app doing a job on the golfer's
  // behalf — honestly "Looper", not the caddie persona conversing. Classic
  // maps to "Looper" too (the app's own caddie name, matching the empty-hint
  // treatment). Only converse/general + a non-classic persona shows the
  // short persona name, truncated for the tiny mono captions.
  const speakerLabel =
    activeTask != null || personaId === "classic"
      ? "Looper"
      : captionPersonaName(caddy.name);

  return (
    <LooperSheetShell
      // Docked → the shell renders NOTHING (no chrome, no scroll lock), as
      // if closed — the golfer is talking straight into the orb. On
      // promotion the shell sees closed→open and re-baselines its
      // speak-newest watermark to turns.length-1 (the just-appended user
      // turn, §2j), so the first caddie reply is spoken but the user's own
      // turn is not. NO presentation prop is added to LooperSheetShell
      // itself — that would touch the tee-time consumer's own shell
      // instance and LooperSheet.test.tsx, both out of scope.
      open={open && presentation === "full"}
      onClose={close}
      title={activeTask?.copy.title ?? activeConverse?.copy.title ?? "What can I do for you?"}
      emptyHint={
        activeTask?.copy.hint ??
        activeConverse?.copy.hint ??
        (personaId === "classic"
          ? "Tee times, courses, your game — ask me anything."
          : `${captionPersonaName(caddy.name)} here — tee times, courses, your game. Ask me anything.`)
      }
      turns={turns}
      phase={phase}
      interim={dictation.interim}
      error={error ?? dictation.micError}
      onMicTap={() => void handleMicTap()}
      streamingTurn={streamingText}
      personaId={personaId}
      speakerLabel={speakerLabel}
    />
  );
}
