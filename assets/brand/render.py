#!/usr/bin/env python3
"""Render the app icons and Play Store artwork from the brand SVGs.

Needs Inkscape (SVG rasterising) and Pillow (compositing). Run from anywhere:

    python3 assets/brand/render.py
"""

import re
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
ASSETS = ROOT / "assets"
STORE = ROOT / "store"

INK = "#1B1D22"
BLUE = "#3E7BD6"
BLUE_ON_DARK = "#5F95E6"
GROUND = "#F4F6FA"
WHITE = "#FFFFFF"
MUTED = "#9AA3AF"
DIM = "#6B7280"

# Android adaptive icons show the centre 66/108 of the foreground. Shrinking the
# mark to 78% keeps its outermost bar corners inside that circle.
ADAPTIVE_SCALE = 0.78

MARK_RECTS = re.findall(r"<rect[^>]*/>", (HERE / "mark.svg").read_text())
ONDARK_RECTS = re.findall(r"<rect[^>]*/>", (HERE / "mark-ondark.svg").read_text())


def mark_svg(rects, scale=1.0, background=None, corner_radius=0.0, fill=None):
    """Wrap the mark's rects in a 100x100 SVG, optionally scaled about the centre."""
    body = "".join(rects)
    if fill:
        body = re.sub(r'fill="#[0-9A-Fa-f]{6}"', f'fill="{fill}"', body)
    if scale != 1.0:
        body = f'<g transform="translate(50 50) scale({scale}) translate(-50 -50)">{body}</g>'
    ground = ""
    if background:
        ground = f'<rect width="100" height="100" rx="{corner_radius}" fill="{background}"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">{ground}{body}</svg>'


def rasterise(svg, size):
    """Render SVG text to an RGBA image of the given pixel size with Inkscape."""
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False) as src:
        src.write(svg)
    out = Path(src.name).with_suffix(".png")
    subprocess.run(
        [
            "inkscape",
            "--export-type=png",
            f"--export-filename={out}",
            f"--export-width={size}",
            f"--export-height={size}",
            src.name,
        ],
        check=True,
        capture_output=True,
    )
    image = Image.open(out).convert("RGBA")
    image.load()
    Path(src.name).unlink()
    out.unlink()
    return image


def save(image, path, opaque=False):
    if opaque:
        image = image.convert("RGB")
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)
    print(f"wrote {path.relative_to(ROOT)} ({image.width}x{image.height})")


def font(weight, size):
    face = ImageFont.truetype(str(HERE / "fonts" / "Sora[wght].ttf"), size)
    face.set_variation_by_axes([weight])
    return face


def draw_tracked(draw, x, y, runs, face, tracking):
    """Draw [(text, colour), ...] left to right with letter spacing in pixels."""
    for text, colour in runs:
        for char in text:
            draw.text((x, y), char, font=face, fill=colour)
            x += face.getlength(char) + tracking
    return x


def tracked_width(runs, face, tracking):
    text = "".join(run[0] for run in runs)
    return sum(face.getlength(c) for c in text) + tracking * (len(text) - 1)


def app_icons():
    square = mark_svg(MARK_RECTS, background=GROUND)
    save(rasterise(square, 1024), ASSETS / "icon.png", opaque=True)
    save(rasterise(square, 512), STORE / "icon-512.png", opaque=True)

    foreground = mark_svg(MARK_RECTS, scale=ADAPTIVE_SCALE)
    save(rasterise(foreground, 1024), ASSETS / "android-icon-foreground.png")

    monochrome = mark_svg(MARK_RECTS, scale=ADAPTIVE_SCALE, fill=INK)
    save(rasterise(monochrome, 1024), ASSETS / "android-icon-monochrome.png")

    save(rasterise(mark_svg(MARK_RECTS), 1024), ASSETS / "splash-icon.png")

    rounded = (HERE / "icon.svg").read_text()
    save(rasterise(rounded, 48), ASSETS / "favicon.png")


def feature_graphic():
    width, height = 1024, 500
    canvas = Image.new("RGBA", (width, height), INK)
    draw = ImageDraw.Draw(canvas)
    left = 72

    tile_x = width - 72 - 300
    tile = rasterise((HERE / "icon.svg").read_text(), 300)
    canvas.alpha_composite(tile, (tile_x, (height - 300) // 2 - 10))

    runs = [("Voice", WHITE), ("Claude", BLUE_ON_DARK)]
    size = 96
    while tracked_width(runs, font(600, size), -0.035 * size) > tile_x - left - 48:
        size -= 2
    draw_tracked(draw, left, 214 - size, runs, font(600, size), -0.035 * size)

    body = font(400, 32)
    draw.text((left, 250), "Hands-free Claude for walks.", font=body, fill=WHITE)
    draw.text((left, 296), "Long-press your earbud, ask,", font=body, fill=MUTED)
    draw.text((left, 338), "listen, keep talking.", font=body, fill=MUTED)

    note = "Bring your own Anthropic and Deepgram keys. Not affiliated with Anthropic."
    size = 22
    while font(400, size).getlength(note) > width - left - 40:
        size -= 1
    draw.text((left, 430), note, font=font(400, size), fill=DIM)

    save(canvas, STORE / "feature-graphic.png", opaque=True)


if __name__ == "__main__":
    app_icons()
    feature_graphic()
