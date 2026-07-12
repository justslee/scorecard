import { describe, it, expect } from 'vitest';
import { decideBackSwipe, isDisqualified, isEdgeStart, type BackSwipeSample } from './backSwipeGesture';

describe('isEdgeStart', () => {
  it.each([0, 12, 24])('returns true for startX %d at safeAreaLeft 0', (startX) => {
    expect(isEdgeStart(startX, 0)).toBe(true);
  });

  it('returns false for startX 25 at safeAreaLeft 0', () => {
    expect(isEdgeStart(25, 0)).toBe(false);
  });

  it('returns true for startX 80 at safeAreaLeft 59 (landscape notch)', () => {
    expect(isEdgeStart(80, 59)).toBe(true);
  });

  it('returns false for startX 84 at safeAreaLeft 59', () => {
    expect(isEdgeStart(84, 59)).toBe(false);
  });
});

describe('decideBackSwipe', () => {
  const base: BackSwipeSample = {
    startX: 0,
    startY: 100,
    endX: 0,
    endY: 100,
    elapsedMs: 0,
    viewportWidth: 400,
    safeAreaLeft: 0,
  };

  it("'back' for a fast flick (dx 80, dy 10, 300ms)", () => {
    const s: BackSwipeSample = { ...base, endX: 80, endY: 110, elapsedMs: 300 };
    expect(decideBackSwipe(s)).toBe('back');
  });

  it("'back' for a long, slow drag (dx 0.4×vw, 1500ms)", () => {
    const s: BackSwipeSample = { ...base, endX: 0.4 * base.viewportWidth, elapsedMs: 1500 };
    expect(decideBackSwipe(s)).toBe('back');
  });

  it("'back' at the exact fast-flick boundary (dx 70 @ 599ms)", () => {
    const s: BackSwipeSample = { ...base, endX: 70, elapsedMs: 599 };
    expect(decideBackSwipe(s)).toBe('back');
  });

  it("'ignore' for a leftward swipe (dx -80)", () => {
    const s: BackSwipeSample = { ...base, endX: -80, elapsedMs: 300 };
    expect(decideBackSwipe(s)).toBe('ignore');
  });

  it("'ignore' for a vertical-dominant swipe (dx 80, dy 60)", () => {
    const s: BackSwipeSample = { ...base, endX: 80, endY: 160, elapsedMs: 300 };
    expect(decideBackSwipe(s)).toBe('ignore');
  });

  it("'ignore' when the start is outside the edge zone (startX 40)", () => {
    const s: BackSwipeSample = { ...base, startX: 40, endX: 120, elapsedMs: 300 };
    expect(decideBackSwipe(s)).toBe('ignore');
  });

  it("'ignore' for a short+slow drag that fails both arms (dx 71 @ 900ms, 0.35×vw > 71)", () => {
    // viewportWidth 400 → 0.35×vw = 140, well above dx 71.
    const s: BackSwipeSample = { ...base, endX: 71, elapsedMs: 900 };
    expect(decideBackSwipe(s)).toBe('ignore');
  });

  it("'ignore' for zero movement", () => {
    expect(decideBackSwipe(base)).toBe('ignore');
  });
});

describe('isDisqualified', () => {
  it('returns true for dy 40 / dx 10 (vertical scroll from the edge)', () => {
    expect(isDisqualified(0, 0, 10, 40)).toBe(true);
  });

  it('returns false for dy 20 / dx 5 (under the 30px vertical floor)', () => {
    expect(isDisqualified(0, 0, 5, 20)).toBe(false);
  });

  it('returns false for dy 50 / dx 80 (horizontal-dominant despite dy > 30)', () => {
    expect(isDisqualified(0, 0, 80, 50)).toBe(false);
  });
});
