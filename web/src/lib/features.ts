/** Port of src/features.py — turn images into feature vectors.
 *
 * Cells and tiles go through the same extractor, so "visually similar"
 * becomes "close in euclidean distance" and clustering, matching and the
 * variety penalty all share one space. */

import type { FeatureKind, TileSet } from './types';

export const HIST_BINS = 6;

export interface Features {
  /** count * dims, row-major. */
  data: Float32Array;
  count: number;
  dims: number;
}

/** (n, t, t, 3) -> (n, 3): average colour per image. */
function meanRgb({ data, count, size }: TileSet): Features {
  const px = size * size;
  const out = new Float32Array(count * 3);
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
  return { data: out, count, dims: 3 };
}

/** (n, t, t, 3) -> (n, bins**3): joint RGB histogram.
 *
 * Pixels are binned jointly across R, G and B (not per channel), so the
 * feature can tell "orange pixels" from "red + yellow pixels". Normalized
 * to sum to 1 then scaled by 255 so distances land on the same magnitude
 * as mean_rgb — that keeps the shared variety penalty meaningful.
 *
 * Bins are soft: each pixel splits its mass between the two nearest bin
 * centres per channel (trilinear, 8 corners). With hard edges, two nearly
 * identical colours either side of a boundary share no bins and land as
 * far apart as red and blue — measurably worse than plain mean RGB. This
 * mirrors color_histogram() in src/features.py. */
function colorHistogram({ data, count, size }: TileSet, bins = HIST_BINS): Features {
  const px = size * size;
  const dims = bins * bins * bins;
  const out = new Float32Array(count * dims);
  const top = bins - 1;

  for (let i = 0; i < count; i++) {
    const base = i * px * 3;
    const row = i * dims;
    for (let p = 0; p < px; p++) {
      const cr = (data[base + p * 3] * bins) / 256 - 0.5;
      const cg = (data[base + p * 3 + 1] * bins) / 256 - 0.5;
      const cb = (data[base + p * 3 + 2] * bins) / 256 - 0.5;
      const lr = Math.floor(cr);
      const lg = Math.floor(cg);
      const lb = Math.floor(cb);
      const fr = cr - lr;
      const fg = cg - lg;
      const fb = cb - lb;

      for (let dr = 0; dr < 2; dr++) {
        const wr = dr ? fr : 1 - fr;
        if (wr === 0) continue;
        const ir = Math.min(top, Math.max(0, lr + dr));
        for (let dg = 0; dg < 2; dg++) {
          const wg = dg ? fg : 1 - fg;
          if (wg === 0) continue;
          const ig = Math.min(top, Math.max(0, lg + dg));
          for (let db = 0; db < 2; db++) {
            const wb = db ? fb : 1 - fb;
            if (wb === 0) continue;
            const ib = Math.min(top, Math.max(0, lb + db));
            out[row + ir * bins * bins + ig * bins + ib] += wr * wg * wb;
          }
        }
      }
    }
    for (let d = 0; d < dims; d++) out[row + d] = (out[row + d] / px) * 255;
  }
  return { data: out, count, dims };
}

export function extract(tiles: TileSet, kind: FeatureKind): Features {
  return kind === 'histogram' ? colorHistogram(tiles) : meanRgb(tiles);
}

/** Squared euclidean distance between row `a` of A and row `b` of B. */
export function sqDist(
  A: Float32Array,
  a: number,
  B: Float32Array,
  b: number,
  dims: number,
): number {
  let sum = 0;
  const ai = a * dims;
  const bi = b * dims;
  for (let d = 0; d < dims; d++) {
    const diff = A[ai + d] - B[bi + d];
    sum += diff * diff;
  }
  return sum;
}
