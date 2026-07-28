/** Port of src/animate.py — tiles fly in from off-screen and settle into
 * their slots.
 *
 * The Pygame version blits one scaled surface per unique tile; here the
 * equivalent is an ImageBitmap cache, so a 1,500-cell mosaic is 1,500 cheap
 * drawImage calls per frame rather than 1,500 pixel loops.
 *
 * Three things were added on top of the Python original, all of them cheap
 * enough to survive a few thousand sprites at 60 fps:
 *
 * - **A wave, not a shuffle.** Delays are mostly a diagonal sweep across the
 *   grid with a little jitter on top. Pure random delays read as noise; a
 *   sweep reads as something being *built*, and you can follow one tile.
 * - **Heat.** A tile in flight is tinted toward brand cyan with a `lighter`
 *   pass that fades to nothing as it lands, so motion is legible as motion
 *   and the frame cools into true colour. No shadow blur anywhere — that is
 *   the one canvas effect that will not hold frame rate at this sprite count.
 * - **A signature.** The watermark is drawn into the frame itself, so a
 *   recording of this canvas carries it without a compositing step. */

import { BRAND, drawWatermark } from './brand';

export interface Sprite {
  sx: number;
  sy: number;
  fx: number;
  fy: number;
  delay: number;
  spin: number;
  tile: number;
}

export interface AnimationHandle {
  stop: () => void;
  /** Resolves when the fly-in finishes (or immediately if stopped). */
  done: Promise<void>;
}

const BACKDROP = '#05070b';

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random point just outside a random edge of the canvas. */
function scatterStart(rand: () => number, w: number, h: number): [number, number] {
  const margin = Math.max(80, Math.min(w, h) * 0.25);
  switch (Math.floor(rand() * 4)) {
    case 0:
      return [rand() * (w + margin * 2) - margin, -margin];
    case 1:
      return [rand() * (w + margin * 2) - margin, h + margin];
    case 2:
      return [-margin, rand() * (h + margin * 2) - margin];
    default:
      return [w + margin, rand() * (h + margin * 2) - margin];
  }
}

export interface AnimateOptions {
  duration?: number;
  stagger?: number;
  seed?: number;
  onProgress?: (fraction: number) => void;
  /** Called after every painted frame — the recorder's hook for a
   * fixed-rate capture. */
  onFrame?: () => void;
  /** Sign each frame in the corner. */
  watermark?: boolean;
  /** Extra seconds to hold on the finished mosaic before resolving, so a
   * recording doesn't cut the moment it completes. */
  hold?: number;
  /** Skip the flight entirely — the honest response to
   * prefers-reduced-motion, which still has to end at the same picture. */
  still?: boolean;
}

export function animate(
  canvas: HTMLCanvasElement,
  choice: Int32Array,
  bitmaps: Map<number, ImageBitmap>,
  rows: number,
  cols: number,
  tileSize: number,
  {
    duration = 1.5,
    stagger = 1.6,
    seed = 42,
    onProgress,
    onFrame,
    watermark = true,
    hold = 0,
    still = false,
  }: AnimateOptions = {},
): AnimationHandle {
  const w = cols * tileSize;
  const h = rows * tileSize;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const rand = mulberry32(seed);
  const sprites: Sprite[] = new Array(choice.length);
  for (let i = 0; i < choice.length; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const [sx, sy] = scatterStart(rand, w, h);
    // Mostly a diagonal sweep, a quarter jitter: ordered enough to read as
    // construction, disordered enough not to look like a wipe.
    const wave = (c / Math.max(1, cols - 1)) * 0.6 + (r / Math.max(1, rows - 1)) * 0.4;
    sprites[i] = {
      sx,
      sy,
      fx: c * tileSize,
      fy: r * tileSize,
      delay: (wave * 0.75 + rand() * 0.25) * stagger,
      spin: (rand() - 0.5) * 0.9,
      tile: choice[i],
    };
  }
  // Draw in delay order so tiles still in flight pass over settled ones.
  sprites.sort((a, b) => a.delay - b.delay);

  let frame = 0;
  let stopped = false;
  const flight = stagger + duration;
  const total = flight + hold;
  let resolve!: () => void;
  const done = new Promise<void>((res) => {
    resolve = res;
  });

  /** Faint tile-grid rulings, visible only while the mosaic is still mostly
   * empty. Cheap: a few dozen strokes, not one per cell. */
  function drawGuides() {
    ctx.save();
    ctx.strokeStyle = 'rgba(92, 225, 242, 0.055)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = tileSize * 4;
    for (let x = step; x < w; x += step) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = step; y < h; y += step) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  function paint(elapsed: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BACKDROP;
    ctx.fillRect(0, 0, w, h);
    if (elapsed < flight) drawGuides();

    // Pass 1: the tiles themselves, transformed by their own progress.
    for (const s of sprites) {
      const bmp = bitmaps.get(s.tile);
      if (!bmp) continue;
      const p = Math.min(1, Math.max(0, (elapsed - s.delay) / duration));
      if (p <= 0) continue;
      const e = easeOutCubic(p);
      const x = s.sx + (s.fx - s.sx) * e;
      const y = s.sy + (s.fy - s.sy) * e;

      if (p >= 1) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.drawImage(bmp, s.fx, s.fy, tileSize, tileSize);
        continue;
      }

      // In flight: overshoot the scale slightly and unwind the spin, both
      // driven off the same eased parameter so they land together.
      const scale = 1 + (1 - e) * 0.55;
      const angle = s.spin * (1 - e);
      const half = tileSize / 2;
      const cx = x + half;
      const cy = y + half;
      const cos = Math.cos(angle) * scale;
      const sin = Math.sin(angle) * scale;
      ctx.setTransform(cos, sin, -sin, cos, cx, cy);
      ctx.globalAlpha = 0.15 + 0.85 * e;
      ctx.drawImage(bmp, -half, -half, tileSize, tileSize);
    }

    // Pass 2: the heat. One additive rectangle per in-flight tile, batched
    // under a single composite-mode switch.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = BRAND.cyan;
    for (const s of sprites) {
      const p = Math.min(1, Math.max(0, (elapsed - s.delay) / duration));
      if (p <= 0 || p >= 1) continue;
      const e = easeOutCubic(p);
      ctx.globalAlpha = (1 - e) * 0.3;
      const x = s.sx + (s.fx - s.sx) * e;
      const y = s.sy + (s.fy - s.sy) * e;
      ctx.fillRect(x, y, tileSize, tileSize);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    if (watermark) drawWatermark(ctx, w, h);
    onProgress?.(Math.min(1, elapsed / Math.max(0.001, flight)));
    onFrame?.();
  }

  if (still) {
    paint(total + 1);
    stopped = true;
    resolve();
    return { stop: () => {}, done };
  }

  const start = performance.now();
  const tick = (now: number) => {
    if (stopped) return;
    const elapsed = (now - start) / 1000;
    paint(elapsed);
    if (elapsed >= total) {
      stopped = true;
      resolve();
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      resolve();
    },
    done,
  };
}
