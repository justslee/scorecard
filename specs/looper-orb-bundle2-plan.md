# Looper Orb — Bundle 2: Round-Page Identity Restyle

Status: PLAN (contract for builder). Owner-approved.
Scope: ONE item — restyle the round page's "Ask Caddie" pill medallion to the
Looper ink-orb + serif-italic "L" identity. Semantics unchanged (round-scoped
CaddieSheet). No general-chat page-powers work. No new design language.

---

## 1. Intent (verbatim direction)
Restyle the round page's "Ask Caddie" pill to the Looper identity — the SAME
ink-orb + serif-L visual language as the tab-island orb (`LooperOrb` in
`FloatingTabBar.tsx`) — with the SAME tap-summons semantics. The round page has
NO tab bar, so the pill's placement stays where it is (bottom pill row, next to
"Enter score").

## 2. Grounding (verified)
- Identity source of truth: `frontend/src/components/nav/FloatingTabBar.tsx`,
  `LooperOrb` (lines ~78-153). Ink circle: `background: T.ink`, `color: T.paper`,
  `border: 1px solid ${T.hairline}`, raised
  `boxShadow: '0 6px 18px rgba(26,42,26,0.28), 0 1px 0 rgba(255,255,255,0.25) inset'`,
  `fontFamily: T.serif`, `fontStyle: 'italic'`, glyph "L". 54x54 in the bar.
- Target pill: `frontend/src/app/round/[id]/RoundPageClient.tsx`, the
  "Ask Caddie — ghost pill" `motion.button` (lines ~1869-1916). Today it renders
  a 20x20 accent-bg medallion with `caddy.initial` (persona initial) + a
  serif-italic "Ask caddie" label. onClick: `voice.stop()` then
  `setCaddieOpen(true)`.
- `accent = DEFAULT_ACCENT` (line 194). `caddy`/`personaId` from
  `useCaddiePersona()` (line 199). `voice = useVoiceCaddie({...})` (line 660).
- Persona is ALSO surfaced in the CaddieSheet header identifier row
  (`CaddieSheet.tsx` lines ~684-702): a 22x22 accent medallion with
  `caddy.initial`, tap-to-switch-persona. So persona identity is NOT lost if the
  pill medallion changes.
- Theme tokens (ink/paper/hairline/accent/serif/sans/mono) already imported in
  RoundPageClient.

## 3. Design decisions (locked)

### 3.1 Visual form — LOCKED
Swap ONLY the medallion inside the existing ghost pill. Keep the pill shape,
size, placement, shadow, and label mechanics untouched.

Change the medallion `<span>` (lines ~1897-1914) from the accent persona-initial
treatment to the Looper ink-orb treatment:
- `background`: `accent` -> `T.ink`
- add `border: 1px solid ${T.hairline}`
- add the raised inset highlight so it reads as the same raised orb, scaled down.
  Use a lighter shadow than the 54px bar orb (a 20px chip should not carry the
  full drop shadow — keep it calm). Recommended:
  `boxShadow: '0 1px 4px rgba(26,42,26,0.20), 0 1px 0 rgba(255,255,255,0.25) inset'`.
  Rationale: the inset top-highlight is the signature that ties it to the bar
  orb; the outer shadow is trimmed because the pill itself already floats.
- glyph: replace `{caddy.initial}` with the literal `L`
- keep: `width:20, height:20, borderRadius:'50%'`, flex centering,
  `fontFamily: T.serif`, `fontStyle:'italic'`, `fontSize:10`, `color: T.paper`,
  `flexShrink:0`.

Result: a mini ink-orb "L" chip inside the paper ghost pill — unmistakably the
same Looper identity as the bar orb, at pill scale. No orb "breaks the edge"
here (that behavior is bar-specific and irrelevant with no tab bar).

Rejected alternative: a bigger orb-forward pill (e.g. leading raised circle
overhanging the pill). Rejected — over-reaches scope, risks a new visual pattern
on a page that already has a strong bottom-row rhythm, and fights the 320px
compression budget.

### 3.2 Semantics — UNCHANGED (locked)
Keep onClick exactly: `voice.stop(); setCaddieOpen(true);`. This opens the
ROUND-scoped CaddieSheet (persona-aware, hole context, Postgres session). Do NOT
wire `looper-bus` / `openLooper` here — there is no tab bar and the round page
deliberately owns its round-scoped caddie. Do NOT open the general LooperSheet.

### 3.3 Label — LOCKED to "Ask Looper" (with designer flag)
Bundle 1 named the assistant "Looper" (aria-label "Talk to Looper"). For identity
consistency, change the visible label from "Ask caddie" to "Ask Looper" so the
restyled ink-"L" chip and the word agree. Keep the same styling
(serif italic, ellipsis, nowrap).

DESIGNER JUDGMENT CALL — flag for NORTHSTAR review: on the round page the sheet
is the persona-named caddie (Classic/Strategist/etc.), so "caddie" is also
correct and arguably warmer in-round. If the designer prefers to preserve the
in-round "caddie" vocabulary, keep the label "Ask caddie" and ship the visual
restyle only. Builder: default to "Ask Looper"; revert the single string to
"Ask caddie" if the designer says so. This is a one-string toggle — call it out
in the PR description for explicit sign-off.

### 3.4 Long-press-to-listen — NOT added (locked, low-risk)
Keep the round pill TAP-ONLY. Do NOT add the bar orb's long-press->listening
gesture here. Justification:
- The bar orb's long-press opens Looper already-listening via `openLooper`;
  the round page has a different voice architecture (`useVoiceCaddie` warm/live
  realtime + hold-to-talk on its own affordance) and a strict one-mic rule.
