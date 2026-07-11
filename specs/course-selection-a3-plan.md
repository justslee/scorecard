# Course Selection A3 — Clarify Turn for AMBIGUOUS Spoken Course Names

Parent: `specs/course-selection-ux-plan.md` §A.2.3, §Sequencing A3. Builds on shipped A0 (dispatch gating), A1 (selector-centered discovery), A2 (`resolveSpokenCourse` + single-resolution auto-add). Frontend-only; **no backend/DB changes** (verified: candidates already carry id/name/center/locality from the unified search — nothing new is needed server-side).

## Behavior contract

1. `resolveSpokenCourse` → `ambiguous`: the ack ASKS with the real localities ("I found a few courses called Marine Park — Brooklyn, NY, or Old Bridge, NJ. Which one?"), candidates are held as **pending page state**, `dispatched:false`, and `TaskAck.expectReply:true` makes the orb host reopen the mic for the reply.
2. The NEXT utterance, while pending, is first parsed as a clarify answer: **ordinal** ("the first one", "second", "number two", "the last one"), **locality token** ("the Brooklyn one", "Marine Park in Brooklyn", "New Jersey"), **unique bare-name repeat**.
3. A pick → the SAME A2 add-flow (`courseOptionFromSelection` + `addCourseOption`, deselect untouched GPS preselects, honest real-mile distance) → dispatch iff the original turn was armed (had a window/go-ahead) or the reply adds one.
4. No match / ambiguous-again → ONE honest re-ask (`expectReply:true` again), then graceful bail. Hard budget: **2 asks total** (initial + one re-ask), then pending clears.
5. Purity split preserved: `caddie-task.ts`/`course-clarify.ts` compute everything; `page.tsx` owns pending state + the 1400ms timer; `CaddieOrbSheet.tsx` owns mic lifecycle.

## Honesty invariants (unchanged, now also under clarify)

- `dispatched:false` until a real candidate is chosen. Never a guessed course, never GPS fallback, never a fabricated locality (`localityLabel` may be `""` — fall back to the candidate name in copy, never invent).
- **A bare "yes"/"go ahead" while pending must NOT dispatch** — `BARE_YES_RE`/`DISPATCH_RE` set `parsed.dispatch:true`, and today's `planTeeTimeApply` would dispatch a search that ignores the named course (the exact A0 lie). The routing rule below closes this hole; it gets a RED test.
- Honest distance: the picked Brooklyn course reads its real ~320 mi; `maxMiles` is not fake-widened (A2 precedent, `caddie-task.test.ts:216-218`).

## Design

### Step 0 — RED tests first (all must FAIL before any product change)

