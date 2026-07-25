"""Measure mosaic quality per feature type, so the README can cite numbers
instead of adjectives.

    python scripts/evaluate_features.py

Two metrics, both lower-is-better:

- per-pixel error: mean euclidean RGB distance between every target pixel
  and the pixel that replaced it. This is the honest measure of mosaic
  fidelity — it sees a tile's internal structure, not just its average.
- mean-colour error: the same distance computed on cell/tile averages.
  Easier on the features that only model average colour, so the gap
  between the two metrics is itself informative.

Reported alongside the number of distinct tiles used, because fidelity and
variety trade against each other — a matcher that puts the same grey tile
everywhere scores well on error and looks terrible.
"""

import argparse
from pathlib import Path

import numpy as np

from src import cluster, features, grid, matching, sources

ROOT = Path(__file__).resolve().parent.parent


def per_pixel_error(cells, tiles, choice):
    diff = cells.astype(np.float64) - tiles[choice].astype(np.float64)
    return float(np.sqrt((diff**2).sum(axis=-1)).mean())


def mean_color_error(cells, tiles, choice):
    cell_mean = cells.reshape(len(cells), -1, 3).mean(axis=1)
    tile_mean = tiles.reshape(len(tiles), -1, 3).mean(axis=1)
    return float(np.linalg.norm(cell_mean - tile_mean[choice], axis=1).mean())


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--target", default=str(ROOT / "assets/targets/demo_sunset.png"))
    p.add_argument("--sources", default=str(ROOT / "assets/sources"))
    p.add_argument("--tile-size", type=int, default=16)
    p.add_argument("--grid-cols", type=int, default=48)
    p.add_argument("--k", type=int, default=8)
    args = p.parse_args()

    cells, rows, cols = grid.load_target(args.target, args.tile_size, args.grid_cols)
    tiles, _ = sources.load_tiles(args.sources, args.tile_size)
    print(f"{rows}x{cols} grid = {len(cells)} cells, {len(tiles)} source tiles, k={args.k}\n")

    header = f"{'feature':>10} {'variety':>8} {'per-pixel':>10} {'mean-colour':>12} {'tiles used':>11}"
    print(header)
    print("-" * len(header))

    for name in sorted(features.EXTRACTORS):
        tile_feats = features.extract(tiles, name)
        cell_feats = features.extract(cells, name)
        km = cluster.cluster_tiles(tile_feats, args.k)
        for variety in (0.0, 0.25, 0.5):
            choice = matching.match_clustered(cell_feats, tile_feats, km, variety)
            print(
                f"{name:>10} {variety:>8.2f} "
                f"{per_pixel_error(cells, tiles, choice):>10.2f} "
                f"{mean_color_error(cells, tiles, choice):>12.2f} "
                f"{len(set(choice.tolist())):>11d}"
            )

    print(
        "\nVariety trades fidelity for distinct tiles by design: it handicaps\n"
        "tiles that have already been placed, so error rises as coverage does."
    )


if __name__ == "__main__":
    main()
