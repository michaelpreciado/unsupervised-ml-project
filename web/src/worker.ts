/** Runs the pipeline off the main thread.
 *
 * Histogram features on a large grid are a few hundred million float ops —
 * enough to freeze the page if run inline. Pixel buffers arrive as
 * transferables, so handing work over costs nothing.
 *
 * Two jobs live here: a full run, and the k-selection sweep, which refits
 * the model once per k and is by far the most expensive thing the page can
 * be asked to do. Both are addressed by request id so a result can never be
 * mistaken for the answer to a newer question. */

import { runPipeline, scanK } from './lib/pipeline';
import type { PipelineParams, TileSet } from './lib/types';

interface RunRequest {
  kind: 'run';
  id: number;
  cells: TileSet;
  cellMeans: Uint8Array;
  rows: number;
  cols: number;
  tiles: TileSet;
  params: PipelineParams;
}

interface ScanRequest {
  kind: 'scan';
  id: number;
  tiles: TileSet;
  feature: PipelineParams['feature'];
  from: number;
  to: number;
}

export type WorkerRequest = RunRequest | ScanRequest;

const post = (message: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.kind === 'scan') {
      post({ id: request.id, ok: true, scan: scanK(request.tiles, request.feature, request.from, request.to) });
      return;
    }

    const result = runPipeline(
      request.cells,
      request.cellMeans,
      request.rows,
      request.cols,
      request.tiles,
      request.params,
    );
    post({ id: request.id, ok: true, result }, [
      result.choice.buffer,
      result.labels.buffer,
      result.cellCluster.buffer,
      result.cellDist.buffer,
      result.cellNearest.buffer,
      result.cellCandidates.buffer,
      result.scatter.tiles.buffer,
      result.scatter.centroids.buffer,
      result.scatter.cells.buffer,
    ]);
  } catch (error) {
    post({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
