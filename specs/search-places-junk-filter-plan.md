# Search: Places Junk-Venue Filter Plan

## Problem

Searching a famous course name (e.g. "Pebble Beach") surfaces near-junk non-course rows from Google Places: "Pebble Beach Pro Shop" (store), gift shops, restaurants/grills, golf academies, and lodges that sit at or near the course. These are legitimate Places venues but are NOT golf courses, so they pollute course-search results. Pebble Beach is now live in prod, making this timely.

Goal: the Places leg of course search should hard-drop the *unambiguous* non-course venue and downrank the *ambiguous* one, while never touching a real course.

## Hard constraints (do not regress)

- Prefix-first relevance stays intact. `course_finder.matches_query_prefix` (the gate) and `course_finder.rank_courses` (the tiering) are preserved. The new penalty is a NEW LOWEST-PRIORITY tie-break inside the existing tier tuple, added *after* exact/prefix/local and never reordering those.
- NEVER filter out a real course. Prefer DOWNRANK over hard-drop when ambiguous. Hard-drop ONLY when the venue is unambiguously non-course (primaryType is a clearly non-golf type AND `golf_course` is not among `types`).
- `golf_course` type ALWAYS wins: if `golf_course` is in the place's `types`, keep it and apply zero penalty, regardless of name.
- Deterministic and offline-testable. No live Places calls in tests.
- Small, contained, backend-only, silent-leaning change.

## Current state (read before building)

- `backend/app/services/course_finder.py` — `search_google_places` (lines ~187-255) builds each result dict. The FieldMask (`X-Goog-FieldMask`, lines ~217-220) currently requests only `places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri,places.rating` — it does NOT request `places.types` or `places.primaryType`. The request body already sets `"includedType": "golf_course"` (line 222), which biases but does not guarantee course-only results. `matches_query_prefix` (~77), `rank_courses` (~101), `LOCAL_SOURCES` (~40).
- `backend/app/routes/course_search.py` — `/api/courses/search`. Places is the PRIMARY external leg via `_search_google_places` → `course_finder.search_google_places`. GolfAPI is a metered fallback that only runs `if not places` (line 285). Ranking happens at line 323 via `course_finder.rank_courses(gated, q, anchor=anchor)`.
- `backend/app/services/tee_times/affiliate.py` (line 98) — the OTHER caller of `search_google_places`, with query `f"golf courses near {query.area}"`. It uses `places[0]["center"]` as an anchor and returns `dedupe_by_name(places)`. Any change to `search_google_places` must be additive/safe for this caller.
- `backend/tests/test_course_search.py` — test conventions: route called directly, all seams monkeypatched, representative payloads, `pytest`/`monkeypatch`, async tests.

## Design

### 1. New pure classifier in `course_finder.py`

Add module-level constants and a pure function. All are additive; place them near the relevance/ranking block (after `rank_courses`, before the write-through section) so they live with the other pure, unit-tested helpers.

**Constants:**

```python
# Positive signal: a Places "types" entry that confirms a real golf course.
_GOLF_COURSE_TYPES: frozenset[str] = frozenset({"golf_course"})

# primaryType / types values that mark a clearly non-golf venue. When the
# PRIMARY type is one of these AND golf_course is absent from types, the row
# is an unambiguous non-course venue -> hard-drop.
_NON_COURSE_PRIMARY_TYPES: frozenset[str] = frozenset({
    "store", "clothing_store", "shopping_mall", "gift_shop",
    "restaurant", "cafe", "coffee_shop", "bar", "meal_takeaway",
    "meal_delivery", "food",
    "lodging", "hotel", "resort_hotel", "motel", "bed_and_breakfast",
    "spa", "wellness_center",
})

# Softer name heuristics: substrings that SUGGEST a non-course venue. Used only
# to DOWNRANK (never to drop), and only when golf_course is NOT in types.
_NON_COURSE_NAME_SUBSTRINGS: tuple[str, ...] = (
    "pro shop", "gift shop", "grill", "restaurant", "academy",
    "lodge", "spa", "cafe",
)
```

**Function:**

