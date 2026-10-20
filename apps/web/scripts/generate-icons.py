"""Render app/favicon.ico (16, 32, 48) and app/apple-icon.png (180) from the
Trace mark's geometry (kept in step with components/brand/Logo.tsx).

    python3 apps/web/scripts/generate-icons.py      # needs Pillow

Each size is drawn 8x larger and downsampled, so edges are anti-aliased.
"""
from pathlib import Path

from PIL import Image, ImageDraw

INK = (0x1E, 0x22, 0x35, 255)
SPAN = (0xB9, 0xBD, 0xDB, 255)
SLOW = (0x9C, 0xA2, 0xE8, 255)
SS = 8

LARGE = [(12, 14, 22, 6, False), (20, 24, 18, 6, False), (14, 34, 27, 6, True), (24, 44, 12, 6, False)]
MEDIUM = [(12, 13, 22, 7, False), (20, 23.5, 18, 7, False), (14, 34, 27, 7, True), (24, 44.5, 12, 7, False)]
SMALL = [(10, 12, 24, 10, False), (10, 28, 44, 10, True), (22, 44, 16, 10, False)]


def render(size: int, full_bleed: bool = False) -> Image.Image:
    optical = "small" if size <= 20 else "medium" if size <= 40 else "large"
    px = size * SS
    k = px / 64
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if full_bleed:  # iOS rounds the corners itself
        d.rectangle([0, 0, px, px], fill=INK)
    elif optical == "small":
        d.rounded_rectangle([0, 0, px - 1, px - 1], radius=14 * k, fill=INK)
    else:
        d.rounded_rectangle([2 * k, 2 * k, 62 * k, 62 * k], radius=15 * k, fill=INK)

    spans = SMALL if optical == "small" else MEDIUM if optical == "medium" else LARGE
    for x, y, w, h, slow in spans:
        d.rounded_rectangle([x * k, y * k, (x + w) * k, (y + h) * k], radius=h / 2 * k, fill=SLOW if slow else SPAN)

    if optical == "medium":
        cx, cy, r = 48 * k, 37.5 * k, 5.5 * k
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=SLOW)
    elif optical == "large":
        cx, cy = 48 * k, 37 * k
        r = 5.5 * k
        d.pieslice([cx - r, cy - r, cx + r, cy + r], 90, 270, fill=SLOW)
        ring = 5 * k
        d.ellipse([cx - ring - k, cy - ring - k, cx + ring + k, cy + ring + k], outline=SLOW, width=round(2 * k))

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    app = Path(__file__).resolve().parent.parent / "app"
    # Pillow writes an ICO from its largest frame and takes the smaller,
    # hand-tuned optical sizes from append_images instead of downscaling it.
    small, medium, large = (render(s) for s in (16, 32, 48))
    large.save(app / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)], append_images=[small, medium])
    render(180, full_bleed=True).save(app / "apple-icon.png", format="PNG", optimize=True)
    print("wrote", app / "favicon.ico", "and", app / "apple-icon.png")


if __name__ == "__main__":
    main()
