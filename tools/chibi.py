"""Draw a Q-version (chibi) of the supplied character, entirely in code.

The supplied illustration is a seven-head-tall mecha figure holding a sword
almost as long as she is. Two cheaper options were tried and rejected:

* **A big-head warp.** Scaling the head up and the body down distorts whatever
  crosses the split - here the sword and the hair both do, and the result reads
  as a funhouse mirror rather than as a chibi.
* **A framed portrait.** Faithful, but that is a badge, not a Q-version.

So the character is redrawn at chibi proportions - roughly two and a half heads
tall, with a head nearly half the total height - keeping the features that make
her recognisable:

* long silver-white hair with a high crown and long side strands,
* crimson eyes,
* white mecha plate over a black under-suit with cyan seams,
* a small red-glowing blade,
* the cyan holographic accents of the original artwork.

Everything is composed at 3x and downsampled, which is the only way to get clean
curves out of aliased drawing primitives.

Run `python tools/chibi.py <outdir>` to render previews.
"""

from __future__ import annotations

import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

# ---------------------------------------------------------------------------
# Palette, sampled from the supplied illustration
# ---------------------------------------------------------------------------
HAIR_LIGHT = (240, 244, 250, 255)
HAIR_MID = (206, 217, 232, 255)
HAIR_DARK = (150, 165, 188, 255)
HAIR_SHADOW = (110, 126, 152, 255)

SKIN = (252, 228, 214, 255)
SKIN_SHADE = (236, 196, 180, 255)
SKIN_LINE = (196, 140, 128, 255)

EYE_RED = (206, 58, 74, 255)
EYE_RED_DARK = (140, 28, 46, 255)
EYE_RED_LIGHT = (245, 130, 140, 255)
WHITE = (255, 255, 255, 255)
BROW = (150, 160, 178, 255)

PLATE = (243, 246, 251, 255)
PLATE_SHADE = (198, 210, 226, 255)
PLATE_EDGE = (150, 166, 188, 255)
SUIT = (44, 50, 60, 255)
SUIT_DARK = (28, 33, 41, 255)
GOLD = (216, 182, 116, 255)
CYAN = (86, 210, 255, 255)
CYAN_DEEP = (36, 140, 200, 255)
RED = (255, 77, 94, 255)
RED_DEEP = (188, 34, 52, 255)
BLUSH = (255, 150, 164, 255)
OUTLINE = (58, 66, 82, 255)

SCALE = 3

# Where the face sits, as a normalised square (cx, cy, half-size). The generic
# "top of the bounding box" heuristic cannot be used here: the blade reaches
# higher than the head, so an avatar cropped that way lands on the sword. The
# generator knows exactly where the face is, so it says so.
FACE_BOX = (0.500, 0.348, 0.252)


def bezier(p0, p1, p2, steps=24):
    """Points along a quadratic curve, for shapes that must not look faceted."""
    points = []
    for index in range(steps + 1):
        t = index / steps
        u = 1 - t
        points.append((
            u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
            u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
        ))
    return points


def superellipse(cx, cy, rx, ry, power=2.6, steps=96):
    """A slightly boxy ellipse; rounder shapes read as softer at small sizes."""
    points = []
    for index in range(steps):
        angle = 2 * math.pi * index / steps
        cos, sin = math.cos(angle), math.sin(angle)
        x = math.copysign(abs(cos) ** (2 / power), cos) * rx
        y = math.copysign(abs(sin) ** (2 / power), sin) * ry
        points.append((cx + x, cy + y))
    return points


