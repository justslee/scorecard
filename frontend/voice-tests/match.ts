export type MatchResult = { ok: true } | { ok: false; reason: string };

function isObject(x: unknown): x is Record<string, any> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/**
 * Deep subset match:
 * - primitives: ===
 * - objects: expected keys must exist and match
 * - arrays: expected elements must be present in actual (order/extra elements ignored)
 */
export function subsetMatch(actual: unknown, expected: unknown, path = "$"): MatchResult {
  if (expected === undefined) return { ok: true };

  // null and primitives
  if (expected === null || typeof expected !== "object") {
    if (actual === expected) return { ok: true };
    return {
      ok: false,
      reason: `${path}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`,
    };
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return { ok: false, reason: `${path}: expected array got ${typeof actual}` };
    }

    // Subset semantics:
    // - if expected are primitives: each must appear in actual (as a set)
    // - if expected are objects/arrays: each expected element must match at least one actual element
    for (let i = 0; i < expected.length; i++) {
      const e = expected[i];
      const isPrimitive = e === null || typeof e !== "object";
      if (isPrimitive) {
        const ok = actual.some((a) => a === e);
        if (!ok) {
          return {
            ok: false,
            reason: `${path}: missing expected element ${JSON.stringify(e)} in ${JSON.stringify(actual)}`,
          };
        }
        continue;
      }

      let found = false;
      for (let j = 0; j < actual.length; j++) {
        const r = subsetMatch(actual[j], e, `${path}[${i}]`);
        if (r.ok) {
          found = true;
          break;
        }
      }
      if (!found) {
        return {
          ok: false,
          reason: `${path}: missing expected element at index ${i} (${JSON.stringify(e)})`,
        };
      }
    }

    return { ok: true };
  }

  if (!isObject(actual) || !isObject(expected)) {
    return { ok: false, reason: `${path}: expected object got ${typeof actual}` };
  }

  for (const [k, v] of Object.entries(expected)) {
    const r = subsetMatch((actual as any)[k], v, `${path}.${k}`);
    if (!r.ok) return r;
  }
  return { ok: true };
}
