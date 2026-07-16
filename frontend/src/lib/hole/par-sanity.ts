/**
 * par-sanity — display-side guard against an implausible stored par (owner
 * field-test incident: Bethpage Red-11 showed "PAR 3 · 462Y" — no real par 3
 * plays 280+ yards from any normal tee). Defense only: the PRIMARY fix is
 * correcting the stored data (a sanctioned course re-ingest); this guard
 * just stops the header from confidently printing a par it can prove is
 * wrong, for THIS hole or any future one with the same stale-data class of
 * bug (specs/map-fieldtest-v119-plan.md Item 5).
 *
 * Threshold kept in lockstep with the caddie's own guard
 * (`backend/app/caddie/voice_prompts.py:PAR_SANITY_MIN_YARDS_FOR_PAR3 = 280`)
 * — same 280y floor, same "par 3 only" scope, so the map header and the
 * caddie's spoken/written note never disagree about which holes are
 * suspect. If that constant ever changes, update this one to match.
 */

/** Mirrors backend `PAR_SANITY_MIN_YARDS_FOR_PAR3` — keep numerically equal. */
export const PAR_SANITY_MIN_YARDS_FOR_PAR3 = 280;

/**
 * Returns `par` unless it's a physically implausible par-3 (par === 3 and
 * yards > 280), in which case it returns `null` — the caller renders an
 * honest "—" instead of asserting a false "3". `yards == null` (unknown) is
 * NOT suppressed — there's no evidence against the stored par yet.
 *
 * Pure function — no side effects, headless-testable.
 */
export function displayPar(par: number | null, yards: number | null): number | null {
  if (par === 3 && yards != null && yards > PAR_SANITY_MIN_YARDS_FOR_PAR3) return null;
  return par;
}
