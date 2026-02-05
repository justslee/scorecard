export function isObject(x: any): x is Record<string, any> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

/** Deep subset match: expected must be contained in actual. */
export function deepSubset(actual: any, expected: any, path = "$"): string[] {
  const errs: string[] = [];

  if (expected === undefined) return errs;

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected array, got ${typeof actual}`];
    // subset rule for arrays: expected items must equal actual at same index
    for (let i = 0; i < expected.length; i++) {
      errs.push(...deepSubset(actual[i], expected[i], `${path}[${i}]`));
    }
    return errs;
  }

  if (isObject(expected)) {
    if (!isObject(actual)) return [`${path}: expected object, got ${typeof actual}`];
    for (const [k, v] of Object.entries(expected)) {
      errs.push(...deepSubset(actual[k], v, `${path}.${k}`));
    }
    return errs;
  }

  if (actual !== expected) {
    errs.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  return errs;
}
