"""Milestone 2: load the batch of source images as tile-sized thumbnails."""

from pathlib import Path

import numpy as np
from PIL import Image

EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


def load_tiles(folder, tile_size):
    """Load every image in folder as a tile_size x tile_size RGB thumbnail.

    Returns (tiles, paths) where tiles is a uint8 array of shape
    (n, tile_size, tile_size, 3).
    """
    paths = sorted(
        p for p in Path(folder).iterdir()
        if p.suffix.lower() in EXTENSIONS and not p.name.startswith(".")
    )
    if not paths:
        raise ValueError(f"No images found in {folder}")
    return load_tiles_from_paths(paths, tile_size)


def load_tiles_from_paths(paths, tile_size):
    """Same as load_tiles, but from an explicit list of image paths — the
    Gradio UI hands us uploaded files rather than a folder.

    Each image is center-cropped to a square before resizing so tiles
    aren't distorted; unreadable files are skipped.
    """
    paths = [
        Path(p) for p in paths
        if Path(p).suffix.lower() in EXTENSIONS and not Path(p).name.startswith(".")
    ]
    if not paths:
        raise ValueError("No usable images given")

    tiles, kept = [], []
    for p in paths:
        try:
            img = Image.open(p).convert("RGB")
        except OSError:
            continue
        side = min(img.size)
        left = (img.width - side) // 2
        top = (img.height - side) // 2
        img = img.crop((left, top, left + side, top + side))
        img = img.resize((tile_size, tile_size), Image.LANCZOS)
        tiles.append(np.asarray(img))
        kept.append(p)
    if not tiles:
        raise ValueError("None of the given files could be read as images")
    return np.stack(tiles), kept
