/**
 * Voice testing scenario schema.
 *
 * This is designed for deterministic generation + fast execution.
 */

export type VoiceTestEndpoint = "parse-voice" | "parse-voice-scores";

export type VoiceTestContext = {
  /** e.g. "command-lane" */
  mode?: string;
  /** e.g. "setup" | "scoring" */
  screen?: string;

  knownPlayers?: string[];
  knownCourses?: string[];

  /** scoring context */
  hole?: number;
  par?: number;
};

export type VoiceScenario = {
  id: string;
  context: VoiceTestContext;
  utterance: string;
  endpoint: VoiceTestEndpoint;

  /** Subset of the expected *effect* (parsed JSON) */
  expectedEffect: Record<string, any>;

  /** Optional assertion for result.confidence */
  expectedConfidenceMin?: number;

  tags?: string[];
  notes?: string;

  /** Internal metadata (not part of the public schema). */
  __meta?: {
    seed?: number;
    index?: number;
    baseUtterance?: string;
    mutated?: boolean;
  };
};

export type RunnerOptions = {
  seed: number;
  count: number;
  smoke: boolean;
  endpoint?: VoiceTestEndpoint;
  concurrency: number;
  shrinkOnFailure: boolean;
  verbose: boolean;
  onlyTags?: string[];
  failFast: boolean;
};
