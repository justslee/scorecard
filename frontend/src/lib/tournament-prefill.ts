/**
 * Tournament ↔ caddie-context glue (specs/omnipresent-caddie-orb-plan.md §4,
 * slice S3). Mirrors `lib/teetime/caddie-task.ts`'s shape: pure functions
 * turning the stranded tournament parse layer's output into the generic
 * contract's `TaskParse`, and computing exactly what `/tournament/new`'s
 * setters should apply — the page owns state; this module only computes what
 * to do with it. Tournament CREATION is never auto-dispatched here (unlike
 * tee-time) — the golfer always taps "Create tournament"; the filled-in form
 * + honest ack line IS the confirmation.
 */

import type { TaskParse } from "@/lib/caddie-context";
import type { VoiceParseResultValidated } from "@/lib/voice/schemas";
import { fuzzyBestMatch } from "@/lib/voice/utils";

/** The tournament sub-object of a validated parse — reuse the Zod-inferred
 *  shape rather than re-declaring it a third time. */
export type ParsedTournamentConfig = NonNullable<VoiceParseResultValidated["tournament"]>;

// ── parse → TaskParse ────────────────────────────────────────────────────

/** parsed → the contract's TaskParse. Pure. Never throws on a game-typed
 *  result — hasSignal simply reads false, so the host falls through to
 *  conversation rather than misfiring a tournament from a game utterance. */
export function tournamentTaskParse(
  transcript: string,
  result: VoiceParseResultValidated,
): TaskParse {
  return {
    transcript,
    hasSignal: result.type === "tournament" && result.tournament != null,
    confidence: result.confidence,
    ack: tournamentConfirmEcho(result),
    payload: result,
  };
}

/** Neutral echo for the low-confidence confirm line — describes what was
 *  heard without ever claiming action was taken (never "on it"). */
export function tournamentConfirmEcho(result: VoiceParseResultValidated): string {
  if (result.type !== "tournament" || !result.tournament) return "not much, honestly";
  const t = result.tournament;
  const rounds = `a ${t.numRounds}-round tournament`;
  if (t.playerNames.length > 0) return `${rounds} with ${t.playerNames.join(", ")}`;
  return rounds;
}

// ── parsed → prefill plan ────────────────────────────────────────────────

export interface TournamentPrefillPlan {
  /** Trimmed tournament name; null if empty/absent — leave the form untouched. */
  name: string | null;
  /** Clamped to [1,4] — the form only offers 1–4 rounds. */
  numRounds: 1 | 2 | 3 | 4;
  /** The raw spoken round count, pre-clamp (for the ack/telemetry). */
  numRoundsRequested: number;
  /** true when numRounds !== numRoundsRequested. */
  numRoundsClamped: boolean;
  /** Saved-player ids matched from parsed.tournament.playerNames (deduped). */
  selectedIds: string[];
  /** Parsed player names that matched NO saved player — staged as new custom
   *  players (deduped case-insensitively against each other and against the
   *  matched saved players' names). */
  customPlayerNames: string[];
  /** Honest notes for fields this form has no surface for — never silently
   *  dropped (courses, groupings, handicap adjustment, round-count clamp). */
  notes: string[];
  /** One calm line: what landed + the notes. Never claims creation — the
   *  golfer always taps "Create tournament" themselves. */
  ackLine: string;
}

const FUZZY_PLAYER_THRESHOLD = 0.76;

/** Pure. Computes everything `/tournament/new`'s setters need from a
 *  confirmed tournament parse, plus the honest ack line. */
