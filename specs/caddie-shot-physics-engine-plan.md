# Caddie shot-distance physics engine — implementation plan

*Slice 3 of specs/caddie-physics-engine.md ("the big one"). Owner directive
(2026-07-09, 4-screenshot session): the caddie told the owner a 300-yard drive
with 4 mph downwind and 38 ft downhill "plays about 392 / total around 390."
"Ground those on actual physics + math. Write very complex physics equations if
we have to. Add a physics component to all this."*

SCOPE: the SHOT-DISTANCE engine only — what one shot carries, rolls, and totals
under real conditions, and what a target "plays like." Green-slope spatial
reasoning (green_geometry.py), bend distance, and tree CV are separate queued
items in the epic; §13 notes the interfaces, this plan does not design them.

---

## 1. The bug, precisely (two independent failures)

**Failure A — wrong operand.** The plays-like adjustment was applied to the
390-yard PIN distance instead of the player's 300-yard DRIVE. Root cause: the
only "effective distance" the system exposes is `HoleIntelligence.effective_yards`
(pin-relative, whole-hole elevation), surfaced via `get_conditions`'
`plays_like` block (backend/app/caddie/tools.py, `conditions_payload`). The LLM
had no tool that answers "what does MY shot do here," so it improvised
arithmetic on the number it had. The fix is structural, not prompt-side: a
`get_shot_distance` tool that computes per-shot, plus a grounding rule
forbidding the model from doing distance arithmetic itself (the exact pattern
that fixed hazards: geometry is ground truth, the model is a writer).

**Failure B — toy model.** Current math, verified:
- `effective_yards = yards + round(elevation_change_ft / 3)`
  (backend/app/caddie/course_intel.py:169) — 1 yd per 3 ft, club-independent,
  applied to the pin.
- `playsLikeYards` (frontend/src/lib/map/wind.ts): ±0.8%/0.5% per mph on the
  head component, capped ±15%, no flight-time/club/spin dependence, crosswind
  discarded.
- `compute_adjustments` (backend/app/caddie/club_selection.py): the same
  rules-of-thumb stacked additively (elevation /3, wind %, 2 yd/10°F,
  2%/1000 ft altitude, ±2–3% firmness).

None of these distinguish CARRY from ROLL. A downhill drive gains mostly
through longer flight to lower ground AND extra roll-out on a downslope —
effects that depend on the club's descent angle and landing speed, which a
scalar fudge cannot represent.

## 2. Modeling decision — hybrid, player-anchored

Full RK4 numerical integration of the flight ODEs + a calibrated closed-form
roll model, used DIFFERENTIALLY (reverse-fit to the player's own stored club
distance so systematic aero error cancels; no launch monitor needed). RK4
chosen over closed-form because every correction term a closed form needs
(descent-angle coupling, wind-roll interaction, elevation geometry) is exactly
what the current toy model gets wrong. CPU: <2 ms/trajectory, <40 ms/cold tool
call — negligible vs the 6 s tool timeout. Roll stays closed-form (turf
mechanics is genuinely messy; false precision to integrate it).

## 3-13. (full technical content)

See the executive summary committed alongside; the full equations (drag
F_d=½ρC_d(S)Av² on airspeed u=v−w, Magnus F_L=½ρC_l(S)Av²(ŝ×û), spin-ratio
coefficients, exponential spin decay, RK4 dt=0.01 s, elevation-plane
termination, Magnus-humidity air density, reverse-fit launch priors from
CLUB_REFERENCE, the roll model with the −sin γ downslope term), the tool
contract (get_shot_distance: {club|target_yards,hole_number} →
{carry,total,plays_like_yards,breakdown,assumptions[]}), PHYSICS_GROUNDING_RULE
in both mouths, the course_intel.py:169 + compute_adjustments alignment, the
12-row unit-test table, the eval-harness teeth (the 315-330 incident scenario),
and the 13-step ordered build checklist are captured in the Fable plan report
(session transcript) and reproduced here as the authoritative build spec.

## The worked incident case (proof)
300 driver, 4 mph tail, −38 ft downhill: neutral carry 277 + roll 23 → under
conditions carry ≈298 (tail +5-6, downhill flight +16 via Δh/tan(descent), NOT
naive 1yd/3ft) + roll ≈29 (downslope + hotter landing) → TOTAL ≈326, band
315-330 — NOT 390. The 390 pin, run through the same engine's plays-like solve,
plays like ≈358-365 (SHORTER, opposite sign of the caddie's "plays 392"). Both
failures die structurally.

## Ordered steps
1. physics.py atmosphere + RK4 core (+ monotonicity/determinism tests)
2. CLUB_REFERENCE table + calibration test pinning Cd/Cl (±4y/row)
3. reverse-fit to stored distances (secant + lru_cache)
4. roll model calibrated to roll-fraction targets
5. shot_distance_for_club / plays_like_target — INCIDENT TEST (315-330) passes here
6. tool registration + resolve_tool branch (tool_loop unchanged)
7. realtime parity: POST /session/shot-distance + frontend dispatch
8. PHYSICS_GROUNDING_RULE in both prompt builders
9. course_intel.py:169 → physics elevation-only plays-like
10. compute_adjustments delegates to physics (get_recommendation can't contradict)
11. eval teeth: SHOT_DISTANCE_IN_BAND check + RED-proof mutant + 3 golden scenarios
12. frontend playsLikeYards deprecation comment
13. budgeted Tier-2 run

Second slice flagged: tiles consuming backend plays-like, gust/wind-profile,
wedge spin-back, lie effects, carry/total profile flag.
