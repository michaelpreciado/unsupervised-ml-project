/** Port of src/animate.py — tiles fly in from off-screen and settle into
 * their slots with staggered ease-out-cubic motion.
 *
 * The Pygame version blits one scaled surface per unique tile; here the
 * equivalent is an ImageBitmap cache, so a 1,500-cell mosaic is 1,500
 * cheap drawImage calls per frame rather than 1,500 pixel loops. */

export interface Sprite {
  sx: number;
  sy: number;
  fx: number;
  fy: number;
  delay: number;
  tile: number;
}

export interface AnimationHandle {
  stop: () => void;
  /** Resolves when the fly-in finishes (or immediately if stopped). */
  done: Promise<void>;
}

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
}

export function animate(
  canvas: HTMLCanvasElement,
  choice: Int32Array,
  bitmaps: Map<number, ImageBitmap>,
  rows: number,
  cols: number,
  tileSize: number,
  { duration = 1.5, stagger = 1.6, seed = 42, onProgress }: AnimateOptions = {},
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
    sprites[i] = {
      sx,
      sy,
      fx: c * tileSize,
      fy: r * tileSize,
      delay: rand() * stagger,
      tile: choice[i],
    };
  }
  // Draw in delay order so tiles still in flight pass over settled ones.
  sprites.sort((a, b) => a.delay - b.delay);

  let frame = 0;
  let stopped = false;
  const total = stagger + duration;
  let resolve!: () => void;
  const done = new Promise<void>((res) => {
    resolve = res;
  });

  const start = performance.now();
  const tick = (now: number) => {
    if (stopped) return;
    const elapsed = (now - start) / 1000;

    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);
    for (const s of sprites) {
      const p = Math.min(1, Math.max(0, (elapsed - s.delay) / duration));
      const e = easeOutCubic(p);
      const bmp = bitmaps.get(s.tile);
      if (!bmp) continue;
      ctx.drawImage(
        bmp,
        s.sx + (s.fx - s.sx) * e,
        s.sy + (s.fy - s.sy) * e,
        tileSize,
        tileSize,
      );
    }
    onProgress?.(Math.min(1, elapsed / total));

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
