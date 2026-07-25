"""Milestone 7: render the static mosaic image."""

import numpy as np
from PIL import Image


def render_mosaic(choice, tiles, rows, cols, tile_size, out_path):
    t = tile_size
    canvas = np.zeros((rows * t, cols * t, 3), np.uint8)
    for i, tile_index in enumerate(choice):
        r, c = divmod(i, cols)
        canvas[r * t:(r + 1) * t, c * t:(c + 1) * t] = tiles[tile_index]
    Image.fromarray(canvas).save(out_path)
    return out_path
