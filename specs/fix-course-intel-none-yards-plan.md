# Fix: course-intel `NoneType + int` crash on null yardage

Classification: NOTICEABLE (restores the dead Elev / "plays like" tile — currently +0ft/error on every hole — on the owner's real round).

## Root cause (verified against code)
- `backend/app/caddie/course_intel.py:55` — `effective_yards = yards + round(elevation_change / 3)`. `elevation_change` is a float (init `0.0` at line 47, populated at 48-52 *before* this line, independent of yards), so the `None` operand is `yards`.
- `backend/app/routes/caddie.py:1004-1006` builds args via `hc.get("yards", 400)` / `hc.get("par", 4)` / `hc.get("handicap", 9)`. `dict.get(key, default)` only substitutes when the key is **absent**; a present-but-`null` value returns `None`.
- `frontend/src/app/round/[id]/RoundPageClient.tsx:709` sends `yards: round.holes[c.holeNumber - 1]?.yards`, which is `null` for a round with no stored yardage → key present, value null → `.get` returns `None` → crash for every hole → caught by the per-hole `except` at `caddie.py:1020-1024` → the "+0ft on every tile" incident #106's logging was added to name.
- Same latent failure for `par`/`handicap`: `HoleIntelligence(par=None)` would fail pydantic validation (`par: int`, required) and hit the same per-hole `except`.

## Design (locked, per owner "no fake-data fallbacks")
- `build_hole_intelligence` must never throw on `None`/non-numeric numeric inputs.
- `par`, `handicap_rating`: display-only ints the model requires → coalesce to existing signature defaults (`4`, `9`) when not a real int.
- `yards`: HONEST. Unknown yardage stays `yards=None`, `effective_yards=None` — never a fabricated `400` (which would also emit a bogus "plays like"). Elevation (`elevation_change_ft`) is still computed and returned — it is the valuable Elev-tile output and is independent of yards.
- Coalescing lives centrally in `build_hole_intelligence` (single source of truth); the route passes raw request values through so absent-key and null-value collapse to the same `None` path.

## Exact edits

### 1. `backend/app/caddie/types.py` — `HoleIntelligence` (class at line 93; `Optional` already imported, used at line 100)
- Line 96: `    yards: int` → `    yards: Optional[int] = None`
- Line 99: `    effective_yards: int = 0  # adjusted for elevation` → `    effective_yards: Optional[int] = None  # adjusted for elevation; None = yardage unknown`

### 2. `backend/app/caddie/course_intel.py` — `build_hole_intelligence`
Signature (lines 23-29): widen the three numeric params to `Optional[int]` (defaults unchanged so existing no-arg callers/tests are untouched):
```python
async def build_hole_intelligence(
    hole_coords: dict,
    par: Optional[int] = 4,
    yards: Optional[int] = 400,
    handicap_rating: Optional[int] = 9,
    osm_features: Optional[dict] = None,
) -> HoleIntelligence:
```
Coalesce right after `tee = hole_coords.get("tee")` (line 44), before the elevation block:
```python
    # The route passes raw request values, which may be null (stored round
    # with no yardage). Coalesce display-only ints to defaults; keep yards
    # HONEST — unknown yardage must not become a fabricated 400 (owner: no
    # fake-data fallbacks). bool excluded (bool is an int subclass).
    par = par if isinstance(par, int) and not isinstance(par, bool) else 4
    handicap_rating = (
        handicap_rating
        if isinstance(handicap_rating, int) and not isinstance(handicap_rating, bool)
        else 9
    )
    yards = (
        int(round(yards))
        if isinstance(yards, (int, float)) and not isinstance(yards, bool)
        else None
    )
```
Line 55 → honest, None-safe:
```python
    effective_yards = None if yards is None else yards + round(elevation_change / 3)
```
The return block (lines 81-90) is unchanged in shape — `yards=yards` and `effective_yards=effective_yards` now carry `int | None`.

### 3. `backend/app/routes/caddie.py:1004-1006` — pass raw (recommended single honest path)
```python
                par=hc.get("par"),
                yards=hc.get("yards"),
                handicap_rating=hc.get("handicap"),
```
This removes the misleading `.get(k, default)` (which never fired for null anyway) and routes absent-key AND null uniformly through the central coalescing.

### 4. `frontend/src/lib/caddie/types.ts` — `HoleIntelligence` mirror
- Line 70: `  yards: number;` → `  yards: number | null;`
- Line 73: `  effective_yards: number;` → `  effective_yards: number | null;`

Consumer null-tolerance (verified — no tsc break):
- `RoundPageClient.tsx:723` `h.effective_yards ?? 0` → collapses null to number.
- `RoundPageClient.tsx:742` `hi.effective_yards || undefined` → collapses null.
- `RoundPageClient.tsx:1094` `holeIntel?.effectiveYards || (...)` reads the already-coalesced `{effectiveYards}` from the map built at :723 (always `number`); `0` is falsy so it correctly falls back to the real from-tee distance — honest behavior, not a fake plays-like.
- No frontend consumer reads `HoleIntelligence.yards` directly (all `.yards` hits are on the separate `round.holes[]`/`hole` types).
- OUT OF SCOPE / no edit: `frontend/src/lib/caddie/api.ts:243-248` `SessionConditions.plays_like.{yards,effective_yards}` is a distinct `get_conditions` voice-tool endpoint type, not `HoleIntelligence`.

## Test (non-DB, no Postgres / no container)
Add to existing `backend/tests/test_course_intel_resilience.py` (same incident, same file conventions: module-level DB env config at top already covers import-time; `@pytest.mark.asyncio`; `asyncio_mode = "auto"` per `pyproject.toml`). No monkeypatch needed — with no `tee`+`green` the `if tee and green` (line 48) and `if green` (line 59) guards skip all network calls; no `osm_features` → hazards empty.
```python
@pytest.mark.asyncio
async def test_none_inputs_never_throw_and_stay_honest():
    """Null yards/par/handicap from the route (stored round had no yardage)
    must not crash. yards unknown → effective_yards stays None (no fabricated
    400); par/handicap coalesce to display defaults. No tee/green ⇒ zero
    network calls, elevation stays 0.0."""
    intel = await course_intel.build_hole_intelligence(
        hole_coords={"holeNumber": 1},
        yards=None,
        par=None,
        handicap_rating=None,
    )
    assert intel.yards is None
    assert intel.effective_yards is None
    assert intel.par == 4
    assert intel.handicap_rating == 9
    assert intel.elevation_change_ft == 0.0
```

## Edge cases
- `par`/`handicap` non-int (None, 0.0, str) → default (4 / 9). `par=0` invalid golf → non-int→default via `isinstance`; bool excluded (`isinstance(True, int)` is True).
- `yards` genuinely `0` never happens; if it did, `isinstance(0, int)` → `yards=0`, `effective_yards = 0 + elev` (honest, no crash).
- `yards` as JSON float (e.g. `412.0`) → `int(round(yards))` normalizes to the `Optional[int]` field.
- Absent key vs null key now converge: `hc.get(k)` → `None` → central coalesce. Uniform.

## Gates
- Backend: `cd backend && ruff check .` and `cd backend && uv run pytest tests/test_course_intel_resilience.py` (uv per `pyproject.toml`; no DB needed).
- Frontend (`types.ts` touched): `cd frontend && npm run lint && npx tsc --noEmit && npm run build && npx tsx voice-tests/runner.ts --smoke`.
- DB-backed backend integration tests (`backend/tests/integration/`) run in CI, not locally — no Postgres on this machine; do not spin up a container.
