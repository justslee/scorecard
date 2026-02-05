import { z } from "zod";

// Keep schemas permissive enough for model output, then normalize.

export const GameFormatSchema = z.enum([
  "skins",
  "nassau",
  "bestBall",
  "matchPlay",
  "stableford",
  "wolf",
  "threePoint",
  "scramble",
]);

export const GameSettingsSchema = z
  .object({
    handicapped: z.boolean().optional(),
    pointValue: z.number().nonnegative().optional(),
    carryover: z.boolean().optional(),
    matchPlayMode: z.enum(["individual", "teams"]).optional(),
    matchPlayPlayers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export const ParsedGameConfigSchema = z
  .object({
    format: GameFormatSchema,
    name: z.string().min(1),
    teams: z
      .array(
        z.object({
          name: z.string().optional().default(""),
          playerNames: z.array(z.string().min(1)).default([]),
        })
      )
      .optional(),
    playerNames: z.array(z.string().min(1)).default([]),
    handicaps: z.record(z.string(), z.number().nonnegative()).optional(),
    settings: GameSettingsSchema.default({}),
  })
  .strict();

export const HandicapAdjustmentSchema = z
  .object({
    type: z.enum(["half-divergence", "fixed", "none"]),
    description: z.string().optional().default(""),
  })
  .strict();

export const ParsedTournamentConfigSchema = z
  .object({
    name: z.string().min(1),
    numRounds: z.number().int().positive(),
    courses: z.array(z.string().min(1)).default([]),
    playerNames: z.array(z.string().min(1)).default([]),
    groupings: z.array(z.array(z.string().min(1))).optional(),
    handicaps: z.record(z.string(), z.number().nonnegative()).optional(),
    handicapAdjustment: HandicapAdjustmentSchema.optional(),
  })
  .strict();

export const VoiceParseResultSchema = z
  .object({
    type: z.enum(["game", "tournament"]),
    game: ParsedGameConfigSchema.optional(),
    tournament: ParsedTournamentConfigSchema.optional(),
    confidence: z.number().min(0).max(1),
    // New fields for better UX; optional to keep backwards compatibility.
    explanations: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
    // What we normalized from/to.
    normalization: z
      .object({
        players: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              score: z.number().min(0).max(1),
            })
          )
          .optional(),
        courses: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              score: z.number().min(0).max(1),
            })
          )
          .optional(),
      })
      .optional(),
  })
  .strict();

export type VoiceParseResultValidated = z.infer<typeof VoiceParseResultSchema>;

export const VoiceScoreParseResultSchema = z
  .object({
    hole: z.number().int().positive(),
    scores: z.record(z.string(), z.number().int().nonnegative()),
    confidence: z.number().min(0).max(1).optional(),
    explanations: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

export type VoiceScoreParseResultValidated = z.infer<
  typeof VoiceScoreParseResultSchema
>;
