#!/usr/bin/env python3
"""Build every desktop-pet image asset from one source picture.

Source resolution order:

1. ``<repo>/pet-source.png`` - the image the user supplies.
2. ``<repo>/assets/pet-source.png`` - the same image kept with the project.
3. Generated fallback art - a hand-drawn mascot, so the pet is never faceless.

The user's picture is genuinely *optimised* rather than merely resized:

* an opaque picture with a near-uniform border gets that border turned into
  real transparency (flood fill from the edges, so interior whites survive);
* the alpha bounding box is trimmed so the mascot fills its box instead of
  floating in padding;
* colour is gently lifted (contrast + saturation) so it survives being drawn
  small on a busy wallpaper;
* a soft contact shadow and a faint rim glow are composited underneath, which
  is what makes a sticker read as an object rather than a floating decal;
* every surface gets the size it actually asks for, including a multi-size
  ``.ico`` for the Windows notification area.

Run: ``python tools/build-assets.py``
"""

from __future__ import annotations

import os
import sys
from collections import deque

try:
    from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageOps
except ImportError:  # pragma: no cover - Pillow is a documented prerequisite
    print("build-assets: Pillow is required (pip install Pillow)", file=sys.stderr)
    raise SystemExit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# `PET_ASSET_ROOT` lets the test suite build into a scratch directory instead of
# overwriting the committed artwork.
OUT_ROOT = os.path.abspath(os.environ.get("PET_ASSET_ROOT") or ROOT)
ASSETS = os.path.join(OUT_ROOT, "assets")
WEB_ASSETS = os.path.join(OUT_ROOT, "web", "assets")

# Where the source picture is looked for, in order.
SOURCE_DIRS = [OUT_ROOT, os.path.join(OUT_ROOT, "assets")]
if OUT_ROOT != ROOT:
    SOURCE_DIRS += [ROOT, os.path.join(ROOT, "assets")]

# Rendered heights. The floating window and the web page both scale from these.
SIZES = (512, 256, 128, 64)
ICO_SIZES = (256, 128, 64, 48, 32, 16)

BRAND_DEEP = (28, 78, 216)
BRAND_MID = (74, 134, 255)
BRAND_LIGHT = (150, 200, 255)
BELLY = (226, 240, 255)
INK = (17, 24, 46)
BLUSH = (255, 138, 160)


# ---------------------------------------------------------------------------
# Source discovery
# ---------------------------------------------------------------------------
def find_source() -> str | None:
    for directory in SOURCE_DIRS:
        for name in ("pet-source.png", "pet-source.jpg", "pet-source.jpeg", "pet-source.webp"):
            candidate = os.path.join(directory, name)
            if os.path.isfile(candidate):
                return candidate
    return None


