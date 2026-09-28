/** Port of src/sources.py — load the source library as square thumbnails.
 *
 * Two paths in: the bundled sprite atlas (400 tiles in one request), or a
 * folder the visitor picks. Both end up as the same packed TileSet, and
 * both centre-crop to a square before resizing so tiles aren't distorted. */

import type { TileSet } from './types';

/** A higher-resolution copy of the library, kept as one sprite sheet on the
 * main thread only (it never goes to the worker). The deep-zoom viewer and
 * the hi-res export read from it, so zooming in shows real photo detail
 * instead of a 16 px tile blown up. */
export interface Lod {
  source: CanvasImageSource;
  /** Edge of one tile in the sheet, in px. */
  size: number;
  cols: number;
  count: number;
}

export interface Library {
  tiles: TileSet;
  lod: Lod | null;
}

export const LOD_SIZE = 64;
/** Decodes in flight at once. Enough to keep the decoder busy, few enough
 * that four 12-megapixel photos never sit in memory together. */
const CONCURRENCY = 4;

interface AtlasManifest {
  count: number;
  tileSize: number;
  cols: number;
  rows: number;
  image: string;
}

/** Read `count` tiles out of one atlas image, resampled to tileSize. */
export async function loadAtlas(tileSize: number, manifestUrl = '/tiles/atlas.json'): Promise<Library> {
  const manifest: AtlasManifest = await fetch(manifestUrl).then((r) => {
    if (!r.ok) throw new Error(`Could not load the tile atlas (${r.status})`);
    return r.json();
  });

  const bitmap = await createImageBitmap(
    await fetch(manifest.image).then((r) => r.blob()),
  );

  const canvas = document.createElement('canvas');
  canvas.width = manifest.cols * tileSize;
  canvas.height = manifest.rows * tileSize;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  // Keep the atlas at its native resolution as the LOD sheet: it is already
  // decoded, so the sharpest level of detail costs nothing extra.
  const lod: Lod = { source: bitmap, size: manifest.tileSize, cols: manifest.cols, count: manifest.count };
  return { tiles: sliceGrid(ctx, canvas.width, manifest.cols, tileSize, manifest.count), lod };
}

/** Slice a rows×cols grid of tileSize cells out of a canvas context. */
function sliceGrid(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  cols: number,
  tileSize: number,
  count: number,
): TileSet {
  const { data: rgba } = ctx.getImageData(0, 0, canvasWidth, ctx.canvas.height);
  const px = tileSize * tileSize;
  const out = new Uint8Array(count * px * 3);

  for (let i = 0; i < count; i++) {
    const tr = Math.floor(i / cols);
    const tc = i % cols;
    const base = i * px * 3;
    for (let y = 0; y < tileSize; y++) {
      const srcRow = ((tr * tileSize + y) * canvasWidth + tc * tileSize) * 4;
      for (let x = 0; x < tileSize; x++) {
        const s = srcRow + x * 4;
        const d = base + (y * tileSize + x) * 3;
        out[d] = rgba[s];
        out[d + 1] = rgba[s + 1];
        out[d + 2] = rgba[s + 2];
      }
    }
  }
  return { data: out, count, size: tileSize };
}

export const IMAGE_TYPES = /\.(jpe?g|png|webp|bmp|gif|avif)$/i;

interface Ingested {
  tile: Uint8Array;
}

/**
 * Decode `count` images with bounded concurrency into packed tiles plus a
 * LOD sheet. `open(i)` yields a bitmap (or throws to skip).
 *
 * Each worker loop owns its own scratch canvas, so decodes overlap without
 * sharing a context, and every bitmap is closed the moment it has been
 * sampled — peak memory is CONCURRENCY decoded images, not the whole set.
 */
