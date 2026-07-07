# Restyle /map/course ErrorScreen → yardage-book not-found pattern

Owner/designer (backlog p6, from designer review of ff2b043): the map viewer's
`ErrorScreen` is generic/off-brand — Lucide `AlertCircle`, `T.sans` body, plain
text link — while the on-brand detail-page not-found state (serif-italic headline,
mono uppercase caption, hairline pill button on paper-noise) sits one route away.
The unified detail landing now funnels more traffic through `/map/course`, so a
golfer on patchy course wifi lands on this exact screen. Bring it on-brand.

## Scope (frontend-only, CSS/JSX; no logic change)
File: `frontend/src/app/map/course/page.tsx` — the `ErrorScreen({ message, onBack })`
component (~159-210). Do NOT change `Spinner`, data-fetch, GPS, or map logic — only
the error component's markup/styling. The `message` prop and `onBack` callback stay.

## Target pattern — mirror the detail-page not-found EXACTLY
Reference: `frontend/src/app/courses/[id]/CourseDetailClient.tsx` ~195-254. Copy its
visual vocabulary (do not import its JSX; re-implement in place):
- **Container**: full-screen (keep the existing `position: fixed; inset: 0`),
  `background: ${PAPER_NOISE}, ${T.paper}` with `backgroundBlendMode: "multiply"`,
  centered column, `textAlign: center`, generous padding (`40px 22px`).
  `PAPER_NOISE` is already used by that detail page — import the same token/const it
  uses (grep it; if it lives in a shared module reuse it, otherwise fall back to plain
  `T.paper` — do NOT invent a new noise asset).
- **Headline** (was the AlertCircle+message): the dynamic `message` rendered as
  `T.serif`, `fontStyle: italic`, `fontSize: 22`, `letterSpacing: -0.3`,
  `color: T.pencil`, `lineHeight: 1.3`. Remove the `AlertCircle` import+icon.
- **Caption** (new, static): `T.mono`, `fontSize: 9`, `letterSpacing: 1.3`,
  `color: T.pencilSoft`, `textTransform: uppercase`, `marginTop: 8`. Copy: something
  calm + honest for a map failure, e.g. `Check your connection and try again.`
- **Button** (was plain text link → pill): `onClick={onBack}`, `marginTop: 24`,
  `padding: "11px 24px"`, `borderRadius: 99`, `border: 1px solid ${T.hairline}`,
  `background: transparent`, `color: T.ink`, `T.mono`, `fontSize: 10`,
  `letterSpacing: 1.3`, `textTransform: uppercase`, `minHeight: 44`, `cursor: pointer`.
  Keep whatever the current back label conveys (e.g. `Back`), mono-uppercased.

## Guardrails
- Keep it a pure presentational change; the three `<ErrorScreen .../>` call sites
  (~694, ~729, ~736) pass `message` + `onBack` — signature MUST stay the same.
- If `AlertCircle` was the only use of `lucide-react` in the file, drop the now-unused
  import (lint will flag it otherwise). If other icons are still used, leave the import.
- Verify `T.hairline` and `T.pencilSoft` exist in tokens (they do — used by the detail
  page). Reuse `PAPER_NOISE` the same way the detail page does; no new deps/assets.

## Gates
`cd frontend`: `npx tsc --noEmit`, `npm run lint`, `npm run build`,
`npx tsx voice-tests/runner.ts --smoke` (unaffected but part of the gate).
User-facing → designer review vs NORTHSTAR after gates. No backend, no security-review
(pure styling, no new endpoint/auth/dep/capability).

## Files
- EDIT: `frontend/src/app/map/course/page.tsx` (ErrorScreen only; drop AlertCircle if unused).
