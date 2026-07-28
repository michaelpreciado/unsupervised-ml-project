/** The whole pipeline in one call — the browser twin of src/main.py.
 *
 * grid → features → k-means → match → project → (stats). Rendering and
 * animation live in canvas.ts / animate.ts, so this stays pure computation
 * and can run inside a worker.
 *
 * Beyond producing a mosaic it produces a *record* of producing one: the
 * convergence trace, the silhouette, what the variety penalty cost, and a
 * 2-D projection of the feature space. The page is a teaching instrument,
 * and none of that is recoverable after the fact. */

import { extract } from './features';
import { kmeans, silhouette } from './kmeans';
import { matchBrute, matchClustered } from './matching';
import { pca2, project } from './projection';
import type { KScanPoint, PipelineParams, PipelineResult, Scatter, TileSet } from './types';

/** Cap on cells drawn in the feature-space plot. Past a few thousand points
 * the scatter is a solid mass and the extra transfer is wasted. */
const MAX_SCATTER_CELLS = 2500;

/** Mean RGB per image as bytes, for anything that needs to *show* a colour
 * rather than measure one. Kept separate from the feature extractor so the
 * plot looks the same whichever feature is selected. */
function meanColors(set: TileSet): Uint8Array {
  const feats = extract(set, 'mean_rgb');
  const out = new Uint8Array(set.count * 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(feats.data[i]);
  return out;
}

export function runPipeline(
  cells: TileSet,
  cellMeans: Uint8Array,
  rows: number,
  cols: number,
  tiles: TileSet,
  params: PipelineParams,
): PipelineResult {
  const t0 = performance.now();
  const tileFeats = extract(tiles, params.feature);
  const cellFeats = extract(cells, params.feature);
  const msFeatures = performance.now() - t0;

  const t1 = performance.now();
  const model = kmeans(tileFeats, params.k);
  const msKmeans = performance.now() - t1;

  const t2 = performance.now();
  const clustered = matchClustered(cellFeats, tileFeats, model, params.variety);
  const msCluster = performance.now() - t2;

  let msBrute: number | null = null;
  let distBrute = cellFeats.count * tileFeats.count;
  if (params.compare) {
    const t3 = performance.now();
    const brute = matchBrute(cellFeats, tileFeats, params.variety);
    msBrute = performance.now() - t3;
    distBrute = brute.distanceOps;
  }

  const clusterSizes = new Array(model.k).fill(0);
  for (let i = 0; i < model.labels.length; i++) clusterSizes[model.labels[i]]++;

  const quality = silhouette(tileFeats, model.labels, model.k);

  /* ------------------------------------------------------------ display */

  const tileColors = meanColors(tiles);
  const clusterColors = new Uint8Array(model.k * 3);
  const acc = new Float64Array(model.k * 3);
  for (let t = 0; t < tiles.count; t++) {
    const c = model.labels[t];
    acc[c * 3] += tileColors[t * 3];
    acc[c * 3 + 1] += tileColors[t * 3 + 1];
    acc[c * 3 + 2] += tileColors[t * 3 + 2];
  }
  for (let c = 0; c < model.k; c++) {
    const n = Math.max(1, clusterSizes[c]);
    for (let ch = 0; ch < 3; ch++) clusterColors[c * 3 + ch] = Math.round(acc[c * 3 + ch] / n);
  }

  const t4 = performance.now();
  const basis = pca2(tileFeats);
  const cellStride = Math.max(1, Math.ceil(cellFeats.count / MAX_SCATTER_CELLS));
  const sampled: number[] = [];
  for (let i = 0; i < cellFeats.count; i += cellStride) sampled.push(i);
  const thinned = new Float32Array(sampled.length * cellFeats.dims);
  sampled.forEach((i, n) => {
    thinned.set(
      cellFeats.data.subarray(i * cellFeats.dims, (i + 1) * cellFeats.dims),
      n * cellFeats.dims,
    );
  });

  const scatter: Scatter = {
    tiles: project(tileFeats.data, tileFeats.count, basis),
    centroids: project(model.centroids, model.k, basis),
    cells: project(thinned, sampled.length, basis),
    cellStride,
    explained: basis.explained,
  };
  const msProjection = performance.now() - t4;

  return {
    choice: clustered.choice,
    labels: model.labels,
    cellMeans,
    tileColors,
    clusterColors,
    cellCluster: clustered.cellCluster,
    cellDist: clustered.cellDist,
    cellNearest: clustered.cellNearest,
    cellCandidates: clustered.cellCandidates,
    scatter,
    stats: {
      rows,
      cols,
      cells: cells.count,
      tiles: tiles.count,
      k: model.k,
      clusterSizes,
      featureDims: tileFeats.dims,
      uniqueTiles: new Set(clustered.choice).size,
      msFeatures,
      msKmeans,
      msCluster,
      msProjection,
      msBrute,
      distClustered: clustered.distanceOps,
      distBrute,
      trace: model.trace,
      restarts: model.restarts,
      inertia: model.inertia,
      silhouette: quality.score,
      silhouetteSampled: quality.sampled,
      penalty: clustered.penalty,
      displaced: clustered.displaced,
      meanDist: clustered.meanDist,
      meanNearest: clustered.meanNearest,
    },
  };
}

/**
 * Refit the model across a range of k and report both selection criteria.
 *
 * Inertia falls monotonically with k — it has to, more centres can only fit
 * tighter — so on its own it can never choose a k, only show an elbow.
 * Silhouette can peak, and where it does is a real answer. Run with fewer
 * restarts than the main fit because this is a shape, not a final model.
 */
export function scanK(
  tiles: TileSet,
  feature: PipelineParams['feature'],
  from: number,
  to: number,
): KScanPoint[] {
  const feats = extract(tiles, feature);
  const out: KScanPoint[] = [];
  for (let k = from; k <= to; k++) {
    if (k > feats.count) break;
    const model = kmeans(feats, k, { nInit: 3 });
    out.push({
      k,
      inertia: model.inertia,
      silhouette: silhouette(feats, model.labels, model.k, 400).score,
    });
  }
  return out;
}
