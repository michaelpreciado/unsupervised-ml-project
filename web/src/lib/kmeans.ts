/** Port of src/cluster.py — k-means over the tile features.
 *
 * This is the unsupervised core: no labels anywhere, the grouping comes
 * purely from the data. scikit-learn's defaults are mirrored deliberately
 * (k-means++ seeding, n_init restarts keeping the lowest inertia, Lloyd
 * iterations to convergence) so the browser and the Python CLI produce
 * comparable clusterings. */

import { sqDist } from './features';
import type { Features } from './features';

export interface KMeansModel {
  k: number;
  dims: number;
  /** k * dims centroid coordinates. */
  centroids: Float32Array;
  /** Cluster label per input row. */
  labels: Int32Array;
  inertia: number;
}

/** Small deterministic PRNG so a given seed always yields the same run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-means++ seeding: after a random first centre, each subsequent centre
 * is drawn with probability proportional to its squared distance from the
 * nearest existing centre. Far better local minima than uniform picks. */
function kmeansPlusPlus(
  { data, count, dims }: Features,
  k: number,
  rand: () => number,
): Float32Array {
  const centroids = new Float32Array(k * dims);
  const first = Math.floor(rand() * count);
  centroids.set(data.subarray(first * dims, (first + 1) * dims), 0);

  const closest = new Float64Array(count);
  for (let i = 0; i < count; i++) closest[i] = sqDist(data, i, centroids, 0, dims);

  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < count; i++) total += closest[i];
    let pick = count - 1;
    if (total > 0) {
      let threshold = rand() * total;
      for (let i = 0; i < count; i++) {
        threshold -= closest[i];
        if (threshold <= 0) {
          pick = i;
          break;
        }
      }
    } else {
      pick = Math.floor(rand() * count);
    }
    centroids.set(data.subarray(pick * dims, (pick + 1) * dims), c * dims);
    for (let i = 0; i < count; i++) {
      const d = sqDist(data, i, centroids, c, dims);
      if (d < closest[i]) closest[i] = d;
    }
  }
  return centroids;
}

function lloyd(
  features: Features,
  centroids: Float32Array,
  k: number,
  maxIter: number,
): { labels: Int32Array; inertia: number } {
  const { data, count, dims } = features;
  const labels = new Int32Array(count).fill(-1);
  const sums = new Float64Array(k * dims);
  const counts = new Int32Array(k);
  let inertia = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    inertia = 0;

    for (let i = 0; i < count; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d = sqDist(data, i, centroids, c, dims);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      inertia += bestDist;
      if (labels[i] !== best) {
        labels[i] = best;
        changed = true;
      }
    }
    if (!changed && iter > 0) break;

    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < count; i++) {
      const c = labels[i];
      counts[c]++;
      for (let d = 0; d < dims; d++) sums[c * dims + d] += data[i * dims + d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue; // keep an empty cluster's old centre
      for (let d = 0; d < dims; d++) centroids[c * dims + d] = sums[c * dims + d] / counts[c];
    }
  }
  return { labels, inertia };
}

export function kmeans(
  features: Features,
  k: number,
  { nInit = 10, maxIter = 100, seed = 42 } = {},
): KMeansModel {
  const kk = Math.max(1, Math.min(k, features.count));
  const rand = mulberry32(seed);
  let best: KMeansModel | null = null;

  for (let attempt = 0; attempt < nInit; attempt++) {
    const centroids = kmeansPlusPlus(features, kk, rand);
    const { labels, inertia } = lloyd(features, centroids, kk, maxIter);
    if (!best || inertia < best.inertia) {
      best = { k: kk, dims: features.dims, centroids, labels, inertia };
    }
  }
  return best!;
}

/** Assign already-fitted clusters to new rows (the target's cells). */
export function predict(model: KMeansModel, features: Features): Int32Array {
  const { data, count, dims } = features;
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    let best = 0;
    let bestDist = Infinity;
    for (let c = 0; c < model.k; c++) {
      const d = sqDist(data, i, model.centroids, c, dims);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    out[i] = best;
  }
  return out;
}
