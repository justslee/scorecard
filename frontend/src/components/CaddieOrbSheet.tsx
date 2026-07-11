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
import { LooperSheetShell, type LooperTurn, type LooperPhase } from "@/components/LooperSheet";
import { useLooperDictation } from "@/hooks/useLooperDictation";
import { buildKeyterms } from "@/lib/voice/keyterms";
import { talkToCaddie, talkToCaddieStream, BeforeFirstByteError } from "@/lib/caddie/api";
import { useStreamBuffer } from "@/lib/caddie/stream-buffer";
import { onLooperOpen } from "@/lib/looper-bus";
import { haptic } from "@/lib/haptics";
import {
  getCaddieContext,
  onCaddieContextChange,
  setCaddieOrbState,
  TASK_CONFIDENCE_FLOOR,
  type CaddieTaskContext,
  type CaddieTaskId,
} from "@/lib/caddie-context";

export default function CaddieOrbSheet() {
  const [open, setOpen] = useState(false);
  // The task ctx id the OPEN session is bound to; null = general lane.
  const [boundId, setBoundId] = useState<CaddieTaskId | null>(null);
  const [turns, setTurns] = useState<LooperTurn[]>([]);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Streaming caddie reply — see LooperSheet's former default export; only
  // the FULL text is ever committed into `turns`, on completion.
  const [streamingText, setStreamingText] = useState<string | null>(null);

  const streamAbortRef = useRef<AbortController | null>(null);
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
    setOpen(false);
    setThinking(false);
    setError(null);
    setBoundId(null);
  }, [answerBuffer]);

  // ── Summon routing (the lane switch) ──
  useEffect(() => {
    return onLooperOpen((detail) => {
      const ctx = getCaddieContext();

      // 1) SURFACE — no sheet at all: the page owns its own voice surface.
      if (ctx?.kind === "surface") {
        ctx.summon(detail.listening);
        return;
      }

      // 2) LEGACY floor — the courses hub still consumes its own bus summons
      //    (app/courses/page.tsx). Until a future slice migrates it to a
      //    "courses" surface registration, the host must not double-handle it.
      if (!ctx && detail.context === "courses") return;

      // 3) TASK or CONVERSE or GENERAL — open the sheet, bound to the context.
      setBoundId(ctx?.kind === "task" ? ctx.id : null);
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
              personality_id: "classic",
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
            personality_id: "classic",
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
    [answerBuffer, appendTurn],
  );

  // ── Mic handler — lanes + gates ──
  const handleMicTap = useCallback(async () => {
    setError(null);
    if (!dictation.listening) {
      await dictation.start();
      return;
    }

    const gen = sessionRef.current;
    setThinking(true);
    const heard = await dictation.stopAndResolve();
    if (sessionRef.current !== gen) return; // sheet closed/reopened meanwhile
    if (!heard) {
      setThinking(false);
      const activeTask = boundTaskCtx();
      setError(
        activeTask
          ? "Didn't catch that — tap the mic and tell me when and where."
          : "No speech detected. Tap the mic to try again.",
      );
      return;
    }

    // SNAPSHOT BEFORE appending the user turn — see historyBase note in the
    // plan: the parse() await between append and converse may let a render
    // flush turnsRef, which would duplicate the utterance in the fall-through.
    const historyBase = turnsRef.current;
    appendTurn({ role: "user", text: heard });

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
  }, [dictation, boundTaskCtx, appendTurn, runConverse]);

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

  return (
    <LooperSheetShell
      open={open}
      onClose={close}
      title={activeTask?.copy.title ?? "What can I do for you?"}
      emptyHint={activeTask?.copy.hint ?? "Tee times, courses, your game — ask me anything."}
      turns={turns}
      phase={phase}
      interim={dictation.interim}
      error={error ?? dictation.micError}
      onMicTap={() => void handleMicTap()}
      streamingTurn={streamingText}
    />
  );
}
