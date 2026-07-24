# Screenshot-fidelity proof — 3-5 simulator side-by-sides

**Not run this cycle** (the builder's contract scopes this build to the
offline framework only — no paid live run, no simulator drive). This is the
recipe the release/QA step follows once a LIVE pilot run has produced real
composites to compare against.

Purpose (specs/caddie-bench-plan.md §4): prove the `render.py` satellite
composite is close enough to what the owner actually screenshots in the app
— side-by-side with a real iOS Simulator screenshot of the SAME position on
Bethpage Red (the diag build's course).

## Prerequisites

- A completed LIVE pilot run under `tests/eval/caddie_bench/runs/<run_id>/`
  with `composites/*.png` for at least 3-5 Bethpage Red cases (hole 6 or 16 —
  the two Red holes in the pilot set).
- `ops/harness/oncourse-sim/README.md`'s Debug diagnostic build, which
  self-seeds a Bethpage Red round on simulator UDID
  `D4DB2397-D23A-4D55-A049-8E7D4B738E8D`. Follow that README's Step 1 (fixture
  regeneration, offline) and Step 2 (diagnostic patch + Debug build) verbatim
  — build products go to `/tmp/simspm` (this bench's own scratch dir,
  distinct from `/tmp/looper-spm` used elsewhere, per the builder's contract —
  never share build dirs between concurrent harnesses).

## Steps

1. **Pick 3-5 pilot cases** from the Red-hole subset of `runs/<run_id>/
   results.jsonl` — prefer a spread across lies (TEE, FAIRWAY, GREENSIDE) so
   the composite's overlay variety is exercised.

2. **For each chosen case**, read its `resolved.lat` / `resolved.lng` from
   the result JSONL line, then:
   ```bash
   xcrun simctl location D4DB2397-D23A-4D55-A049-8E7D4B738E8D set <lat>,<lng>
   # give the app a moment to re-render the map at the new position
   xcrun simctl io D4DB2397-D23A-4D55-A049-8E7D4B738E8D screenshot \
       /tmp/simspm/sim-<case_id>.png
   ```

3. **Montage** the simulator screenshot next to the bench's own
   `runs/<run_id>/composites/<case_id>.png` (e.g. `montage -tile 2x1
   -geometry +4+4 sim-<case_id>.png composites/<case_id>.png
   sim-vs-render-<n>.png`, or any equivalent side-by-side tool).

4. **Commit** the resulting montages to
   `specs/assets/caddie-bench/sim-vs-render-<n>.png` (only these 3-5 images —
   everything else under `runs/` stays gitignored) and embed them in
   `specs/caddie-bench-report-<date>.md`'s screenshot-fidelity section.

## What "close enough" means here

The composite is NOT expected to be pixel-identical to the real satellite
imagery the app renders (different tile provider framing/zoom) — the bar is:
same hole shape/orientation recognizable, hazard positions in the right
place relative to the player pin, and the yardage/wind/hole-header text
matching what a human would read off the real in-app screenshot. Material
disagreement (e.g. the player pin sitting in a visibly different lie than
the real screenshot shows) is a `geometry.py` bug, not a rendering nit — file
it against the sampler, not against this recipe.
