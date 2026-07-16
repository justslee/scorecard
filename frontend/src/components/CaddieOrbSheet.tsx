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
import { useCaddiePersona, captionPersonaName } from "@/lib/caddie/persona";
import { useStreamBuffer } from "@/lib/caddie/stream-buffer";
import { onLooperOpen } from "@/lib/looper-bus";
import { haptic } from "@/lib/haptics";
import {
  getCaddieContext,
  onCaddieContextChange,
  setCaddieOrbState,
  TASK_CONFIDENCE_FLOOR,
  type CaddieTaskContext,
  type CaddieConverseContext,
  type CaddieTaskId,
} from "@/lib/caddie-context";

export default function CaddieOrbSheet() {
  // Source of truth for the golfer's chosen persona (persona.ts §resolution
  // order); mounting the hook here — the layout-mounted, single omnipresent
  // host — is what makes every off-round surface speak/reply in the SAME
  // persona chosen on the round page, instead of silently defaulting to
  // classic (persona.ts's module-level pub-sub converges this instance with
  // any other mounted instance, e.g. the round page's own).
  const { personaId, caddy } = useCaddiePersona();
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
      open={open}
      onClose={close}
      title={activeTask?.copy.title ?? activeConverse?.copy.title ?? "What can I do for you?"}
      emptyHint={
        activeTask?.copy.hint ??
        activeConverse?.copy.hint ??
        (personaId === "classic"
          ? "Tee times, courses, your game — ask me anything."
          : `${caddy.name} here — tee times, courses, your game. Ask me anything.`)
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
