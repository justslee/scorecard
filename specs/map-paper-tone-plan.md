# Plan: `map-base-paper-tone-style` — Retone the Scout Map Base to Paper/Ink

**Northstar check:** NORTHSTAR.md "yardage-book aesthetic — on-paper, restrained palette… hand-made and calm, not trendy/flashy." This change makes the crux map surface read as paper/ink instead of stock Google. NOTICEABLE, designer-BLOCKING.

## 0. Context & current state (verified in-repo)

- `frontend/src/lib/course/scout-map-config.ts` L97–105: `SCOUT_MAP_STYLES` is exactly 3 POI-suppression rules (poi `labels` off, `poi.business` off, `transit` off). Pure data module — only import is `BBox` from `@/lib/golf-api`; `google.maps.MapTypeStyle` resolves ambiently. This convention must be preserved.
- `frontend/src/components/CourseScoutMap.tsx` L242–257: `GoogleMap.create` config uses `mapTypeId: MapType.Normal`, `styles: SCOUT_MAP_STYLES` (L252). All native calls are onMapReady-gated (L239–276). L310–313: `enableCurrentLocation(true)` — the standard blue my-location dot.
- `frontend/src/components/GoogleSatelliteMap.tsx` L528–546: `GoogleMap.create` with `mapTypeId: MapType.Satellite`, **no `styles` key** (L533–541).
- `frontend/src/lib/course/scout-map-config.test.ts` L63–88: invariant describe block iterates **all** of `SCOUT_MAP_STYLES` asserting (i) featureType ∈ {poi, poi.business, transit}, (ii) every styler is exactly `{visibility:"off"}`, (iii) no road/water/administrative/all. **These three tests will fail against a composed array as written — they must be re-scoped, not deleted** (see §4).
- Plugin mechanics (verified): `@capacitor/google-maps/ios/.../Map.swift` L154–159 applies `config.styles` via `GMSMapStyle(jsonString:)` inside create, and on parse failure **silently logs** "Invalid Google Maps styles" and ships the stock look. Two consequences: (a) same shipped mechanism, no mapId needed; (b) an `rgba(...)` string (like `T.hairline` verbatim) would silently kill the whole retone — guarded by a test in §4.
- Palette source: `frontend/src/components/yardage/tokens.ts` (`T.*`). scout-map-config.ts must NOT import tokens.ts (would break the pure/Node-testable convention) — hex values are inlined with comments naming the token they derive from, same as the file's existing style.

## 1. The style JSON — `SCOUT_MAP_BASE_TONE`

Add to `scout-map-config.ts` (below `boundsToBBox`, above the suppression rules). Every color is an opaque 6-digit hex (GMSMapStyle requirement). Ordering matters within the array (later rules win per-property; parent featureTypes match children), so general rules precede specific ones.

