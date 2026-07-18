# Tee-selector audit — BEFORE (all-courses, read-only, prod DB)

specs/caddie-yardage-selector-p0-plan.md Lead 2. Captured 2026-07-18 via
`backend/scripts/audit_tee_selector.py` run read-only on the prod box
(instance `i-0826ae70df62d9fe8`, service `scorecard-api`'s own
`DATABASE_URL`, app venv) — no writes, no `build_hole_intelligence`, no
weather/USGS/LLM calls. 12 mapped courses, 168 par-4/5 holes, both bags
(owner's real 12-club bag and `DEFAULT_CLUB_DISTANCES`), handicap = the one
populated `golfer_profiles.handicap_index` row (3.0).

Three runs per hole (uncapped baseline / bend-cap-only / full) attribute
WHICH mechanism fired. `bend-cap corner trees` reproduces the EXACT filter
`aim_point.py`'s bend-cap gate uses, so the audit shows precisely what
evidence justified (or didn't) each cap. FLAG = final pick is an iron/wedge
(4iron or shorter) off a par-4/5 tee.

## Verdict summary (legit vs bogus, one sentence each)

**Root-cause class convicted: Class A, "phantom corners" — but the specific
mechanism is a MISSING UPPER BOUND on the bend-cap's `corner_trees` filter,
not a low deviation threshold as originally hypothesized.** The filter only
checked `h.carry_yards >= bend.distance_yards - CORNER_TREE_LOOKBACK_YDS`
with no ceiling, so ANY tree hazard anywhere past that point — even one
clustered near or past the green — counted as "guarding" the corner.
Critically, `deviation_yards` does NOT separate the two classes in this
data: every bogus hole below has a REAL, substantial dogleg (43-103y
deviation); a deviation-only fix would not have caught a single one of
them. The discriminator is the tree's ALONG-PATH position relative to the
corner.

**LEGIT bend-caps (real corner, real near-corner tree evidence) — cap stays
unchanged after the fix:**
- Pebble Beach 1 (58y dev, tree at -15/+20 vs corner)
- Pebble Beach 16 (32y dev, tree at +10)
- Bethpage Black 1 (82y dev, tree at +15)
- Bethpage Black 2 (44y dev, tree at -5/+0)
- Bethpage Black 6 (49y dev, tree at -15)
- Bethpage Black 7 (110y dev, tree at -5 — the biggest real dogleg in the set)
- Kiawah Island 2 (103y dev, tree at +30)
- Augusta National 2 (90y dev, tree at +5)
- Augusta National 10 (60y dev, tree at -15)
- Pinehurst No. 2 14 (61y dev, tree at +25 — mechanism legit, but the
  resulting layup is severe; flagged for owner feel-check, not a bug)

**LEGIT corridor-cost (real water pinch, min-obs=1 by design for water — a
single ring vertex IS real evidence per the extractor's own contract):**
- Muirfield Village 14 (dug in separately: driver lands in a literal 3y-wide
  gap between water on both sides at ~306y)
- St Andrews (Old Course) 1 (same pattern: 3y gap at ~299-320y)

**BOGUS bend-caps (Class A conviction — nearest qualifying tree is 60-280y
PAST the corner, i.e. greenside/downstream, unrelated to the dogleg) — cap
CLEARS after the fix:**
- Pebble Beach 3 (nearest qualifying tree +85y past a 265y corner on a 381y
  hole — essentially at the green)
- Pine Valley 1 (nearest +60y past a 240y corner)
- Pine Valley 9 (nearest +280y past a 175y corner on a 554y hole — the most
  extreme case; capped the drive to a 9-iron/7-iron for no real reason)
- Pine Valley 16 (nearest +60y past a 225y corner)
- Kiawah Island 3 (nearest +65y past a 245y corner)
- Shinnecock Hills 15 (nearest +120y past a 240y corner on a 395y hole —
  greenside trees)

Three additional holes had a MILDER version of the same bug (capped to
3wood, not severe enough to trip the sub-hybrid FLAG, but still bogus and
also cleared by the fix): Augusta National 13 (nearest +45), Bethpage Black
16 (nearest +55), Cypress Point 1 (nearest +65).

**False positives of this audit's own crude FLAG heuristic (NOT the Lead-2
bug — these are the ordinary REACHABLE/approach-club path, not the
positioning/bend-cap/corridor path at all; ordinary "green's in range, lay
up to it" caddying on a short par-4, ordinary and correct):**
- Bethpage Red 6 (287y hole; default bag naturally lands on 5iron via a
  legitimate near-corner tree at delta=0 — this IS a legit bend-cap for the
  DEFAULT bag specifically, see `test_13_red6_5iron_via_bend_cap_unchanged`)
- Cypress Point 14 (262y hole, green in range of the owner's longer clubs —
  standard lay-up-to-flag selection, not a cap)

## Raw table

# Tee-selector audit — handicap=3.0 (prod golfer_profiles.handicap_index)

| course | hole | par | yards | pick(owner) | pick(default) | mechanism | bend dist/dev | bend-cap corner trees (aim_point's own filter) | corridor evidence @uncapped total | FLAG |
|---|---|---|---|---|---|---|---|---|---|---|
| Pebble Beach Golf Links | 1 | 4 | 360(derived) | 5iron | 5wood | bend-cap@220 | right@220/58y | 205y(-15 vs corner)/moderate/right; 240y(+20 vs corner)/moderate/left; 255y(+35 vs corner)/moderate/right; 280y(+60 vs corner)/moderate/left; 310y(+90 vs corner)/moderate/left; 455y(+235 vs corner)/moderate/left | L:3obs/3feat/q=Y R:0obs/0feat/q=n | FLAG |
| Pebble Beach Golf Links | 2 | 5 | 508(derived) | driver | driver | none | straight/1y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pebble Beach Golf Links | 3 | 4 | 381(derived) | 4iron | 5wood | bend-cap@265 | left@265/48y | 350y(+85 vs corner)/moderate/right; 390y(+125 vs corner)/moderate/right; 405y(+140 vs corner)/moderate/right | L:0obs/0feat/q=n R:0obs/0feat/q=n | FLAG |
| Pebble Beach Golf Links | 4 | 4 | 333(derived) | driver | driver | none | straight/5y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pebble Beach Golf Links | 6 | 5 | 520(derived) | driver | driver | none | straight/1y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pebble Beach Golf Links | 8 | 4 | 411(derived) | driver | driver | none | right@215/36y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pebble Beach Golf Links | 9 | 4 | 520(derived) | driver | driver | none | right@325/32y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pebble Beach Golf Links | 10 | 4 | 514(derived) | driver | driver | none | straight/8y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pebble Beach Golf Links | 11 | 4 | 383(derived) | driver | driver | none | right@270/18y | 275y(+5 vs corner)/moderate/left; 305y(+35 vs corner)/moderate/left | L:8obs/2feat/q=Y R:0obs/0feat/q=n |  |
| Pebble Beach Golf Links | 13 | 4 | 365(derived) | driver | driver | none | right@305/59y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pebble Beach Golf Links | 14 | 5 | 516(derived) | driver | driver | none | right@280/106y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pebble Beach Golf Links | 15 | 4 | 396(derived) | driver | driver | none | straight/4y | - | L:0obs/0feat/q=n R:3obs/3feat/q=Y |  |
| Pebble Beach Golf Links | 16 | 4 | 394(derived) | 6iron | 4iron | bend-cap@235 | right@235/32y | 245y(+10 vs corner)/moderate/right; 335y(+100 vs corner)/moderate/right; 340y(+105 vs corner)/moderate/left; 365y(+130 vs corner)/moderate/right; 370y(+135 vs corner)/moderate/left; 390y(+155 vs corner)/moderate/right; 400y(+165 vs corner)/moderate/left; 425y(+190 vs corner)/moderate/right; 435y(+200 vs corner)/moderate/left | L:1obs/1feat/q=n R:1obs/1feat/q=n | FLAG |
| Pebble Beach Golf Links | 18 | 5 | 488(derived) | driver | driver | none | left@225/74y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Red | 1 | 4 | 467(derived) | driver | driver | none | straight/6y | - | L:1obs/1feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Red | 2 | 4 | 386(derived) | driver | driver | none | left@255/70y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Red | 3 | 4 | 355(derived) | driver | driver | none | right@215/70y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Red | 5 | 5 | 469(derived) | driver | driver | none | right@295/64y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Red | 6 | 4 | 287(derived) | 3wood | 5iron | none | left@195/83y | 195y(+0 vs corner)/moderate/right; 225y(+30 vs corner)/moderate/right; 255y(+60 vs corner)/moderate/right; 310y(+115 vs corner)/moderate/right | L:0obs/0feat/q=n R:0obs/0feat/q=n | FLAG |
| Bethpage Red | 8 | 4 | 402(derived) | driver | driver | none | right@265/22y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Red | 9 | 4 | 434(derived) | driver | driver | none | left@190/66y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Red | 10 | 4 | 425(derived) | driver | driver | none | right@250/66y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Red | 11 | 4 | 463(derived) | driver | driver | none | right@310/69y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Red | 13 | 4 | 380(derived) | driver | driver | none | straight/5y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Red | 14 | 4 | 420(derived) | driver | driver | none | left@250/73y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Red | 15 | 4 | 487(derived) | driver | driver | none | right@295/54y | 305y(+10 vs corner)/moderate/right; 410y(+115 vs corner)/moderate/right | L:0obs/0feat/q=n R:1obs/1feat/q=n |  |
| Bethpage Red | 16 | 5 | 499(derived) | 3wood | driver | bend-cap@270 | right@270/121y | 305y(+35 vs corner)/moderate/right; 325y(+55 vs corner)/moderate/right | L:0obs/0feat/q=n R:3obs/2feat/q=Y |  |
| Bethpage Red | 18 | 4 | 458(derived) | 3wood | driver | bend-cap@285 | right@285/21y | 275y(-10 vs corner)/moderate/right; 300y(+15 vs corner)/moderate/right; 335y(+50 vs corner)/moderate/right; 415y(+130 vs corner)/moderate/right; 445y(+160 vs corner)/moderate/right | L:0obs/0feat/q=n R:2obs/1feat/q=n |  |
| Bethpage Black | 1 | 4 | 387(derived) | 4iron | driver | bend-cap@280 | right@280/82y | 295y(+15 vs corner)/moderate/right; 325y(+45 vs corner)/moderate/right; 360y(+80 vs corner)/moderate/right; 375y(+95 vs corner)/moderate/right; 460y(+180 vs corner)/moderate/right; 465y(+185 vs corner)/moderate/center; 480y(+200 vs corner)/moderate/right | L:0obs/0feat/q=n R:6obs/6feat/q=Y | FLAG |
| Bethpage Black | 2 | 4 | 372(derived) | 4iron | driver | bend-cap@240 | left@240/44y | 235y(-5 vs corner)/moderate/left; 240y(+0 vs corner)/moderate/right; 280y(+40 vs corner)/moderate/right; 290y(+50 vs corner)/moderate/left; 290y(+50 vs corner)/moderate/right; 325y(+85 vs corner)/moderate/right; 330y(+90 vs corner)/moderate/left; 405y(+165 vs corner)/moderate/left; 410y(+170 vs corner)/moderate/left | L:2obs/2feat/q=n R:2obs/2feat/q=n | FLAG |
| Bethpage Black | 4 | 5 | 507(derived) | 3wood | driver | bend-cap@265 | left@265/51y | 285y(+20 vs corner)/moderate/right; 330y(+65 vs corner)/moderate/left; 355y(+90 vs corner)/moderate/right; 360y(+95 vs corner)/moderate/left; 375y(+110 vs corner)/moderate/left; 420y(+155 vs corner)/moderate/right; 495y(+230 vs corner)/moderate/right; 555y(+290 vs corner)/moderate/right; 585y(+320 vs corner)/moderate/right | L:0obs/0feat/q=n R:5obs/5feat/q=Y |  |
| Bethpage Black | 5 | 4 | 477(derived) | driver | driver | none | straight/9y | - | L:1obs/1feat/q=n R:4obs/4feat/q=Y |  |
| Bethpage Black | 6 | 4 | 394(derived) | 5iron | hybrid | bend-cap@235 | left@235/49y | 220y(-15 vs corner)/moderate/left; 260y(+25 vs corner)/moderate/left; 265y(+30 vs corner)/moderate/right; 290y(+55 vs corner)/moderate/left; 300y(+65 vs corner)/moderate/right; 330y(+95 vs corner)/moderate/right; 345y(+110 vs corner)/moderate/right; 380y(+145 vs corner)/moderate/right; 415y(+180 vs corner)/moderate/right; 435y(+200 vs corner)/moderate/right | L:1obs/1feat/q=n R:5obs/5feat/q=Y | FLAG |
| Bethpage Black | 7 | 5 | 487(derived) | 6iron | 4iron | bend-cap@210 | right@210/110y | 205y(-5 vs corner)/moderate/left; 235y(+25 vs corner)/moderate/left; 255y(+45 vs corner)/moderate/left; 290y(+80 vs corner)/moderate/right; 315y(+105 vs corner)/moderate/right; 355y(+145 vs corner)/moderate/right; 370y(+160 vs corner)/moderate/left; 390y(+180 vs corner)/moderate/right; 405y(+195 vs corner)/moderate/left; 420y(+210 vs corner)/moderate/left; 425y(+215 vs corner)/moderate/right; 455y(+245 vs corner)/moderate/left; 465y(+255 vs corner)/moderate/right; 480y(+270 vs corner)/moderate/right; 495y(+285 vs corner)/moderate/left; 520y(+310 vs corner)/moderate/left; 550y(+340 vs corner)/moderate/left; 575y(+365 vs corner)/moderate/left | L:0obs/0feat/q=n R:6obs/6feat/q=Y | FLAG |
| Bethpage Black | 9 | 4 | 526(derived) | driver | driver | none | left@295/122y | 295y(+0 vs corner)/moderate/right; 335y(+40 vs corner)/moderate/left; 370y(+75 vs corner)/moderate/right; 415y(+120 vs corner)/moderate/left; 450y(+155 vs corner)/moderate/left; 450y(+155 vs corner)/moderate/right; 510y(+215 vs corner)/moderate/left | L:1obs/1feat/q=n R:13obs/13feat/q=Y |  |
| Bethpage Black | 10 | 4 | 496(derived) | driver | driver | none | left@335/31y | 335y(+0 vs corner)/moderate/right; 405y(+70 vs corner)/moderate/right; 475y(+140 vs corner)/moderate/right; 550y(+215 vs corner)/moderate/right | L:0obs/0feat/q=n R:1obs/1feat/q=n |  |
| Bethpage Black | 11 | 4 | 435(derived) | driver | driver | none | straight/15y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Black | 12 | 4 | 536(derived) | driver | driver | none | left@290/52y | 290y(+0 vs corner)/moderate/right; 320y(+30 vs corner)/moderate/left; 320y(+30 vs corner)/moderate/right; 350y(+60 vs corner)/moderate/right; 385y(+95 vs corner)/moderate/right; 535y(+245 vs corner)/moderate/left; 565y(+275 vs corner)/moderate/left | L:0obs/0feat/q=n R:5obs/5feat/q=Y |  |
| Bethpage Black | 13 | 5 | 602(derived) | driver | driver | none | right@340/16y | 350y(+10 vs corner)/moderate/left; 390y(+50 vs corner)/moderate/right; 425y(+85 vs corner)/moderate/left; 465y(+125 vs corner)/moderate/right; 500y(+160 vs corner)/moderate/left; 540y(+200 vs corner)/moderate/right; 560y(+220 vs corner)/moderate/left; 605y(+265 vs corner)/moderate/left; 610y(+270 vs corner)/moderate/right; 630y(+290 vs corner)/moderate/right | L:4obs/4feat/q=Y R:5obs/5feat/q=Y |  |
| Bethpage Black | 15 | 4 | 472(derived) | driver | driver | none | left@290/40y | 315y(+25 vs corner)/moderate/left; 375y(+85 vs corner)/moderate/left; 405y(+115 vs corner)/moderate/left; 425y(+135 vs corner)/moderate/left; 440y(+150 vs corner)/moderate/right; 465y(+175 vs corner)/moderate/left; 480y(+190 vs corner)/moderate/right; 515y(+225 vs corner)/moderate/right; 525y(+235 vs corner)/moderate/center; 530y(+240 vs corner)/moderate/left; 540y(+250 vs corner)/moderate/right | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Black | 16 | 4 | 481(derived) | 3wood | driver | bend-cap@295 | left@295/23y | 350y(+55 vs corner)/moderate/left; 370y(+75 vs corner)/moderate/left | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Bethpage Black | 18 | 4 | 508(derived) | driver | driver | none | left@395/41y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pine Valley | 1 | 4 | 349(derived) | 4iron | 5wood | bend-cap@240 | right@240/103y | 300y(+60 vs corner)/moderate/right; 330y(+90 vs corner)/moderate/right; 355y(+115 vs corner)/moderate/right; 375y(+135 vs corner)/moderate/right; 410y(+170 vs corner)/moderate/right; 435y(+195 vs corner)/moderate/right; 450y(+210 vs corner)/moderate/center | L:0obs/0feat/q=n R:1obs/1feat/q=n | FLAG |
| Pine Valley | 2 | 4 | 355(derived) | driver | driver | none | straight/8y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pine Valley | 4 | 4 | 477(derived) | driver | driver | none | right@330/65y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pine Valley | 6 | 4 | 372(derived) | driver | driver | none | right@225/76y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pine Valley | 7 | 5 | 633(derived) | driver | driver | none | right@340/24y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pine Valley | 8 | 4 | 348(derived) | driver | driver | none | left@265/43y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pine Valley | 9 | 4 | 554(derived) | 9iron | 7iron | bend-cap@175 | left@175/43y | 455y(+280 vs corner)/moderate/left; 470y(+295 vs corner)/moderate/left; 495y(+320 vs corner)/moderate/left; 535y(+360 vs corner)/moderate/left; 570y(+395 vs corner)/moderate/left; 580y(+405 vs corner)/moderate/left | L:0obs/0feat/q=n R:0obs/0feat/q=n | FLAG |
| Pine Valley | 11 | 4 | 402(derived) | driver | driver | none | right@335/17y | 360y(+25 vs corner)/moderate/right; 390y(+55 vs corner)/moderate/right; 415y(+80 vs corner)/moderate/right | L:0obs/0feat/q=n R:2obs/1feat/q=n |  |
| Pine Valley | 12 | 4 | 321(derived) | driver | driver | none | left@300/65y | 300y(+0 vs corner)/moderate/right; 320y(+20 vs corner)/moderate/right | L:0obs/0feat/q=n R:4obs/1feat/q=Y |  |
| Pine Valley | 13 | 4 | 464(derived) | driver | driver | none | left@320/71y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pine Valley | 15 | 5 | 631(derived) | driver | driver | none | straight/1y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pine Valley | 16 | 4 | 473(derived) | 6iron | 4iron | bend-cap@225 | right@225/63y | 285y(+60 vs corner)/moderate/right; 380y(+155 vs corner)/moderate/right | L:0obs/0feat/q=n R:0obs/0feat/q=n | FLAG |
| Pine Valley | 17 | 4 | 325(derived) | driver | driver | none | right@250/34y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pine Valley | 18 | 4 | 470(derived) | driver | driver | none | right@335/30y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pinehurst No. 2 | 1 | 4 | 399(derived) | driver | driver | none | left@255/23y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pinehurst No. 2 | 2 | 4 | 475(derived) | driver | driver | none | right@315/22y | 345y(+30 vs corner)/moderate/right; 410y(+95 vs corner)/moderate/right; 440y(+125 vs corner)/moderate/right; 470y(+155 vs corner)/moderate/right; 510y(+195 vs corner)/moderate/right; 545y(+230 vs corner)/moderate/right; 570y(+255 vs corner)/moderate/right | L:0obs/0feat/q=n R:1obs/1feat/q=n |  |
| Pinehurst No. 2 | 3 | 4 | 379(derived) | 3wood | driver | bend-cap@275 | right@275/36y | 290y(+15 vs corner)/moderate/right; 325y(+50 vs corner)/moderate/right; 365y(+90 vs corner)/moderate/right | L:0obs/0feat/q=n R:2obs/1feat/q=n |  |
| Pinehurst No. 2 | 4 | 4 | 496(derived) | driver | driver | none | left@310/43y | 355y(+45 vs corner)/moderate/left; 425y(+115 vs corner)/moderate/left; 490y(+180 vs corner)/moderate/left | L:1obs/1feat/q=n R:0obs/0feat/q=n |  |
| Pinehurst No. 2 | 5 | 5 | 565(derived) | driver | driver | none | left@295/50y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pinehurst No. 2 | 7 | 4 | 351(derived) | driver | driver | none | right@215/89y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pinehurst No. 2 | 8 | 5 | 447(derived) | driver | driver | none | right@470/92y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pinehurst No. 2 | 10 | 5 | 614(derived) | driver | driver | none | left@330/24y | 385y(+55 vs corner)/moderate/left; 410y(+80 vs corner)/moderate/left; 445y(+115 vs corner)/moderate/left; 485y(+155 vs corner)/moderate/left; 525y(+195 vs corner)/moderate/left; 555y(+225 vs corner)/moderate/left; 595y(+265 vs corner)/moderate/left; 595y(+265 vs corner)/moderate/left | L:1obs/1feat/q=n R:0obs/0feat/q=n |  |
| Pinehurst No. 2 | 11 | 4 | 379(derived) | driver | driver | none | right@235/22y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pinehurst No. 2 | 12 | 4 | 445(derived) | driver | driver | none | right@305/32y | 285y(-20 vs corner)/moderate/right; 390y(+85 vs corner)/moderate/right; 445y(+140 vs corner)/moderate/right; 475y(+170 vs corner)/moderate/right; 500y(+195 vs corner)/moderate/center; 520y(+215 vs corner)/moderate/center; 535y(+230 vs corner)/moderate/right; 560y(+255 vs corner)/moderate/center | L:0obs/0feat/q=n R:1obs/1feat/q=n |  |
| Pinehurst No. 2 | 13 | 4 | 375(derived) | driver | driver | none | right@240/26y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pinehurst No. 2 | 14 | 4 | 471(derived) | 9iron | 8iron | bend-cap@175 | right@175/61y | 200y(+25 vs corner)/moderate/left; 275y(+100 vs corner)/moderate/left; 345y(+170 vs corner)/moderate/left; 410y(+235 vs corner)/moderate/left; 435y(+260 vs corner)/moderate/left | L:1obs/1feat/q=n R:0obs/0feat/q=n | FLAG |
| Pinehurst No. 2 | 16 | 5 | 521(derived) | driver | driver | none | left@240/60y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Pinehurst No. 2 | 18 | 4 | 398(derived) | driver | driver | none | left@90/41y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 1 | 4 | 414(derived) | 3wood | driver | bend-cap@295 | right@295/18y | 360y(+65 vs corner)/moderate/right; 400y(+105 vs corner)/moderate/right; 420y(+125 vs corner)/moderate/right | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 2 | 5 | 543(derived) | driver | driver | none | left@260/57y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 4 | 4 | 387(derived) | driver | driver | none | straight/14y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 5 | 5 | 443(derived) | driver | driver | none | left@220/83y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 6 | 5 | 508(derived) | driver | driver | none | left@265/65y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 8 | 4 | 312(derived) | driver | driver | none | right@255/53y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 9 | 4 | 318(derived) | driver | driver | none | straight/6y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 10 | 5 | 472(derived) | driver | driver | none | right@255/26y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 11 | 4 | 449(derived) | driver | driver | none | right@275/24y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 12 | 4 | 363(derived) | driver | driver | none | right@250/78y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 13 | 4 | 387(derived) | driver | driver | none | straight/8y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 14 | 4 | 262(derived) | 4iron | driver | none | left@205/33y | 195y(-10 vs corner)/moderate/left; 195y(-10 vs corner)/moderate/right; 230y(+25 vs corner)/moderate/left; 230y(+25 vs corner)/moderate/center; 235y(+30 vs corner)/moderate/right; 265y(+60 vs corner)/moderate/left; 275y(+70 vs corner)/moderate/right; 295y(+90 vs corner)/moderate/left; 310y(+105 vs corner)/moderate/right; 335y(+130 vs corner)/moderate/left; 350y(+145 vs corner)/moderate/right; 350y(+145 vs corner)/moderate/center; 365y(+160 vs corner)/moderate/right; 365y(+160 vs corner)/moderate/center; 370y(+165 vs corner)/moderate/left; 380y(+175 vs corner)/moderate/left | L:7obs/7feat/q=Y R:9obs/9feat/q=Y | FLAG |
| Cypress Point Club | 17 | 4 | 351(derived) | driver | driver | none | right@245/57y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Cypress Point Club | 18 | 4 | 339(derived) | driver | driver | none | right@235/26y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Kiawah Island (Ocean Course) | 1 | 4 | 505(derived) | driver | driver | none | right@410/22y | 480y(+70 vs corner)/moderate/right; 500y(+90 vs corner)/moderate/right | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Kiawah Island (Ocean Course) | 2 | 5 | 470(derived) | 4iron | 5wood | bend-cap@245 | left@245/103y | 275y(+30 vs corner)/moderate/left; 310y(+65 vs corner)/moderate/left; 345y(+100 vs corner)/moderate/left; 365y(+120 vs corner)/moderate/left; 435y(+190 vs corner)/moderate/left; 520y(+275 vs corner)/moderate/right; 540y(+295 vs corner)/moderate/right | L:1obs/1feat/q=n R:0obs/0feat/q=n | FLAG |
| Kiawah Island (Ocean Course) | 3 | 4 | 357(derived) | 4iron | 5wood | bend-cap@245 | left@245/49y | 310y(+65 vs corner)/moderate/left; 330y(+85 vs corner)/moderate/left | L:1obs/1feat/q=n R:0obs/0feat/q=n | FLAG |
| Kiawah Island (Ocean Course) | 4 | 4 | 391(derived) | driver | driver | none | left@135/21y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Kiawah Island (Ocean Course) | 6 | 4 | 460(derived) | driver | driver | none | left@325/39y | 350y(+25 vs corner)/moderate/right; 375y(+50 vs corner)/moderate/right; 420y(+95 vs corner)/moderate/right | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Kiawah Island (Ocean Course) | 7 | 5 | 551(derived) | driver | driver | none | right@320/59y | 360y(+40 vs corner)/moderate/right; 525y(+205 vs corner)/moderate/right; 560y(+240 vs corner)/moderate/right; 590y(+270 vs corner)/moderate/right | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Kiawah Island (Ocean Course) | 9 | 4 | 482(derived) | driver | driver | none | straight/2y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Kiawah Island (Ocean Course) | 10 | 4 | 433(derived) | driver | driver | none | right@305/18y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Kiawah Island (Ocean Course) | 11 | 5 | 532(derived) | driver | driver | none | right@350/22y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Kiawah Island (Ocean Course) | 12 | 4 | 467(derived) | driver | driver | none | straight/2y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Kiawah Island (Ocean Course) | 13 | 4 | 462(derived) | driver | driver | none | right@295/18y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Kiawah Island (Ocean Course) | 15 | 4 | 463(derived) | driver | driver | none | straight/12y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Kiawah Island (Ocean Course) | 16 | 5 | 575(derived) | driver | driver | none | straight/13y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Kiawah Island (Ocean Course) | 18 | 4 | 546(derived) | driver | driver | none | right@380/80y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Muirfield Village | 3 | 4 | 443(derived) | driver | driver | none | left@325/71y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Muirfield Village | 5 | 5 | 581(derived) | driver | driver | none | right@365/97y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Muirfield Village | 6 | 4 | 449(derived) | driver | driver | none | right@310/24y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Muirfield Village | 7 | 5 | 561(derived) | driver | driver | none | left@220/55y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Muirfield Village | 9 | 4 | 414(derived) | driver | driver | none | right@315/17y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Muirfield Village | 10 | 4 | 643(derived) | 3wood | driver | corridor-cost | left@490/47y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Muirfield Village | 11 | 5 | 571(derived) | driver | driver | none | left@320/66y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Muirfield Village | 13 | 4 | 435(derived) | driver | driver | none | left@305/54y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Muirfield Village | 14 | 4 | 355(derived) | 4iron | 5wood | corridor-cost | straight/1y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n | FLAG |
| Muirfield Village | 15 | 5 | 555(derived) | driver | driver | none | right@320/37y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Muirfield Village | 17 | 4 | 497(derived) | driver | driver | none | straight/14y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Muirfield Village | 18 | 4 | 536(derived) | driver | driver | none | right@335/122y | 580y(+245 vs corner)/moderate/right | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 1 | 4 | 372(derived) | driver | driver | none | right@225/38y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 3 | 4 | 496(derived) | driver | driver | none | left@315/37y | 520y(+205 vs corner)/moderate/left; 560y(+245 vs corner)/moderate/left | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 4 | 4 | 460(derived) | driver | driver | none | right@345/53y | 345y(+0 vs corner)/moderate/left; 375y(+30 vs corner)/moderate/left | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 5 | 5 | 579(derived) | driver | driver | none | right@290/38y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 6 | 4 | 476(derived) | driver | driver | none | right@300/58y | 360y(+60 vs corner)/moderate/right; 395y(+95 vs corner)/moderate/right | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 8 | 4 | 501(derived) | driver | driver | none | right@395/25y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 9 | 4 | 567(derived) | driver | driver | none | left@410/74y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 10 | 4 | 317(derived) | driver | driver | none | right@230/102y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 12 | 5 | 469(derived) | driver | driver | none | right@215/31y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 13 | 4 | 354(derived) | driver | driver | none | right@250/49y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 14 | 4 | 456(derived) | driver | driver | none | right@305/40y | 435y(+130 vs corner)/moderate/left | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 15 | 4 | 395(derived) | 5iron | 4iron | bend-cap@240 | right@240/44y | 360y(+120 vs corner)/moderate/right; 425y(+185 vs corner)/moderate/right | L:0obs/0feat/q=n R:0obs/0feat/q=n | FLAG |
| Shinnecock Hills | 16 | 5 | 584(derived) | driver | driver | none | right@300/56y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Shinnecock Hills | 18 | 4 | 593(derived) | driver | driver | none | left@455/60y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Oakmont Country Club | 1 | 4 | 480(derived) | driver | driver | none | straight/7y | - | L:0obs/0feat/q=n R:1obs/1feat/q=n |  |
| Oakmont Country Club | 2 | 4 | 334(derived) | driver | driver | none | straight/8y | - | L:0obs/0feat/q=n R:2obs/2feat/q=n |  |
| Oakmont Country Club | 3 | 4 | 436(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:4obs/4feat/q=Y |  |
| Oakmont Country Club | 4 | 5 | 574(derived) | driver | driver | none | right@290/77y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Oakmont Country Club | 5 | 4 | 434(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Oakmont Country Club | 7 | 4 | 473(derived) | driver | driver | none | straight/1y | - | L:0obs/0feat/q=n R:1obs/1feat/q=n |  |
| Oakmont Country Club | 9 | 5 | 463(derived) | driver | driver | none | straight/10y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Oakmont Country Club | 10 | 4 | 457(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Oakmont Country Club | 11 | 4 | 378(derived) | driver | driver | none | straight/14y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Oakmont Country Club | 12 | 5 | 623(derived) | driver | driver | none | right@385/41y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Oakmont Country Club | 14 | 4 | 344(derived) | driver | driver | none | straight/12y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Oakmont Country Club | 15 | 4 | 491(derived) | driver | driver | none | straight/14y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Oakmont Country Club | 17 | 4 | 301(derived) | driver | driver | none | left@230/35y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Oakmont Country Club | 18 | 4 | 563(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 1 | 4 | 355(derived) | 4iron | 5wood | corridor-cost | straight/1y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n | FLAG |
| St Andrews (Old Course) | 2 | 4 | 386(derived) | driver | driver | none | straight/5y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 3 | 4 | 405(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 4 | 4 | 480(derived) | driver | driver | none | left@320/18y | 320y(+0 vs corner)/moderate/right; 360y(+40 vs corner)/moderate/right; 380y(+60 vs corner)/moderate/right; 430y(+110 vs corner)/moderate/left | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 5 | 5 | 562(derived) | driver | driver | none | straight/6y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 6 | 4 | 359(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 7 | 4 | 332(derived) | driver | driver | none | right@240/39y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 9 | 4 | 348(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 10 | 4 | 375(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 12 | 4 | 343(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 13 | 4 | 420(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 14 | 5 | 492(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 15 | 4 | 348(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 16 | 4 | 418(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 17 | 4 | 488(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| St Andrews (Old Course) | 18 | 4 | 370(derived) | driver | driver | none | straight/0y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Augusta National | 1 | 4 | 432(derived) | driver | driver | none | right@285/26y | 330y(+45 vs corner)/moderate/right; 405y(+120 vs corner)/moderate/right; 485y(+200 vs corner)/moderate/right; 495y(+210 vs corner)/moderate/right | L:0obs/0feat/q=n R:9obs/1feat/q=Y |  |
| Augusta National | 2 | 5 | 537(derived) | 4iron | driver | bend-cap@300 | left@300/90y | 305y(+5 vs corner)/moderate/right; 340y(+40 vs corner)/moderate/left; 380y(+80 vs corner)/moderate/right; 420y(+120 vs corner)/moderate/left; 460y(+160 vs corner)/moderate/right; 465y(+165 vs corner)/moderate/right; 480y(+180 vs corner)/moderate/left; 520y(+220 vs corner)/moderate/left | L:11obs/1feat/q=Y R:6obs/1feat/q=Y | FLAG |
| Augusta National | 3 | 4 | 379(derived) | driver | driver | none | right@280/27y | none | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Augusta National | 5 | 4 | 457(derived) | driver | driver | none | right@350/63y | 360y(+10 vs corner)/moderate/left; 365y(+15 vs corner)/moderate/left; 500y(+150 vs corner)/moderate/left; 555y(+205 vs corner)/moderate/left; 570y(+220 vs corner)/moderate/right; 610y(+260 vs corner)/moderate/right; 650y(+300 vs corner)/moderate/right; 685y(+335 vs corner)/moderate/left; 690y(+340 vs corner)/moderate/right; 710y(+360 vs corner)/moderate/left; 720y(+370 vs corner)/moderate/right | L:2obs/2feat/q=n R:1obs/1feat/q=n |  |
| Augusta National | 7 | 4 | 439(derived) | driver | driver | none | straight/5y | - | L:2obs/2feat/q=n R:0obs/0feat/q=n |  |
| Augusta National | 8 | 5 | 558(derived) | driver | driver | none | right@310/20y | none | L:0obs/0feat/q=n R:3obs/3feat/q=Y |  |
| Augusta National | 9 | 4 | 438(derived) | driver | driver | none | left@325/69y | 305y(-20 vs corner)/moderate/right; 310y(-15 vs corner)/moderate/left; 330y(+5 vs corner)/moderate/right; 350y(+25 vs corner)/moderate/left; 360y(+35 vs corner)/moderate/left | L:12obs/1feat/q=Y R:10obs/1feat/q=Y |  |
| Augusta National | 10 | 4 | 482(derived) | 5iron | 4iron | bend-cap@265 | left@265/60y | 250y(-15 vs corner)/moderate/left; 325y(+60 vs corner)/moderate/left; 405y(+140 vs corner)/moderate/left; 485y(+220 vs corner)/moderate/left; 490y(+225 vs corner)/moderate/right; 520y(+255 vs corner)/moderate/left | L:3obs/2feat/q=Y R:0obs/0feat/q=n | FLAG |
| Augusta National | 11 | 4 | 524(derived) | driver | driver | none | right@360/25y | 345y(-15 vs corner)/moderate/right; 370y(+10 vs corner)/moderate/right; 385y(+25 vs corner)/moderate/left; 390y(+30 vs corner)/moderate/right; 460y(+100 vs corner)/moderate/left; 495y(+135 vs corner)/moderate/left | L:8obs/1feat/q=Y R:0obs/0feat/q=n |  |
| Augusta National | 13 | 5 | 451(derived) | 3wood | driver | bend-cap@285 | left@285/130y | 330y(+45 vs corner)/moderate/left; 400y(+115 vs corner)/moderate/left; 450y(+165 vs corner)/moderate/left; 515y(+230 vs corner)/moderate/left; 585y(+300 vs corner)/moderate/left; 660y(+375 vs corner)/moderate/left; 700y(+415 vs corner)/moderate/left | L:1obs/1feat/q=n R:0obs/0feat/q=n |  |
| Augusta National | 14 | 4 | 429(derived) | 3wood | driver | bend-cap@270 | left@270/29y | 260y(-10 vs corner)/moderate/left; 295y(+25 vs corner)/moderate/left; 330y(+60 vs corner)/moderate/left; 355y(+85 vs corner)/moderate/left; 450y(+180 vs corner)/moderate/right | L:8obs/1feat/q=Y R:0obs/0feat/q=n |  |
| Augusta National | 15 | 5 | 541(derived) | driver | driver | none | straight/1y | - | L:0obs/0feat/q=n R:0obs/0feat/q=n |  |
| Augusta National | 17 | 4 | 467(derived) | driver | driver | none | left@290/44y | 270y(-20 vs corner)/moderate/left; 270y(-20 vs corner)/moderate/right; 300y(+10 vs corner)/moderate/right; 325y(+35 vs corner)/moderate/right; 365y(+75 vs corner)/moderate/right; 385y(+95 vs corner)/moderate/right | L:2obs/1feat/q=n R:8obs/1feat/q=Y |  |
| Augusta National | 18 | 4 | 488(derived) | driver | 5wood | none | right@330/78y | 320y(-10 vs corner)/moderate/left; 335y(+5 vs corner)/moderate/right; 355y(+25 vs corner)/moderate/left; 380y(+50 vs corner)/moderate/left; 400y(+70 vs corner)/moderate/right; 450y(+120 vs corner)/moderate/right | L:3obs/1feat/q=Y R:17obs/1feat/q=Y |  |

**Totals:** 168 par-4/5 holes audited, 20 flagged.