export function tournamentPrefillFromParse(
  parsed: VoiceParseResultValidated,
  savedPlayers: { id: string; name: string }[],
  knownCourses: string[],
): TournamentPrefillPlan {
  const t = parsed.tournament;
  if (!t) {
    return {
      name: null,
      numRounds: 1,
      numRoundsRequested: 1,
      numRoundsClamped: false,
      selectedIds: [],
      customPlayerNames: [],
      notes: [],
      ackLine: "Didn't catch a tournament in that — fill it in below, or try again.",
    };
  }

  // The offline no-LLM parser always emits the literal sentinel "Tournament"
  // when it heard no actual name (lib/voice/pipeline.ts parseVoiceLocalBasic)
  // — never a real transcription. Treat that sentinel the same as "no name
  // heard": leave the form's own name (placeholder or user-typed) untouched
  // rather than clobbering it with a name the golfer never said. A genuinely
  // different name (e.g. from a future LLM-backed extractor) still flows
  // through and gets quoted normally.
  const rawName = t.name.trim();
  const name = rawName.length > 0 && rawName.toLowerCase() !== "tournament" ? rawName : null;

  const numRoundsRequested = t.numRounds;
  const numRounds = Math.max(1, Math.min(4, numRoundsRequested)) as 1 | 2 | 3 | 4;
  const numRoundsClamped = numRounds !== numRoundsRequested;

  const { selectedIds, customPlayerNames } = matchPlayers(t.playerNames, savedPlayers);

  const notes: string[] = [];
  if (t.courses.length > 0) {
    notes.push(
      `I heard ${t.courses.join(" then ")} — course order isn’t settable on this form yet; noted.`,
    );
  }
  if (t.groupings && t.groupings.length > 0) {
    notes.push("I heard groupings — pairings aren’t settable on this form yet; noted.");
  }
  if (t.handicapAdjustment) {
    notes.push("I heard a handicap adjustment — that isn’t settable on this form yet; noted.");
  }
  if (t.handicaps && Object.keys(t.handicaps).length > 0) {
    notes.push("I heard stroke allocations too — those aren’t settable on this form yet; noted.");
  }
  if (numRoundsClamped) {
    notes.push(
      numRoundsRequested > 4
        ? `I heard ${numRoundsRequested} rounds — capped at 4 (max).`
        : `I heard ${numRoundsRequested} rounds — set to 1 (minimum).`,
    );
  }

  const ackLine = buildAckLine({
    name,
    numRounds,
    totalPlayers: selectedIds.length + customPlayerNames.length,
    notes,
  });

  // knownCourses is unused today — the form has no course field to resolve
  // against yet (see the "courses" note above). Kept in the signature per
  // the contract so a future course surface doesn't need a signature change.
  void knownCourses;

  return { name, numRounds, numRoundsRequested, numRoundsClamped, selectedIds, customPlayerNames, notes, ackLine };
}

/** Exact case-insensitive match first, else fuzzy (0.76) against saved
 *  players. Unmatched names are staged as customPlayerNames, deduped
 *  case-insensitively against each other AND against matched saved names. */
function matchPlayers(
  playerNames: string[],
  savedPlayers: { id: string; name: string }[],
): { selectedIds: string[]; customPlayerNames: string[] } {
  const selectedIds: string[] = [];
  const matchedSavedLower = new Set<string>();
  const customPlayerNames: string[] = [];
  const seenCustomLower = new Set<string>();

  for (const raw of playerNames) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();

    const exact = savedPlayers.find((p) => p.name.toLowerCase() === lower);
    const matched =
      exact ?? (() => {
        const fuzzy = fuzzyBestMatch(trimmed, savedPlayers.map((p) => p.name), FUZZY_PLAYER_THRESHOLD);
        return fuzzy.match ? savedPlayers.find((p) => p.name === fuzzy.match) ?? null : null;
      })();

    if (matched) {
      if (!selectedIds.includes(matched.id)) selectedIds.push(matched.id);
      matchedSavedLower.add(matched.name.toLowerCase());
      continue;
    }

    if (matchedSavedLower.has(lower) || seenCustomLower.has(lower)) continue;
    seenCustomLower.add(lower);
    customPlayerNames.push(trimmed);
  }

  return { selectedIds, customPlayerNames };
}

/** Keep the ack calm (Northstar: quiet, not a wall of caveats) — surface at
 *  most this many note sentences; anything beyond gets a single short
 *  catch-all rather than stacking every caveat into one run-on paragraph.
 *  Nothing is silently dropped from the golfer's perspective — the
 *  catch-all still acknowledges more was heard. */
const MAX_ACK_NOTES = 2;

function buildAckLine(args: {
  name: string | null;
  numRounds: number;
  totalPlayers: number;
  notes: string[];
}): string {
  const landed: string[] = [];
  if (args.name) landed.push(`“${args.name}”`);
  landed.push(`${args.numRounds} round${args.numRounds === 1 ? "" : "s"}`);
  if (args.totalPlayers > 0) {
    landed.push(`${args.totalPlayers} player${args.totalPlayers === 1 ? "" : "s"}`);
  }

  const lead = `Filled it in — ${landed.join(", ")}.`;

  const shownNotes = args.notes.slice(0, MAX_ACK_NOTES);
  const droppedCount = args.notes.length - shownNotes.length;
  const catchAll =
    droppedCount > 0 ? " …and a couple other details I couldn’t set here." : "";
  const noteText = shownNotes.length > 0 ? ` ${shownNotes.join(" ")}${catchAll}` : "";

  return `${lead}${noteText} Tap Create when you’re ready.`;
}