```ts
/**
 * Base-map paper/ink retone for the B2 scout map (MapType.Normal) — maps the
 * yardage-book T.* palette (components/yardage/tokens.ts) onto Google's
 * landscape/road/water/label layers so the map reads as printed paper, not
 * stock Google. Values are inlined hex (GMSMapStyle can't parse rgba/oklch);
 * each rule's comment names the token it derives from. Order matters:
 * general featureTypes precede specific ones (later/specific rules win).
 * See specs/map-paper-tone-plan.md.
 */
export const SCOUT_MAP_BASE_TONE: google.maps.MapTypeStyle[] = [
  // ── Landscape → paper ─────────────────────────────────────────────
  // T.paper
  { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#f4f1ea" }] },
  // T.paperDeep — natural terrain a shade deeper, keeps subtle texture
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#ece7db" }] },
  // paper↔paperDeep blend — urban blocks/building ground
  { featureType: "landscape.man_made", elementType: "geometry", stylers: [{ color: "#f0ece2" }] },

  // ── POI ground → paper; park/golf greenery → on-paper sage ────────
  // T.paperDeep — institutional footprints (schools/hospitals) melt into paper
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#ece7db" }] },
  // T.paper shifted toward T.inkSoft's green hue at paper luminance —
  // parks/fairways stay VISIBLY green (a golf map needs them) but calm
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#dde3d0" }] },

  // ── Water → muted blue-gray, NOT stock Google blue ────────────────
  // T.accent's blue family desaturated ~85% and lifted to paper luminance
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#c9d4d6" }] },
  // T.pencil on T.paper — water names in pencil, paper halo
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#6b6558" }] },
  { featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#f4f1ea" }] },

  // ── Roads → pale fills + pencil strokes; hierarchy = darkness ladder
  //    (highway darkest → local lightest; never one flat weight) ──────
  // mid(T.paperDeep, T.paperEdge) — highways most present
  { featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#e2dcce" }] },
  // T.paperEdge pulled 1/3 toward T.pencilSoft — a drawn edge, not neon
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#c2bbaa" }] },
  // mid(T.paper, T.paperDeep)
  { featureType: "road.arterial", elementType: "geometry.fill", stylers: [{ color: "#f0ece2" }] },
  // T.paperEdge
  { featureType: "road.arterial", elementType: "geometry.stroke", stylers: [{ color: "#d9d2c0" }] },
  // T.paper lifted slightly toward white — locals quietest, just above paper
  { featureType: "road.local", elementType: "geometry.fill", stylers: [{ color: "#f8f7f2" }] },
  // T.hairline flattened onto T.paper (12% ink over #f4f1ea)
  { featureType: "road.local", elementType: "geometry.stroke", stylers: [{ color: "#dad9d1" }] },

  // ── Road labels → pencil on paper; colorful route shields off ─────
  // T.pencil
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#6b6558" }] },
  // T.paper halo keeps text legible over any fill
  { featureType: "road", elementType: "labels.text.stroke", stylers: [{ color: "#f4f1ea" }] },
  // T.inkSoft — highway names read a step stronger (hierarchy in labels too)
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#3a4a38" }] },
  // Route shields (US-101 reds/blues) can't be recolored, only hidden —
  // the one loud element paper can't absorb. Icons only; road text stays.
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },

  // ── Administrative → ink/pencil ───────────────────────────────────
  // T.paperEdge — boundaries as faint drawn lines
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#d9d2c0" }] },
  // T.inkSoft on T.paper
  { featureType: "administrative", elementType: "labels.text.fill", stylers: [{ color: "#3a4a38" }] },
  { featureType: "administrative", elementType: "labels.text.stroke", stylers: [{ color: "#f4f1ea" }] },
  // T.ink — city names are the strongest text on the page
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#1a2a1a" }] },
  // T.pencilSoft — neighborhood names recede
  { featureType: "administrative.neighborhood", elementType: "labels.text.fill", stylers: [{ color: "#958d7d" }] },
];
```

Token derivation table:

| Rule | Token derivation |
|---|---|
| landscape geometry | `T.paper` exact |
| landscape.natural | `T.paperDeep` exact |
| landscape.man_made / road.arterial fill | mid(`T.paper`, `T.paperDeep`) = `#f0ece2` |
| poi geometry | `T.paperDeep` exact |
| poi.park | `T.paper` hue-shifted toward `T.inkSoft` green, paper luminance (hand-tuned sage) |
| water geometry | `T.accent` hue, ~85% desaturated, paper-deep luminance |
| road.highway fill / stroke | mid(`T.paperDeep`,`T.paperEdge`) / `T.paperEdge`→⅓`T.pencilSoft` |
| road.arterial stroke / admin stroke | `T.paperEdge` exact |
| road.local fill / stroke | `T.paper` +lift / `T.hairline` flattened on paper (`#dad9d1` = 12% ink over `#f4f1ea`) |
| road text / water text | `T.pencil` exact; halo `T.paper` exact |
| highway text / admin text | `T.inkSoft` exact |
| locality text | `T.ink` exact |
| neighborhood text | `T.pencilSoft` exact |

Deliberately restrained: no `gamma`/`lightness`/`saturation` stylers (pure hex is deterministic across renderers), no dark fills, no `invert_lightness`, nothing hidden except route-shield icons.

## 2. Composition with shipped POI-suppression

Shape: **two named sub-arrays + one composed export**, keeping `SCOUT_MAP_STYLES` as the single import CourseScoutMap already uses (zero diff there).

1. Rename the existing 3-entry array to `export const SCOUT_POI_SUPPRESSION: google.maps.MapTypeStyle[]` (keep its doc comment and entries **byte-identical** — semantics locked).
2. Add `SCOUT_MAP_BASE_TONE` (§1).
3. Compose:

```ts
/**
 * The full B2 scout-map style: paper/ink base tone + the shipped POI/transit
 * suppression. Base tone first, suppression last — suppression's
 * visibility:"off" wins regardless, but keep the quieting rules terminal for
 * readability. CourseScoutMap imports this name unchanged.
 */
export const SCOUT_MAP_STYLES: google.maps.MapTypeStyle[] = [
  ...SCOUT_MAP_BASE_TONE,
  ...SCOUT_POI_SUPPRESSION,
];
```

No conflict is possible: base tone only sets `color` on its features; suppression only sets `visibility:"off"` on poi labels / poi.business / transit — different properties. `poi.park` geometry stays visible because suppression's poi rule is `elementType: "labels"` only.

