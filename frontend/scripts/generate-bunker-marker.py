#!/usr/bin/env python3
"""
Generate the bundled bunker-marker PNGs (public/assets/bunker-marker.png and
public/assets/bunker-marker-{a..f}.png).

Renders a small sand "bean" with an ink outline — the canonical printed-
yardage-book symbol for a bunker — so it reads as a DISTINCT shape from the
round 200/150/100 yardage plates (specs/tee-shot-overlays-center-and-style-
plan.md, Part B). An asymmetric, non-round silhouette works at a glance over
any satellite imagery and for colorblind users, not just a color swap.

The lettered variants (A-F) additionally stamp a large ink coin with a
reversed-out paper letter over the bean — the legend key shared with
`BunkerCarry.letter` (specs/lettered-bunker-legend-plan.md). The coin is sized
to read at the TRUE 26x26 display size (roughly a quarter of this 96px
canvas), so it dominates the marker; the sand bean peeks out at the
lower-left as the secondary "this is sand" cue. `render(None)` reproduces the
plain bean (with stipples) byte-identical to the original single-PNG
generator; `render('A')`..`render('F')` drop the stipples and add the coin +
letter.

python3 stdlib only (zlib for PNG compression) — no image library dependency,
mirrors `generate-tee-markers.py`'s `coverage`, `over`, `_chunk`, `write_png`
helpers exactly.

Usage:
    python3 scripts/generate-bunker-marker.py

Re-run is idempotent (deterministic render) — safe to regenerate whenever the
glyph geometry/tones below change.
"""

import os
import struct
import zlib

SIZE = 96  # canvas px — ~4.4x the 22px display size, crisp on 3x retina
FEATHER = 1.25  # anti-alias feather width, in px (matches generate-tee-markers.py)

INK = (26, 42, 26)  # T.ink
HALO_ALPHA = 0.25
SAND = (0xD9, 0xC4, 0x92)  # muted sand — between T.gold (#c99a2e) and T.paperEdge (#d9d2c0)
STIPPLE_ALPHA = 0.55

# Tilted bean silhouette — signed-distance union of two circles (exact for
# circle unions): sd(p) = min(|p-c1|-r1, |p-c2|-r2).
C1 = (38.0, 52.0)
R1 = 20.0
C2 = (58.0, 46.0)
R2 = 15.0

STIPPLES = [(36.0, 50.0), (48.0, 47.0), (58.0, 44.0)]
STIPPLE_R = 2.5

# ── Letter coin (stamped over the bean, dominant element) ───────────────────
# Sized so the letter reads at the TRUE 26x26 display size (scale ~0.27x of
# this 96px canvas) — the coin must be a legible MAJORITY of the marker, not
# a small badge on the bean (specs/lettered-bunker-legend-plan.md fixup:
# 96px-source review missed illegibility at final render size). Centered near
# the canvas middle (not the C2 lobe) so the outer ring (R_FILL + RIM = 28)
# stays fully inside the 96px canvas with margin; the sand bean peeks out at
# the lower-left as the secondary "this is sand" cue — the coin is now the
# primary element by design.
COIN_C = (58.0, 40.0)
COIN_R_FILL = 24.0
COIN_RIM = 4.0  # == the bean outline's coverage(sd, 4.0)
PAPER = (0xF4, 0xF1, 0xEA)  # T.paper

# ── Procedural stroke font A-F ──────────────────────────────────────────────
# Normalized box x in [0,1] L->R, y in [0,1] top->baseline (y down). Scaled up
# with the coin (was 8.5x11 / STROKE_R 1.5 — sub-pixel at 26px final size).
GW = 13.0
GH = 17.0
STROKE_R = 3.0  # final rendered stroke >= ~1.5px at the 26px display size

LETTER_SEGMENTS = {
    "A": [((0.0, 1.0), (0.5, 0.0)), ((0.5, 0.0), (1.0, 1.0)), ((0.19, 0.62), (0.81, 0.62))],
    "B": [
        ((0.0, 0.0), (0.0, 1.0)),
        ((0.0, 0.0), (0.60, 0.0)), ((0.60, 0.0), (0.92, 0.14)), ((0.92, 0.14), (0.92, 0.34)),
        ((0.92, 0.34), (0.60, 0.48)), ((0.60, 0.48), (0.0, 0.48)),
        ((0.0, 0.48), (0.65, 0.48)), ((0.65, 0.48), (1.0, 0.62)), ((1.0, 0.62), (1.0, 0.86)),
        ((1.0, 0.86), (0.65, 1.0)), ((0.65, 1.0), (0.0, 1.0)),
    ],
    "C": [
        ((0.92, 0.06), (0.38, 0.0)), ((0.38, 0.0), (0.0, 0.32)), ((0.0, 0.32), (0.0, 0.68)),
        ((0.0, 0.68), (0.38, 1.0)), ((0.38, 1.0), (0.92, 0.94)),
    ],
    "D": [
        ((0.0, 0.0), (0.0, 1.0)),
        ((0.0, 0.0), (0.55, 0.0)), ((0.55, 0.0), (1.0, 0.33)), ((1.0, 0.33), (1.0, 0.67)),
        ((1.0, 0.67), (0.55, 1.0)), ((0.55, 1.0), (0.0, 1.0)),
    ],
    "E": [
        ((0.0, 0.0), (0.0, 1.0)), ((0.0, 0.0), (0.95, 0.0)), ((0.0, 0.5), (0.78, 0.5)),
        ((0.0, 1.0), (0.95, 1.0)),
    ],
    "F": [((0.0, 0.0), (0.0, 1.0)), ((0.0, 0.0), (0.95, 0.0)), ((0.0, 0.5), (0.78, 0.5))],
}


