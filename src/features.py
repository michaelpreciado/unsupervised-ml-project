"""Milestone 3: turn images into feature vectors for clustering/matching.

Both source tiles and target cells are tile_size x tile_size uint8 arrays,
so the same feature function applies to both — that's what makes
"distance in feature space" meaningful for matching.

Feature progression (see PROJECT.md): mean_rgb (3 dims) is the simplest
thing that works; histogram (bins^3 dims) captures color *distribution*
so a half-red/half-blue tile stops matching a uniform purple cell.
"""

import numpy as np


def mean_rgb(images):
    """(n, t, t, 3) uint8 -> (n, 3) float: average color per image."""
    return images.reshape(len(images), -1, 3).mean(axis=1)


def color_histogram(images, bins=6):
    """(n, t, t, 3) uint8 -> (n, bins**3) float: joint RGB histogram.

    Each pixel is binned jointly across R, G and B (not per-channel), so
    the feature distinguishes "orange pixels" from "red + yellow pixels".
    Normalized to sum to 1, then scaled so euclidean distances are on a
    comparable magnitude to mean_rgb (helps the shared variety penalty).

    Bins are assigned *softly*: each pixel splits its mass between the two
    nearest bin centres per channel (trilinear, 8 corners). Hard binning
    was measurably worse than mean_rgb here — with hard edges, two nearly
    identical colours either side of a boundary share no bins at all, so
    they land as far apart as red and blue, and the matcher happily picks
    a structurally wrong tile that happens to straddle the right bin.
    Soft binning makes distance degrade smoothly with colour distance and
    cuts the demo's per-pixel error from 40.2 to 33.9 (see
    scripts/evaluate_features.py).
    """
    n = len(images)
    px = images.shape[1] * images.shape[2]
    dims = bins**3

    # Continuous bin coordinates, offset so a colour sitting exactly on a
    # bin centre gets all of its weight from that bin.
    coords = images.reshape(n, px, 3).astype(np.float64) * bins / 256.0 - 0.5
    low = np.floor(coords)
    frac = coords - low
    low = low.astype(np.int64)

    feats = np.zeros(n * dims)
    row_offset = (np.arange(n) * dims)[:, None]
    for dr in (0, 1):
        wr = frac[:, :, 0] if dr else 1.0 - frac[:, :, 0]
        ir = np.clip(low[:, :, 0] + dr, 0, bins - 1)
        for dg in (0, 1):
            wg = frac[:, :, 1] if dg else 1.0 - frac[:, :, 1]
            ig = np.clip(low[:, :, 1] + dg, 0, bins - 1)
            for db in (0, 1):
                wb = frac[:, :, 2] if db else 1.0 - frac[:, :, 2]
                ib = np.clip(low[:, :, 2] + db, 0, bins - 1)
                idx = row_offset + ir * bins * bins + ig * bins + ib
                feats += np.bincount(
                    idx.ravel(), weights=(wr * wg * wb).ravel(),
                    minlength=n * dims,
                )
    return feats.reshape(n, dims) / px * 255.0


EXTRACTORS = {"mean_rgb": mean_rgb, "histogram": color_histogram}


def extract(images, kind):
    return EXTRACTORS[kind](images)
