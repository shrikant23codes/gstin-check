"""Render the app icons from the same geometry as icons/icon.svg.

Run:  uv run --with pillow python tools/make_icons.py
Writes icons/icon-192.png, icons/icon-512.png and icons/icon-maskable-512.png.
"""
from __future__ import annotations

import pathlib
import sys

from PIL import Image, ImageDraw

INK = (22, 19, 15)
PAPER = (250, 247, 241)
RULE = (184, 176, 166)   # INK at ~30% over PAPER
ACCENT = (224, 138, 46)

BASE = 512.0          # the SVG viewBox the geometry below is authored against
SS = 4                # supersample factor for smooth edges


def receipt_polygon(scale: float, dx: float, dy: float) -> list[tuple[float, float]]:
    """Body top-left/bottom plus a sawtooth torn bottom edge, as in the SVG path."""
    pts = [(156.0, 104.0), (356.0, 104.0), (356.0, 372.0)]
    x, i = 356.0, 0
    while x > 156.0:
        y = 388.0 if i % 2 == 0 else 372.0
        pts.append((x, y))
        x -= 10.0
        i += 1
    pts.append((156.0, 104.0))
    return [(px * scale + dx, py * scale + dy) for px, py in pts]


def draw(px: int, maskable: bool) -> Image.Image:
    s = px * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        # Full bleed, mark held inside the 80% safe zone.
        d.rectangle([0, 0, s, s], fill=INK)
        scale = (s / BASE) * 0.78
        off = (s - BASE * scale) / 2.0
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 112.0 / BASE, fill=INK)
        scale, off = s / BASE, 0.0

    d.polygon(receipt_polygon(scale, off, off), fill=PAPER)

    def box(x, y, w, h, r=8.0):
        return [x * scale + off, y * scale + off, (x + w) * scale + off, (y + h) * scale + off]

    for x, y, w, h in [(196, 160, 120, 16), (196, 204, 120, 16), (196, 248, 72, 16)]:
        d.rounded_rectangle(box(x, y, w, h), radius=8.0 * scale, fill=RULE)

    lw = int(26 * scale)
    d.line(
        [(x * scale + off, y * scale + off) for x, y in [(232, 322), (266, 356), (328, 286)]],
        fill=ACCENT, width=lw, joint="curve",
    )
    for cx, cy in [(232, 322), (328, 286), (266, 356)]:
        r = lw / 2.0
        d.ellipse([cx * scale + off - r, cy * scale + off - r,
                   cx * scale + off + r, cy * scale + off + r], fill=ACCENT)

    return img.resize((px, px), Image.LANCZOS)


def main() -> int:
    out = pathlib.Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    for size, maskable in [(192, False), (512, False), (512, True)]:
        name = "icon-maskable-512.png" if maskable else f"icon-{size}.png"
        img = draw(size, maskable)
        if maskable:
            img = img.convert("RGB")          # maskable icons must not be see-through
        path = out / name
        img.save(path)
        print("wrote", path, img.size, img.mode)
    return 0


if __name__ == "__main__":
    sys.exit(main())
