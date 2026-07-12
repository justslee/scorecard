// Tests for the priming-echo classifier (specs/caddie-context-leak-plan.md).
// Pure module, no WebRTC/DOM — see realtime-warm.test.ts for the
// handler-level wiring test.

import { describe, it, expect } from 'vitest';
import { isPrimingEcho } from './priming-echo';

describe('isPrimingEcho', () => {
  describe('dropped — the transcriber echoing its own transcription.prompt', () => {
    it('drops the raw owner string verbatim (branch A: both signature labels)', () => {
      const transcript =
        "Player's clubs: GW, LW, PW, SW, Driver. This hole: trees, trees, trees, bunker, bunker, trees, trees. " +
        'Golf vocabulary: birdie, bogey, double bogey, eagle, albatross, mulligan, gimme, up and down, fairway, ' +
        'tee box, pitching wedge, sand wedge, lob wedge, gap wedge, hybrid, 3-wood, 5-wood, driver, putter, ' +
        'yardage, dogleg, carry, layup, pin high.';
      expect(isPrimingEcho(transcript)).toBe(true);
    });

    it('drops the natural paraphrase (branch A: both signature phrases survive rewording)', () => {
      const transcript =
        "The player's clubs for this hole include a GW, LW, PW, SW, and a Driver. This hole is surrounded by " +
        'trees and has multiple bunkers. Golf vocabulary related to this hole includes birdie, bogey, double ' +
        'bogey, eagle, albatross, mulligan, gimme, up and down, fairway, tee box.';
      expect(isPrimingEcho(transcript)).toBe(true);
    });

    it('drops a label-free full-vocabulary enumeration (branch B: keyterm density, no signature phrase)', () => {
      const transcript =
        'birdie, bogey, double bogey, eagle, albatross, mulligan, gimme, up and down, fairway, tee box, ' +
        'pitching wedge, sand wedge, lob wedge, gap wedge, hybrid, 3-wood, 5-wood, driver, putter, yardage, ' +
        'dogleg, carry, layup, pin high';
      expect(isPrimingEcho(transcript)).toBe(true);
    });

    it('drops "This hole: trees, trees, trees, bunker, bunker." (branch C: pure hazard-list echo)', () => {
      expect(isPrimingEcho('This hole: trees, trees, trees, bunker, bunker.')).toBe(true);
    });

    it('drops the golf-vocab-only setup echo (golf_baseline_prompt shape)', () => {
      const transcript =
        'Golf vocabulary: birdie, bogey, double bogey, eagle, albatross, mulligan, gimme, up and down, fairway, ' +
        'tee box, pitching wedge, sand wedge, lob wedge, gap wedge, hybrid, 3-wood, 5-wood, driver, putter, ' +
        'yardage, dogleg, carry, layup, pin high.';
      expect(isPrimingEcho(transcript)).toBe(true);
    });
  });

  describe('not dropped — real golfer speech', () => {
    it('does not drop "what club for this bunker?"', () => {
      expect(isPrimingEcho('what club for this bunker?')).toBe(false);
    });

    it('does not drop "I hit driver 250"', () => {
      expect(isPrimingEcho('I hit driver 250')).toBe(false);
    });

    it('does not drop "gimme range?"', () => {
      expect(isPrimingEcho('gimme range?')).toBe(false);
    });

    it('does not drop "how far to carry the water"', () => {
      expect(isPrimingEcho('how far to carry the water')).toBe(false);
    });

    it('does not drop a dense adversarial turn (~7 distinct keyterms, no signature phrase, not a pure hazard list)', () => {
      const transcript =
        "should I hit driver or 3-wood, or lay up with the hybrid — don't want a double bogey, need to carry " +
        'the fairway bunker and stay pin high';
      expect(isPrimingEcho(transcript)).toBe(false);
    });

    it('does not drop "that\'s a double bogey, no gimme"', () => {
      expect(isPrimingEcho("that's a double bogey, no gimme")).toBe(false);
    });

    it('does not drop "trees and bunker" (2-segment hazard answer, below the 3-segment floor)', () => {
      expect(isPrimingEcho('trees and bunker')).toBe(false);
    });

    it('does not drop "bunker"', () => {
      expect(isPrimingEcho('bunker')).toBe(false);
    });

    it('does not drop an empty string', () => {
      expect(isPrimingEcho('')).toBe(false);
    });

    it('does not drop a whitespace-only string', () => {
      expect(isPrimingEcho('   ')).toBe(false);
    });
  });
});
