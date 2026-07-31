#!/usr/bin/env python3
"""Regenerate the extension icons.

    python3 tools/make-icons.py

Renders a rounded tile with a checkmark at 4x and downsamples, so the 16px
icon still reads cleanly in the Chrome toolbar.
Requires Pillow: pip install pillow
"""

from pathlib import Path

from PIL import Image, ImageDraw

BG = (79, 70, 229)  # indigo
FG = (255, 255, 255)
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 8
OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icons"


def render(size: int) -> Image.Image:
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=BG)

    # Checkmark, as a fraction of the tile so it scales with every size.
    points = [(s * 0.26, s * 0.52), (s * 0.44, s * 0.70), (s * 0.76, s * 0.32)]
    draw.line(points, fill=FG, width=int(s * 0.11), joint="curve")

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon{size}.png"
        render(size).save(path)
        print(f"wrote {path.relative_to(OUT_DIR.parent.parent.parent)}")


if __name__ == "__main__":
    main()