def coverage(d: float, r: float, feather: float = FEATHER) -> float:
    """1.0 fully inside radius/threshold r, 0.0 fully outside, linear feather at the edge."""
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


def signed_dist(px: float, py: float) -> float:
    d1 = ((px - C1[0]) ** 2 + (py - C1[1]) ** 2) ** 0.5 - R1
    d2 = ((px - C2[0]) ** 2 + (py - C2[1]) ** 2) ** 0.5 - R2
    return min(d1, d2)


def coin_dist(px: float, py: float) -> float:
    return ((px - COIN_C[0]) ** 2 + (py - COIN_C[1]) ** 2) ** 0.5 - COIN_R_FILL


def to_canvas(nx: float, ny: float):
    return (COIN_C[0] + (nx - 0.5) * GW, COIN_C[1] + (ny - 0.5) * GH)


def dist_to_segment(px: float, py: float, a, b) -> float:
    ax, ay = a
    bx, by = b
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    ab2 = abx * abx + aby * aby
    t = 0.0 if ab2 == 0 else (apx * abx + apy * aby) / ab2
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * abx, ay + t * aby
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def letter_coverage(px: float, py: float, letter: str) -> float:
    """Max (not sum) coverage over the letter's stroke segments, canvas space."""
    segments = LETTER_SEGMENTS[letter]
    best = 0.0
    for (na, nb) in segments:
        a = to_canvas(*na)
        b = to_canvas(*nb)
        d = dist_to_segment(px, py, a, b)
        cov = coverage(d, STROKE_R)
        if cov > best:
            best = cov
    return best


def render(letter=None) -> list:
    """Return a SIZE x SIZE list of (r,g,b,a) 0-255 tuples.

    `letter=None` -> plain bean with stipples (byte-identical to the original
    single-PNG render). `letter='A'..'F'` -> bean without stipples, plus an
    ink coin with a reversed-out paper letter stamped on the C2 lobe.
    """
    pixels = []
    for y in range(SIZE):
        row = []
        for x in range(SIZE):
            px = x + 0.5
            py = y + 0.5
            sd = signed_dist(px, py)

            rgb, a = (0, 0, 0), 0.0
            # Layer 1 (bottom): soft ink halo — contrast on light imagery.
            if letter is None:
                halo_cov = coverage(sd, 8.0, feather=2.5)
            else:
                sd_coin = coin_dist(px, py)
                halo_cov = coverage(min(sd, sd_coin), 8.0, feather=2.5)
            rgb, a = over(INK, halo_cov * HALO_ALPHA, rgb, a)
            # Layer 2: ink outline (~1 display px).
            outline_cov = coverage(sd, 4.0)
            rgb, a = over(INK, outline_cov, rgb, a)
            # Layer 3: sand fill.
            fill_cov = coverage(sd, 0.0)
            rgb, a = over(SAND, fill_cov, rgb, a)

            if letter is None:
                # Layer 4 (top): ink stipple dots.
                for (cx, cy) in STIPPLES:
                    dot_d = ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5
                    dot_cov = coverage(dot_d, STIPPLE_R)
                    if dot_cov > 0:
                        rgb, a = over(INK, dot_cov * STIPPLE_ALPHA, rgb, a)
            else:
                # Layer 4: solid ink coin (replaces stipples for lettered variants).
                sd_coin = coin_dist(px, py)
                coin_cov = coverage(sd_coin, COIN_RIM)
                rgb, a = over(INK, coin_cov, rgb, a)
                # Layer 5 (top): reversed-out paper letter.
                letter_cov = letter_coverage(px, py, letter)
                rgb, a = over(PAPER, letter_cov, rgb, a)

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

    pixels = render(None)
    path = os.path.join(out_dir, "bunker-marker.png")
    write_png(path, pixels)
    print(f"wrote {path}")

    for ch in "abcdef":
        pixels = render(ch.upper())
        path = os.path.join(out_dir, f"bunker-marker-{ch}.png")
        write_png(path, pixels)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
