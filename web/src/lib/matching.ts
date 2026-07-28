/** Port of src/matching.py — assign a source tile to every grid cell.
 *
 * Two implementations of the same greedy assignment:
 *
 * - matchBrute: distance from every cell to every tile.
 * - matchClustered: nearest centroid first, then distances only inside
 *   that cluster (~k times less distance work). This is the coarse
 *   quantization idea behind IVF approximate-nearest-neighbour indexes,
 *   except the index here is the unsupervised model itself.
 *
 * Both share a variety penalty: every time a tile is used it takes a
 * distance handicap on later cells, so one perfectly-average tile can't
 * carpet the mosaic. The penalty is scaled from the data (median nearest
 * distance) so it behaves the same for any feature type. */

import { sqDist } from './features';
import type { Features } from './features';
import { predict } from './kmeans';
import type { KMeansModel } from './kmeans';

export interface MatchResult {
  choice: Int32Array;
  /** Number of cell↔tile distance computations performed. */
  distanceOps: number;
  /** Per cell: the feature distance to the tile it ended up with, before
   * the variety penalty is added. Drives the hover readout. */
  cellDist: Float32Array;
  /** Per cell: the distance to the closest tile available to it at all.
   * Distinct from `cellDist` whenever the variety penalty steered the cell
   * elsewhere, which is why the residual map uses this one — it isolates
   * "the library can't do better" from "the matcher chose otherwise". */
  cellNearest: Float32Array;
  /** Per cell: how many tiles it actually compared against. */
  cellCandidates: Int32Array;
  /** Per cell: the cluster it was routed into, or -1 for brute force. */
  cellCluster: Int32Array;
  /** Cells the variety penalty pushed off their nearest tile, and what
   * that cost in mean distance — the price of not repeating yourself. */
  displaced: number;
  meanDist: number;
  meanNearest: number;
  /** The handicap one prior use costs a tile, in feature-space units. */
  penalty: number;
}

/** Greedy argmin over per-cell candidate lists, accumulating the usage
 * penalty in row-major cell order. `candidates[i]` is null for "all tiles". */
function greedy(
  cellFeats: Features,
  tileFeats: Features,
  candidates: (Int32Array | null)[],
  variety: number,
): MatchResult {
  const n = cellFeats.count;
  const dims = cellFeats.dims;
  const allTiles = tileFeats.count;
  const choice = new Int32Array(n);
  const counts = new Float64Array(allTiles);
  const cellDist = new Float32Array(n);
  const cellCandidates = new Int32Array(n);
  let distanceOps = 0;

  // Pass 1: each cell's raw nearest distance, so the penalty can be scaled
  // from the data (median) exactly like the Python version.
  const rows: Float64Array[] = new Array(n);
  const mins = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const cand = candidates[i];
    const m = cand ? cand.length : allTiles;
    const row = new Float64Array(m);
    let min = Infinity;
    for (let j = 0; j < m; j++) {
      const t = cand ? cand[j] : j;
      const d = Math.sqrt(sqDist(cellFeats.data, i, tileFeats.data, t, dims));
      row[j] = d;
      if (d < min) min = d;
    }
    distanceOps += m;
    cellCandidates[i] = m;
    rows[i] = row;
    mins[i] = min;
  }

  const penalty = variety > 0 ? variety * median(mins) : 0;

  // Pass 2: greedy pick with the accumulated usage handicap.
  let displaced = 0;
  let distSum = 0;
  let nearestSum = 0;
  for (let i = 0; i < n; i++) {
    const cand = candidates[i];
    const row = rows[i];
    let best = 0;
    let bestScore = Infinity;
    let bestRaw = Infinity;
    for (let j = 0; j < row.length; j++) {
      const t = cand ? cand[j] : j;
      const score = row[j] + penalty * counts[t];
      if (score < bestScore) {
        bestScore = score;
        bestRaw = row[j];
        best = t;
      }
    }
    choice[i] = best;
    cellDist[i] = bestRaw;
    counts[best] += 1;
    distSum += bestRaw;
    nearestSum += mins[i];
    // A strict inequality would miss ties; the penalty only matters when it
    // actually cost the cell something.
    if (bestRaw > mins[i] + 1e-6) displaced++;
  }

  return {
    choice,
    distanceOps,
    cellDist,
    cellNearest: Float32Array.from(mins),
    cellCandidates,
    cellCluster: new Int32Array(n).fill(-1),
    displaced,
    meanDist: n ? distSum / n : 0,
    meanNearest: n ? nearestSum / n : 0,
    penalty,
  };
}

function median(values: Float64Array): number {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function matchBrute(
  cellFeats: Features,
  tileFeats: Features,
  variety = 0.5,
): MatchResult {
  const candidates = new Array<Int32Array | null>(cellFeats.count).fill(null);
  return greedy(cellFeats, tileFeats, candidates, variety);
}

export function matchClustered(
  cellFeats: Features,
  tileFeats: Features,
  model: KMeansModel,
  variety = 0.5,
): MatchResult {
  const cellCluster = predict(model, cellFeats);

  // Tile indices grouped by cluster label.
  const members: number[][] = Array.from({ length: model.k }, () => []);
  for (let t = 0; t < model.labels.length; t++) members[model.labels[t]].push(t);
  const allTiles = new Int32Array(tileFeats.count).map((_, i) => i);
  const byCluster = members.map((m) =>
    // An empty cluster falls back to a full search, same as the Python code.
    m.length ? Int32Array.from(m) : allTiles,
  );

  const candidates: (Int32Array | null)[] = new Array(cellFeats.count);
  for (let i = 0; i < cellFeats.count; i++) candidates[i] = byCluster[cellCluster[i]];

  const result = greedy(cellFeats, tileFeats, candidates, variety);
  result.cellCluster = cellCluster;
  // The centroid lookup is part of the cost — count it honestly.
  result.distanceOps += cellFeats.count * model.k;
  return result;
}
