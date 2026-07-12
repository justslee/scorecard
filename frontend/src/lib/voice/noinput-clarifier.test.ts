// Tests for the no-input clarifier classifier
// (specs/caddie-noise-clarification-reply-plan.md). Pure module, no
// WebRTC/DOM — see realtime-noinput.test.ts for the handler-level wiring
// test.

import { describe, it, expect } from 'vitest';
import { isNoInputClarifier, couldBecomeClarifier, NOINPUT_RESOLVE_GRACE_MS } from './noinput-clarifier';

describe('isNoInputClarifier', () => {
  describe('suppress-eligible — hadRealUserInput=false, clarifier-shaped', () => {
    it('suppresses the canonical phrase', () => {
      expect(isNoInputClarifier("Didn't catch that — say again?", false)).toBe(true);
    });

    it('suppresses "Didn\'t quite catch that. Could you say that again?" (paraphrase)', () => {
      expect(isNoInputClarifier("Didn't quite catch that. Could you say that again?", false)).toBe(true);
    });

    it('suppresses "Sorry, come again?"', () => {
      expect(isNoInputClarifier('Sorry, come again?', false)).toBe(true);
    });

    it('suppresses "Say that one more time?"', () => {
      expect(isNoInputClarifier('Say that one more time?', false)).toBe(true);
    });

    it('suppresses "Sorry — I missed that. Say it again."', () => {
      expect(isNoInputClarifier('Sorry — I missed that. Say it again.', false)).toBe(true);
    });

    it('suppresses the curly-apostrophe variant of the canonical phrase', () => {
      expect(isNoInputClarifier('Didn’t catch that — say again?', false)).toBe(true);
    });

    it('suppresses "Pardon, run that by me again?"', () => {
      expect(isNoInputClarifier('Pardon, run that by me again?', false)).toBe(true);
    });
  });

  describe('never suppressed', () => {
    it('does NOT suppress the canonical phrase when hadRealUserInput=true (the gate)', () => {
      expect(isNoInputClarifier("Didn't catch that — say again?", true)).toBe(false);
    });

    it('does not suppress "You\'ve got 152 to the pin — smooth 8-iron." (substantive answer, digits)', () => {
      expect(isNoInputClarifier("You've got 152 to the pin — smooth 8-iron.", false)).toBe(false);
    });

    it('does not suppress "Driver. Favor the left side." (substantive answer)', () => {
      expect(isNoInputClarifier('Driver. Favor the left side.', false)).toBe(false);
    });

    it('does not suppress "Didn\'t catch the wind — it\'s calm out there." (real content mixed with ask-again words)', () => {
      expect(isNoInputClarifier("Didn't catch the wind — it's calm out there.", false)).toBe(false);
    });

    it('does not suppress "Say again — the driver or the 3-wood?" (contains digit)', () => {
      expect(isNoInputClarifier('Say again — the driver or the 3-wood?', false)).toBe(false);
    });

    it('does not suppress "Take one more club into this wind." (out-of-vocab word)', () => {
      expect(isNoInputClarifier('Take one more club into this wind.', false)).toBe(false);
    });

    it('does not suppress "Sorry about that." (no marker phrase)', () => {
      expect(isNoInputClarifier('Sorry about that.', false)).toBe(false);
    });

    it('does not suppress a 15+-word ramble containing a marker (length cap)', () => {
      const ramble =
        'I am so very sorry but I just could not quite catch that could you please say that again for me one more time';
      expect(ramble.trim().split(/\s+/).length).toBeGreaterThan(14);
      expect(isNoInputClarifier(ramble, false)).toBe(false);
    });

    it('does not suppress an empty string', () => {
      expect(isNoInputClarifier('', false)).toBe(false);
    });

    it('does not suppress a whitespace-only string', () => {
      expect(isNoInputClarifier('   ', false)).toBe(false);
    });

    it('does not suppress a string of only digits', () => {
      expect(isNoInputClarifier('152', false)).toBe(false);
    });
  });
});

describe('couldBecomeClarifier', () => {
  it('"" -> true (nothing to judge yet)', () => {
    expect(couldBecomeClarifier('')).toBe(true);
  });

  it('"Didn\'t" -> true (single vocab word)', () => {
    expect(couldBecomeClarifier("Didn't")).toBe(true);
  });

  it('"Didn\'t quite ca" -> true (last word is a prefix of a vocab word, "ca" -> "catch"/"can")', () => {
    expect(couldBecomeClarifier("Didn't quite ca")).toBe(true);
  });

  it('"You\'ve" -> false (out-of-vocab word, not a prefix of any vocab word)', () => {
    expect(couldBecomeClarifier("You've")).toBe(false);
  });

  it('the full canonical phrase -> true', () => {
    expect(couldBecomeClarifier("Didn't catch that — say again?")).toBe(true);
  });

  it('a partial substantive answer with a digit -> false', () => {
    expect(couldBecomeClarifier("You've got 15")).toBe(false);
  });

  it('a run-on partial exceeding the word cap -> false', () => {
    const longPartial =
      'I am so very sorry but I just could not quite catch that could you please';
    expect(couldBecomeClarifier(longPartial)).toBe(false);
  });
});

describe('NOINPUT_RESOLVE_GRACE_MS', () => {
  it('is 2000ms', () => {
    expect(NOINPUT_RESOLVE_GRACE_MS).toBe(2000);
  });
});
