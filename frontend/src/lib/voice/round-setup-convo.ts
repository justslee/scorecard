// Pure decision logic for the conversational (agentic) round setup.
//
// The backend (/api/voice/parse-round-setup) merges each spoken turn and returns
// what's still missing + the caddie's next question. This turns one such response
// into the next UI step — keep asking, or proceed — with a hard cap so we never
// loop forever. Kept pure so it's unit-tested without the mic/network.

export interface ConvoConfig {
  courseName: string;
  playerNames: string[];
  teeName?: string;
}

/** Shape of the backend parse-round-setup response (agentic fields included). */
export interface SetupParseResponse {
  courseName?: string;
  playerNames?: string[];
  teeName?: string | null;
  missing?: string[];
  followUpQuestion?: string | null;
  complete?: boolean;
}

/** After this many follow-up questions, proceed with whatever we have rather
 *  than badgering the golfer — they can still fix fields on the setup screen. */
export const MAX_FOLLOWUP_TURNS = 4;

/** Which field the next answer should fill, so the backend can bias parsing. */
export function expectingFromMissing(
  missing: string[] | undefined,
): "course" | "players" | undefined {
  if (!missing || missing.length === 0) return undefined;
  if (missing.includes("course")) return "course";
  if (missing.includes("players")) return "players";
  return undefined;
}

export type ConvoStep =
  | { kind: "complete"; config: ConvoConfig }
  | {
      kind: "ask";
      config: ConvoConfig;
      question: string;
      expecting: "course" | "players" | undefined;
    };

/**
 * Decide what to do after a parse turn. `turns` = follow-ups asked so far.
 * Proceeds (complete) when the backend says so, when there's no question to ask,
 * or when the follow-up cap is reached — otherwise asks the next question.
 */
export function nextConvoStep(
  res: SetupParseResponse,
  turns: number,
): ConvoStep {
  const config: ConvoConfig = {
    courseName: res.courseName ?? "",
    playerNames: res.playerNames ?? [],
    teeName: res.teeName ?? undefined,
  };
  if (res.complete || !res.followUpQuestion || turns >= MAX_FOLLOWUP_TURNS) {
    return { kind: "complete", config };
  }
  return {
    kind: "ask",
    config,
    question: res.followUpQuestion,
    expecting: expectingFromMissing(res.missing),
  };
}
