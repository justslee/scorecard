# Caddie hazard grounding — real geometry, no invented bunkers

Owner escalation (2026-07-06): the caddie said "260 to the left bunker" on a hole with NO left bunker. LEAN fix — NOT the paused P3 epic (no carries/DECADE/polygon raycasting).

## Root cause (recon-verified)
1. The realtime orb has ZERO hazard grounding: `build_realtime_instructions` (voice_prompts.py) includes handicap/clubs/weather/hole number — no hazards; neither get_conditions nor get_recommendation returns hazards. Asked about trouble, the model invents feature + confident yardage.
2. The one existing hazard source is fuzzy: `/course-intel` derives hazards from a live Overpass fetch (radius 2000m) classified relative to the GREEN. The curated per-hole bunker/water polygons in PostGIS (`hole_features`, course_spatial.py) never reach the caddie brain.
3. `_BASE_BEHAVIOR` bans invented numbers-from-tools but not invented FEATURES.

Key seam: `/course-intel` receives round_id; `session.course_id` = round.mappedCourseId ?? courseId; `courses_mapped.get_course(course_id)` returns per-hole FeatureCollections. Extract hazards server-side there and cache into `session.hole_intel[n].hazards` — BOTH mouths already read from that. **No frontend changes.**

## New module: backend/app/caddie/hazards.py (pure, unit-testable)

```
extract_hole_hazards(features, *, tee=None, green=None, cap=5) -> list[Hazard]
format_hazards_line(hole_number, hazards) -> str
HAZARD_GROUNDING_RULE: str
```

### extract_hole_hazards
1. Derive tee & green from the FeatureCollection (green/tee polygon centroids via `_ring_centroid`; fallback: `hole` LineString endpoints first=tee last=green; last resort: the tee=/green= args). Neither derivable → return [] (never guess a bearing).
2. For each feature with featureType in {bunker, water}: centroid via `_ring_centroid` (Points direct).
3. Tee→green line math (equirectangular meters via `_deg_to_m` idiom, → yards):
   - unit vector û along tee→green; hazard vector h = centroid − tee.
   - carry_yards = dot(h, û) × 1.09361, rounded to nearest 5, negatives clamped to 0.
   - line_side = sign of cross(û, h) (positive=LEFT of travel direction — pin the convention in a unit test) with a 10y lateral deadband → "center".
4. Fill legacy green-relative fields (distance_from_green, side=line_side, penalty_severity: water="death", bunker="moderate") so the offline HoleIntelBundle and existing consumers keep working.
5. Sort by carry_yards, cap 5.

### format_hazards_line
Group by (type, line_side); single → `bunker L 245y`; multiple → range `bunker L 230-260y`; bunker before water, nearer first, groups capped at 5. Output: `Hole 4 hazards: bunker L 245y, water R 190-230y`. Empty → "" (caller omits the line; absence triggers the generic-language rule).

### Edge cases (all unit-tested)
No bunker/water → []; hazard on the line → center; par-3 short line valid; hazard beyond green keeps true tee distance; clustered same-side bunkers merge to a range; missing tee OR green → []; yards rounded to 5 (no false precision).

## Wiring — both paths

A. **routes/caddie.py::get_course_intel**: after resolving the owned session, if session.course_id → `store.get_course(course_id)`, index holes by number; after build_hole_intelligence, REPLACE intel.hazards with extract_hole_hazards(fc, tee=, green=) when a stored FeatureCollection exists (replace, not merge — curated data must not be polluted by Overpass strays). Unmapped holes keep existing behavior. Existing set_hole_intel cache write carries it into the session JSONB.

B. **Realtime orb**: (1) voice_prompts._situation_block appends format_hazards_line for current_hole when hazards exist; (2) _BASE_BEHAVIOR gains HAZARD_GROUNDING_RULE; (3) get_conditions endpoint response gains `hazards` (model_dump list) + preformatted `hazards_line`; update the get_conditions tool description in realtime_relay.DEFAULT_TOOLS (returns real hazards; model must not name hazards absent from the list).

C. **CaddieSheet session text path** (routes/caddie.py::session_voice): replace the green-relative hazard_strs with format_hazards_line; append HAZARD_GROUNDING_RULE to the inline INSTRUCTIONS block (import the shared constant — no wording drift). Apply the same rule line to the legacy stateless /voice handler.

### HAZARD_GROUNDING_RULE
> Only name a specific hazard (bunker, water, trees) or a yardage to one if it appears in the hazard data provided for this hole. If no hazard data is given for the hole, do not invent one: speak generally about where to miss ("trouble left", "keep it right-center", "bail out short") and never state a specific feature with a distance (e.g. never "a bunker at 260 on the left") unless it is in the data.

## Files
NEW: backend/app/caddie/hazards.py + backend/tests/test_hazards.py.
EDIT (backend only): backend/app/caddie/types.py (Hazard += carry_yards: int = 0, line_side: str = "center" — additive/defaulted, no migration); backend/app/routes/caddie.py; backend/app/caddie/voice_prompts.py; backend/app/services/realtime_relay.py (tool description); backend/tests/test_realtime_tools.py.

## Tests (deterministic, no LLM)
test_hazards.py: synthetic hole (tee poly, green ~300y downrange, bunker left ~245y, water right 190-230y) → exactly those two hazards, correct line_side + carry_yards (±5y), NO phantom third hazard; on-line hazard → center; par-3; same-side range merge + cap; empty → [] and "".
test_realtime_tools.py: instructions contain HAZARD_GROUNDING_RULE; situation block contains the exact compact line given seeded hole_intel hazards; no-hazard hole → directive present, no fabricated feature.

## Gates
Backend: ruff + full pytest (primary — backend-only change). Verify useRealtimeCaddie.ts forwards raw get_conditions JSON (doesn't strip unknown fields) and TS types accept the two new optional Hazard fields — additive-optional design chosen to avoid frontend gates; if a type rejects, that pulls in tsc/lint/voice-smoke. /code-review yes; /security-review NOT triggered (no new endpoint/auth/dep; hazard data is server-derived from our own PostGIS).

## Rejected
Frontend-shipped centroids (backend already has them by course_id); keep Overpass hazards + add distances (fuzzy phantom source, not a fix); P3 raycasting/DECADE (paused); merge stored+Overpass (pollution); prompt-only hardening (the escalation's exact point); new get_hazards tool (get_conditions is the natural home).
