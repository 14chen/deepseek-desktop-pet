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

# The Q-version is drawn by a sibling module; importing it here keeps one entry
# point for `npm run build:assets`.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from chibi import draw_chibi
except ImportError:  # pragma: no cover - the module ships with the tool
    draw_chibi = None

# numpy is only needed to drop detached fragments from an ML matte. Without it,
# that step is skipped and everything else still works.
try:
    import numpy as np
except ImportError:  # pragma: no cover - optional
    np = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# `PET_ASSET_ROOT` lets the test suite build into a scratch directory instead of
# overwriting the committed artwork.
OUT_ROOT = os.path.abspath(os.environ.get("PET_ASSET_ROOT") or ROOT)
ASSETS = os.path.join(OUT_ROOT, "assets")
WEB_ASSETS = os.path.join(OUT_ROOT, "web", "assets")

# Where the source picture is looked for, in order. The parent of the project is
# included because "drop it next to the project folder" is the natural thing to
# do and costs nothing to support.
SOURCE_DIRS = [OUT_ROOT, os.path.join(OUT_ROOT, "assets"), os.path.dirname(OUT_ROOT)]
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
    """Find the supplied picture, accepting whatever extension it arrived with.

    A file named `pet-source.png.jpg` is a common accident and should just work.
    """
    for directory in SOURCE_DIRS:
        if not os.path.isdir(directory):
            continue
        names = sorted(os.listdir(directory))
        # Exact conventional names win, then any `pet-source.*` image.
        for preferred in ("pet-source.png", "pet-source.jpg", "pet-source.jpeg", "pet-source.webp"):
            if preferred in names and os.path.isfile(os.path.join(directory, preferred)):
                return os.path.join(directory, preferred)
        for name in names:
            stem, ext = os.path.splitext(name)
            if stem.startswith("pet-source") and ext.lower() in (".png", ".jpg", ".jpeg", ".webp", ".bmp"):
                return os.path.join(directory, name)
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
def corners_agree(image: Image.Image, tolerance: int = 26) -> bool:
    """Do the four corners describe one flat colour? If not, there is no sticker."""
    rgb = image.convert("RGB")
    width, height = rgb.size
    if width < 8 or height < 8:
        return False
    pixels = rgb.load()
    corners = [
        pixels[0, 0], pixels[width - 1, 0],
        pixels[0, height - 1], pixels[width - 1, height - 1],
    ]
    seed = corners[0]
    return all(sum(abs(corner[i] - seed[i]) for i in range(3)) <= tolerance * 3 for corner in corners[1:])


def strip_uniform_border(image: Image.Image, tolerance: int = 26) -> Image.Image:
    """Turn a near-uniform outer background into real transparency.

    A breadth-first flood from the border means interior pixels of the same
    colour (a white shirt, an eye highlight) are preserved; only regions
    reachable from outside are cleared.
    """
    if not corners_agree(image, tolerance):
        return image

    rgb = image.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    rgba = image.copy()
    alpha = Image.new("L", (width, height), 255)
    alpha_pixels = alpha.load()
    seed = pixels[0, 0]

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


def crop_normalised(image: Image.Image, box: tuple[float, float, float]) -> Image.Image:
    """Crop a normalised square (centre x, centre y, half-size) and re-square it."""
    cx, cy, half = box
    side = int(min(image.width, image.height) * half * 2)
    left = max(0, min(image.width - side, int(image.width * cx - side / 2)))
    top = max(0, min(image.height - side, int(image.height * cy - side / 2)))
    return square(image.crop((left, top, left + side, top + side)))


