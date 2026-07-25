"""Milestone 6: assign the best source tile to every grid cell.

Two implementations of the same greedy assignment:

- match_brute: distance from every cell to every tile.
- match_clustered: nearest k-means centroid per cell, then distances only
  within that cluster (~k times less distance work). This is where the
  unsupervised step pays off.

Both share a "variety" penalty: each time a tile is used, it gets a
distance handicap on later cells, so one perfectly-average tile doesn't
carpet the whole mosaic. The penalty is scaled from the data (median
nearest-neighbor distance) so it works for any feature type.
"""

import numpy as np
from sklearn.metrics import pairwise_distances


def _greedy(dist_rows, n_tiles, variety):
    """dist_rows: per-cell (distances, tile_indices). Greedy argmin with a
    usage penalty accumulated in original (row-major) cell order."""
    mins = [d.min() for d, _ in dist_rows]
    penalty = variety * float(np.median(mins)) if variety > 0 else 0.0
    counts = np.zeros(n_tiles)
    choice = np.empty(len(dist_rows), dtype=int)
    for i, (d, idx) in enumerate(dist_rows):
        j = int(np.argmin(d + penalty * counts[idx]))
        choice[i] = idx[j]
        counts[idx[j]] += 1
    return choice


def match_brute(cell_feats, tile_feats, variety=0.5):
    dist = pairwise_distances(cell_feats, tile_feats)
    all_idx = np.arange(len(tile_feats))
    return _greedy([(row, all_idx) for row in dist], len(tile_feats), variety)


def match_clustered(cell_feats, tile_feats, kmeans, variety=0.5):
    cell_cluster = kmeans.predict(cell_feats)
    dist_rows = [None] * len(cell_feats)
    for c in np.unique(cell_cluster):
        cell_idx = np.flatnonzero(cell_cluster == c)
        tile_idx = np.flatnonzero(kmeans.labels_ == c)
        if len(tile_idx) == 0:  # empty cluster: fall back to full search
            tile_idx = np.arange(len(tile_feats))
        dist = pairwise_distances(cell_feats[cell_idx], tile_feats[tile_idx])
        for row, i in enumerate(cell_idx):
            dist_rows[i] = (dist[row], tile_idx)
    return _greedy(dist_rows, len(tile_feats), variety)