New `frontend/src/lib/teetime/course-clarify.test.ts` (module doesn't exist yet — these ARE the matcher spec) and a new `describe("planTeeTimeApply — A3: clarify turn")` in `frontend/src/lib/teetime/caddie-task.test.ts`, plus host cases in `frontend/src/components/CaddieOrbSheet.test.tsx`. Fixture: candidates `[{id:"mp-bk", name:"Marine Park Golf Course", localityLabel:"Brooklyn, NY", center:BROOKLYN, address:"2880 Flatbush Ave, Brooklyn, NY"}, {id:"mp-nj", name:"Marine Park Golf Club", localityLabel:"Old Bridge, NJ", center:NJ, address:"…Old Bridge, NJ"}]`.

RED list (decision table):
1. **ambiguous → ask + pending**: `planTeeTimeApply(parsed{windows:[sat-morning], unresolvedCourseNames:["marine park"]}, current, {kind:"ambiguous", candidates})` → `dispatched:false`, `pendingClarify.candidates` = the 2, `pendingClarify.armed === true`, `expectReply === true`, line contains both "Brooklyn" and "Old Bridge" (fields don't exist today → RED).
2. **"the Brooklyn one" → picks Brooklyn + dispatches**: `matchClarifyReply("the brooklyn one", candidates)` → `{kind:"picked", candidate.id:"mp-bk"}`; `planTeeTimeApply(replyParse, {…, touched:false, origin:PITTSBURGH}, null, {pending:{…armed:true}, match})` → added + `selected:true`, GPS preselect deselected, `distance > 50`, `maxMiles === null`, `dispatched:true`, `pendingClarify === null`, `expectReply === false`, line `Found Marine Park Golf Course in Brooklyn, NY — … mi away. On it.`
3. **ordinal**: `"the first one"` / `"second"` / `"number two"` / `"the last one"` pick indices 0/1/1/last; `"the fifth one"` with 2 candidates → `{kind:"none"}`.
4. **locality forms**: `"marine park in brooklyn"` → picked (and, at page level, must NOT re-enter A2 resolution — see routing); a token hitting BOTH candidates (`"ny"` when both are NY) → `{kind:"ambiguous"}`.
5. **bare-name repeat**: reply exactly the shared name matching 2+ candidates → `ambiguous` (re-ask, not re-resolve); reply matching exactly one candidate's distinct name → picked.
6. **no-match re-ask**: pending `attempts:0`, reply "the purple one" → plan: `dispatched:false`, re-ask line names both localities, `pendingClarify.attempts === 1`, `expectReply === true`.
7. **bounded bail**: same with `attempts:1` → bail line, `pendingClarify === null`, `expectReply === false`, `dispatched:false`.
8. **"yes" can't dispatch a guess**: pending + reply `"yeah go ahead"` (`parsed.dispatch:true`, nothing else) → `routeClarifyReply` keeps the clarify lane, plan re-asks, `dispatched === false`.
9. **stale-state bail (topic change)**: pending + reply "actually Sunday afternoon anywhere" (`windows:[sunday]`, no match) → `routeClarifyReply` returns `null`; normal plan dispatches Sunday and `pendingClarify === null` (pending cleared). Same for a DIFFERENT new course name (`unresolvedCourseNames:["dyker beach"]` → normal A2 turn).
10. **host expectReply** (CaddieOrbSheet.test.tsx, fake timers): apply returns `{line, dispatched:false, expectReply:true}` → `dictation.start` is called again after the reopen beat while the sheet stays open; sheet closed (or context unregistered) before the beat → NO restart. `expectReply` absent → today's behavior byte-identical.
11. **defensive empty candidates**: `{kind:"ambiguous", candidates:[]}` → old generic line, `pendingClarify === null`, `expectReply === false` (keeps existing test `caddie-task.test.ts:267` green).

### Step 1 — Enrich the candidate payload (`frontend/src/lib/teetime/course-resolve.ts`)

Do NOT touch the decision table. Two additive changes to `ResolvedCandidate`: add `address?: string` (from `r.address` in `ambiguousOf`) so a clarify pick feeds `courseOptionFromSelection` the same honest input as the "one" path (identical `localityLabel` muni), and make `center` **required** (candidates are only ever built from `PlaceableResult`, which guarantees it — the optional type is a lie that would force a guard downstream). Update `course-resolve.test.ts` fixtures if any construct candidates loosely.

### Step 2 — New pure matcher: `frontend/src/lib/teetime/course-clarify.ts`

```ts
export interface PendingCourseClarify {
  name: string;                       // original spoken name, for honest copy
  candidates: ResolvedCandidate[];    // nearest-first as resolver ordered them
  armed: boolean;                     // original turn had a window or go-ahead
  attempts: number;                   // asks already answered-and-missed (0 after first ask)
}
export type ClarifyReplyMatch =
  | { kind: "picked"; candidate: ResolvedCandidate }
  | { kind: "ambiguous" }             // 2+ candidates matched
  | { kind: "none" };
export function matchClarifyReply(transcript: string, candidates: ResolvedCandidate[]): ClarifyReplyMatch
export function routeClarifyReply(parsed: TeeTimePrefsParseResultValidated, pending: PendingCourseClarify | null):
  { pending: PendingCourseClarify; match: ClarifyReplyMatch } | null
```

`matchClarifyReply`, staged, first stage with ≥1 hit decides (unique → picked, 2+ → ambiguous):
1. **Ordinal**: `\b(first|1st|second|2nd|third|3rd|fourth|4th)\b`, `number (one|two|three|four|\d)`, `\b(?:the )?last one\b`. Out-of-range → none. (Reuses the spirit of `ordinalTeePick` in `lib/course/tee-anchor.ts`; regex-level, not shared code — different domain.)
2. **Locality tokens**: candidate locality tokens = `localityLabel.toLowerCase().split(/[,\s]+/)` minus empties; a candidate matches when any token appears word-bounded in the normalized reply. Include a small const map of full state names → abbrevs ("new york"→"ny", "new jersey"→"nj", …) so "the New Jersey one" works.
3. **Name tokens**: `identifyingTokens` (from `@/lib/course-search-helpers`, same generic-token semantics the resolver uses) on the reply vs each candidate name; unique full match → picked; matching several identically-named candidates → **ambiguous** (this is what stops the re-resolve loop).

`routeClarifyReply` (the page's whole routing decision, pure and testable):
- no pending → `null` (normal turn — a clarify-shaped utterance with no pending falls through to converse exactly as today).
- match `picked` → clarify lane (reply may ALSO carry windows/party/price — they merge in apply).
- match not picked AND `hasNonDispatchSignal(parsed)` (windows / courseNames / unresolvedCourseNames / favoritesOnly / partySize / price / distance — **dispatch alone does NOT count**) → `null`: topic change; the normal plan clears pending.
- otherwise (bare yes, silence-noise, "the purple one") → clarify lane with the none/ambiguous match → re-ask/bail.

### Step 3 — `frontend/src/lib/teetime/caddie-task.ts`

- `TeeTimeTaskPayload` gains `clarify: {pending: PendingCourseClarify; match: ClarifyReplyMatch} | null` (default null); `teeTimeTaskParse` gains the matching optional arg. When `clarify != null`: `hasSignal: true`, `confidence: Math.max(parsed.confidence, 0.9)` (deterministic matcher — must clear the 0.6 floor so the re-ask/bail runs in the task lane, never gate (b) and never converse fall-through).
- `TeeTimeApplyPlan` gains `pendingClarify: PendingCourseClarify | null` and `expectReply: boolean`. Every branch computes them (normal branches → `null`/`false`), so the page assigns unconditionally — that IS the staleness story: any applied turn that isn't an ask clears pending.
- `planTeeTimeApply(parsed, current, resolution, clarify = null)`:
  - **Ambiguous ask branch** (existing gate, candidates non-empty): new `ambiguousAskLine(name, candidates)` listing localities (`localityLabel || name`, cap already 4 from the resolver); `pendingClarify = {name, candidates, armed: parsed.windows.length>0 || parsed.dispatch, attempts: 0}`; `expectReply:true`. Empty candidates → old generic line, no pending (defensive; keeps test :267 green). Windows/party/price from the same utterance still apply (they already do — the gate only blocks dispatch).
  - **Clarify picked**: run the standard windows/group/price section, then reuse the A2 add block (extract today's `resolvedOne` add+select+deselect-untouched code into a private helper used by both paths) with a course synthesized from the candidate (`{id, name, center, location: address}`). Skip the `unresolvedCourseNames` gate entirely on this turn — the pick IS the resolution (prevents "marine park in brooklyn" from re-tripping the gate). `dispatched = pending.armed || parsed.windows.length>0 || parsed.dispatch`; line = the A2 `Found … — … mi away.` format, `On it.` only when dispatched; `pendingClarify:null`, `expectReply:false`.
  - **Clarify none/ambiguous**: `attempts + 1 < 2` → re-ask (`Sorry — which one: Brooklyn, NY, or Old Bridge, NJ? You can say "the first one."`), `pendingClarify = {...pending, attempts: attempts+1}`, `expectReply:true`. Budget spent → bail (`No worries — I'll leave it for now. You can add it from the course list, or name the area again anytime.`), `pendingClarify:null`, `expectReply:false`. `dispatched:false` in both.

### Step 4 — `frontend/src/lib/caddie-context.ts`

`TaskAck` gains `expectReply?: boolean` — "true → the host reopens the mic for one follow-up turn after speaking the line; only meaningful with `dispatched:false`". Optional ⇒ the other registrant (`app/tournament/new/page.tsx`) needs no change.

### Step 5 — `frontend/src/app/tee-time/page.tsx` (Prefs)

- `const pendingClarifyRef = useRef<PendingCourseClarify | null>(null);` — a ref (nothing renders from it; the registered ctx delegates through refs already). It dies with `Prefs` on unmount, and the host's existing context-unmount hygiene (`CaddieOrbSheet.tsx:153-160`) closes the sheet — pending can never wedge the sheet.
- `parse`: `const route = routeClarifyReply(parsed, pendingClarifyRef.current);` — when route is non-null, **skip `resolveSpokenCourse` entirely** (never re-resolve on a clarify turn; this plus the matcher's name-repeat→ambiguous rule kills the loop) and return `teeTimeTaskParse(transcript, parsed, null, route)`. Otherwise today's A2 path unchanged (topic-change turns with a new unresolved name DO resolve normally).
- `apply`: pass `clarify` through to `planTeeTimeApply`; then `pendingClarifyRef.current = plan.pendingClarify;` unconditionally; `if (clarify?.match.kind === "picked") coursesTouchedRef.current = true;` (mirrors the `resolution?.kind === "one"` line at page.tsx:417); return `{line, dispatched, expectReply: plan.expectReply}`. The 1400ms dispatch beat is untouched — the pick arms it exactly once, `expectReply:false` on that turn, pending cleared ⇒ structurally no double-dispatch.
- `getKeyterms`: append pending candidates' `localityLabel`s (and names) so STT hears "Brooklyn" cleanly during the clarify turn.

### Step 6 — `frontend/src/components/CaddieOrbSheet.tsx` (host, mic lifecycle only)

In gate (c), after `appendTurn({role:"looper", text: ack.line})`:

```ts
if (ack.expectReply && !ack.dispatched) {
  // one hands-free follow-up turn — the clarify answer
  expectReplyTimerRef.current = setTimeout(() => {
    if (sessionRef.current !== gen || !openRef.current) return;
    if (!dictationRef.current.listening) void dictationRef.current.start();
  }, 900);
}
```

- New `expectReplyTimerRef`, cleared in `close()` and at the top of `handleMicTap` (a manual tap supersedes the auto-reopen). Gen + open guards make close/unregister/dispatch races inert. The follow-up utterance then flows through the existing `onUtteranceEnd → handleMicTap → activeTask.parse/apply` path — no new routing.
- 900ms matches the confirming-beat rhythm; no orb-state changes needed (`dictation.listening` already drives the shell's listening phase).

### Step 7 — Gates (exact)

```
cd frontend && npm run lint && npx tsc --noEmit \
  && npx tsx voice-tests/runner.ts --smoke \
  && npx vitest run src/lib/teetime/course-clarify.test.ts src/lib/teetime/caddie-task.test.ts src/lib/teetime/course-resolve.test.ts src/components/CaddieOrbSheet.test.tsx \
  && npm run build
```

`parseTeeTimePrefs` is untouched, so `--smoke` is a pure regression gate (corpus + 200 generated). All Step-0 tests RED before the change, GREEN after; every pre-existing test stays green (notably `caddie-task.test.ts:267` ambiguous-empty and the whole A0/A2 tables).

## Edge-case decision table (summary)

| Situation | Outcome |
|---|---|
| Clarify-shaped utterance, no pending | Normal parse → no signal → converse fall-through (unchanged) |
| Pending + reply picks (ordinal/locality/name) | Add+select via A2 flow, dispatch iff armed/reply-armed, pending cleared |
| Pending + "yes"/"go ahead" only | Re-ask; NEVER dispatch (dispatch-only is not topic change) |
| Pending + new prefs or different course name | Topic change: normal turn (incl. A2 resolve), pending cleared |
| Pending + reply matches 0 or 2+ | One re-ask (attempts budget 2 asks total), then honest bail, pending cleared |
| Pending + low-confidence topic-change parse (gate b) | Confirm line, apply not called, pending survives one turn (harmless — next applied turn settles it) |
| Dispatch fires / phase leaves "prefs" | Prefs unmounts → ref dies, ctx unregisters, host closes sheet — no wedge |

## Risks for the reviewer

1. **Mic-reopen vs spoken ack (TTS)**: `LooperSheetShell` owns TTS and speaks the ask; the host reopens the mic ~900ms later, which can overlap playback when spoken replies are enabled (default off) — STT may hear the caddie's own question. Locality keyterm bias and the matcher's conservatism blunt it; the clean fix (thread `useSheetTTS`'s `onPlaybackEnd` up through the shell) is deliberately out of A3 scope — flag if unacceptable.
2. **Locality token false positives**: shared-state tokens ("ny") correctly go ambiguous, but a reply whose words coincide with a locality token could mis-pick; word-boundary matching + staged precedence keeps this narrow, and a mis-pick is visible/undoable (course row appears; dispatch only when armed).
3. **`confidence: 0.9` on none/ambiguous clarify turns** is a deliberate gate bypass so the re-ask happens in the task lane; a reviewer should confirm this can't launder a genuinely unrelated utterance past gate (b) — the `hasNonDispatchSignal` topic-change escape is the guard.
4. **`ResolvedCandidate.center` tightened to required** — safe by construction today, but any future candidate source must uphold it.

## Critical Files for Implementation
- `frontend/src/lib/teetime/caddie-task.ts`
- `frontend/src/lib/teetime/course-clarify.ts` (new) + `course-clarify.test.ts` (new)
- `frontend/src/app/tee-time/page.tsx`
- `frontend/src/components/CaddieOrbSheet.tsx` (+ `.test.tsx`)
- `frontend/src/lib/caddie-context.ts` (and `frontend/src/lib/teetime/course-resolve.ts` for the candidate enrichment)