- Adding a second hold-to-talk entry point risks racing the warm-path mic
  invariants in `lib/voice/realtime.ts` (mic withheld until `attachMic`; silent
  placeholder track) and would require pinning tests before touching them.
- Lowest-risk, matches current behavior, keeps the pill a pure presentational
  restyle. Voice on the round page stays owned by the existing voice affordance.

Do NOT touch `lib/voice/realtime.ts` warm-path invariants.

### 3.5 Persona initial — preserved elsewhere (locked)
Replacing `caddy.initial` with "L" on the pill is safe: the CaddieSheet header
(`CaddieSheet.tsx` ~684) still shows the accent persona-initial medallion and the
tap-to-switch persona picker. Persona identity is surfaced the moment the sheet
opens. No persona regression.

## 4. Exact change set

Primary file: `frontend/src/app/round/[id]/RoundPageClient.tsx`

1. Medallion `<span>` (lines ~1897-1914):
   - `background: accent` -> `background: T.ink`
   - add `border: `1px solid ${T.hairline}``
   - add `boxShadow: '0 1px 4px rgba(26,42,26,0.20), 0 1px 0 rgba(255,255,255,0.25) inset'`
   - `{caddy.initial}` -> `L`
   - keep all other style props as-is.
2. Label `<span>` (line ~1915): `Ask caddie` -> `Ask Looper` (per 3.3; designer
   may keep "Ask caddie").
3. Accessibility: add `aria-label="Ask Looper"` to the `motion.button`
   (lines ~1869) — the button currently has no explicit label; the medallion is
   now a decorative "L" so the accessible name should be set explicitly and match
   the visible label. Mark the medallion `<span>` `aria-hidden` is optional (it
   is text "L", harmless; prefer setting the button aria-label and leaving span
   as-is).

No change to: onClick, `whileTap`, pill container styles, flex/compression props,
the "Enter score" pill, `caddy`/`accent`/`voice` wiring, CaddieSheet props.

### Shared-constant option (optional, do NOT over-engineer)
If the builder wants to reduce drift between the bar orb and the pill chip, a
tiny shared style helper is acceptable — e.g. an exported
`looperOrbSurface(size: number)` returning the ink/paper/border/serif style
object, consumed by both `LooperOrb` and the round pill medallion. This is
OPTIONAL. Given the two orbs differ in size and shadow weight, inlining the
handful of props is equally acceptable and lower-churn. Do NOT do a broad refactor
of `FloatingTabBar.tsx`. Decision left to builder; prefer inline unless the
shared helper is trivially clean.

## 5. Types / cross-file sync
None. Pure presentational change. No prop shape, no `looper-bus`, no API, no
shared types. CaddieSheet contract untouched.

## 6. Edge cases
- 320px width: unchanged. Pill keeps `flexShrink:1, minWidth:0`; medallion keeps
  `flexShrink:0`; label keeps ellipsis+nowrap. "Ask Looper" is one char shorter
  than "Ask caddie" — no worse. Verify the pill still compresses before "Enter
  score" at 320px.
- One-mic rule: `voice.stop()` stays first in onClick — preserved. No new mic
  path introduced (per 3.4).
- Pressed/active: keep `whileTap={{ scale: 0.97 }}`. The mini orb inherits the
  pill's tap scale (it is a child) — no separate press state needed.
- Accessibility: explicit `aria-label` added (per 4.3); decorative "L" no longer
  implies persona. Contrast: T.paper "L" on T.ink is the same as the bar orb —
  already vetted.
- Motion: no new animation. Do not add entrance motion to the medallion.

## 7. Gates (run from `frontend/`)
Required, in order:
1. `cd frontend && npm run lint`
2. `cd frontend && npx tsc --noEmit`
3. `cd frontend && npm run build`
4. `cd frontend && npx tsx voice-tests/runner.ts --smoke`
   (must stay green — proves no accidental voice/mic regression even though we
   did not touch voice; guards the one-mic invariant.)
5. `cd frontend && npx vitest run src/components/nav/FloatingTabBar.test.tsx`
   (identity source unchanged — should stay green.)

User-facing change -> DESIGNER REVIEW against `NORTHSTAR.md` REQUIRED (calm,
voice-first, yardage-book; reuse tokens; no new design language). Sign off the
label decision (3.3) during this review.

No `/security-review` — no endpoint, auth, or dependency change.

## 8. Tests
- Existing `src/components/nav/FloatingTabBar.test.tsx` is the identity-orb test
  pattern (raised ink orb, serif "L", tap/long-press). It should remain green
  unchanged.
- A new test for the restyled round pill is OPTIONAL and low value: the change is
  presentational and the pill's behavior (`voice.stop` + `setCaddieOpen`) is
  unchanged. If the builder adds one, keep it light — assert the pill renders the
  "L" glyph and its onClick calls `voice.stop` then opens the sheet — mirroring
  the FloatingTabBar.test.tsx style. Not required to ship.

## 9. Out of scope (do not touch)
- General-chat page-powers (Home/Partners/Profile).
- `looper-bus` / `openLooper` wiring on the round page.
- `lib/voice/realtime.ts` warm-path invariants; `useVoiceCaddie`.
- CaddieSheet internals, persona picker, session logic.
- FloatingTabBar behavior/layout.

## Critical files for implementation
- frontend/src/app/round/[id]/RoundPageClient.tsx  (the pill block, ~1869-1916)
- frontend/src/components/nav/FloatingTabBar.tsx    (LooperOrb identity reference, ~78-153)
- frontend/src/components/CaddieSheet.tsx           (confirms persona still surfaced, header ~684)
- frontend/src/components/nav/FloatingTabBar.test.tsx (identity-test pattern reference)
- frontend/NORTHSTAR.md is at repo-root NORTHSTAR.md (design gate)
