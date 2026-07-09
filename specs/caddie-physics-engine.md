# Caddie physics & spatial-reasoning engine

*Owner directive 2026-07-09 (4-screenshot session): "the caddie is fluent but not
grounded." It states physics it can't compute — 300y drive + 4mph downwind + 38ft
downhill ≠ 390. Green-slope→putt-side reasoning is wrong until hand-held. Trees/bend
unmapped. "Add a physics component to all this. Write very complex physics equations if
we have to."*

Root cause: the caddie has a LANGUAGE model, not a WORLD model. It narrates physics from
naive arithmetic. Fix = deterministic engines the LLM CITES, never computes itself
(same pattern that fixed hazards: geometry is ground truth, the model is a writer).

## Current state (verified, both broken)
- Elevation: `effective_yards = yards + round(elevation_change_ft / 3)` (course_intel.py)
  — a flat 1yd/3ft rule, applied to PIN distance regardless of shot.
- Wind: `playsLikeYards` — capped ±15% linear fudge on head component; no ball-speed,
  spin, or flight-time dependence.
- The "390 drive" bug: the plays-like adjustment was applied to the 390 pin distance,
  not the player's 300 drive; and a downhill DRIVE gains through ROLL, not carry.

## P1 — Shot-distance physics engine (backend/app/caddie/physics.py)
A real (documented, unit-tested) ball-flight model. Inputs: club/player carry+total
baseline (from club_distances), launch/spin priors per club, air density (temp, altitude,
humidity → ρ), wind VECTOR (not just head component), elevation delta, lie.
- **Carry** from a projectile+drag+lift integration (or a well-fit reduced model —
  the plan picks: full RK4 trajectory vs an empirically-fit closed form; both are
  legitimate, the closed form is cheaper and calibratable). Wind adjusts carry via
  time-of-flight × wind component; elevation adjusts via extra fall time.
- **Roll** modeled separately (firmness prior; downhill adds roll, into-wind steepens
  descent and kills roll). THE DRIVE FIX lives here: a downhill drive's extra yards are
  mostly roll.
- Output: {carry, total, plays_like_to_target} with the ASSUMPTIONS surfaced (so the
  caddie says "≈315 with the slope and helping wind, mostly extra roll" — honest, bounded).
- Calibrate against known references (a scratch driver ~290 carry; the elevation
  rule-of-thumb ~2yd/1000ft-of-altitude and the 1yd/3ft as a SANITY BAND, not the model).
- Exposed as a caddie TOOL (`get_shot_distance`) so both mouths compute, never guess;
  eval-harness scenarios: the exact 300/downwind/downhill case must yield a sane total
  (315-330, NOT 390).

## P1 — Green-slope spatial reasoning (backend/app/caddie/green_geometry.py)
Deterministic "which side leaves the uphill putt" from the slope vector + player view.
- Slope stored as a vector/aspect; rotate into the player's tee→green frame → LEFT/RIGHT
  relative to the golfer (never "west"). The hazard-side polyline frame already does this.
- Rule engine: slope-falls-left ⇒ LEFT is the low side ⇒ a miss/leave on the fall side sits
  BELOW the hole ⇒ that miss leaves the UPHILL putt (miss/leave the high side ⇒ downhill,
  the one to avoid). [Corrected 2026-07-09 — the original chain here read "approach miss
  RIGHT ⇒ uphill putt", which is the HIGH/downhill side and physically backwards; see
  specs/caddie-green-slope-spatial-plan.md §0 for the full derivation and the resolution.]
  A pure function + test table for all aspects; the LLM CITES its output ("leave it left,
  that's your uphill putt") and is forbidden from deriving putt-break geometry itself.
- Eval scenarios: slope-left → recommends a LEFT-side (fall-side/low-side) leave for an
  uphill putt (the exact chain the owner hand-walked, corrected per §0 above).

## P2 — Bend distance (free from existing geometry)
The hole polyline (now stored) has vertices; the dogleg = the max-deviation vertex from
the tee→green chord. Compute along-path distance to it; expose as intel + a tool answer
("the fairway bends right at ~250"). No ML, no new data.

## P2 — Tree detection (satellite CV)
Trees aren't in OSM. Feasibility: canopy segmentation on the ESRI/Google satellite tile
is a solved CV task — pretrained tree-canopy/land-cover models exist (no custom training
to start). POC: run a pretrained segmentation model over the hole's tile at ingest,
extract canopy polygons near the fairway corridor, store as `tree`-type features → the
caddie gets tree carry/clearance distances via the same hazard path. HONEST fallback
stays ("trees aren't mapped here") until coverage is real. Cost/latency: one inference
per hole at ingest (like the guide research), cached forever.

## P1 (small) — Remove the seeded user-voice question
The auto opening posts the QUESTION in the player's voice ("I'm on the tee, about 390…")
then live-mode doesn't cleanly answer it. Fix: the caddie OPENS with the recommendation
in ITS OWN voice (caddie turn, not a synthesized user turn) — keep the auto-reco value,
drop the fake user message. buildOpeningTurnText → the opening becomes an assistant-side
briefing seeded server-side, not a user bubble.

## Sequencing
1. Remove seeded question (small, ship fast).
2. Green-slope spatial engine (contained, high-embarrassment bug).
3. Shot physics engine (the big one — Fable plan; calibration + tool + eval teeth).
4. Bend distance (cheap, geometry).
5. Tree CV POC (research → spike).

All engines are TOOLS the caddie cites; the eval harness gets teeth cases from THIS
session's exact failures. Physics is deterministic and testable — the caddie stops
narrating physics and starts reporting it.
