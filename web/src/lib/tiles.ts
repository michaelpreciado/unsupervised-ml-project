/** Port of src/sources.py — load the source library as square thumbnails.
 *
 * Two paths in: the bundled sprite atlas (400 tiles in one request), or a
 * folder the visitor picks. Both end up as the same packed TileSet, and
 * both centre-crop to a square before resizing so tiles aren't distorted. */

import type { TileSet } from './types';

interface AtlasManifest {
  count: number;
  tileSize: number;
  cols: number;
  rows: number;
  image: string;
}

/** Read `count` tiles out of one atlas image, resampled to tileSize. */
export async function loadAtlas(tileSize: number, manifestUrl = '/tiles/atlas.json'): Promise<TileSet> {
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
  bitmap.close();

  return sliceGrid(ctx, canvas.width, manifest.cols, tileSize, manifest.count);
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

/** Load a visitor-supplied folder of images as tiles. Unreadable files are
 * skipped rather than failing the run, matching the Python loader. */
export async function loadFiles(
  files: File[],
  tileSize: number,
  maxTiles = 1200,
  onProgress?: (done: number, total: number) => void,
): Promise<TileSet> {
  const usable = files
    .filter((f) => IMAGE_TYPES.test(f.name) && !f.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, maxTiles);
  if (!usable.length) throw new Error('No images found in that folder');

  const px = tileSize * tileSize;
  const canvas = document.createElement('canvas');
  canvas.width = tileSize;
  canvas.height = tileSize;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';

  const chunks: Uint8Array[] = [];
  for (let i = 0; i < usable.length; i++) {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(usable[i]);
    } catch {
      continue; // not a decodable image — skip it
    }
    const side = Math.min(bitmap.width, bitmap.height);
    const left = (bitmap.width - side) / 2;
    const top = (bitmap.height - side) / 2;
    ctx.drawImage(bitmap, left, top, side, side, 0, 0, tileSize, tileSize);
    bitmap.close();

    const { data: rgba } = ctx.getImageData(0, 0, tileSize, tileSize);
    const tile = new Uint8Array(px * 3);
    for (let p = 0; p < px; p++) {
      tile[p * 3] = rgba[p * 4];
      tile[p * 3 + 1] = rgba[p * 4 + 1];
      tile[p * 3 + 2] = rgba[p * 4 + 2];
    }
    chunks.push(tile);
    if (onProgress && i % 25 === 0) onProgress(i + 1, usable.length);
  }

  if (!chunks.length) throw new Error('None of those files could be read as images');

  const data = new Uint8Array(chunks.length * px * 3);
  chunks.forEach((tile, i) => data.set(tile, i * px * 3));
  onProgress?.(usable.length, usable.length);
  return { data, count: chunks.length, size: tileSize };
}
