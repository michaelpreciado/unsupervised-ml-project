/** Canvas drawings for the "behind the scenes" panels.
 *
 * Everything here plots numbers the pipeline actually produced during the
 * run you are looking at — no illustrative curves, no stand-in data. If a
 * chart is on screen it is describing this mosaic.
 *
 * Shared conventions: cyan is the quantity being argued about, blue is its
 * counterpart, white is the target, grey is context. Charts are drawn at
 * device resolution and sized from their CSS box, so they stay crisp
 * without any layout coupling. */

import type { KMeansStep } from './kmeans';
import type { KScanPoint, Scatter } from './types';

const CYAN = '#5ce1f2';
const BLUE = '#6aa6ff';
const GRID = 'rgba(126, 197, 224, 0.09)';
const AXIS = 'rgba(150, 186, 206, 0.62)';
const LABEL_FONT = '10px ui-monospace, SFMono-Regular, Menlo, monospace';

interface Surface {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

/** Size the backing store to the element's CSS box at device resolution.
 * Returns null when the element hasn't been laid out yet (a hidden panel),
 * which callers treat as "nothing to draw". */
function surface(canvas: HTMLCanvasElement, aspect: number, maxHeight = Infinity): Surface | null {
  const cssW = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
  if (!cssW) return null;
  const cssH = Math.min(maxHeight, Math.round(cssW / aspect));
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.height = `${cssH}px`;

  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return { ctx, w: cssW, h: cssH };
}

/** A line drawn twice — wide and faint, then thin and bright. Cheaper than
 * shadowBlur and it reads the same at this scale. */
function glowLine(ctx: CanvasRenderingContext2D, path: () => void, color: string, width = 1.75) {
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = width * 3.2;
  ctx.beginPath();
  path();
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = width;
  ctx.beginPath();
  path();
  ctx.stroke();
}

function gridLines(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rows = 4) {
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= rows; i++) {
    const gy = Math.round(y + (h * i) / rows) + 0.5;
    ctx.moveTo(x, gy);
    ctx.lineTo(x + w, gy);
  }
  ctx.stroke();
}

function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return abs >= 10 ? value.toFixed(0) : value.toFixed(2);
}

function emptyState(canvas: HTMLCanvasElement, message: string, aspect = 2.2) {
  const s = surface(canvas, aspect);
  if (!s) return;
  s.ctx.fillStyle = AXIS;
  s.ctx.font = LABEL_FONT;
  s.ctx.textAlign = 'center';
  s.ctx.fillText(message, s.w / 2, s.h / 2);
}

/* ------------------------------------------------------- convergence */

/**
 * Lloyd's algorithm, iteration by iteration: inertia as a line, tiles that
 * changed cluster as bars beneath it.
 *
 * The point of showing both is that they tell the same story in different
 * currencies. Inertia can only fall — that's the guarantee the algorithm
 * gives — but it flattens long before it stops. The reassignment count is
 * what actually hits zero, and that's what "converged" means here.
 */