class Canvas:
    """A 3x working surface with helpers that take 0..1 coordinates."""

    def __init__(self, size: int):
        self.size = size
        self.px = size * SCALE
        self.image = Image.new("RGBA", (self.px, self.px), (0, 0, 0, 0))
        self.draw = ImageDraw.Draw(self.image)

    def p(self, x, y):
        return (x * self.px, y * self.px)

    def length(self, value):
        return value * self.px

    def ellipse(self, cx, cy, rx, ry, fill, power=2.6):
        self.draw.polygon(superellipse(
            cx * self.px, cy * self.px, rx * self.px, ry * self.px, power), fill=fill)

    def circle(self, cx, cy, r, fill):
        self.draw.ellipse(
            [(cx - r) * self.px, (cy - r) * self.px, (cx + r) * self.px, (cy + r) * self.px], fill=fill)

    def polygon(self, points, fill):
        self.draw.polygon([self.p(x, y) for x, y in points], fill=fill)

    def line(self, points, fill, width):
        self.draw.line([self.p(x, y) for x, y in points], fill=fill, width=int(width * self.px), joint="curve")

    def arc(self, cx, cy, rx, ry, start, end, fill, width):
        self.draw.arc(
            [(cx - rx) * self.px, (cy - ry) * self.px, (cx + rx) * self.px, (cy + ry) * self.px],
            start, end, fill=fill, width=int(width * self.px))

    def paste(self, other, offset=(0, 0), mask=None):
        self.image.alpha_composite(other.image)

    def blur(self, radius):
        self.image = self.image.filter(ImageFilter.GaussianBlur(radius * self.px))
        self.draw = ImageDraw.Draw(self.image)
        return self


# ---------------------------------------------------------------------------
# Body parts
# ---------------------------------------------------------------------------
def draw_hair_back(c: Canvas):
    """The mass behind everything, so the silhouette reads as long hair."""
    # Skull-hugging crown, slightly wider than the face
    c.ellipse(0.50, 0.300, 0.243, 0.235, HAIR_MID, power=2.2)

    # Long falls either side, reaching past the hips as in the original
    left = bezier((0.288, 0.250), (0.140, 0.480), (0.196, 0.815))
    c.polygon(left + [(0.300, 0.880), (0.386, 0.812), (0.404, 0.520), (0.420, 0.300)], HAIR_MID)
    right = bezier((0.712, 0.250), (0.860, 0.470), (0.804, 0.815))
    c.polygon(right + [(0.700, 0.880), (0.614, 0.812), (0.596, 0.520), (0.580, 0.300)], HAIR_MID)

    # Shading inside each fall rather than separate strands: detached shapes
    # read as wings beside the body instead of as one head of hair.
    c.polygon([(0.286, 0.330), (0.208, 0.520), (0.232, 0.780), (0.306, 0.700), (0.318, 0.430)], HAIR_DARK)
    c.polygon([(0.714, 0.330), (0.792, 0.520), (0.768, 0.780), (0.694, 0.700), (0.682, 0.430)], HAIR_DARK)

    # Depth: a darker band inside the crown so the head is not a flat disc
    c.ellipse(0.50, 0.330, 0.215, 0.200, HAIR_DARK, power=2.2)
    c.ellipse(0.50, 0.312, 0.212, 0.196, HAIR_MID, power=2.2)


def draw_body(c: Canvas):
    """Tiny legs and torso, so the head dominates the silhouette."""
    # Legs
    for cx in (0.443, 0.557):
        c.ellipse(cx, 0.812, 0.050, 0.082, SUIT, power=2.4)
        c.ellipse(cx, 0.856, 0.056, 0.052, SUIT_DARK, power=2.4)
        c.ellipse(cx, 0.884, 0.060, 0.050, PLATE, power=2.4)
        c.ellipse(cx, 0.888, 0.026, 0.020, CYAN_DEEP, power=2.4)

    # Hip plates, kept in the plate colour so they read as part of the skirt
    c.polygon([(0.372, 0.688), (0.628, 0.688), (0.664, 0.792), (0.336, 0.792)], PLATE)
    c.polygon([(0.392, 0.700), (0.608, 0.700), (0.618, 0.734), (0.382, 0.734)], PLATE_SHADE)
    c.polygon([(0.348, 0.756), (0.404, 0.756), (0.392, 0.822), (0.336, 0.812)], PLATE)
    c.polygon([(0.596, 0.756), (0.652, 0.756), (0.664, 0.812), (0.608, 0.822)], PLATE)
    c.line([(0.404, 0.756), (0.392, 0.822)], PLATE_EDGE, 0.007)
    c.line([(0.596, 0.756), (0.608, 0.822)], PLATE_EDGE, 0.007)

    # Waist: dark under-suit with a gold belt
    c.ellipse(0.50, 0.676, 0.112, 0.052, SUIT, power=2.4)
    c.ellipse(0.50, 0.664, 0.115, 0.022, GOLD, power=2.4)

    # Cuirass
    c.ellipse(0.50, 0.618, 0.128, 0.072, PLATE, power=2.4)
    c.ellipse(0.50, 0.640, 0.122, 0.040, PLATE_SHADE, power=2.4)
    c.line([(0.50, 0.556), (0.50, 0.676)], CYAN, 0.007)
    c.line([(0.398, 0.600), (0.602, 0.600)], PLATE_EDGE, 0.009)

    # Pauldrons, sitting on the shoulders rather than beside them
    for cx, mirror in ((0.360, -1), (0.640, 1)):
        c.ellipse(cx, 0.588, 0.086, 0.070, PLATE, power=2.4)
        c.ellipse(cx, 0.572, 0.058, 0.028, PLATE_SHADE, power=2.4)
        c.ellipse(cx + mirror * 0.012, 0.604, 0.024, 0.024, RED, power=2.2)
        c.ellipse(cx + mirror * 0.012, 0.604, 0.010, 0.010, (255, 205, 212, 255), power=2.2)