# ---------------------------------------------------------------------------
# Fallback mascot
# ---------------------------------------------------------------------------
def draw_fallback(size: int = 1024) -> Image.Image:
    """Draw a friendly whale-ish mascot entirely in code.

    Everything is composed at 4x and downsampled, which is the cheapest way to
    get clean curves out of Pillow's aliased drawing primitives.
    """
    scale = 2
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    def px(value: float) -> float:
        return value * canvas

    # --- tail fluke, drawn first so the body overlaps its root ------------
    fluke = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    fluke_draw = ImageDraw.Draw(fluke)
    # Two lobes meeting in a notch: the classic whale tail, attached at the
    # body's right edge so it reads as one creature rather than a pasted-on
    # triangle.
    fluke_draw.polygon(
        [
            (px(0.70), px(0.50)),
            (px(0.90), px(0.30)),
            (px(1.00), px(0.34)),
            (px(0.94), px(0.51)),
            (px(1.00), px(0.68)),
            (px(0.90), px(0.72)),
            (px(0.70), px(0.58)),
        ],
        fill=BRAND_MID + (255,),
    )
    fluke = fluke.filter(ImageFilter.GaussianBlur(canvas * 0.006))
    image.alpha_composite(fluke)

    # --- body: a soft superellipse ---------------------------------------
    body = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    body_draw = ImageDraw.Draw(body)
    body_draw.ellipse(
        [px(0.10), px(0.16), px(0.86), px(0.86)],
        fill=(255, 255, 255, 255),
    )
    # Round the silhouette's corners a little by blurring the mask edge.
    body_mask = body.split()[3].filter(ImageFilter.GaussianBlur(canvas * 0.012))

    gradient = Image.new("RGBA", (canvas, canvas))
    grad_draw = ImageDraw.Draw(gradient)
    top, bottom = px(0.16), px(0.86)
    for y in range(int(top), int(bottom) + 1):
        t = min(1.0, max(0.0, (y - top) / max(1.0, bottom - top)))
        # Ease the ramp so the highlight sits high like a lit sphere.
        eased = t ** 0.85
        colour = tuple(
            int(BRAND_LIGHT[i] + (BRAND_DEEP[i] - BRAND_LIGHT[i]) * eased)
            for i in range(3)
        )
        grad_draw.line([(0, y), (canvas, y)], fill=colour + (255,))

    image.paste(gradient, (0, 0), body_mask)

    # --- belly ------------------------------------------------------------
    belly = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    belly_draw = ImageDraw.Draw(belly)
    belly_draw.ellipse(
        [px(0.24), px(0.44), px(0.74), px(0.82)],
        fill=BELLY + (235,),
    )
    belly = belly.filter(ImageFilter.GaussianBlur(canvas * 0.02))
    image.alpha_composite(Image.composite(belly, Image.new("RGBA", image.size), body_mask))

    # --- pectoral fin, low on the flank so it clears the blush -----------
    fin = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    fin_draw = ImageDraw.Draw(fin)
    fin_draw.ellipse([px(0.13), px(0.60), px(0.34), px(0.74)], fill=BRAND_MID + (255,))
    fin = fin.filter(ImageFilter.GaussianBlur(canvas * 0.010))
    image.alpha_composite(fin)

    # --- antenna with a glowing bulb --------------------------------------
    draw.line(
        [(px(0.48), px(0.19)), (px(0.50), px(0.08))],
        fill=INK + (255,),
        width=int(canvas * 0.012),
    )
    glow = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse([px(0.44), px(0.02), px(0.56), px(0.14)], fill=(255, 214, 102, 255))
    glow = glow.filter(ImageFilter.GaussianBlur(canvas * 0.014))
    image.alpha_composite(glow)
    draw.ellipse([px(0.465), px(0.045), px(0.535), px(0.115)], fill=(255, 236, 179, 255))

    # --- eyes -------------------------------------------------------------
    for cx in (0.36, 0.62):
        # Sclera
        draw.ellipse(
            [px(cx - 0.075), px(0.36), px(cx + 0.075), px(0.36 + 0.15)],
            fill=(255, 255, 255, 255),
        )
        # Iris
        draw.ellipse(
            [px(cx - 0.048), px(0.395), px(cx + 0.048), px(0.395 + 0.096)],
            fill=INK + (255,),
        )
        # Catch-light, offset up-left like a real specular highlight
        draw.ellipse(
            [px(cx - 0.032), px(0.408), px(cx - 0.004), px(0.436)],
            fill=(255, 255, 255, 235),
        )
        draw.ellipse(
            [px(cx + 0.012), px(0.448), px(cx + 0.028), px(0.464)],
            fill=(255, 255, 255, 160),
        )

    # --- blush ------------------------------------------------------------
    blush = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    blush_draw = ImageDraw.Draw(blush)
    for cx in (0.26, 0.72):
        blush_draw.ellipse(
            [px(cx - 0.07), px(0.50), px(cx + 0.07), px(0.585)],
            fill=BLUSH + (170,),
        )
    blush = blush.filter(ImageFilter.GaussianBlur(canvas * 0.018))
    image.alpha_composite(blush)

    # --- mouth ------------------------------------------------------------
    draw.arc(
        [px(0.44), px(0.50), px(0.56), px(0.585)],
        start=15,
        end=165,
        fill=INK + (255,),
        width=int(canvas * 0.010),
    )

    # --- rim light on the upper-left, the classic sticker "pop" -----------
    # An arc rather than a full ellipse: a complete ring reads as a drawn
    # circle, while a top-left arc reads as a light source.
    rim = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    rim_draw = ImageDraw.Draw(rim)
    rim_draw.arc(
        [px(0.11), px(0.17), px(0.85), px(0.85)],
        start=155,
        end=310,
        fill=(255, 255, 255, 205),
        width=int(canvas * 0.016),
    )
    rim = rim.filter(ImageFilter.GaussianBlur(canvas * 0.008))
    image.alpha_composite(Image.composite(rim, Image.new("RGBA", image.size), body_mask))

    return image.resize((size, size), Image.Resampling.LANCZOS)


