export type VoiceEndpoint = "/api/parse-voice" | "/api/parse-voice-scores";

export type VoiceParseSetupResult =
  | {
      type: "game";
      game: {
        format: string;
        name: string;
        teams?: { name: string; playerNames: string[] }[];
        playerNames: string[];
        handicaps?: Record<string, number>;
        settings?: Record<string, any>;
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
};
