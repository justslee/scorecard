# Aim-point: hazard-aware recommendation line on the reachable branch

**File under change:** `backend/app/caddie/aim_point.py` (plus tests).
**Bug class:** the LAST flag-only remnant of the [[caddie-shot-context-reachability]] family.
**Owner repro (Augusta 12):** a 155y par-3 (reachable) with water carrying center ~140y,
bunker center ~148y, bunker left ~165y — all present in the hole's `hazards` /
`carries_payload` / `format_hazards_line`. Today the RECOMMENDATION line in the strategy
ground-truth block (`strategy.py::format_strategy_ground_truth`, ~line 214, reachable
turns take the `aim_point.description` path) says **"Aim at the flag — green light, no
trouble"**, directly contradicting the hazards line two lines below it.

**Root cause:** `classify_pin_position` (aim_point.py ~81) escalates ONLY on
`penalty_severity in ("severe","death") AND distance_from_green <= 10`, or any `death`
hazard. Tee/approach CARRY hazards live in the tee-anchored `carry_yards` frame (the
frame `hazards.py::format_hazards_line`, `tools.py::carries_payload`, and
`decade_advice.py::drive_zone_hazards` all use) and do not trip that green-frame gate —
so `compute_aim_point` (~115) falls through to the hardcoded green-light string (~132).

**Fix philosophy:** evidence-driven, not tone-driven. When carry-relevant hazards exist
between the player and the green, the aim line must (a) never claim "no trouble" /
"green light", (b) name the governing carry (bound to a payload hazard's own
`carry_yards`) or the safe miss-side per the per-side evidence, (c) stay consistent with
`compute_miss_side` by construction. A genuinely clean hole must STILL say green light,
byte-identical to today. Calm, voice-readable, one number (NORTHSTAR).

---

## 1. Approach: the en-route predicate, where it lives, signature changes

### 1.1 New pure helper: `en_route_carry_hazards`

Add to `aim_point.py`, immediately after `classify_pin_position`:

```python
def en_route_carry_hazards(
    hazards: list[Hazard],
    hole_yards: Optional[int],
    distance_yards: int,
) -> Optional[list[Hazard]]:
    """Hazards between the player and the green in the tee-anchored
    `carry_yards` frame (the SAME frame drive_zone_hazards / carries_payload /
    format_hazards_line use — hazards.py's along-played-line number).

    Returns:
      []    — no carry-frame evidence, or every carry hazard is provably NOT
              between the player and the green (behind the player, or past the
              green). Caller keeps today's behavior verbatim.
      [h..] — the en-route subset (there IS trouble on the way in).
      None  — frame unknown: carry evidence exists but hole_yards is None, so
              the player's tee-offset is unknowable. Caller must neither claim
              "no trouble" nor fabricate a carry (conservative/honest).
    """
    carry_evidence = [h for h in hazards if h.carry_yards > 0]
    if not carry_evidence:
        return []          # green-frame-only hazard sets (carry_yards defaulted 0)
    if hole_yards is None:
        return None        # cannot place the player on the tee->green line
    tee_offset = max(0, hole_yards - distance_yards)   # GPS-behind-tee jitter clamp
    return [h for h in carry_evidence if tee_offset < h.carry_yards < hole_yards]
```