def head_crop(image: Image.Image, band_ratio: float = 0.34) -> Image.Image:
    """Crop to the head and shoulders of the subject.

    A full-body figure squeezed into a 128 px avatar is unreadable, and a tray
    icon at 16 px is worse. The head is at the top of the alpha bounding box, so
    the crop is taken from there and centred on where the subject actually is in
    that band rather than on the canvas.
    """
    alpha = image.split()[3]
    bbox = alpha.getbbox()
    if bbox is None:
        return square(image)

    left, top, right, bottom = bbox
    height = bottom - top
    width = right - left

    band_height = max(8, int(height * band_ratio))
    band = alpha.crop((left, top, right, top + band_height))

    # Alpha-weighted horizontal centre of the band, so a subject that leans or
    # holds a weapon to one side still frames their face.
    pixels = band.load()
    weight = 0
    moment = 0
    for y in range(0, band.height, 2):
        for x in range(0, band.width, 2):
            value = pixels[x, y]
            if value < 24:
                continue
            weight += value
            moment += value * x
    centre_x = int(left + (moment / weight)) if weight > 0 else left + width // 2

    side = band_height
    crop_left = max(0, min(image.width - side, centre_x - side // 2))
    crop_top = max(0, min(image.height - side, top))
    return square(image.crop((crop_left, crop_top, crop_left + side, crop_top + side)))


def circular_avatar(image: Image.Image, size: int = 128, focus_head: bool = True) -> Image.Image:
    """A round avatar for the web header.

    The subject is framed on the head rather than the whole figure: a
    full-body character inside a 128 px circle is unreadable.
    """
    framed = head_crop(image) if focus_head else square(image)
    square_art = framed.resize((size, size), Image.Resampling.LANCZOS)
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size * 4 - 1, size * 4 - 1], fill=255)
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(square_art, (0, 0), mask)
    return out


def tray_icon(image: Image.Image, size: int = 256) -> Image.Image:
    """A legible notification-area icon.

    A 16 px tray slot shows almost nothing of a full figure, so this is the head
    on an opaque rounded plate with a little margin.
    """
    framed = head_crop(image).resize((size, size), Image.Resampling.LANCZOS)
    plate = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    plate.alpha_composite(framed)
    return plate


# ---------------------------------------------------------------------------
# Illustration badge
# ---------------------------------------------------------------------------
# When the supplied picture is a full illustration rather than a sticker, there
# is nothing honest to cut out: the subject usually shares colours with its
# background, and an automatic matte produces ragged hair and half-eaten armour.
# The badge solves that by framing the character instead of extracting it, and
# takes its shape language from the artwork's own holographic rings.
#
# The palette below is sampled from the supplied illustration: silver-white
# armour, cyan hologram, and the red core of the blade.
BADGE_WHITE = (255, 255, 255)
BADGE_CYAN = (96, 214, 255)
BADGE_DEEP = (28, 122, 190)
BADGE_RED = (255, 86, 96)
BADGE_SIZE = 1024


def disc_mask(size: int, inset: int, feather: float) -> Image.Image:
    """A soft-edged disc, drawn oversized and downsampled for clean curves."""
    scale = 4
    big = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(big).ellipse(
        [inset * scale, inset * scale, (size - inset) * scale - 1, (size - inset) * scale - 1],
        fill=255,
    )
    mask = big.resize((size, size), Image.Resampling.LANCZOS)
    return mask.filter(ImageFilter.GaussianBlur(feather)) if feather > 0 else mask


def radial_ramp(size: int, inner: float, outer: float, power: float = 1.5) -> Image.Image:
    """A radial brightness ramp, evaluated small and scaled up."""
    small = 256
    ramp = Image.new("L", (small, small), 0)
    pixels = ramp.load()
    centre = (small - 1) / 2
    for y in range(small):
        for x in range(small):
            dx = (x - centre) / centre
            dy = (y - centre) / centre
            distance = min(1.0, (dx * dx + dy * dy) ** 0.5)
            pixels[x, y] = max(0, min(255, int((inner + (outer - inner) * distance ** power) * 255)))
    return ramp.resize((size, size), Image.Resampling.BICUBIC)


