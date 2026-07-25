"""Milestone 1: split the target image into a grid of tile-sized cells."""

import numpy as np
from PIL import Image


def load_target(path, tile_size, grid_cols=None):
    """Load the target image and cut it into tile_size x tile_size cells.

    If grid_cols is given, the image is first resized so the mosaic is
    exactly grid_cols cells wide (aspect ratio preserved). Otherwise the
    image is cropped down to the nearest multiple of tile_size.

    Returns (cells, rows, cols) where cells is a uint8 array of shape
    (rows * cols, tile_size, tile_size, 3) in row-major order.
    """
    img = Image.open(path).convert("RGB")

    if grid_cols is not None:
        scale = (grid_cols * tile_size) / img.width
        img = img.resize(
            (grid_cols * tile_size, max(tile_size, round(img.height * scale))),
            Image.LANCZOS,
        )

    cols = img.width // tile_size
    rows = img.height // tile_size
    if rows == 0 or cols == 0:
        raise ValueError(
            f"Target {img.size} is smaller than one {tile_size}px tile"
        )
    img = img.crop((0, 0, cols * tile_size, rows * tile_size))

    arr = np.asarray(img)
    # (rows*t, cols*t, 3) -> (rows, cols, t, t, 3) -> (rows*cols, t, t, 3)
    cells = (
        arr.reshape(rows, tile_size, cols, tile_size, 3)
        .transpose(0, 2, 1, 3, 4)
        .reshape(rows * cols, tile_size, tile_size, 3)
    )
    return cells, rows, cols


def render_grid_preview(cells, rows, cols, tile_size, out_path):
    """Paint each cell as a solid block of its mean color (sanity check)."""
    means = cells.reshape(len(cells), -1, 3).mean(axis=1).astype(np.uint8)
    blocks = means.reshape(rows, cols, 1, 1, 3)
    canvas = np.broadcast_to(
        blocks, (rows, cols, tile_size, tile_size, 3)
    ).transpose(0, 2, 1, 3, 4).reshape(rows * tile_size, cols * tile_size, 3)
    Image.fromarray(np.ascontiguousarray(canvas)).save(out_path)
