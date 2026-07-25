/** Static rendering: the mosaic, the blocky grid preview, and the cluster
 * contact sheets (src/render.py + src/cluster.py's save_contact_sheets). */

import type { TileSet } from './types';

/** Turn the packed tile bytes into ImageBitmaps, one per tile index used,
 * so the animation can blit them cheaply. */
export async function tileBitmaps(tiles: TileSet, wanted: Iterable<number>): Promise<Map<number, ImageBitmap>> {
  const px = tiles.size * tiles.size;
  const out = new Map<number, ImageBitmap>();
  const pending: Promise<void>[] = [];

  for (const index of new Set(wanted)) {
    const rgba = new Uint8ClampedArray(px * 4);
    const base = index * px * 3;
    for (let p = 0; p < px; p++) {
      rgba[p * 4] = tiles.data[base + p * 3];
      rgba[p * 4 + 1] = tiles.data[base + p * 3 + 1];
      rgba[p * 4 + 2] = tiles.data[base + p * 3 + 2];
      rgba[p * 4 + 3] = 255;
    }
    const img = new ImageData(rgba, tiles.size, tiles.size);
    pending.push(createImageBitmap(img).then((bmp) => void out.set(index, bmp)));
  }
  await Promise.all(pending);
  return out;
}

/** Paint the finished mosaic into a canvas at native tile resolution. */
export function drawMosaic(
  canvas: HTMLCanvasElement,
  choice: Int32Array,
  tiles: TileSet,
  rows: number,
  cols: number,
): void {
  const t = tiles.size;
  canvas.width = cols * t;
  canvas.height = rows * t;
  const ctx = canvas.getContext('2d')!;
  const px = t * t;
  const image = ctx.createImageData(canvas.width, canvas.height);

  for (let i = 0; i < choice.length; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const base = choice[i] * px * 3;
    for (let y = 0; y < t; y++) {
      let d = ((r * t + y) * canvas.width + c * t) * 4;
      let s = base + y * t * 3;
      for (let x = 0; x < t; x++) {
        image.data[d] = tiles.data[s];
        image.data[d + 1] = tiles.data[s + 1];
        image.data[d + 2] = tiles.data[s + 2];
        image.data[d + 3] = 255;
        d += 4;
        s += 3;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** Each cell as a flat block of its mean colour — the milestone-1 sanity
 * check, and the clearest "before" against the finished mosaic. */
export function drawGridPreview(
  canvas: HTMLCanvasElement,
  means: Uint8Array,
  rows: number,
  cols: number,
): void {
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(cols, rows);
  for (let i = 0; i < rows * cols; i++) {
    image.data[i * 4] = means[i * 3];
    image.data[i * 4 + 1] = means[i * 3 + 1];
    image.data[i * 4 + 2] = means[i * 3 + 2];
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

/** One contact sheet per cluster: proof the grouping is sensible before
 * anything downstream depends on it. */
export function drawContactSheet(
  canvas: HTMLCanvasElement,
  tiles: TileSet,
  labels: Int32Array,
  cluster: number,
  maxTiles = 64,
): number {
  const members: number[] = [];
  for (let i = 0; i < labels.length && members.length < maxTiles; i++) {
    if (labels[i] === cluster) members.push(i);
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
  const rows = Math.max(1, Math.ceil(members.length / cols));
  const t = tiles.size;
  canvas.width = cols * t;
  canvas.height = rows * t;

  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(canvas.width, canvas.height);
  const px = t * t;
  members.forEach((tileIndex, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const base = tileIndex * px * 3;
    for (let y = 0; y < t; y++) {
      let d = ((r * t + y) * canvas.width + c * t) * 4;
      let s = base + y * t * 3;
      for (let x = 0; x < t; x++) {
        image.data[d] = tiles.data[s];
        image.data[d + 1] = tiles.data[s + 1];
        image.data[d + 2] = tiles.data[s + 2];
        image.data[d + 3] = 255;
        d += 4;
        s += 3;
      }
    }
  });
  ctx.putImageData(image, 0, 0);
  return members.length;
}