## 3. Both-maps application — and the satellite honesty call

- **CourseScoutMap** (`MapType.Normal`): gets the retone for free via the unchanged `styles: SCOUT_MAP_STYLES` at L252. **No edit to CourseScoutMap.tsx.**
- **GoogleSatelliteMap** (`MapType.Satellite`): **do not touch it.**
  - JSON styling cannot repaint photographic imagery — landscape/water/park fills are no-ops on satellite pixels by definition.
  - `MapType.Satellite` maps to iOS `kGMSTypeSatellite`, which renders **imagery only — no road vectors and no base-map labels at all** (labels-over-imagery is *Hybrid*). There is nothing for even a label-quieting subset to act on.
  - Therefore a `SATELLITE_LABEL_STYLES` export is **not warranted** — it would be dead config implying a capability that doesn't exist. The hole view stays photographic and visually unchanged. If that surface ever moves to `MapType.Hybrid`, revisit with a label-only subset then.

## 4. Invariant test — exact changes to `scout-map-config.test.ts`

Update the import to `{ deriveHighlightAction, highlightMarkerFor, boundsToBBox, SCOUT_MAP_STYLES, SCOUT_MAP_BASE_TONE, SCOUT_POI_SUPPRESSION }`.

**(1) Re-scope the existing strict block** (L63–88): rename describe to `"SCOUT_POI_SUPPRESSION invariants"` and iterate `SCOUT_POI_SUPPRESSION` instead of `SCOUT_MAP_STYLES` in all three tests (their assertions stay identical — they lock the suppression semantics exactly as shipped).

**(2) Add the composed-array block** (paste-ready):

```ts
describe("SCOUT_MAP_STYLES (composed) invariants", () => {
  it("is exactly base tone + POI suppression, in that order", () => {
    expect(SCOUT_MAP_STYLES).toEqual([...SCOUT_MAP_BASE_TONE, ...SCOUT_POI_SUPPRESSION]);
  });

  it("still turns poi labels off (labels only — park geometry survives)", () => {
    expect(SCOUT_MAP_STYLES).toContainEqual({
      featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }],
    });
  });

  it("still turns poi.business off", () => {
    expect(SCOUT_MAP_STYLES).toContainEqual({
      featureType: "poi.business", stylers: [{ visibility: "off" }],
    });
  });

  it("still turns transit off", () => {
    expect(SCOUT_MAP_STYLES).toContainEqual({
      featureType: "transit", stylers: [{ visibility: "off" }],
    });
  });

  it("never hides road/water/landscape/park GEOMETRY — retone, don't hide", () => {
    const guarded = /^(road|water|landscape|poi\.park)/;
    for (const rule of SCOUT_MAP_STYLES) {
      if (!guarded.test(rule.featureType ?? "")) continue;
      const hidesIt = (rule.stylers ?? []).some(
        (s) => (s as { visibility?: string }).visibility === "off",
      );
      if (hidesIt) {
        // Sole allowed exception: colorful route-shield icons.
        expect(rule.elementType).toBe("labels.icon");
      }
    }
  });
});

describe("SCOUT_MAP_BASE_TONE invariants", () => {
  it("every rule names an explicit featureType AND elementType (no bare-all rules)", () => {
    for (const rule of SCOUT_MAP_BASE_TONE) {
      expect(rule.featureType).toBeDefined();
      expect(rule.elementType).toBeDefined();
    }
  });

  it("every color styler is an opaque 6-digit hex — GMSMapStyle silently rejects rgba/oklch, which would ship the stock map", () => {
    for (const rule of SCOUT_MAP_BASE_TONE) {
      for (const styler of rule.stylers ?? []) {
        const color = (styler as { color?: string }).color;
        if (color !== undefined) expect(color).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("road hierarchy is a real ladder: highway fill darker than arterial darker than local", () => {
    const fillOf = (ft: string) =>
      SCOUT_MAP_BASE_TONE.find(
        (r) => r.featureType === ft && r.elementType === "geometry.fill",
      )?.stylers?.map((s) => (s as { color?: string }).color)[0] as string;
    const lum = (hex: string) =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(lum(fillOf("road.highway"))).toBeLessThan(lum(fillOf("road.arterial")));
    expect(lum(fillOf("road.arterial"))).toBeLessThan(lum(fillOf("road.local")));
  });
});
```

The hex test is load-bearing: a GMSMapStyle parse failure is swallowed with only a CAPLog line — the *only* CI-visible guard against pasting `T.hairline`'s rgba is this assertion. The ladder test locks the "don't flatten road hierarchy" requirement as data.

