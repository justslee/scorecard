# Caddie bench — CYCLE 5 diagnosis (run `20260725-230324`, 189 cases, satellite, 11-dim)

Every number below was computed from that run's `results.jsonl` on the box
(i-0826ae70df62d9fe8, `/tmp/benchwt_1784730879/backend/tests/eval/caddie_bench/runs/20260725-230324/`)
via read-only SSM. Denominator for per-dim splits = **162 judged ADVICE cases** (189 total − 5
canaries − 22 FACT-routed). The report's own headline uses the same exclusion, so the numbers here
reconcile with it to within rounding (e.g. report natural_speech 60.9% vs 61.1% here — the report
counts the 5 canaries' judged rows in some dims; the splits below are internally consistent).

## Headline (both bases, as reported)
- **NEW basis (11-dim, satellite, aggression_realism added): 86.5%**
- **Legacy basis (10-dim, comparable to runs ≤ cycle 3): 85.2%** (trajectory 53.4 → 77.0 → 85.2)
- Correctness dims (7, unweighted avg) 82.6% · owner-crux dims (4) 79.6%
- Degraded rate 15.3% · contested 16.8% · det-check overall 92.9% · canaries all PASS
- Cost $7.125 / 189 cases · wall 6946s · latency p50 2127ms

---

## FINDING 0 — the cycle-5 brief's lead hypothesis is FALSIFIED

The brief asked whether natural_speech (60.9%) is dragged by the 15.3% degrade rate, per cycle 3's
measured 32% (degraded) vs 63.2% (clean). **It is not — not any more.**

| dim | all | DEGRADED (n=25) | CLEAN (n=137) |
|---|---|---|---|
| **natural_speech** | 61.1% | **60.0%** | **61.3%** |
| non_repetitive | 99.4% | 96.0% | 100.0% |
| strategic_depth | 78.4% | **28.0%** | 87.6% |
| answers_the_question | 84.6% | 72.0% | 86.9% |
| numbers_coherence | 74.1% | 92.0% | 70.8% |
| hazard_awareness | 68.5% | 56.0% | 70.8% |

Cycle-4's degraded-line cap/dedupe work closed the speech gap on the degraded path completely
(32% → 60.0%, now level with clean). So **natural_speech is a register problem across the board**,
exactly as the brief's fallback branch anticipated — and per the brief we go to the judge's own
reasons rather than touching a prompt on a guess.

Degrades still cost real points, but on **strategic_depth** (28.0% vs 87.6%) and hazard_awareness,
not speech. That is a second-order lever; the three root causes below are larger.

## Degrade taxonomy (cycle-3 c2 instrumentation, first cycle it has data)

| reject reason | count | share of degrades |
|---|---|---|
| `validator:side-flip` | 24 | 82.8% |
| `validator:pin:favor-side` | 4 | 13.8% |
| `exception:ReadTimeout` | 1 | 3.4% |

Side-flip is essentially the whole degrade population. Its distribution:
- lie: tee 10, fairway 8, rough 3, bunker 3 · shot_kind: approach 14, positioning 10
- **engine `miss_side.preferred` on those 24: `short` on 22, `right` on 2**

That is the tell. The degrades are not a validator-tuning problem — they are ROOT CAUSE 3 below
surfacing through the validator: the engine hands down `preferred="short"`, the model (which can
see the satellite image and the hazard list) says something that contradicts it, and the side-flip
validator rejects the honest narrative. Fix the miss-side payload and most of these degrades stop
being generated in the first place. **Do not touch the side-flip validator.**

---

## ROOT CAUSE 1 — `leave_plays_like_yards` is a number the engine never solved
### (numbers_coherence 74.9%, 2x-weighted — the single biggest weighted lever)

**Evidence.** 42 of 162 advice cases fail numbers_coherence. 41 of 42 are `shot_kind=positioning`
and classed `wrong_numbers`. 40 of those speak a "plays like N" for the LEAVE, and:

> **40 / 40 of them spoke the engine's own `leave_plays_like_yards` verbatim (±3y). Zero
> confabulated it.** The bench's `numbers_close` det-check caught only 2 of the 42.

The model is faithful. The engine's number is bad.

| case | leave_yards | leave_plays_like (spoken) |
|---|---|---|
| black_h4 slot4 bomber | 20 | 15 |
| red_h1 slot4 short_hitter | 5 | **20** |
| black_h8 slot0 short_hitter | 10 | **25** |
| black_h18 slot2 short_hitter | 15 | **30** |
| black_h4 slot4 owner | 25 | **35** |
| black_h4 slot4 short_hitter | 30 | **45** |
| black_h5 slot1 short_hitter | 280 | 335 |
| black_h18 slot0 short_hitter | 215 | 260 |

**Root cause, at the line.** `backend/app/caddie/aim_point.py:794`

```python
leave_plays_like_yards = round(max(0, adjusted_yards - club_dist) / 5) * 5
```

`adjusted_yards` is THIS shot's wind/elevation-adjusted distance to the green; `club_dist` is the
selected club's **calm** stored yardage. Their difference is not a solve of the next shot — it is
the raw leave plus this shot's entire wind adjustment, re-attributed to a shot that has a different
bearing, a different club, and an unknown lie. Hence "a 5-yard leave plays like 20". It is applied
to 76/76 positioning cases, and numbers_coherence on those is **46.1%**.

The docstring at `aim_point.py:779-783` already concedes it is "a labeled extra, never the primary
leave". The bench proves the label does not save it: `voice_prompts.py:351-352` renders it as
`" (plays like ~N)"` and the judge scores it as a flat contradiction of the authoritative solve.

This is precisely the standing memory **[[caddie-numbers-coherence]]** — every spoken number must
bind to ONE per-turn engine solve. This one binds to a second shot the engine never solved.

**Fix direction (for the plan, not a decision made here):** stop putting an unsolved plays-like for
the leave in the caddie's mouth. Suppress it from the spoken payload; keep `leave_yards` (the raw
closing arithmetic the golfer can check) as the primary and only leave number. If a plays-like for
the next shot is ever wanted, it has to come from an actual solve of that shot, not this subtraction.
Removing an unsupported number is a correctness fix, not judge-weakening.

