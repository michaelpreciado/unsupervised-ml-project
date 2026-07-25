/** Port of src/grid.py — cut the target image into tile-sized cells.
 *
 * The image is first resized so the mosaic is exactly gridCols cells wide
 * (aspect ratio preserved), then cropped down to whole tiles. Cells come
 * back in row-major order in the same packed layout as the tile library,
 * which is what lets one feature extractor serve both. */

import type { TileSet } from './types';

export interface GridResult {
  cells: TileSet;
  rows: number;
  cols: number;
}

/** Draw `source` scaled to gridCols*tileSize wide, then slice it up. */
export function gridTarget(
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  tileSize: number,
  gridCols: number,
): GridResult {
  const srcW = 'width' in source ? source.width : 0;
  const srcH = 'height' in source ? source.height : 0;
  if (!srcW || !srcH) throw new Error('Target image has no dimensions');

  const width = gridCols * tileSize;
  const height = Math.max(tileSize, Math.round((srcH * width) / srcW));

  const cols = Math.floor(width / tileSize);
  const rows = Math.floor(height / tileSize);
  if (rows === 0 || cols === 0) {
    throw new Error(`Target is smaller than one ${tileSize}px tile`);
  }

  const canvas = document.createElement('canvas');
  canvas.width = cols * tileSize;
  canvas.height = rows * tileSize;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not get a 2D context');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);

  const { data: rgba } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = tileSize * tileSize;
  const cells = new Uint8Array(rows * cols * px * 3);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellBase = (r * cols + c) * px * 3;
      for (let y = 0; y < tileSize; y++) {
        const srcRow = ((r * tileSize + y) * canvas.width + c * tileSize) * 4;
        for (let x = 0; x < tileSize; x++) {
          const s = srcRow + x * 4;
          const d = cellBase + (y * tileSize + x) * 3;
          cells[d] = rgba[s];
          cells[d + 1] = rgba[s + 1];
          cells[d + 2] = rgba[s + 2];
        }
      }
    }
  }

  return { cells: { data: cells, count: rows * cols, size: tileSize }, rows, cols };
}

/** Mean colour of every cell — the blocky sanity-check preview from
 * milestone 1, kept because it makes the matching step legible. */
export function cellMeans({ data, count, size }: TileSet): Uint8Array {
  const px = size * size;
  const out = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    const base = i * px * 3;
    for (let p = 0; p < px; p++) {
      r += data[base + p * 3];
      g += data[base + p * 3 + 1];
      b += data[base + p * 3 + 2];
    }
    out[i * 3] = r / px;
    out[i * 3 + 1] = g / px;
    out[i * 3 + 2] = b / px;
  }
  return out;
}