def gradient_ring(size: int, inset: int, width: int, top, bottom) -> Image.Image:
    """A vertical-gradient annulus."""
    scale = 2
    big = size * scale
    gradient = Image.new("RGBA", (big, big))
    draw = ImageDraw.Draw(gradient)
    for y in range(big):
        t = y / max(1, big - 1)
        draw.line([(0, y), (big, y)],
                  fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
    band = Image.new("L", (big, big), 0)
    edge = inset * scale
    ImageDraw.Draw(band).ellipse([edge, edge, big - edge - 1, big - edge - 1],
                                 outline=255, width=width * scale)
    gradient.putalpha(band)
    return gradient.resize((size, size), Image.Resampling.LANCZOS)


def offset_layer(image: Image.Image, dx: int, dy: int) -> Image.Image:
    """Offset without wrapping, leaving the vacated area transparent."""
    shifted = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shifted.paste(image, (dx, dy))
    return shifted


def auto_crop_box(image: Image.Image, side_ratio: float = 0.36, centre_ratio: float = 0.28) -> tuple[int, int, int]:
    """Pick a head-and-shoulders crop without hard-coded pixel coordinates.

    A portrait illustration puts the face in the upper third, so the framing is
    derived from the image's own proportions rather than from numbers that only
    suit one picture. The ratios were tuned by comparing candidates: at a
    desktop pet's size the face has to dominate, and a looser crop leaves the
    character too small to recognise.
    """
    width, height = image.size
    side = int(min(width, height) * side_ratio)
    cx = int(width * 0.50)
    cy = int(height * centre_ratio)
    left = max(0, min(width - side, cx - side // 2))
    top = max(0, min(height - side, cy - side // 2))
    return left, top, left + side, top + side


def build_badge(image: Image.Image, box: tuple[int, int, int] | None = None) -> Image.Image:
    """Compose the character into a luminous disc."""
    crop_box = box or auto_crop_box(image)
    crop = image.crop(crop_box).resize((BADGE_SIZE, BADGE_SIZE), Image.Resampling.LANCZOS)

    # The original is bright and low-contrast; a small display needs the face to
    # separate from the armour.
    crop = ImageEnhance.Contrast(crop).enhance(1.06)
    crop = ImageEnhance.Color(crop).enhance(1.10)
    crop = ImageEnhance.Sharpness(crop).enhance(1.12)

    inset = int(BADGE_SIZE * 0.035)
    disc = disc_mask(BADGE_SIZE, inset, BADGE_SIZE * 0.0035)

    # Darken toward the rim so the face stays the brightest thing in the badge.
    shade = radial_ramp(BADGE_SIZE, 0.0, 255.0, 1.45).point(lambda value: 255 - value)
    figure = Image.new("RGBA", (BADGE_SIZE, BADGE_SIZE), (0, 0, 0, 0))
    figure.paste(Image.composite(crop, ImageEnhance.Brightness(crop).enhance(0.70), shade), (0, 0), disc)

    canvas = Image.new("RGBA", (BADGE_SIZE, BADGE_SIZE), (0, 0, 0, 0))

    glow = Image.new("RGBA", (BADGE_SIZE, BADGE_SIZE), (0, 0, 0, 0))
    glow.paste(Image.new("RGBA", (BADGE_SIZE, BADGE_SIZE), BADGE_CYAN + (255,)), (0, 0),
               disc_mask(BADGE_SIZE, inset - int(BADGE_SIZE * 0.012), BADGE_SIZE * 0.018))
    glow = glow.filter(ImageFilter.GaussianBlur(BADGE_SIZE * 0.022))
    glow.putalpha(glow.split()[3].point(lambda value: int(value * 0.55)))
    canvas.alpha_composite(glow)

    canvas.alpha_composite(figure)

    band = max(4, int(BADGE_SIZE * 0.013))
    canvas.alpha_composite(gradient_ring(BADGE_SIZE, inset - band // 2, band, BADGE_WHITE, BADGE_CYAN))

    hairline = gradient_ring(BADGE_SIZE, inset + int(BADGE_SIZE * 0.016),
                             max(2, int(BADGE_SIZE * 0.004)), BADGE_WHITE, BADGE_DEEP)
    hairline.putalpha(hairline.split()[3].point(lambda value: int(value * 0.55)))
    canvas.alpha_composite(hairline)

    # One warm accent on the ring, echoing the blade. It is the single red note
    # in an otherwise cool palette, which is what makes the badge read as this
    # character rather than a generic frame.
    accent = Image.new("RGBA", (BADGE_SIZE, BADGE_SIZE), (0, 0, 0, 0))
    accent_draw = ImageDraw.Draw(accent)
    radius = int(BADGE_SIZE * 0.030)
    reach = (BADGE_SIZE * 0.5 - inset) * 0.72
    ax = int(BADGE_SIZE * 0.5 + reach)
    ay = int(BADGE_SIZE * 0.5 + reach)
    accent_draw.ellipse([ax - radius, ay - radius, ax + radius, ay + radius], fill=BADGE_RED + (255,))
    accent_draw.ellipse([ax - radius // 2, ay - radius // 2, ax + radius // 2, ay + radius // 2],
                        fill=(255, 232, 236, 255))
    canvas.alpha_composite(accent.filter(ImageFilter.GaussianBlur(BADGE_SIZE * 0.0018)))

    # Contact shadow so the disc reads as a floating object.
    shadow = Image.new("RGBA", (BADGE_SIZE, BADGE_SIZE), (0, 0, 0, 0))
    shadow.paste(Image.new("RGBA", (BADGE_SIZE, BADGE_SIZE), (6, 14, 30, 255)), (0, 0),
                 disc_mask(BADGE_SIZE, inset, BADGE_SIZE * 0.02))
    shadow = offset_layer(shadow.filter(ImageFilter.GaussianBlur(BADGE_SIZE * 0.03)),
                          0, int(BADGE_SIZE * 0.022))
    shadow.putalpha(shadow.split()[3].point(lambda value: int(value * 0.5)))

    out = Image.new("RGBA", (BADGE_SIZE, BADGE_SIZE), (0, 0, 0, 0))
    out.alpha_composite(shadow)
    out.alpha_composite(canvas)
    return out


def dilate(mask):
    """4-connected binary dilation, without pulling in scipy."""
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    return out


def keep_significant_components(image: Image.Image, min_fraction: float = 0.02) -> Image.Image:
    """Drop opaque islands that are not part of the subject.

    A matte reliably keeps the character but often also keeps disconnected
    fragments - floating props, background slivers, stray highlights. Labelling
    runs on a reduced copy (fast enough in pure numpy) and the resulting keep
    mask is applied at full resolution.
    """
    if np is None:
        return image
    alpha = image.split()[3]
    scale = 3
    small_w = max(1, image.width // scale)
    small_h = max(1, image.height // scale)
    small = alpha.resize((small_w, small_h), Image.Resampling.BILINEAR)
    mask = np.asarray(small) > 110

    remaining = mask.copy()
    components: list[tuple[int, np.ndarray]] = []
    # Grow each component from one seed; bounded iterations keep this cheap.
    while remaining.any():
        ys, xs = np.nonzero(remaining)
        seed = np.zeros_like(remaining)
        seed[ys[0], xs[0]] = True
        grown = seed & remaining
        for _ in range(max(small_w, small_h)):
            step = dilate(grown) & remaining
            if np.array_equal(step, grown):
                break
            grown = step
        remaining &= ~grown
        components.append((int(grown.sum()), grown))
        if len(components) > 400:
            break

    if not components:
        return image

    components.sort(key=lambda item: item[0], reverse=True)
    largest = components[0][0]
    keep = np.zeros_like(mask)
    dropped = 0
    for size, grown in components:
        if size >= largest * min_fraction:
            keep |= grown
        else:
            dropped += 1
    if dropped:
        print(f"build-assets: dropped {dropped} detached fragment(s) from the matte")

    keep_image = Image.fromarray((keep * 255).astype(np.uint8)).resize(image.size, Image.Resampling.BILINEAR)
    out = image.copy()
    out.putalpha(ImageChops.multiply(alpha, keep_image))
    return out


def try_cutout(image: Image.Image) -> Image.Image | None:
    """Attempt an ML matte of the subject, when the optional tools are present.

    `PET_CUTOUT=0` forces the badge path, which is what keeps a build
    reproducible on a machine without the model.
    """
    mode = (os.environ.get("PET_CUTOUT") or "auto").strip().lower()
    if mode in ("0", "off", "false", "never"):
        return None

    site = os.environ.get("PET_SEG_SITE", r"F:\devbox\pet-tools\pysite")
    if site and os.path.isdir(site) and site not in sys.path:
        sys.path.insert(0, site)
    try:
        from rembg import new_session, remove
    except ImportError:
        print("build-assets: no ML segmenter available; using the badge composition")
        return None

    model = os.environ.get("PET_CUTOUT_MODEL", "isnet-anime")
    try:
        print(f"build-assets: running the {model} matte (first use downloads the weights)")
        session = new_session(model)
        cut = remove(
            image,
            session=session,
            alpha_matting=True,
            alpha_matting_foreground_threshold=250,
            alpha_matting_background_threshold=15,
            alpha_matting_erode_size=6,
        )
    except Exception as error:  # noqa: BLE001 - any failure simply falls back
        print(f"build-assets: the matte failed ({type(error).__name__}: {error}); using the badge")
        return None

    alpha = cut.split()[3]
    coverage = sum(alpha.point(lambda value: 1 if value > 128 else 0).getdata()) / (cut.width * cut.height)
    print(f"build-assets: matte covers {coverage * 100:.1f}% of the frame")
    # A matte that keeps almost everything, or almost nothing, did not work.
    if coverage > 0.75 or coverage < 0.05:
        print("build-assets: the matte is not plausible; using the badge composition")
        return None

    cut = keep_significant_components(cut)
    return cut


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
def build() -> int:
    os.makedirs(ASSETS, exist_ok=True)
    os.makedirs(WEB_ASSETS, exist_ok=True)

    source = find_source()
    # `PET_ART` chooses what the pet actually looks like:
    #   chibi    - the Q-version drawn from the character's design (default when
    #              a source picture is present, which is what it is based on);
    #   source   - the supplied picture itself, cut out or framed;
    #   fallback - the drawn mascot, used when there is no source at all.
    mode = (os.environ.get("PET_ART") or ("chibi" if source else "fallback")).strip().lower()
    if source:
        print(f"build-assets: source = {source}")

    art = None
    face_box = None
    if mode == "chibi" and draw_chibi is not None:
        print("build-assets: drawing the Q-version of the character")
        art = draw_chibi(1024)
        try:
            from chibi import FACE_BOX
            face_box = FACE_BOX
        except ImportError:  # pragma: no cover - guarded with the module above
            face_box = None
        print("build-assets: chibi composed from the source palette")
    elif mode == "fallback":
        print("build-assets: no source found - generating the drawn mascot")
        art = draw_fallback(1024)
    elif source:
        with Image.open(source) as opened:
            original = opened.convert("RGBA")

        alpha_range = original.split()[3].getextrema()
        if alpha_range[0] < 255:
            # Already has transparency: it is a cut-out subject, so keep it and
            # just tidy the framing.
            print("build-assets: source already has transparency - using it as a cut-out figure")
            art = trim_alpha(enhance(original))
        elif corners_agree(original):
            # A sticker: the outer flat colour is safe to remove.
            print("build-assets: flat outer background detected - removing it")
            stripped = strip_uniform_border(original)
            if stripped.split()[3].getextrema()[0] < 255:
                print("build-assets: background removed")
                art = trim_alpha(enhance(stripped))
            else:
                print("build-assets: the outer colour is not uniform enough to remove safely")

        if art is None:
            # A full illustration. A colour-based matte cannot separate this
            # kind of artwork, so an ML matte is attempted first and the badge
            # composition is the guaranteed fallback.
            print("build-assets: treating the source as a full illustration")
            cut = try_cutout(original)
            if cut is not None:
                art = trim_alpha(enhance(cut))
                print("build-assets: using the ML cut-out figure")
            else:
                print("build-assets: framing the character in a badge (see build_badge)")
                art = build_badge(original)
                print(f"build-assets: badge crop = {auto_crop_box(original)}")
    else:
        print(f"build-assets: PET_ART={mode} needs a source picture; using the drawn mascot")
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

    # The avatar and the tray icon need the face, not the figure. The chibi
    # generator states where its face is; for a supplied picture the top of the
    # alpha bounds is a good enough guess.
    if mode == "chibi" and draw_chibi is not None and face_box is not None:
        focus = crop_normalised(master, face_box)
    else:
        focus = head_crop(master)

    avatar = os.path.join(ASSETS, "avatar.png")
    circular_avatar(focus, 128, focus_head=False).save(avatar, "PNG", optimize=True)
    outputs.append(avatar)

    ico = os.path.join(ASSETS, "pet.ico")
    focus.resize((256, 256), Image.Resampling.LANCZOS).save(ico, sizes=[(s, s) for s in ICO_SIZES])
    outputs.append(ico)

    # The web page and the in-app overlay read from web/assets.
    for name, size in (("pet.png", 512), ("pet-256.png", 256), ("pet-128.png", 128), ("avatar.png", 128)):
        target = os.path.join(WEB_ASSETS, name)
        if name == "avatar.png":
            circular_avatar(focus, size, focus_head=False).save(target, "PNG", optimize=True)
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
    print(f"build-assets: done ({used}) -> {OUT_ROOT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(build())