```python
def classify_place_venue(name: str, types, primary_type) -> str:
    """Classify a Google Places result into a venue class for course search.

    Returns one of:
      "course"      -- golf_course present in types (never dropped, never penalized)
      "non_course"  -- unambiguous non-golf venue -> caller should HARD-DROP
      "ambiguous"   -- name heuristic suggests non-course but types don't
                       confirm -> caller should DOWNRANK, never drop

    Pure: no I/O, deterministic. `types` is the place's types list (may be None
    / empty for non-Places sources); `primary_type` is places.primaryType (may
    be None). Name/type matching is case- and whitespace-normalized.
    """
```

**Exact logic (in order):**

1. Normalize: `type_set = {t.strip().lower() for t in (types or [])}`; `pt = (primary_type or "").strip().lower()`; `folded_name = _fold(name or "")` (reuse existing `_fold`, which lowercases + strips accents/apostrophes). Note `_fold` does not collapse internal whitespace, so also apply `" ".join(folded_name.split())` before substring checks so `"pro   shop"` matches `"pro shop"`.
2. **golf_course immunity:** if `_GOLF_COURSE_TYPES & type_set` (i.e. `"golf_course" in type_set`) -> return `"course"`. This is checked FIRST, so a place typed as a golf course is never dropped or penalized no matter its name or primaryType.
3. **Unambiguous non-course (hard-drop):** if `pt in _NON_COURSE_PRIMARY_TYPES` (and golf_course already ruled out in step 2) -> return `"non_course"`. Rationale: primaryType is Google's single best classification; when it is a store/restaurant/lodging/etc. and golf_course is absent, it is not a course.
4. **Ambiguous (downrank):** if any substring in `_NON_COURSE_NAME_SUBSTRINGS` appears in the normalized name -> return `"ambiguous"`. This is the softer signal: name says "Pro Shop"/"Grill"/"Academy"/"Lodge" but the types didn't confirm a non-course primaryType.
5. Default -> return `"course"` (treat as a course; do not penalize).

**Edge cases (spell out expected behavior):**

- "Pebble Beach Golf Links", types include `golf_course` -> step 2 -> `"course"`, kept, zero penalty, sorts with real courses.
- "Pebble Beach Pro Shop", primaryType `store` (or `clothing_store`), no golf_course -> step 3 -> `"non_course"`, hard-dropped.
- A standalone "... Gift Shop", primaryType `store`/`gift_shop`, no golf_course -> step 3 -> `"non_course"`, hard-dropped.
- "Pebble Beach Golf Academy" — if types include `golf_course` -> `"course"` (immunity wins). If not, and primaryType is e.g. `establishment`/`point_of_interest` (not in the non-course set), the name substring "academy" -> step 4 -> `"ambiguous"`, downranked, NOT dropped. This is the deliberate downrank-not-drop bias: a driving-range/academy could be a legitimate result the owner still wants visible, just below the real course.
- "The Lodge at Pebble Beach" — if primaryType is `lodging`/`hotel` and no golf_course -> step 3 -> `"non_course"`, dropped (it is a hotel). If types are ambiguous (no lodging primaryType) but name contains "lodge" -> step 4 -> `"ambiguous"`, downranked. Either outcome keeps it out of the top slot.
- A legit course whose `types` happen to omit `golf_course` and whose name is clean (no substring hit) and whose primaryType is not in the non-course set (e.g. `point_of_interest`) -> step 5 -> `"course"`, kept unpenalized. This protects real courses that Google typed loosely.

### 2. Where classification is applied

**(a) In `search_google_places` (course_finder.py):**

- Extend the FieldMask to also request `places.types,places.primaryType`:
  ```
  "places.id,places.displayName,places.formattedAddress,"
  "places.location,places.websiteUri,places.rating,"
  "places.types,places.primaryType"
  ```
