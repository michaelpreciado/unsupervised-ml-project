"""Pack the source-image library into a sprite atlas for the web demo.

The browser demo runs the same pipeline as src/, so it needs the same tile
library — but 400 individual PNG requests is a bad way to ship it. This
packs them into one atlas image plus a JSON manifest, and copies the demo
target alongside.

    python scripts/make_web_assets.py

Re-run whenever assets/sources changes.
"""

import json
import math
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "assets/sources"
TARGET = ROOT / "assets/targets/demo_sunset.png"
WEB_PUBLIC = ROOT / "web/public"

# Tiles are stored at this resolution and downscaled in the browser for
# smaller tile sizes. 48px covers every tile size the UI offers.
ATLAS_TILE = 48


def build_atlas(tile_size=ATLAS_TILE):
    paths = sorted(
        p for p in SOURCES.iterdir()
        if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
        and not p.name.startswith(".")
    )
    if not paths:
        raise SystemExit(
            f"No source images in {SOURCES} — run scripts/make_demo_assets.py first"
        )

    cols = math.ceil(math.sqrt(len(paths)))
    rows = math.ceil(len(paths) / cols)
    atlas = np.zeros((rows * tile_size, cols * tile_size, 3), np.uint8)

    for i, p in enumerate(paths):
        img = Image.open(p).convert("RGB")
        side = min(img.size)  # center-crop square, same as src/sources.py
        left = (img.width - side) // 2
        top = (img.height - side) // 2
        img = img.crop((left, top, left + side, top + side))
        img = img.resize((tile_size, tile_size), Image.LANCZOS)
        r, c = divmod(i, cols)
        atlas[
            r * tile_size:(r + 1) * tile_size,
            c * tile_size:(c + 1) * tile_size,
        ] = np.asarray(img)

    out_dir = WEB_PUBLIC / "tiles"
    out_dir.mkdir(parents=True, exist_ok=True)
    # WebP: the noisy synthetic tiles cost ~1.8MB as PNG, ~10x less here,
    # and a few quantization steps of color are invisible in 16px tiles.
    Image.fromarray(atlas).save(out_dir / "atlas.webp", quality=92, method=6)
    manifest = {
        "count": len(paths),
        "tileSize": tile_size,
        "cols": cols,
        "rows": rows,
        "image": "/tiles/atlas.webp",
    }
    (out_dir / "atlas.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def copy_demo_target():
    if not TARGET.exists():
        return None
    dest_dir = WEB_PUBLIC / "demo"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / TARGET.name
    shutil.copyfile(TARGET, dest)
    return dest


if __name__ == "__main__":
    m = build_atlas()
    print(f"atlas: {m['count']} tiles @ {m['tileSize']}px "
          f"({m['rows']}x{m['cols']} grid) -> web/public{m['image']}")
    dest = copy_demo_target()
    if dest:
        print(f"demo target -> {dest.relative_to(ROOT)}")
