export type VoiceEndpoint = "/api/voice/parse-transcript" | "/api/voice/parse-scores";

export type VoiceParseSetupResult =
  | {
      type: "game";
      game: {
        format: string;
        name: string;
        teams?: { name: string; playerNames: string[] }[];
        playerNames: string[];
        handicaps?: Record<string, number>;
        settings?: Record<string, unknown>;
      };
      confidence: number;
    }
  | {
      type: "tournament";
      tournament: {
        name: string;
        numRounds: number;
        courses: string[];
        playerNames: string[];
        handicaps?: Record<string, number>;
      };
      confidence: number;
    };

export type VoiceParseScoresResult = {
  hole: number;
  scores: Record<string, number>;
  /** Derived confidence 0–1.  Undefined = treat as high (no amber cue shown). */
  confidence?: number;
  warnings?: string[];
};