**The predicate, exactly** (keep this consistent with `drive_zone_hazards`' framing):

- `h.carry_yards > 0` — degenerate-projection exclusion, identical to
  `drive_zone_hazards` and `carries_payload` ("a zero carry is placeholder noise").
- Player's along-path position = `tee_offset = max(0, hole.yards - distance_yards)`.
  On a par-3 / tee shot `tee_offset == 0`, so `carry_yards` IS distance-from-player.
  On a mid-hole approach the player has advanced `hole.yards - distance_yards` from
  the tee. The `max(0, …)` clamp handles `distance_yards > hole.yards` (GPS reading
  from behind the tee) by treating it as a tee shot — never a negative offset.
- En-route iff `tee_offset < h.carry_yards < hole.yards` — strictly ahead of the
  player AND strictly short of the green. A hazard at/past `hole.yards` (e.g. the
  Augusta bunker L at 165 on the 155y hole, or any greenside-behind hazard) is the
  pin-light / `compute_miss_side` green-frame's business, NOT a carry.
- `hole.yards is None` + carry evidence present → `None` sentinel (honest unknown; in
  practice near-unreachable since `carry_yards` is only computed for mapped holes, but
  cached/partial intel makes it possible).
- **Frame discipline:** `distance_yards` is the RAW geometric distance
  (`rec.raw_yards`), NEVER `adjusted_yards` — `carry_yards` is a geometric
  ground-truth number, and mixing in the plays-like frame would shift the player's
  position by wind/elevation. Competition-legal and normal modes therefore behave
  identically here (see §6).

### 1.2 Governing-carry helper (shared so aim line and P1 reasoning agree by construction)

```python
_HAZARD_NOUNS: dict[str, str] = {
    "water": "water", "bunker": "bunker", "ob": "OB", "trees": "trees", "slope": "slope",
}  # article-free sibling of decade_advice._friendly_hazard_name; fallback "trouble"


def _governing_center_carry(en_route: list[Hazard]) -> Optional[Hazard]:
    """The one carry the spoken line names: among line_side=='center' en-route
    hazards, most severe wins; ties break to the LARGER carry_yards (the deeper
    constraint), then hazard type for full determinism. None when no center
    en-route hazard exists (lateral-only case)."""
    center = [h for h in en_route if h.line_side.lower() == "center"]
    if not center:
        return None
    return max(center, key=lambda h: (_SEVERITY_RANK.get(h.penalty_severity, 0),
                                      h.carry_yards, h.type))
```

(`_SEVERITY_RANK` already exists at module scope, aim_point.py ~512.)

Definition of "governing", explicitly: **most severe first, then deepest carry**.
Rationale: the line speaks ONE number (calm/voice-readable); the scariest hazard is the
headline, and the full list still rides in the hazards line / carries payload. Augusta:
water (severe, 140) beats bunker (moderate, 148) → "carry the water at 140".

### 1.3 Signature change — minimal

`compute_aim_point` gains ONE optional keyword parameter; `classify_pin_position` is
**unchanged** (public, tested in `TestClassifyPinPosition`):

```python
def compute_aim_point(
    hole: HoleIntelligence,
    player_stats: Optional[PlayerStatistics],
    handicap: float = 15.0,
    distance_yards: Optional[int] = None,
) -> AimPoint:
```

- `distance_yards is None` (all existing direct callers: `test_positioning_shot.py:153`,
  every `TestComputeAimPoint` test) → `en_route = []` → **byte-identical legacy output**.
- The en-route computation happens INSIDE `compute_aim_point` (via the §1.1 helper), so
  the function stays self-contained; `generate_recommendation` merely passes the
  distance it already has.

### 1.4 Call-site changes

- `generate_recommendation` reachable branch (aim_point.py ~747):
  `aim = compute_aim_point(hole, player_stats, handicap, distance_yards=distance_yards)`
- Reasoning block (~918): calls `en_route_carry_hazards` / `_governing_center_carry`
  again (pure + deterministic + same inputs → provably the same verdict as the aim
  line; no state threading needed). See §3.
- `tests/test_positioning_shot.py:153` and `tests/test_aim_point.py` direct calls:
  **no edit required** — defaulted parameter. T4's hole is hazard-free, so
  `generate_recommendation`'s distance-passing call and the test's default call both
  produce the green-light string; the equality assertion stays green.

---

## 2. The new description strings — exact construction

Inside `compute_aim_point`, replace ONLY the `pin_light == "green"` arm (yellow/red
strings never claim clean and are untouched):

```python
if distance_yards is not None:
    en_route = en_route_carry_hazards(hole.hazards, hole.yards, distance_yards)
else:
    en_route = []   # no positional evidence -> legacy behavior

if pin_light == "green":
    if en_route is None:
        # Carry evidence exists but the frame is unknown (hole.yards None):
        # neither claim clean nor fabricate a carry we can't anchor.
        description = "Aim at the flag"
    elif not en_route:
        description = "Aim at the flag — green light, no trouble"   # verbatim today
    else:
        governing = _governing_center_carry(en_route)
        if governing is not None:
            noun = _HAZARD_NOUNS.get(governing.type.lower(), "trouble")
            description = f"Aim at the flag — carry the {noun} at {governing.carry_yards}"
        else:
            # Lateral-only en-route trouble.
            worst = max(en_route, key=lambda h: (_SEVERITY_RANK.get(h.penalty_severity, 0),
                                                 h.carry_yards, h.type))
            noun = _HAZARD_NOUNS.get(worst.type.lower(), "trouble")
            miss = compute_miss_side(hole, player_stats)
            if miss.preferred in ("left", "right"):
                safe_side = miss.preferred
            else:
                safe_side = "right" if worst.line_side.lower() == "left" else "left"
            if safe_side != worst.line_side.lower():
                description = (f"Aim at the flag — {noun} {worst.line_side.lower()} "
                               f"at {worst.carry_yards}, favor the {safe_side} side")
            else:
                # Miss verdict says the hazard's own side is still the lesser
                # evil — name the fact, let miss_side carry the verdict, never
                # a contradicting side instruction.
                description = (f"Aim at the flag — {noun} {worst.line_side.lower()} "
                               f"at {worst.carry_yards}")
elif pin_light == "yellow":
    description = "Aim between the pin and center of green"          # unchanged
else:
    description = "Aim center of green — sucker pin, don't chase it" # unchanged
```

**Number binding:** every spoken carry number is `governing.carry_yards` /
`worst.carry_yards` — a payload hazard's own field, never recomputed, never
player-relative arithmetic (the tee-anchored number is the SAME number the hazards
line and carries payload speak, so all three surfaces agree byte-for-byte).

**Miss-side consistency by construction:** the lateral safe-side clause is
`compute_miss_side(hole, player_stats).preferred` whenever that verdict is lateral —
the identical pure call `generate_recommendation` makes two lines later, same inputs,
deterministic → cannot disagree. When the miss verdict is short/long (orthogonal axes,
no contradiction possible) the clause falls back to the opposite of the worst lateral
hazard's `line_side`; when even that would name the hazard's own preferred side, the
side clause is omitted entirely.

**Death-side favor clause (aim_point.py ~139-143) composition:** structurally disjoint
from the new logic, with a proof the builder should record as a comment: any
`penalty_severity == "death"` hazard forces `classify_pin_position` to return at least
"yellow" (lines 107-110), so on the `pin_light == "green"` arm — the only arm this plan
changes — `death_sides` is always empty and the `". Favor the … side — penalty …"`
append never fires. The append code itself is untouched and still composes after the
yellow/red strings exactly as today. (If a future refactor ever let it fire after a new
string, it appends grammatically: `"Aim at the flag — carry the water at 140. Favor the
left side — penalty right"`.)

### Verbatim expected lines

- **Augusta 12** (155y par-3, water C carry 140 severe, bunker C carry 148 moderate,
  bunker L carry 165 moderate; pin light green):

  > `Aim at the flag — carry the water at 140`

- **Genuinely clean hole** (no hazards, or only green-frame/far/mild hazards with no
  en-route carry evidence):

  > `Aim at the flag — green light, no trouble`

  — byte-identical to today. The fix must not hedge here.

---

## 3. Reasoning append (aim_point.py ~918-923) — P1 agrees with the aim line

Today the reachable P1 block only fires for red/yellow pins. Add a green-pin arm:

```python
if pin_light == "red":
    _r.append((1, "Red light pin — play to the center, don't short-side yourself"))
elif pin_light == "yellow":
    _r.append((1, "Yellow light pin — aim between pin and center"))
elif pin_light == "green":
    en_route = en_route_carry_hazards(hole.hazards, hole.yards, distance_yards)
    governing = _governing_center_carry(en_route) if en_route else None
    if governing is not None:
        noun = _HAZARD_NOUNS.get(governing.type.lower(), "trouble")
        _r.append((1, f"{noun.capitalize()} at {governing.carry_yards} between you and "
                      f"the green — take enough club to carry it"))
```

- Uses the SAME two helpers as the description → the P1 line and the aim line can never
  name different hazards or numbers.
- Augusta-12 P1 line: `"Water at 140 between you and the green — take enough club to carry it"`.
- Lateral-only and `None`-frame cases add NO new P1 (the aim description + `miss_side` +
  the existing `decade_aim_advice` P1 already cover lateral; don't stack hedges — the
  4-item cap and calm-voice discipline stay intact).
- No other reasoning lines, `aggressiveness` (green + hazards is already "moderate"),
  or `confidence` change.

### Consumers (fix propagates at the source; nothing reintroduces the wart)

- `strategy.py::format_strategy_ground_truth` (~214) speaks `aim_point.description` on
  reachable (no-tee-numbers) turns → the RECOMMENDATION line is fixed automatically.
- `strategy_turn.py::compose_degraded_line` (~30) does **not** consume
  `aim_point.description` — verified: it composes purely from `tee_shot_numbers`,
  `miss_side.preferred`, `carries`, and green-read fields. Its battery
  (`tests/eval/test_strategy_tool.py`, `_FORBIDDEN_SUBSTRINGS` incl. "no trouble")
  stays green untouched. This plan makes the same never-"no trouble"-with-hazards
  property hold at the SOURCE (`compute_aim_point`), so the degraded line's guarantee
  and the live line finally agree. (Note: "at the flag" is forbidden only for
  compose_degraded_line's OUTPUT — a positioning-context surface; the reachable aim
  description legitimately says it.)
- `voice_prompts.py` ~407/412 and `routes/caddie.py` ~920/925/1725 speak the
  description verbatim → propagate for free.

---

## 4. Test plan (exact files, classes, fixtures)

### 4.1 `backend/tests/test_aim_point.py` — extend

New helpers (existing `_water`/`_bunker` set `distance_from_green` but leave
`carry_yards=0`/`line_side="center"` defaulted — Augusta fixtures must set both):

```python
def _carry_hazard(type_, line_side, carry, severity="moderate", distance=15.0):
    return Hazard(type=type_, side="front" if line_side == "center" else line_side,
                  line_side=line_side, carry_yards=carry,
                  penalty_severity=severity, distance_from_green=distance)

def _augusta12_hole() -> HoleIntelligence:
    return _make_hole(par=3, yards=155, hazards=[
        _carry_hazard("water",  "center", 140, severity="severe",   distance=15.0),
        _carry_hazard("bunker", "center", 148, severity="moderate", distance=7.0),
        _carry_hazard("bunker", "left",   165, severity="moderate", distance=10.0),
    ])
```

(Sanity: `classify_pin_position` on this hole → "green" — water is severe but
`distance_from_green=15 > 10`; bunkers moderate; no death. That IS the repro.)

New class `TestEnRouteCarryHazards` (predicate units):
1. Tee frame: hole 155/dist 155 → water 140 + bunker 148 in, bunker 165 out.
2. Approach frame: hole 400/dist 150 (tee_offset 250) → carry 200 hazard (already
   passed) excluded; carry 300 included; carry 400 excluded.
3. `carry_yards=0` evidence only → `[]`.
4. `hole_yards=None` with carry evidence → `None`; with no carry evidence → `[]`.
5. Clamp: dist 160 on 155y hole (behind tee) → tee_offset 0, same as tee frame.

New class `TestHazardAwareReachableAim`:
1. **Augusta-12 repro (the headline test):**
   - Direct: `compute_aim_point(_augusta12_hole(), None, distance_yards=155).description
     == "Aim at the flag — carry the water at 140"` (exact).
   - End-to-end: `rec = generate_recommendation(_augusta12_hole(), 155,
     {"7iron": 160, "9iron": 140, "pw": 130}, handicap=15)`; assert
     `rec.shot_kind == "approach"`; `"water"` and `"140"` in
     `rec.aim_point.description`; `"no trouble" not in` and `"green light" not in`
     the description (lowercased); reasoning contains the
     `"Water at 140 between you and the green"` P1 line.
2. **Clean hole still green light (don't-hedge guard):** `_make_hole(par=3, yards=155)`
   (no hazards) → direct + end-to-end description `== "Aim at the flag — green light,
   no trouble"` (exact, byte-identical).
3. **Green-frame-only hazards keep green light:** mild bunker `distance=20`,
   `carry_yards=0` (the existing `_bunker` helper) → exact legacy string.
4. **Past-green hazard not carry-relevant:** only the bunker-L-165 hazard on the 155y
   hole → exact legacy green-light string.
5. **Passed hazard on an approach not carry-relevant:** hole 400y, dist 150 (reachable
   with the bag), lone hazard carry 200 severe center, `distance_from_green=200` →
   legacy string (player is past it).
6. **Lateral-only en-route + miss-side agreement:** par-3 180y, water
   `line_side="right"`, `side="right"`, carry 160, severe, `distance_from_green=20`
   → description `== "Aim at the flag — water right at 160, favor the left side"`
   AND `generate_recommendation(...).miss_side.preferred == "left"` (agreement
   asserted, not assumed).
7. **Unknown frame honest:** hole `yards=None`, hazard carry 140 →
   `compute_aim_point(hole, None, distance_yards=155).description == "Aim at the flag"`
   (no clean claim, no fabricated carry).
8. **Default back-compat:** `compute_aim_point(_augusta12_hole(), None)` (no
   `distance_yards`) → legacy green-light string — documents that direct legacy
   callers are byte-stable.

### 4.2 Existing tests — preserved vs updated

- `tests/test_aim_point.py::TestClassifyPinPosition` — untouched function; **preserved**.
- `tests/test_aim_point.py::TestComputeAimPoint` — all fixtures have `carry_yards=0`;
  **preserved, no edits**.
- `tests/test_positioning_shot.py` (T1-T6, incl. line 153's
  `rec.aim_point.description == compute_aim_point(hole, None).description`) —
  **preserved, no edits** (T4 hole is hazard-free; T3/T5 hazards either
  positioning-path or `carry_yards=0`).
- `tests/test_decade_advice.py` :423 (`"Aim between"` yellow + favor-right) and :617
  (handicap does not change aim) — fixtures use `_hazard` with `carry_yards=0` →
  **preserved, no edits**.
- `tests/eval/test_strategy_tool.py` compose_degraded_line battery (Red-6 /
  Augusta-12 / flat-green / falls-toward shapes, `_FORBIDDEN_SUBSTRINGS`) —
  **preserved, no edits**; the Red-6 "favor the right / trees right at 220" and other
  Red-shape side verdicts come from `compute_positioning_miss_side` /
  `carries_payload`, which this plan does not touch.
- `tests/test_miss_side_grounding.py`, `tests/test_tee_shot_numbers.py`,
  `tests/test_corridor_bend_cap.py`, `tests/test_corridor_width_selection.py` —
  positioning-path; **preserved** (run them to prove it).

---

## 5. Gates (all DB-free; backend DB-route tests run in CI — do NOT spin up a container)

From `backend/`:

```
uv run ruff check .
uv run pytest tests/test_aim_point.py tests/test_positioning_shot.py \
  tests/test_decade_advice.py tests/test_miss_side_grounding.py \
  tests/test_tee_shot_numbers.py tests/test_corridor_bend_cap.py \
  tests/test_corridor_width_selection.py tests/test_caddie_tools.py \
  tests/eval/test_strategy_tool.py -q
```

**Shared-types check:** `Hazard` is consumed on both sides, but this fix reads ONLY
existing fields (`carry_yards`, `line_side`, `penalty_severity`, `type`) and changes no
Pydantic model — `backend/app/caddie/types.py` untouched, no frontend `types.ts` /
`models.py` shape change, no JSONB/cache migration. `AimPoint.description` remains a
plain string; frontend renders it opaquely. State this in the PR; nothing to run.

---

## 6. Edge cases, risks, non-goals

- **Center vs lateral:** center en-route hazards produce the carry clause (governing =
  most severe, then deepest carry, then type — fully deterministic); lateral-only
  produces the hazard-fact + safe-side clause per §2. Mixed → center wins the sentence
  (the must-carry constraint outranks a lateral lean; miss_side still carries the
  lateral verdict).
- **Multiple carries:** ONE governing number spoken (calm/voice-readable); the complete
  list still lives in the hazards line ("the COMPLETE list — there are NO others"), so
  no information is lost, and the two surfaces can't disagree because both bind to the
  same `carry_yards` payload ints.
- **Tee frame vs approach frame:** handled by `tee_offset`; a hazard the player already
  passed can NEVER trip the new logic (`tee_offset < carry_yards` strict), and a
  greenside/past-green hazard can NEVER trip it (`carry_yards < hole.yards` strict) —
  the two "don't hedge everywhere" guards, both tested (§4.1 cases 4-5).
- **`hole.yards is None`:** honest degradation — drop only the clean-claim ("Aim at the
  flag"), never fabricate a player-relative carry from an unanchorable frame, never
  return the "no trouble" claim while carry evidence exists.
- **competition_legal:** predicate and strings use raw geometric `distance_yards` and
  stored payload `carry_yards` — zero physics involvement, so both modes behave
  identically; no new competition-mode branch. (Covered implicitly; add no test.)
- **Don't-hedge guard:** `en_route == []` → the exact legacy green-light string. The
  ONLY holes that lose "green light, no trouble" are holes where the engine's own
  hazard evidence proves trouble between the player and the green.
- **Reasoning cap:** the new P1 can displace a P2-P4 line under the 4-item cap —
  intended; P1 is safety-critical per the established scheme.
- **Repetition risk:** aim line, hazards line, and (rarely) `decade_aim_advice` may all
  mention the same water — same fact, same number, different surfaces; acceptable and
  consistent. Do not de-duplicate across surfaces in this change.
- **Strategy validator:** `strategy.py`'s fail-closed reply validation checks the
  MODEL's output against payload hazards; our deterministic string is model INPUT —
  no interaction.
- **Non-goals:** no new geometry, no corridor math, no change to
  `classify_pin_position`, `compute_miss_side`, yellow/red strings, positioning path,
  or any Pydantic shape.

## Build order

1. Add `_HAZARD_NOUNS`, `en_route_carry_hazards`, `_governing_center_carry` to
   `aim_point.py` (§1.1-1.2).
2. Extend `compute_aim_point` signature + green-arm composition (§1.3, §2), with the
   death-clause disjointness proof as a comment.
3. Pass `distance_yards` at the reachable call site (~747) and add the green-pin P1
   arm (~918) (§1.4, §3).
4. Add tests (§4.1). Touch no existing test.
5. Run gates (§5).
