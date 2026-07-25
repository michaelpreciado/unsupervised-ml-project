/** The whole pipeline in one call — the browser twin of src/main.py.
 *
 * grid → features → k-means → match → (stats). Rendering and animation
 * live in canvas.ts / animate.ts, so this stays pure computation and can
 * run inside a worker. */

import { extract } from './features';
import { kmeans } from './kmeans';
import { matchBrute, matchClustered } from './matching';
import type { PipelineParams, PipelineResult, TileSet } from './types';

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

  return {
    choice: clustered.choice,
    labels: model.labels,
    cellMeans,
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
      msBrute,
      distClustered: clustered.distanceOps,
      distBrute,
    },
  };
}