## 5. Native-map discipline

- Styles ride the existing `GoogleMap.create` config path — natively supported on `MapType.Normal` via `GMSMapStyle(jsonString:)`, **no mapId, no cloud styling, no new plugin calls**. Identical mechanism to the shipped `SCOUT_MAP_STYLES`; the readiness gate (L239–276) is untouched because create-config styling happens inside create itself.
- No new assets, no new Places/GolfAPI/network calls, no behavior change — pure data-array diff. The pure/DOM-free convention holds (plain arrays, one `BBox` type import, no tokens.ts import).
- **Files touched (complete list):** `frontend/src/lib/course/scout-map-config.ts`, `frontend/src/lib/course/scout-map-config.test.ts`. **Explicitly untouched:** `CourseScoutMap.tsx` (import name unchanged), `GoogleSatelliteMap.tsx` (§3), tokens.ts, everything native.

## 6. Gates + verification

Sandbox-verifiable (run all, in order):
```
cd frontend && npm run lint && npx tsc --noEmit && npx vitest run && npm run build && npx tsx voice-tests/runner.ts --smoke
cd backend && ruff check .   # no backend diff — gate still runs per workflow
```

iOS-sim screenshot check (evidence, per CLAUDE.md "show evidence, don't assert"): build to the simulator, open the B2 scout map over a known area (Marine Park, Brooklyn — water + parkland + highway/arterial/local mix in one viewport), `xcrun simctl io booted screenshot`, and **read the image** against this checklist:
1. Base reads paper (#f4f1ea family), not Google gray-white; water is muted blue-gray, not stock blue.
2. Road hierarchy legible: three distinct weights; no route shields.
3. Labels quiet but readable: city names ink, streets pencil with paper halo.
4. Golf-course/park green geometry still visible (sage, not hidden) — the invariant, visually.
5. Shipped course-flag markers and the blue location dot still pop against the new base (saturated-blue GMS dot vs muted `#c9d4d6` water: confirm the dot remains unmistakable over water).
6. Satellite hole view: unchanged (expected — confirm no regression, not a paper look).

**Needs owner real-device confirmation** (same as the markers were): actual GMS palette rendering on device, sunlight legibility of pencil-on-paper labels, and the location-dot-over-water read. §1–§4 logic is locked by unit gates; the *look* is the owner call. Designer-blocking, NOTICEABLE — route the screenshot through the designer before the bundle is marked noticeable.

## 7. Risks / edge cases

- **Silent style rejection (highest severity):** malformed JSON → plugin logs and ships stock look with green tests. Mitigation: hex-format test (§4) + mandatory screenshot (a stock-blue ocean = instant catch).
- **Over-quiet labels:** pencil `#6b6558` on `#f4f1ea` ~4.2:1 — acceptable; fallback knob is bumping road text to `T.inkSoft` and neighborhood to `T.pencil`.
- **Water vs location dot:** muted water lowers dot/water contrast vs stock. GMS's dot is saturated `#4285F4` with a white ring — should hold; item 5 verifies. If it fails, deepen water toward `#bcc9cc`, never recolor the dot.
- **Road hierarchy collapse at low zoom:** stroke ladder is the guard; if mush at zoom ~10, darken `road.highway` fill one step toward `T.paperEdge` (`#d9d2c0`).
- **Park sage vs landscape paper:** `#dde3d0` vs `#f4f1ea` is a deliberate whisper; if fairways don't read on device, pull toward `#d3ddc4` — but do NOT go saturated green.
- **Accidental hiding:** locked by test §4 — only `visibility:"off"` in the base tone is road `labels.icon`.
- **Satellite overclaim:** pre-empted in §3.
- **NORTHSTAR honesty clause:** Google's Normal renderer anti-aliases/blends fills, so "paper" can drift toward "beige Google" (muddy). If the device screenshot reads *muddy generic beige* instead of *paper*, report to the owner with the screenshot rather than shipping — the honest ceiling of JSON styling may be "calm and on-palette" rather than fully "hand-made"; the owner judges whether that clears the bar or whether this needs cloud map styling (mapId) as a follow-up.

## Implementation order
1. `scout-map-config.ts`: rename suppression → `SCOUT_POI_SUPPRESSION` (byte-identical entries), add `SCOUT_MAP_BASE_TONE` (§1), add composed `SCOUT_MAP_STYLES` (§2).
2. `scout-map-config.test.ts`: re-scope existing invariants to `SCOUT_POI_SUPPRESSION`, add the two new describe blocks (§4).
3. Run sandbox gates (§6).
4. Sim screenshot pass → designer review → owner device confirmation for the palette.