# ---------------------------------------------------------------------------
# Photo preparation
# ---------------------------------------------------------------------------
def strip_uniform_border(image: Image.Image, tolerance: int = 26) -> Image.Image:
    """Turn a near-uniform outer background into real transparency.

    A breadth-first flood from the border means interior pixels of the same
    colour (a white shirt, an eye highlight) are preserved; only regions
    reachable from outside are cleared.
    """
    rgb = image.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    rgba = image.copy()
    alpha = Image.new("L", (width, height), 255)
    alpha_pixels = alpha.load()

    corners = [pixels[0, 0], pixels[width - 1, 0], pixels[0, height - 1], pixels[width - 1, height - 1]]
    # Only touch the background when the corners agree it is one flat colour.
    for corner in corners[1:]:
        if sum(abs(corner[i] - corners[0][i]) for i in range(3)) > tolerance * 3:
            return image
    seed = corners[0]

    def matches(colour) -> bool:
        return sum(abs(colour[i] - seed[i]) for i in range(3)) <= tolerance * 3

    visited = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))

    while queue:
        x, y = queue.popleft()
        if x < 0 or y < 0 or x >= width or y >= height:
            continue
        index = y * width + x
        if visited[index]:
            continue
        if not matches(pixels[x, y]):
            continue
        visited[index] = 1
        alpha_pixels[x, y] = 0
        queue.append((x + 1, y))
        queue.append((x - 1, y))
        queue.append((x, y + 1))
        queue.append((x, y - 1))

    # Feather the cut so it does not look like scissors.
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.2))
    rgba.putalpha(ImageChops.multiply(rgba.split()[3], alpha))
    return rgba


def trim_alpha(image: Image.Image, padding_ratio: float = 0.04) -> Image.Image:
    """Crop to the visible pixels, then add back a small breathing margin."""
    bbox = image.split()[3].getbbox()
    if bbox is None:
        return image
    left, top, right, bottom = bbox
    side = max(right - left, bottom - top)
    pad = int(side * padding_ratio)
    left = max(0, left - pad)
    top = max(0, top - pad)
    right = min(image.width, right + pad)
    bottom = min(image.height, bottom + pad)
    return image.crop((left, top, right, bottom))


def square(image: Image.Image) -> Image.Image:
    """Center the art on a transparent square so no surface distorts it."""
    side = max(image.width, image.height)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2), image)
    return canvas


def enhance(image: Image.Image) -> Image.Image:
    """Lift contrast and saturation just enough to survive a small draw."""
    rgb = image.convert("RGBA")
    alpha = rgb.split()[3]
    boosted = ImageEnhance.Contrast(rgb.convert("RGB")).enhance(1.07)
    boosted = ImageEnhance.Color(boosted).enhance(1.12)
    boosted = ImageEnhance.Sharpness(boosted).enhance(1.15)
    boosted = boosted.convert("RGBA")
    boosted.putalpha(alpha)
    return boosted


def add_effects(image: Image.Image) -> Image.Image:
    """Composite a contact shadow and a faint rim glow under the art."""
    side = max(image.width, image.height)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2), image)

    alpha = canvas.split()[3]

    # Contact shadow: the silhouette, pushed down and blurred.
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow.putalpha(alpha.filter(ImageFilter.GaussianBlur(side * 0.035)))
    shadow = ImageChops.offset(shadow, 0, int(side * 0.03))
    shadow_layer = Image.new("RGBA", canvas.size, (8, 20, 48, 118))
    shadow_layer.putalpha(shadow.split()[3].point(lambda value: int(value * 0.55)))
    canvas.alpha_composite(shadow_layer)

    # Rim glow: a wider, dimmer, brand-coloured copy behind the art. This is
    # what keeps a dark mascot legible on a dark wallpaper.
    glow_alpha = alpha.filter(ImageFilter.GaussianBlur(side * 0.02))
    glow_layer = Image.new("RGBA", canvas.size, (120, 190, 255, 255))
    glow_layer.putalpha(glow_alpha.point(lambda value: int(value * 0.5)))
    canvas.alpha_composite(glow_layer)

    # The art itself, on top.
    canvas.alpha_composite(_reapply(canvas.size, image))
    return canvas


