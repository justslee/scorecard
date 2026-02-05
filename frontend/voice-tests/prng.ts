// Deterministic PRNG utilities (no deps).
// mulberry32: https://stackoverflow.com/a/47593316

export function mulberry32(seed: number) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: () => number, minIncl: number, maxIncl: number) {
  return Math.floor(rng() * (maxIncl - minIncl + 1)) + minIncl;
}

export function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

export function maybe(rng: () => number, p = 0.5) {
  return rng() < p;
}

export function shuffle<T>(rng: () => number, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}