def draw_arms(c: Canvas):
    """One arm raised to the hilt overhead, one hanging at her side."""
    # Raised arm (viewer left), reaching up past the jaw to the grip
    c.polygon([(0.352, 0.592), (0.286, 0.500), (0.248, 0.390), (0.296, 0.366), (0.334, 0.474), (0.402, 0.572)], SUIT)
    c.ellipse(0.272, 0.348, 0.050, 0.046, PLATE, power=2.4)
    # Resting arm
    c.polygon([(0.664, 0.596), (0.712, 0.664), (0.730, 0.734), (0.680, 0.744), (0.648, 0.678), (0.612, 0.620)], SUIT)
    c.ellipse(0.706, 0.752, 0.050, 0.042, PLATE, power=2.4)


def draw_sword(c: Canvas):
    """A short red-glowing blade held overhead.

    Drawn last and above the face on purpose: an earlier version ran it behind
    the hair, where it survived only as a thin pink sliver. Held high it clears
    every feature and reads instantly, which is the whole reason the character
    is recognisable at pet size.
    """
    hand = (0.272, 0.352)
    pommel = (0.244, 0.268)
    c.line([hand, pommel], SUIT_DARK, 0.036)
    for t in (0.3, 0.62):
        px = hand[0] + (pommel[0] - hand[0]) * t
        py = hand[1] + (pommel[1] - hand[1]) * t
        c.circle(px, py, 0.012, GOLD)
    c.line([(0.234, 0.282), (0.282, 0.310)], GOLD, 0.030)

    guard = (0.262, 0.328)
    tip = (0.876, 0.058)
    axis = (tip[0] - guard[0], tip[1] - guard[1])
    length = math.hypot(*axis)
    perp = (-axis[1] / length, axis[0] / length)
    half = 0.024

    a = (guard[0] + perp[0] * half, guard[1] + perp[1] * half)
    b = (guard[0] - perp[0] * half, guard[1] - perp[1] * half)
    c.polygon([a, tip, b], PLATE)
    # The blade's red core, inset from the edge
    a2 = (guard[0] + perp[0] * half * 0.55, guard[1] + perp[1] * half * 0.55)
    b2 = (guard[0] - perp[0] * half * 0.55, guard[1] - perp[1] * half * 0.55)
    c.polygon([a2, (tip[0] - axis[0] * 0.02, tip[1] - axis[1] * 0.02), b2], RED_DEEP)

    glow = Canvas(c.size)
    glow.line([guard, tip], RED, 0.052)
    glow.blur(0.026)
    c.image.alpha_composite(glow.image)

    core = (guard[0] + axis[0] * 0.02, guard[1] + axis[1] * 0.02)
    end = (tip[0] - axis[0] * 0.03, tip[1] - axis[1] * 0.03)
    c.line([core, end], (255, 205, 210, 255), 0.012)
    c.circle(*guard, 0.020, GOLD)
    c.circle(*guard, 0.009, RED)


