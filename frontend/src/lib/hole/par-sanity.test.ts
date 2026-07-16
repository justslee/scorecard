/**
 * Unit tests for par-sanity.ts — the display-side par-vs-yardage guard
 * (specs/map-fieldtest-v119-plan.md Item 5, Red-11 "PAR 3 · 462Y" fix).
 *
 * Pure — no browser APIs. Run: cd frontend && npx vitest run src/lib/hole/par-sanity.test.ts
 */

import { describe, it, expect } from 'vitest';
import { displayPar, PAR_SANITY_MIN_YARDS_FOR_PAR3 } from './par-sanity';

describe('displayPar — suppresses an implausible par-3 rather than printing a false par', () => {
  it('displayPar(3, 462) -> suppressed (null) — Red-11 field-test case', () => {
    expect(displayPar(3, 462)).toBeNull();
  });

  it('displayPar(3, 180) -> 3 — a legitimate short par 3 is unaffected', () => {
    expect(displayPar(3, 180)).toBe(3);
  });

  it('displayPar(4, 462) -> 4 — non-par-3 never suppressed, regardless of yardage', () => {
    expect(displayPar(4, 462)).toBe(4);
  });

  it('displayPar(5, 620) -> 5 — non-par-3 never suppressed', () => {
    expect(displayPar(5, 620)).toBe(5);
  });

  it('the threshold is exactly 280y (matches backend PAR_SANITY_MIN_YARDS_FOR_PAR3) — 280 itself is NOT suppressed, 281 is', () => {
    expect(PAR_SANITY_MIN_YARDS_FOR_PAR3).toBe(280);
    expect(displayPar(3, 280)).toBe(3);
    expect(displayPar(3, 281)).toBeNull();
  });

  it('yards == null -> not suppressed (no evidence against the stored par yet)', () => {
    expect(displayPar(3, null)).toBe(3);
  });

  it('par == null -> passes through null unchanged', () => {
    expect(displayPar(null, 462)).toBeNull();
  });
});
