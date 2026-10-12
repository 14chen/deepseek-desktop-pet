"""Preview the character badge used when no clean cutout is available.

The supplied artwork is a full illustration whose subject is white-on-white
against the background, so a colour cutout is unreliable. The badge keeps the
character recognisable by framing the head and shoulders in a luminous disc —
and takes its shape language from the artwork itself, which is full of glowing
holographic rings and hex panels.

Run: python tools/preview-badge.py <source> <outdir> [cx cy side]
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

OUT_SIZE = 1024

# Palette lifted from the artwork: silver-white armour, cyan hologram, and the
# red core of the blade.
WHITE = (255, 255, 255)
CYAN = (96, 214, 255)
DEEP_CYAN = (28, 122, 190)
RED = (255, 86, 96)


def circle_mask(size: int, inset: int, feather: float) -> Image.Image:
    """A soft-edged disc, drawn at 4x and downsampled for clean curves."""
    scale = 4
    big = Image.new("L", (size * scale, size * scale), 0)
    draw = ImageDraw.Draw(big)
    draw.ellipse(
        [inset * scale, inset * scale, (size - inset) * scale - 1, (size - inset) * scale - 1],
        fill=255,
    )
    mask = big.resize((size, size), Image.Resampling.LANCZOS)
    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(feather))
    return mask


def radial_shade(size: int, inner: float, outer: float, power: float = 1.6) -> Image.Image:
    """A radial brightness ramp, bright in the middle and dim at the rim."""
    small = 256
    ramp = Image.new("L", (small, small), 0)
    pixels = ramp.load()
    centre = (small - 1) / 2
    for y in range(small):
        for x in range(small):
            dx = (x - centre) / centre
            dy = (y - centre) / centre
            distance = min(1.0, (dx * dx + dy * dy) ** 0.5)
            value = inner + (outer - inner) * (distance ** power)
            pixels[x, y] = max(0, min(255, int(value * 255)))
    return ramp.resize((size, size), Image.Resampling.BICUBIC)


def ring(size: int, inset: int, width: int, top: tuple, bottom: tuple) -> Image.Image:
    """A gradient annulus. The gradient is built once and masked to the band."""
    scale = 2
    big_size = size * scale
    big_inset = inset * scale
    big_width = width * scale

    gradient = Image.new("RGBA", (big_size, big_size))
    draw = ImageDraw.Draw(gradient)
    inner = big_inset
    outer = big_size - big_inset
    for y in range(big_size):
        t = y / max(1, big_size - 1)
        colour = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        draw.line([(0, y), (big_size, y)], fill=colour + (255,))

    band = Image.new("L", (big_size, big_size), 0)
    band_draw = ImageDraw.Draw(band)
    band_draw.ellipse([inner, inner, outer - 1, outer - 1], outline=255, width=big_width)
    gradient.putalpha(band)
    return gradient.resize((size, size), Image.Resampling.LANCZOS)


def build(source: str, cx: int, cy: int, side: int) -> Image.Image:
    img = Image.open(source).convert("RGB")
    w, h = img.size

    left = max(0, min(w - side, cx - side // 2))
    top = max(0, min(h - side, cy - side // 2))
    crop = img.crop((left, top, left + side, top + side)).resize(
        (OUT_SIZE, OUT_SIZE), Image.Resampling.LANCZOS)

    # Lift the character a little: the artwork is bright and low-contrast, and a
    # small display needs the face to separate from the armour.
    crop = ImageEnhance.Contrast(crop).enhance(1.06)
    crop = ImageEnhance.Color(crop).enhance(1.08)
    crop = ImageEnhance.Sharpness(crop).enhance(1.12)

    disc_inset = int(OUT_SIZE * 0.035)
    disc = circle_mask(OUT_SIZE, disc_inset, OUT_SIZE * 0.0035)

    # Darken toward the rim so the face stays the brightest thing in the badge.
    shaded = Image.composite(crop, ImageEnhance.Brightness(crop).enhance(0.72),
                             radial_shade(OUT_SIZE, 0.0, 255, 1.5).point(lambda v: 255 - v))

    figure = Image.new("RGBA", (OUT_SIZE, OUT_SIZE), (0, 0, 0, 0))
    figure.paste(shaded, (0, 0), disc)

    # Outer glow, then the ring, then a bright inner hairline.
    canvas = Image.new("RGBA", (OUT_SIZE, OUT_SIZE), (0, 0, 0, 0))

    glow = Image.new("RGBA", (OUT_SIZE, OUT_SIZE), (0, 0, 0, 0))
    glow.paste(Image.new("RGBA", (OUT_SIZE, OUT_SIZE), CYAN + (255,)), (0, 0),
               circle_mask(OUT_SIZE, disc_inset - int(OUT_SIZE * 0.012), OUT_SIZE * 0.018))
    glow = glow.filter(ImageFilter.GaussianBlur(OUT_SIZE * 0.022))
    glow.putalpha(glow.split()[3].point(lambda v: int(v * 0.55)))
    canvas.alpha_composite(glow)

    canvas.alpha_composite(figure)

    band_width = max(4, int(OUT_SIZE * 0.013))
    canvas.alpha_composite(ring(OUT_SIZE, disc_inset - band_width // 2, band_width, WHITE, CYAN))

    hairline = ring(OUT_SIZE, disc_inset + int(OUT_SIZE * 0.016), max(2, int(OUT_SIZE * 0.004)),
                    (255, 255, 255), DEEP_CYAN)
    hairline.putalpha(hairline.split()[3].point(lambda v: int(v * 0.55)))
    canvas.alpha_composite(hairline)

    # A single red accent, echoing the blade, sitting on the ring at the lower
    # right. It is the one warm note in an otherwise cool palette, which is what
    # makes the badge read as this character rather than a generic frame.
    accent = Image.new("RGBA", (OUT_SIZE, OUT_SIZE), (0, 0, 0, 0))
    accent_draw = ImageDraw.Draw(accent)
    radius = int(OUT_SIZE * 0.030)
    ax = int(OUT_SIZE * 0.5 + (OUT_SIZE * 0.5 - disc_inset) * 0.72)
    ay = int(OUT_SIZE * 0.5 + (OUT_SIZE * 0.5 - disc_inset) * 0.72)
    accent_draw.ellipse([ax - radius, ay - radius, ax + radius, ay + radius], fill=RED + (255,))
    accent_draw.ellipse([ax - radius // 2, ay - radius // 2, ax + radius // 2, ay + radius // 2],
                        fill=(255, 232, 236, 255))
    accent = accent.filter(ImageFilter.GaussianBlur(OUT_SIZE * 0.0018))
    canvas.alpha_composite(accent)

    # Contact shadow, offset down, so the disc reads as floating.
    shadow = Image.new("RGBA", (OUT_SIZE, OUT_SIZE), (0, 0, 0, 0))
    shadow.paste(Image.new("RGBA", (OUT_SIZE, OUT_SIZE), (6, 14, 30, 255)), (0, 0),
                 circle_mask(OUT_SIZE, disc_inset, OUT_SIZE * 0.02))
    shadow = shadow.filter(ImageFilter.GaussianBlur(OUT_SIZE * 0.03))
    shadow = ImageChops_offset(shadow, 0, int(OUT_SIZE * 0.022))
    shadow.putalpha(shadow.split()[3].point(lambda v: int(v * 0.5)))

    out = Image.new("RGBA", (OUT_SIZE, OUT_SIZE), (0, 0, 0, 0))
    out.alpha_composite(shadow)
    out.alpha_composite(canvas)
    return out


def ImageChops_offset(image: Image.Image, dx: int, dy: int) -> Image.Image:
    """Offset without wrapping, filling the vacated area with transparency."""
    shifted = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shifted.paste(image, (dx, dy))
    return shifted


if __name__ == "__main__":
    source, outdir = sys.argv[1], sys.argv[2]
    cx = int(sys.argv[3]) if len(sys.argv) > 3 else 530
    cy = int(sys.argv[4]) if len(sys.argv) > 4 else 300
    side = int(sys.argv[5]) if len(sys.argv) > 5 else 560
    os.makedirs(outdir, exist_ok=True)
    badge = build(source, cx, cy, side)
    badge.save(os.path.join(outdir, "badge.png"))
    badge.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(outdir, "badge-256.png"))
    print(f"wrote badge.png (1024) and badge-256.png for crop c=({cx},{cy}) side={side}")