**Honest projected impact:** 41 of 42 numbers_coherence failures are this class, but several also
carry an independent defect (e.g. `black_h5 slot4` is simultaneously a bad_club case), so not all
flip. Conservative band: numbers_coherence **74.9% → 88–95%**, on a 2x-weighted dim.

---

## ROOT CAUSE 2 — the "No green slope is mapped" closer
### (natural_speech 60.9%, the lowest dim — and it is NOT the degrades)

**Evidence.** Split the 162 advice answers by how they treat green slope:

| answer class | n | natural_speech |
|---|---|---|
| **negative disclaimer** ("No green slope is mapped") | **101 (62%)** | **54.5%** |
| positive slope read | 12 | 83.3% |
| no slope mention at all | 49 | 69.4% |

Of the 53 CLEAN natural_speech failures, the judge's own critique sentences name this closer
**22 times out of 30** — in its words: *"sounds like map metadata rather than natural caddie
speech"*, *"more like a system readout than spoken caddie advice"*, *"robotic and irrelevant"*,
*"templated"*. Representative endings from the transcripts:

> "…leaving about 215 in, playing like 260. **No green slope is mapped.**"
> "…and the right bunker is about 60 yards from you. **No green slope is mapped.**"

**Root cause, at the line.** Not `slope_advice.py` (it correctly returns `None` when absent) and not
the payload (`strategy.py:399-401` only emits a Green-slope line when a description exists). It is
manufactured by two clauses of the strategy system prompt (`backend/app/caddie/strategy.py`,
`_strategy_system()`):

1. *"If a section says data is unavailable, say plainly what you don't know instead of guessing."*
2. Output contract: *"…and one green note when the read is available."*

Clause 1's real purpose is anti-confabulation. But combined with an output contract that asks for a
green note, it reads as an instruction to **narrate absent data**, and the model complies on 62% of
turns. A real caddie with no green read simply doesn't mention the green read.

**Fix direction:** keep the anti-confabulation guarantee (never invent a read) and drop the
narrate-the-absence behaviour — when a section is absent, say nothing about it rather than announcing
the gap. This is removal of a prompt clause that manufactures robotic filler, **not** persona padding
added to game the speech dim; the reviewer must confirm the never-invent contract survives intact
(this is the one prompt-surface change in the cycle and needs that specific scrutiny).