async function ingest(
  count: number,
  tileSize: number,
  open: (i: number) => Promise<ImageBitmap>,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ library: Library; skipped: number }> {
  const px = tileSize * tileSize;
  const lodCols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const lodCanvas = document.createElement('canvas');
  lodCanvas.width = lodCols * LOD_SIZE;
  lodCanvas.height = Math.ceil(count / lodCols) * LOD_SIZE;
  const lodCtx = lodCanvas.getContext('2d')!;
  lodCtx.imageSmoothingQuality = 'high';

  const results: (Ingested | null)[] = new Array(count).fill(null);
  let next = 0;
  let done = 0;

  const lane = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = tileSize;
    canvas.height = tileSize;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    while (next < count) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const i = next++;
      try {
        const bitmap = await open(i);
        const side = Math.min(bitmap.width, bitmap.height);
        const left = (bitmap.width - side) / 2;
        const top = (bitmap.height - side) / 2;
        ctx.drawImage(bitmap, left, top, side, side, 0, 0, tileSize, tileSize);
        // The LOD slot is keyed by source index; gaps from skipped files are
        // squeezed out below by re-indexing.
        lodCtx.drawImage(
          bitmap, left, top, side, side,
          (i % lodCols) * LOD_SIZE, Math.floor(i / lodCols) * LOD_SIZE, LOD_SIZE, LOD_SIZE,
        );
        bitmap.close();
        const { data: rgba } = ctx.getImageData(0, 0, tileSize, tileSize);
        const tile = new Uint8Array(px * 3);
        for (let p = 0; p < px; p++) {
          tile[p * 3] = rgba[p * 4];
          tile[p * 3 + 1] = rgba[p * 4 + 1];
          tile[p * 3 + 2] = rgba[p * 4 + 2];
        }
        results[i] = { tile };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        // not a decodable image — skip it
      }
      done++;
      if (onProgress && (done % 8 === 0 || done === count)) onProgress(done, count);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, count) }, lane));

  const kept = results.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
  if (!kept.length) throw new Error('None of those files could be read as images');

  const data = new Uint8Array(kept.length * px * 3);
  kept.forEach((src, n) => data.set(results[src]!.tile, n * px * 3));

  let lod: Lod;
  if (kept.length === count) {
    lod = { source: lodCanvas, size: LOD_SIZE, cols: lodCols, count };
  } else {
    // Compact the sheet so LOD index == tile index.
    const cols = Math.max(1, Math.ceil(Math.sqrt(kept.length)));
    const packed = document.createElement('canvas');
    packed.width = cols * LOD_SIZE;
    packed.height = Math.ceil(kept.length / cols) * LOD_SIZE;
    const pctx = packed.getContext('2d')!;
    kept.forEach((src, n) => {
      pctx.drawImage(
        lodCanvas,
        (src % lodCols) * LOD_SIZE, Math.floor(src / lodCols) * LOD_SIZE, LOD_SIZE, LOD_SIZE,
        (n % cols) * LOD_SIZE, Math.floor(n / cols) * LOD_SIZE, LOD_SIZE, LOD_SIZE,
      );
    });
    lod = { source: packed, size: LOD_SIZE, cols, count: kept.length };
  }
  onProgress?.(count, count);
  return {
    library: { tiles: { data, count: kept.length, size: tileSize }, lod },
    skipped: count - kept.length,
  };
}

/** Load a visitor-supplied folder of images as tiles. Unreadable files are
 * skipped rather than failing the run, matching the Python loader. */
export async function loadFiles(
  files: File[],
  tileSize: number,
  maxTiles = 1200,
  onProgress?: (done: number, total: number) => void,
): Promise<Library & { skipped: number }> {
  const usable = files
    .filter((f) => IMAGE_TYPES.test(f.name) && !f.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, maxTiles);
  if (!usable.length) throw new Error('No images found in that folder — try a folder of JPEG, PNG or WebP photos.');
  const { library, skipped } = await ingest(usable.length, tileSize, (i) => createImageBitmap(usable[i]), onProgress);
  return { ...library, skipped };
}

/**
 * Build a library from an array of data-URL images (e.g. the batch returned
 * by the Google proxy). Cross-origin images cannot be read by the canvas,
 * which is exactly why the proxy hands us base64 data-URLs instead of
 * remote URLs.
 */
export async function loadDataUrls(
  dataUrls: string[],
  tileSize: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Library> {
  if (!dataUrls.length) throw new Error('The search returned no images.');
  const { library } = await ingest(
    dataUrls.length,
    tileSize,
    async (i) => createImageBitmap(await (await fetch(dataUrls[i])).blob()),
    onProgress,
  );
  return library;
}
