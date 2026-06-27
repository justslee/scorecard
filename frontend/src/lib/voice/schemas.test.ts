/**
 * Unit tests for the Zod schemas in lib/voice/schemas.ts.
 *
 * Covers valid and invalid shapes for VoiceScoreParseResultSchema,
 * VoiceParseResultSchema (game + tournament paths), GameFormatSchema,
 * and related nested schemas (ParsedGameConfigSchema, handicap bounds, etc.).
 *
 * DO NOT modify lib/voice/* or schemas.ts to make tests pass.
 */

import { describe, it, expect } from 'vitest';
import {
  VoiceScoreParseResultSchema,
  VoiceParseResultSchema,
  GameFormatSchema,
  ParsedGameConfigSchema,
  ParsedTournamentConfigSchema,
} from './schemas';

// ---------------------------------------------------------------------------
// GameFormatSchema
// ---------------------------------------------------------------------------

describe('GameFormatSchema', () => {
  const valid = ['skins', 'nassau', 'bestBall', 'matchPlay', 'stableford', 'wolf', 'threePoint', 'scramble'];

  it.each(valid.map((f) => [f]))('accepts format "%s"', (fmt) => {
    expect(GameFormatSchema.safeParse(fmt).success).toBe(true);
  });

  it('rejects an unknown format string', () => {
    expect(GameFormatSchema.safeParse('bingo').success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(GameFormatSchema.safeParse('').success).toBe(false);
  });

  it('rejects a number', () => {
    expect(GameFormatSchema.safeParse(42).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VoiceScoreParseResultSchema
// ---------------------------------------------------------------------------

describe('VoiceScoreParseResultSchema', () => {
  describe('valid inputs', () => {
    it('accepts a minimal valid result', () => {
      const r = VoiceScoreParseResultSchema.safeParse({ hole: 1, scores: { Justin: 4, Bob: 5 } });
      expect(r.success).toBe(true);
    });

    it('accepts an empty scores map', () => {
      const r = VoiceScoreParseResultSchema.safeParse({ hole: 1, scores: {} });
      expect(r.success).toBe(true);
    });

    it('accepts result with all optional fields populated', () => {
      const r = VoiceScoreParseResultSchema.safeParse({
        hole: 3,
        scores: { Justin: 4 },
        confidence: 0.9,
        explanations: ['Parsed via heuristics.'],
        warnings: [],
      });
      expect(r.success).toBe(true);
    });

    it('accepts score value of 0 (nonneg int)', () => {
      const r = VoiceScoreParseResultSchema.safeParse({ hole: 1, scores: { Justin: 0 } });
      expect(r.success).toBe(true);
    });

    it('accepts confidence at boundary values 0 and 1', () => {
      expect(VoiceScoreParseResultSchema.safeParse({ hole: 1, scores: {}, confidence: 0 }).success).toBe(true);
      expect(VoiceScoreParseResultSchema.safeParse({ hole: 1, scores: {}, confidence: 1 }).success).toBe(true);
    });

    it('produces parsed data with correct types', () => {
      const r = VoiceScoreParseResultSchema.safeParse({ hole: 5, scores: { Bob: 3 }, confidence: 0.8 });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.hole).toBe(5);
        expect(r.data.scores['Bob']).toBe(3);
        expect(r.data.confidence).toBe(0.8);
      }
    });
  });

  describe('invalid inputs', () => {
    it('rejects hole = 0 (must be positive)', () => {
      expect(VoiceScoreParseResultSchema.safeParse({ hole: 0, scores: {} }).success).toBe(false);
    });

    it('rejects negative hole', () => {
      expect(VoiceScoreParseResultSchema.safeParse({ hole: -1, scores: {} }).success).toBe(false);
    });

    it('rejects non-integer hole (float)', () => {
      expect(VoiceScoreParseResultSchema.safeParse({ hole: 1.5, scores: {} }).success).toBe(false);
    });

    it('rejects negative score value', () => {
      expect(VoiceScoreParseResultSchema.safeParse({ hole: 1, scores: { Justin: -1 } }).success).toBe(false);
    });

    it('rejects fractional score value', () => {
      expect(VoiceScoreParseResultSchema.safeParse({ hole: 1, scores: { Justin: 4.5 } }).success).toBe(false);
    });

    it('rejects confidence > 1', () => {
      expect(VoiceScoreParseResultSchema.safeParse({ hole: 1, scores: {}, confidence: 1.01 }).success).toBe(false);
    });

    it('rejects confidence < 0', () => {
      expect(VoiceScoreParseResultSchema.safeParse({ hole: 1, scores: {}, confidence: -0.1 }).success).toBe(false);
    });

    it('rejects missing hole field', () => {
      expect(VoiceScoreParseResultSchema.safeParse({ scores: { Justin: 4 } }).success).toBe(false);
    });

    it('rejects missing scores field', () => {
      expect(VoiceScoreParseResultSchema.safeParse({ hole: 1 }).success).toBe(false);
    });

    it('rejects extra (unknown) fields — strict schema', () => {
      expect(
        VoiceScoreParseResultSchema.safeParse({ hole: 1, scores: {}, unknownField: 'bad' }).success
      ).toBe(false);
    });

    it('rejects null', () => {
      expect(VoiceScoreParseResultSchema.safeParse(null).success).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// ParsedGameConfigSchema
// ---------------------------------------------------------------------------

describe('ParsedGameConfigSchema', () => {
  const minimal = { format: 'skins', name: 'Skins', playerNames: [], settings: {} };

  it('accepts a minimal valid game config', () => {
    expect(ParsedGameConfigSchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts a config with optional handicaps', () => {
    const r = ParsedGameConfigSchema.safeParse({
      ...minimal,
      handicaps: { Justin: 5, Bob: 12 },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a config with teams', () => {
    const r = ParsedGameConfigSchema.safeParse({
      ...minimal,
      playerNames: ['Justin', 'Bob', 'Mike', 'Sam'],
      teams: [
        { name: 'Team 1', playerNames: ['Justin', 'Bob'] },
        { name: 'Team 2', playerNames: ['Mike', 'Sam'] },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty name (min(1))', () => {
    expect(ParsedGameConfigSchema.safeParse({ ...minimal, name: '' }).success).toBe(false);
  });

  it('rejects unknown format', () => {
    expect(ParsedGameConfigSchema.safeParse({ ...minimal, format: 'disc-golf' }).success).toBe(false);
  });

  it('rejects negative handicap value (nonneg constraint)', () => {
    expect(
      ParsedGameConfigSchema.safeParse({ ...minimal, handicaps: { Justin: -2 } }).success
    ).toBe(false);
  });

  it('rejects extra fields — strict schema', () => {
    expect(ParsedGameConfigSchema.safeParse({ ...minimal, extraKey: 'x' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ParsedTournamentConfigSchema
// ---------------------------------------------------------------------------

describe('ParsedTournamentConfigSchema', () => {
  const minimal = { name: 'Club Champ', numRounds: 2, courses: [], playerNames: [] };

  it('accepts a minimal valid tournament config', () => {
    expect(ParsedTournamentConfigSchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts a config with groupings and handicaps', () => {
    const r = ParsedTournamentConfigSchema.safeParse({
      ...minimal,
      playerNames: ['Justin', 'Bob'],
      handicaps: { Justin: 3 },
      groupings: [['Justin', 'Bob']],
    });
    expect(r.success).toBe(true);
  });

  it('rejects numRounds = 0 (must be positive)', () => {
    expect(ParsedTournamentConfigSchema.safeParse({ ...minimal, numRounds: 0 }).success).toBe(false);
  });

  it('rejects non-integer numRounds', () => {
    expect(ParsedTournamentConfigSchema.safeParse({ ...minimal, numRounds: 2.5 }).success).toBe(false);
  });

  it('rejects empty tournament name', () => {
    expect(ParsedTournamentConfigSchema.safeParse({ ...minimal, name: '' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VoiceParseResultSchema
// ---------------------------------------------------------------------------

describe('VoiceParseResultSchema', () => {
  describe('valid game results', () => {
    const baseGame = {
      type: 'game' as const,
      game: { format: 'skins', name: 'Skins', playerNames: ['Justin', 'Bob'], settings: {} },
      confidence: 0.8,
    };

    it('accepts a valid game result', () => {
      expect(VoiceParseResultSchema.safeParse(baseGame).success).toBe(true);
    });

    it('accepts confidence at boundary (0 and 1)', () => {
      expect(VoiceParseResultSchema.safeParse({ ...baseGame, confidence: 0 }).success).toBe(true);
      expect(VoiceParseResultSchema.safeParse({ ...baseGame, confidence: 1 }).success).toBe(true);
    });

    it('accepts optional explanations and warnings arrays', () => {
      const r = VoiceParseResultSchema.safeParse({
        ...baseGame,
        explanations: ['Parsed via heuristics.'],
        warnings: ['Low confidence.'],
      });
      expect(r.success).toBe(true);
    });

    it('accepts a normalization field with player remapping', () => {
      const r = VoiceParseResultSchema.safeParse({
        ...baseGame,
        normalization: {
          players: [{ from: 'justn', to: 'Justin', score: 0.9 }],
        },
      });
      expect(r.success).toBe(true);
    });

    it('accepts a matchPlay game with settings', () => {
      const r = VoiceParseResultSchema.safeParse({
        type: 'game',
        game: {
          format: 'matchPlay',
          name: 'Match Play',
          playerNames: ['Justin', 'Bob'],
          settings: {
            handicapped: false,
            matchPlayMode: 'individual',
            matchPlayPlayers: { player1: 'Justin', player2: 'Bob' },
          },
        },
        confidence: 0.8,
      });
      expect(r.success).toBe(true);
    });
  });

  describe('valid tournament results', () => {
    it('accepts a minimal tournament result', () => {
      const r = VoiceParseResultSchema.safeParse({
        type: 'tournament',
        tournament: {
          name: 'Club Championship',
          numRounds: 2,
          courses: ['Pebble Beach'],
          playerNames: ['Justin', 'Bob'],
        },
        confidence: 0.7,
      });
      expect(r.success).toBe(true);
    });

    it('accepts a tournament with optional normalization', () => {
      const r = VoiceParseResultSchema.safeParse({
        type: 'tournament',
        tournament: { name: 'Tourney', numRounds: 1, courses: [], playerNames: [] },
        confidence: 0.6,
        normalization: {
          courses: [{ from: 'pebble', to: 'Pebble Beach', score: 0.88 }],
        },
      });
      expect(r.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects unknown type string', () => {
      expect(
        VoiceParseResultSchema.safeParse({ type: 'round', confidence: 0.5 }).success
      ).toBe(false);
    });

    it('rejects confidence > 1', () => {
      expect(
        VoiceParseResultSchema.safeParse({
          type: 'game',
          game: { format: 'skins', name: 'T', playerNames: [], settings: {} },
          confidence: 1.1,
        }).success
      ).toBe(false);
    });

    it('rejects confidence < 0', () => {
      expect(
        VoiceParseResultSchema.safeParse({
          type: 'game',
          game: { format: 'skins', name: 'T', playerNames: [], settings: {} },
          confidence: -0.01,
        }).success
      ).toBe(false);
    });

    it('rejects extra top-level fields — strict schema', () => {
      expect(
        VoiceParseResultSchema.safeParse({
          type: 'game',
          game: { format: 'skins', name: 'T', playerNames: [], settings: {} },
          confidence: 0.5,
          extra: 'bad',
        }).success
      ).toBe(false);
    });

    it('rejects a game config with empty name', () => {
      expect(
        VoiceParseResultSchema.safeParse({
          type: 'game',
          game: { format: 'skins', name: '', playerNames: [], settings: {} },
          confidence: 0.5,
        }).success
      ).toBe(false);
    });

    it('rejects a tournament with numRounds = 0', () => {
      expect(
        VoiceParseResultSchema.safeParse({
          type: 'tournament',
          tournament: { name: 'T', numRounds: 0, courses: [], playerNames: [] },
          confidence: 0.5,
        }).success
      ).toBe(false);
    });

    it('rejects negative handicap in game config', () => {
      expect(
        VoiceParseResultSchema.safeParse({
          type: 'game',
          game: {
            format: 'skins',
            name: 'Skins',
            playerNames: ['Justin'],
            handicaps: { Justin: -2 },
            settings: {},
          },
          confidence: 0.8,
        }).success
      ).toBe(false);
    });

    it('rejects null', () => {
      expect(VoiceParseResultSchema.safeParse(null).success).toBe(false);
    });
  });
});
