"""Tree-canopy detection feasibility spike — classical CV over ESRI satellite tiles.

RESEARCH SPIKE (2026-07-09). NOT wired into the app. Runs ONLY in an isolated spike
venv — it imports numpy + Pillow, which are deliberately absent from the app's deps.
The pure-geometry helpers it uses live in tree_spike_geometry.py (no numpy) and ARE
tested in CI.

Set up + run (from repo root):
    python3 -m venv /tmp/tree-spike-venv
    /tmp/tree-spike-venv/bin/pip install numpy Pillow requests
    /tmp/tree-spike-venv/bin/python backend/scripts/tree_detect_spike.py \
        --tee 40.742998,-73.454575 --green 40.745071,-73.451351 \
        --label black-1 --out /tmp/tree-spike-out

Method (see specs/tree-detection-cv-spike-plan.md §2): a golf course is all green, so
colour (Excess-Green) is only a NEGATIVE filter; the discriminator between mown turf and
tree canopy is TEXTURE (local std-dev of luminance) — canopy is bumpy, turf is smooth.
Outputs per hole: a raw mosaic PNG, a canopy-overlay PNG, and a stats line/JSON.

Findings from the real Bethpage run are recorded in specs/tree-detection-cv-findings.md.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
import time

# scripts/ is not a package — import the sibling pure-geometry module directly.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tree_spike_geometry import (  # noqa: E402
    ESRI_WORLD_IMAGERY,
    latlng_to_tile,
    meters_per_pixel,
    corridor_bbox,
)

try:
    import numpy as np
    import requests
    from PIL import Image, ImageDraw
except ImportError as exc:  # pragma: no cover - spike-venv guard
    sys.exit(
        f"[tree_detect_spike] missing '{exc.name}'. This is a SPIKE script; run it in an "
        "isolated venv:\n  python3 -m venv /tmp/tree-spike-venv\n"
        "  /tmp/tree-spike-venv/bin/pip install numpy Pillow requests\n"
        "Do NOT add these to the app's pyproject.toml."
    )

_UA = {"User-Agent": "looper-tree-spike/1.0 (feasibility research; contact repo owner)"}


def fetch_mosaic(bbox, z, cache_dir):
    """Fetch + stitch the ESRI tiles covering ``bbox`` (min_lat,min_lng,max_lat,max_lng).
    Returns (PIL image, latlng->pixel fn, meters_per_pixel). Tiles cached to disk."""
    min_lat, min_lng, max_lat, max_lng = bbox
    x0, ytop, _, _ = latlng_to_tile(max_lat, min_lng, z)  # NW corner
    x1, ybot, _, _ = latlng_to_tile(min_lat, max_lng, z)  # SE corner
    xa, xb = min(x0, x1), max(x0, x1)
    ya, yb = min(ytop, ybot), max(ytop, ybot)
    canvas = Image.new("RGB", ((xb - xa + 1) * 256, (yb - ya + 1) * 256))
    os.makedirs(cache_dir, exist_ok=True)
    for tx in range(xa, xb + 1):
        for ty in range(ya, yb + 1):
            cache = os.path.join(cache_dir, f"tile_{z}_{tx}_{ty}.jpg")
            if os.path.exists(cache):
                data = open(cache, "rb").read()
            else:
                url = ESRI_WORLD_IMAGERY.format(z=z, x=tx, y=ty)
                data = requests.get(url, headers=_UA, timeout=30).content
                open(cache, "wb").write(data)
                time.sleep(0.15)  # politeness
            canvas.paste(Image.open(io.BytesIO(data)).convert("RGB"),
                         ((tx - xa) * 256, (ty - ya) * 256))

    def latlng_to_px(lat, lng):
        xt, yt, px, py = latlng_to_tile(lat, lng, z)
        return (xt - xa) * 256 + px, (yt - ya) * 256 + py

    mpp = meters_per_pixel((min_lat + max_lat) / 2.0, z)
    return canvas, latlng_to_px, mpp


def _box_mean(a, k):
    """Same-shape running-mean box filter via an integral image (pure numpy)."""
    pad = k // 2
    ap = np.pad(a, pad, mode="edge")
    integ = np.zeros((ap.shape[0] + 1, ap.shape[1] + 1), dtype=np.float64)
    integ[1:, 1:] = ap.cumsum(0).cumsum(1)
    n, m = a.shape
    s = (integ[k:k + n, k:k + m] - integ[0:n, k:k + m]
         - integ[k:k + n, 0:m] + integ[0:n, 0:m])
    return s / (k * k)


def detect_canopy(img, k_tex=9, exg_t=8.0, tex_t=14.0):
    """Excess-Green vegetation gate AND high local-texture -> canopy mask. Returns
    (canopy bool mask, exg array, texture array)."""
    arr = np.asarray(img).astype(np.float64)
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    exg = 2 * g - r - b  # excess green vegetation index (0-255 channels)
    var = np.clip(_box_mean(lum * lum, k_tex) - _box_mean(lum, k_tex) ** 2, 0, None)
    texture = np.sqrt(var)  # local std-dev of luminance
    return (exg > exg_t) & (texture > tex_t), exg, texture


def morph(mask, it_open=1, it_close=3):
    """Binary open (despeckle) then close (bridge crown gaps) via 3x3 box thresholds."""
    def dilate(m):
        return _box_mean(m.astype(np.float64), 3) > 0.001

    def erode(m):
        return _box_mean(m.astype(np.float64), 3) > 0.999

    m = mask
    for _ in range(it_open):
        m = dilate(erode(m))
    for _ in range(it_close):
        m = erode(dilate(m))
    return m


def process(tee, green, label, z, buffer_yd, out_dir):
    bbox = corridor_bbox(tee, green, buffer_yd)
    img, to_px, mpp = fetch_mosaic(bbox, z, os.path.join(out_dir, "tiles"))
    canopy, _, _ = detect_canopy(img)
    canopy = morph(canopy)

    # overlay: canopy tinted red, tee->green chord in cyan
    overlay = img.convert("RGBA")
    tint = np.zeros((*canopy.shape, 4), dtype=np.uint8)
    tint[canopy] = [255, 40, 40, 120]
    overlay = Image.alpha_composite(overlay, Image.fromarray(tint))
    draw = ImageDraw.Draw(overlay)
    tx, ty = to_px(*tee)
    gx, gy = to_px(*green)
    draw.line([tx, ty, gx, gy], fill=(0, 200, 255, 255), width=3)
    draw.ellipse([tx - 6, ty - 6, tx + 6, ty + 6], fill=(0, 255, 0, 255))
    draw.ellipse([gx - 6, gy - 6, gx + 6, gy + 6], fill=(255, 255, 0, 255))

    os.makedirs(out_dir, exist_ok=True)
    raw_path = os.path.join(out_dir, f"{label}_raw.png")
    ov_path = os.path.join(out_dir, f"{label}_overlay.png")
    img.save(raw_path)
    overlay.convert("RGB").save(ov_path)

    line_yd = math.hypot((gx - tx) * mpp, (gy - ty) * mpp) * 1.09361
    stats = {
        "label": label, "zoom": z, "mpp": round(mpp, 3),
        "mosaic_px": list(img.size), "canopy_pct": round(float(canopy.mean()) * 100, 1),
        "chord_yards": round(line_yd), "raw": raw_path, "overlay": ov_path,
    }
    json.dump(stats, open(os.path.join(out_dir, f"{label}_stats.json"), "w"), indent=2)
    print(f"{label} z{z} canopy={stats['canopy_pct']}% mpp={stats['mpp']} "
          f"chord={stats['chord_yards']}yd -> {ov_path}")
    return stats


def _parse_ll(s):
    lat, lng = s.split(",")
    return float(lat), float(lng)


def main():
    ap = argparse.ArgumentParser(description="Tree-canopy CV spike over ESRI tiles")
    ap.add_argument("--tee", required=True, type=_parse_ll, help="LAT,LNG")
    ap.add_argument("--green", required=True, type=_parse_ll, help="LAT,LNG")
    ap.add_argument("--label", required=True)
    ap.add_argument("--zoom", type=int, default=19)
    ap.add_argument("--buffer-yd", type=float, default=60.0)
    ap.add_argument("--out", default="/tmp/tree-spike-out")
    args = ap.parse_args()
    process(args.tee, args.green, args.label, args.zoom, args.buffer_yd, args.out)


if __name__ == "__main__":
    main()
