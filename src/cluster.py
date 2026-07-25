"""Milestones 4-5: k-means clustering of source tiles + cluster visualization.

This is the unsupervised ML core. K-means partitions the source tiles by
visual similarity in feature space; the matching step then uses the
centroids as a coarse index (nearest-centroid first, search only inside
that cluster) — the same idea behind IVF approximate nearest-neighbor
search.
"""

import math
from pathlib import Path

import numpy as np
from PIL import Image
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score


def cluster_tiles(features, k, seed=42):
    k = min(k, len(features))
    return KMeans(n_clusters=k, n_init=10, random_state=seed).fit(features)


def scan_k(features, k_min, k_max, seed=42):
    """Fit k-means over a range of k. Returns [(k, inertia, silhouette)].

    Inertia always decreases with k (look for the elbow); silhouette
    peaks where clusters are most separated — use both to justify k.
    """
    results = []
    for k in range(k_min, min(k_max, len(features) - 1) + 1):
        km = KMeans(n_clusters=k, n_init=10, random_state=seed).fit(features)
        sil = silhouette_score(features, km.labels_) if k >= 2 else float("nan")
        results.append((k, km.inertia_, sil))
    return results


def save_contact_sheets(tiles, labels, tile_size, out_dir, max_per_sheet=100):
    """One image per cluster showing its member tiles — proof the
    clustering did something sensible before matching depends on it."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for c in np.unique(labels):
        members = tiles[labels == c][:max_per_sheet]
        cols = math.ceil(math.sqrt(len(members)))
        rows = math.ceil(len(members) / cols)
        sheet = np.zeros((rows * tile_size, cols * tile_size, 3), np.uint8)
        for i, tile in enumerate(members):
            r, col = divmod(i, cols)
            sheet[
                r * tile_size:(r + 1) * tile_size,
                col * tile_size:(col + 1) * tile_size,
            ] = tile
        path = out_dir / f"cluster_{c:02d}.png"
        Image.fromarray(sheet).save(path)
        written.append(path)
    return written
