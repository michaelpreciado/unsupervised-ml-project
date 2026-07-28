/** PCA down to two dimensions, so the feature space can be looked at.
 *
 * Everything upstream — clustering, matching, the variety penalty — happens
 * in 3 or 216 dimensions, which is exactly the part of an unsupervised
 * pipeline nobody can see. Projecting onto the two directions of greatest
 * variance gives a faithful-enough map to answer the questions that matter
 * to a reader: are the clusters actually separated, do the target's cells
 * land where the library has tiles, and where are the gaps.
 *
 * Implemented with power iteration rather than a full eigendecomposition:
 * only the top two components are ever needed, the covariance matrix is
 * never formed (216×216 would be, but 216-dim is not the worst case), and
 * it stays a few dozen lines of readable arithmetic. */

import type { Features } from './features';

export interface Basis {
  dims: number;
  /** Feature-space centroid the projection is taken around. */
  mean: Float32Array;
  /** Two unit axes, 2 * dims, row-major. */
  axes: Float32Array;
  /** Fraction of total variance each axis carries. Reported because a
   * scatter plot of a 216-dim space is only as trustworthy as this pair of
   * numbers. */
  explained: [number, number];
}

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One power-iteration pass: v ← normalize(Xᶜᵀ Xᶜ v), with any previously
 * found axes projected out so the second component comes back orthogonal
 * to the first. */
function topAxis(
  data: Float32Array,
  count: number,
  dims: number,
  mean: Float32Array,
  found: Float32Array[],
  rand: () => number,
  iterations = 48,
): { axis: Float32Array; eigenvalue: number } {
  const v = new Float32Array(dims);
  for (let d = 0; d < dims; d++) v[d] = rand() * 2 - 1;
  const w = new Float64Array(dims);
  let eigenvalue = 0;

  for (let it = 0; it < iterations; it++) {
    w.fill(0);
    let energy = 0;
    for (let i = 0; i < count; i++) {
      const base = i * dims;
      let dot = 0;
      for (let d = 0; d < dims; d++) dot += (data[base + d] - mean[d]) * v[d];
      energy += dot * dot;
      for (let d = 0; d < dims; d++) w[d] += dot * (data[base + d] - mean[d]);
    }
    eigenvalue = energy / Math.max(1, count - 1);

    for (const axis of found) {
      let dot = 0;
      for (let d = 0; d < dims; d++) dot += w[d] * axis[d];
      for (let d = 0; d < dims; d++) w[d] -= dot * axis[d];
    }

    let norm = 0;
    for (let d = 0; d < dims; d++) norm += w[d] * w[d];
    norm = Math.sqrt(norm);
    if (norm < 1e-12) break; // degenerate — the data has no spread left
    for (let d = 0; d < dims; d++) v[d] = w[d] / norm;
  }
  return { axis: v, eigenvalue };
}

export function pca2({ data, count, dims }: Features): Basis {
  const mean = new Float32Array(dims);
  for (let i = 0; i < count; i++) {
    const base = i * dims;
    for (let d = 0; d < dims; d++) mean[d] += data[base + d];
  }
  for (let d = 0; d < dims; d++) mean[d] /= Math.max(1, count);

  let totalVariance = 0;
  for (let i = 0; i < count; i++) {
    const base = i * dims;
    for (let d = 0; d < dims; d++) {
      const delta = data[base + d] - mean[d];
      totalVariance += delta * delta;
    }
  }
  totalVariance /= Math.max(1, count - 1);

  const rand = seededRandom(7);
  const first = topAxis(data, count, dims, mean, [], rand);
  const second = topAxis(data, count, dims, mean, [first.axis], rand);

  const axes = new Float32Array(2 * dims);
  axes.set(first.axis, 0);
  axes.set(second.axis, dims);

  const share = (v: number) => (totalVariance > 0 ? Math.min(1, v / totalVariance) : 0);
  return {
    dims,
    mean,
    axes,
    explained: [share(first.eigenvalue), share(second.eigenvalue)],
  };
}

/** Project arbitrary rows onto an existing basis — used to drop the
 * target's cells and the k-means centroids into the same picture as the
 * tiles, which is the whole point of the plot. */
export function project(rows: Float32Array, count: number, basis: Basis): Float32Array {
  const { dims, mean, axes } = basis;
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const base = i * dims;
    let x = 0;
    let y = 0;
    for (let d = 0; d < dims; d++) {
      const delta = rows[base + d] - mean[d];
      x += delta * axes[d];
      y += delta * axes[dims + d];
    }
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }
  return out;
}
