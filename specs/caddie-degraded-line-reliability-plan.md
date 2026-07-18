# Plan — Caddie strategy reliability + clean degraded fallback (pre-round fix cluster)

Owner-directed urgent cluster (live prod smoke of v1.1.13, 2026-07-17). NOTICEABLE.
Land on `integration/next`, PR #147 checklist item: "caddie: reliable strategy answers + clean fallback".
Do NOT ship/ping — owner handles the ship ask.

## Context (verified in-tree)
- The degraded line is a closure `_degraded_line()` inside `run_strategy_turn`
  (`backend/app/caddie/strategy_turn.py:95-112`). It is the fallback on any validator reject /
  synth error / timeout / missing key when a recommendation exists.
- It is broken 3 ways:
  1. **Prompt-leakage spoken aloud** — it reuses `format_tee_numbers_line(...)`
     (`voice_prompts.py:297`), whose string contains prompt scaffold:
     `"...(AUTHORITATIVE — they close: 466 − 276 = 190)..."` and
     `"...Speak ONLY these numbers for this tee shot."` — TTS'd verbatim.
  2. **"the none" bug** — `green_read.uphill_leave_side` is the literal STRING `"none"`
     (`green_geometry.py:179,202`) on a flat / falls-toward green; the current guard
     `if green_read.get("available") and gr_side:` treats `"none"` as truthy →
     `"Green: the uphill putt leaves from the none."`
  3. **Advice quality** — it interpolates `rec.aim_point.description`, whose default is
     `"Aim at the flag — green light, no trouble"` (`aim_point.py:132`). On a positioning
     (can't-reach) tee shot this both aims at an unreachable flag AND says "no trouble" even
     when drive-zone hazards exist. It bypasses the reach/hazard-evidence discipline.

## Fix A — rewrite the degraded line, composed PURELY from engine FIELDS

**Extract to a module-level pure function** so it is directly unit-testable and the existing
route tests stop reconstructing it by hand:

```python
def compose_degraded_line(rec: dict, green_read: dict, carries: dict) -> str:
```
(place it at module scope in `strategy_turn.py`; the closure inside `run_strategy_turn`
becomes `strategy_text = compose_degraded_line(rec, green_read, carries)`.)

**Zero reuse** of `format_tee_numbers_line` and zero reuse of any `*.description` prose
(`aim_point.description`, `miss_side.description/avoid`). Build every clause from structured
fields only. Import `CLUB_DISPLAY_NAMES` from `app.caddie.club_selection`.

Compose in this order; **omit** any clause whose source is empty/None/`"none"` (never a
placeholder, never "no trouble", never "at the flag/pin"):

1. **Club + numbers.**
   - `club_key = rec.get("club") or ""`; `club_display = CLUB_DISPLAY_NAMES.get(club_key, club_key) or "your club"`.
   - `tn = rec.get("tee_shot_numbers")` present (positioning/tee shot) → validate to
     `TeeShotNumbers` and compose from its fields:
     - lead: `f"{club_display} off the tee — {n.to_green_yards} to the green"`
       + `f", plays like {n.plays_like_yards}"` **only if** `n.plays_like_yards != n.to_green_yards`.
     - drive: if `n.drive_carry_yards is not None` → `f"; carries {n.drive_carry_yards}, totals {n.drive_total_yards}"`;
       else (competition-legal) → `f"; {n.club_stored_yards} stored"`.
     - leave: if `n.leave_exact_yards <= 0` → `", reaches the green"`; else `f", leaves about {n.leave_yards} in"`.
     - end the sentence with a period.
   - No `tn`, but `rec.get("shot_kind") == "positioning"` (can't-reach, no full tee block) →
     `f"{club_display} — position it, {rec.get('raw_yards')} to the green"`
     + `f", leaves about {rec['leave_yards']} in"` if `rec.get("leave_yards")`. **Never** "at the flag".
   - Else (reachable approach) → `f"{club_display}, {rec.get('raw_yards')} to the green"`
     + `f", plays like {rec.get('target_yards')}"` **only if** `target_yards` present and `!= raw_yards`.
     End with a period.
2. **Favor-side** from `rec.miss_side.preferred`:
   - `left`/`right` → `f" Favor the {pref}."`
   - `short` → `" Favor short."`; `long` → `" Favor long."`
   - `center` / falsy → **omit** (do NOT say "no trouble" / "no strong side").
3. **Hazard clause** from the drive-zone/frame carries (`carries.get("carries")`, each
   `{type, side, carry_yards}`):
   - build `hz = [c for c in carries_list if c.get("carry_yards")]`;
   - if non-empty → `" Watch " + ", ".join(f"{c['type']} {c['side']} at {c['carry_yards']}" for c in hz) + "."`
     (a compact side+carry list; the favor-side above already carries the "why").
   - empty / carries unavailable → **omit** (no "no trouble" ever).
4. **Green read** from `green_read`:
   - `gr = green_read.get("uphill_leave_side")`;
   - available and `gr in ("left","right")` → `f" Green: a miss {gr} leaves the uphill putt."`
   - available and `gr == "none"` and `green_read.get("uphill_leave_depth") in ("short","long")`
     → `f" Green: leave it {depth} for the uphill putt."`
   - else → **omit**. **Never** emit the substring "the none".

### Test battery (pin it) — `backend/tests/eval/test_strategy_tool.py`
Add a `class`/section of direct `compose_degraded_line(...)` tests. Use **real Red-6 and
Augusta-12 payload shapes** from the smoke as fixtures (positioning 3-wood + trees-right
carries; center-bunker 140-165). Assert on the composed strings:
- **Forbidden substrings never appear** (case-insensitive where apt), across every fixture:
  `"AUTHORITATIVE"`, `"Speak ONLY"`, `"they close"`, `"the none"`, `"no trouble"`,
  `"at the flag"`, `"at the pin"`.
- Red-6 (positioning, 3-wood, trees right, miss right): line names the club + numbers as
  numbers, favors right, mentions the trees-right carry(s), NO unreachable flag aim, NO "no trouble".
- Augusta-12 (center bunkers 140-165): the hazard clause names the bunkers with side+carry;
  no "no trouble".
- A **flat-green** fixture (`uphill_leave_side == "none"`, no depth): no green clause, no "the none".
- A **falls-toward** fixture (`uphill_leave_side == "none"`, `uphill_leave_depth == "short"`):
  green clause uses the depth phrasing, still no "the none".
- A clean **reachable-approach** fixture: sane "{club}, {raw} to the green…" with favor side.
- Include the verbatim expected Red-6 line as one exact-equality assertion (the report needs it).

### Update the existing route tests
`_expected_degraded_line` (~line 675) currently reconstructs the OLD closure. Replace its body
so it delegates to the new `compose_degraded_line(rec, green_read, carries)` from the same
payload — one source of truth, no drift. Tests 2/3/4 (validator-reject / synth-raises /
missing-key) then assert equality against the real composer. (`carries` = `payload["carries"]`.)

## Fix B — synth reliability

`backend/app/caddie/strategy.py`:
- Raise `_STRATEGY_TIMEOUT_S` **10.0 → 18.0** (primary lever; the voice has the thinking-bridge,
  a slow real answer beats a broken fallback). Update the adjacent comment.
- **Do NOT reduce `_STRATEGY_MAX_OUTPUT_TOKENS`.** It is a *cap*, not a latency target: on a
  reasoning model the model stops when done, so lowering the cap does NOT cut p50 latency — it
  only risks MORE `incomplete`-status degrades (reasoning tokens + visible output share the cap;
  low-effort reasoning can be several hundred tokens). Keep 1024. (Report this reasoning; it
  answers the owner's "try 512" suggestion with the engineering reason not to.)
- Leave `_strategy_reasoning_effort()` default `"low"` (already the fast setting; it stays
  env-tunable via `CADDIE_STRATEGY_REASONING_EFFORT`). The real latency lever is effort, not the
  token cap, but dropping below "low" risks answer quality on the caddie crux — not worth it
  tonight; 9.6s p50 under the bridge is acceptable, and the 18s timeout is what lifts completion.
- Keep the fail-closed validator EXACTLY as-is.

## Fix C — retry: SKIP (report why)
An 18s timeout + one retry = up to 36s worst case, which blows the ~20s worst-case-with-bridge
budget the owner set. A single 18s attempt captures the slow-but-real answers; a retry only helps
a rare transient blip while doubling worst-case wait. Do not add a retry.

## Client-budget alignment (owner-flagged; VERIFIED — must be fixed)
Two client paths call the synth:
1. **Realtime orb (primary)** — `get_strategy` (`realtime.ts:229`) → `getStrategy`
   (`caddie/api.ts:269`) → `post` → `fetchAPI` (`lib/api.ts:153`), which uses **native
   `fetch` with NO app-level timeout** (WKWebView default ~60s; web unbounded) → backend
   `/session/strategy` → `run_strategy_turn`. Budget ≥ 18s. **ALIGNED — no change.**
2. **Text mouth (secondary)** — `sessionVoice` (`caddie/api.ts:503`) →
   `postWithTimeout('/caddie/session/voice', …, { timeoutMs: SESSION_VOICE_TIMEOUT_MS })`
   with **`SESSION_VOICE_TIMEOUT_MS = 8_000`** (`caddie/api.ts:651`). The ADVICE branch of
   `/session/voice` runs `run_strategy_turn` INLINE (`caddie.py:1009`). 8s < 18s → the client
   aborts to the stateless `talkToCaddie` fallback before the good synth returns (already
   misaligned vs the current 10s; the 18s raise widens it). **FIX:** raise
   `SESSION_VOICE_TIMEOUT_MS` **8_000 → 20_000** (backend 18s synth + ~2s overhead) and update
   its comment to state the dependency: it MUST stay ≥ the backend strategy synth timeout because
   the ADVICE interception runs the synth inline. (This trades a little fail-fast snappiness on a
   rare slow FACT/OTHER turn for a correct session-aware answer — the same "slow real answer beats
   a broken fallback" principle the owner set for the backend. Flag to reviewer for a sanity check;
   the realtime orb, the primary path, is unaffected.)
   - The realtime relay `timeout=15.0` (`realtime_relay.py:211`) is only for minting the
     ephemeral session token, NOT tool dispatch — irrelevant to strategy. No change.

## Gates
- `cd backend && ruff check .`
- `cd backend && python -m pytest tests/eval/test_strategy_tool.py -q` (+ the strategy/routing
  suites); full backend suite runs in CI (~2814, no regressions). No local Postgres — DB-backed
  tests run in CI, do not spin a container.
- `cd frontend && npm run lint && npx tsc --noEmit` (frontend one-line const change).

## Do NOT
- No changes to `main`; no force-push. No edits to the validator's grounding logic. No new deps.
