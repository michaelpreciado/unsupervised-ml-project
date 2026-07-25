"""Generate synthetic demo assets so the pipeline runs without real photos.

Creates a sunset target image and a batch of small gradient/noise source
images spread across the hue wheel. Swap in real photos any time —
assets/sources works with any folder of images.
"""

import colorsys
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent


def make_sources(n=400, size=64, out_dir=ROOT / "assets/sources"):
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(42)
    noise_rng = np.random.default_rng(42)
    for i in range(n):
        hue = rng.random()
        sat = 0.25 + 0.65 * rng.random()
        val = 0.20 + 0.75 * rng.random()
        base = np.array(colorsys.hsv_to_rgb(hue, sat, val)) * 255.0
        grad = np.linspace(-28, 28, size)[:, None, None]
        noise = noise_rng.normal(0, 10, (size, size, 3))
        arr = np.clip(base[None, None, :] + grad + noise, 0, 255).astype(np.uint8)
        Image.fromarray(arr).save(out_dir / f"src_{i:04d}.png")
    return n


def make_target(out_path=ROOT / "assets/targets/demo_sunset.png", w=768, h=512):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    horizon = int(h * 0.62)

    top = np.array([70, 35, 110], float)      # dusk purple
    mid = np.array([245, 140, 60], float)     # sunset orange
    sea_top = np.array([60, 70, 130], float)
    sea_bot = np.array([12, 18, 48], float)

    img = np.zeros((h, w, 3), float)
    sky_t = np.linspace(0, 1, horizon)[:, None, None]
    img[:horizon] = top + (mid - top) * sky_t
    sea_t = np.linspace(0, 1, h - horizon)[:, None, None]
    img[horizon:] = sea_top + (sea_bot - sea_top) * sea_t

    pil = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(pil)
    cx, cy, r = w // 2, horizon - 55, 62
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 235, 160))
    # sun reflection on the water
    draw.polygon(
        [(cx - 30, horizon), (cx + 30, horizon), (cx + 70, h), (cx - 70, h)],
        fill=(200, 140, 90),
    )
    pil = pil.filter(ImageFilter.GaussianBlur(3))
    pil.save(out_path)
    return out_path


if __name__ == "__main__":
    n = make_sources()
    target = make_target()
    print(f"wrote {n} source images and target {target}")
