"""Pipeline entry point.

    python -m src.main --target assets/targets/demo_sunset.png \
        --sources assets/sources --tile-size 16 --grid-cols 48 --k 8

Steps: grid the target -> load source tiles -> extract features ->
k-means cluster (+ contact sheets) -> match cells to tiles (timing
brute force vs cluster-accelerated) -> render mosaic -> animate.
"""

import argparse
import time
from pathlib import Path

from . import cluster, features, grid, matching, render, sources


def parse_args():
    p = argparse.ArgumentParser(description="Unsupervised-learning photo mosaic")
    p.add_argument("--target", required=True, help="target image path")
    p.add_argument("--sources", default="assets/sources",
                   help="folder of source images")
    p.add_argument("--tile-size", type=int, default=16)
    p.add_argument("--grid-cols", type=int, default=48,
                   help="mosaic width in tiles (target is resized to fit)")
    p.add_argument("--k", type=int, default=8, help="number of k-means clusters")
    p.add_argument("--feature", choices=sorted(features.EXTRACTORS),
                   default="mean_rgb")
    p.add_argument("--variety", type=float, default=0.5,
                   help="usage penalty; 0 = pure nearest match, higher = "
                        "more distinct tiles used")
    p.add_argument("--scan-k", metavar="MIN:MAX",
                   help="report inertia + silhouette over a k range, then exit")
    p.add_argument("--no-compare", action="store_true",
                   help="skip the brute-force timing comparison")
    p.add_argument("--animate", action="store_true",
                   help="play the Pygame fly-in animation")
    p.add_argument("--record", metavar="PATH", nargs="?",
                   const="output/mosaic.mp4",
                   help="render the animation to a watermarked video instead "
                        "of playing it (default output/mosaic.mp4)")
    p.add_argument("--no-watermark", action="store_true",
                   help="omit the Preciado Tech corner signature")
    p.add_argument("--out", default="output")
    return p.parse_args()


def main():
    args = parse_args()
    out = Path(args.out)
    out.mkdir(exist_ok=True)

    cells, rows, cols = grid.load_target(
        args.target, args.tile_size, args.grid_cols)
    grid.render_grid_preview(
        cells, rows, cols, args.tile_size, out / "grid_preview.png")
    print(f"target: {rows}x{cols} grid = {len(cells)} cells "
          f"({args.tile_size}px tiles) -> {out / 'grid_preview.png'}")

    tiles, paths = sources.load_tiles(args.sources, args.tile_size)
    print(f"sources: {len(tiles)} images from {args.sources}")

    tile_feats = features.extract(tiles, args.feature)
    cell_feats = features.extract(cells, args.feature)
    print(f"features: {args.feature} ({tile_feats.shape[1]} dims)")

    if args.scan_k:
        k_min, k_max = (int(x) for x in args.scan_k.split(":"))
        print(f"\n{'k':>3} {'inertia':>14} {'silhouette':>11}")
        for k, inertia, sil in cluster.scan_k(tile_feats, k_min, k_max):
            print(f"{k:>3} {inertia:>14.1f} {sil:>11.3f}")
        return

    km = cluster.cluster_tiles(tile_feats, args.k)
    sizes = [int((km.labels_ == c).sum()) for c in range(km.n_clusters)]
    print(f"k-means: k={km.n_clusters}, cluster sizes {sizes}")
    cluster.save_contact_sheets(
        tiles, km.labels_, args.tile_size, out / "clusters")
    print(f"cluster contact sheets -> {out / 'clusters'}/")

    t0 = time.perf_counter()
    choice = matching.match_clustered(
        cell_feats, tile_feats, km, args.variety)
    t_clustered = time.perf_counter() - t0
    print(f"matching (cluster-accelerated): {t_clustered * 1000:.1f} ms")

    if not args.no_compare:
        t0 = time.perf_counter()
        matching.match_brute(cell_feats, tile_feats, args.variety)
        t_brute = time.perf_counter() - t0
        print(f"matching (brute force):         {t_brute * 1000:.1f} ms "
              f"-> {t_brute / t_clustered:.1f}x slower")

    print(f"tiles used: {len(set(choice.tolist()))} unique of {len(tiles)}")
    mosaic_path = render.render_mosaic(
        choice, tiles, rows, cols, args.tile_size, out / "mosaic.png")
    print(f"mosaic -> {mosaic_path}")

    if args.record:
        from . import animate
        path = animate.record(choice, tiles, rows, cols, args.tile_size,
                              args.record, watermark=not args.no_watermark)
        print(f"animation -> {path}")
    elif args.animate:
        from . import animate
        animate.animate(choice, tiles, rows, cols, args.tile_size,
                        watermark=not args.no_watermark)


if __name__ == "__main__":
    main()
