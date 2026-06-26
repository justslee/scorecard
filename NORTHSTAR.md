# Looper — Northstar & Design Foundation

Every change the team makes MUST serve this. When in doubt, choose what protects the
**feel** described here over what adds a feature or follows generic app conventions.
This file is loaded into every agent's context via `CLAUDE.md` — it is the standing brief.

> ⚠️ Owner: this is drafted from the README + the redesign. Edit it so it states *your*
> Northstar exactly — the team follows whatever this says.

## Northstar (the product)
Looper is a **quiet, voice-first golf companion** — scorecard, caddie, tee times — that
feels like a **printed yardage book**, not a SaaS app. A golfer should set up a round,
keep score, and get caddie help **by talking**, while the app stays calm and out of the
way. Success = a round feels **effortless and personal**.

*(README: "A quiet, voice-first golf companion. Scorecard, caddy, tee times — styled like
a printed yardage book rather than a SaaS app.")*

## Design foundation (the non-negotiable feel)
- **Yardage-book aesthetic** — on-paper, restrained palette, serif display type
  (Instrument Serif), generous whitespace. Hand-made and calm, **not** trendy / flashy /
  dashboard-y.
- **Voice-first** — talking is the primary interface; tapping is the fallback. Design the
  voice path first.
- **Mobile-first** — one-handed use, on the course, in sunlight.
- **Quiet** — minimal chrome, no SaaS clutter, no notification noise. Calm > busy.
- **Reuse the system** — build on the existing components in
  `frontend/src/components/yardage/` and the established Tailwind patterns. Do **not**
  introduce new design languages or component libraries.

## What this means for the team
- Match the existing look, feel, and component patterns; never drift into generic
  SaaS/dashboard UI.
- Prefer the voice-first path; keep interactions calm and minimal.
- If a change would compromise the yardage-book feel for the sake of a feature, **flag it
  for the owner** instead of shipping it.
- The `designer` agent reviews every user-facing change against this document before it
  ships.