- In the result loop (lines ~236-249), read `types = p.get("types")` and `primary_type = p.get("primaryType")`, then call `cls = classify_place_venue(name, types, primary_type)`.
- If `cls == "non_course"`: `continue` (skip the row — hard-drop at the source).
- Otherwise append the row as today, plus a new additive field `"venue_penalty": 1 if cls == "ambiguous" else 0`. Do NOT add `types`/`primaryType` to the emitted dict (they are internal classification inputs, not needed downstream and not part of the wire shape). Keep every existing field (`id`, `name`, `address`, `center`, `website`, `rating`, `source`) unchanged.

This keeps the classification logic entirely within the Places leg, where the types data exists.

**(b) In `rank_courses` (course_finder.py):**

- Add the penalty as the LOWEST-priority element of the sort key, so prefix-first ordering is fully preserved and non-golf venues sort below real courses only within an otherwise-equal tier. Current key:
  `(exact, prefix, local, dist, _fold(name))`
  New key:
  `(exact, prefix, local, venue_penalty, dist, _fold(name))`
  where `venue_penalty = c.get("venue_penalty") or 0`. Position rationale: penalty sits AFTER `local` (so a real local/mapped course always outranks an ambiguous external venue) and BEFORE `dist`/alpha (so among external hits at the same relevance tier, the ambiguous "…Academy"/"…Lodge" sorts below the clean course). It never affects `exact`/`prefix`, so `'Bethpa' -> Bethpage only` and the tiering are untouched.
- `venue_penalty` defaults to `0` for local/osm/golfapi/mapbox rows (they never set the field), so those sources are unaffected.

**(c) Shared-callsite safety (`tee_times/affiliate.py`):**

