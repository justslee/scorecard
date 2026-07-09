# Multi-tee anchor reconciliation — "from the tee" ≠ card yardage

*Owner 2026-07-09 (screenshot, Bethpage hole 3): the top-right card says 178Y (par 3),
the F/C/B tiles labeled "FROM THE TEE" show Center ~231 / Plays 245. A 53-67y gap that
shouldn't exist on a par 3, where tee→center-green IS the card number.*

## Diagnosis (prod-verified, read-only)
Hole 3 stores **5 tee boxes** with wildly different distances to the green:
`232y, 207y, 174y, 159y, 136y`. The header card (178Y) matches the **174y tee**; the
"FROM THE TEE" tiles anchor to the **232y back tee** (the geometry picks tee box [0] /
the back-most, regardless of which tee the player is on). Top-level `tee`/`green` coords
are None and `yardages` is empty on this hole — so the two surfaces derive from different
sources that disagree:
- header 178Y ← scorecard/round data (the tee the player picked)
- F/C/B "from the tee" ← our OSM geometry, arbitrary tee box (232)

## The fix
Anchor BOTH the "from the tee" F/C/B AND the plays-like to the SAME tee the player
selected at round start (the app already knows the chosen tee — the colored tee-marker
feature placed it). Concretely:
1. Map the player's selected tee (front/middle/back or the named set) to the nearest
   stored OSM tee box (by name/ref match, else by matching the card yardage to the tee
   box whose distance-to-green is closest — the 174y box for a 178 card).
2. Use THAT tee box as `holeCoordsForTiles.tee` for the "from the tee" F/C/B and plays-like
   (frontend/src/app/round/[id]/RoundPageClient.tsx — currently picks the first/back tee).
3. Reconcile the header: if the card yardage and the anchored tee→green disagree by >~8%,
   prefer the card yardage's tee (they should now agree by construction).
4. When the player has a live GPS fix on the hole, the rangefinder ("from where you stand")
   already overrides — this fix is for the no-fix / pre-shot "from the tee" state.
5. Honest fallback: if no tee can be matched, show the card yardage and label the tiles
   from the card, never a contradictory geometry number.

## Tests
- Hole-3 fixture: selected 174y tee → tiles ≈ card 178 (not 232).
- Tee-box selection: named-tee match, then card-yardage-nearest fallback.
- The >8% reconciliation guard; honest fallback when no tee matches.

Needs a Fable plan (the selected-tee → OSM-tee-box mapping is the crux; the round already
carries the chosen tee — thread it through). Geometry-correctness item: full adversarial
review per lessons.md (this is the third geometry-anchor incident after hazards + doglegs).