**Honest projected impact:** if the 101 disclaimer cases regress to the observed no-mention baseline
(69.4%), natural_speech = (101·0.694 + 12·0.833 + 49·0.694)/162 ≈ **70.4%**, i.e. **60.9% → ~70%**
(+9pts, 1x-weighted). It should not go higher than that on this fix alone.

---

## ROOT CAUSE 3 — the greenside evidence window is too tight
### (miss_side_evidence 63.7% + hazard_awareness 65.4%, both 2x — and the degrade engine)

**Evidence.** Split by the engine's own `miss_side.description`:

| engine miss-side class | n | miss_side | hazard | speech |
|---|---|---|---|---|
| named a side + evidence | 94 | 74.5% | 79.8% | 58.5% |
| **"No strong miss side mapped"** | **68 (42%)** | **52.9%** | **52.9%** | 64.7% |

By shot_kind: approach 58.1% / 60.5% vs positioning 73.7% / 77.6%.
By lie: **rough 29.6%** (n=27, the worst class by far), greenside 50.0%, fairway 63.0%, tee 83.1%.
`preferred="short"` fires on **121 of 162** cases (75%) and carries 17 of the run's
`engine_looks_wrong` flags.

Critically, on those 68 "no strong miss side" cases the hazards **are present in the payload** —
their own `engine_ref.reasoning[]` contains lines like `"Around the green: bunker center"` and
`"Bunker about 160 out between you and the green"`. So this is a **payload-classification** gap, not
a mouth gap: the engine has the hazard and then declares there is no miss-side evidence anyway.

The judge says the same thing case after case, unprompted:
> *"the engine's claim of no mapped trouble tight to the green appears inconsistent with the mapped
> 470- and 475-yard bunkers and the image"* · *"'favor short' is contradicted by those very
> short-side bunkers"* · *"bunkers at 520y and 525y sit roughly **28–33 yards short of the green**
> on both sides"* · *"only about **11–19 yards laterally** from the line"*

**Root cause, at the line.** `backend/app/caddie/aim_point.py:509-520`, the cycle-3 commit-4 branch.
Its own comment names the culprit:

> *"on bethpage h18 the map shows short trouble just outside the `distance_from_green <= 20`
> evidence window, making the claim visibly wrong"*

The window is literally **20 yards**. The hazards the judge keeps citing sit at **22–33 yards**. So
cycle-3's honest-degrade branch — correct in intent — now fires on 42% of all cases because the
evidence window excludes the very bunkers that are in play, and it emits both
`"No strong miss side mapped"` and `"No mapped trouble tight to the green"` on holes where the
satellite image plainly shows greenside sand.

**Fix direction:** re-measure the greenside evidence window against the real fixture geometry and
widen it (and/or add the lateral-offset criterion the judge is implicitly using) so genuine greenside
hazards become per-side evidence; keep the honest-degrade branch for the case where there truly is no
mapped greenside hazard. **The threshold must be measured off the committed fixtures, not guessed** —
see the standing backlog warning about `CORNER_MIN_DEVIATION_FRACTION` picking a knife-edge through a
populated continuum. `compute_miss_side` feeds live production advice, so this is the highest-risk of
the three and needs the fable-grade review.

**Honest projected impact:** the 68-case class moving partway toward the named-side class would put
miss_side_evidence ≈ **63.7% → 70–75%** and hazard_awareness ≈ **65.4% → 72–78%**, both 2x-weighted,
plus a large share of the 24 side-flip degrades (22 of which ride `preferred="short"`) never being
generated — which in turn recovers strategic_depth on those cases (28.0% → clean-path 87.6%).
This is the least certain of the three projections.

---

## FINDING 4 — FACT routing 80% (10 cases), reported honestly

The 2 misroutes are both `fact_distance_04`: `bethpage_black_h7__fact__fact_distance_04` and
`pebble_beach_h3__fact__fact_distance_04`, each routed `intent=other` instead of `fact`. Same single
phrasing, on two different holes — so this is one phrasing the router doesn't recognise, not a
systemic tiering failure. n=10 is far too small to act on confidently; **recorded, not fixed this
cycle.** Re-check it at the next full run before spending a change on it.

---

## Cycle-5 scope recommendation (impact × safety order)