export function drawConvergence(canvas: HTMLCanvasElement, trace: KMeansStep[]): void {
  if (trace.length < 2) {
    emptyState(canvas, 'converged on the first pass — nothing to plot');
    return;
  }
  const s = surface(canvas, 2.35);
  if (!s) return;
  const { ctx, w, h } = s;

  const padL = 44;
  const padR = 62;
  const padT = 14;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const barBand = plotH * 0.3;
  const lineH = plotH - barBand - 6;

  const maxInertia = Math.max(...trace.map((t) => t.inertia));
  const minInertia = Math.min(...trace.map((t) => t.inertia));
  const span = Math.max(1e-9, maxInertia - minInertia);
  const maxMoved = Math.max(1, ...trace.map((t) => t.moved));

  const x = (i: number) => padL + (plotW * i) / Math.max(1, trace.length - 1);
  const y = (v: number) => padT + lineH * (1 - (v - minInertia) / span);

  gridLines(ctx, padL, padT, plotW, lineH, 3);

  // Reassignments: the count that has to reach zero.
  const barW = Math.max(2, Math.min(14, plotW / trace.length - 3));
  ctx.fillStyle = 'rgba(106, 166, 255, 0.42)';
  trace.forEach((step, i) => {
    const bh = (step.moved / maxMoved) * barBand;
    ctx.fillRect(x(i) - barW / 2, padT + plotH - bh, barW, bh);
  });

  glowLine(ctx, () => {
    trace.forEach((step, i) => (i ? ctx.lineTo(x(i), y(step.inertia)) : ctx.moveTo(x(i), y(step.inertia))));
  }, CYAN);

  ctx.fillStyle = CYAN;
  trace.forEach((step, i) => {
    ctx.beginPath();
    ctx.arc(x(i), y(step.inertia), i === trace.length - 1 ? 3.6 : 2.2, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.font = LABEL_FONT;
  ctx.fillStyle = AXIS;
  ctx.textAlign = 'right';
  ctx.fillText(compact(maxInertia), padL - 7, padT + 4);
  ctx.fillText(compact(minInertia), padL - 7, padT + lineH + 4);
  ctx.textAlign = 'left';
  ctx.fillText(`${maxMoved} moved`, padL + plotW + 7, padT + plotH - barBand + 4);
  ctx.fillText('0', padL + plotW + 7, padT + plotH + 4);
  ctx.textAlign = 'center';
  ctx.fillText('iteration →', padL + plotW / 2, h - 5);
}

/* ---------------------------------------------------------- restarts */

/**
 * Final inertia of every restart, best highlighted.
 *
 * k-means only finds a local minimum, and which one depends entirely on
 * where the centres started. Spread across these bars is the argument for
 * `n_init > 1`; a flat row is the same argument's null result.
 */
export function drawRestarts(canvas: HTMLCanvasElement, restarts: number[]): void {
  if (!restarts.length) return;
  const s = surface(canvas, 5.2);
  if (!s) return;
  const { ctx, w, h } = s;

  const padL = 8;
  const padR = 8;
  const padB = 14;
  const plotW = w - padL - padR;
  const plotH = h - padB - 4;

  const best = Math.min(...restarts);
  const worst = Math.max(...restarts);
  const span = Math.max(1e-9, worst - best);
  const gap = 3;
  const barW = Math.max(2, plotW / restarts.length - gap);

  restarts.forEach((value, i) => {
    // Scaled to the spread, not to zero: at 400 tiles the restarts differ
    // by fractions of a percent and a zero-based axis would hide it.
    const norm = (value - best) / span;
    const bh = 4 + (plotH - 4) * norm;
    const isBest = value === best;
    ctx.fillStyle = isBest ? CYAN : 'rgba(106, 166, 255, 0.35)';
    ctx.fillRect(padL + i * (barW + gap), 4 + plotH - bh, barW, bh);
  });

  ctx.font = LABEL_FONT;
  ctx.fillStyle = AXIS;
  ctx.textAlign = 'left';
  ctx.fillText(`best ${compact(best)}`, padL, h - 3);
  ctx.textAlign = 'right';
  ctx.fillText(
    span / best < 0.001 ? 'all restarts agreed' : `worst ${compact(worst)}`,
    w - padR,
    h - 3,
  );
}

/* ------------------------------------------------------------ k scan */

/**
 * Inertia and silhouette against k.
 *
 * Inertia falls monotonically — more centres can only fit tighter — so it
 * can show an elbow but never choose. Silhouette can peak, and where it
 * peaks is an actual answer. Plotting them together is the fastest way to
 * see why "pick k by the elbow" is a heuristic and not a rule.
 */
export function drawKScan(canvas: HTMLCanvasElement, points: KScanPoint[], currentK: number): void {
  if (points.length < 2) {
    emptyState(canvas, 'run the sweep to compare values of k');
    return;
  }
  const s = surface(canvas, 2.35);
  if (!s) return;
  const { ctx, w, h } = s;

  const padL = 46;
  const padR = 46;
  const padT = 14;
  // Two label rows below the plot: k ticks, then the series key.
  const padB = 38;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const inertias = points.map((p) => p.inertia);
  const sils = points.map((p) => p.silhouette);
  const iMax = Math.max(...inertias);
  const iMin = Math.min(...inertias);
  const sMax = Math.max(...sils);
  const sMin = Math.min(0, ...sils);

  const x = (i: number) => padL + (plotW * i) / (points.length - 1);
  const yi = (v: number) => padT + plotH * (1 - (v - iMin) / Math.max(1e-9, iMax - iMin));
  const ys = (v: number) => padT + plotH * (1 - (v - sMin) / Math.max(1e-9, sMax - sMin));

  gridLines(ctx, padL, padT, plotW, plotH, 4);

  // Where the current k sits, so the sweep reads as a decision you can act on.
  const activeIndex = points.findIndex((p) => p.k === currentK);
  if (activeIndex >= 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(activeIndex), padT);
    ctx.lineTo(x(activeIndex), padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  glowLine(ctx, () => {
    points.forEach((p, i) => (i ? ctx.lineTo(x(i), yi(p.inertia)) : ctx.moveTo(x(i), yi(p.inertia))));
  }, BLUE, 1.6);
  glowLine(ctx, () => {
    points.forEach((p, i) => (i ? ctx.lineTo(x(i), ys(p.silhouette)) : ctx.moveTo(x(i), ys(p.silhouette))));
  }, CYAN, 1.6);

  // Mark the best silhouette — the one point on this chart that is a
  // recommendation rather than a description.
  const peak = sils.indexOf(sMax);
  const peakX = x(peak);
  const peakY = ys(sMax);
  ctx.fillStyle = CYAN;
  ctx.beginPath();
  ctx.arc(peakX, peakY, 4.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(5,10,14,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.font = LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.fillStyle = AXIS;
  points.forEach((p, i) => {
    if (points.length > 12 && i % 2) return;
    ctx.fillText(String(p.k), x(i), h - 22);
  });

  // The peak value hangs off the marker, pushed to whichever side has room.
  ctx.fillStyle = CYAN;
  ctx.textAlign = peak > points.length / 2 ? 'right' : 'left';
  const nudge = peak > points.length / 2 ? -9 : 9;
  ctx.fillText(`k=${points[peak].k} · ${sMax.toFixed(3)}`, peakX + nudge, peakY + 3);

  // Series key on its own row below the k ticks, where no line can reach it.
  ctx.textAlign = 'left';
  ctx.fillStyle = BLUE;
  ctx.fillText('— inertia', padL, h - 7);
  ctx.textAlign = 'center';
  ctx.fillStyle = AXIS;
  ctx.fillText('k →', padL + plotW / 2, h - 7);
  ctx.textAlign = 'right';
  ctx.fillStyle = CYAN;
  ctx.fillText('silhouette —', padL + plotW, h - 7);
}

/* ---------------------------------------------------- feature space */

/** Andrew's monotone chain. Used for cluster outlines — a hull is a fair
 * summary of "where this cluster lives" and costs one sort. */
function convexHull(points: number[][]): number[][] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (source: number[][]) => {
    const out: number[][] = [];
    for (const p of source) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(pts), ...build([...pts].reverse())];
}

export interface FeatureSpaceOptions {
  /** Dim every cluster but this one. */
  highlight?: number | null;
  /** Overlay the target's cells — the demand side of the space. */
  showCells?: boolean;
}

/**
 * The feature space itself, flattened to its two highest-variance
 * directions.
 *
 * This is the only view in which the unsupervised part is literally
 * visible: coloured points are library tiles at their true mean colour,
 * outlines are the partition k-means found, crosses are the centroids, and
 * the white haze is where the target's cells are asking for tiles. Empty
 * white regions are the honest failure mode of a photo mosaic — colours the
 * target needs that the library simply doesn't have.
 */
export function drawFeatureSpace(
  canvas: HTMLCanvasElement,
  scatter: Scatter,
  labels: Int32Array,
  tileColors: Uint8Array,
  k: number,
  { highlight = null, showCells = true }: FeatureSpaceOptions = {},
): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const consider = (arr: Float32Array) => {
    for (let i = 0; i < arr.length; i += 2) {
      if (arr[i] < minX) minX = arr[i];
      if (arr[i] > maxX) maxX = arr[i];
      if (arr[i + 1] < minY) minY = arr[i + 1];
      if (arr[i + 1] > maxY) maxY = arr[i + 1];
    }
  };
  consider(scatter.tiles);
  if (showCells) consider(scatter.cells);
  if (!Number.isFinite(minX)) return;

  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);

  // The canvas takes the *data's* aspect ratio where it can, so the cloud
  // fills the box instead of floating in margin — but never taller than a
  // screenful. PC1 and PC2 are the same units either way, and the equal
  // scale below is what actually guarantees the shape isn't distorted.
  const s = surface(canvas, Math.min(3, Math.max(1.15, spanX / spanY)), 560);
  if (!s) return;
  const { ctx, w, h } = s;

  const pad = 18;
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = (w - spanX * scale) / 2 - minX * scale;
  const oy = (h - spanY * scale) / 2 - minY * scale;
  const px = (v: number) => ox + v * scale;
  // Flip y so the plot reads like a graph rather than a screen buffer.
  const py = (v: number) => h - (oy + v * scale);

  ctx.fillStyle = 'rgba(6, 12, 18, 0.55)';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 6; i++) {
    ctx.moveTo(Math.round((w * i) / 6) + 0.5, 0);
    ctx.lineTo(Math.round((w * i) / 6) + 0.5, h);
    ctx.moveTo(0, Math.round((h * i) / 6) + 0.5);
    ctx.lineTo(w, Math.round((h * i) / 6) + 0.5);
  }
  ctx.stroke();

  // Demand: where the target needs colour.
  if (showCells) {
    ctx.fillStyle = 'rgba(226, 244, 252, 0.5)';
    for (let i = 0; i < scatter.cells.length; i += 2) {
      ctx.fillRect(px(scatter.cells[i]) - 0.75, py(scatter.cells[i + 1]) - 0.75, 1.5, 1.5);
    }
  }

  // The partition k-means found.
  const byCluster: number[][][] = Array.from({ length: k }, () => []);
  for (let t = 0; t < labels.length; t++) {
    byCluster[labels[t]]?.push([px(scatter.tiles[t * 2]), py(scatter.tiles[t * 2 + 1])]);
  }
  byCluster.forEach((members, c) => {
    if (members.length < 3) return;
    const hull = convexHull(members);
    if (hull.length < 3) return;
    const active = highlight === null || highlight === c;
    ctx.beginPath();
    hull.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fillStyle = active ? 'rgba(92, 225, 242, 0.07)' : 'rgba(92, 225, 242, 0.02)';
    ctx.fill();
    ctx.strokeStyle = active ? 'rgba(92, 225, 242, 0.45)' : 'rgba(92, 225, 242, 0.12)';
    ctx.lineWidth = active && highlight !== null ? 1.6 : 1;
    ctx.stroke();
  });

  // Supply: the tiles, at the colour they actually are.
  for (let t = 0; t < labels.length; t++) {
    const dim = highlight !== null && labels[t] !== highlight;
    ctx.globalAlpha = dim ? 0.16 : 0.92;
    ctx.fillStyle = `rgb(${tileColors[t * 3]},${tileColors[t * 3 + 1]},${tileColors[t * 3 + 2]})`;
    ctx.beginPath();
    ctx.arc(px(scatter.tiles[t * 2]), py(scatter.tiles[t * 2 + 1]), dim ? 1.6 : 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // The centroids — the whole model, in k points.
  for (let c = 0; c < k; c++) {
    const cx = px(scatter.centroids[c * 2]);
    const cy = py(scatter.centroids[c * 2 + 1]);
    const active = highlight === null || highlight === c;
    ctx.globalAlpha = active ? 1 : 0.25;
    ctx.strokeStyle = '#04080c';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.stroke();
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  ctx.font = LABEL_FONT;
  ctx.fillStyle = AXIS;
  ctx.textAlign = 'left';
  ctx.fillText(`PC1 · ${(scatter.explained[0] * 100).toFixed(1)}% of variance`, 10, h - 20);
  ctx.fillText(`PC2 · ${(scatter.explained[1] * 100).toFixed(1)}%`, 10, h - 8);
}
