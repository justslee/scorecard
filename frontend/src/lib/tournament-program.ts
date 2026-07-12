// tournament-program.ts — pure copy/format helpers for the tournament setup
// page's "The Program" redesign (specs/tournament-redesign-plan.md). Extracted
// so vitest can import these without pulling in framer-motion / the rest of
// the client component tree — same reason tournament-standings.ts exists
// (see the comment at TournamentPageClient.tsx:73-77).

const NUMBER_WORDS: Record<number, string> = {
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
};

/** 1→"one" … 9→"nine"; anything else (0, 10+) falls back to String(n). */
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** "SATURDAY, JULY 12" — weekday, month, day; no year. */
export function formatProgramDate(d: Date): string {
  return d
    .toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    })
    .toUpperCase();
}

/**
 * Composing summary sentence. players < 1 → "" (caller hides it).
 * "A field of three, over two days."  ·  "A field of one, over one day."
 * players ≥ 10 → digits: "A field of 12, over two days."
 * rounds is 1–4 by construction (NUM_ROUNDS) so its word form always exists.
 */
export function fieldSummary(players: number, rounds: number): string {
  if (players < 1) return "";
  const playersWord = players < 10 ? numberWord(players) : String(players);
  const dayWord = rounds === 1 ? "day" : "days";
  return `A field of ${playersWord}, over ${numberWord(rounds)} ${dayWord}.`;
}

/**
 * Colophon. "2 DAYS · 3 ENTRANTS" · singulars "1 DAY · 1 ENTRANT".
 * Digits, not words (it is a mono spec line). players < 1 → "" (caller hides).
 */
export function colophonLine(rounds: number, players: number): string {
  if (players < 1) return "";
  const dayWord = rounds === 1 ? "DAY" : "DAYS";
  const entrantWord = players === 1 ? "ENTRANT" : "ENTRANTS";
  return `${rounds} ${dayWord} · ${players} ${entrantWord}`;
}

/** Ghost entry lines remaining: max(0, min(3, 4 - totalPlayers)).
 *  0→3, 1→3, 2→2, 3→1, ≥4→0 — cap 3, yields one-for-one, zero once field ≥ 4. */
export function ghostCount(totalPlayers: number): number {
  return Math.max(0, Math.min(3, 4 - totalPlayers));
}
