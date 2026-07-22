"""Map composite renderer — the judge's "screenshot of the map + hole number
+ course + wind + yardage left" context pack (specs/caddie-bench-plan.md §1,
§4). Two modes:

  - `mode="vector"` — a neutral on-paper background with the SAME overlays,
    zero network/key. This is the offline/CI substrate and the diffable
    artifact (G1) — NOT judge-equivalent (no tree/texture context), never
    used for the pilot's judged scores.
  - `mode="satellite"` — Google Static Maps base tile (`maptype=satellite`,
    cached per (hole, center, zoom, mode) in `runs/tile_cache/`, ~$0.04
    total for the pilot) with the same overlays drawn on top. This is what
    the LIVE pilot judges against — never exercised offline (no key, no
    network, in CI).

Composites are drawn with Pillow (test-only dev dependency — never imported
by `app/`). `GOOGLE_MAPS_KEY` is read from the environment at call time,
never logged, never embedded in a cache filename or PNG metadata.
"""

from __future__ import annotations

import hashlib
import math
import os
from pathlib import Path
from typing import Literal, Optional

from PIL import Image, ImageDraw

from tests.eval.caddie_bench import geometry as geo
from tests.eval.caddie_bench.schema import BenchCase, ResolvedPosition

_IMG_SIZE = 640
_PAD_YARDS = 40  # bbox padding around tee/green/hazards, in yards
_M_PER_YARD = 0.9144

_PAPER_BG = (245, 240, 227)   # yardage-book cream — vector-mode background
_INK = (58, 50, 38)
_FAIRWAY = (198, 209, 172)
_BUNKER = (223, 201, 154)
_WATER = (150, 190, 205)
_GREEN = (150, 196, 140)
_HAZARD_OUTLINE = (176, 84, 60)
_PIN = (204, 60, 45)
_PLAYER = (40, 60, 200)


def _hole_bbox(fc: dict) -> tuple[float, float, float, float]:
    """(min_lon, min_lat, max_lon, max_lat) over every coordinate in the
    FeatureCollection, padded by `_PAD_YARDS`."""
    lons: list[float] = []
    lats: list[float] = []

    def _walk(coords):
        if isinstance(coords[0], (int, float)):
            lons.append(coords[0])
            lats.append(coords[1])
            return
        for c in coords:
            _walk(c)

    for f in fc.get("features", []):
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates")
        if coords:
            _walk(coords)
    if not lons:
        raise ValueError("FeatureCollection has no coordinates to bound")
    mid_lat = (min(lats) + max(lats)) / 2.0
    pad_deg_lat = (_PAD_YARDS * _M_PER_YARD) / 111_320.0
    pad_deg_lon = pad_deg_lat / max(math.cos(math.radians(mid_lat)), 0.1)
    return min(lons) - pad_deg_lon, min(lats) - pad_deg_lat, max(lons) + pad_deg_lon, max(lats) + pad_deg_lat


def _projector(bbox: tuple[float, float, float, float], size: int = _IMG_SIZE):
    min_lon, min_lat, max_lon, max_lat = bbox
    mid_lat = math.radians((min_lat + max_lat) / 2.0)
    cos_lat = max(math.cos(mid_lat), 0.1)
    span_x = (max_lon - min_lon) * cos_lat
    span_y = max_lat - min_lat
    span = max(span_x, span_y, 1e-9)

    def project(lon: float, lat: float) -> tuple[float, float]:
        x = ((lon - min_lon) * cos_lat) / span * size
        y = size - ((lat - min_lat) / span * size)  # flip: north = up
        return x, y

    return project


def _tile_cache_path(cache_dir: Path, hole_fixture_id: str, mode: str, zoom: int) -> Path:
    # Key-free filename: hashes the (hole, mode, zoom) tuple, never any
    # secret material.
    digest = hashlib.sha256(f"{hole_fixture_id}|{mode}|{zoom}".encode()).hexdigest()[:16]
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"{hole_fixture_id}_{mode}_{digest}.png"


