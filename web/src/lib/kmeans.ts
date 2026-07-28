/** Port of src/cluster.py — k-means over the tile features.
 *
 * This is the unsupervised core: no labels anywhere, the grouping comes
 * purely from the data. scikit-learn's defaults are mirrored deliberately
 * (k-means++ seeding, n_init restarts keeping the lowest inertia, Lloyd
 * iterations to convergence) so the browser and the Python CLI produce
 * comparable clusterings. */

import { sqDist } from './features';
import type { Features } from './features';

/** One Lloyd iteration, recorded so the page can show convergence rather
 * than assert it. */
export interface KMeansStep {
  iter: number;
  /** Sum of squared distances to the assigned centroid. Monotonically
   * non-increasing — that it never rises is the guarantee Lloyd gives. */
  inertia: number;
  /** Tiles that changed cluster this pass. Hits zero at convergence. */
  moved: number;
  /** How far the centroids travelled, summed. The other convergence view:
   * assignments stop flipping because the centres stop moving. */
  shift: number;
}

export interface KMeansModel {
  k: number;
  dims: number;
  /** k * dims centroid coordinates. */
  centroids: Float32Array;
  /** Cluster label per input row. */
  labels: Int32Array;
  inertia: number;
  /** Convergence trace of the restart that won. */
  trace: KMeansStep[];
  /** Final inertia of every restart, in the order they were run. Spread
   * across these is the visible argument for why n_init > 1 exists. */
  restarts: number[];
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
): { labels: Int32Array; inertia: number; trace: KMeansStep[] } {
  const { data, count, dims } = features;
  const labels = new Int32Array(count).fill(-1);
  const sums = new Float64Array(k * dims);
  const counts = new Int32Array(k);
  const trace: KMeansStep[] = [];
  let inertia = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    let moved = 0;
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
        moved++;
      }
    }
    if (moved === 0 && iter > 0) {
      trace.push({ iter: iter + 1, inertia, moved: 0, shift: 0 });
      break;
    }

    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < count; i++) {
      const c = labels[i];
      counts[c]++;
      for (let d = 0; d < dims; d++) sums[c * dims + d] += data[i * dims + d];
    }
    let shift = 0;
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue; // keep an empty cluster's old centre
      let move = 0;
      for (let d = 0; d < dims; d++) {
        const next = sums[c * dims + d] / counts[c];
        const delta = next - centroids[c * dims + d];
        move += delta * delta;
        centroids[c * dims + d] = next;
      }
      shift += Math.sqrt(move);
    }
    trace.push({ iter: iter + 1, inertia, moved, shift });
  }
  return { labels, inertia, trace };
}

export function kmeans(
  features: Features,
  k: number,
  { nInit = 10, maxIter = 100, seed = 42 } = {},
): KMeansModel {
  const kk = Math.max(1, Math.min(k, features.count));
  const rand = mulberry32(seed);
  const restarts: number[] = [];
  let best: KMeansModel | null = null;

  for (let attempt = 0; attempt < nInit; attempt++) {
    const centroids = kmeansPlusPlus(features, kk, rand);
    const { labels, inertia, trace } = lloyd(features, centroids, kk, maxIter);
    restarts.push(inertia);
    if (!best || inertia < best.inertia) {
      best = { k: kk, dims: features.dims, centroids, labels, inertia, trace, restarts };
    }
  }
  best!.restarts = restarts;
  return best!;
}

/**
 * Mean silhouette coefficient — how well each point sits in its own cluster
 * versus the next-best one, in [-1, 1].
 *
 * Unlike inertia, this doesn't fall monotonically as k grows, so it can
 * actually pick a k rather than just describe one. It's O(n²), so large
 * libraries are evaluated on a deterministic subsample; the page reports
 * how many points were used so the number isn't read as exact.
 */
export function silhouette(
  features: Features,
  labels: Int32Array,
  k: number,
  maxSamples = 600,
): { score: number; sampled: number } {
  const { data, count, dims } = features;
  if (k < 2 || count <= k) return { score: 0, sampled: 0 };

  const stride = Math.max(1, Math.ceil(count / maxSamples));
  const idx: number[] = [];
  for (let i = 0; i < count; i += stride) idx.push(i);
  const n = idx.length;

  // Cluster sizes over the *sample*, since the a/b means are taken over it.
  const sizes = new Int32Array(k);
  for (const i of idx) sizes[labels[i]]++;

  let total = 0;
  let counted = 0;
  const sums = new Float64Array(k);
  for (let ai = 0; ai < n; ai++) {
    const i = idx[ai];
    const own = labels[i];
    if (sizes[own] < 2) continue; // a singleton cluster has no defined a(i)

    sums.fill(0);
    for (let bi = 0; bi < n; bi++) {
      if (bi === ai) continue;
      const j = idx[bi];
      sums[labels[j]] += Math.sqrt(sqDist(data, i, data, j, dims));
    }

    const a = sums[own] / (sizes[own] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === own || sizes[c] === 0) continue;
      const mean = sums[c] / sizes[c];
      if (mean < b) b = mean;
    }
    if (!Number.isFinite(b)) continue;

    const denom = Math.max(a, b);
    if (denom > 0) total += (b - a) / denom;
    counted++;
  }
  return { score: counted ? total / counted : 0, sampled: n };
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
