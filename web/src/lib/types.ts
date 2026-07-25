/** Shared shapes for the browser port of the Python pipeline.
 *
 * Images move around as flat RGB byte arrays rather than ImageData so they
 * can be transferred to the worker without a copy. A "tile set" is n images
 * of size × size pixels packed back to back. */

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
  msBrute: number | null;
  /** Distance computations each matcher performed — the honest metric. */
  distClustered: number;
  distBrute: number;
}

export interface PipelineResult {
  /** For each grid cell (row-major), the index of its chosen tile. */
  choice: Int32Array;
  /** Cluster label per tile. */
  labels: Int32Array;
  /** Mean colour per cell, RGB — used for the grid preview. */
  cellMeans: Uint8Array;
  stats: PipelineStats;
}
