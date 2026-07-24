"""One-time, gated fixture extractor (specs/caddie-bench-plan.md §1). NOT a
pytest module (filename doesn't match `test_*.py` — pinned by
`test_bench_teeth.py`); refuses to run without `CADDIE_BENCH_EXTRACT=1`.

Two modes:
  --from-overpass (default, ZERO network): parses the already-committed
    `tests/fixtures/bethpage_overpass.json` via the production
    `_parse_course_geometry_response` + `assemble_osm_course` pipeline
    (exactly `test_bethpage_validation.py` / `test_tee_club_expected_strokes.py`
    already exercise) and writes one `{_provenance, par, yards, features}`
    file per pilot hole under `fixtures/holes/`. Yardages for Black holes are
    injected from the published card (`test_bethpage_validation.py::CARD`);
    Red holes have no card in this repo, so yardage is DERIVED from the
    tee->green polyline length (same straight-line method
    `test_tee_club_expected_strokes.py::_linestring_yards` uses), labeled in
    `_provenance` as derived, not measured.

  --from-prod (READ-ONLY): one `SELECT ... ST_AsGeoJSON(geom) FROM
    public.hole_features WHERE hole_id = ...` against prod RDS, run on-box
    with `DATABASE_URL` in-process only. Used once for Muirfield Village 14
    (optional pilot hole #9). Still requires `CADDIE_BENCH_EXTRACT=1`.

Invocation (never in CI):
    cd backend && CADDIE_BENCH_EXTRACT=1 uv run python -m \\
        tests.eval.caddie_bench.extract_fixtures --from-overpass
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Optional

_LAT_M_PER_DEG = 111_320.0
_M_PER_YARD = 0.9144

_OVERPASS_FIXTURE_PATH = Path(__file__).parent.parent.parent / "fixtures" / "bethpage_overpass.json"
_PEBBLE_SOURCE_PATH = Path(__file__).parent.parent.parent / "fixtures" / "pebble_beach_hole3_geometry.json"
_HOLES_OUT_DIR = Path(__file__).parent / "fixtures" / "holes"

# Published Bethpage Black scorecard (Black tees) — same source as
# test_bethpage_validation.py::CARD (bluegolf.ijgt.com, verified 2026-06-29).
_BLACK_CARD_YARDS: dict[int, int] = {
    4: 517, 5: 478, 7: 553, 8: 210, 18: 411,
}

# The pilot's 7 core Bethpage holes (par-4/5) + 1 par-3, per plan §2.
_BLACK_PAR45_HOLES = (4, 5, 7, 18)
_BLACK_PAR3_HOLES = (8,)
_RED_HOLES = (6, 16)


def _linestring_yards(coords: list) -> Optional[float]:
    if len(coords) < 2:
        return None
    lon1, lat1 = coords[0]
    lon2, lat2 = coords[-1]
    mid_lat_rad = math.radians((lat1 + lat2) / 2.0)
    dx_m = (lon2 - lon1) * _LAT_M_PER_DEG * math.cos(mid_lat_rad)
    dy_m = (lat2 - lat1) * _LAT_M_PER_DEG
    return math.hypot(dx_m, dy_m) / _M_PER_YARD


def _hole_linestring_coords(fc: dict) -> Optional[list]:
    for f in fc.get("features", []):
        if (f.get("properties") or {}).get("featureType") == "hole":
            geom = f.get("geometry") or {}
            if geom.get("type") == "LineString":
                return geom.get("coordinates")
    return None


def extract_from_overpass(out_dir: Path = _HOLES_OUT_DIR) -> list[Path]:
    from app.services.osm import _parse_course_geometry_response
    from app.services.osm_ingest import _deterministic_uuid, assemble_osm_course

    if not _OVERPASS_FIXTURE_PATH.exists():
        raise FileNotFoundError(f"missing committed fixture: {_OVERPASS_FIXTURE_PATH}")
    raw = json.loads(_OVERPASS_FIXTURE_PATH.read_text())
    geometry = _parse_course_geometry_response(raw, course_name_filter=None)

    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    for course_display, target_course_name, wanted, slug in (
        ("Bethpage Black", "Black", _BLACK_PAR45_HOLES + _BLACK_PAR3_HOLES, "bethpage_black"),
        ("Bethpage Red", "Red", _RED_HOLES, "bethpage_red"),
    ):
        course_id = _deterministic_uuid(f"osm-{slug}")
        assembled = assemble_osm_course(
            geometry=geometry, course_id=course_id, course_name=course_display,
            target_course_name=target_course_name, address="99 Quaker Meeting House Rd, Farmingdale, NY 11735",
            location={"lat": 40.7445, "lng": -73.4609},
        )
        by_number = {h["number"]: h for h in assembled["holes"]}
        for n in wanted:
            if n not in by_number:
                raise ValueError(f"{course_display}: hole {n} not assembled from the Overpass fixture")
            h = by_number[n]
            if slug == "bethpage_black":
                yards = _BLACK_CARD_YARDS[n]
                provenance = (
                    f"OSM geometry assembled from the committed tests/fixtures/bethpage_overpass.json "
                    f"({course_display}, hole {n}) via app.services.osm_ingest.assemble_osm_course. "
                    f"Yardage {yards} from the published Bethpage Black scorecard "
                    "(BlueGolf/IJGT, verified 2026-06-29 — see test_bethpage_validation.py::CARD)."
                )
            else:
                coords = _hole_linestring_coords(h["features"])
                yards = round(_linestring_yards(coords)) if coords else None
                provenance = (
                    f"OSM geometry assembled from the committed tests/fixtures/bethpage_overpass.json "
                    f"({course_display}, hole {n}) via app.services.osm_ingest.assemble_osm_course. "
                    f"Yardage {yards} DERIVED (straight-line tee->green polyline length) — no published "
                    "card for Bethpage Red in this repo; see test_tee_club_expected_strokes.py for the "
                    "same derivation method used elsewhere in this codebase."
                )
            out_path = out_dir / f"{slug}_h{n}.json"
            out_path.write_text(json.dumps({
                "_provenance": provenance,
                "par": h["par"],
                "yards": yards,
                "features": h["features"],
            }, indent=2))
            written.append(out_path)

    return written


def copy_pebble_fixture(out_dir: Path = _HOLES_OUT_DIR) -> Path:
    """Re-point the existing committed Pebble Beach hole-3 geometry fixture
    into the bench's own fixtures/holes/ directory, in the bench's
    `{_provenance, par, yards, features}` shape."""
    if not _PEBBLE_SOURCE_PATH.exists():
        raise FileNotFoundError(f"missing committed fixture: {_PEBBLE_SOURCE_PATH}")
    blob = json.loads(_PEBBLE_SOURCE_PATH.read_text())
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "pebble_beach_h3.json"
    out_path.write_text(json.dumps({
        "_provenance": (
            blob.get("_provenance", "")
            + " Re-pointed into caddie_bench/fixtures/holes/ verbatim by "
            "extract_fixtures.copy_pebble_fixture (no new extraction)."
        ),
        "par": blob["par"],
        "yards": 381,  # published Pebble Beach hole 3 yardage (see test_corner_tree_forward_bound.py)
        "features": blob["features"],
    }, indent=2))
    return out_path


def extract_from_prod(hole_id: str, out_path: Path) -> Path:
    """READ-ONLY single-hole extraction from prod RDS. `DATABASE_URL` read
    from the environment, in-process only — never logged, never written to
    the output fixture. One SELECT, same query shape as
    `courses_mapped.get_course`."""
    import asyncio

    async def _run() -> dict:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import create_async_engine

        database_url = os.environ["DATABASE_URL"]
        engine = create_async_engine(database_url)
        try:
            async with engine.connect() as conn:
                result = await conn.execute(
                    text(
                        "SELECT hole_number, par, yardages, properties, "
                        "ST_AsGeoJSON(geom)::json AS geom_json "
                        "FROM public.hole_features WHERE hole_id = :hole_id"
                    ),
                    {"hole_id": hole_id},
                )
                rows = result.mappings().all()
        finally:
            await engine.dispose()
        if not rows:
            raise ValueError(f"no hole_features rows for hole_id={hole_id!r}")
        features = [
            {
                "type": "Feature",
                "properties": dict(r["properties"] or {}),
                "geometry": r["geom_json"],
            }
            for r in rows
        ]
        par = rows[0]["par"]
        yardages = rows[0]["yardages"] or {}
        yards = next(iter(yardages.values()), None) if yardages else None
        return {"par": par, "yards": yards, "features": {"type": "FeatureCollection", "features": features}}

    data = asyncio.run(_run())
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        "_provenance": (
            f"Prod stored-course FeatureCollection, hole_id={hole_id} — READ-ONLY extraction via "
            "extract_fixtures.py --from-prod (CADDIE_BENCH_EXTRACT=1, on-box DATABASE_URL, key-free)."
        ),
        "par": data["par"],
        "yards": data["yards"],
        "features": data["features"],
    }, indent=2))
    return out_path


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from-overpass", action="store_true", default=True)
    parser.add_argument("--from-prod", metavar="HOLE_ID", default=None)
    parser.add_argument("--pebble", action="store_true", help="also (re)write the Pebble Beach hole-3 fixture")
    args = parser.parse_args(argv)

    if os.getenv("CADDIE_BENCH_EXTRACT") != "1":
        print(
            "extract_fixtures.py is gated OFF by default. To run it on-demand:\n"
            "  cd backend && CADDIE_BENCH_EXTRACT=1 uv run python -m "
            "tests.eval.caddie_bench.extract_fixtures --from-overpass\n",
            file=sys.stderr,
        )
        return 2

    if args.from_prod:
        out_path = _HOLES_OUT_DIR / "muirfield_village_h14.json"
        written = extract_from_prod(args.from_prod, out_path)
        print(f"wrote {written}")
        return 0

    written = extract_from_overpass()
    for p in written:
        print(f"wrote {p}")
    pebble = copy_pebble_fixture()
    print(f"wrote {pebble}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