- The change is safe and beneficial for the affiliate caller: hard-dropping obvious non-course venues from `search_google_places` means `places[0]["center"]` is more likely to anchor on a real course, and `dedupe_by_name(places)` simply returns fewer junk rows. The new `venue_penalty` field is additive and ignored by that caller (it doesn't rank). No change needed in affiliate.py. No gating flag required — the behavior is universally correct for "find real golf courses."

**(d) Route interaction — metered GolfAPI fallback:**

- In `course_search.py`, the fallback fires `if not places` (line 285). If the junk filter drops ALL Places rows to `[]` (e.g. a query that only matched a pro shop), the GolfAPI discovery leg would then fire, consuming one call from its 45-calls/month budget. This is acceptable and generally desirable: an all-junk Places result means we genuinely have no course from Places, so trying the coverage backstop is correct. The realistic exposure is tiny — a famous course query returns the real course (typed `golf_course`) alongside the junk, so `places` is non-empty and the fallback does NOT fire. Document this in the PR so it is a known, intended interaction, not a surprise. No code change needed at the route; the existing `if not places` semantics are preserved.

### 3. Verification gates the builder runs

- `cd backend && ruff check .` — lint clean.
- `cd backend && python -m pytest tests/test_course_search.py -q` — existing suite green plus new cases below.
- New deterministic tests (add to `backend/tests/test_course_search.py`, or a sibling `test_places_venue_filter.py`). Two groups:

  **Pure classifier tests** (call `course_finder.classify_place_venue` directly, no monkeypatch):
  - golf_course type present + junk name ("Pebble Beach Pro Shop", types `["golf_course"]`) -> `"course"` (immunity).
  - "Pebble Beach Pro Shop", primaryType `"store"`, types `["store","point_of_interest"]` -> `"non_course"`.
  - standalone gift shop, primaryType `"gift_shop"` (or `"store"`), no golf_course -> `"non_course"`.
  - "Pebble Beach Golf Academy", primaryType `"point_of_interest"`, no golf_course -> `"ambiguous"`.
  - "The Lodge at Pebble Beach", primaryType `"lodging"`, no golf_course -> `"non_course"`; and a variant with a non-lodging primaryType but "lodge" in the name -> `"ambiguous"`.
  - clean course name, no golf_course in types, benign primaryType -> `"course"`.
  - whitespace/case normalization: `"PEBBLE BEACH PRO   SHOP"` still classifies via the "pro shop" substring.

  **`search_google_places` integration tests** (monkeypatch the HTTP POST at the seam used by existing tests, feeding a representative `data["places"]` payload; assert on the returned list — offline, deterministic):
  - Payload with a real course (`golf_course` type) + a pro shop (`store`) + a gift shop (`store`) -> returned list contains ONLY the real course (junk hard-dropped), and its `venue_penalty` is `0`.
  - Payload with a real course + a "…Golf Academy" (no golf_course type) -> both returned; academy row has `venue_penalty == 1`; then feed both through `course_finder.rank_courses(..., q)` and assert the real course sorts first.
  - FieldMask assertion: verify the request headers include `places.types` and `places.primaryType` (guards against silently dropping the mask fields).
  - If mocking `httpx` at the venue level is heavier than the existing test style prefers, the classifier + `rank_courses` penalty tier can be covered purely (classifier tests above + a `rank_courses` ordering test that sets `venue_penalty` on input dicts), keeping full coverage without new network seams. Prefer whichever approach matches existing conventions best.

  **`rank_courses` penalty-tier test:** three input dicts at the same relevance/local tier — a clean external course (`venue_penalty` unset), an ambiguous one (`venue_penalty=1`), and a local course — assert order: local first, clean external second, ambiguous external last; and assert a `golf_course`-immune / exact-name match still leads regardless of penalty (penalty never overrides exact/prefix/local).

- Note: backend DB integration tests run in CI (no local Postgres), so the builder does not run them locally — the unit tests above fully cover this change since it is pure/plumbing.
- Frontend gates are unaffected (no frontend change): lint/tsc/voice-tests unchanged, not run for this task.

### 4. Shared-type / wire-shape sync (`types.ts` <-> `models.py`)

- No shared-type change. This is backend-internal search plumbing. The client-facing course result shape (`id`, `name`, `address`, `center`, `source`) is unchanged. `places.types`/`places.primaryType` are consumed internally by the classifier and NOT emitted to the client. `venue_penalty` is an internal ranking hint on the intermediate dict and is not part of the documented API contract; it does not need to appear in `types.ts`/`models.py`. The route returns the ranked dicts directly; extra keys are already tolerated today (e.g. `website`/`rating` flow through), so `venue_penalty` is harmless. Leave it.

### 5. Risks and mitigations

Relevance regressions are THE risk.

- **Over-aggressive hard-drop hides a real course.** Mitigation: hard-drop is gated on primaryType in non-course set AND golf_course absent; golf_course immunity is checked first; ambiguous name-only signals downrank instead of drop. A real course typed `golf_course` (the common case for famous courses) is structurally immune.
- **Name-heuristic false positives on real course names** (e.g. a course legitimately named "… Grill Golf Club" or "… Academy" that is a real course). Mitigation: name heuristics only DOWNRANK, never drop, and golf_course-typed rows are immune to the name path entirely. Worst case an ambiguous real course sorts one tie-break lower, still visible.
- **Triggering the metered GolfAPI fallback** when the filter empties `places`. Mitigation: for famous-course queries the real course survives (golf_course type), so `places` stays non-empty and the fallback does not fire; the only time it fires is a genuinely course-less Places result, where trying the backstop is the correct behavior. Documented as intended.
- **FieldMask regression** (forgetting to carry `places.types`/`places.primaryType` would make everything classify as `"course"` — silently disabling the filter). Mitigation: explicit test asserting the FieldMask includes both fields.
- **Prefix-first / tiering regression.** Mitigation: penalty is appended as the lowest-priority key element after exact/prefix/local; a dedicated `rank_courses` test asserts exact/prefix/local always dominate the penalty.

## Files to touch

- `backend/app/services/course_finder.py` — add `classify_place_venue` + the three constant sets; extend the Places FieldMask with `places.types,places.primaryType`; drop `non_course` rows and tag `venue_penalty` in `search_google_places`; add the `venue_penalty` element to the `rank_courses` sort key.
- `backend/tests/test_course_search.py` (or a new sibling `backend/tests/test_places_venue_filter.py`) — classifier unit tests, `search_google_places` filter tests, and the `rank_courses` penalty-tier test.

No changes required to `backend/app/routes/course_search.py`, `backend/app/services/tee_times/affiliate.py`, or any frontend/shared-type file.