def _reapply(size: tuple[int, int], image: Image.Image) -> Image.Image:
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    layer.paste(image, ((size[0] - image.width) // 2, (size[1] - image.height) // 2), image)
    return layer


def circular_avatar(image: Image.Image, size: int = 128) -> Image.Image:
    """A round, padded crop for the web header."""
    square_art = square(image).resize((size, size), Image.Resampling.LANCZOS)
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size * 4 - 1, size * 4 - 1], fill=255)
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(square_art, (0, 0), mask)
    return out


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
def build() -> int:
    os.makedirs(ASSETS, exist_ok=True)
    os.makedirs(WEB_ASSETS, exist_ok=True)

    source = find_source()
    if source:
        print(f"build-assets: source = {source}")
        with Image.open(source) as opened:
            art = opened.convert("RGBA")
        # A photo or AI render usually arrives as an opaque rectangle. Detecting
        # that and cutting the flat outer background is the single biggest
        # quality win for a floating mascot.
        alpha_range = art.split()[3].getextrema()
        if alpha_range[0] == 255:
            print("build-assets: opaque image detected - attempting background removal")
            stripped = strip_uniform_border(art)
            if stripped.split()[3].getextrema()[0] < 255:
                art = stripped
                print("build-assets: flat outer background removed")
            else:
                print("build-assets: background is not a single flat colour; keeping the image as-is")
        art = trim_alpha(art)
        art = enhance(art)
    else:
        print("build-assets: no pet-source found - generating fallback mascot art")
        art = draw_fallback(1024)

    art = square(art)
    # Normalise to a single high-resolution master, then derive everything.
    master = art.resize((1024, 1024), Image.Resampling.LANCZOS)
    master = add_effects(master)

    outputs = []
    for size in SIZES:
        rendered = master.resize((size, size), Image.Resampling.LANCZOS)
        target = os.path.join(ASSETS, f"pet-{size}.png")
        rendered.save(target, "PNG", optimize=True)
        outputs.append(target)

    primary = os.path.join(ASSETS, "pet.png")
    master.resize((SIZES[0], SIZES[0]), Image.Resampling.LANCZOS).save(primary, "PNG", optimize=True)
    outputs.append(primary)

    # The floating window falls back to this when the user's art is unusable.
    fallback = os.path.join(ASSETS, "pet-fallback.png")
    draw_fallback(512).resize((512, 512), Image.Resampling.LANCZOS).save(fallback, "PNG", optimize=True)
    outputs.append(fallback)

    avatar = os.path.join(ASSETS, "avatar.png")
    circular_avatar(master, 128).save(avatar, "PNG", optimize=True)
    outputs.append(avatar)

    ico = os.path.join(ASSETS, "pet.ico")
    master.resize((256, 256), Image.Resampling.LANCZOS).save(ico, sizes=[(s, s) for s in ICO_SIZES])
    outputs.append(ico)

    # The web page and the in-app overlay read from web/assets.
    for name, size in (("pet.png", 512), ("pet-256.png", 256), ("pet-128.png", 128), ("avatar.png", 128)):
        target = os.path.join(WEB_ASSETS, name)
        if name == "avatar.png":
            circular_avatar(master, size).save(target, "PNG", optimize=True)
        else:
            master.resize((size, size), Image.Resampling.LANCZOS).save(target, "PNG", optimize=True)
        outputs.append(target)

    for path in outputs:
        # `relpath` raises when the scratch root is on another drive, which is
        # exactly what a test build does.
        try:
            shown = os.path.relpath(path, OUT_ROOT)
        except ValueError:
            shown = path
        print(f"  wrote {shown} ({os.path.getsize(path):,} bytes)")

    used = "user image" if source else "generated fallback"
    with open(os.path.join(ASSETS, "SOURCE.txt"), "w", encoding="utf-8") as handle:
        handle.write(f"Art source: {used}\n")
        if source:
            handle.write(f"From: {source}\n")
    print(f"build-assets: done ({used}) -> {OUT_ROOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(build())
