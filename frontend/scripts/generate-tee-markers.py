#!/usr/bin/env python3
"""
Generate the bundled tee-marker PNGs (public/assets/tee-marker-{slug}.png).

Renders a small, calm, anti-aliased dot — a colored fill, a thin white ring,
and a soft ink halo (for contrast against light imagery like sand or cart
paths) — NOT a Google-style pin. Matches the yardage-book "on paper" feel:
one flat colored marker per tee-box color, centered on the tee coordinate.

python3 stdlib only (zlib for PNG compression) — no image library dependency,
per the persistent-map-tee-marker plan (B2: "do not add an image dependency").

Usage:
    python3 scripts/generate-tee-markers.py

Regenerate whenever the palette in `teeColorFor`
(src/lib/map/google-map-helpers.ts) changes — the two are meant to stay in
sync (rgb value here == TEE_COLOR_RULES rgb there).
"""

import os
import struct
import zlib

SIZE = 96  # canvas px — ~3.2x the 30px display size, crisp on 3x retina
CENTER = SIZE / 2
R_FILL = 15.0        # colored dot radius
R_RING_OUTER = 20.0  # outer edge of the thin white ring
R_HALO_OUTER = 23.0  # outer edge of the soft ink halo (contrast on light ground)
FEATHER = 1.25       # anti-alias feather width, in px

INK_HALO = (26, 42, 26)      # T.ink — soft dark halo for contrast on light imagery
HALO_ALPHA = 0.28            # halo peak alpha (soft, not a hard outline)
WHITE = (255, 255, 255)

# Canonical tee-marker colors — MUST match TEE_COLOR_RULES / NEUTRAL_TEE_COLOR
# in src/lib/map/google-map-helpers.ts.
COLORS = {
    "black":   (0x1f, 0x1f, 0x1f),
    "blue":    (0x2e, 0x5a, 0xa8),
    "red":     (0xb2, 0x3a, 0x2e),
    "green":   (0x2f, 0x6b, 0x3a),
    "gold":    (0xc9, 0x9a, 0x2e),
    "white":   (0xf2, 0xef, 0xe6),
    "neutral": (0x6b, 0x65, 0x58),  # T.pencil — calm ink/graphite, unknown tee
}


def coverage(d: float, r: float, feather: float = FEATHER) -> float:
    """1.0 fully inside radius r, 0.0 fully outside, linear feather at the edge."""
    v = (r - d) / feather + 0.5
    return max(0.0, min(1.0, v))


def over(src_rgb, src_a, dst_rgb, dst_a):
    """Porter-Duff 'source over destination' compositing."""
    out_a = src_a + dst_a * (1 - src_a)
    if out_a <= 0:
        return (0, 0, 0), 0.0
    out_rgb = tuple(
        (src_rgb[i] * src_a + dst_rgb[i] * dst_a * (1 - src_a)) / out_a
        for i in range(3)
    )
    return out_rgb, out_a


def render(fill_rgb):
    """Return a SIZE x SIZE list of (r,g,b,a) 0-255 tuples."""
    pixels = []
    for y in range(SIZE):
        row = []
        for x in range(SIZE):
            px = x + 0.5
            py = y + 0.5
            d = ((px - CENTER) ** 2 + (py - CENTER) ** 2) ** 0.5

            rgb, a = (0, 0, 0), 0.0
            # Layer 1 (bottom): soft ink halo.
            halo_cov = coverage(d, R_HALO_OUTER, feather=2.0)
            rgb, a = over(INK_HALO, halo_cov * HALO_ALPHA, rgb, a)
            # Layer 2: white ring.
            ring_cov = coverage(d, R_RING_OUTER)
            rgb, a = over(WHITE, ring_cov, rgb, a)
            # Layer 3 (top): colored fill.
            fill_cov = coverage(d, R_FILL)
            rgb, a = over(fill_rgb, fill_cov, rgb, a)

            r8 = round(max(0, min(255, rgb[0])))
            g8 = round(max(0, min(255, rgb[1])))
            b8 = round(max(0, min(255, rgb[2])))
            a8 = round(max(0, min(255, a * 255)))
            row.append((r8, g8, b8, a8))
        pixels.append(row)
    return pixels


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, pixels) -> None:
    """Minimal 8-bit RGBA PNG encoder — stdlib zlib only, no filtering (type 0)."""
    height = len(pixels)
    width = len(pixels[0])

    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0 (none) for every scanline
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(bytes(raw), 9)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(_chunk(b"IHDR", ihdr))
        f.write(_chunk(b"IDAT", idat))
        f.write(_chunk(b"IEND", b""))


def main() -> None:
    out_dir = os.path.join(os.path.dirname(__file__), "..", "public", "assets")
    out_dir = os.path.normpath(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    for slug, rgb in COLORS.items():
        pixels = render(rgb)
        path = os.path.join(out_dir, f"tee-marker-{slug}.png")
        write_png(path, pixels)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