def draw_head(c: Canvas):
    """Nearly half the figure - that proportion is what makes it a chibi."""
    # Neck
    c.ellipse(0.50, 0.522, 0.058, 0.046, SKIN_SHADE, power=2.4)

    # Face
    c.ellipse(0.50, 0.352, 0.196, 0.212, SKIN, power=2.3)
    # Jaw shading, so the face is not a flat oval
    c.ellipse(0.50, 0.478, 0.140, 0.078, SKIN_SHADE, power=2.6)
    c.ellipse(0.50, 0.462, 0.126, 0.066, SKIN, power=2.6)
    # Ears
    c.ellipse(0.312, 0.372, 0.028, 0.044, SKIN, power=2.4)
    c.ellipse(0.688, 0.372, 0.028, 0.044, SKIN, power=2.4)

    # Eyes: large, crimson, with a clear sclera so they read as eyes
    for cx in (0.416, 0.584):
        c.ellipse(cx, 0.380, 0.056, 0.064, WHITE, power=2.2)
        c.ellipse(cx, 0.386, 0.046, 0.054, EYE_RED, power=2.2)
        c.ellipse(cx, 0.396, 0.040, 0.044, EYE_RED_LIGHT, power=2.2)
        c.ellipse(cx, 0.404, 0.026, 0.030, EYE_RED_DARK, power=2.2)
        c.ellipse(cx, 0.396, 0.014, 0.016, (40, 16, 24, 255), power=2.2)
        # Specular highlights, the single biggest cue for a lively eye
        c.ellipse(cx - 0.019, 0.356, 0.016, 0.017, WHITE, power=2.0)
        c.ellipse(cx + 0.020, 0.410, 0.009, 0.009, WHITE, power=2.0)
        # Upper lash, thick and dark
        c.arc(cx, 0.366, 0.058, 0.058, 175, 365, OUTLINE, 0.016)
        c.arc(cx, 0.404, 0.054, 0.052, 20, 160, SKIN_LINE, 0.006)

    # Blush
    blush = Canvas(c.size)
    blush.ellipse(0.352, 0.452, 0.048, 0.024, BLUSH, power=2.2)
    blush.ellipse(0.648, 0.452, 0.048, 0.024, BLUSH, power=2.2)
    blush.blur(0.015)
    c.image.alpha_composite(blush.image)

    # A small, contented smile
    c.arc(0.500, 0.470, 0.030, 0.026, 20, 160, SKIN_LINE, 0.010)
    c.line([(0.470, 0.470), (0.530, 0.470)], (0, 0, 0, 0), 0.001)


def draw_hair_front(c: Canvas):
    """Fringe and side locks.

    Everything here has to stop above y≈0.30: the eyes begin at 0.316, and an
    earlier version's crown ellipse reached 0.416 and buried the whole face in
    hair.
    """
    # Crown volume, hugging the skull
    c.ellipse(0.50, 0.210, 0.212, 0.086, HAIR_LIGHT, power=2.2)
    c.ellipse(0.432, 0.196, 0.136, 0.058, HAIR_LIGHT, power=2.2)
    c.ellipse(0.578, 0.200, 0.118, 0.052, HAIR_LIGHT, power=2.2)

    # Fringe: pointed locks ending just above the brows
    c.polygon([(0.302, 0.196), (0.348, 0.292), (0.392, 0.190)], HAIR_LIGHT)
    c.polygon([(0.370, 0.178), (0.442, 0.300), (0.492, 0.184)], HAIR_LIGHT)
    c.polygon([(0.492, 0.182), (0.550, 0.296), (0.606, 0.186)], HAIR_LIGHT)
    c.polygon([(0.596, 0.190), (0.646, 0.288), (0.698, 0.198)], HAIR_LIGHT)
    # Shading between the locks, so the fringe is not one flat shape
    c.polygon([(0.442, 0.300), (0.458, 0.208), (0.492, 0.286)], HAIR_MID)
    c.polygon([(0.550, 0.296), (0.534, 0.204), (0.506, 0.282)], HAIR_MID)

    # Side locks framing the cheeks, clear of the eyes
    c.polygon([(0.300, 0.204), (0.254, 0.360), (0.288, 0.596), (0.330, 0.470), (0.334, 0.268)], HAIR_LIGHT)
    c.polygon([(0.700, 0.204), (0.746, 0.360), (0.712, 0.596), (0.670, 0.470), (0.666, 0.268)], HAIR_LIGHT)
    c.polygon([(0.330, 0.470), (0.352, 0.566), (0.388, 0.522), (0.368, 0.404)], HAIR_MID)
    c.polygon([(0.670, 0.470), (0.648, 0.566), (0.612, 0.522), (0.632, 0.404)], HAIR_MID)

    # Brows sit over the fringe, as they usually do in this style
    c.arc(0.418, 0.304, 0.040, 0.020, 205, 335, BROW, 0.009)
    c.arc(0.582, 0.304, 0.040, 0.020, 205, 335, BROW, 0.009)

    # Crown ornament, echoing the armour and the original's holograms
    c.polygon([(0.472, 0.104), (0.500, 0.072), (0.528, 0.104), (0.500, 0.136)], CYAN)
    c.circle(0.500, 0.104, 0.014, WHITE)