| # | change | dims moved | weight | risk |
|---|---|---|---|---|
| A | suppress the unsolved leave plays-like (RC-1) | numbers_coherence | 2x | LOW — payload removal, must hold tee-parity pins |
| B | stop narrating absent green-slope data (RC-2) | natural_speech | 1x | LOW — one prompt clause; must preserve never-invent |
| C | re-measure + widen the greenside evidence window (RC-3) | miss_side + hazard (+degrades, +strategic_depth) | 2x | HIGH — live `compute_miss_side` geometry |

All three are the same standing pattern: **the engine framed something badly and the model faithfully
repeated it.** None of them is a judge change, a validator loosening, or persona padding. The judge,
the det-checks, the canaries and the side-flip validator are all to be left exactly as they are.

---

## ADDENDUM — RC-3's threshold, MEASURED (eng-lead, before the plan landed)

The plan must not let the builder guess this cut, so I measured it first. Source: every hazard
extracted by the production path (`app.caddie.hazards.extract_hole_hazards` via the bench's
`hole_intel_from_fixture`) over all 10 committed hole fixtures — **78 hazards total**.

`distance_from_green` for everything inside 60y, with its lateral offset and side:

| dist | lateral | side | type | hole |
|---|---|---|---|---|
| 20.0 | 2.8 | center | bunker | black_h5 |
| 20.0 | 19.3 | left | bunker | red_h6 |
| 21.0 | 17.4 | right | bunker | black_h5 |
| 21.0 | 21.3 | left | bunker | black_h8 |
| 21.0 | 17.5 | left | bunker | red_h6 |
| 23.0 | 10.3 | left | bunker | black_h5 |
| 24.0 | 7.4 | center | bunker | black_h4 |
| 24.0 | 19.8 | left | bunker | black_h7 |
| 25.0 | 18.8 | left | bunker | red_h5 |
| 26.0 | 18.4 | right | bunker | black_h7 |
| 26.0 | 22.5 | right | bunker | red_h5 |
| 33.0 | 19.1 | right | bunker | red_h16 |
| 34.0 | 33.8 | right | **trees** | pebble_h3 |
| 35.0 | 8.8 | center | bunker | black_h8 |
| 35.0 | 29.9 | right | **trees** | red_h1 |
| 36.0 | 35.4 | right | **trees** | red_h1 |
| 36.0 | 33.9 | right | **trees** | pebble_h3 |
| 39.0 | 25.4 | right | **trees** | red_h6 |
| 42.0 | 11.4 | left | bunker | red_h16 |
| 46.0 | 10.0 | left | water | black_h8 |
| 46.0 | 45.3 | left | **trees** | red_h1 |
| 47.0 | 25.0 | left | **trees** | red_h1 |
| 49.0 | 7.7 | center | bunker | black_h4 |
| 51.0 | 18.3 | right | bunker | red_h16 |
| 60.0 | 13.7 | left | bunker | red_h5 |

**The finding: `distance_from_green <= 20` is a knife edge through the densest cluster in the
whole distribution.** Eleven greenside bunkers sit between 20 and 26 yards; the current cut admits
exactly **2** of them and excludes **9**. This is the `CORNER_MIN_DEVIATION_FRACTION`-at-0.30 scar
repeating verbatim — a threshold placed inside a populated region rather than through a void. It is
also exactly what the judge kept reporting unprompted ("bunkers 22-33 yards short of the green",
"11-19 yards laterally").

**Where the real voids are.** On distance, the only genuine gap in this region is **26 → 33**
(7 yards empty); above that the distribution is continuous (33,34,35,35,36,36,39,42,46,46,47,49,51,60,
63,65,67,72,...), so there is no clean distance-only cut above 26. On lateral offset, the tight
greenside BUNKERS run 2.8–22.5y while the flanking TREE lines at 34–47y run 25.4–45.3y — a second,
independent separation.

**So the honest criterion is two-axis, not a widened single number:** greenside evidence =
`distance_from_green` inside roughly the high-20s **AND** lateral offset inside roughly 25y. That
cut sits in a real void on *both* axes and cleanly separates "sand guarding this green" from
"tree line well off the line". A distance-only widening to ~35 would sweep in the pebble_h3 /
red_h1 / red_h6 tree lines at 25–45y lateral, which are not greenside miss evidence and would
trade one wrong claim for another.

The builder must re-derive this table itself (the command above is reproducible in ~10s offline,
zero DB) and justify the final constants against it — but the measurement is done and the answer is
not "bump 20 to 25". Handing this to the plan/builder so no one picks a number by feel.
