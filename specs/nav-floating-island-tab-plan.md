# Floating Island Tab Bar — Implementation Plan

Frontend-only. Adds an Instagram-style floating "island" bottom tab bar to Looper,
mounted once in the root layout, shown only on hub routes, styled with the existing
yardage-book `T` tokens. No new design language, no new dependencies, no icon library.

## Goal & constraints
- A rounded pill that HOVERS above the bottom edge (horizontal margins + soft shadow +
  large radius), NOT an edge-to-edge SaaS bar.
- Respect `env(safe-area-inset-bottom)`.
- Calm, on-paper, restrained. Active = ink; inactive = pencil.
- Inline SVG icons (stroke currentColor, strokeWidth 1.5, viewBox 0 0 24 24), matching
  `src/app/players/page.tsx`. No lucide-react (codebase deliberately avoids it).
- Tokens from `@/components/yardage/tokens` (`T`). framer-motion already available.

## Tabs (all destinations verified to exist)
| Label     | href        | Icon (inline SVG)                 |
|-----------|-------------|-----------------------------------|
| Home      | `/`         | house                             |
| Partners  | `/players`  | two-person / users                |
| Tee times | `/tee-time` | calendar-clock                    |
| Profile   | `/profile`  | single user (reuse UserIcon path) |

## Files to CREATE
1. `frontend/src/components/nav/shouldShowTabBar.ts`
2. `frontend/src/components/nav/shouldShowTabBar.test.ts`
3. `frontend/src/components/nav/FloatingTabBar.tsx`

## Files to EDIT
4. `frontend/src/app/layout.tsx` — mount `<FloatingTabBar />` inside `<AuthProvider>`, after `{children}`.
5. (Verify only, likely no change) bottom padding on hub pages — see "No overlap".

---

### 1. `shouldShowTabBar.ts` (pure, unit-testable)

Allowlist of hub routes; everything else (incl. future immersive screens) defaults to hidden.

```ts
export const HUB_ROUTES = ['/', '/players', '/profile', '/tee-time'] as const;

export function shouldShowTabBar(pathname: string): boolean {
  if (!pathname) return false;
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;
  return (HUB_ROUTES as readonly string[]).includes(normalized);
}
```

Matching rules: exact equality after trailing-slash normalization. No prefix matching, so
nested routes never accidentally show the bar.

### 2. `shouldShowTabBar.test.ts` (vitest, node env)

Cover: true for the 4 hub routes and trailing-slash variants; false for `/round/new`,
`/round/abc123`, `/round/123/view`, `/tournament/x`, `/settings`, `/sign-in`, `/sign-up`,
`''`, `/unknown`, `/playerss`.

### 3. `FloatingTabBar.tsx` (client component)

- `'use client'`; `const pathname = usePathname();`
- `if (!shouldShowTabBar(pathname)) return null;`
- Fixed, centered floating pill with 4 `next/link` items.
- Active via trailing-slash-normalized equality with each tab href (leaf routes only).
- Inline SVG icons (22px, strokeWidth 1.5), `aria-current="page"` on active link.

Container: `position:fixed; left:0; right:0; bottom: calc(12px + env(safe-area-inset-bottom));
z-index:40; display:flex; justifyContent:center; pointerEvents:none; padding:0 16px`.
Inner pill: `pointerEvents:auto; width:100%; maxWidth:420; background:T.paper;
border:1px solid T.hairline; borderRadius:999; boxShadow:'0 6px 24px rgba(26,42,26,0.12),
0 1px 0 rgba(255,255,255,0.4) inset'; padding:6px; gap:2px; fontFamily:T.sans`.
Each tab: `flex:1; column; alignItems:center; gap:3px; minHeight:52; borderRadius:999;
color: active?T.ink:T.pencil; background: active?T.paperDeep:'transparent';
fontSize:10.5; transition:color/background 120ms`.

Optional one-time entrance: `motion.nav initial={{y:12,opacity:0}} animate={{y:0,opacity:1}}
transition={T.springSoft}`. Use `<nav aria-label="Primary">`.

### 4. Mount in `layout.tsx`

Server layout can host the client leaf:
```tsx
import FloatingTabBar from "@/components/nav/FloatingTabBar";
...
<AuthProvider>
  {children}
  <FloatingTabBar />
</AuthProvider>
```

### 5. No overlap (verify hub pages)

Bar is ~52px + 12px offset + safe-area. Verify hub pages clear it:
- `/` (`page.tsx`): wrapper has only `env(safe-area-inset-bottom,16px)` — add ~`calc(84px + env(safe-area-inset-bottom))`.
- `/players`: already `max(80px, calc(80px + env(safe-area-inset-bottom)))` — sufficient.
- `/profile`: add ~`calc(84px + env(safe-area-inset-bottom))` to content wrapper.
- `/tee-time`: verify last card clears; add bottom padding if clipped.
Do NOT pad immersive routes — bar is hidden there.

## Edge cases
- Active state nested routes: N/A (leaf paths, exact match).
- Safe area: bottom offset `calc(12px + env(safe-area-inset-bottom))`; `viewportFit:"cover"` already set.
- Overlap: wrapper `pointerEvents:none`, pill `pointerEvents:auto` so taps pass through margins.
- Z-index: bar at 40, below players modal (50) and sheets.
- Accessibility: `<nav aria-label="Primary">`, `aria-current="page"`, `aria-hidden` on SVGs, `aria-label` per link, 52px targets.
- Theme: pill uses opaque `T.paper` to read over `PAPER_NOISE` backgrounds.

## Gates (run from `frontend/`)
```
cd frontend
npm run lint
npx tsc --noEmit
npx tsx voice-tests/runner.ts --smoke      # expect 265/265
npx vitest run                             # includes new shouldShowTabBar.test.ts
npm run build
```
