"""Render sample bills to test the scanner against.

Run:  uv run --with pillow python tools/make_sample_bill.py
Writes sample-bills/*.png — a clean one (what a good printer produces) and a
"photo" version (slight rotation, blur, uneven lighting) to exercise the
scanner's contrast pass rather than its best case.
"""
from __future__ import annotations

import pathlib
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = [
    "/System/Library/Fonts/Supplemental/Courier New.ttf",
    "/System/Library/Fonts/Supplemental/Andale Mono.ttf",
    "/System/Library/Fonts/Menlo.ttc",
    "/Library/Fonts/Arial.ttf",
]

DHABA_LINES = [
    ("HOTEL JAMMU HIMACHAL DHABA", "center"),
    ("Cheerwa, Udaipur  |  NH-48", "center"),
    ("GSTIN : 27AAPFU0939F1ZV", "left"),
    ("TAX INVOICE   Bill No. 1174", "left"),
    ("", ""),
    ("Masala Dosa        2      240.00", "left"),
    ("Dal Fry            1      180.00", "left"),
    ("Tea                3      150.00", "left"),
    ("Rotli              4       71.90", "left"),
    ("", ""),
    ("Taxable Value            641.90", "left"),
    ("CGST @ 2.5%               16.05", "left"),
    ("SGST @ 2.5%               16.05", "left"),
    ("", ""),
    ("Grand Total              674.00", "left"),
    ("", ""),
    ("Thank you, visit again", "center"),
]

COMPOSITION_LINES = [
    ("SHREE BALAJI TRADERS", "center"),
    ("Main Road, Jaipur", "center"),
    ("GSTIN : 08AAACR5055K1Z7", "left"),
    ("BILL OF SUPPLY", "left"),
    ("Composition taxable person,", "left"),
    ("not eligible to collect tax on supplies", "left"),
    ("", ""),
    ("Cement bags      10     3400.00", "left"),
    ("", ""),
    ("CGST @ 2.5%               85.00", "left"),
    ("SGST @ 2.5%               85.00", "left"),
    ("Grand Total             3570.00", "left"),
]


def find_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONTS:
        if pathlib.Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def render(lines, width=760, margin=48, size=27, paper=(252, 250, 244)) -> Image.Image:
    font = find_font(size)
    line_h = int(size * 1.62)
    height = margin * 2 + line_h * (len(lines) + 2)
    img = Image.new("RGB", (width, height), paper)
    d = ImageDraw.Draw(img)

    # a printed border, like most Indian retail bills have
    d.rectangle([18, 18, width - 19, height - 19], outline=(120, 112, 104), width=2)

    y = margin
    for text, align in lines:
        if text:
            if align == "center":
                w = d.textlength(text, font=font)
                d.text(((width - w) / 2, y), text, font=font, fill=(30, 26, 22))
            else:
                d.text((margin, y), text, font=font, fill=(30, 26, 22))
        y += line_h
    return img


def as_photo(img: Image.Image) -> Image.Image:
    """What a phone camera in a dim dhaba actually hands you."""
    # uneven lighting: a soft dark corner
    glow = Image.new("L", img.size, 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-img.width * 0.3, -img.height * 0.2, img.width * 0.95, img.height * 0.9], fill=90)
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    img = Image.composite(Image.new("RGB", img.size, (255, 255, 255)), img, glow)

    img = img.rotate(-1.6, resample=Image.BICUBIC, expand=True, fillcolor=(200, 196, 188))
    img = img.filter(ImageFilter.GaussianBlur(0.9))
    return img


def main() -> int:
    out = pathlib.Path(__file__).resolve().parent.parent / "sample-bills"
    out.mkdir(exist_ok=True)

    clean = render(DHABA_LINES)
    clean.save(out / "dhaba-clean.png")
    as_photo(clean).save(out / "dhaba-photo.jpg", quality=72)

    comp = render(COMPOSITION_LINES)
    comp.save(out / "composition-clean.png")
    as_photo(comp).save(out / "composition-photo.jpg", quality=72)

    for p in sorted(out.iterdir()):
        print("wrote", p, p.stat().st_size, "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