def fetch_base_tile(
    fx: geo.HoleFixture, *, mode: Literal["satellite", "vector"], cache_dir: Path,
) -> Image.Image:
    """`mode="vector"`: a blank on-paper canvas, zero network. `mode=
    "satellite"`: Google Static Maps, cached forever per hole. Only
    "satellite" ever touches the network or a key."""
    if mode == "vector":
        return Image.new("RGB", (_IMG_SIZE, _IMG_SIZE), _PAPER_BG)

    if mode != "satellite":
        raise ValueError(f"unknown render mode {mode!r}")

    cache_path = _tile_cache_path(cache_dir, fx.fixture_id, mode, zoom=17)
    if cache_path.exists():
        return Image.open(cache_path).convert("RGB")

    api_key = os.getenv("GOOGLE_MAPS_KEY") or os.getenv("NEXT_PUBLIC_GOOGLE_MAPS_KEY")
    if not api_key:
        raise RuntimeError(
            "GOOGLE_MAPS_KEY not set — satellite rendering requires it (never used offline/CI)."
        )
    import httpx

    bbox = _hole_bbox(fx.features)
    center_lat = (bbox[1] + bbox[3]) / 2.0
    center_lon = (bbox[0] + bbox[2]) / 2.0
    params = {
        "center": f"{center_lat},{center_lon}",
        "zoom": "17",
        "size": f"{_IMG_SIZE // 2}x{_IMG_SIZE // 2}",
        "scale": "2",
        "maptype": "satellite",
        "key": api_key,
    }
    resp = httpx.get("https://maps.googleapis.com/maps/api/staticmap", params=params, timeout=15.0)
    resp.raise_for_status()
    cache_path.write_bytes(resp.content)
    return Image.open(cache_path).convert("RGB")


def compose(
    base: Image.Image, fx: geo.HoleFixture, resolved: ResolvedPosition, annotations: dict,
) -> Image.Image:
    """Pure given the base image — draws hazard outlines, centerline, the
    player position pin, the green/target, and the text annotations (yardage,
    wind, hole/par header) that mirror what the owner's screenshot flow
    captures."""
    img = base.copy().resize((_IMG_SIZE, _IMG_SIZE))
    draw = ImageDraw.Draw(img, "RGBA")
    bbox = _hole_bbox(fx.features)
    project = _projector(bbox)

    def _ring_px(ring: list[list[float]]) -> list[tuple[float, float]]:
        return [project(lon, lat) for lon, lat in ring]

    for f in fx.features.get("features", []):
        props = f.get("properties") or {}
        ftype = props.get("featureType")
        geom = f.get("geometry") or {}
        color = {"fairway": _FAIRWAY, "bunker": _BUNKER, "water": _WATER, "green": _GREEN}.get(ftype)
        if color is None or geom.get("type") != "Polygon" or not geom.get("coordinates"):
            continue
        pts = _ring_px(geom["coordinates"][0])
        draw.polygon(pts, fill=(*color, 140), outline=(*_HAZARD_OUTLINE, 200) if ftype in ("bunker", "water") else _INK)

    hole_feat = next((f for f in fx.features.get("features", []) if (f.get("properties") or {}).get("featureType") == "hole"), None)
    if hole_feat:
        coords = (hole_feat.get("geometry") or {}).get("coordinates") or []
        if len(coords) >= 2:
            pts = [project(lon, lat) for lon, lat in coords]
            draw.line(pts, fill=_INK, width=2)

    # Player position.
    px, py = project(resolved.lng, resolved.lat)
    r = 7
    draw.ellipse([px - r, py - r, px + r, py + r], fill=_PLAYER, outline=_INK)

    # Green pin (approximate green centroid).
    green_feats = [f for f in fx.features.get("features", []) if (f.get("properties") or {}).get("featureType") == "green"]
    if green_feats:
        gx, gy = project(*(geo._feature_point(green_feats[0]) or (resolved.lng, resolved.lat)))
        draw.line([(gx, gy - 14), (gx, gy + 8)], fill=_PIN, width=2)
        draw.polygon([(gx, gy - 14), (gx + 10, gy - 10), (gx, gy - 6)], fill=_PIN)

    header = (
        f"Hole {fx.hole_number} · Par {fx.par}"
        f"{f' · {fx.yards}y' if fx.yards else ''} · {round(resolved.distance_to_green_yards)}y to green"
    )
    draw.rectangle([0, 0, _IMG_SIZE, 26], fill=(*_PAPER_BG, 235))
    draw.text((8, 6), header, fill=_INK)

    wind_line = annotations.get("wind_line")
    if wind_line:
        draw.rectangle([0, _IMG_SIZE - 24, _IMG_SIZE, _IMG_SIZE], fill=(*_PAPER_BG, 235))
        draw.text((8, _IMG_SIZE - 20), wind_line, fill=_INK)

    return img


def render_case(
    case: BenchCase, fx: geo.HoleFixture, resolved: ResolvedPosition, *,
    mode: Literal["satellite", "vector"], out_dir: Path, cache_dir: Optional[Path] = None,
    annotations: Optional[dict] = None,
) -> Path:
    """Renders ONE case's composite PNG to `out_dir/composites/<case.id>.png`
    (gitignored under `runs/`, except the worst-10 gallery report.py copies
    out) and returns its path."""
    cache_dir = cache_dir or (out_dir / "tile_cache")
    base = fetch_base_tile(fx, mode=mode, cache_dir=cache_dir)
    img = compose(base, fx, resolved, annotations or {})
    composites_dir = out_dir / "composites"
    composites_dir.mkdir(parents=True, exist_ok=True)
    out_path = composites_dir / f"{case.id}.png"
    img.save(out_path)
    return out_path