def draw_accents(c: Canvas):
    """Small cyan holographic notes lifted from the original's background."""
    for cx, cy, r, alpha in ((0.185, 0.360, 0.030, 200), (0.826, 0.330, 0.024, 180), (0.150, 0.640, 0.020, 160)):
        layer = Canvas(c.size)
        layer.circle(cx, cy, r, CYAN)
        layer.blur(0.006)
        layer.image.putalpha(layer.image.split()[3].point(lambda v: int(v * alpha / 255)))
        c.image.alpha_composite(layer.image)


def add_outline(image: Image.Image, width: int, colour) -> Image.Image:
    """A sticker outline behind the art, which is what makes it read on any wallpaper."""
    alpha = image.split()[3]
    grown = alpha
    for _ in range(width):
        grown = grown.filter(ImageFilter.MaxFilter(3))
    ring = Image.new("RGBA", image.size, colour)
    ring.putalpha(grown)
    out = Image.new("RGBA", image.size, (0, 0, 0, 0))
    out.alpha_composite(ring)
    out.alpha_composite(image)
    return out


def add_glow(image: Image.Image, colour, radius: int, strength: float) -> Image.Image:
    """A soft halo, so a light figure stays visible on a light wallpaper."""
    halo = Image.new("RGBA", image.size, colour)
    halo.putalpha(image.split()[3].filter(ImageFilter.GaussianBlur(radius))
                  .point(lambda v: int(v * strength)))
    out = Image.new("RGBA", image.size, (0, 0, 0, 0))
    out.alpha_composite(halo)
    out.alpha_composite(image)
    return out


def add_shadow(image: Image.Image, offset: int, radius: int, strength: float) -> Image.Image:
    """A contact shadow so the character reads as standing, not floating."""
    shadow = Image.new("RGBA", image.size, (14, 22, 42, 255))
    shifted = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shifted.paste(shadow, (0, offset))
    shifted.putalpha(shifted.split()[3].point(lambda v: 0))
    shifted = Image.new("RGBA", image.size, (0, 0, 0, 0))
    layer = Image.new("L", image.size, 0)
    layer.paste(image.split()[3], (0, offset))
    shifted.putalpha(layer.filter(ImageFilter.GaussianBlur(radius)).point(lambda v: int(v * strength)))
    out = Image.new("RGBA", image.size, (0, 0, 0, 0))
    out.alpha_composite(shifted)
    out.alpha_composite(image)
    return out


def draw_chibi(size: int = 1024) -> Image.Image:
    """Compose the whole character and return it at `size`."""
    c = Canvas(size)
    draw_hair_back(c)
    draw_body(c)
    draw_arms(c)
    draw_head(c)
    draw_hair_front(c)
    # Last, so the blade clears the hair and the face completely.
    draw_sword(c)
    draw_accents(c)

    art = c.image.resize((size, size), Image.Resampling.LANCZOS)
    art = add_outline(art, max(2, size // 200), OUTLINE)
    art = add_glow(art, (120, 200, 255, 255), max(6, size // 34), 0.55)
    art = add_shadow(art, max(6, size // 26), max(8, size // 30), 0.42)
    return art


if __name__ == "__main__":
    outdir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(outdir, exist_ok=True)
    render = draw_chibi(1024)
    render.save(os.path.join(outdir, "chibi.png"))
    render.resize((256, 256), Image.Resampling.LANCZOS).save(os.path.join(outdir, "chibi-256.png"))
    print(f"wrote {os.path.join(outdir, 'chibi.png')} and chibi-256.png")
