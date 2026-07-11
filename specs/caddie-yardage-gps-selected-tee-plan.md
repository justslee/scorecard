# Caddie Yardage: GPS-to-Green + Selected-Tee Grounding (fix plan)

**Bug (owner, 2026-07-11, Bethpage Black hole 3, GPS active):** caddie sheet header shows "HOLE 3 · PAR 3 · 178 YDS"; caddie says "178 on the card… trust that number" and argues when the owner corrects to 231 (the black tees he's playing). GPS is live and the green is mapped — neither is used. Recurring after `specs/multi-tee-anchor-reconciliation-plan.md` (bundle #119), which reconciled geometry to the card number (~174/178) instead of the tees the golfer selected.

## 1. Root-cause diagnosis (the full chain, with file:line)

**The 178 is the MOCK ILLUSTRATION constant — not any card.**
- `frontend/src/components/yardage/HoleIllustration.tsx:20` — mock hole 3 is `{ par: 3, yards: 178 }`. The prior spec (Leg B) already identified this constant as the phantom-178 source and fixed the round-page pill only.
- The standard round-setup flow stores NO per-hole yards: `frontend/src/app/round/new/page.tsx:350-352` builds `holeList` from `createDefaultCourse(courseName)` (pars only, `frontend/src/lib/types.ts:306-328`), so `round.holes[2].yards` is `undefined`. (Only the tournament flow snapshots tee yardages: `NewTournamentRoundClient.tsx:439`.)
- `frontend/src/app/round/[id]/RoundPageClient.tsx:2243` — `holeYards={round.holes[currentHole - 1]?.yards ?? hole.yards}` where `hole = HOLES[currentHole - 1]` (line 816). With no card yards, **`holeYards` = mock 178**. Same fallback feeds the offline card at line 2221. The prior fix's honest header ladder (`headerYards`, 1194-1195) was applied to the round-page pill only — the CaddieSheet prop, live-voice context, and offline card kept the raw mock fallback. **That is the recurrence.**

**178 reaches every caddie mouth; 231 and GPS reach none:**
- Sheet header: `CaddieSheet.tsx:1406` renders `Hole {n} · Par {p} · {holeYards} yds` → "178 YDS".
- Stateless voice: `CaddieSheet.tsx:641/658` send `yards: holeYards` (178) → `backend/app/routes/caddie.py:1279` injects `Current hole: #3, Par 3, 178 yards` into the prompt. The model paraphrases as "178 **on the card**" — nothing says where the number came from. `VoiceCaddieRequest.yards` defaults to `400` (types.py:277); `distance_yards` (types.py:278, prompt 1283-1284) exists but the voice sheet never sets it (only the manual tap-distance path does, CaddieSheet.tsx:1101-1120).
- Session voice: `SessionVoiceRequest` (caddie.py:193-198) carries ONLY round_id/transcript/personality_id/hole_number — **no GPS, no distance, no yards field at all.** Grounds on `session.hole_intel[hole].yards` (caddie.py:621-631), built with `yards: round.holes[c.holeNumber-1]?.yards` (RoundPageClient.tsx:763) = undefined → no yardage; tool default `intel.yards or 400` (tools.py:857).
- Live (realtime) voice: `useCaddieLiveSession.ts:84-86,174` — anchored + re-anchored per hole with `holeYards` = mock 178.
- GPS exists + gated: `RoundPageClient.tsx:1139-1146` computes `posOnHole` (5–800y) and `fcbLive` — used only for tiles, never plumbed to any caddie request or the header.

**Selected tee is captured but dropped:**
- `round.teeName` ("Black") IS stored at setup (round/new/page.tsx:383, types.ts:193-194; voice maps "black" at 276) and feeds `applyTeeAnchors` (RoundPageClient.tsx:352-359).
- But `resolveTeeAnchor` (tee-anchor.ts:235-241) requires a *tagged* box for a named match, and OSM boxes are typically untagged (tee-anchor.ts:32-35). With `cardYards: null`, card-nearest is skipped (244), single-box fails (5 boxes, 250) → anchor is `legacy` (arbitrary). The black box geometry (~232y) sits unused; the mapped course per-tee card map `HoleData.yardages[teeName]` (courses/types.ts:21, populated via golf-api.ts:602-621,682-690) is never consulted for a round's yardage.
- The prior fix reconciles geometry to `hole.yards`/cardYards — absent or the scorecard default — never to the golfer's tee.

**Why the caddie argues:** `OBSERVED_REALITY_RULE` (voice_prompts.py:42-50) defers to the player only on *visually observable* facts. A yardage isn't covered, and `TOOL_USE_RULE`/`_BASE_BEHAVIOR` instruct "never state a yardage that came from neither a tool nor the CURRENT SITUATION" — so the model's only grounded number is 178 and it doubles down. The grounding is the bug; the prompt rule is the aggravator.

## 2. Fix design (GPS-to-green when on the hole, else selected-tee distance, never the scorecard default)

### 2.1 One shared yardage resolver (frontend, pure) — new `frontend/src/lib/caddie/hole-yardage.ts`
`resolveHoleYardage({ fcbLive, selectedTeeCardYards, selectedTeeGeomYards, cardYards, par }) -> { yards: number|null, basis: 'gps'|'tee-card'|'tee-geom'|'card'|null }`
Priority: (1) `fcbLive.center` → `gps` (existing 5–800y gate = on-the-hole test); (2) selected-tee card yards (Bethpage black hole 3 → 231); (3) selected-tee geometry (par-3 exact ~232; par 4/5 floor only); (4) real card snapshot; (5) null → honest "—", prompt omits the yardage line. **The mock `HOLES[i].yards` is banned from every caddie/grounding surface** (kept only for the paper illustration on unmapped rounds).

### 2.2 Selected tee becomes known (half already is)
- Setup already captures `round.teeName` (picker + voice). No new UI.
- **Snapshot per-hole selected-tee yards at creation**: in round/new `handleTeeOff`, when the course has tee data, store `selectedTee.holes` into `round.holes` (as the tournament flow already does, NewTournamentRoundClient.tsx:439). Store `teeId`.
- **Hydrate for mapped/legacy rounds**: surface mapped `CourseData.holes[].yardages` from `useHoleCoordinates`; derive `selectedTeeCardYards = yardages[matchName(round.teeName)]` per hole (reuse `namesMatch`, tee-anchor.ts:93). No migration.
- **Untagged-box tee selection (tee-anchor enhancement)**: when boxes untagged + teeName present, add ordinal fallback — rank boxes by yardsToGreen desc; count-match ordinal align, else safe endpoints ("black"/"tips" → back-most; "red"/"forward" → shortest); ambiguous → existing honest paths. Flips Bethpage hole 3 to the 232 box → also fixes "from the tee" tiles + wind bearing.
- Selected-tee **card** (231) beats **geometry** (232) for the spoken number; geometry for map anchor + no-card fallback.

### 2.3 Plumb one number everywhere (all surfaces agree)
RoundPageClient computes `resolvedYardage` once per hole/GPS tick, passes `{yards, basis}`:
- CaddieSheet header (replace holeYards, RoundPageClient:2243): resolved number + honest basis caption ("204 to the green" / "231 yds · black tees" / "—").
- Live session context (useCaddieLiveSession): re-anchor with resolved number + basis; re-send when basis flips (GPS acquired/lost), not just on hole change.
- Offline card (2221) + plays-basis: `cardYards` (1151) = selected-tee card snapshot → headerYards, F/C/B card-only tiles, plays-like all read 231. GPS tiles path already first + unchanged.
- Voice requests: CaddieSheet sends `yards: resolved.yards`, `yardage_basis: resolved.basis`, + a live `distanceToGreenYards` (fcbLive.center) so BOTH stateless (`distance_yards`) and session requests carry it per turn.

### 2.4 Backend grounding + prompt (stop "on the card", stop arguing)
- `SessionVoiceRequest` (caddie.py:193): add optional `distance_to_green_yards`, `hole_yards`, `yardage_basis` (additive/defaulted). Mirror on the streaming twin + `VoiceCaddieRequest` (drop fake `yards:int=400` → `Optional[int]=None`).
- `_build_session_voice_prompt` (617-631) + `_build_voice_prompt` (1279-1284): one shared yardage-context formatter labeling provenance:
  - GPS: `Distance to the middle of the green, GPS from where the player stands NOW: 204 yards. This is the player's real number — use it.`
  - Tee: `Hole 3, Par 3 — 231 yards from the {teeName} tees (the tees this player is playing). Do not quote any other tee's yardage.`
  - Else: par only + "yardage unknown — ask the player or say so."
  - `hole_intel.yards` demoted to elevation/effective-delta math only, never spoken when a better basis exists.
- New shared `YARDAGE_GROUNDING_RULE` in voice_prompts.py (both stable_text + build_realtime_instructions, like OBSERVED_REALITY_RULE): the GPS/selected-tee number is ground truth; if the player states a different yardage (rangefinder/tee sign), adopt THEIRS immediately — never defend a stored number against the golfer's reality; never say "on the card" unless it's really that player's tee card.
- Tool default (tools.py:857): `get_recommendation` with no distance → the request-carried resolved yardage (stash `session.current_yardage` per turn), not `intel.yards or 400`.
- Course-intel input (RoundPageClient.tsx:763): send selected-tee snapshot yards → hole_intel.effective_yards/physics coherent.

No-fake-data: GPS only from a real fix inside the gate; tee only from real tee data; else omit — never 400, never the mock.

## 3. Build slices (smallest valuable first)
1. **Shared resolver + kill the mock on caddie surfaces** — `hole-yardage.ts` + tests; replace `?? hole.yards` at RoundPageClient:2243/2221; header caption. Ships alone: header stops lying before backend changes.
2. **Selected-tee yardage capture** — round/new snapshot of selectedTee.holes; mapped yardages[teeName] hydration; tee-anchor untagged-ordinal/back-most rule. Bethpage hole 3 → 231/232.
3. **GPS + basis to the caddie grounding** — new optional fields on the request models (+ streaming twins + caddie/api.ts params), CaddieSheet/live-session plumbing, shared prompt yardage formatter, course-intel yards input, tool default.
4. **Prompt agreement rule** — `YARDAGE_GROUNDING_RULE` both mouths + realtime; provenance labels; eval-fixture the "player corrects the yardage" turn.

## 4. Test strategy (Bethpage-hole-3 goes RED on today's code)
- Frontend fixture (RED today): green at fixed lat/lng, 5 untagged boxes 232/207/174/159/136, round `{teeName:"Black", holes[2]:{par:3}}` (no yards — real prod shape). Assert today's holeYards = 178 (mock); resolveHoleYardage = 231 (tee-card) / ~232 (tee-geom), NEVER 178. GPS: 204y from green → {204,'gps'}; 900y off hole → tee basis; nothing → {null}.
- tee-anchor: untagged + "black" → back-most; ordinal align; ambiguity → honest fallback (all existing precedence + GPS-wins tests stay green).
- Backend prompt: `_build_session_voice_prompt` with distance_to_green_yards=204 has the GPS line + NOT "178"; tee basis has "231"+"Black tees"; nothing → no fabricated yardage, no "400". Same for `_build_voice_prompt` with yards=None.
- Agreement invariant: header value == caddie-request value == plays/F-C-B card basis (single resolver → near-tautological; guards divergence regression).
- Eval turn (caddie-advice-eval): "I thought this hole was 231" with grounding 231 → reply agrees, not argues.

## 5. Risks
- Tee-box geometry understates par-4/5 (doglegs) → geometry basis par-3-only; par 4/5 use tee-card/card snapshot else "at least" floor.
- Untagged-box ordinal picks wrong tee → constrained to count-match + safe endpoints; else honest fallback.
- GPS jitter/wrong hole → reuse proven 5–800y gate; basis flips visible in header caption.
- Session prompt-cache → new context in the volatile (uncached) block; request fields additive/optional (old builds unaffected).
- Legacy rounds: no teeName → skip tee basis; card snapshot or honest null; no fabricated numbers.

### Critical Files
- `frontend/src/app/round/[id]/RoundPageClient.tsx` (763, 1139–1195, 2221, 2243)
- `frontend/src/components/CaddieSheet.tsx` (641/658, 669–674, 1103/1120, 1406)
- `backend/app/routes/caddie.py` (193–198, 617–631, 1279–1284)
- `frontend/src/lib/course/tee-anchor.ts` (+ new `frontend/src/lib/caddie/hole-yardage.ts`)
- `backend/app/caddie/voice_prompts.py` (`YARDAGE_GROUNDING_RULE`; + tools.py:846–858 tool default)
