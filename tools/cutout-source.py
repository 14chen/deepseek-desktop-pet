"""Cut the subject out of an illustration with an anime-tuned segmentation model.

Anime art is exactly where a colour-based matte fails: the subject shares its
palette with the background, hair strands are sub-pixel, and the outline is the
only real boundary. `isnet-anime` is trained for this and produces a genuinely
usable alpha, so the build uses it when it is available and falls back to the
badge composition when it is not.

The model is optional and lives outside the repository, because it is a ~180 MB
download that only matters when the source artwork changes.

Run: python tools/cutout-source.py <source> <out.png> [model]
"""

from __future__ import annotations

import os
import sys

from PIL import Image

MODEL = os.environ.get("PET_CUTOUT_MODEL", "isnet-anime")
SITE = os.environ.get("PET_SEG_SITE", r"F:\devbox\pet-tools\pysite")


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    source, out = sys.argv[1], sys.argv[2]
    model = sys.argv[3] if len(sys.argv) > 3 else MODEL

    if SITE and os.path.isdir(SITE) and SITE not in sys.path:
        sys.path.insert(0, SITE)

    try:
        from rembg import new_session, remove
    except ImportError as error:
        print(f"cutout: rembg is unavailable ({error}); the badge composition will be used instead")
        return 3

    print(f"cutout: model={model} (the first run downloads the weights)")
    session = new_session(model)

    with Image.open(source) as opened:
        original = opened.convert("RGBA")

    # `remove` handles the model's own pre/post-processing, including the
    # alpha matting that keeps hair strands soft.
    result = remove(
        original,
        session=session,
        alpha_matting=True,
        alpha_matting_foreground_threshold=250,
        alpha_matting_background_threshold=15,
        alpha_matting_erode_size=6,
    )

    bbox = result.split()[3].getbbox()
    print(f"cutout: subject bbox = {bbox}")
    if bbox:
        result = result.crop(bbox)

    result.save(out)
    covered = sum(1 for pixel in result.getdata() if pixel[3] > 128)
    total = result.width * result.height
    print(f"cutout: wrote {out} ({result.width}x{result.height}, subject covers {covered / total * 100:.1f}% of the box)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
