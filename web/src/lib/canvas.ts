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

/**
 * The target repainted in exactly k colours — each cell filled with the
 * mean colour of the cluster it was routed into.
 *
 * This is the model's own view of the image. Everything the matcher can
 * distinguish at the routing stage is here; everything else it has to
 * recover by searching inside a cluster. Turning k up and watching this
 * image resolve is the clearest available answer to "what does k do".
 */
export function drawClusterMap(
  canvas: HTMLCanvasElement,
  cellCluster: Int32Array,
  clusterColors: Uint8Array,
  rows: number,
  cols: number,
): void {
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(cols, rows);
  for (let i = 0; i < rows * cols; i++) {
    const c = Math.max(0, cellCluster[i]);
    image.data[i * 4] = clusterColors[c * 3];
    image.data[i * 4 + 1] = clusterColors[c * 3 + 1];
    image.data[i * 4 + 2] = clusterColors[c * 3 + 2];
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

/** Deep navy → cyan → white. Monotone in lightness, so the map still reads
 * correctly in greyscale or to a colour-blind viewer. */
const HEAT: [number, number, number][] = [
  [4, 10, 38],
  [12, 92, 168],
  [64, 208, 236],
  [240, 253, 255],
];

function heat(t: number): [number, number, number] {
  const x = Math.min(0.9999, Math.max(0, t)) * (HEAT.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = HEAT[i];
  const b = HEAT[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * Where the library ran out: per-cell distance between the colour the target
 * asked for and the closest tile that existed, penalties excluded.
 *
 * Excluding the variety penalty is the whole point. A cell that got a worse
 * tile because a better one was already used is a *choice*; a cell whose
 * best available option was still far away is a gap in the library. Only
 * the second one is fixed by adding photos, and this map shows only that.
 *
 * Normalised to the 95th percentile rather than the maximum, so a single
 * pathological cell can't flatten everything else into the floor.
 */
export function drawResidual(
  canvas: HTMLCanvasElement,
  cellNearest: Float32Array,
  rows: number,
  cols: number,
): number {
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(cols, rows);

  const sorted = Float32Array.from(cellNearest).sort();
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 1;

  for (let i = 0; i < rows * cols; i++) {
    const [r, g, b] = heat(cellNearest[i] / p95);
    image.data[i * 4] = r;
    image.data[i * 4 + 1] = g;
    image.data[i * 4 + 2] = b;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return p95;
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
