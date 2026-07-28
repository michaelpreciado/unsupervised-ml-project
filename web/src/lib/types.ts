/** Shared shapes for the browser port of the Python pipeline.
 *
 * Images move around as flat RGB byte arrays rather than ImageData so they
 * can be transferred to the worker without a copy. A "tile set" is n images
 * of size × size pixels packed back to back. */

import type { KMeansStep } from './kmeans';

export interface TileSet {
  /** n * size * size * 3 bytes, RGB, tiles laid out one after another. */
  data: Uint8Array;
  count: number;
  size: number;
}

export type FeatureKind = 'mean_rgb' | 'histogram';

export interface PipelineParams {
  tileSize: number;
  gridCols: number;
  k: number;
  feature: FeatureKind;
  variety: number;
  /** Run the brute-force matcher too, for the timing comparison. */
  compare: boolean;
}

/** The feature space, flattened to two principal components so it can be
 * drawn. Tiles, centroids and the target's cells all share one basis. */
export interface Scatter {
  /** tiles * 2 */
  tiles: Float32Array;
  /** k * 2 */
  centroids: Float32Array;
  /** sampled cells * 2 — thinned for large grids. */
  cells: Float32Array;
  /** Every `cellStride`-th cell made it into `cells`. */
  cellStride: number;
  /** Variance share of each axis, so the plot can state its own fidelity. */
  explained: [number, number];
}

export interface PipelineStats {
  rows: number;
  cols: number;
  cells: number;
  tiles: number;
  k: number;
  clusterSizes: number[];
  featureDims: number;
  uniqueTiles: number;
  msCluster: number;
  msKmeans: number;
  msFeatures: number;
  msProjection: number;
  msBrute: number | null;
  /** Distance computations each matcher performed — the honest metric. */
  distClustered: number;
  distBrute: number;

  /* --------------------------------------------- what k-means actually did */
  /** Convergence trace of the winning restart. */
  trace: KMeansStep[];
  /** Final inertia of each restart, in run order. */
  restarts: number[];
  inertia: number;
  silhouette: number;
  silhouetteSampled: number;

  /* ------------------------------------------------- what matching cost */
  /** Distance handicap applied per prior use of a tile, in feature units. */
  penalty: number;
  /** Cells the variety penalty pushed off their nearest tile. */
  displaced: number;
  /** Mean distance to the tile each cell received. */
  meanDist: number;
  /** Mean distance to the tile each cell *would* have received with no
   * variety penalty. The gap between the two is what variety costs. */
  meanNearest: number;
}

export interface PipelineResult {
  /** For each grid cell (row-major), the index of its chosen tile. */
  choice: Int32Array;
  /** Cluster label per tile. */
  labels: Int32Array;
  /** Mean colour per cell, RGB — used for the grid preview. */
  cellMeans: Uint8Array;
  /** Mean colour per tile, RGB — used to colour the feature-space plot. */
  tileColors: Uint8Array;
  /** Mean colour per cluster, RGB — used for the cluster map view. */
  clusterColors: Uint8Array;
  /** Cluster each cell was routed into. */
  cellCluster: Int32Array;
  /** Distance from each cell to the tile it received. */
  cellDist: Float32Array;
  /** Distance from each cell to the best tile it could have received. */
  cellNearest: Float32Array;
  /** Tiles each cell was compared against. */
  cellCandidates: Int32Array;
  scatter: Scatter;
  stats: PipelineStats;
}

/** The k-selection sweep, run on demand — it refits the model once per k. */
export interface KScanPoint {
  k: number;
  inertia: number;
  silhouette: number;
}
