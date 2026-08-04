"""OSM-vs-CV comparison for the tree-detection spike — makes the findings reproducible.

RESEARCH SPIKE (2026-07-09). NOT wired into the app. Isolated spike venv only
(numpy + Pillow + requests), same as tree_detect_spike.py.

Given a hole's tee/green, this:
  1. fetches the ESRI tile mosaic + runs the classical CV canopy detector (from
     tree_detect_spike.py),
  2. fetches OSM `natural=tree` nodes and `natural=wood`/`landuse=forest`/`scrub`/
     `tree_row` polygons for the same bbox (the SAME tags osm.py ingests),
  3. writes a 3-panel figure (raw | CV canopy | OSM trees+woods), and
  4. prints the numbers cited in specs/tree-detection-cv-findings.md: OSM node/poly
     counts, CV canopy %, whole-corridor vs in-woods mean ExG (the leaf-off signal),
     and CV recall inside OSM-mapped woodland.

Run (from repo root, isolated venv):
    /tmp/tree-spike-venv/bin/python backend/scripts/tree_osm_compare.py \
        --tee 40.745894,-73.450704 --green 40.749638,-73.452077 \
        --label black-15 --out /tmp/tree-spike-out
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tree_spike_geometry import corridor_bbox  # noqa: E402

try:
    import numpy as np
    import requests
    from PIL import Image, ImageDraw
except ImportError as exc:  # pragma: no cover - spike-venv guard
    sys.exit(
        f"[tree_osm_compare] missing '{exc.name}'. SPIKE script — isolated venv only:\n"
        "  python3 -m venv /tmp/tree-spike-venv\n"
        "  /tmp/tree-spike-venv/bin/pip install numpy Pillow requests"
    )

from tree_detect_spike import detect_canopy, fetch_mosaic, morph  # noqa: E402

_UA = {"User-Agent": "looper-tree-spike/1.0 (feasibility research; contact repo owner)"}
_OVERPASS = "https://overpass-api.de/api/interpreter"


def osm_features(bbox):
    """Return (tree_nodes[(lat,lng)], woods_polys[[(lat,lng)...]]) for the bbox using
    the same tags backend/app/services/osm.py ingests."""
    min_lat, min_lng, max_lat, max_lng = bbox
    b = f"{min_lat},{min_lng},{max_lat},{max_lng}"
    q = (f"[out:json][timeout:60];("
         f"node[natural=tree]({b});"
         f"way[natural=wood]({b});way[landuse=forest]({b});"
         f"way[natural=scrub]({b});way[natural=tree_row]({b}););out geom;")
    # Overpass throttles anonymous callers; retry a couple of times on a non-JSON body.
    els = None
    for attempt in range(3):
        resp = requests.post(_OVERPASS, data={"data": q}, headers=_UA, timeout=90)
        try:
            els = resp.json().get("elements", [])
            break
        except ValueError:
            if attempt == 2:
                sys.exit(f"[tree_osm_compare] Overpass returned no JSON "
                         f"(status {resp.status_code}) — likely rate-limited; retry later.")
            __import__("time").sleep(10)
    trees = [(e["lat"], e["lon"]) for e in els if e.get("type") == "node"]
    polys = [[(p["lat"], p["lon"]) for p in e["geometry"]]
             for e in els if e.get("type") == "way" and e.get("geometry")]
    return trees, polys


def _label(img, text):
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 300, 26], fill=(0, 0, 0))
    d.text((6, 8), text, fill=(255, 255, 255))
    return img


def run(tee, green, label, z, buffer_yd, out_dir):
    bbox = corridor_bbox(tee, green, buffer_yd)
    img, to_px, mpp = fetch_mosaic(bbox, z, os.path.join(out_dir, "tiles"))
    canopy, exg, _ = detect_canopy(img)
    canopy = morph(canopy)
    tx, ty = to_px(*tee)
    gx, gy = to_px(*green)

    def chord(dd):
        dd.line([tx, ty, gx, gy], fill=(0, 200, 255, 255), width=3)
        dd.ellipse([tx - 6, ty - 6, tx + 6, ty + 6], fill=(0, 255, 0, 255))
        dd.ellipse([gx - 6, gy - 6, gx + 6, gy + 6], fill=(255, 255, 0, 255))

    p1 = img.copy()
    chord(ImageDraw.Draw(p1))
    _label(p1, "RAW satellite (ESRI)")

    ov = img.convert("RGBA")
    tint = np.zeros((*canopy.shape, 4), dtype=np.uint8)
    tint[canopy] = [255, 40, 40, 120]
    p2 = Image.alpha_composite(ov, Image.fromarray(tint)).convert("RGB")
    chord(ImageDraw.Draw(p2))
    _label(p2, f"CV canopy {canopy.mean() * 100:.1f}%")

    trees, polys = osm_features(bbox)
    ref = Image.new("L", img.size, 0)
    rd = ImageDraw.Draw(ref)
    p3 = img.convert("RGBA")
    layer = Image.new("RGBA", p3.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    for poly in polys:
        pts = [to_px(la, lo) for la, lo in poly]
        if len(pts) >= 3:
            rd.polygon(pts, fill=255)
            ld.polygon(pts, fill=(40, 120, 255, 90), outline=(40, 120, 255, 255))
    for la, lo in trees:
        x, y = to_px(la, lo)
        ld.ellipse([x - 4, y - 4, x + 4, y + 4], fill=(255, 180, 0, 230))
    p3 = Image.alpha_composite(p3, layer).convert("RGB")
    chord(ImageDraw.Draw(p3))
    _label(p3, f"OSM {len(trees)} trees {len(polys)} woods")

    combo = Image.new("RGB", (p1.width + p2.width + p3.width, max(p.height for p in (p1, p2, p3))), (20, 20, 20))
    x = 0
    for p in (p1, p2, p3):
        combo.paste(p, (x, 0))
        x += p.width
    scale = 1000.0 / combo.width
    combo = combo.resize((1000, int(combo.height * scale)))
    os.makedirs(out_dir, exist_ok=True)
    combo_path = os.path.join(out_dir, f"{label}_compare.jpg")
    combo.save(combo_path, "JPEG", quality=72)

    ref_mask = np.asarray(ref) > 0
    stats = {
        "label": label, "zoom": z, "mpp": round(mpp, 3),
        "cv_canopy_pct": round(float(canopy.mean()) * 100, 1),
        "osm_tree_nodes": len(trees), "osm_woods_polys": len(polys),
        "mean_exg_corridor": round(float(exg.mean()), 1), "compare_fig": combo_path,
    }
    if ref_mask.sum() > 500:
        stats["osm_woods_px"] = int(ref_mask.sum())
        stats["mean_exg_in_woods"] = round(float(exg[ref_mask].mean()), 1)
        stats["cv_recall_in_woods_pct"] = round(float(canopy[ref_mask].mean()) * 100, 1)
    print(json.dumps(stats))
    json.dump(stats, open(os.path.join(out_dir, f"{label}_compare_stats.json"), "w"), indent=2)
    return stats


def _parse_ll(s):
    lat, lng = s.split(",")
    return float(lat), float(lng)


def main():
    ap = argparse.ArgumentParser(description="OSM-vs-CV tree comparison spike")
    ap.add_argument("--tee", required=True, type=_parse_ll)
    ap.add_argument("--green", required=True, type=_parse_ll)
    ap.add_argument("--label", required=True)
    ap.add_argument("--zoom", type=int, default=19)
    ap.add_argument("--buffer-yd", type=float, default=60.0)
    ap.add_argument("--out", default="/tmp/tree-spike-out")
    a = ap.parse_args()
    run(a.tee, a.green, a.label, a.zoom, a.buffer_yd, a.out)


if __name__ == "__main__":
    main()
