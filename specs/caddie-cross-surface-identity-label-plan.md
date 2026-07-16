# Implementation Plan — `caddie-cross-surface-identity-label`

Fix: `LooperSheetShell` hardcodes "Looper" at all 4 identity sites; captions must attribute the speaking persona per the designer's decision. Pure frontend, label-only. RED-first.

## 1. Shell prop (presentational only) — `frontend/src/components/LooperSheet.tsx`

Add to the props interface (~L83, next to `personaId?: string`):

```ts
speakerLabel?: string;
```

Default in the destructure (~L47–58): `speakerLabel = "Looper"`. No persona logic in the shell.

Site changes:
- **Kicker ~L183: NO CHANGE.** Stays literal `Looper` (wordmark invariant).
- **Reply caption ~L300:** `{t.role === "user" ? "You" : speakerLabel}`
- **Streaming caption ~L328:** `Looper` → `{speakerLabel}`
- **Thinking pulse ~L370:** `Looper is thinking…` → `` {`${speakerLabel} is thinking…`} ``

Author Title Case; the existing `text-transform: uppercase` styles at all three sites do the caps. Do not bake "LOOPER".

## 2. Shared short-name helper — `frontend/src/lib/caddie/persona.ts`

Export one derivation; refactor `personaToCaddy` (:69) to use it:

```ts
export function shortPersonaName(name: string): string {
  return name.replace(/^The\s+/i, '').trim();
}
```

In `personaToCaddy`, replace the inline `const short = p.name.replace(...)` with `const short = shortPersonaName(p.name);`. No other persona.ts changes — `useCaddiePersona` stays the single source of truth.

## 3. Label computation — `frontend/src/components/CaddieOrbSheet.tsx`

Place a const right after the existing `activeTask` / `activeConverse` derivation (~L370–377), before the `return`:

```ts
const CAPTION_MAX = 16;
const shortName = shortPersonaName(caddy.name);
const speakerLabel =
  activeTask != null || personaId === "classic"
    ? "Looper"
    : shortName.length > CAPTION_MAX
    ? `${shortName.slice(0, CAPTION_MAX)}…`
    : shortName;
```

Pass `speakerLabel={speakerLabel}` on `<LooperSheetShell …/>` (~L380). Notes:
- Lane: `activeTask != null` → TASK → "Looper" (any persona). Otherwise (converse or general) → persona short name.
- Classic → "Looper" (not "Classic Caddie"). Logged-out/unresolved falls out free: `useCaddiePersona` seeds `personaId='classic'` synchronously.
- Truncation only bites customs (all built-in short names ≤ 10 chars); `slice` on short names is a no-op, no throw. Picker/empty-hint keep full `caddy.name` — untouched.
- Derived every render from `caddy` → persona switch reflows live via the existing pub-sub; thinking pulse and caption read the same `speakerLabel` for a turn, so no "Looper is thinking…" → "Hype Man" flicker.
- Import `shortPersonaName` alongside the existing `useCaddiePersona` import from `@/lib/caddie/persona`.
- Do NOT touch the round-page `CaddieSheet` (separate surface, already coherent).

## 4. Tests (write RED first, then implement)

**`frontend/src/components/LooperSheet.test.tsx`** (extend existing file; reuse its `baseProps` + framer-motion/TTS mocks). New `describe("LooperSheetShell — speakerLabel prop")`:
1. `speakerLabel="Hype Man"` + a looper reply turn → reply caption renders "Hype Man" (RED today).
2. Same prop + `streamingTurn="…"` → streaming caption "Hype Man" (RED).
3. Same prop + `phase="thinking"` → "Hype Man is thinking…" (RED).
4. Omitted `speakerLabel` → all three sites render "Looper" (back-compat; GREEN before and after).
5. `speakerLabel="Hype Man"` → kicker still shows "Looper" (wordmark invariant guard).
6. User turn caption stays "You" regardless of `speakerLabel`.

**`frontend/src/components/CaddieOrbSheet.test.tsx`** (extend; already in the caddie-experience gate, dims 3, 8). Harness note: it mocks `@/lib/caddie/api` (`fetchPersonalities → []`, `getCaddieProfile → { preferred_personality_id: null }`) and stubs `localStorage` via `makeLocalStorage()`. To select a persona synchronously, seed `localStorage.setItem('looper.caddiePersonaId', 'hype')` before render (the hook's `useState` initializer reads it; `BUILTIN_PERSONAS` resolves the name with no fetch) — or resolve `getCaddieProfileMock` with `preferred_personality_id: 'hype'`. Cases:
1. General/converse lane (no bound task) + persona `hype` → looper reply caption shows "Hype Man" (RED today).
2. Task lane (registered + bound task ctx, reuse the file's existing task-context fixture) + persona `hype` → caption "Looper".
3. Persona `classic` (default) → "Looper".
4. No seeding at all (unresolved/logged-out path) → "Looper".

Gate: `cd frontend && npm run test:caddie-experience` must stay green (existing `personaId` back-compat tests unaffected — new prop defaults to "Looper").

## 5. Risks / non-goals

- Label-only: no VAD/mic/dedup/one-mic/TTS behavior change (`personaId` prop for voice untouched).
- No shared-type changes (`types.ts` ↔ `models.py` untouched; no backend edits — ruff is a no-op).
- Verify with: lint, `tsc`, build, voice-tests smoke, ruff, `npm run test:caddie-experience`.

## Designer's lane→label semantics (authoritative)

| Site | Task lane | Converse/general + classic | Converse/general + non-classic | Logged-out/unresolved |
|------|-----------|---------------------------|-------------------------------|----------------------|
| Kicker (:183) | Looper | Looper | Looper | Looper |
| Reply caption (:300) | Looper | Looper | short persona name | Looper |
| Streaming (:328) | Looper | Looper | short persona name | Looper |
| Thinking (:370) | Looper | Looper | short persona name | Looper |

Rationale: the kicker is the app wordmark (product identity, invariant); the captions/pulse are speaker attribution (who's talking now). Task lanes are the app doing a job on the user's behalf, honestly "Looper", not the caddie persona conversing. Classic maps to "Looper" (the app's own caddie name) matching today's empty-hint treatment. Custom names truncated to 16ch + ellipsis on the tiny mono captions only.
