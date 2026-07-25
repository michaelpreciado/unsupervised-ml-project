/** Runs the pipeline off the main thread.
 *
 * Histogram features on a large grid are a few hundred million float ops —
 * enough to freeze the page if run inline. Pixel buffers arrive as
 * transferables, so handing work over costs nothing. */

import { runPipeline } from './lib/pipeline';
import type { PipelineParams, TileSet } from './lib/types';

export interface WorkerRequest {
  id: number;
  cells: { data: Uint8Array; count: number; size: number };
  cellMeans: Uint8Array;
  rows: number;
  cols: number;
  tiles: { data: Uint8Array; count: number; size: number };
  params: PipelineParams;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, cells, cellMeans, rows, cols, tiles, params } = event.data;
  try {
    const result = runPipeline(
      cells as TileSet,
      cellMeans,
      rows,
      cols,
      tiles as TileSet,
      params,
    );
    (self as unknown as Worker).postMessage({ id, ok: true, result }, [
      result.choice.buffer,
      result.labels.buffer,
    ]);
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
